import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const isProd = env.NODE_ENV === "production";

function int(value, fallback) {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(n) ? n : fallback;
}

function list(value) {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function trustProxy(value) {
  // On Vercel there is exactly one proxy in front of the function, and it sets X-Forwarded-For to the real client address.
  if (value === undefined || value === "") return env.VERCEL ? 1 : "loopback";
  if (value === "false") return false;
  if (value === "true") return true;
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

let jwtSecret = env.JWT_SECRET;
if (!jwtSecret) {
  if (isProd) throw new Error("JWT_SECRET must be set in production");
  jwtSecret = crypto.randomBytes(32).toString("hex");
  console.warn("[config] JWT_SECRET not set: using a random one. Admin logins reset on every restart.");
}

const MB = 1024 * 1024;

export const config = {
  isProd,
  root,
  port: int(env.PORT, 4000),

  // ---- Database: Supabase Postgres ----
  // DATABASE_URL is the Postgres connection string from Supabase (Project Settings > Database > Connection string).
  // On Vercel use the *transaction pooler* string (port 6543): every function instance opens its own connections, and the
  // pooler is what keeps them from exhausting Postgres. "pglite" is an in-process Postgres used by the automated tests and
  // for trying the app locally without a Supabase project (DB_DRIVER=pglite, optional PGLITE_DIR to keep the data).
  db: {
    driver: env.DB_DRIVER || "pg",
    url: env.DATABASE_URL || "",
    poolMax: int(env.DB_POOL_MAX, 3),
    // Supabase's poolers present a certificate that Node doesn't trust out of the box. By default the connection is
    // encrypted but the certificate is not verified; set DATABASE_CA_CERT (the PEM from Supabase > Database > SSL
    // Configuration) to verify it fully. DATABASE_SSL=false turns TLS off (a local Postgres only).
    ssl: env.DATABASE_SSL !== "false",
    caCert: (env.DATABASE_CA_CERT || "").replace(/\\n/g, "\n"),
    pgliteDir: env.PGLITE_DIR || "",
  },
  // How long (ms) site settings / domains are cached inside one running instance. Saving in the admin UI clears the cache of the
  // instance that handled the save at once; other running instances pick the change up within this time.
  settingsCacheMs: int(env.SETTINGS_CACHE_MS, 5000),

  // ---- File storage: Supabase Storage ----
  // Resumes and photos live in a PRIVATE bucket, the logo / background in a PUBLIC one. Both are created automatically.
  // "local" keeps the files in a folder instead (automated tests / local trials without Supabase).
  storage: {
    driver: env.STORAGE_DRIVER || "supabase",
    supabaseUrl: (env.SUPABASE_URL || "").replace(/\/$/, ""),
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
    // Optional. Only sent as the `apikey` header on direct browser uploads, for projects whose gateway insists on it.
    anonKey: env.SUPABASE_ANON_KEY || "",
    uploadsBucket: env.SUPABASE_UPLOADS_BUCKET || "resume-uploads",
    mediaBucket: env.SUPABASE_MEDIA_BUCKET || "portal-media",
    localDir: env.LOCAL_STORAGE_DIR ? path.resolve(env.LOCAL_STORAGE_DIR) : path.join(root, "data", "storage"),
    // Total size of all stored resumes + photos. Above it, the oldest applications (with their files) are deleted automatically
    // until the total is back under the limit. 0 turns the automatic deletion off.
    maxTotalBytes: int(env.MAX_STORAGE_MB, 300) * MB,
    // Files that were uploaded by a browser but never attached to an application are removed after this many minutes.
    pendingUploadMinutes: int(env.PENDING_UPLOAD_MINUTES, 120),
  },
  // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" to /api/cron/maintenance. Without it that endpoint stays off.
  cronSecret: env.CRON_SECRET || "",

  maxResumeBytes: int(env.MAX_RESUME_MB, 5) * MB,
  maxPhotoBytes: int(env.MAX_PHOTO_MB, 3) * MB,
  jwtSecret,
  adminSessionHours: int(env.ADMIN_SESSION_HOURS, 8),
  trustProxy: trustProxy(env.TRUST_PROXY),
  corsOrigins: list(env.CORS_ORIGINS),
  // Redirects plain-http requests to https and sends a long-lived HSTS header. On by default in production; a
  // deployment that terminates TLS at a load balancer and reaches this app over plain http internally (and sets
  // X-Forwarded-Proto correctly, read via "trust proxy" above) should leave this on -- req.secure follows that header.
  // Only turn it off (FORCE_HTTPS=false) for a deployment that genuinely has no TLS in front of it anywhere.
  forceHttps: env.FORCE_HTTPS === undefined ? isProd : env.FORCE_HTTPS === "true",
  // Multi-domain: which candidate site (domain) a request belongs to is read from the X-Site-Host header that the frontend
  // sends. If SITE_PROXY_KEY is set, that header is only believed when X-Site-Key carries the same secret.
  // Anti-scraping (see middleware/antiscrape.js). BLOCK_BOTS=false turns off the User-Agent filter. An IP that causes
  // ABUSE_STRIKES rate-limit / bot hits within 10 minutes is blocked for ABUSE_BLOCK_MINUTES (ABUSE_STRIKES=0 disables blocking).
  blockBots: env.BLOCK_BOTS !== "false",
  abuseStrikes: int(env.ABUSE_STRIKES, 5),
  abuseBlockMinutes: int(env.ABUSE_BLOCK_MINUTES, 30),
  siteProxyKey: env.SITE_PROXY_KEY || "",
  // true = requests from a domain that is not listed under Domains are refused (instead of using the default settings)
  requireKnownDomain: env.REQUIRE_KNOWN_DOMAIN === "true",
  // Public URL of the admin UI, used in Slack/Telegram messages
  publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${int(env.PORT, 4000)}`).replace(/\/$/, ""),

  // Encrypts the Next.js <-> Express hop at the source, instead of relying only on a reverse proxy in front of this
  // app: when both a cert and a key are set, the server terminates TLS itself on tlsPort (see startServers() in
  // server.js), on top of the plain-http listener on `port` above (kept open only so FORCE_HTTPS can 308-redirect
  // it, and for a reverse proxy that already terminates TLS further out). Point the frontend's BACKEND_URL at
  // https://<this host>:<tlsPort> once this is set. TLS 1.2 is the floor; older, broken protocol versions are refused.
  tls: {
    certFile: env.TLS_CERT_FILE ? path.resolve(env.TLS_CERT_FILE) : "",
    keyFile: env.TLS_KEY_FILE ? path.resolve(env.TLS_KEY_FILE) : "",
    caFile: env.TLS_CA_FILE ? path.resolve(env.TLS_CA_FILE) : "",
    port: int(env.TLS_PORT, 4443),
  },

  verify: {
    maxAttempts: int(env.VERIFY_MAX_ATTEMPTS, 3),
    sessionMinutes: int(env.VERIFY_SESSION_MINUTES, 15),
    // After passing all 3 stages the token stays valid this long
    tokenMinutes: int(env.VERIFY_TOKEN_MINUTES, 30),
    // The copy/paste (stage 3) challenge has no expiry of its own (see verification.js); an abandoned one is instead
    // swept up by age during the regular cleanup (db.js: cleanupVerifySessions), so the table doesn't grow forever.
    copySessionMaxAgeDays: int(env.COPY_SESSION_MAX_AGE_DAYS, 7),
    // An unfinished "confirm" session (the one-step re-check shown in the confirm-submit modal) is cleaned up sooner.
    confirmSessionMaxAgeHours: int(env.CONFIRM_SESSION_MAX_AGE_HOURS, 24),
  },

  seedSuperAdmin: {
    email: env.SUPERADMIN_EMAIL || "",
    password: env.SUPERADMIN_PASSWORD || "",
  },

  // Uploaded logo / background. Kept apart from resumes: that bucket is public, the resume bucket never is.
  media: {
    logoBytes: int(env.MAX_LOGO_MB, 2) * MB,
    imageBytes: int(env.MAX_BG_IMAGE_MB, 10) * MB,
    videoBytes: int(env.MAX_BG_VIDEO_MB, 40) * MB,
  },

  // Env values are the fallback; anything the super admin saves on the Settings page wins.
  slack: {
    webhookUrl: env.SLACK_WEBHOOK_URL || "",
    // The Settings page only accepts webhook URLs on these hosts (stops it being used to make the server call anything)
    allowedHosts: list(env.SLACK_ALLOWED_HOSTS).length ? list(env.SLACK_ALLOWED_HOSTS) : ["hooks.slack.com", "hooks.slack-gov.com"],
    allowHttp: env.SLACK_ALLOW_HTTP === "true", // only for local testing
  },
  telegram: {
    botToken: env.TELEGRAM_BOT_TOKEN || "",
    chatId: env.TELEGRAM_CHAT_ID || "",
    sendFile: (env.TELEGRAM_SEND_FILE || "true") !== "false",
    apiBase: (env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, ""),
  },
};
