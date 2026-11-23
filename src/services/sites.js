import { db } from "../db.js";
import { config } from "../config.js";
import { toIso } from "./time.js";

/**
 * Candidate sites ("domains"). One backend can serve any number of frontends; every site has its own branding,
 * settings and notification channels (see settings.js), and may have its own roles.
 */

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?::\d{1,5})?$/;

/** "https://WWW.Example.com:443/apply?x=1" -> "www.example.com". Returns "" when it isn't a usable host name. */
export function normalizeDomain(input) {
  if (typeof input !== "string") return "";
  let v = input.trim().toLowerCase();
  if (!v) return "";
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  v = v.split(/[/?#]/)[0]; // path, query, fragment
  v = v.replace(/^[^@]*@/, ""); // user info
  v = v.replace(/\.$/, ""); // trailing dot
  if (v.length > 253 || !HOST_RE.test(v)) return "";
  return v;
}

// The (small) list of domains is read once and kept in memory for config.settingsCacheMs, like the settings are.
let cache = null;

export function invalidateSites() {
  cache = null;
}

async function allSites() {
  if (!cache || config.settingsCacheMs <= 0 || Date.now() - cache.at > config.settingsCacheMs) {
    const entry = { at: Date.now(), promise: db.all("SELECT * FROM sites") };
    cache = entry;
    entry.promise.catch(() => {
      if (cache === entry) cache = null;
    });
  }
  return cache.promise;
}

export async function getSiteById(id) {
  if (!id) return null;
  return (await allSites()).find((s) => s.id === id) || null;
}

/**
 * The site for a request host. Tries the exact host (with port), then without the port, then without / with "www.",
 * so "example.com", "www.example.com" and "example.com:3000" can all reach the site registered as "example.com".
 */
export async function findSiteByHost(host) {
  const h = normalizeDomain(host);
  if (!h) return null;
  const noPort = h.replace(/:\d+$/, "");
  const bare = noPort.replace(/^www\./, "");
  const candidates = [...new Set([h, noPort, bare, `www.${bare}`])];
  const sites = await allSites();
  for (const c of candidates) {
    const hit = sites.find((s) => s.domain.toLowerCase() === c);
    if (hit) return hit;
  }
  return null;
}

/** True when `origin` ("https://example.com") belongs to an active site. */
export async function originBelongsToSite(origin) {
  const host = normalizeDomain(origin);
  if (!host) return false;
  const site = await findSiteByHost(host);
  return !!site && !!site.active;
}

export function siteRow(r) {
  return {
    id: r.id,
    name: r.name,
    domain: r.domain,
    active: !!r.active,
    createdAt: toIso(r.created_at),
    applicationCount: r.application_count ?? 0,
    roleCount: r.role_count ?? 0,
    overrideCount: r.override_count ?? 0,
  };
}

export async function listSites() {
  const rows = await db.all(
    `SELECT s.*,
       (SELECT COUNT(*) FROM applications a WHERE a.site_id = s.id) AS application_count,
       (SELECT COUNT(*) FROM roles r WHERE r.site_id = s.id) AS role_count,
       (SELECT COUNT(*) FROM site_settings x WHERE x.site_id = s.id) AS override_count
     FROM sites s ORDER BY lower(s.domain)`,
  );
  return rows.map(siteRow);
}
