import { db } from "../db.js";

/** Append an entry to the activity history shown to the super admin. Never throws. */
export async function logEvent(type, client = {}, { userId = null, details = {}, siteId = null } = {}) {
  try {
    await db.run(
      `INSERT INTO activity_log (type, ip, country, browser, os, platform, is_mobile, user_id, details, site_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        type,
        client.ip || "",
        client.countryName || client.country || "",
        client.browser || "",
        client.os || "",
        client.platform || "",
        client.isMobile ? 1 : 0,
        userId,
        JSON.stringify(details),
        siteId,
      ],
    );
  } catch (err) {
    console.error("[activity] failed to log event:", err.message);
  }
}
