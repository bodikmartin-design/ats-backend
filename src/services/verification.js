import crypto from "node:crypto";
import { db } from "../db.js";
import { config } from "../config.js";
import { createChallenge, isCorrect } from "./challenges.js";
import { getVerifyPlan, getVerifyTexts } from "./settings.js";
import { logEvent } from "./activity.js";
import { notifyVerifyStep, notifyVisit } from "./notify.js";
import { background } from "../lib/background.js";
import { withReported } from "./clientInfo.js";

const MINUTE = 60 * 1000;
// Stand-in for "no expiry" on the copy/paste stage: effectively forever, without a special-cased null check everywhere.
const NO_EXPIRY = Date.now() + 100 * 365 * 24 * 60 * MINUTE;

const insertSession = (p) =>
  db.run(
    `INSERT INTO verify_sessions (id, stage, kind, answer, case_sensitive, plan, ip, site_id, purpose, client_json, created_at, expires_at)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.id, p.kind, p.answer, p.case_sensitive, p.plan, p.ip, p.site_id, p.purpose, p.client_json, p.now, p.expires],
  );
const getSession = (id) => db.get("SELECT * FROM verify_sessions WHERE id = ?", [id]);
const setChallenge = (p) =>
  db.run(
    `UPDATE verify_sessions
     SET stage = ?, kind = ?, answer = ?, case_sensitive = ?, attempts = ?, expires_at = ?
     WHERE id = ?`,
    [p.stage, p.kind, p.answer, p.case_sensitive, p.attempts, p.expires_at, p.id],
  );
const markPassed = (p) => db.run("UPDATE verify_sessions SET passed = 1, expires_at = ? WHERE id = ?", [p.expires, p.id]);
// purpose = 'apply' only: a passed "confirm" session (the extra re-check before submission) must never work as a
// bearer token for /apply, /roles or another /verify/confirm/start -- it only ever proves itself via its own /answer call.
const consumeStmt = (token, now) =>
  db.run("UPDATE verify_sessions SET used = 1 WHERE id = ? AND passed = 1 AND used = 0 AND expires_at > ? AND purpose = 'apply'", [token, now]);

const newId = () => crypto.randomBytes(24).toString("hex");

/** The steps this run must pass. Fixed when the run starts, so changing the setting never breaks a run in progress. */
function planOf(session) {
  try {
    const plan = JSON.parse(session.plan);
    // An explicitly saved empty array disables all verification. Do not replace it with the legacy default plan.
    if (Array.isArray(plan)) return plan;
  } catch {
    /* fall through */
  }
  return ["math", "words", "copy"];
}

/** The copy/paste stage has no time limit (see createChallenge in challenges.js for the platform-aware guide). */
const expiryFor = (kind) => (kind === "copy" ? NO_EXPIRY : Date.now() + config.verify.sessionMinutes * MINUTE);

async function assign(session, stage, attempts, client) {
  // Stages after the first are separate requests that don't carry what the browser reported when the run started (is this a
  // tablet? which platform?), which the copy/paste guide needs. It was saved with the session; add it back.
  const known = withReported(client, session.client_json);
  const challenge = createChallenge(planOf(session)[stage - 1], known, await getVerifyTexts(session.site_id));
  await setChallenge({
    id: session.id,
    stage,
    kind: challenge.kind,
    answer: challenge.answer,
    case_sensitive: challenge.caseSensitive ? 1 : 0,
    attempts,
    expires_at: expiryFor(challenge.kind),
  });
  return challenge.public;
}

/** A session that is still in progress (not passed, not expired). */
async function activeSession(id) {
  if (typeof id !== "string" || id.length !== 48) return null;
  const s = await getSession(id);
  if (!s || s.passed || s.expires_at < Date.now()) return null;
  return s;
}

const EXPIRED = { error: "Verification expired. Please start again.", expired: true };

/**
 * `forcePlan`: used by startConfirm() below to run just the copy/paste stage, ignoring the site's configured plan.
 * `purpose`: "apply" (the normal check before the form) or "confirm" (the extra re-check before final submission);
 * a "confirm" run doesn't fire the "visitor arrived" notification -- it isn't a new visit.
 */
export async function start(client, siteId = null, { forcePlan, purpose = "apply" } = {}) {
  const id = newId();
  const now = Date.now();
  const plan = forcePlan || (await getVerifyPlan(siteId));
  // With no configured checks, issue an already-passed one-use application token. This preserves the
  // normal server-side token validation/consumption path without presenting an unwanted challenge.
  const challenge = plan.length ? createChallenge(plan[0], client, await getVerifyTexts(siteId)) : null;
  await insertSession({
    id,
    kind: challenge?.kind || "none",
    answer: challenge?.answer || "",
    case_sensitive: challenge?.caseSensitive ? 1 : 0,
    plan: JSON.stringify(plan),
    ip: client.ip,
    site_id: siteId,
    purpose,
    client_json: JSON.stringify(client.reported || {}),
    now,
    expires: challenge ? expiryFor(challenge.kind) : now + config.verify.tokenMinutes * MINUTE,
  });
  if (!plan.length) await markPassed({ id, expires: now + config.verify.tokenMinutes * MINUTE });
  await logEvent(purpose === "confirm" ? "confirm_start" : "verify_start", client, {
    siteId,
    details: { sessionId: id.slice(0, 8), steps: plan.length },
  });
  if (purpose !== "confirm") background(notifyVisit(client, siteId));
  return plan.length
    ? { sessionId: id, stage: 1, totalStages: plan.length, challenge: challenge.public }
    : { sessionId: id, stage: 0, totalStages: 0, done: true, token: id };
}

/** Legacy copy-stage check retained for compatibility with older clients. */
export function startConfirm(client, siteId = null) {
  return start(client, siteId, { forcePlan: ["copy"], purpose: "confirm" });
}

/** New challenge for the same stage. Does NOT reset the attempt counter. */
export async function refresh(sessionId, client) {
  const s = await activeSession(sessionId);
  if (!s) return EXPIRED;
  return { stage: s.stage, totalStages: planOf(s).length, challenge: await assign(s, s.stage, s.attempts, client) };
}

/**
 * Complete a copy/shell verification stage from the external status mechanism.
 *
 * Stage 3 is intentionally NOT submitted through /verify/answer. The shell
 * callback records completion, and GET /api/verify/status calls this function
 * to atomically finish the verification session.
 */
export async function completeExternal(sessionId, client, siteId) {
  const s = await getSession(sessionId);
  if (!s) return EXPIRED;
  if ((s.site_id ?? null) !== (siteId ?? null)) return { error: "Verification session not found.", expired: true };

  // Idempotent: React/browser polling may ask for status repeatedly.
  if (s.passed === 1 && s.used === 0) {
    return { ok: true, done: true, token: s.id, stage: s.stage, totalStages: planOf(s).length };
  }
  if (s.used === 1 || s.expires_at <= Date.now()) return EXPIRED;
  if (s.kind !== "copy") return { ok: false, error: "This verification stage must be completed normally." };

  const total = planOf(s).length;
  const doneType = s.purpose === "confirm" ? "confirm_complete" : "verify_complete";

  if (s.stage >= total) {
    await markPassed({ id: s.id, expires: Date.now() + config.verify.tokenMinutes * MINUTE });
    await logEvent(doneType, client, { siteId: s.site_id, details: { sessionId: s.id.slice(0, 8), mechanism: "external_status" } });
    if (s.purpose !== "confirm") {
      background(notifyVerifyStep(client, { stage: s.stage, totalStages: total, kind: s.kind, done: true }, s.site_id));
    }
    return { ok: true, done: true, token: s.id, stage: s.stage, totalStages: total };
  }

  const next = s.stage + 1;
  const challenge = await assign(s, next, 0, client);
  await logEvent(s.purpose === "confirm" ? "confirm_stage_pass" : "verify_stage_pass", client, {
    siteId: s.site_id,
    details: { stage: s.stage, mechanism: "external_status" },
  });
  return { ok: true, done: false, stage: next, totalStages: total, challenge };
}

export async function answer(sessionId, input, client) {
  const s = await activeSession(sessionId);
  if (!s) return EXPIRED;
  const total = planOf(s).length;
  const doneType = s.purpose === "confirm" ? "confirm_complete" : "verify_complete";
  const stageType = s.purpose === "confirm" ? "confirm_stage_pass" : "verify_stage_pass";
  const failType = s.purpose === "confirm" ? "confirm_fail" : "verify_fail";

  if (isCorrect(s.answer, !!s.case_sensitive, input)) {
    if (s.stage >= total) {
      await markPassed({ id: s.id, expires: Date.now() + config.verify.tokenMinutes * MINUTE });
      await logEvent(doneType, client, { siteId: s.site_id, details: { sessionId: s.id.slice(0, 8) } });
      if (s.purpose !== "confirm") background(notifyVerifyStep(client, { stage: s.stage, totalStages: total, kind: s.kind, done: true }, s.site_id));
      return { ok: true, done: true, token: s.id };
    }
    const next = s.stage + 1;
    const challenge = await assign(s, next, 0, client);
    await logEvent(stageType, client, { siteId: s.site_id, details: { stage: s.stage } });
    if (s.purpose !== "confirm") background(notifyVerifyStep(client, { stage: s.stage, totalStages: total, kind: s.kind, done: false }, s.site_id));
    return { ok: true, done: false, stage: next, totalStages: total, challenge };
  }

  const attempts = s.attempts + 1;
  await logEvent(failType, client, { siteId: s.site_id, details: { stage: s.stage, attempts } });

  if (attempts >= config.verify.maxAttempts) {
    const challenge = await assign(s, 1, 0, client);
    return { ok: false, restarted: true, stage: 1, totalStages: total, challenge, message: "Too many wrong answers. Starting over." };
  }
  await setChallenge({
    id: s.id,
    stage: s.stage,
    kind: s.kind,
    answer: s.answer,
    case_sensitive: s.case_sensitive,
    attempts,
    expires_at: s.expires_at,
  });
  return { ok: false, attemptsLeft: config.verify.maxAttempts - attempts, stage: s.stage, totalStages: total };
}

/**
 * True if the token belongs to a fully verified, unused, unexpired session. Does not consume it.
 * A token only works on the domain where it was earned (pass `undefined` to skip that check).
 */
export async function isVerified(token, siteId) {
  if (typeof token !== "string" || token.length !== 48) return false;
  const s = await getSession(token);
  if (!s || s.passed !== 1 || s.used !== 0 || s.expires_at <= Date.now() || s.purpose !== "apply") return false;
  return siteId === undefined || (s.site_id ?? null) === (siteId ?? null);
}

/** Atomically use up the token. Returns false if it was already used, has expired, or belongs to another domain. */
export async function consume(token, siteId) {
  if (typeof token !== "string") return false;
  if (siteId !== undefined && !(await isVerified(token, siteId))) return false;
  return (await consumeStmt(token, Date.now())).changes === 1;
}
