import { db } from "../db.js";
import { config } from "../config.js";
import { logEvent } from "./activity.js";
import { purgeUploadObjects } from "./pending.js";

/**
 * Storage quota. Resumes and photos together may use at most MAX_STORAGE_MB (default 300 MB) of Supabase Storage.
 * When a new application pushes the total over that, the OLDEST applications are deleted -- the database row and its resume
 * and photo files -- until the total is back under the limit. The activity history records each automatic deletion (without
 * the candidate's details). MAX_STORAGE_MB=0 turns this off.
 *
 * The total is the sum of the resume and photo sizes recorded for every application; files that were uploaded but never
 * attached to an application are removed separately (see pending.js) and are not part of it.
 */

const LOCK_KEY = 727_275;
const BATCH = 200;
const SYSTEM = { ip: "", country: "", browser: "", os: "", platform: "", isMobile: false };

export async function storageUsage() {
  const row = await db.get("SELECT COALESCE(SUM(resume_size + photo_size), 0)::bigint AS bytes, COUNT(*) AS count FROM applications");
  return { bytes: Number(row.bytes), count: Number(row.count), limitBytes: config.storage.maxTotalBytes };
}

/**
 * Deletes the oldest applications until the stored resumes + photos fit in the limit.
 * Resolves to { deleted, freedBytes, usedBytes, limitBytes }; never throws (a failure is logged, the caller carries on).
 */
export async function enforceStorageLimit() {
  const limit = config.storage.maxTotalBytes;
  const idle = { deleted: 0, freedBytes: 0, usedBytes: 0, limitBytes: limit };
  if (!limit) return idle;
  try {
    const outcome = await db.tx(async (t) => {
      // Only one instance trims at a time; a second request that arrives meanwhile just moves on.
      if (!(await t.get("SELECT pg_try_advisory_xact_lock(?) AS ok", [LOCK_KEY])).ok) return null;
      let used = Number((await t.get("SELECT COALESCE(SUM(resume_size + photo_size), 0)::bigint AS bytes FROM applications")).bytes);
      const usedBefore = used;
      const victims = [];
      while (used > limit) {
        const batch = await t.all(
          `SELECT id, resume_file, photo_file, resume_size, photo_size, role_title, site_id
           FROM applications ORDER BY created_at ASC, id ASC LIMIT ${BATCH}`,
        );
        if (!batch.length) break;
        const take = [];
        for (const a of batch) {
          if (used <= limit) break;
          take.push(a);
          used -= a.resume_size + a.photo_size;
        }
        await t.run("DELETE FROM applications WHERE id = ANY(?)", [take.map((a) => a.id)]);
        for (const a of take) {
          for (const f of [a.resume_file, a.photo_file]) {
            if (f) {
              await t.run("INSERT INTO storage_trash (bucket, path, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", [config.storage.uploadsBucket, f, Date.now()]);
            }
          }
        }
        victims.push(...take);
      }
      return { victims, usedBefore, usedAfter: used };
    });
    if (!outcome || !outcome.victims.length) return { ...idle, usedBytes: outcome ? outcome.usedAfter : (await storageUsage()).bytes };

    // The rows are gone; now the files. Any file storage refuses to delete stays in storage_trash and is retried later.
    await purgeUploadObjects(outcome.victims.flatMap((a) => [a.resume_file, a.photo_file]).filter(Boolean));
    const freedBytes = outcome.usedBefore - outcome.usedAfter;
    for (const a of outcome.victims) {
      await logEvent("application_deleted", SYSTEM, {
        siteId: a.site_id ?? null,
        details: { applicationId: a.id, role: a.role_title, reason: "storage_limit" },
      });
    }
    await logEvent("storage_cleanup", SYSTEM, {
      details: { deleted: outcome.victims.length, freedBytes, usedBytes: outcome.usedAfter, limitBytes: limit },
    });
    console.log(`[storage] Over the ${Math.round(limit / 1048576)} MB limit: deleted ${outcome.victims.length} oldest application(s), freed ${Math.round(freedBytes / 1024)} KB.`);
    return { deleted: outcome.victims.length, freedBytes, usedBytes: outcome.usedAfter, limitBytes: limit };
  } catch (err) {
    console.error("[storage] automatic cleanup failed:", err.message);
    return idle;
  }
}
