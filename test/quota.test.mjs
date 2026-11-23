import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Own process (see package.json), so it can run with a tiny storage limit: 1 MB instead of 300 MB.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-quota-test-"));
const UPLOADS = path.join(tmp, "storage", "resume-uploads");
const KB = 1024;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let server;
let base;
let db;
let cookie;
let roleId;

before(async () => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DB_DRIVER: "pglite",
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: path.join(tmp, "storage"),
    SETTINGS_CACHE_MS: "0",
    MAX_STORAGE_MB: "1",
    MAX_RESUME_MB: "1",
    CRON_SECRET: "cron-secret-for-tests",
    SITE_PROXY_KEY: "proxy-key-for-tests",
    JWT_SECRET: "test-secret",
    SUPERADMIN_EMAIL: "boss@example.com",
    SUPERADMIN_PASSWORD: "correct horse battery",
  });
  const { app } = await import("../src/server.js");
  ({ db } = await import("../src/db.js"));
  const { ensureReady } = await import("../src/schema.js");
  await ensureReady();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", "user-agent": UA },
    body: JSON.stringify({ email: "boss@example.com", password: "correct horse battery" }),
  });
  cookie = login.headers.getSetCookie()[0].split(";")[0];
  roleId = (await admin("GET", "/api/admin/roles")).data.roles[0].id;
});

after(async () => {
  server?.close();
  await db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function admin(method, url, json, extra = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { "user-agent": UA, "x-requested-with": "XMLHttpRequest", cookie, ...(json ? { "content-type": "application/json" } : {}), ...extra },
    body: json ? JSON.stringify(json) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data };
}

const pdfBytes = (size) => Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(size - 9, 0x20)]);
const jpgBytes = (size) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, 1)]);

/** What the browser does: ask for upload links, PUT the files to them, then create the application. */
async function submit({ resumeSize, photoSize, name = "Ada" }) {
  const slots = await admin("POST", "/api/admin/applications/uploads", {
    resume: { name: "cv.pdf", size: resumeSize },
    photo: photoSize ? { name: "me.jpg", size: photoSize } : undefined,
  });
  assert.equal(slots.status, 200, JSON.stringify(slots.data));
  const put = async (slot, bytes, type) => {
    const u = slot.upload.url;
    const res = await fetch(u.startsWith("http") ? u : base + u, { method: slot.upload.method, headers: slot.upload.headers, body: bytes });
    assert.equal(res.status, 200, `upload failed: ${res.status}`);
  };
  await put(slots.data.resume, pdfBytes(resumeSize));
  if (photoSize) await put(slots.data.photo, jpgBytes(photoSize));
  return admin("POST", "/api/admin/applications", {
    name,
    email: "ada@example.com",
    roleId,
    hiringType: "Full-time",
    workingType: "Remote",
    resumeKey: slots.data.resume.key,
    photoKey: photoSize ? slots.data.photo.key : undefined,
  });
}

const used = async () => Number((await db.get("SELECT COALESCE(SUM(resume_size + photo_size), 0) AS n FROM applications")).n);
const names = () => fs.readdirSync(UPLOADS);

test("files go to storage directly, and the stored size is what actually arrived", async () => {
  const a = await submit({ resumeSize: 300 * KB, photoSize: 100 * KB, name: "First" });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const row = await db.get("SELECT * FROM applications WHERE id = ?", [a.data.id]);
  assert.equal(row.resume_size, 300 * KB);
  assert.equal(row.photo_size, 100 * KB);
  assert.equal(names().length, 2);
  assert.equal(await db.get("SELECT COUNT(*) AS n FROM pending_uploads").then((r) => Number(r.n)), 0, "nothing is left waiting");
  const status = (await admin("GET", "/api/admin/status")).data;
  assert.equal(status.storage.bytes, 400 * KB);
  assert.equal(status.storage.limitBytes, 1024 * KB);
});

test("over the limit: the oldest applications and their files are deleted automatically", async () => {
  // 400 KB so far. Add 350 KB: 750 KB, still under 1 MB.
  const second = await submit({ resumeSize: 350 * KB, name: "Second" });
  assert.equal(second.status, 201);
  assert.equal(await used(), 750 * KB);
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM applications")).n, 2);

  // +400 KB = 1150 KB > 1024 KB: the first application (400 KB, the oldest) goes, leaving 750 KB.
  const first = await db.get("SELECT id, resume_file, photo_file FROM applications ORDER BY created_at, id LIMIT 1");
  const third = await submit({ resumeSize: 400 * KB, name: "Third" });
  assert.equal(third.status, 201);

  assert.equal(await db.get("SELECT 1 AS x FROM applications WHERE id = ?", [first.id]), undefined, "the oldest application is gone");
  const left = (await db.all("SELECT name FROM applications ORDER BY id")).map((r) => r.name);
  assert.deepEqual(left, ["Second", "Third"]);
  assert.equal(await used(), 750 * KB);
  assert.ok(await used() <= 1024 * KB);
  const files = names();
  assert.ok(!files.includes(first.resume_file) && !files.includes(first.photo_file), "its files were deleted from storage");
  assert.equal(files.length, 2);

  const log = await db.get("SELECT details FROM activity_log WHERE type = 'storage_cleanup' ORDER BY id DESC LIMIT 1");
  assert.equal(JSON.parse(log.details).deleted, 1);
  const reason = await db.get("SELECT details FROM activity_log WHERE type = 'application_deleted' ORDER BY id DESC LIMIT 1");
  assert.equal(JSON.parse(reason.details).reason, "storage_limit");
});

test("one big submission can push out several old ones, oldest first, and only as many as needed", async () => {
  await db.run("DELETE FROM applications");
  fs.rmSync(UPLOADS, { recursive: true, force: true });
  fs.mkdirSync(UPLOADS, { recursive: true });
  for (const n of ["Ann", "Bob", "Cat"]) assert.equal((await submit({ resumeSize: 300 * KB, name: n })).status, 201); // 900 KB
  const big = await submit({ resumeSize: 900 * KB, name: "Big" }); // 1800 KB in total: has to drop until it is <= 1024 KB
  assert.equal(big.status, 201);
  const left = (await db.all("SELECT name FROM applications ORDER BY id")).map((r) => r.name);
  assert.deepEqual(left, ["Big"], "Ann, Bob and Cat all had to go to fit the new 900 KB file");
  assert.equal(names().length, 1);
});

test("the daily job trims too (rows added behind the app's back), and needs the right secret", async () => {
  assert.equal((await fetch(`${base}/api/cron/maintenance`, { headers: { "user-agent": UA } })).status, 401);
  assert.equal((await fetch(`${base}/api/cron/maintenance`, { headers: { "user-agent": UA, authorization: "Bearer nope" } })).status, 401);

  await db.run("DELETE FROM applications");
  const role = await db.get("SELECT r.id, r.title FROM roles r LIMIT 1");
  for (let i = 0; i < 4; i++) {
    await db.run(
      `INSERT INTO applications (name, email, phone, role_id, role_title, company_name, resume_file, resume_name, resume_size, photo_size, source, created_at)
       VALUES (?, 'x@example.com', '', ?, ?, 'Co', ?, 'cv.pdf', ?, 0, 'web', now() + (? || ' seconds')::interval)`,
      [`Old${i}`, role.id, role.title, `fake-${i}.pdf`, 400 * KB, String(i)],
    );
  }
  assert.equal(await used(), 1600 * KB);
  const r = await fetch(`${base}/api/cron/maintenance`, { headers: { "user-agent": UA, authorization: "Bearer cron-secret-for-tests" } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.quota.deleted, 2);
  assert.deepEqual((await db.all("SELECT name FROM applications ORDER BY created_at")).map((x) => x.name), ["Old2", "Old3"]);
  assert.equal(await used(), 800 * KB);
});

test("uploads that were never attached to an application are cleaned up, and the file checks hold", async () => {
  fs.rmSync(UPLOADS, { recursive: true, force: true });
  fs.mkdirSync(UPLOADS, { recursive: true });

  // refused before any link is issued
  assert.equal((await admin("POST", "/api/admin/applications/uploads", { resume: { name: "cv.exe", size: 100 } })).status, 400);
  assert.equal((await admin("POST", "/api/admin/applications/uploads", { resume: { name: "cv.pdf", size: 2 * 1024 * KB } })).status, 400, "over MAX_RESUME_MB");

  // a link is used but the application is never created
  const slots = await admin("POST", "/api/admin/applications/uploads", { resume: { name: "cv.pdf", size: 10 * KB } });
  const put = await fetch(base + slots.data.resume.upload.url, { method: "PUT", headers: slots.data.resume.upload.headers, body: pdfBytes(10 * KB) });
  assert.equal(put.status, 200);
  assert.equal(names().length, 1);

  // a link can't be used twice
  const again = await fetch(base + slots.data.resume.upload.url, { method: "PUT", headers: slots.data.resume.upload.headers, body: pdfBytes(10 * KB) });
  assert.equal(again.status, 409);

  // a name that wasn't issued, or not a PDF in disguise, doesn't become an application
  const form = { name: "X", email: "x@example.com", roleId, hiringType: "Full-time", workingType: "Remote" };
  assert.equal((await admin("POST", "/api/admin/applications", { ...form, resumeKey: "00000000-0000-4000-8000-000000000000.pdf" })).status, 400);

  // time passes (PENDING_UPLOAD_MINUTES), the job runs, the orphan is deleted
  await db.run("UPDATE pending_uploads SET created_at = created_at - 3 * 60 * 60 * 1000");
  const { runMaintenance } = await import("../src/services/maintenance.js");
  const result = await runMaintenance();
  assert.equal(result.pendingRemoved, 1);
  assert.equal(names().length, 0);
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM pending_uploads")).n), 0);
});

test("a file that doesn't look like what it claims to be is deleted and doesn't count", async () => {
  const slots = await admin("POST", "/api/admin/applications/uploads", { resume: { name: "cv.pdf", size: 50 * KB } });
  await fetch(base + slots.data.resume.upload.url, { method: "PUT", headers: slots.data.resume.upload.headers, body: Buffer.alloc(50 * KB, 0x4d) });
  const before = await used();
  const r = await admin("POST", "/api/admin/applications", {
    name: "Mallory", email: "m@example.com", roleId, hiringType: "Full-time", workingType: "Remote", resumeKey: slots.data.resume.key,
  });
  assert.equal(r.status, 400);
  assert.ok(r.data.fields.resume);
  assert.equal(await used(), before);
  assert.equal(names().length, 0, "the rejected upload was removed from storage");
});

test("the visitor's address is taken from X-Client-IP only when the frontend proves itself with the shared key", async () => {
  const header = (key) => ({ "user-agent": UA, "x-forwarded-for": "10.9.9.9", "x-client-ip": "203.0.113.7", ...(key ? { "x-site-key": key } : {}) });
  const ipOf = async (headers) => {
    const start = await fetch(`${base}/api/verify/start`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
    const { sessionId } = await start.json();
    return (await db.get("SELECT ip FROM verify_sessions WHERE id = ?", [sessionId])).ip;
  };
  assert.equal(await ipOf(header("proxy-key-for-tests")), "203.0.113.7");
  assert.equal(await ipOf(header("wrong-key")), "10.9.9.9", "a visitor can't choose their own address");
  assert.equal(await ipOf(header(null)), "10.9.9.9");
});
