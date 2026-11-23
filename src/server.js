import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { ensureReady } from "./schema.js";
import publicRoutes from "./routes/public.js";
import authRoutes from "./routes/auth.js";
import adminRoutes from "./routes/admin.js";
import verifyRoutes from "./routes/verify.js";
import cronRoutes from "./routes/cron.js";
import { errorHandler, notFound } from "./middleware/security.js";
import { blockedIpGuard, botGuard, noIndex, robotsTxt } from "./middleware/antiscrape.js";
import { trustedClientIp } from "./middleware/clientip.js";
import { notificationsEnabled } from "./services/notify.js";
import { getAdminThemeVars } from "./services/settings.js";
import { originBelongsToSite } from "./services/sites.js";
import { maybeRunMaintenance, runMaintenance } from "./services/maintenance.js";
import { background } from "./lib/background.js";
import * as storage from "./storage.js";
import { localStorageRoutes, LOCAL_STORAGE_PREFIX } from "./storage.js";

export const app = express();
app.set("trust proxy", config.trustProxy);
app.disable("x-powered-by");

// Strong transport security: a long-lived, preload-eligible HSTS header on every response (once a browser has seen
// it, it refuses to downgrade this origin to plain http again, even if a future request is tampered with), and in
// production a redirect for any request that still arrives over plain http. req.secure is computed from
// X-Forwarded-Proto when "trust proxy" above is set, so this is correct behind a TLS-terminating reverse proxy too
// (which is how Vercel reaches this app).
// The admin page uploads files straight to Supabase Storage (signed upload URLs) and shows images/videos served from it, so that
// one origin is added to the otherwise strict content-security policy.
const supabaseOrigin = (() => {
  try {
    return config.storage.supabaseUrl ? new URL(config.storage.supabaseUrl).origin : null;
  } catch {
    return null;
  }
})();
const withStorage = (...base) => (supabaseOrigin ? [...base, supabaseOrigin] : base);
app.use(
  helmet({
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true, preload: true },
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "connect-src": withStorage("'self'"),
        "img-src": withStorage("'self'", "data:"),
        "media-src": withStorage("'self'"),
      },
    },
  }),
);
if (config.forceHttps) {
  app.use((req, res, next) => {
    if (req.secure) return next();
    res.redirect(308, `https://${req.get("host")}${req.originalUrl}`);
  });
}

// Liveness probe: answers 200 as long as the process is up and the event loop is running.
// Deliberately does NOT touch the database -- it stays "healthy" during startup and while the
// DB is briefly unreachable, so a load balancer / orchestrator won't kill a container that is
// merely waiting for Postgres. Use /readyz (below) if you want a dependency-aware check.
app.get("/healthy", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// Readiness probe: only 200 when the database is reachable and the schema is prepared.
// Kept separate from /healthy so a slow/absent DB doesn't make a perfectly fine process look dead.
app.get("/readyz", async (_req, res) => {
  try {
    await ensureReady();
    res.status(200).json({ status: "ready" });
  } catch (err) {
    console.error("[readyz]", err);
    res.status(503).json({ status: "not_ready", error: "database unreachable" });
  }
});

// The visitor's real address when the request came through the candidate site's /api proxy (see middleware/clientip.js)
app.use(trustedClientIp);

// The database tables, storage buckets and first-run data are created on the first request of each instance (one cheap query
// afterwards). Static admin files don't need the database, so they skip this.
const needsDatabase = (req) => req.path.startsWith("/api") || req.path.startsWith("/media") || req.path === "/admin/theme.css";
app.use(async (req, res, next) => {
  if (!needsDatabase(req)) return next();
  try {
    await ensureReady();
    next();
  } catch (err) {
    console.error("[startup]", err);
    res.status(503).json({ error: "The service is starting up or its database isn't reachable. Please try again in a moment." });
  }
});

// Cross-origin calls: origins listed in CORS_ORIGINS may use cookies (they can reach the admin API). The domains registered
// under Domains may call the public API from the browser too, but never with cookies.
app.use(
  cors(async (req, cb) => {
    try {
      const origin = req.get("origin");
      if (!origin) return cb(null, { origin: false });
      if (config.corsOrigins.includes(origin)) return cb(null, { origin: true, credentials: true });
      if (await originBelongsToSite(origin)) return cb(null, { origin: true, credentials: false });
      cb(null, { origin: false });
    } catch (err) {
      cb(err);
    }
  }),
);
app.use(express.json({ limit: "50kb" }));
app.use(cookieParser());

// Anti-scraping: no indexing anywhere, a blocked IP gets nothing, scripts can't use the login either (see middleware/antiscrape.js)
app.use(noIndex);
app.get("/robots.txt", robotsTxt);

// Housekeeping (expired sessions, abandoned uploads, the storage limit) about once an hour per running instance, in the background.
app.use("/api", (_req, res, next) => {
  // Ask Chromium browsers (Chrome, Edge, Brave) to also send their exact OS version (it tells Windows 11 from 10, which the
  // User-Agent cannot); it is only used for the platform label shown in the verification step and the notifications.
  res.setHeader("Accept-CH", "Sec-CH-UA-Platform-Version");
  background(maybeRunMaintenance());
  next();
});
app.use("/api/cron", cronRoutes);
if (config.storage.driver === "local") app.use(LOCAL_STORAGE_PREFIX, localStorageRoutes());

app.use("/api", blockedIpGuard);
app.use("/api/auth", botGuard);
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api", publicRoutes);
app.use("/api/verify", verifyRoutes);
app.use("/api", notFound);

// Uploaded logo and background live in the public media bucket; this sends the browser there. Files have random names, so the
// redirect can be cached. Resumes are NOT in here.
const MEDIA_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp4": "video/mp4", ".webm": "video/webm" };
app.get("/media/:file", async (req, res) => {
  const name = req.params.file;
  if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) return res.status(404).json({ error: "Not found" });
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  // helmet sends "same-origin" for everything; the logo and background are meant to be shown on the candidate sites (a different
  // origin than this backend), and browsers refuse the redirect below otherwise (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin).
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (config.storage.driver === "local") {
    // sendFile answers Range requests, so browsers can stream and loop a background video
    const file = storage.localPath("media", name);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "Not found" });
    return res.type(MEDIA_TYPES[path.extname(name).toLowerCase()] || "application/octet-stream").sendFile(file, { dotfiles: "allow" });
  }
  res.redirect(302, await storage.publicUrl(name));
});

// Colors for the admin UI, from the theme the super admin picked. Public on purpose (the login page needs it).
app.get("/admin/theme.css", async (_req, res) => {
  const vars = Object.entries(await getAdminThemeVars())
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  res.setHeader("Content-Type", "text/css; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.send(`:root {\n${vars}\n}\n`);
});

// Backend UI (login required for every action; the page itself is only a login form + scripts)
app.use("/admin", express.static(path.join(config.root, "public", "admin"), { index: "index.html" }));
app.get("/", (_req, res) => res.redirect("/admin/"));

app.use(errorHandler);

/**
 * Starts the server on a machine of your own (not needed on Vercel, which imports `app` from api/index.js).
 * The plain-http listener on `config.port` always starts (it's what FORCE_HTTPS's 308-redirect
 * middleware above needs to have something to redirect, and what a reverse proxy that already terminates TLS
 * talks to over its own internal network). When TLS_CERT_FILE/TLS_KEY_FILE are set, a second listener on
 * `config.tls.port` terminates TLS itself, right here in this process. Exported so tests can call it directly with their own
 * env instead of spawning a subprocess.
 */
export function startServers() {
  ensureReady().catch((err) => console.error("[startup] could not prepare the database:", err.message));
  setInterval(() => runMaintenance().catch((err) => console.error("[maintenance]", err.message)), 60 * 60 * 1000).unref();

  const httpServer = http.createServer(app);
  httpServer.listen(config.port, async () => {
    console.log(`API + admin UI on http://localhost:${config.port}  (admin: /admin/)`);
    try {
      const n = await notificationsEnabled();
      console.log(`Default notifications: Slack ${n.slack ? "on" : "off"}, Telegram ${n.telegram ? "on" : "off"}`);
    } catch {
      /* the database isn't ready yet; the line above is informational only */
    }
    if (config.isProd && !config.siteProxyKey) {
      console.warn("[config] SITE_PROXY_KEY is not set: any visitor can pick which domain's settings apply by sending X-Site-Host. Set the same secret on the frontend and here.");
    }
    if (config.isProd && !config.publicBaseUrl.startsWith("https://")) {
      console.warn("[config] PUBLIC_BASE_URL does not start with https:// -- links sent to Slack/Telegram and the HSTS/redirect behavior expect this app to be reachable over TLS in production.");
    }
  });

  let httpsServer = null;
  if (config.tls.certFile && config.tls.keyFile) {
    try {
      const credentials = {
        cert: fs.readFileSync(config.tls.certFile),
        key: fs.readFileSync(config.tls.keyFile),
        ca: config.tls.caFile ? fs.readFileSync(config.tls.caFile) : undefined,
        // Strong transport encryption: refuse TLS 1.0/1.1 (both are deprecated and have known weaknesses) and let
        // Node pick from its own modern, AEAD-only default cipher list for 1.2/1.3.
        minVersion: "TLSv1.2",
        honorCipherOrder: true,
      };
      httpsServer = https.createServer(credentials, app);
      httpsServer.listen(config.tls.port, () => {
        console.log(`API + admin UI also on https://localhost:${config.tls.port} -- TLS terminated here. Point the frontend's BACKEND_URL at this one.`);
      });
    } catch (e) {
      console.error(`[tls] Could not start the HTTPS listener (${e.message}). Check TLS_CERT_FILE / TLS_KEY_FILE / TLS_CA_FILE. Continuing on plain HTTP only.`);
    }
  } else if (config.isProd && !process.env.VERCEL) {
    console.warn(
      "[tls] TLS_CERT_FILE/TLS_KEY_FILE are not set: this process only speaks plain HTTP on its own. That's fine if a reverse proxy or load balancer in front of it already terminates TLS -- otherwise set those two variables so this server encrypts the hop itself before BACKEND_URL points anywhere outside localhost.",
    );
  }

  return { httpServer, httpsServer };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  startServers();
}