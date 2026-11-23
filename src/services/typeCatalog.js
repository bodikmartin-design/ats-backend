import { db } from "../db.js";

/**
 * Hiring types (Full-time, Part-time, ...) and working types (On-site, Hybrid, Remote, ...) the candidate chooses
 * on the apply form. Both are admin-managed catalogs with the identical shape, scoped like roles: a row with no
 * domain shows on every site, a row tied to one domain shows only there. See schema.js for the table definitions and
 * the defaults seeded on a brand-new database.
 */
function makeCatalog(table) {
  return {
    /** Active labels a candidate on this domain may choose from (that domain's own, plus every-domain ones). */
    async listForSite(siteId = null) {
      const rows = siteId
        ? await db.all(
            `SELECT label FROM ${table} WHERE active = 1 AND (site_id IS NULL OR site_id = ?) ORDER BY sort_order, lower(label)`,
            [siteId],
          )
        : await db.all(`SELECT label FROM ${table} WHERE active = 1 AND site_id IS NULL ORDER BY sort_order, lower(label)`);
      return rows.map((r) => r.label);
    },
    /** Every row (active or not, every domain), for the admin management page. */
    listAdmin() {
      return db.all(
        `SELECT t.*, s.domain AS site_domain FROM ${table} t LEFT JOIN sites s ON s.id = t.site_id
         ORDER BY t.sort_order, lower(t.label)`,
      );
    },
    get(id) {
      return db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    },
    create({ label, siteId, active, sortOrder }) {
      return db.insert(`INSERT INTO ${table} (label, site_id, active, sort_order) VALUES (?, ?, ?, ?)`, [label, siteId, active ? 1 : 0, sortOrder]);
    },
    async save(id, { label, siteId, active, sortOrder }) {
      return (await db.run(`UPDATE ${table} SET label = ?, site_id = ?, active = ?, sort_order = ? WHERE id = ?`, [label, siteId, active ? 1 : 0, sortOrder, id])).changes;
    },
    async remove(id) {
      return (await db.run(`DELETE FROM ${table} WHERE id = ?`, [id])).changes;
    },
    /** Is this exact label currently offered to this domain (its own, or an every-domain one)? */
    async isValid(label, siteId = null) {
      return !!(await db.get(
        `SELECT 1 FROM ${table} WHERE active = 1 AND lower(label) = lower(?) AND (site_id IS NULL OR site_id = ?)`,
        [label, siteId],
      ));
    },
  };
}

export const hiringTypes = makeCatalog("hiring_types");
export const workingTypes = makeCatalog("working_types");
