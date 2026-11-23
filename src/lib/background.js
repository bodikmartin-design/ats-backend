import { waitUntil } from "@vercel/functions";

/**
 * Work that should finish after the response has been sent (a Slack message, a cleanup). On Vercel the function would be
 * frozen the moment the response ends, so the promise is handed to waitUntil, which keeps it alive until it settles.
 * Anywhere else it simply keeps running. Failures are logged, never thrown.
 */
export function background(promise) {
  const safe = Promise.resolve(promise).catch((err) => console.error("[background]", err?.message || err));
  try {
    waitUntil(safe);
  } catch {
    /* not running on Vercel: the promise just keeps running */
  }
  return safe;
}
