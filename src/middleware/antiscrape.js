import { config } from "../config.js";
import { db } from "../db.js";

/**
 * Anti-scraping measures. None of these can stop a determined, careful scraper (nothing public can), but together they
 * make bulk collection slow, noisy and easy to spot:
 *  1. search engines and archives are told not to index anything (noIndex + /robots.txt),
 *  2. obvious scripts and headless browsers are refused (botGuard),
 *  3. every rate-limit hit, and every blocked bot request, is a "strike"; a few strikes in a short time block that IP
 *     for a while (blockedIpGuard / recordStrike).
 * The candidate data itself (resumes, photos, applications) is behind the admin login and never reachable from here.
 */

const NO_INDEX = "noindex, nofollow, noarchive, nosnippet, noimageindex";

/** Tells search engines and web archives to keep their hands off every response (API, admin UI and uploads included). */
export function noIndex(_req, res, next) {
  res.setHeader("X-Robots-Tag", NO_INDEX);
  next();
}

export function robotsTxt(_req, res) {
  res.type("text/plain").send("User-agent: *\nDisallow: /\n");
}

// Command-line tools, HTTP libraries, scraping frameworks, headless / automated browsers and self-declared crawlers.
// A real browser never sends any of these. A scraper can fake its User-Agent, so this only removes the lazy ones.
const BOT_UA =
  /(curl|wget|libwww|python-requests|python-urllib|python\/|aiohttp|httpx|urllib|scrapy|go-http-client|okhttp|java\/|apache-httpclient|httpclient|node-fetch|undici|axios|got\/|^node\b|postmanruntime|insomnia|hurl\/|headlesschrome|phantomjs|puppeteer|playwright|selenium|webdriver|cypress|jsdom|mechanize|crawler|spider|scraper|scrape|harvest|bot\b|bot\/|slurp|archiver|ia_archiver)/i;

export const looksAutomated = (userAgent) => {
  const ua = String(userAgent || "").trim();
  return ua.length < 10 || BOT_UA.test(ua);
};

/** Refuse requests that identify as (or are missing the identity of) a script instead of a browser. */
export async function botGuard(req, res, next) {
  if (!config.blockBots || !looksAutomated(req.get("user-agent"))) return next();
  await recordStrike(req.ip);
  res.status(403).json({ error: "Automated access isn't allowed." });
}

// ---------------------------------------------------------------- strikes -> temporary IP block (kept in the database,
// because serverless instances don't share memory)

const WINDOW_MS = 10 * 60 * 1000;

/** Count one abuse event for this IP. Resolves to true if that tipped it into a block. */
export async function recordStrike(ip, now = Date.now()) {
  if (!ip || !config.abuseStrikes) return false;
  try {
    // A window that ran out, or a block that ended, starts counting again from one.
    const stale = "((abuse_strikes.until_at = 0 AND ? - abuse_strikes.first_at > ?) OR (abuse_strikes.until_at > 0 AND abuse_strikes.until_at <= ?))";
    const row = await db.get(
      `INSERT INTO abuse_strikes (ip, count, first_at, until_at) VALUES (?, 1, ?, 0)
       ON CONFLICT (ip) DO UPDATE SET
         count = CASE WHEN ${stale} THEN 1 ELSE abuse_strikes.count + 1 END,
         first_at = CASE WHEN ${stale} THEN ? ELSE abuse_strikes.first_at END,
         until_at = CASE WHEN ${stale} THEN 0 ELSE abuse_strikes.until_at END
       RETURNING count, until_at`,
      [ip, now, now, WINDOW_MS, now, now, WINDOW_MS, now, now, now, WINDOW_MS, now],
    );
    if (row.until_at === 0 && row.count >= config.abuseStrikes) {
      const until = now + config.abuseBlockMinutes * 60 * 1000;
      const set = await db.run("UPDATE abuse_strikes SET until_at = ? WHERE ip = ? AND until_at = 0", [until, ip]);
      if (set.changes) {
        console.warn(`[abuse] ${ip} blocked for ${config.abuseBlockMinutes} min after ${row.count} rate-limit / bot hits`);
        return true;
      }
    }
  } catch (err) {
    console.error("[abuse] could not record a strike:", err.message);
  }
  return false;
}

/** Milliseconds this IP is still blocked for (0 = not blocked). */
export async function isBlocked(ip, now = Date.now()) {
  const row = await db.get("SELECT until_at FROM abuse_strikes WHERE ip = ?", [ip]);
  if (!row || !row.until_at) return 0;
  if (row.until_at <= now) {
    await db.run("DELETE FROM abuse_strikes WHERE ip = ? AND until_at <= ?", [ip, now]);
    return 0;
  }
  return row.until_at - now;
}

/** First thing on every /api request: an IP that is currently blocked gets nothing. */
export async function blockedIpGuard(req, res, next) {
  const wait = await isBlocked(req.ip);
  if (!wait) return next();
  res.setHeader("Retry-After", String(Math.ceil(wait / 1000)));
  res.status(429).json({ error: "Too many requests. Please try again later." });
}

/** For tests. */
export const _resetStrikes = () => db.run("DELETE FROM abuse_strikes");
