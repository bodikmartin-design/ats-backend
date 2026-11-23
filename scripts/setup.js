// npm run setup -- creates the database tables, the storage buckets and the first super admin in your Supabase project.
// The same work happens automatically on the first request of a deployment; running it once yourself just means you see the
// result (and a generated admin password) in your terminal instead of in the Vercel logs.
import { ensureReady } from "../src/schema.js";
import { db } from "../src/db.js";

try {
  await ensureReady();
  const n = (await db.get("SELECT COUNT(*) AS n FROM users")).n;
  console.log(`\nDone. The database and storage buckets are ready (${n} admin user${n === 1 ? "" : "s"}).`);
} catch (err) {
  console.error("\nSetup failed:", err.message);
  process.exitCode = 1;
} finally {
  await db.close();
}
