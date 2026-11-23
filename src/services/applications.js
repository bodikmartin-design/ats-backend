import { db } from "../db.js";
import { config } from "../config.js";
import * as v from "../lib/validate.js";
import { hiringTypes, workingTypes } from "./typeCatalog.js";

const FIND_ROLE = `
  SELECT r.id, r.title, r.site_id, c.site_id AS company_site_id, c.id AS company_id, c.name AS company_name, c.description AS company_description,
         c.website AS company_website, c.location AS company_location, c.contact_email AS company_contact_email
  FROM roles r JOIN companies c ON c.id = r.company_id
  WHERE r.id = ? AND r.active = 1 AND c.active = 1
`;

const GET_WITH_SUBMITTER = `
  SELECT a.*, u.email AS submitted_by_email
  FROM applications a LEFT JOIN users u ON u.id = a.submitted_by
  WHERE a.id = ?
`;

/**
 * `siteId` is the domain the candidate applies on: roles (and companies) tied to another domain can't be chosen
 * (those with no domain are shared by all). Pass `undefined` to skip that check (a super admin submitting for a candidate).
 */
export async function validateApplicant(body, siteId) {
  const checks = v.collect({
    name: v.text(body.name, "Name", { min: 2, max: 100, required: true }),
    email: v.email(body.email),
    phone: v.phone(body.phone),
  });
  const roleId = v.positiveInt(body.roleId);
  if (!roleId) checks.errors.roleId = "Please select a role.";
  else {
    const role = await db.get(FIND_ROLE, [roleId]);
    const elsewhere = (own) => siteId !== undefined && own && own !== siteId;
    if (!role || elsewhere(role.site_id) || elsewhere(role.company_site_id)) checks.errors.roleId = "That role is no longer available.";
    else checks.values.role = role;
  }
  const hiringType = typeof body.hiringType === "string" ? body.hiringType.trim() : "";
  if (!hiringType || !(await hiringTypes.isValid(hiringType, siteId ?? null))) checks.errors.hiringType = "Please select a hiring type.";
  else checks.values.hiringType = hiringType;
  const workingType = typeof body.workingType === "string" ? body.workingType.trim() : "";
  if (!workingType || !(await workingTypes.isValid(workingType, siteId ?? null))) checks.errors.workingType = "Please select a working type.";
  else checks.values.workingType = workingType;
  checks.ok = Object.keys(checks.errors).length === 0;
  return checks;
}

/**
 * `file` / `photo` are the claimed uploads from uploads.js ({ filename, size }); `photo` is optional.
 * The application row is created and the uploads are marked as no longer pending in one transaction.
 */
export async function createApplication({ values, file, photo = null, photoDisplayName = "", displayName, client, source, submittedBy = null, site = null }) {
  return db.tx(async (t) => {
    const id = await t.insert(
      `INSERT INTO applications
        (name, email, phone, role_id, role_title, company_name, resume_file, resume_name, resume_size,
         hiring_type, working_type, photo_file, photo_name, photo_size,
         site_id, site_domain, source, submitted_by, ip, country, country_name, browser, os, platform, is_mobile, client_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.name,
        values.email,
        values.phone,
        values.role.id,
        values.role.title,
        values.role.company_name,
        file.filename,
        displayName,
        file.size,
        values.hiringType,
        values.workingType,
        photo?.filename || "",
        photo ? photoDisplayName : "",
        photo?.size || 0,
        site?.id ?? null,
        site?.domain ?? "",
        source,
        submittedBy,
        client.ip,
        client.country,
        client.countryName,
        client.browser,
        client.os,
        client.platform,
        client.isMobile ? 1 : 0,
        JSON.stringify({ userAgent: client.userAgent, reported: client.reported }),
      ],
    );
    await t.run("DELETE FROM pending_uploads WHERE bucket = ? AND path = ANY(?)", [
      config.storage.uploadsBucket,
      [file.filename, photo?.filename].filter(Boolean),
    ]);
    return t.get(GET_WITH_SUBMITTER, [id]);
  });
}

/** The part of a company's information that candidates are allowed to read. */
export function publicCompany(role) {
  return {
    name: role.company_name,
    description: role.company_description,
    website: role.company_website,
    location: role.company_location,
    contactEmail: role.company_contact_email,
  };
}
