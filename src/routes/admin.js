import path from "node:path";
import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "../db.js";
import { config } from "../config.js";
import { requireAuth, requireSuperAdmin } from "../middleware/auth.js";
import { requireAjaxHeader } from "../middleware/security.js";
import { getClientInfo } from "../services/clientInfo.js";
import { logEvent } from "../services/activity.js";
import { createApplication, validateApplicant } from "../services/applications.js";
import { notifyNewApplication, notificationsEnabled } from "../services/notify.js";
import { claimApplicationUploads, issueApplicationUploads, safeDisplayName } from "../services/uploads.js";
import { purgeUploadObjects } from "../services/pending.js";
import { enforceStorageLimit, storageUsage } from "../services/quota.js";
import * as storage from "../storage.js";
import { hiringTypes, workingTypes } from "../services/typeCatalog.js";
import * as v from "../lib/validate.js";
import { getAdminSettings, getOwnSetting, getTimeZone, ownedMediaFiles, putSetting, resetSiteSettings, updateSettings } from "../services/settings.js";
import { getSiteById, invalidateSites, listSites, normalizeDomain } from "../services/sites.js";
import { importBlockchainRoles } from "../services/roleCatalog.js";
import { claimMediaUpload, finishMediaUpload, issueMediaUpload, removeMedia } from "../services/media.js";
import { sendTestNotification } from "../services/notify.js";
import { formatInZone, toIso } from "../services/time.js";
import { background } from "../lib/background.js";
import { asyncRoutes } from "../middleware/security.js";

const router = asyncRoutes(Router());
router.use(requireAuth, requireAjaxHeader);

const bool = (x) => (x === false || x === 0 || x === "0" || x === "false" ? 0 : 1);
const bad = (res, errors, message = "Please fix the highlighted fields.") =>
  res.status(400).json({ error: message, fields: errors });

/** ?siteId= on the settings endpoints: empty / "default" = the default settings, a number = that domain. Sends a 404 and returns null if it doesn't exist. */
async function settingsScope(req, res) {
  const raw = req.query.siteId;
  if (raw === undefined || raw === "" || raw === "default") return { siteId: null };
  const id = v.positiveInt(raw);
  if (!id || !(await getSiteById(id))) {
    res.status(404).json({ error: "Domain not found." });
    return null;
  }
  return { siteId: id };
}

/** ?siteId= as a list filter: empty = everything, "none" / "default" = not tied to a domain, a number = that domain. */
function siteFilter(req, column) {
  const raw = req.query.siteId;
  if (raw === "none" || raw === "default") return { clause: `${column} IS NULL`, params: [] };
  const id = v.positiveInt(raw);
  return id ? { clause: `${column} = ?`, params: [id] } : null;
}

// ------------------------------------------------------------------ status

router.get("/status", async (_req, res) => {
  res.json({
    notifications: await notificationsEnabled(),
    maxResumeMb: config.maxResumeBytes / 1024 / 1024,
    timeZone: await getTimeZone(),
    storage: await storageUsage(),
  });
});

// ------------------------------------------------------------------ domains (read: any admin; write: super admin, below)

router.get("/sites", async (_req, res) => res.json({ sites: await listSites() }));

async function siteInput(body, id = null) {
  const c = v.collect({ name: v.text(body.name, "Name", { required: true, max: 80 }) });
  const domain = normalizeDomain(body.domain);
  if (!domain) c.errors.domain = "Enter a domain such as careers.example.com (add :3000 for local testing).";
  else {
    const taken = await db.get("SELECT id FROM sites WHERE lower(domain) = lower(?)", [domain]);
    if (taken && taken.id !== id) c.errors.domain = "That domain is already added.";
  }
  c.values.domain = domain;
  c.values.active = bool(body.active);
  c.ok = Object.keys(c.errors).length === 0;
  return c;
}

// ------------------------------------------------------------------ companies (admin + super admin)
// Companies and roles are managed per domain: each one belongs to a domain and is only offered to candidates on that
// domain. One with no domain is shared by every domain. A role always lives on its company's domain (see roleInput).

/** body.siteId -> a domain id, or null for "all domains". Returns { id } or { error }. */
async function domainFrom(body) {
  const raw = body.siteId;
  if (raw === undefined || raw === null || raw === "" || raw === "all") return { id: null };
  const id = v.positiveInt(raw);
  if (id && (await getSiteById(id))) return { id };
  return { error: "Choose a domain from the list, or all domains." };
}

async function companyInput(body) {
  const c = v.collect({
    name: v.text(body.name, "Name", { required: true, max: 120 }),
    description: v.text(body.description, "Description", { max: 2000 }),
    website: v.url(body.website),
    location: v.text(body.location, "Location", { max: 120 }),
    contact_email: v.email(body.contactEmail, "Contact email", { required: false }),
  });
  c.values.active = bool(body.active);
  const domain = await domainFrom(body);
  if (domain.error) c.errors.siteId = domain.error;
  c.values.site_id = domain.id ?? null;
  c.ok = Object.keys(c.errors).length === 0;
  return c;
}

const companyRow = (r) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  website: r.website,
  location: r.location,
  contactEmail: r.contact_email,
  active: !!r.active,
  siteId: r.site_id ?? null,
  siteDomain: r.site_domain || "",
  roleCount: Number(r.role_count),
  updatedAt: toIso(r.updated_at),
});

// ?siteId= filters like on the other pages: empty = every domain, "none" = shared by all domains, a number = that domain
// (a domain's list also needs the shared ones to be usable there: add ?withShared=1).
router.get("/companies", async (req, res) => {
  const where = [];
  const params = [];
  const bySite = siteFilter(req, "c.site_id");
  if (bySite) {
    const shared = req.query.withShared === "1" && bySite.params.length ? " OR c.site_id IS NULL" : "";
    where.push(`(${bySite.clause}${shared})`);
    params.push(...bySite.params);
  }
  const rows = await db.all(
    `SELECT c.*, s.domain AS site_domain, (SELECT COUNT(*) FROM roles r WHERE r.company_id = c.id) AS role_count
     FROM companies c LEFT JOIN sites s ON s.id = c.site_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY lower(c.name), c.id`,
    params,
  );
  res.json({ companies: rows.map(companyRow) });
});

router.post("/companies", async (req, res) => {
  const c = await companyInput(req.body || {});
  if (!c.ok) return bad(res, c.errors);
  const x = c.values;
  const id = await db.insert(
    "INSERT INTO companies (name, description, website, location, contact_email, active, site_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [x.name, x.description, x.website, x.location, x.contact_email, x.active, x.site_id],
  );
  await logEvent("company_created", getClientInfo(req), { userId: req.user.id, siteId: x.site_id, details: { id } });
  res.status(201).json({ id });
});

router.put("/companies/:id", async (req, res) => {
  const id = v.positiveInt(req.params.id);
  if (!id || !(await db.get("SELECT 1 AS x FROM companies WHERE id = ?", [id]))) {
    return res.status(404).json({ error: "Company not found." });
  }
  const c = await companyInput(req.body || {});
  if (!c.ok) return bad(res, c.errors);
  const x = c.values;
  // A company on a domain keeps all its roles on that domain: moving the company moves its roles with it.
  const rolesMoved = await db.tx(async (t) => {
    await t.run(
      `UPDATE companies SET name = ?, description = ?, website = ?, location = ?, contact_email = ?, active = ?, site_id = ?,
       updated_at = now() WHERE id = ?`,
      [x.name, x.description, x.website, x.location, x.contact_email, x.active, x.site_id, id],
    );
    if (!x.site_id) return 0;
    return (await t.run("UPDATE roles SET site_id = ?, updated_at = now() WHERE company_id = ? AND site_id IS DISTINCT FROM ?", [x.site_id, id, x.site_id])).changes;
  });
  await logEvent("company_updated", getClientInfo(req), { userId: req.user.id, siteId: x.site_id, details: { id, rolesMoved } });
  res.json({ ok: true, rolesMoved });
});

router.delete("/companies/:id", async (req, res) => {
  const id = v.positiveInt(req.params.id);
  if (!id) return res.status(404).json({ error: "Company not found." });
  const roles = (await db.get("SELECT COUNT(*) AS n FROM roles WHERE company_id = ?", [id])).n;
  if (roles > 0) {
    return res.status(409).json({ error: "Delete or move this company's roles first, or just mark it inactive." });
  }
  const info = await db.run("DELETE FROM companies WHERE id = ?", [id]);
  if (!info.changes) return res.status(404).json({ error: "Company not found." });
  await logEvent("company_deleted", getClientInfo(req), { userId: req.user.id, details: { id } });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ roles (admin + super admin)

async function roleInput(body) {
  const c = v.collect({
    title: v.text(body.title, "Title", { required: true, max: 120 }),
    department: v.text(body.department, "Department", { max: 80 }),
    location: v.text(body.location, "Location", { max: 120 }),
    description: v.text(body.description, "Description", { max: 4000 }),
  });
  const companyId = v.positiveInt(body.companyId);
  const company = companyId ? await db.get("SELECT id, site_id FROM companies WHERE id = ?", [companyId]) : null;
  if (!company) c.errors.companyId = "Choose a company.";
  c.values.company_id = companyId;
  const type = typeof body.employmentType === "string" ? body.employmentType : "Full-time";
  if (!v.EMPLOYMENT_TYPES.includes(type)) c.errors.employmentType = "Invalid employment type.";
  c.values.employment_type = type;
  c.values.active = bool(body.active);
  // A role belongs to a domain. A company on a domain only has roles on that same domain (left empty, the role simply takes it);
  // a company shared by all domains can have roles on any one domain, or shared ones.
  const domain = await domainFrom(body);
  if (domain.error) c.errors.siteId = domain.error;
  else if (company?.site_id && domain.id && domain.id !== company.site_id) {
    const home = await getSiteById(company.site_id);
    c.errors.siteId = `This company belongs to ${home?.domain || "another domain"}, so its roles must be on that domain.`;
  }
  c.values.site_id = company?.site_id || domain.id || null;
  c.ok = Object.keys(c.errors).length === 0;
  return c;
}

const roleRow = (r) => ({
  id: r.id,
  companyId: r.company_id,
  companyName: r.company_name,
  title: r.title,
  department: r.department,
  location: r.location,
  employmentType: r.employment_type,
  description: r.description,
  active: !!r.active,
  siteId: r.site_id ?? null,
  siteDomain: r.site_domain || "",
  updatedAt: toIso(r.updated_at),
});

router.get("/roles", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const where = [];
  const params = [];
  for (const t of q.split(/\s+/).filter(Boolean).slice(0, 5)) {
    where.push(
      `(r.title ILIKE ? ESCAPE '\\' OR r.department ILIKE ? ESCAPE '\\' OR r.location ILIKE ? ESCAPE '\\' OR c.name ILIKE ? ESCAPE '\\')`,
    );
    const p = v.likeTerm(t);
    params.push(p, p, p, p);
  }
  const companyId = v.positiveInt(req.query.companyId);
  if (companyId) {
    where.push("r.company_id = ?");
    params.push(companyId);
  }
  const bySite = siteFilter(req, "r.site_id");
  if (bySite) {
    where.push(bySite.clause);
    params.push(...bySite.params);
  }
  const rows = await db.all(
    `SELECT r.*, c.name AS company_name, s.domain AS site_domain FROM roles r JOIN companies c ON c.id = r.company_id
     LEFT JOIN sites s ON s.id = r.site_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY lower(c.name), lower(r.title) LIMIT 500`,
    params,
  );
  res.json({ roles: rows.map(roleRow) });
});

router.post("/roles", async (req, res) => {
  const c = await roleInput(req.body || {});
  if (!c.ok) return bad(res, c.errors);
  const x = c.values;
  const id = await db.insert(
    `INSERT INTO roles (company_id, title, department, location, employment_type, description, active, site_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [x.company_id, x.title, x.department, x.location, x.employment_type, x.description, x.active, x.site_id],
  );
  await logEvent("role_created", getClientInfo(req), { userId: req.user.id, siteId: x.site_id, details: { id } });
  res.status(201).json({ id });
});

router.put("/roles/:id", async (req, res) => {
  const id = v.positiveInt(req.params.id);
  if (!id || !(await db.get("SELECT 1 AS x FROM roles WHERE id = ?", [id]))) {
    return res.status(404).json({ error: "Role not found." });
  }
  const c = await roleInput(req.body || {});
  if (!c.ok) return bad(res, c.errors);
  const x = c.values;
  await db.run(
    `UPDATE roles SET company_id = ?, title = ?, department = ?, location = ?, employment_type = ?,
     description = ?, active = ?, site_id = ?, updated_at = now() WHERE id = ?`,
    [x.company_id, x.title, x.department, x.location, x.employment_type, x.description, x.active, x.site_id, id],
  );
  await logEvent("role_updated", getClientInfo(req), { userId: req.user.id, siteId: x.site_id, details: { id } });
  res.json({ ok: true });
});

/** Add the general blockchain / Web3 roles (skips titles that already exist in the company). */
router.post("/roles/import-blockchain", async (req, res) => {
  const companyId = v.positiveInt(req.body?.companyId);
  if (companyId && !(await db.get("SELECT 1 AS x FROM companies WHERE id = ?", [companyId]))) {
    return res.status(404).json({ error: "Company not found." });
  }
  // without a company, the "Blockchain Project" company of the chosen domain is used (created if needed)
  const domain = await domainFrom(req.body || {});
  if (domain.error) return bad(res, { siteId: domain.error });
  const result = await importBlockchainRoles({ companyId, siteId: domain.id });
  await logEvent("roles_imported", getClientInfo(req), { userId: req.user.id, details: result });
  res.json(result);
});

router.delete("/roles/:id", async (req, res) => {
  const id = v.positiveInt(req.params.id);
  const info = id ? await db.run("DELETE FROM roles WHERE id = ?", [id]) : { changes: 0 };
  if (!info.changes) return res.status(404).json({ error: "Role not found." });
  await logEvent("role_deleted", getClientInfo(req), { userId: req.user.id, details: { id } });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ hiring types / working types (admin + super admin)
// Candidate-facing dropdowns on the apply form. Same shape and site-scoping rules as roles (see roleInput above):
// a row with no domain shows on every site, a row tied to one domain shows only there.

async function typeInput(body) {
  const c = v.collect({ label: v.text(body.label, "Label", { required: true, max: 60 }) });
  c.values.active = bool(body.active);
  const order = Number(body.sortOrder);
  c.values.sort_order = Number.isInteger(order) ? order : 0;
  const rawSite = body.siteId;
  if (rawSite === undefined || rawSite === null || rawSite === "" || rawSite === "all") c.values.site_id = null;
  else if (v.positiveInt(rawSite) && (await getSiteById(v.positiveInt(rawSite)))) c.values.site_id = v.positiveInt(rawSite);
  else c.errors.siteId = "Choose a domain from the list, or all domains.";
  c.ok = Object.keys(c.errors).length === 0;
  return c;
}

const typeRow = (r) => ({
  id: r.id,
  label: r.label,
  active: !!r.active,
  sortOrder: r.sort_order,
  siteId: r.site_id ?? null,
  siteDomain: r.site_domain || "",
});

/** Mounts GET/POST/PUT/DELETE for a hiring-type or working-type catalog at `path` ("/hiring-types" or "/working-types"). */
function mountTypeCatalog(path, catalog, logPrefix, responseKey) {
  router.get(path, async (_req, res) => res.json({ [responseKey]: (await catalog.listAdmin()).map(typeRow) }));

  router.post(path, async (req, res) => {
    const c = await typeInput(req.body || {});
    if (!c.ok) return bad(res, c.errors);
    const x = c.values;
    const id = await catalog.create({ label: x.label, siteId: x.site_id, active: x.active, sortOrder: x.sort_order });
    await logEvent(`${logPrefix}_created`, getClientInfo(req), { userId: req.user.id, details: { id } });
    res.status(201).json({ id });
  });

  router.put(`${path}/:id`, async (req, res) => {
    const id = v.positiveInt(req.params.id);
    if (!id || !(await catalog.get(id))) return res.status(404).json({ error: "Not found." });
    const c = await typeInput(req.body || {});
    if (!c.ok) return bad(res, c.errors);
    const x = c.values;
    await catalog.save(id, { label: x.label, siteId: x.site_id, active: x.active, sortOrder: x.sort_order });
    await logEvent(`${logPrefix}_updated`, getClientInfo(req), { userId: req.user.id, details: { id } });
    res.json({ ok: true });
  });

  router.delete(`${path}/:id`, async (req, res) => {
    const id = v.positiveInt(req.params.id);
    if (!id || !(await catalog.remove(id))) return res.status(404).json({ error: "Not found." });
    await logEvent(`${logPrefix}_deleted`, getClientInfo(req), { userId: req.user.id, details: { id } });
    res.json({ ok: true });
  });
}

mountTypeCatalog("/hiring-types", hiringTypes, "hiring_type", "hiringTypes");
mountTypeCatalog("/working-types", workingTypes, "working_type", "workingTypes");

/** Active choices for the "Submit a resume" form: every domain's own plus every "all domains" entry, so an admin
 *  picking any domain in that form always has something to choose from. */
router.get("/application-options", async (_req, res) => {
  const all = async (catalog) => {
    const seen = new Set();
    const labels = [];
    for (const row of await catalog.listAdmin()) {
      if (row.active && !seen.has(row.label)) {
        seen.add(row.label);
        labels.push(row.label);
      }
    }
    return labels;
  };
  res.json({ hiringTypes: await all(hiringTypes), workingTypes: await all(workingTypes) });
});

// ------------------------------------------------------------------ super admin only: history + resumes + users

const superOnly = asyncRoutes(Router());
superOnly.use(requireSuperAdmin);

const applicationRow = (r, tz) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  roleTitle: r.role_title,
  companyName: r.company_name,
  hiringType: r.hiring_type,
  workingType: r.working_type,
  resumeName: r.resume_name,
  resumeSize: r.resume_size,
  resumeKind: path.extname(r.resume_file || "").slice(1).toLowerCase(), // "pdf" | "doc" | "docx"
  hasPhoto: !!r.photo_file,
  photoName: r.photo_name || "",
  photoSize: r.photo_size || 0,
  source: r.source,
  domain: r.site_domain || "",
  submittedBy: r.submitted_by_email || null,
  ip: r.ip,
  country: r.country_name,
  browser: r.browser,
  os: r.os,
  platform: r.platform,
  isMobile: !!r.is_mobile,
  createdAt: toIso(r.created_at),
  createdAtLocal: formatInZone(r.created_at, tz),
});

superOnly.get("/applications", async (req, res) => {
  const { page, pageSize, offset } = v.pageParams(req.query);
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const where = [];
  const params = [];
  for (const t of q.split(/\s+/).filter(Boolean).slice(0, 5)) {
    where.push(
      `(a.name ILIKE ? ESCAPE '\\' OR a.email ILIKE ? ESCAPE '\\' OR a.role_title ILIKE ? ESCAPE '\\'
        OR a.company_name ILIKE ? ESCAPE '\\' OR a.country_name ILIKE ? ESCAPE '\\' OR a.ip ILIKE ? ESCAPE '\\')`,
    );
    const p = v.likeTerm(t);
    params.push(p, p, p, p, p, p);
  }
  const bySite = siteFilter(req, "a.site_id");
  if (bySite) {
    where.push(bySite.clause);
    params.push(...bySite.params);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (await db.get(`SELECT COUNT(*) AS n FROM applications a ${clause}`, params)).n;
  const rows = await db.all(
    `SELECT a.*, u.email AS submitted_by_email FROM applications a
     LEFT JOIN users u ON u.id = a.submitted_by ${clause}
     ORDER BY a.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const tz = await getTimeZone();
  res.json({ applications: rows.map((r) => applicationRow(r, tz)), total, page, pageSize, timeZone: tz, storage: await storageUsage() });
});

const PHOTO_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const missingFile = (res) => !res.headersSent && res.status(404).json({ error: "File is missing on the server." });
// A Vercel function can't send a response body over 4.5 MB. Smaller files are sent by the server (so they can be shown inline
// with the protective headers below); larger ones are handed to storage through a short-lived signed link.
const PROXY_MAX_BYTES = 4_000_000;
const SIGNED_LINK_SECONDS = 60;

// ?inline=1 shows a PDF in the browser; without it (and for Word files, which browsers can't show) the file downloads.
superOnly.get("/applications/:id/resume", async (req, res) => {
  const id = v.positiveInt(req.params.id);
  const row = id ? await db.get("SELECT resume_file, resume_name, resume_size FROM applications WHERE id = ?", [id]) : null;
  if (!row) return res.status(404).json({ error: "Not found." });
  // resume_file is a server-generated UUID name
  const name = path.basename(row.resume_file);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  const inline = req.query.inline === "1" && path.extname(name).toLowerCase() === ".pdf";
  try {
    if (inline && row.resume_size <= PROXY_MAX_BYTES) {
      const bytes = await storage.download("uploads", name);
      res.type("application/pdf");
      res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(row.resume_name || "resume.pdf")}`);
      res.send(bytes);
    } else {
      res.redirect(302, await storage.signedUrl("uploads", name, { expiresIn: SIGNED_LINK_SECONDS, downloadName: inline ? undefined : row.resume_name || "resume" }));
    }
  } catch {
    return missingFile(res);
  }
  await logEvent(inline ? "resume_viewed" : "resume_downloaded", getClientInfo(req), { userId: req.user.id, details: { applicationId: id } });
});

// The photo is shown in the page by default; ?download=1 saves it instead.
superOnly.get("/applications/:id/photo", async (req, res) => {
  const id = v.positiveInt(req.params.id);
  const row = id ? await db.get("SELECT photo_file, photo_name FROM applications WHERE id = ?", [id]) : null;
  if (!row || !row.photo_file) return res.status(404).json({ error: "Not found." });
  const name = path.basename(row.photo_file);
  const type = PHOTO_TYPES[path.extname(name).toLowerCase()];
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  try {
    if (!type || req.query.download === "1") {
      res.redirect(302, await storage.signedUrl("uploads", name, { expiresIn: SIGNED_LINK_SECONDS, downloadName: row.photo_name || "photo" }));
      await logEvent("photo_downloaded", getClientInfo(req), { userId: req.user.id, details: { applicationId: id } });
      return;
    }
    const bytes = await storage.download("uploads", name); // a photo is at most MAX_PHOTO_MB (3 MB by default)
    // an image opened on its own gets no script rights, whatever it contains
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self' data:; sandbox");
    res.type(type);
    res.send(bytes);
  } catch {
    return missingFile(res);
  }
});

/** Remove an application and the resume / photo files stored for it. Cannot be undone. */
superOnly.delete("/applications/:id", async (req, res) => {
  const id = v.positiveInt(req.params.id);
  const row = id ? await db.get("SELECT id, resume_file, photo_file, role_title, site_id FROM applications WHERE id = ?", [id]) : null;
  if (!row) return res.status(404).json({ error: "Application not found." });
  const files = [row.resume_file, row.photo_file].filter(Boolean).map((f) => path.basename(f));
  // the row and a note to delete its files are saved together; if storage is down right now the maintenance job finishes the job
  await db.tx(async (t) => {
    await t.run("DELETE FROM applications WHERE id = ?", [id]);
    for (const f of files) {
      await t.run("INSERT INTO storage_trash (bucket, path, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", [config.storage.uploadsBucket, f, Date.now()]);
    }
  });
  await purgeUploadObjects(files);
  // the history keeps only that a deletion happened, not the candidate's personal details
  await logEvent("application_deleted", getClientInfo(req), {
    userId: req.user.id,
    siteId: row.site_id ?? null,
    details: { applicationId: id, role: row.role_title },
  });
  res.json({ ok: true });
});

/** Step 1 of "submit a resume for a candidate": signed upload URLs, the same mechanism the public form uses. */
superOnly.post("/applications/uploads", async (req, res) => {
  const out = await issueApplicationUploads({ owner: `admin:${req.user.id}`, resume: req.body?.resume, photo: req.body?.photo || undefined });
  if (out.fields) return res.status(400).json({ error: Object.values(out.fields)[0], fields: out.fields });
  res.json(out);
});

/** Super admin submits a resume on behalf of a candidate. No human verification needed (already logged in). */
superOnly.post("/applications", async (req, res) => {
  const body = req.body || {};
  const client = getClientInfo(req);
  const files = await claimApplicationUploads({ owner: `admin:${req.user.id}`, resumeKey: body.resumeKey, photoKey: body.photoKey });
  if (files.error) return res.status(files.status).json({ error: files.error, fields: files.fields });

  let created = false;
  try {
    // Which domain's notifications and history this belongs to: the one chosen, else the role's own domain, else the default.
    // Resolved before validation so the hiring-type / working-type choice is checked against that same domain's options.
    const rawSite = body.siteId;
    let site = null;
    let siteErr = null;
    if (rawSite !== undefined && rawSite !== null && rawSite !== "" && rawSite !== "default") {
      site = await getSiteById(v.positiveInt(rawSite));
      if (!site) siteErr = "Choose a domain from the list.";
    }
    const checked = await validateApplicant(body, site?.id);
    if (siteErr) checked.errors.siteId = siteErr;
    if (siteErr || !checked.ok) {
      await files.discard();
      return res.status(400).json({ error: "Please fix the highlighted fields.", fields: checked.errors });
    }
    if (!site && checked.values.role.site_id) site = await getSiteById(checked.values.role.site_id);

    const application = await createApplication({
      values: checked.values,
      file: files.resume,
      photo: files.photo,
      photoDisplayName: files.photo ? safeDisplayName(files.photo.declaredName) : "",
      displayName: safeDisplayName(files.resume.declaredName),
      client,
      source: "admin",
      submittedBy: req.user.id,
      site,
    });
    created = true;
    await logEvent("application_submitted_by_admin", client, {
      userId: req.user.id,
      siteId: site?.id ?? null,
      details: { applicationId: application.id, role: application.role_title },
    });
    background(notifyNewApplication(application, client));
    await enforceStorageLimit();
    res.status(201).json({ ok: true, id: application.id });
  } catch (err) {
    if (!created) await files.discard();
    throw err;
  }
});

superOnly.get("/activity", async (req, res) => {
  const { page, pageSize, offset } = v.pageParams(req.query, 200);
  const type = typeof req.query.type === "string" ? req.query.type.slice(0, 50) : "";
  const where = [];
  const params = [];
  if (type) {
    where.push("l.type = ?");
    params.push(type);
  }
  const bySite = siteFilter(req, "l.site_id");
  if (bySite) {
    where.push(bySite.clause);
    params.push(...bySite.params);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (await db.get(`SELECT COUNT(*) AS n FROM activity_log l ${clause}`, params)).n;
  const rows = await db.all(
    `SELECT l.*, u.email AS user_email, s.domain AS site_domain FROM activity_log l LEFT JOIN users u ON u.id = l.user_id
     LEFT JOIN sites s ON s.id = l.site_id
     ${clause} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const types = (await db.all("SELECT DISTINCT type FROM activity_log ORDER BY type")).map((r) => r.type);
  const tz = await getTimeZone();
  res.json({
    timeZone: tz,
    events: rows.map((r) => ({
      id: r.id,
      type: r.type,
      ip: r.ip,
      country: r.country,
      browser: r.browser,
      os: r.os,
      platform: r.platform,
      isMobile: !!r.is_mobile,
      user: r.user_email || null,
      domain: r.site_domain || "",
      details: r.details,
      createdAt: toIso(r.created_at),
      createdAtLocal: formatInZone(r.created_at, tz),
    })),
    types,
    total,
    page,
    pageSize,
  });
});

/** Delete activity history: everything, or only entries older than N days. One line recording the deletion stays. */
superOnly.post("/activity/clear", async (req, res) => {
  const { mode, days, confirm } = req.body || {};
  let deleted;
  let keptDays = null;
  if (mode === "all") {
    if (confirm !== true) return res.status(400).json({ error: "Confirmation required." });
    deleted = (await db.run("DELETE FROM activity_log")).changes;
  } else if (mode === "older") {
    keptDays = v.positiveInt(days);
    if (!keptDays || keptDays > 3650) return res.status(400).json({ error: "Enter a number of days from 1 to 3650." });
    deleted = (await db.run("DELETE FROM activity_log WHERE created_at < now() - make_interval(days => ?::int)", [keptDays])).changes;
  } else {
    return res.status(400).json({ error: "Choose what to delete." });
  }
  await logEvent("activity_cleared", getClientInfo(req), { userId: req.user.id, details: { mode, olderThanDays: keptDays, deleted } });
  res.json({ deleted });
});

// ------------------------------------------------------------------ settings (super admin only)

const isUniqueViolation = (err) => err?.code === "23505";

// Domains: add / rename / switch off / delete
superOnly.post("/sites", async (req, res) => {
  const c = await siteInput(req.body || {});
  if (!c.ok) return bad(res, c.errors);
  const x = c.values;
  let id;
  try {
    id = await db.insert("INSERT INTO sites (name, domain, active) VALUES (?, ?, ?)", [x.name, x.domain, x.active]);
  } catch (err) {
    if (isUniqueViolation(err)) return bad(res, { domain: "That domain is already added." });
    throw err;
  }
  invalidateSites();
  await logEvent("site_created", getClientInfo(req), { userId: req.user.id, siteId: id, details: { domain: x.domain } });
  res.status(201).json({ id });
});

superOnly.put("/sites/:id", async (req, res) => {
  const id = v.positiveInt(req.params.id);
  if (!id || !(await getSiteById(id))) return res.status(404).json({ error: "Domain not found." });
  const c = await siteInput(req.body || {}, id);
  if (!c.ok) return bad(res, c.errors);
  const x = c.values;
  try {
    await db.run("UPDATE sites SET name = ?, domain = ?, active = ?, updated_at = now() WHERE id = ?", [x.name, x.domain, x.active, id]);
  } catch (err) {
    if (isUniqueViolation(err)) return bad(res, { domain: "That domain is already added." });
    throw err;
  }
  invalidateSites();
  await logEvent("site_updated", getClientInfo(req), { userId: req.user.id, siteId: id, details: { domain: x.domain, active: !!x.active } });
  res.json({ ok: true });
});

superOnly.delete("/sites/:id", async (req, res) => {
  const id = v.positiveInt(req.params.id);
  const site = id ? await getSiteById(id) : null;
  if (!site) return res.status(404).json({ error: "Domain not found." });
  // Its companies and roles belong to it. They are not silently turned into "all domains" (that would show them on every other
  // site): delete or move them first.
  const owned = await db.get(
    "SELECT (SELECT COUNT(*) FROM companies WHERE site_id = ?) AS companies, (SELECT COUNT(*) FROM roles WHERE site_id = ?) AS roles",
    [id, id],
  );
  if (Number(owned.companies) + Number(owned.roles) > 0) {
    return res.status(409).json({
      error: `This domain still has ${owned.companies} compan${Number(owned.companies) === 1 ? "y" : "ies"} and ${owned.roles} role${Number(owned.roles) === 1 ? "" : "s"}. Delete them, or change them to another domain, first.`,
    });
  }
  const files = await ownedMediaFiles(id); // this domain's own logo / background
  // its settings are removed (cascade); applications and history keep the domain name
  await db.run("DELETE FROM sites WHERE id = ?", [id]);
  invalidateSites();
  await Promise.all(files.map(removeMedia));
  await logEvent("site_deleted", getClientInfo(req), { userId: req.user.id, details: { domain: site.domain } });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ settings (super admin only)
// Every settings endpoint takes ?siteId=: empty = the default settings, a number = that domain's own overrides.

superOnly.get("/settings", async (req, res) => {
  const scope = await settingsScope(req, res);
  if (scope) res.json(await getAdminSettings(scope.siteId));
});

superOnly.put("/settings", async (req, res) => {
  const scope = await settingsScope(req, res);
  if (!scope) return;
  const result = await updateSettings(req.body || {}, scope.siteId);
  if (result.errors) return bad(res, result.errors);
  // Log which settings changed, never their values (two of them are secrets)
  await logEvent("settings_updated", getClientInfo(req), { userId: req.user.id, siteId: scope.siteId, details: { changed: result.changed } });
  res.json(await getAdminSettings(scope.siteId));
});

/** Make a domain use the default settings again for some parts of the page. */
superOnly.post("/settings/reset", async (req, res) => {
  const scope = await settingsScope(req, res);
  if (!scope) return;
  if (!scope.siteId) return res.status(400).json({ error: "Only a domain can be reset to the default settings." });
  const names = Array.isArray(req.body?.keys) ? req.body.keys.filter((k) => typeof k === "string").slice(0, 40) : [];
  if (!names.length) return res.status(400).json({ error: "Choose what to reset." });
  const orphaned = await resetSiteSettings(scope.siteId, names);
  await Promise.all(orphaned.map(removeMedia));
  await logEvent("settings_reset", getClientInfo(req), { userId: req.user.id, siteId: scope.siteId, details: { reset: names } });
  res.json(await getAdminSettings(scope.siteId));
});

superOnly.post("/settings/test-notification", async (req, res) => {
  const scope = await settingsScope(req, res);
  if (!scope) return;
  const result = await sendTestNotification(req.body?.channel, scope.siteId);
  await logEvent("notification_test", getClientInfo(req), {
    userId: req.user.id,
    siteId: scope.siteId,
    details: { channel: req.body?.channel, ok: result.ok },
  });
  if (!result.ok) return res.status(502).json({ error: result.error });
  res.json({ ok: true });
});

const mediaKind = (req, res) => {
  const kind = req.params.kind;
  if (kind === "logo" || kind === "background") return kind;
  res.status(404).json({ error: "Not found." });
  return null;
};

/** Step 1 of a logo / background upload: a signed URL, so the (up to 40 MB) file goes straight to storage. */
superOnly.post("/settings/media/:kind/upload-url", async (req, res) => {
  const kind = mediaKind(req, res);
  if (!kind) return;
  const out = await issueMediaUpload(kind, req.body?.file, `admin:${req.user.id}`);
  if (out.error) return res.status(400).json({ error: out.error });
  res.json(out);
});

/** Step 2: the file is uploaded; check it and make it the logo / background. */
superOnly.post("/settings/media/:kind", async (req, res) => {
  const kind = mediaKind(req, res);
  if (!kind) return;
  const scope = await settingsScope(req, res);
  if (!scope) return;
  const saved = await claimMediaUpload(kind, req.body?.key, `admin:${req.user.id}`);
  if (saved.error) return res.status(400).json({ error: saved.error });

  // Only delete the previous file if this scope owned it (a domain that inherited the default logo must not delete the default's file)
  if (kind === "logo") {
    const old = await getOwnSetting("logo_file", scope.siteId);
    await putSetting("logo_file", saved.filename, scope.siteId);
    await removeMedia(old);
  } else {
    const old = await getOwnSetting("bg_file", scope.siteId);
    await putSetting("bg_file", saved.filename, scope.siteId);
    await putSetting("bg_type", saved.type, scope.siteId);
    await removeMedia(old);
  }
  await finishMediaUpload(saved.filename);
  await logEvent("media_uploaded", getClientInfo(req), { userId: req.user.id, siteId: scope.siteId, details: { kind, type: saved.type } });
  res.json(await getAdminSettings(scope.siteId));
});

/**
 * Remove the logo / background. For the default settings that clears it. For a domain it saves "none" for that domain
 * (so it does not fall back to the default one); use "reset" to inherit the default again.
 */
superOnly.delete("/settings/media/:kind", async (req, res) => {
  const scope = await settingsScope(req, res);
  if (!scope) return;
  const kind = req.params.kind;
  if (kind === "logo") {
    await removeMedia(await getOwnSetting("logo_file", scope.siteId));
    await putSetting("logo_file", "", scope.siteId);
  } else if (kind === "background") {
    await removeMedia(await getOwnSetting("bg_file", scope.siteId));
    await putSetting("bg_file", "", scope.siteId);
    await putSetting("bg_type", "", scope.siteId);
  } else {
    return res.status(404).json({ error: "Not found." });
  }
  await logEvent("media_removed", getClientInfo(req), { userId: req.user.id, siteId: scope.siteId, details: { kind } });
  res.json(await getAdminSettings(scope.siteId));
});

const userRow = (u) => ({ id: u.id, email: u.email, role: u.role, createdAt: toIso(u.created_at) });

superOnly.get("/users", async (_req, res) => {
  const rows = await db.all("SELECT id, email, role, created_at FROM users ORDER BY id");
  res.json({ users: rows.map(userRow) });
});

superOnly.post("/users", async (req, res) => {
  const c = v.collect({ email: v.email(req.body?.email) });
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (password.length < 10 || password.length > 200) c.errors.password = "Password must be 10 to 200 characters.";
  const role = req.body?.role === "super_admin" ? "super_admin" : "admin";
  if (Object.keys(c.errors).length) return bad(res, c.errors);
  if (await db.get("SELECT 1 AS x FROM users WHERE lower(email) = lower(?)", [c.values.email])) {
    return bad(res, { email: "A user with that email already exists." });
  }
  const id = await db.insert("INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)", [c.values.email, await bcrypt.hash(password, 12), role]);
  await logEvent("user_created", getClientInfo(req), {
    userId: req.user.id,
    details: { id, role },
  });
  res.status(201).json({ id });
});

superOnly.put("/users/:id/password", async (req, res) => {
  const id = v.positiveInt(req.params.id);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (password.length < 10 || password.length > 200) {
    return bad(res, { password: "Password must be 10 to 200 characters." });
  }
  const info = id ? await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [await bcrypt.hash(password, 12), id]) : { changes: 0 };
  if (!info.changes) return res.status(404).json({ error: "User not found." });
  await logEvent("user_password_reset", getClientInfo(req), { userId: req.user.id, details: { id } });
  res.json({ ok: true });
});

superOnly.delete("/users/:id", async (req, res) => {
  const id = v.positiveInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account." });
  const target = id ? await db.get("SELECT role FROM users WHERE id = ?", [id]) : null;
  if (!target) return res.status(404).json({ error: "User not found." });
  await db.run("DELETE FROM users WHERE id = ?", [id]);
  await logEvent("user_deleted", getClientInfo(req), { userId: req.user.id, details: { id } });
  res.json({ ok: true });
});

router.use(superOnly);

export default router;
