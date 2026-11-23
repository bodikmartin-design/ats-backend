import crypto from "node:crypto";
import { config } from "../config.js";
import { findSiteByHost, normalizeDomain } from "../services/sites.js";

export function sameSecret(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * Which domain is this request for?
 *  - X-Site-Host, sent by the frontend. When SITE_PROXY_KEY is set it is only believed if X-Site-Key matches, and the
 *    only fallback is the request's own Host header (a visitor can't pick another domain by faking Origin or X-Forwarded-Host).
 *  - Without a key (local development): X-Site-Host, then Origin, then X-Forwarded-Host, then Host.
 */
export function requestHost(req) {
  const first = (v) => String(v || "").split(",")[0].trim();
  const candidates = config.siteProxyKey
    ? [sameSecret(req.get("x-site-key"), config.siteProxyKey) ? req.get("x-site-host") : "", req.get("host")]
    : [req.get("x-site-host"), req.get("origin"), req.get("x-forwarded-host"), req.get("host")];
  for (const c of candidates) {
    const host = normalizeDomain(first(c));
    if (host) return host;
  }
  return "";
}

/** Sets req.siteHost and req.site (null = not a registered domain: the default settings apply). */
export async function siteContext(req, _res, next) {
  try {
    req.siteHost = requestHost(req);
    req.site = req.siteHost ? await findSiteByHost(req.siteHost) : null;
    next();
  } catch (err) {
    next(err);
  }
}

/** Is this site allowed to take part (a registered domain that is switched on, or default settings when unknown domains are allowed)? */
export function siteIsOpen(req) {
  if (req.site) return !!req.site.active;
  return !config.requireKnownDomain;
}

/** For endpoints that start or finish an application: refuse switched-off or unknown domains. */
export function requireOpenSite(req, res, next) {
  if (siteIsOpen(req)) return next();
  res.status(403).json({ error: "This site isn't accepting applications right now.", closed: true });
}

export const siteIdOf = (req) => req.site?.id ?? null;
