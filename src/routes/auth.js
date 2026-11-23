import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "../db.js";
import { clearSession, issueSession, requireAuth } from "../middleware/auth.js";
import { asyncRoutes, loginLimiter, requireAjaxHeader, wrap } from "../middleware/security.js";
import { getClientInfo } from "../services/clientInfo.js";
import { logEvent } from "../services/activity.js";

const router = asyncRoutes(Router());
router.use(requireAjaxHeader);

// Compared against when the email is unknown, so response time doesn't reveal which emails exist
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await bcrypt.hash("not-a-real-password", 12));

router.post(
  "/login",
  loginLimiter,
  wrap(async (req, res) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const client = getClientInfo(req);

    const user = email ? await db.get("SELECT * FROM users WHERE lower(email) = lower(?)", [email]) : null;
    const ok = await bcrypt.compare(password.slice(0, 200), user ? user.password_hash : await getDummyHash());

    if (!user || !ok) {
      await logEvent("login_failed", client, { details: { email: email.slice(0, 100) } });
      return res.status(401).json({ error: "Wrong email or password." });
    }
    issueSession(res, user);
    await logEvent("login_ok", client, { userId: user.id, details: { email: user.email } });
    res.json({ user: { id: user.id, email: user.email, role: user.role } });
  }),
);

router.post("/logout", (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => res.json({ user: req.user }));

router.post(
  "/password",
  requireAuth,
  wrap(async (req, res) => {
    const current = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
    const next = typeof req.body?.newPassword === "string" ? req.body.newPassword : "";
    if (next.length < 10 || next.length > 200) {
      return res.status(400).json({ error: "New password must be 10 to 200 characters." });
    }
    const row = await db.get("SELECT password_hash FROM users WHERE id = ?", [req.user.id]);
    if (!(await bcrypt.compare(current, row.password_hash))) {
      return res.status(400).json({ error: "Current password is wrong." });
    }
    await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [await bcrypt.hash(next, 12), req.user.id]);
    await logEvent("password_changed", getClientInfo(req), { userId: req.user.id });
    res.json({ ok: true });
  }),
);

export default router;
