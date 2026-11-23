import rateLimit from "express-rate-limit";
import { db } from "../db.js";
import { recordStrike } from "./antiscrape.js";

/**
 * Rate-limit counters live in the database, not in memory: serverless instances don't share memory, so an in-memory limiter
 * would give every instance its own allowance and reset whenever one was recycled. One small upsert per limited request.
 */
class DbStore {
  localKeys = false;

  constructor(prefix) {
    this.prefix = prefix;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  k(key) {
    return `${this.prefix}:${key}`;
  }

  async get(key) {
    const row = await db.get("SELECT hits, reset_at FROM rate_limits WHERE key = ? AND reset_at > ?", [this.k(key), Date.now()]);
    return row ? { totalHits: row.hits, resetTime: new Date(row.reset_at) } : undefined;
  }

  async increment(key) {
    const now = Date.now();
    const row = await db.get(
      `INSERT INTO rate_limits (key, hits, reset_at) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN rate_limits.reset_at <= ? THEN 1 ELSE rate_limits.hits + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= ? THEN ? ELSE rate_limits.reset_at END
       RETURNING hits, reset_at`,
      [this.k(key), now + this.windowMs, now, now, now + this.windowMs],
    );
    return { totalHits: row.hits, resetTime: new Date(row.reset_at) };
  }

  async decrement(key) {
    await db.run("UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = ?", [this.k(key)]);
  }

  async resetKey(key) {
    await db.run("DELETE FROM rate_limits WHERE key = ?", [this.k(key)]);
  }
}

// Every limit hit counts as a strike against the IP; a few strikes in a short time block it for a while (antiscrape.js).
const base = (name) => ({
  standardHeaders: true,
  legacyHeaders: false,
  store: new DbStore(name),
  handler: async (req, res, _next, options) => {
    await recordStrike(req.ip);
    res.status(options.statusCode).json(options.message);
  },
});
const tooMany = (message) => ({ error: message });
// The automated test suite runs many verification flows back to back from a single fake IP, far faster
// than a real visitor ever would; give it a lot more headroom so it exercises behavior, not the limiter.
const scale = process.env.NODE_ENV === "test" ? 50 : 1;

export const verifyStartLimiter = rateLimit({
  ...base("verify-start"),
  windowMs: 10 * 60 * 1000,
  limit: 30 * scale,
  message: tooMany("Too many verification attempts. Please try again later."),
});

export const verifyLimiter = rateLimit({
  ...base("verify"),
  windowMs: 60 * 1000,
  limit: 60 * scale,
  message: tooMany("Too many requests. Please slow down."),
});

/** Role search: plenty for someone typing, far too slow for copying the whole role list. */
export const rolesLimiter = [
  rateLimit({ ...base("roles-minute"), windowMs: 60 * 1000, limit: 40 * scale, message: tooMany("Too many searches. Please slow down.") }),
  rateLimit({ ...base("roles-hour"), windowMs: 60 * 60 * 1000, limit: 400 * scale, message: tooMany("Too many searches. Please try again later.") }),
];

export const applyLimiter = rateLimit({
  ...base("apply"),
  windowMs: 60 * 60 * 1000,
  limit: 15 * scale,
  message: tooMany("Too many submissions from this network. Please try again later."),
});

/** Asking for upload URLs happens once per submission attempt (before /apply), so it gets its own allowance. */
export const uploadUrlLimiter = rateLimit({
  ...base("upload-url"),
  windowMs: 60 * 60 * 1000,
  limit: 30 * scale,
  message: tooMany("Too many uploads from this network. Please try again later."),
});

export const loginLimiter = rateLimit({
  ...base("login"),
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: tooMany("Too many failed logins. Try again in 15 minutes."),
});

/** Wrap async route handlers so rejected promises reach the error handler. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Express 4 doesn't catch errors from async handlers. This makes every handler registered on `router` after the call pass a
 * rejected promise on to the error handler, so a database or storage failure becomes a clean 500 instead of a hung request.
 */
export function asyncRoutes(router) {
  const wrapIfHandler = (a) => (typeof a === "function" && a.length < 4 && !a.stack && !a.handle ? wrap(a) : a);
  const wrapArg = (a) => (Array.isArray(a) && a.every((x) => typeof x === "function") ? a.map(wrapIfHandler) : wrapIfHandler(a));
  for (const method of ["get", "post", "put", "patch", "delete", "use", "all"]) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map(wrapArg));
  }
  return router;
}

/**
 * CSRF guard for the cookie-authenticated admin API: state-changing requests must carry a custom header,
 * which a cross-site form or image can't add. The cookie is also SameSite=Strict.
 */
export function requireAjaxHeader(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("x-requested-with") !== "XMLHttpRequest") {
    return res.status(403).json({ error: "Missing X-Requested-With header." });
  }
  next();
}

export function notFound(_req, res) {
  res.status(404).json({ error: "Not found" });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "That file is too large." });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid JSON." });
  }
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status === 500) console.error("[error]", err);
  res.status(status).json({ error: status === 500 ? "Something went wrong." : err.message });
}
