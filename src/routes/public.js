import { Router } from "express";
import { db } from "../db.js";
import * as verification from "../services/verification.js";
import { getClientInfo } from "../services/clientInfo.js";
import { logEvent } from "../services/activity.js";
import { createApplication, publicCompany, validateApplicant } from "../services/applications.js";
import { getSiteInfo, getVerifyTexts, getSetting } from "../services/settings.js";
import { notifyNewApplication } from "../services/notify.js";
import { claimApplicationUploads, issueApplicationUploads, safeDisplayName } from "../services/uploads.js";
import { enforceStorageLimit } from "../services/quota.js";
import { hiringTypes, workingTypes } from "../services/typeCatalog.js";
import { applyLimiter, asyncRoutes, rolesLimiter, uploadUrlLimiter, verifyLimiter, verifyStartLimiter } from "../middleware/security.js";
import { likeTerm } from "../lib/validate.js";
import { background } from "../lib/background.js";
import { requireOpenSite, siteContext, siteIdOf, siteIsOpen } from "../middleware/site.js";

const router = asyncRoutes(Router());

// Every public request is tied to a domain (see middleware/site.js): branding, verification steps, roles and notifications follow it.
router.use(siteContext);

router.get("/health", (_req, res) => res.json({ ok: true }));

/** Branding and theme for the candidate site: logo, background, colors. Nothing secret in here. */
router.get("/site", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const siteId = siteIdOf(req);
  res.json({
    ...(await getSiteInfo(siteId)),
    verifyTexts: await getVerifyTexts(siteId),
    allowMobileApplications: (await getSetting("allow_mobile_applications", siteId)) !== "false",
    closed: !siteIsOpen(req),
  });
});

// ---------------------------------------------------------------- verification (3 stages, checked here)

router.post("/verify/start", verifyStartLimiter, requireOpenSite, async (req, res) => {
  res.json(await verification.start(getClientInfo(req, req.body?.client), siteIdOf(req)));
});

router.post("/verify/answer", verifyLimiter, requireOpenSite, async (req, res) => {
  const { sessionId, answer } = req.body || {};
  const result = await verification.answer(sessionId, answer, getClientInfo(req));
  if (result.expired) return res.status(410).json(result);
  res.json(result);
});

router.post("/verify/refresh", verifyLimiter, requireOpenSite, async (req, res) => {
  const result = await verification.refresh(req.body?.sessionId, getClientInfo(req));
  if (result.expired) return res.status(410).json(result);
  res.json(result);
});

/** Everything below this line needs a fully verified token in the X-Verification-Token header. */
async function requireVerified(req, res, next) {
  // the token only works on the domain where it was earned
  if (!(await verification.isVerified(req.get("x-verification-token"), siteIdOf(req)))) {
    return res.status(401).json({ error: "Human verification required or expired.", verification: true });
  }
  next();
}

/** Legacy confirmation-check endpoint for older clients. The current frontend uses a plain submit confirmation;
 * configured verification steps are enforced by /verify/start and the apply token remains the sole requirement. */
router.post("/verify/confirm/start", verifyStartLimiter, requireOpenSite, requireVerified, async (req, res) => {
  res.json(await verification.startConfirm(getClientInfo(req, req.body?.client), siteIdOf(req)));
});

/** The hiring-type / working-type choices for the apply form (admin-managed, see typeCatalog.js). */
router.get("/application-options", requireOpenSite, requireVerified, async (req, res) => {
  const siteId = siteIdOf(req);
  res.json({ hiringTypes: await hiringTypes.listForSite(siteId), workingTypes: await workingTypes.listForSite(siteId) });
});

// ---------------------------------------------------------------- role search

router.get("/roles", rolesLimiter, requireOpenSite, requireVerified, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const tokens = q.split(/\s+/).filter(Boolean).slice(0, 5);

  // Roles and companies belong to a domain: this site sees its own, plus the ones that have no domain (shared by all sites).
  const where = ["r.active = 1", "c.active = 1", "(r.site_id IS NULL OR r.site_id = ?)", "(c.site_id IS NULL OR c.site_id = ?)"];
  const params = [siteIdOf(req), siteIdOf(req)];
  for (const t of tokens) {
    where.push(
      `(r.title ILIKE ? ESCAPE '\\' OR r.department ILIKE ? ESCAPE '\\' OR r.location ILIKE ? ESCAPE '\\' OR c.name ILIKE ? ESCAPE '\\')`,
    );
    const p = likeTerm(t);
    params.push(p, p, p, p);
  }
  const startsWith = likeTerm(tokens[0] || "").slice(1); // "term%" ranks title matches first

  const rows = await db.all(
    `SELECT r.id, r.title, r.department, r.location, r.employment_type AS "employmentType", r.description,
            c.id AS "companyId", c.name AS "companyName", c.description AS "companyDescription", c.website AS "companyWebsite"
     FROM roles r JOIN companies c ON c.id = r.company_id
     WHERE ${where.join(" AND ")}
     ORDER BY CASE WHEN r.title ILIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, lower(r.title)
     LIMIT 20`,
    [...params, startsWith],
  );
  res.json({ roles: rows });
});

// ---------------------------------------------------------------- resume upload
//
// Two steps, because a Vercel function can't receive a request body over 4.5 MB (a resume plus a photo can be 8 MB):
//   POST /uploads  -> signed storage URLs; the browser PUTs the resume (and photo) straight to Supabase Storage
//   POST /apply    -> the form fields plus the names of the uploaded files; the server checks what actually arrived

router.post("/uploads", uploadUrlLimiter, requireOpenSite, requireVerified, async (req, res) => {
  const client = getClientInfo(req, req.body?.client);
  if (client.isMobile && (await getSetting("allow_mobile_applications", siteIdOf(req))) === "false") {
    return res.status(403).json({ error: "Applications from mobile devices are currently disabled by the administrator." });
  }
  const out = await issueApplicationUploads({
    owner: req.get("x-verification-token"),
    resume: req.body?.resume,
    photo: req.body?.photo || undefined,
  });
  if (out.fields) {
    return res.status(400).json({ error: Object.values(out.fields)[0], fields: out.fields });
  }
  res.json(out);
});

router.post("/apply", applyLimiter, requireOpenSite, requireVerified, async (req, res) => {
  const body = req.body || {};
  const client = getClientInfo(req, body.client);
  if (client.isMobile && (await getSetting("allow_mobile_applications", siteIdOf(req))) === "false") {
    return res.status(403).json({ error: "Applications from mobile devices are currently disabled by the administrator." });
  }
  const token = req.get("x-verification-token");

  // From here on the uploaded files belong to this request; fail() deletes them.
  const files = await claimApplicationUploads({ owner: token, resumeKey: body.resumeKey, photoKey: body.photoKey });
  if (files.error) return res.status(files.status).json({ error: files.error, fields: files.fields });
  const fail = async (status, error, fields) => {
    await files.discard();
    return res.status(status).json({ error, fields });
  };

  let created = false;
  try {
    const checked = await validateApplicant(body, siteIdOf(req));
    if (!checked.ok) return await fail(400, "Please fix the highlighted fields.", checked.errors);

    // Use up the verification token. If two requests race, only one wins.
    if (!(await verification.consume(token, siteIdOf(req)))) return await fail(401, "Human verification required or expired.");

    const application = await createApplication({
      values: checked.values,
      file: files.resume,
      photo: files.photo,
      photoDisplayName: files.photo ? safeDisplayName(files.photo.declaredName) : "",
      displayName: safeDisplayName(files.resume.declaredName),
      client,
      source: "web",
      site: req.site,
    });
    created = true; // the application now owns the files; they must not be deleted any more
    await logEvent("application_submitted", client, {
      siteId: siteIdOf(req),
      details: { applicationId: application.id, role: application.role_title },
    });
    background(notifyNewApplication(application, client));
    await enforceStorageLimit(); // over the storage limit? the oldest applications make room

    res.status(201).json({ ok: true, id: application.id, company: publicCompany(checked.values.role) });
  } catch (err) {
    if (!created) await files.discard();
    throw err;
  }
});

export default router;
