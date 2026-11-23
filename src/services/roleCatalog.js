import { db } from "../db.js";
import { BLOCKCHAIN_COMPANY, BLOCKCHAIN_ROLES } from "../lib/blockchainRoles.js";

/**
 * Adds the general blockchain / Web3 roles to a company, skipping any that are already there (same title),
 * so running it twice never creates duplicates.
 * With a companyId the roles go to that company and to that company's domain. With none, the "Blockchain Project" company of
 * `siteId` is used (and created if needed): with a domain that is a company of its own on that domain, with no domain it is the
 * shared one. Returns { companyId, added, skipped }.
 * `exec`: an open transaction to run inside (first-run setup passes its own); otherwise one is started.
 */
export async function importBlockchainRoles({ companyId = null, siteId = null } = {}, exec = null) {
  const work = async (t) => {
    let id = companyId;
    let roleSite = siteId;
    if (id) {
      roleSite = (await t.get("SELECT site_id FROM companies WHERE id = ?", [id]))?.site_id ?? siteId;
    } else {
      id = (await t.get("SELECT id FROM companies WHERE lower(name) = lower(?) AND site_id IS NOT DISTINCT FROM ?", [BLOCKCHAIN_COMPANY.name, siteId]))?.id;
      if (!id) {
        id = await t.insert(
          "INSERT INTO companies (name, description, website, location, contact_email, site_id) VALUES (?, ?, '', ?, '', ?)",
          [BLOCKCHAIN_COMPANY.name, BLOCKCHAIN_COMPANY.description, BLOCKCHAIN_COMPANY.location, siteId],
        );
      }
    }
    let added = 0;
    let skipped = 0;
    for (const [title, department, type, description] of BLOCKCHAIN_ROLES) {
      if (await t.get("SELECT 1 FROM roles WHERE company_id = ? AND lower(title) = lower(?)", [id, title])) skipped++;
      else {
        await t.run(
          `INSERT INTO roles (company_id, title, department, location, employment_type, description, site_id)
           VALUES (?, ?, ?, '', ?, ?, ?)`,
          [id, title, department, type, description, roleSite],
        );
        added++;
      }
    }
    return { companyId: Number(id), added, skipped, total: BLOCKCHAIN_ROLES.length };
  };
  return exec ? work(exec) : db.tx(work);
}
