import { db } from "../db.js";
import { config } from "../config.js";
import * as storage from "../storage.js";

/**
 * Files a browser uploaded straight to storage but that nothing owns yet.
 *
 * issue  -> the server creates a signed upload URL for a random object name and records it here, tied to an owner
 *           (a verification token for candidates, "admin:<id>" for a logged-in admin);
 * claim  -> when the form is submitted the owner names those objects; claiming flips the row to a private owner, atomically,
 *           so two requests can never both take the same file, and only the request that holds the claim may delete it;
 * done   -> the row is removed in the same transaction that creates the application / saves the setting.
 *
 * Anything left over (an abandoned form, a crash between steps) is removed by sweepPending() once it is old enough, unless an
 * application or setting by then points at it.
 */

export async function registerPending({ bucket, path, kind, owner, declaredName = "" }) {
  await db.run(
    "INSERT INTO pending_uploads (path, bucket, kind, owner, declared_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [path, bucket, kind, owner, declaredName, Date.now()],
  );
}

/** Atomically take ownership of a pending upload. Resolves to the row, or undefined when it isn't (or is no longer) this owner's. */
export async function claimPending({ bucket, path, kind, owner }) {
  const claimOwner = `claim:${owner}`;
  return db.get(
    `UPDATE pending_uploads SET owner = ? WHERE bucket = ? AND path = ? AND kind = ? AND owner = ? RETURNING *`,
    [claimOwner, bucket, path, kind, owner],
  );
}

/** Delete the stored objects. Any that storage refuses to delete are written to storage_trash so the maintenance job retries them. */
export async function discardObjects(items, exec = db) {
  const byBucket = new Map();
  for (const { bucket, path } of items) {
    if (!path) continue;
    if (!byBucket.has(bucket)) byBucket.set(bucket, []);
    byBucket.get(bucket).push(path);
  }
  for (const [bucket, paths] of byBucket) {
    const kind = bucket === config.storage.mediaBucket ? "media" : "uploads";
    const ok = await storage.remove(kind, paths);
    if (!ok) await trash(bucket, paths, exec);
    await exec.run("DELETE FROM pending_uploads WHERE bucket = ? AND path = ANY(?)", [bucket, paths]).catch(() => {});
  }
}

export async function trash(bucket, paths, exec = db) {
  for (const path of paths) {
    await exec.run("INSERT INTO storage_trash (bucket, path, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", [bucket, path, Date.now()]);
  }
}

/** Retry deletions that storage refused earlier. */
export async function purgeTrash() {
  const rows = await db.all("SELECT bucket, path FROM storage_trash LIMIT 500");
  let purged = 0;
  for (const bucket of new Set(rows.map((r) => r.bucket))) {
    const paths = rows.filter((r) => r.bucket === bucket).map((r) => r.path);
    const kind = bucket === config.storage.mediaBucket ? "media" : "uploads";
    if (await storage.remove(kind, paths)) {
      await db.run("DELETE FROM storage_trash WHERE bucket = ? AND path = ANY(?)", [bucket, paths]);
      purged += paths.length;
    }
  }
  return purged;
}

/** Remove abandoned uploads (older than PENDING_UPLOAD_MINUTES) that nothing references. Returns how many were removed. */
export async function sweepPending() {
  const cutoff = Date.now() - config.storage.pendingUploadMinutes * 60 * 1000;
  const old = await db.all("SELECT bucket, path FROM pending_uploads WHERE created_at < ? LIMIT 500", [cutoff]);
  let removed = 0;
  for (const { bucket, path } of old) {
    const referenced = await db.get(
      `SELECT 1 AS x FROM applications WHERE resume_file = ? OR photo_file = ?
       UNION ALL SELECT 1 FROM settings WHERE value = ?
       UNION ALL SELECT 1 FROM site_settings WHERE value = ? LIMIT 1`,
      [path, path, path, path],
    );
    if (referenced) await db.run("DELETE FROM pending_uploads WHERE bucket = ? AND path = ?", [bucket, path]);
    else {
      await discardObjects([{ bucket, path }]);
      removed++;
    }
  }
  return removed;
}

/** When someone asks for fresh upload URLs, whatever they asked for earlier and never used is thrown away. */
export async function dropOwnerPending(owner) {
  const rows = await db.all("SELECT bucket, path FROM pending_uploads WHERE owner = ?", [owner]);
  if (rows.length) await discardObjects(rows);
}

/**
 * Delete stored resume / photo files whose database rows are already gone. They must have been written to storage_trash in the
 * same transaction that removed the rows; whatever storage deletes is taken off that list again, the rest is retried later.
 */
export async function purgeUploadObjects(paths) {
  const bucket = config.storage.uploadsBucket;
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    if (await storage.remove("uploads", chunk)) await db.run("DELETE FROM storage_trash WHERE bucket = ? AND path = ANY(?)", [bucket, chunk]);
  }
}
