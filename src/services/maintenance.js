import { db } from "../db.js";
import { config } from "../config.js";
import { purgeTrash, sweepPending } from "./pending.js";
import { enforceStorageLimit } from "./quota.js";

const MINUTE = 60 * 1000;

/**
 * Remove expired verification sessions, plus two kinds of session that would otherwise live forever:
 *  - the copy/paste (stage 3) challenge never expires on its own (see expiryFor() in verification.js, added so a
 *    visitor who steps away to paste elsewhere isn't timed out mid-step) -- so it needs its own age-based cleanup
 *    instead, based on when the session was created rather than a (very far future) expires_at.
 *  - a "confirm" session (the extra re-check shown in the confirm-submit modal) is meant to be used within minutes;
 *    one left unfinished is cleaned up quickly rather than waiting out the full copy-stage age limit.
 */
export async function cleanupVerifySessions() {
  const now = Date.now();
  await db.run("DELETE FROM verify_sessions WHERE expires_at < ?", [now - 60 * MINUTE]);
  await db.run("DELETE FROM verify_sessions WHERE kind = 'copy' AND created_at < ?", [now - config.verify.copySessionMaxAgeDays * 24 * 60 * MINUTE]);
  await db.run("DELETE FROM verify_sessions WHERE purpose = 'confirm' AND used = 0 AND created_at < ?", [now - config.verify.confirmSessionMaxAgeHours * 60 * MINUTE]);
  // state that used to be in memory: shell-command callbacks (30 min), expired rate-limit counters and finished abuse blocks
  await db.run("DELETE FROM shell_callbacks WHERE COALESCE(verified_at, created_at) < ?", [now - 30 * MINUTE]);
  await db.run("DELETE FROM rate_limits WHERE reset_at < ?", [now]);
  await db.run("DELETE FROM abuse_strikes WHERE (until_at > 0 AND until_at < ?) OR (until_at = 0 AND first_at < ?)", [now, now - 10 * MINUTE]);
}

/** Everything that tidies up after itself. Run daily by Vercel Cron and opportunistically by running instances. */
export async function runMaintenance() {
  await cleanupVerifySessions();
  const pendingRemoved = await sweepPending();
  const trashPurged = await purgeTrash();
  const quota = await enforceStorageLimit();
  return { pendingRemoved, trashPurged, quota };
}

let lastRun = Date.now(); // a fresh instance doesn't start with a cleanup; the first one is due an hour from now (and the daily cron covers the rest)
/** At most once per hour per instance, so cleanup happens even when the daily cron hasn't run (or isn't set up). */
export async function maybeRunMaintenance() {
  if (Date.now() - lastRun < 60 * MINUTE) return;
  lastRun = Date.now();
  await runMaintenance();
}
