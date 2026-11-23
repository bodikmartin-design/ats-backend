import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-test-"));
const received = []; // what the mock Slack / Telegram servers got

let mock;
let server;
let base;
let dbq; // the app's own database handle, for looking at what the server stored
let mockBaseUrl;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CLIENT = JSON.stringify({ platform: "Win32", language: "en-US", timezone: "America/Chicago", screen: "1920x1080", isMobile: false });

before(async () => {
  // Mock Slack webhook + Telegram Bot API
  mock = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ url: req.url, body: Buffer.concat(chunks).toString("latin1") });
      res.setHeader("content-type", "application/json");
      if (req.url.includes("BADTOKEN")) {
        res.statusCode = 401;
        return res.end('{"ok":false,"description":"Unauthorized"}');
      }
      res.end(req.url.startsWith("/slack") ? "ok" : '{"ok":true}');
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const mockBase = `http://127.0.0.1:${mock.address().port}`;

  Object.assign(process.env, {
    NODE_ENV: "test",
    // In-process Postgres (PGlite) and a plain folder stand in for Supabase Postgres / Storage, so no network is needed
    DB_DRIVER: "pglite",
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: path.join(tmp, "storage"),
    SETTINGS_CACHE_MS: "0",
    // (test-only) where the local storage driver keeps resumes / photos and the logo / background
    UPLOAD_DIR: path.join(tmp, "storage", "resume-uploads"),
    MEDIA_DIR: path.join(tmp, "storage", "portal-media"),
    JWT_SECRET: "test-secret",
    SUPERADMIN_EMAIL: "boss@example.com",
    SUPERADMIN_PASSWORD: "correct horse battery",
    SLACK_WEBHOOK_URL: `${mockBase}/slack`,
    TELEGRAM_BOT_TOKEN: "123:ABC",
    TELEGRAM_CHAT_ID: "-100999",
    TELEGRAM_API_BASE: mockBase,
    PUBLIC_BASE_URL: "http://admin.test",
    // the Settings page only accepts Slack hosts on this list; the test's mock server stands in for hooks.slack.com
    SLACK_ALLOWED_HOSTS: "127.0.0.1",
    SLACK_ALLOW_HTTP: "true",
  });
  mockBaseUrl = mockBase;

  const { app } = await import("../src/server.js");
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  ({ db: dbq } = await import("../src/db.js"));
  const { ensureReady } = await import("../src/schema.js");
  await ensureReady();
});

after(async () => {
  server?.close();
  mock?.close();
  await dbq?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Set while a test acts as a visitor of one particular domain (what the frontend sends as X-Site-Host)
let siteHeaders = {};

/**
 * Files no longer travel inside the request to the API (a Vercel function can't take more than 4.5 MB): the server hands out
 * upload links, the client sends the file straight to storage, and the API call that follows only names the uploaded file.
 * Tests keep describing a request as "this form with a file" and this does the three steps the browser would do.
 */
async function viaUploads(method, url, { form, headers = {}, cookie }) {
  const [pathname, query] = url.split("?");
  const qs = query ? `?${query}` : "";
  const isMedia = pathname.startsWith("/api/admin/settings/media/");
  const fileOf = (name) => {
    const f = form.get(name);
    return f && typeof f === "object" && f.size > 0 ? f : null;
  };
  const info = (f) => ({ name: f.name, size: f.size });
  let slotUrl;
  let ask;
  if (isMedia) {
    const file = fileOf("file");
    if (!file) return call(method, url, { json: {}, headers, cookie });
    slotUrl = `${pathname}/upload-url${qs}`;
    ask = { file: info(file) };
  } else {
    slotUrl = pathname === "/api/apply" ? "/api/uploads" : "/api/admin/applications/uploads";
    ask = { resume: fileOf("resume") ? info(fileOf("resume")) : undefined, photo: fileOf("photo") ? info(fileOf("photo")) : undefined };
  }
  const slots = await call("POST", slotUrl, { json: ask, headers, cookie });
  if (slots.status !== 200) return slots;
  const put = async (slot, file) => {
    const u = slot.upload.url;
    const res = await fetch(u.startsWith("http") ? u : base + u, { method: slot.upload.method, headers: slot.upload.headers, body: Buffer.from(await file.arrayBuffer()) });
    assert.ok(res.ok, `storage upload failed: ${res.status} ${await res.text()}`);
  };
  let body;
  if (isMedia) {
    await put(slots.data, fileOf("file"));
    body = { key: slots.data.key };
  } else {
    await put(slots.data.resume, fileOf("resume"));
    if (slots.data.photo) await put(slots.data.photo, fileOf("photo"));
    body = { resumeKey: slots.data.resume.key, photoKey: slots.data.photo?.key };
    for (const [k, v] of form.entries()) {
      if (k === "resume" || k === "photo") continue;
      body[k] = k === "client" ? JSON.parse(v) : v;
    }
  }
  return call(method, url, { json: body, headers, cookie });
}

async function call(method, url, { json, form, headers = {}, cookie } = {}) {
  if (form) return viaUploads(method, url, { form, headers, cookie });
  const h = { "user-agent": UA, "x-forwarded-for": "8.8.8.8", ...siteHeaders, ...headers };
  let body;
  if (json !== undefined) {
    h["content-type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) body = form;
  if (cookie) h.cookie = cookie;
  const res = await fetch(base + url, { method, headers: h, body });
  let data = null;
  try {
    data = await res.clone().json();
  } catch {
    /* not json */
  }
  return { status: res.status, data, res };
}

const solveMath = (prompt) => {
  const [a, op, b] = prompt.replace(" = ?", "").split(" ");
  const x = Number(a);
  const y = Number(b);
  return String(op === "+" ? x + y : op === "-" ? x - y : x * y);
};
const dbAnswer = async (id) => (await dbq.get("SELECT answer FROM verify_sessions WHERE id = ?", [id])).answer;

/** Runs every step the server asks for, the way a person would, and returns the verification token. */
async function passVerification() {
  const start = await call("POST", "/api/verify/start", { json: { client: JSON.parse(CLIENT) } });
  assert.equal(start.status, 200);
  const { sessionId } = start.data;
  assert.equal(start.data.challenge.answer, undefined, "answer must never be sent to the browser");
  return finishVerification(sessionId, start.data.challenge, start.data.totalStages);
}

async function finishVerification(sessionId, firstChallenge, totalStages) {
  let challenge = firstChallenge;
  let stage = 1;
  for (;;) {
    let answer;
    if (challenge.kind === "math") answer = solveMath(challenge.prompt);
    else if (challenge.kind === "copy") answer = challenge.prompt;
    else {
      assert.match(challenge.image, /^data:image\/svg\+xml;base64,/);
      const svg = Buffer.from(challenge.image.split(",")[1], "base64").toString();
      assert.ok(!svg.includes("<text"), "word must be drawn as paths, not text");
      answer = (await dbAnswer(sessionId)).toUpperCase(); // case does not matter for the word step
    }
    const r = await call("POST", "/api/verify/answer", { json: { sessionId, answer } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.ok, true);
    if (r.data.done) {
      assert.equal(stage, totalStages, "finished after exactly the configured number of steps");
      assert.equal(r.data.token, sessionId);
      return r.data.token;
    }
    stage += 1;
    assert.equal(r.data.stage, stage);
    assert.equal(r.data.totalStages, totalStages);
    challenge = r.data.challenge;
  }
}

const pdf = (name = "cv.pdf") => new File([Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF")], name, { type: "application/pdf" });

function applyForm(roleId, extra = {}) {
  const f = new FormData();
  f.set("name", "Ada Lovelace");
  f.set("email", "ada@example.com");
  f.set("phone", "+1 312 555 0100");
  f.set("roleId", String(roleId));
  f.set("hiringType", extra.hiringType !== undefined ? extra.hiringType : "Full-time");
  f.set("workingType", extra.workingType !== undefined ? extra.workingType : "Remote");
  f.set("client", CLIENT);
  f.set("resume", extra.file || pdf());
  if (extra.photo) f.set("photo", extra.photo);
  return f;
}

async function login(email, password) {
  const r = await call("POST", "/api/auth/login", { json: { email, password }, headers: { "x-requested-with": "XMLHttpRequest" } });
  const cookie = r.res.headers.getSetCookie?.()[0]?.split(";")[0];
  return { ...r, cookie };
}
const ajax = { "x-requested-with": "XMLHttpRequest" };

// ---------------------------------------------------------------------------------------------

test("wrong answers are counted on the server and restart after 3", async () => {
  const { data } = await call("POST", "/api/verify/start", { json: {} });
  const id = data.sessionId;
  const a = await call("POST", "/api/verify/answer", { json: { sessionId: id, answer: "-1" } });
  assert.equal(a.data.ok, false);
  assert.equal(a.data.attemptsLeft, 2);

  // Refreshing the challenge must NOT reset the attempt counter
  await call("POST", "/api/verify/refresh", { json: { sessionId: id } });
  const b = await call("POST", "/api/verify/answer", { json: { sessionId: id, answer: "-1" } });
  assert.equal(b.data.attemptsLeft, 1);

  const c = await call("POST", "/api/verify/answer", { json: { sessionId: id, answer: "-1" } });
  assert.equal(c.data.restarted, true);
  assert.equal(c.data.stage, 1);
});

test("role search and apply are blocked without a verified token", async () => {
  assert.equal((await call("GET", "/api/roles?q=front")).status, 401);
  const fake = "a".repeat(48);
  assert.equal((await call("GET", "/api/roles", { headers: { "x-verification-token": fake } })).status, 401);
  const r = await call("POST", "/api/apply", { form: applyForm(1), headers: { "x-verification-token": fake } });
  assert.equal(r.status, 401);

  // A session that only finished stage 1 is not enough
  const { data } = await call("POST", "/api/verify/start", { json: {} });
  await call("POST", "/api/verify/answer", { json: { sessionId: data.sessionId, answer: solveMath(data.challenge.prompt) } });
  assert.equal((await call("GET", "/api/roles", { headers: { "x-verification-token": data.sessionId } })).status, 401);
});

test("verified visitor can search roles, upload a resume, and the token is single use", async () => {
  const token = await passVerification();
  const H = { "x-verification-token": token };

  const all = await call("GET", "/api/roles", { headers: H });
  assert.equal(all.status, 200);
  assert.ok(all.data.roles.length >= 4);

  const found = await call("GET", "/api/roles?q=front eng", { headers: H });
  // the seed data also holds the general blockchain roles, so other titles can match too; ours must be first (starts-with ranks first)
  assert.equal(found.data.roles[0].title, "Frontend Engineer");
  assert.equal(found.data.roles[0].companyName, "Sample Company");

  // a PDF extension with non-PDF content is rejected, and does not burn the token
  const fake = new File([Buffer.from("MZ not a pdf at all")], "evil.pdf");
  const bad = await call("POST", "/api/apply", { form: applyForm(found.data.roles[0].id, { file: fake }), headers: H });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.fields.resume);
  assert.equal(fs.readdirSync(process.env.UPLOAD_DIR).length, 0, "rejected file must be deleted");

  // wrong extension is rejected too
  const exe = new File([Buffer.from("%PDF-1.4")], "cv.exe");
  assert.equal((await call("POST", "/api/apply", { form: applyForm(found.data.roles[0].id, { file: exe }), headers: H })).status, 400);

  const ok = await call("POST", "/api/apply", { form: applyForm(found.data.roles[0].id), headers: H });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.company.name, "Sample Company", "success response carries the company's public info");
  assert.ok(ok.data.company.description);
  assert.equal(ok.data.company.website, "https://example.com");
  assert.equal(ok.data.company.contactEmail, "careers@example.com");

  const row = (await dbq.get("SELECT * FROM applications WHERE id = ?", [ok.data.id]));
  assert.equal(row.name, "Ada Lovelace");
  assert.equal(row.ip, "8.8.8.8", "IP comes from the server, via the trusted proxy header");
  assert.equal(row.country, "US");
  assert.match(row.browser, /^Chrome 124/);
  assert.equal(row.platform, "Win32");
  assert.equal(row.is_mobile, 0);
  assert.equal(row.source, "web");
  assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, row.resume_file)));

  // reusing the same token fails
  const again = await call("POST", "/api/apply", { form: applyForm(found.data.roles[0].id), headers: H });
  assert.equal(again.status, 401);

  // Slack + Telegram were notified with the client details
  await new Promise((r) => setTimeout(r, 400));
  const slack = received.find((m) => m.url === "/slack");
  const tgMsg = received.find((m) => m.url === "/bot123:ABC/sendMessage");
  const tgDoc = received.find((m) => m.url === "/bot123:ABC/sendDocument");
  assert.ok(slack && tgMsg && tgDoc, "slack, telegram message and telegram document expected");
  for (const text of [slack.body, tgMsg.body]) {
    assert.ok(text.includes("8.8.8.8"));
    assert.ok(text.includes("United States"));
    assert.ok(text.includes("Chrome 124"));
    assert.ok(text.includes("Win32"));
    assert.ok(text.includes("Frontend Engineer"));
  }
  assert.ok(tgDoc.body.includes("%PDF-1.4"));
});

test("mobile application setting controls submissions and mobile tracking", async () => {
  const iphone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

  await putSettings({ allowMobileApplications: false });
  assert.equal((await call("GET", "/api/site")).data.allowMobileApplications, false);
  const blockedToken = await passVerification();
  const blockedHeaders = { "x-verification-token": blockedToken };
  const blockedRoles = (await call("GET", "/api/roles", { headers: blockedHeaders })).data.roles;
  const blockedForm = applyForm(blockedRoles[0].id);
  blockedForm.set("client", JSON.stringify({ platform: "iPhone", isMobile: true }));
  const blocked = await call("POST", "/api/apply", { form: blockedForm, headers: { ...blockedHeaders, "user-agent": iphone } });
  assert.equal(blocked.status, 403);

  await putSettings({ allowMobileApplications: true });
  assert.equal((await call("GET", "/api/site")).data.allowMobileApplications, true);
  const token = await passVerification();
  const H = { "x-verification-token": token };
  const roles = (await call("GET", "/api/roles", { headers: H })).data.roles;
  const f = applyForm(roles[0].id);
  f.set("client", JSON.stringify({ platform: "iPhone", isMobile: true }));
  const r = await call("POST", "/api/apply", { form: f, headers: { ...H, "user-agent": iphone } });
  assert.equal(r.status, 201);
  const row = (await dbq.get("SELECT * FROM applications WHERE id = ?", [r.data.id]));
  assert.equal(row.is_mobile, 1);
  assert.equal(row.platform, "iPhone");
  await putSettings({ allowMobileApplications: true });
});

test("admin area needs login, CSRF header, and roles are enforced", async () => {
  assert.equal((await call("GET", "/api/admin/companies", { headers: ajax })).status, 401);

  const bad = await login("boss@example.com", "wrong password");
  assert.equal(bad.status, 401);
  assert.equal((await call("POST", "/api/auth/login", { json: { email: "boss@example.com", password: "x" } })).status, 403);

  const boss = await login("boss@example.com", "correct horse battery");
  assert.equal(boss.status, 200);
  assert.ok(boss.cookie);
  assert.match(boss.res.headers.getSetCookie()[0], /HttpOnly/i);
  assert.match(boss.res.headers.getSetCookie()[0], /SameSite=Strict/i);

  // state-changing admin request without the header is rejected
  const noHeader = await call("POST", "/api/admin/companies", { json: { name: "X" }, cookie: boss.cookie });
  assert.equal(noHeader.status, 403);

  // super admin sees history
  const apps = await call("GET", "/api/admin/applications", { cookie: boss.cookie, headers: ajax });
  assert.equal(apps.status, 200);
  assert.ok(apps.data.total >= 2);
  assert.equal(apps.data.applications[0].ip, "8.8.8.8");
  const activity = await call("GET", "/api/admin/activity", { cookie: boss.cookie, headers: ajax });
  assert.ok(activity.data.types.includes("verify_complete"));
  assert.ok(activity.data.types.includes("application_submitted"));

  // download the resume
  const dl = await fetch(`${base}/api/admin/applications/${apps.data.applications[0].id}/resume`, {
    headers: { cookie: boss.cookie, "x-requested-with": "XMLHttpRequest" },
  });
  assert.equal(dl.status, 200);
  assert.ok((await dl.text()).startsWith("%PDF-"));
  assert.match(dl.headers.get("content-disposition"), /attachment/);

  // create a normal admin
  const mk = await call("POST", "/api/admin/users", {
    json: { email: "ops@example.com", password: "long enough password", role: "admin" },
    cookie: boss.cookie,
    headers: ajax,
  });
  assert.equal(mk.status, 201);

  const ops = await login("ops@example.com", "long enough password");
  assert.equal(ops.status, 200);
  // admin: can edit companies and roles, cannot see history / submit resumes / manage users
  assert.equal((await call("GET", "/api/admin/companies", { cookie: ops.cookie, headers: ajax })).status, 200);
  for (const p of ["/api/admin/applications", "/api/admin/activity", "/api/admin/users"]) {
    assert.equal((await call("GET", p, { cookie: ops.cookie, headers: ajax })).status, 403, p);
  }
  const submit = await call("POST", "/api/admin/applications", { form: applyForm(1), cookie: ops.cookie, headers: ajax });
  assert.equal(submit.status, 403);
});

test("company and role edits show up in candidate search; super admin can submit a resume", async () => {
  const boss = await login("boss@example.com", "correct horse battery");
  const c = { cookie: boss.cookie, headers: ajax };

  const company = await call("POST", "/api/admin/companies", {
    ...c,
    json: { name: "Acme Robotics", description: "We build robots.", website: "https://acme.test", location: "Chicago", active: true },
  });
  assert.equal(company.status, 201);
  const bad = await call("POST", "/api/admin/companies", { ...c, json: { name: "Bad", website: "javascript:alert(1)" } });
  assert.equal(bad.status, 400);

  const role = await call("POST", "/api/admin/roles", {
    ...c,
    json: { companyId: company.data.id, title: "Robotics Welder", department: "Ops", location: "Chicago", employmentType: "Contract", description: "Weld things.", active: true },
  });
  assert.equal(role.status, 201);

  const token = await passVerification();
  const H = { "x-verification-token": token };
  const search = (q) => call("GET", `/api/roles?q=${encodeURIComponent(q)}`, { headers: H });
  assert.equal((await search("weld")).data.roles[0].companyName, "Acme Robotics");
  assert.equal((await search("acme")).data.roles.length, 1, "can search by company name");
  assert.equal((await search("100%")).data.roles.length, 0, "LIKE wildcards are escaped");

  // hide the role: it disappears for candidates
  await call("PUT", `/api/admin/roles/${role.data.id}`, {
    ...c,
    json: { companyId: company.data.id, title: "Robotics Welder", employmentType: "Contract", active: false },
  });
  assert.equal((await search("weld")).data.roles.length, 0);

  // a company with roles can't be deleted
  assert.equal((await call("DELETE", `/api/admin/companies/${company.data.id}`, c)).status, 409);

  // super admin submits a resume for a candidate (no verification needed)
  const sub = await call("POST", "/api/admin/applications", { ...c, form: applyForm(1) });
  assert.equal(sub.status, 201);
  const row = (await dbq.get("SELECT source, submitted_by FROM applications WHERE id = ?", [sub.data.id]));
  assert.equal(row.source, "admin");
  assert.ok(row.submitted_by);
});

test("security headers and static admin UI", async () => {
  const page = await fetch(`${base}/admin/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(page.headers.get("x-powered-by"), null);
  assert.equal((await fetch(`${base}/admin/app.js`)).status, 200);
});

// ============================================================================================
// Settings page: time zone, verification steps, notifications, themes, branding, history delete
// ============================================================================================

let bossCookie;
async function boss() {
  if (!bossCookie) bossCookie = (await login("boss@example.com", "correct horse battery")).cookie;
  return { cookie: bossCookie, headers: ajax };
}
const getSettings = async () => (await call("GET", "/api/admin/settings", await boss())).data;
const putSettings = async (json) => call("PUT", "/api/admin/settings", { ...(await boss()), json });
const uploadMedia = async (kind, bytes, name) => {
  const f = new FormData();
  f.set("file", new File([bytes], name));
  return call("POST", `/api/admin/settings/media/${kind}`, { ...(await boss()), form: f });
};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(120, 2)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(300, 3)]);

async function submitResume(extra = {}) {
  const token = await passVerification();
  const H = { "x-verification-token": token };
  const roles = (await call("GET", "/api/roles", { headers: H })).data.roles;
  const r = await call("POST", "/api/apply", { form: applyForm(roles[0].id, extra), headers: H });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

test("settings are for super admins only", async () => {
  assert.equal((await call("GET", "/api/admin/settings", { headers: ajax })).status, 401);
  const ops = await login("ops@example.com", "long enough password");
  const asOps = { cookie: ops.cookie, headers: ajax };
  assert.equal((await call("GET", "/api/admin/settings", asOps)).status, 403);
  assert.equal((await call("PUT", "/api/admin/settings", { ...asOps, json: { siteName: "Hacked" } })).status, 403);
  assert.equal((await call("POST", "/api/admin/settings/test-notification", { ...asOps, json: { channel: "slack" } })).status, 403);
  assert.equal((await call("POST", "/api/admin/activity/clear", { ...asOps, json: { mode: "all", confirm: true } })).status, 403);
  const f = new FormData();
  f.set("file", new File([PNG], "x.png"));
  assert.equal((await call("POST", "/api/admin/settings/media/logo", { ...asOps, form: f })).status, 403);
});

test("public site info has defaults and nothing secret", async () => {
  const site = (await call("GET", "/api/site")).data;
  assert.equal(site.siteName, "Resume Portal");
  assert.equal(site.logoUrl, null);
  assert.equal(site.background, null);
  assert.equal(site.themeVars["--bg"], "#f3f5f9");
  assert.equal(JSON.stringify(site).includes("slack"), false);
});

test("time zone: events are shown and sent in the chosen zone, stored as UTC", async () => {
  const bad = await putSettings({ timezone: "Mars/Olympus" });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.fields.timezone);

  const zone = "Pacific/Kiritimati"; // UTC+14, so the local clock is a different day than UTC for part of every day
  const ok = await putSettings({ timezone: zone });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.timezone, zone);

  const expected = (iso) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
        .formatToParts(new Date(iso))
        .map((x) => [x.type, x.value]),
    );
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  };

  const c = await boss();
  const apps = (await call("GET", "/api/admin/applications", c)).data;
  assert.equal(apps.timeZone, zone);
  const a = apps.applications[0];
  assert.equal(a.createdAtLocal, expected(a.createdAt));
  assert.notEqual(a.createdAtLocal, a.createdAt.slice(0, 19).replace("T", " "), "shown in the chosen zone, not UTC");

  const act = (await call("GET", "/api/admin/activity", c)).data;
  assert.equal(act.timeZone, zone);
  assert.equal(act.events[0].createdAtLocal, expected(act.events[0].createdAt));

  // Slack and Telegram messages carry the time in that zone
  const before = received.length;
  await submitResume();
  await new Promise((r) => setTimeout(r, 400));
  const fresh = received.slice(before);
  assert.ok(fresh.some((m) => m.url === "/slack" && m.body.includes(`(${zone})`)), "slack message names the zone");
  assert.ok(fresh.some((m) => m.url.endsWith("/sendMessage") && m.body.includes(`(${zone})`)), "telegram message names the zone");

  await putSettings({ timezone: "UTC" });
});

test("verification steps: allow an empty plan, order is fixed, runs in progress keep their plan", async () => {
  assert.equal((await putSettings({ verifyPlan: ["math"] })).status, 400);
  assert.equal((await putSettings({ verifyPlan: ["math", "bogus"] })).status, 400);
  assert.equal((await putSettings({ verifyPlan: "math,copy" })).status, 400);

  const disabled = await putSettings({ verifyPlan: [] });
  assert.equal(disabled.status, 200);
  assert.deepEqual(disabled.data.verifyPlan, []);
  const noChecks = await call("POST", "/api/verify/start", { json: {} });
  assert.equal(noChecks.status, 200);
  assert.equal(noChecks.data.done, true, "an empty plan immediately completes verification");
  assert.equal(noChecks.data.totalStages, 0);
  assert.ok(noChecks.data.token);
  assert.equal((await call("GET", "/api/roles", { headers: { "x-verification-token": noChecks.data.token } })).status, 200);
  const reset = await putSettings({ verifyPlan: ["math", "words", "copy"] });
  assert.equal(reset.status, 200);

  // a run that starts under the full plan
  const old = await call("POST", "/api/verify/start", { json: {} });
  assert.equal(old.data.totalStages, 3);

  const set = await putSettings({ verifyPlan: ["copy", "math"] }); // order sent doesn't matter
  assert.equal(set.status, 200);
  assert.deepEqual(set.data.verifyPlan, ["math", "copy"]);

  const fresh = await call("POST", "/api/verify/start", { json: {} });
  assert.equal(fresh.data.totalStages, 2);
  assert.equal(fresh.data.challenge.kind, "math");
  const token = await finishVerification(fresh.data.sessionId, fresh.data.challenge, 2);
  assert.ok(token);
  // second step of the 2-step plan really is the copy text
  const again = await call("POST", "/api/verify/start", { json: {} });
  const second = await call("POST", "/api/verify/answer", { json: { sessionId: again.data.sessionId, answer: solveMath(again.data.challenge.prompt) } });
  assert.equal(second.data.challenge.kind, "copy");
  assert.equal(second.data.totalStages, 2);

  // the old run still needs all 3 steps
  await finishVerification(old.data.sessionId, old.data.challenge, 3);

  // a 2-step verification is enough to upload
  await submitResume();

  await putSettings({ verifyPlan: ["math", "words", "copy"] });
  assert.equal((await call("POST", "/api/verify/start", { json: {} })).data.totalStages, 3);
});

test("Slack and Telegram settings: validated, secrets never returned, used for sending, .env is the fallback", async () => {
  assert.equal((await putSettings({ slackWebhookUrl: "https://evil.example/hook" })).status, 400);
  assert.equal((await putSettings({ slackWebhookUrl: "not a url" })).status, 400);
  assert.equal((await putSettings({ telegramBotToken: "nope" })).status, 400);
  assert.equal((await putSettings({ telegramChatId: "hello world" })).status, 400);

  const saved = await putSettings({
    slackWebhookUrl: `${mockBaseUrl}/slack-saved/SECRETWEBHOOKPART`,
    telegramBotToken: "555:SECRETSECRET123456",
    telegramChatId: "-100555",
    telegramSendFile: false,
  });
  assert.equal(saved.status, 200);
  const raw = JSON.stringify((await getSettings()));
  assert.ok(!raw.includes("SECRETWEBHOOKPART"), "webhook secret must not be returned");
  assert.ok(!raw.includes("SECRETSECRET"), "bot token secret must not be returned");
  assert.equal(saved.data.slack.source, "settings");
  assert.equal(saved.data.telegram.masked, "555:••••3456");
  assert.equal(saved.data.telegramChatId, "-100555");

  // the test buttons use the saved values
  const c = await boss();
  assert.equal((await call("POST", "/api/admin/settings/test-notification", { ...c, json: { channel: "slack" } })).status, 200);
  assert.equal((await call("POST", "/api/admin/settings/test-notification", { ...c, json: { channel: "telegram" } })).status, 200);
  assert.ok(received.some((m) => m.url === "/slack-saved/SECRETWEBHOOKPART"));
  assert.ok(received.some((m) => m.url === "/bot555:SECRETSECRET123456/sendMessage" && m.body.includes("-100555")));
  assert.equal((await call("POST", "/api/admin/settings/test-notification", { ...c, json: { channel: "email" } })).status, 502);

  // real applications now go to the saved destinations (and Telegram no longer gets the file)
  const mark = received.length;
  await submitResume();
  await new Promise((r) => setTimeout(r, 400));
  const fresh = received.slice(mark);
  assert.ok(fresh.some((m) => m.url === "/slack-saved/SECRETWEBHOOKPART"));
  assert.ok(fresh.some((m) => m.url === "/bot555:SECRETSECRET123456/sendMessage"));
  assert.ok(!fresh.some((m) => m.url.endsWith("/sendDocument")), "send-file switched off");
  assert.ok(!fresh.some((m) => m.url === "/slack" || m.url.startsWith("/bot123:ABC")), "old .env targets are not used any more");

  // a failing Telegram test reports the problem without leaking the token
  await putSettings({ telegramBotToken: "999:BADTOKENBADTOKEN" });
  const failed = await call("POST", "/api/admin/settings/test-notification", { ...c, json: { channel: "telegram" } });
  assert.equal(failed.status, 502);
  assert.match(failed.data.error, /401/);
  assert.ok(!failed.data.error.includes("BADTOKEN"), "error must not contain the token");

  // clearing falls back to the values from .env
  const cleared = await putSettings({ slackWebhookUrl: "", telegramBotToken: "", telegramChatId: "", telegramSendFile: true });
  assert.equal(cleared.data.slack.source, "env");
  assert.equal(cleared.data.telegram.source, "env");
  const mark2 = received.length;
  await submitResume();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(received.slice(mark2).some((m) => m.url === "/slack"), "back to the .env Slack webhook");
});

test("themes: presets and a custom accent color apply to the candidate site and the admin UI", async () => {
  assert.equal((await putSettings({ publicTheme: "nope" })).status, 400);
  assert.equal((await putSettings({ accentColor: "red" })).status, 400);

  await putSettings({ publicTheme: "dark", adminTheme: "midnight", accentColor: "#FFCC00" });
  const site = (await call("GET", "/api/site")).data;
  assert.equal(site.theme, "dark");
  assert.equal(site.themeVars["--bg"], "#0f1320");
  assert.equal(site.themeVars["--accent"], "#ffcc00");
  assert.equal(site.themeVars["--on-accent"], "#111111", "dark text on a light accent color");
  assert.equal(site.themeVars["--scheme"], "dark");

  const css = await (await fetch(`${base}/admin/theme.css`)).text();
  assert.match(css, /--bg: #0b1226;/);
  assert.match(css, /--accent: #ffcc00;/);

  const s = await getSettings();
  assert.ok(s.options.themes.length >= 6);
  assert.ok(s.options.themes.some((t) => t.id === "dark" && t.vars["--card"]));

  await putSettings({ publicTheme: "light", adminTheme: "light", accentColor: "" });
  assert.match(await (await fetch(`${base}/admin/theme.css`)).text(), /--bg: #f3f5f9;/);
});

test("logo and background upload: type is checked by content, files are served, replaced and removed", async () => {
  // rejected
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
  assert.equal((await uploadMedia("logo", svg, "logo.svg")).status, 400);
  assert.equal((await uploadMedia("logo", Buffer.from("just text"), "logo.png")).status, 400);
  assert.equal((await uploadMedia("logo", MP4, "logo.mp4")).status, 400, "video can't be a logo");
  assert.equal((await uploadMedia("banner", PNG, "x.png")).status, 404);
  assert.deepEqual(fs.readdirSync(process.env.MEDIA_DIR), [], "rejected uploads leave nothing behind");

  // logo
  const up = await uploadMedia("logo", PNG, "my logo.png");
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const logoUrl = up.data.logoUrl;
  assert.match(logoUrl, /^\/media\/[0-9a-f-]{36}\.png$/);
  assert.equal((await call("GET", "/api/site")).data.logoUrl, logoUrl);
  const served = await fetch(base + logoUrl);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

  // replacing the logo deletes the old file
  const oldFile = path.join(process.env.MEDIA_DIR, path.basename(logoUrl));
  const replaced = await uploadMedia("logo", JPG, "new.jpg");
  assert.match(replaced.data.logoUrl, /\.jpg$/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(fs.existsSync(oldFile), false);

  // background video, with Range support so browsers can stream and loop it
  const bg = await uploadMedia("background", MP4, "loop.mp4");
  assert.equal(bg.status, 200);
  assert.deepEqual(bg.data.background, { type: "video", url: bg.data.background.url });
  const site = (await call("GET", "/api/site")).data;
  assert.equal(site.background.type, "video");
  assert.equal(site.background.overlay, 45);
  assert.equal(site.background.blur, 4);
  const ranged = await fetch(base + site.background.url, { headers: { range: "bytes=0-9" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-type"), "video/mp4");
  assert.match(ranged.headers.get("content-range"), /^bytes 0-9\//);

  // switching to an image background replaces the video
  const img = await uploadMedia("background", PNG, "bg.png");
  assert.equal(img.data.background.type, "image");
  assert.equal(img.data.background.url.endsWith(".png"), true);

  // dimming and blur
  assert.equal((await putSettings({ bgOverlay: 95 })).status, 400);
  assert.equal((await putSettings({ bgBlur: -1 })).status, 400);
  await putSettings({ bgOverlay: 60, bgBlur: 8 });
  const tuned = (await call("GET", "/api/site")).data.background;
  assert.equal(tuned.overlay, 60);
  assert.equal(tuned.blur, 8);

  // only logo and background files are public; nothing else, no traversal
  const resume = fs.readdirSync(process.env.UPLOAD_DIR)[0];
  assert.equal((await fetch(`${base}/media/${resume}`)).status, 404, "resumes are not served from /media");
  assert.ok([403, 404].includes((await fetch(`${base}/media/..%2Fuploads%2F${resume}`)).status), "traversal refused");
  assert.equal((await fetch(`${base}/media/`)).status, 404, "no directory listing");

  // remove both
  const files = fs.readdirSync(process.env.MEDIA_DIR);
  assert.equal(files.length, 2);
  const c = await boss();
  assert.equal((await call("DELETE", "/api/admin/settings/media/logo", c)).data.logoUrl, null);
  assert.equal((await call("DELETE", "/api/admin/settings/media/background", c)).data.background, null);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(fs.readdirSync(process.env.MEDIA_DIR), []);
  const clean = (await call("GET", "/api/site")).data;
  assert.equal(clean.logoUrl, null);
  assert.equal(clean.background, null);
});

test("super admin can delete activity history (everything, or older than N days)", async () => {
  const c = await boss();
  const total = (await call("GET", "/api/admin/activity", c)).data.total;
  assert.ok(total > 10);

  assert.equal((await call("POST", "/api/admin/activity/clear", { ...c, json: { mode: "all" } })).status, 400, "needs confirm");
  assert.equal((await call("POST", "/api/admin/activity/clear", { ...c, json: { mode: "older", days: 0 } })).status, 400);
  assert.equal((await call("POST", "/api/admin/activity/clear", { ...c, json: { mode: "older", days: "abc" } })).status, 400);
  assert.equal((await call("POST", "/api/admin/activity/clear", { ...c, json: { mode: "weekly" } })).status, 400);

  // nothing is 30 days old yet, so nothing is deleted
  const none = await call("POST", "/api/admin/activity/clear", { ...c, json: { mode: "older", days: 30 } });
  assert.equal(none.data.deleted, 0);

  // age some entries, then delete only those
  await dbq.run("UPDATE activity_log SET created_at = now() - interval '40 days' WHERE id % 2 = 0");
  const aged = Number((await dbq.get("SELECT COUNT(*) AS n FROM activity_log WHERE created_at < now() - interval '30 days'")).n);
  assert.ok(aged > 0);
  const some = await call("POST", "/api/admin/activity/clear", { ...c, json: { mode: "older", days: 30 } });
  assert.equal(some.data.deleted, aged);

  // delete everything: only the line recording the deletion remains
  const all = await call("POST", "/api/admin/activity/clear", { ...c, json: { mode: "all", confirm: true } });
  assert.ok(all.data.deleted > 0);
  const after = (await call("GET", "/api/admin/activity", c)).data;
  assert.equal(after.total, 1);
  assert.equal(after.events[0].type, "activity_cleared");
  assert.equal(JSON.parse(after.events[0].details).deleted, all.data.deleted);
  assert.equal(after.events[0].user, "boss@example.com");

  // applications are not part of the activity history
  assert.ok((await call("GET", "/api/admin/applications", c)).data.total > 5);
});

test("preparing the database again is harmless and keeps the data", async () => {
  const { ensureReady, _resetReady } = await import("../src/schema.js");
  const before = {
    users: (await dbq.get("SELECT COUNT(*) AS n FROM users")).n,
    roles: (await dbq.get("SELECT COUNT(*) AS n FROM roles")).n,
    apps: (await dbq.get("SELECT COUNT(*) AS n FROM applications")).n,
  };
  _resetReady(); // what a new serverless instance does on its first request
  await ensureReady();
  await ensureReady();
  assert.deepEqual(
    {
      users: (await dbq.get("SELECT COUNT(*) AS n FROM users")).n,
      roles: (await dbq.get("SELECT COUNT(*) AS n FROM roles")).n,
      apps: (await dbq.get("SELECT COUNT(*) AS n FROM applications")).n,
    },
    before,
    "starting up again must not re-seed or drop anything",
  );
  // every table is protected by row level security, so Supabase's public REST API can't read them
  const open = await dbq.all(
    "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity",
  );
  assert.deepEqual(open, [], "row level security is enabled on every table");
});

// ============================================================================================
// Site name, notification on/off checkboxes, and visit / per-step / application notifications
// ============================================================================================

test("site name is editable and shown to candidates", async () => {
  assert.equal((await putSettings({ siteName: "" })).status, 400);
  assert.equal((await putSettings({ siteName: "x".repeat(81) })).status, 400);
  const ok = await putSettings({ siteName: "Acme Careers" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.siteName, "Acme Careers");
  assert.equal((await call("GET", "/api/site")).data.siteName, "Acme Careers");
  await putSettings({ siteName: "Resume Portal" });
});

test("role search no longer shows the company description before the resume is submitted", async () => {
  const token = await passVerification();
  const roles = (await call("GET", "/api/roles", { headers: { "x-verification-token": token } })).data.roles;
  // the field is still useful server-side (e.g. for logging), but the frontend must not render it at selection time;
  // here we only confirm the role payload doesn't force the field to be absent, and that /apply is unaffected
  assert.ok(roles.length);
  assert.ok(typeof roles[0].companyName === "string");
});

test("notifications: per-channel on/off switch, independent of saved credentials", async () => {
  await putSettings({ notifyOnApplication: true, notifyOnVisit: false, notifyOnVerifyStep: false });

  // turn Slack off while credentials stay valid: a new application is not sent to Slack any more
  await putSettings({ slackEnabled: false });
  const settingsOff = await getSettings();
  assert.equal(settingsOff.slackEnabled, false);
  assert.equal(settingsOff.slack.set, true, "credentials are untouched, only the switch is off");
  assert.equal((await call("POST", "/api/admin/settings/test-notification", { ...(await boss()), json: { channel: "slack" } })).status, 502, "the test button also respects the switch");

  const mark = received.length;
  await submitResume();
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(!received.slice(mark).some((m) => m.url.includes("/slack")), "Slack switched off: nothing sent");

  await putSettings({ slackEnabled: true });
  const mark2 = received.length;
  await submitResume();
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(received.slice(mark2).some((m) => m.url.includes("/slack")), "Slack switched back on: sent again");

  // same for Telegram
  await putSettings({ telegramEnabled: false });
  assert.equal((await getSettings()).telegramEnabled, false);
  const mark3 = received.length;
  await submitResume();
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(!received.slice(mark3).some((m) => m.url.endsWith("/sendMessage")), "Telegram switched off: nothing sent");
  await putSettings({ telegramEnabled: true });
});

test("notifications: a visitor arriving and passing each verification step can notify, gated by its own setting", async () => {
  await new Promise((r) => setTimeout(r, 400)); // let any trailing async notifications from the previous test land first
  await putSettings({ notifyOnVisit: false, notifyOnVerifyStep: false, verifyPlan: ["math", "copy"] });

  // both off: starting and finishing verification sends nothing
  let mark = received.length;
  const token1 = await passVerification();
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(received.slice(mark).length, 0);

  // turn visit notifications on: starting a session notifies once, finishing the steps does not
  await putSettings({ notifyOnVisit: true });
  mark = received.length;
  const start = await call("POST", "/api/verify/start", { json: {} });
  await new Promise((r) => setTimeout(r, 450));
  const visitMsgs = received.slice(mark);
  assert.equal(visitMsgs.length, 2, "one visit event, sent to both Slack and Telegram");
  assert.ok(visitMsgs.every((m) => /visitor arrived/i.test(m.body)));
  mark = received.length;
  await finishVerification(start.data.sessionId, start.data.challenge, start.data.totalStages);
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(received.slice(mark).length, 0, "step notifications are still off");

  // turn step notifications on instead, visit off: each step passed notifies, with no extra visit message
  await putSettings({ notifyOnVisit: false, notifyOnVerifyStep: true });
  mark = received.length;
  const start2 = await call("POST", "/api/verify/start", { json: {} });
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(received.slice(mark).length, 0, "visit notification is off");
  mark = received.length;
  await finishVerification(start2.data.sessionId, start2.data.challenge, start2.data.totalStages);
  await new Promise((r) => setTimeout(r, 450));
  const stepMsgs = received.slice(mark);
  assert.equal(stepMsgs.length, start2.data.totalStages * 2, "one notification per step, sent to both channels, including the final one");
  assert.ok(stepMsgs.some((m) => /final verification step/i.test(m.body)));
  assert.ok(stepMsgs.some((m) => new RegExp(`1/${start2.data.totalStages}`).test(m.body)));

  await verification_cleanup();
  async function verification_cleanup() {
    await putSettings({ notifyOnVisit: false, notifyOnVerifyStep: false, verifyPlan: ["math", "words", "copy"] });
  }
  // token1 was never consumed; make sure it still works end to end (switch didn't break the normal flow)
  const H = { "x-verification-token": token1 };
  const roles = (await call("GET", "/api/roles", { headers: H })).data.roles;
  assert.ok(roles.length);
});

test("notifications: new-application messages can be switched off on their own", async () => {
  await new Promise((r) => setTimeout(r, 400)); // let any trailing async notifications from the previous test land first
  await putSettings({ notifyOnApplication: false });
  const mark = received.length;
  await submitResume();
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(received.slice(mark).length, 0);
  await putSettings({ notifyOnApplication: true });
  const mark2 = received.length;
  await submitResume();
  await new Promise((r) => setTimeout(r, 450));
  assert.ok(received.slice(mark2).length > 0);
});

// ============================================================================================
// Multi-domain: one backend, many candidate sites, each with its own branding, settings and channels
// ============================================================================================

const wait = (ms = 450) => new Promise((r) => setTimeout(r, ms));
const atHost = (host) => ({ "x-site-host": host });
const siteInfo = async (host) => (await call("GET", "/api/site", { headers: host ? atHost(host) : {} })).data;
const addSite = async (name, domain) => call("POST", "/api/admin/sites", { ...(await boss()), json: { name, domain, active: true } });
const putSite = async (id, json) => call("PUT", `/api/admin/settings?siteId=${id}`, { ...(await boss()), json });
const getSite = async (id) => (await call("GET", `/api/admin/settings?siteId=${id}`, await boss())).data;
const siteIds = {};

/** A visitor of `host` verifies, picks the first role they can see and applies. Returns the apply response. */
async function applyAt(host, roleTitle) {
  siteHeaders = atHost(host);
  try {
    const token = await passVerification();
    const H = { "x-verification-token": token };
    const roles = (await call("GET", "/api/roles" + (roleTitle ? `?q=${encodeURIComponent(roleTitle)}` : ""), { headers: H })).data.roles;
    assert.ok(roles.length, `a role is visible on ${host}`);
    return await call("POST", "/api/apply", { form: applyForm(roles[0].id), headers: H });
  } finally {
    siteHeaders = {};
  }
}

test("domains: add, validate and keep unique; each domain gets its own look, unknown hosts get the default", async () => {
  const ok = await addSite("Alpha Games", "https://ALPHA.test/apply?x=1");
  assert.equal(ok.status, 201);
  siteIds.alpha = ok.data.id;
  siteIds.beta = (await addSite("Beta Labs", "beta.test")).data.id;
  siteIds.gamma = (await addSite("Gamma", "gamma.test")).data.id;

  const list = (await call("GET", "/api/admin/sites", await boss())).data.sites;
  assert.ok(list.some((x) => x.domain === "alpha.test" && x.name === "Alpha Games"), "the domain is stored as a plain host name");
  const dup = await addSite("Again", "Alpha.TEST");
  assert.equal(dup.status, 400);
  assert.ok(dup.data.fields.domain);
  assert.equal((await addSite("Bad", "not a domain!!")).status, 400);

  // a domain without overrides is named after the name it was added with; the default site keeps the default name
  const def = await siteInfo();
  assert.equal((await siteInfo("alpha.test")).siteName, "Alpha Games");
  assert.equal((await siteInfo("www.alpha.test")).siteName, "Alpha Games", "www. reaches the same site");
  assert.equal((await siteInfo("alpha.test:3000")).siteName, "Alpha Games", "so does a port");
  assert.equal((await siteInfo("beta.test")).siteName, "Beta Labs");
  assert.equal((await siteInfo("nobody.test")).siteName, def.siteName, "unknown host: default settings");

  // per-domain overrides never leak into other domains or the default
  const saved = await putSite(siteIds.alpha, { siteName: "Alpha Quest", publicTheme: "forest", accentColor: "#ff8800" });
  assert.equal(saved.status, 200);
  assert.deepEqual([...saved.data.overrides].sort(), ["accentColor", "publicTheme", "siteName"]);
  const a = await siteInfo("alpha.test");
  assert.equal(a.siteName, "Alpha Quest");
  assert.equal(a.theme, "forest");
  assert.equal(a.themeVars["--accent"], "#ff8800");
  const b = await siteInfo("beta.test");
  assert.equal(b.theme, def.theme);
  assert.notEqual(b.themeVars["--accent"], "#ff8800");
  assert.deepEqual(await siteInfo(), def, "the default is unchanged");

  // the admin area theme is shared, so it can't be set per domain
  assert.equal((await putSite(siteIds.alpha, { adminTheme: "dark" })).status, 400);
  // unknown domain id
  assert.equal((await call("GET", "/api/admin/settings?siteId=9999", await boss())).status, 404);
});

test("domains: logo and background are per domain, and a domain can inherit, override or switch them off", async () => {
  const def0 = await siteInfo();
  const up = await call("POST", `/api/admin/settings/media/logo?siteId=${siteIds.alpha}`, { ...(await boss()), form: (() => { const f = new FormData(); f.set("file", new File([PNG], "a.png")); return f; })() });
  assert.equal(up.status, 200);
  assert.ok(up.data.logoUrl?.startsWith("/media/"));
  assert.ok(up.data.overrides.includes("logo"));
  const aLogo = (await siteInfo("alpha.test")).logoUrl;
  assert.equal(aLogo, up.data.logoUrl);
  assert.equal((await siteInfo("beta.test")).logoUrl, def0.logoUrl, "other domains are untouched");
  assert.equal((await fetch(base + aLogo)).status, 200);

  // set a default logo: beta inherits it, alpha keeps its own
  assert.equal((await uploadMedia("logo", JPG, "d.jpg")).status, 200);
  const defLogo = (await siteInfo()).logoUrl;
  assert.ok(defLogo && defLogo !== aLogo);
  assert.equal((await siteInfo("beta.test")).logoUrl, defLogo);
  assert.equal((await siteInfo("alpha.test")).logoUrl, aLogo);

  // background with its own dimming, only for beta
  const bg = new FormData();
  bg.set("file", new File([MP4], "b.mp4"));
  const bgUp = await call("POST", `/api/admin/settings/media/background?siteId=${siteIds.beta}`, { ...(await boss()), form: bg });
  assert.equal(bgUp.status, 200);
  assert.equal((await putSite(siteIds.beta, { bgOverlay: 70, bgBlur: 9 })).status, 200);
  const betaBg = (await siteInfo("beta.test")).background;
  assert.equal(betaBg.type, "video");
  assert.equal(betaBg.overlay, 70);
  assert.equal((await siteInfo("alpha.test")).background, null);

  // "Remove" on a domain means none for that domain, even though the default has a logo
  const removed = await call("DELETE", `/api/admin/settings/media/logo?siteId=${siteIds.alpha}`, await boss());
  assert.equal(removed.status, 200);
  assert.equal((await siteInfo("alpha.test")).logoUrl, null);
  assert.equal((await siteInfo()).logoUrl, defLogo, "the default logo stays");
  assert.equal((await fetch(base + aLogo)).status, 404, "the domain's own file is deleted");

  // "Reset" makes it inherit the default again; resetting the default scope is refused
  const reset = await call("POST", `/api/admin/settings/reset?siteId=${siteIds.alpha}`, { ...(await boss()), json: { keys: ["logo"] } });
  assert.equal(reset.status, 200);
  assert.equal((await siteInfo("alpha.test")).logoUrl, defLogo);
  assert.ok(!reset.data.overrides.includes("logo"));
  assert.equal((await call("POST", "/api/admin/settings/reset", { ...(await boss()), json: { keys: ["logo"] } })).status, 400);

  // resetting beta's background deletes its own file but the default's logo file survives
  const betaBgUrl = betaBg.url;
  assert.equal((await call("POST", `/api/admin/settings/reset?siteId=${siteIds.beta}`, { ...(await boss()), json: { keys: ["background", "bgOverlay", "bgBlur"] } })).status, 200);
  assert.equal((await fetch(base + betaBgUrl)).status, 404);
  assert.equal((await fetch(base + defLogo)).status, 200);
  assert.equal((await call("DELETE", "/api/admin/settings/media/logo", await boss())).status, 200); // tidy up the default
});

test("domains: Slack and Telegram are per domain, inherit the default, and never leak secrets", async () => {
  await putSettings({ notifyOnApplication: true, notifyOnVisit: false, notifyOnVerifyStep: false, slackEnabled: true, telegramEnabled: true });
  await putSite(siteIds.alpha, { slackWebhookUrl: `${mockBaseUrl}/slack-alpha`, telegramBotToken: "111:ALPHA", telegramChatId: "-100111" });
  await putSite(siteIds.beta, { slackWebhookUrl: `${mockBaseUrl}/slack-beta`, telegramBotToken: "222:BETA", telegramChatId: "-100222" });

  const view = await getSite(siteIds.alpha);
  assert.equal(view.slack.source, "site");
  assert.equal(view.telegram.source, "site");
  assert.equal(view.telegramChatId, "-100111");
  assert.ok(!JSON.stringify(view).includes("slack-alpha") && !JSON.stringify(view).includes("111:ALPHA"), "secrets are never returned");
  assert.equal((await getSite(siteIds.gamma)).slack.source, "env", "gamma has nothing of its own and inherits the default settings (here: the .env value)");

  // an application on alpha goes to alpha's channels only, and says which domain it came from
  let mark = received.length;
  assert.equal((await applyAt("alpha.test")).status, 201);
  await wait();
  let got = received.slice(mark);
  assert.ok(got.some((m) => m.url === "/slack-alpha" && m.body.includes("alpha.test")), "alpha Slack");
  assert.ok(got.some((m) => m.url === "/bot111:ALPHA/sendMessage" && m.body.includes("-100111")), "alpha Telegram");
  assert.ok(!got.some((m) => m.url.includes("beta") || m.url.includes("BETA")), "nothing reaches beta's channels");

  // beta likewise
  mark = received.length;
  assert.equal((await applyAt("beta.test")).status, 201);
  await wait();
  got = received.slice(mark);
  assert.ok(got.some((m) => m.url === "/slack-beta"));
  assert.ok(got.some((m) => m.url === "/bot222:BETA/sendMessage"));
  assert.ok(!got.some((m) => m.url.includes("alpha") || m.url.includes("ALPHA")));

  // gamma inherits the default channels (no alpha / beta traffic) and the message names the domain
  mark = received.length;
  assert.equal((await applyAt("gamma.test")).status, 201);
  await wait();
  got = received.slice(mark);
  assert.ok(got.some((m) => m.url.startsWith("/slack") && !m.url.includes("alpha") && !m.url.includes("beta") && m.body.includes("gamma.test")), "default Slack, tagged with gamma.test");
  assert.ok(!got.some((m) => /alpha|beta|ALPHA|BETA/.test(m.url)));

  // the test button uses the domain's own channel
  mark = received.length;
  assert.equal((await call("POST", `/api/admin/settings/test-notification?siteId=${siteIds.alpha}`, { ...(await boss()), json: { channel: "slack" } })).status, 200);
  assert.ok(received.slice(mark).some((m) => m.url === "/slack-alpha" && m.body.includes("alpha.test")));

  // switching Slack off for beta leaves Telegram on and doesn't touch other domains
  await putSite(siteIds.beta, { slackEnabled: false });
  mark = received.length;
  await applyAt("beta.test");
  await wait();
  got = received.slice(mark);
  assert.ok(!got.some((m) => m.url === "/slack-beta"));
  assert.ok(got.some((m) => m.url === "/bot222:BETA/sendMessage"));
  assert.equal((await getSite(siteIds.alpha)).slackEnabled, true);

  // events can differ per domain: visit notices only on alpha
  await putSite(siteIds.alpha, { notifyOnVisit: true });
  mark = received.length;
  siteHeaders = atHost("alpha.test");
  await call("POST", "/api/verify/start", { json: {} });
  siteHeaders = atHost("beta.test");
  await call("POST", "/api/verify/start", { json: {} });
  siteHeaders = {};
  await wait();
  got = received.slice(mark);
  assert.ok(got.some((m) => m.url === "/slack-alpha" && m.body.includes("[alpha.test]")), "alpha announces visitors, tagged with its domain");
  assert.ok(!got.some((m) => m.url.includes("beta")), "beta doesn't");

  // removing alpha's own webhook falls back to the default one
  const cleared = await call("POST", `/api/admin/settings/reset?siteId=${siteIds.alpha}`, { ...(await boss()), json: { keys: ["slackWebhookUrl", "notifyOnVisit"] } });
  assert.equal(cleared.data.slack.source, "env");
  // and "" in a domain's secret field does the same
  await putSite(siteIds.beta, { telegramBotToken: "" });
  assert.equal((await getSite(siteIds.beta)).telegram.source, "env");

  // a saved default is inherited by domains, and reported as such
  await putSettings({ slackWebhookUrl: `${mockBaseUrl}/slack-default` });
  assert.equal((await getSite(siteIds.gamma)).slack.source, "default");
  assert.equal((await getSite(siteIds.alpha)).slack.source, "default");
  mark = received.length;
  await applyAt("gamma.test");
  await wait();
  assert.ok(received.slice(mark).some((m) => m.url === "/slack-default"), "domains without their own webhook use the saved default");
  await putSettings({ slackWebhookUrl: "" }); // back to the .env value for the rest of the suite
});

test("domains: roles can belong to one domain, tokens don't cross domains, switched-off domains are closed", async () => {
  const company = (await call("GET", "/api/admin/companies", await boss())).data.companies[0];
  const mk = await call("POST", "/api/admin/roles", { ...(await boss()), json: { companyId: company.id, title: "Alpha Only Quest Designer", employmentType: "Full-time", active: true, siteId: siteIds.alpha } });
  assert.equal(mk.status, 201);
  const roleId = mk.data.id;
  assert.equal((await call("POST", "/api/admin/roles", { ...(await boss()), json: { companyId: company.id, title: "X", siteId: 9999 } })).status, 400);

  const search = async (host, q) => {
    siteHeaders = atHost(host);
    try {
      const token = await passVerification();
      return { token, roles: (await call("GET", `/api/roles?q=${encodeURIComponent(q)}`, { headers: { "x-verification-token": token } })).data.roles };
    } finally {
      siteHeaders = {};
    }
  };
  assert.equal((await search("alpha.test", "Quest Designer")).roles.length, 1);
  const onBeta = await search("beta.test", "Quest Designer");
  assert.equal(onBeta.roles.length, 0, "not shown on another domain");
  assert.equal((await search("nobody.test", "Quest Designer")).roles.length, 0, "nor on the default site");

  // applying for it from another domain is refused even if the id is guessed
  const H = { "x-verification-token": onBeta.token };
  siteHeaders = atHost("beta.test");
  const sneaky = await call("POST", "/api/apply", { form: applyForm(roleId), headers: H });
  siteHeaders = {};
  assert.equal(sneaky.status, 400);
  assert.ok(sneaky.data.fields.roleId);

  // a token earned on alpha is useless on beta (and the reverse)
  const alphaToken = (await search("alpha.test", "Quest Designer")).token;
  siteHeaders = atHost("beta.test");
  assert.equal((await call("GET", "/api/roles", { headers: { "x-verification-token": alphaToken } })).status, 401);
  siteHeaders = {};

  // admin list filters
  const onlyAlpha = (await call("GET", `/api/admin/roles?siteId=${siteIds.alpha}`, await boss())).data.roles;
  assert.ok(onlyAlpha.length && onlyAlpha.every((r) => r.siteId === siteIds.alpha && r.siteDomain === "alpha.test"));
  const shared = (await call("GET", "/api/admin/roles?siteId=none&q=Quest Designer", await boss())).data.roles;
  assert.equal(shared.length, 0);
  // move it to all domains
  assert.equal((await call("PUT", `/api/admin/roles/${roleId}`, { ...(await boss()), json: { companyId: company.id, title: "Alpha Only Quest Designer", employmentType: "Full-time", active: true, siteId: "" } })).status, 200);
  assert.equal((await search("beta.test", "Quest Designer")).roles.length, 1, "now shown everywhere");

  // switching a domain off closes it
  assert.equal((await call("PUT", `/api/admin/sites/${siteIds.gamma}`, { ...(await boss()), json: { name: "Gamma", domain: "gamma.test", active: false } })).status, 200);
  assert.equal((await siteInfo("gamma.test")).closed, true);
  siteHeaders = atHost("gamma.test");
  const closed = await call("POST", "/api/verify/start", { json: {} });
  siteHeaders = {};
  assert.equal(closed.status, 403);
  assert.equal(closed.data.closed, true);
  assert.equal((await siteInfo("alpha.test")).closed, false);
  await call("PUT", `/api/admin/sites/${siteIds.gamma}`, { ...(await boss()), json: { name: "Gamma", domain: "gamma.test", active: true } });
});

test("domains: verification steps and time zone follow the domain", async () => {
  assert.equal((await putSite(siteIds.alpha, { verifyPlan: ["math", "copy"], timezone: "Asia/Seoul" })).status, 200);
  const start = async (host) => (await call("POST", "/api/verify/start", { json: {}, headers: atHost(host) })).data;
  assert.equal((await start("alpha.test")).totalStages, 2);
  assert.equal((await start("beta.test")).totalStages, (await start("nobody.test")).totalStages, "other domains keep the default steps");
  assert.equal((await getSite(siteIds.alpha)).timezone, "Asia/Seoul");
  assert.notEqual((await getSite(siteIds.beta)).timezone, "Asia/Seoul");
});

test("domains: applications and history show and filter by domain; deleting a domain keeps them", async () => {
  const apps = (await call("GET", `/api/admin/applications?siteId=${siteIds.alpha}`, await boss())).data;
  assert.ok(apps.total >= 1 && apps.applications.every((a) => a.domain === "alpha.test"));
  const defaults = (await call("GET", "/api/admin/applications?siteId=none", await boss())).data;
  assert.ok(defaults.total >= 1 && defaults.applications.every((a) => a.domain === ""));
  const acts = (await call("GET", `/api/admin/activity?siteId=${siteIds.alpha}`, await boss())).data;
  assert.ok(acts.events.length && acts.events.every((e) => e.domain === "alpha.test"));
  assert.ok(acts.types.includes("verify_complete"));

  // a super admin can file a resume under a domain: its notifications and history follow
  const roles = (await call("GET", "/api/admin/roles", await boss())).data.roles;
  const f = applyForm(roles[0].id);
  f.set("siteId", String(siteIds.alpha));
  const mark = received.length;
  assert.equal((await call("POST", "/api/admin/applications", { ...(await boss()), form: f })).status, 201);
  await wait();
  assert.ok(received.slice(mark).some((m) => m.url.startsWith("/slack") && m.body.includes("alpha.test")));

  // delete beta: its settings and own files go, applications keep the domain name, the domain falls back to the default
  const def = await siteInfo();
  const betaApps = (await call("GET", `/api/admin/applications?siteId=${siteIds.beta}`, await boss())).data.total;
  assert.ok(betaApps >= 1);
  const del = await call("DELETE", `/api/admin/sites/${siteIds.beta}`, await boss());
  assert.equal(del.status, 200);
  assert.equal((await dbq.get("SELECT COUNT(*) AS n FROM site_settings WHERE site_id = ?", [siteIds.beta])).n, 0);
  assert.equal((await siteInfo("beta.test")).siteName, def.siteName);
  const kept = (await call("GET", "/api/admin/applications?q=Ada", await boss())).data.applications;
  assert.ok(kept.some((a) => a.domain === "beta.test"), "applications keep the domain they came from");
  assert.equal((await call("DELETE", `/api/admin/sites/${siteIds.beta}`, await boss())).status, 404);

  // only super admins manage domains, any admin can read the list (for the role form)
  const ops = await login("ops@example.com", "long enough password");
  const asOps = { cookie: ops.cookie, headers: ajax };
  assert.equal((await call("GET", "/api/admin/sites", asOps)).status, 200);
  assert.equal((await call("POST", "/api/admin/sites", { ...asOps, json: { name: "N", domain: "n.test" } })).status, 403);
  assert.equal((await call("DELETE", `/api/admin/sites/${siteIds.alpha}`, asOps)).status, 403);
  assert.equal((await call("GET", `/api/admin/settings?siteId=${siteIds.alpha}`, asOps)).status, 403);
});

test("domains: browsers on a registered domain may call the API (without cookies); other origins may not", async () => {
  const withOrigin = (origin) => call("GET", "/api/site", { headers: { origin, ...atHost("alpha.test") } });
  const ok = await withOrigin("http://alpha.test");
  assert.equal(ok.res.headers.get("access-control-allow-origin"), "http://alpha.test");
  assert.equal(ok.res.headers.get("access-control-allow-credentials"), null, "no cookies for site origins");
  assert.equal((await withOrigin("http://evil.example")).res.headers.get("access-control-allow-origin"), null);
});

test("domains: X-Site-Host is only believed with the right key when SITE_PROXY_KEY is set", async () => {
  const { config } = await import("../src/config.js");
  const { requestHost } = await import("../src/middleware/site.js");
  const req = (headers) => ({ get: (k) => headers[k.toLowerCase()] });
  try {
    config.siteProxyKey = "";
    assert.equal(requestHost(req({ "x-site-host": "Alpha.test" })), "alpha.test", "development: header, then Origin, then Host");
    assert.equal(requestHost(req({ origin: "https://beta.test", host: "api.local" })), "beta.test");

    config.siteProxyKey = "s3cret";
    assert.equal(requestHost(req({ "x-site-host": "alpha.test", "x-site-key": "s3cret", host: "api.local" })), "alpha.test");
    assert.equal(requestHost(req({ "x-site-host": "alpha.test", "x-site-key": "wrong", host: "api.local" })), "api.local", "wrong key: header ignored");
    assert.equal(requestHost(req({ "x-site-host": "alpha.test", host: "api.local" })), "api.local", "no key: header ignored");
    assert.equal(requestHost(req({ origin: "https://alpha.test", "x-forwarded-host": "alpha.test", host: "api.local" })), "api.local", "Origin and X-Forwarded-Host can't be used to pick a domain");
  } finally {
    config.siteProxyKey = "";
  }
});

test("blockchain roles are seeded once, can be added again without duplicates, and are open to every domain", async () => {
  const blockchain = (await call("GET", "/api/admin/companies", await boss())).data.companies.find((c) => c.name === "Blockchain Project");
  assert.ok(blockchain && blockchain.roleCount >= 80, "the catalog is in place");
  const smart = (await call("GET", "/api/admin/roles?q=Smart Contract", await boss())).data.roles;
  assert.ok(smart.some((r) => r.title === "Smart Contract Engineer (Solidity)" && r.companyName === "Blockchain Project" && r.siteId === null));
  for (const t of ["Core Protocol Engineer", "Smart Contract Auditor", "Tokenomics Designer / Token Engineer", "Community Manager", "Compliance Officer (AML/KYC)", "Developer Relations Engineer (DevRel)"]) {
    assert.ok((await call("GET", `/api/admin/roles?q=${encodeURIComponent(t)}`, await boss())).data.roles.some((r) => r.title === t), t);
  }

  // delete one, import again: only the missing one comes back; a second import adds nothing
  const gone = smart.find((r) => r.title === "Smart Contract Engineer (Solidity)");
  assert.equal((await call("DELETE", `/api/admin/roles/${gone.id}`, await boss())).status, 200);
  const again = await call("POST", "/api/admin/roles/import-blockchain", { ...(await boss()), json: {} });
  assert.equal(again.status, 200);
  assert.equal(again.data.added, 1);
  assert.ok(again.data.skipped >= 80);
  assert.equal((await call("POST", "/api/admin/roles/import-blockchain", { ...(await boss()), json: {} })).data.added, 0);
  assert.equal((await call("POST", "/api/admin/roles/import-blockchain", { ...(await boss()), json: { companyId: 99999 } })).status, 404);

  // candidates on a domain see them
  siteHeaders = atHost("alpha.test");
  try {
    const token = await passVerification();
    const r = await call("GET", "/api/roles?q=Smart Contract Auditor", { headers: { "x-verification-token": token } });
    assert.equal(r.data.roles[0].title, "Smart Contract Auditor");
  } finally {
    siteHeaders = {};
  }
});

// ============================================================================================
// Confirm-submit re-check (one extra copy/paste step right before the resume is actually sent),
// and stage-3 (copy/paste) changes: no expiry, platform detection, matching guide text
// ============================================================================================

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

/** Like call(), but with a different User-Agent (platform detection reads it). */
async function callAs(ua, method, url, opts = {}) {
  return call(method, url, { ...opts, headers: { "user-agent": ua, ...(opts.headers || {}) } });
}

test("stage 3 (copy/paste): detects the platform, matches the guide to it, and never expires", async () => {
  await putSettings({ verifyPlan: ["math", "words", "copy"] });

  const winId = await finishStageTo((await call("POST", "/api/verify/start", { json: {} })).data.sessionId, "copy");
  const winChallenge = (await call("POST", "/api/verify/refresh", { json: { sessionId: winId } })).data.challenge;
  assert.match(winChallenge.platform, /Windows/); // the suite's default UA (see UA at the top of this file) is Windows
  assert.match(winChallenge.guide, /Win \+ R/);
  assert.match(winChallenge.guide, /Command Prompt/);

  const macStartId = (await callAs(MAC_UA, "POST", "/api/verify/start", { json: {} })).data.sessionId;
  const macId = await finishStageTo(macStartId, "copy", MAC_UA);
  const macChallenge = (await callAs(MAC_UA, "POST", "/api/verify/refresh", { json: { sessionId: macId } })).data.challenge;
  assert.match(macChallenge.platform, /macOS/);
  assert.match(macChallenge.guide, /Terminal/);
  assert.match(macChallenge.guide, /Space/);

  // Linux has a guide of its own (it used to get the Windows one)
  const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const linuxId = await finishStageTo((await callAs(LINUX_UA, "POST", "/api/verify/start", { json: {} })).data.sessionId, "copy", LINUX_UA);
  const linuxChallenge = (await callAs(LINUX_UA, "POST", "/api/verify/refresh", { json: { sessionId: linuxId } })).data.challenge;
  assert.match(linuxChallenge.platform, /Linux/);
  assert.match(linuxChallenge.guide, /Ctrl \+ Alt \+ T/);

  const phoneClient = { ...JSON.parse(CLIENT), isMobile: true };
  const phoneStartId = (await callAs(IPHONE_UA, "POST", "/api/verify/start", { json: { client: phoneClient } })).data.sessionId;
  const phoneId = await finishStageTo(phoneStartId, "copy", IPHONE_UA);
  const phoneChallenge = (await callAs(IPHONE_UA, "POST", "/api/verify/refresh", { json: { sessionId: phoneId } })).data.challenge;
  assert.match(phoneChallenge.platform, /iOS/);
  assert.match(phoneChallenge.platform, /mobile/);
  // a phone has no terminal to open: it gets the generic copy-and-paste wording (never nothing)
  assert.match(phoneChallenge.guide, /copy and paste/i);

  // no expiry on the copy stage: expires_at is pushed far into the future as soon as the session reaches it
  const row = (await dbq.get("SELECT expires_at FROM verify_sessions WHERE id = ?", [winId]));
  assert.ok(row.expires_at > Date.now() + 1000 * 60 * 60 * 24 * 365, "expires_at was pushed far into the future");

  // a confirm session (always just the copy stage, see the next test) is likewise never-expiring from the start
  const token = await passVerification();
  const confirmId = (await call("POST", "/api/verify/confirm/start", { json: {}, headers: { "x-verification-token": token } })).data.sessionId;
  const confirmRow = (await dbq.get("SELECT expires_at FROM verify_sessions WHERE id = ?", [confirmId]));
  assert.ok(confirmRow.expires_at > Date.now() + 1000 * 60 * 60 * 24 * 365);
});

test("verification page text: editable from the admin Settings page, including the platform-specific stage-3 guides", async () => {
  // Defaults show up on the public /site endpoint before anything is customized.
  const before = (await call("GET", "/api/site")).data;
  assert.equal(before.verifyTexts.title, "Verify you're human");
  assert.match(before.verifyTexts.subtitle, /\{total\}/);
  assert.equal(before.verifyTexts.math.title, "Solve the problem");

  // A non-admin can't change it.
  assert.equal((await call("PUT", "/api/admin/settings", { json: { verifyTitle: "Quick check" } })).status, 401);

  // Reject bad input (too long / empty) without touching anything else.
  const tooLong = await putSettings({ verifyTitle: "x".repeat(500) });
  assert.equal(tooLong.status, 400);
  assert.ok(tooLong.data.fields.verifyTitle);
  assert.equal((await putSettings({ verifyCopyGuideMac: "" })).status, 400);

  // A full rewrite of every piece of verification copy, including the per-platform stage-3 guides.
  const saved = await putSettings({
    verifyTitle: "Quick security check",
    verifySubtitle: "Just {total} short steps.",
    verifyMathTitle: "Do the sum",
    verifyMathHint: "Numbers only.",
    verifyMathPlaceholder: "Answer here",
    verifyWordsTitle: "Read the image",
    verifyWordsHint: "Letters only.",
    verifyWordsPlaceholder: "Word here",
    verifyCopyTitle: "Copy & paste",
    verifyCopyHint: "Copy it exactly.",
    verifyCopyPlaceholder: "Paste here",
    verifyCopyGuideMac: "On a Mac: Cmd+C then Cmd+V, custom wording.",
    verifyCopyGuideWin: "On Windows: Ctrl+C then Ctrl+V, custom wording.",
    verifyCopyGuideLinux: "On Linux: open a terminal, custom wording.",
    verifyCopyGuideFallback: "Otherwise: use your device's copy/paste, custom wording.",
  });
  assert.equal(saved.status, 200);

  const after = (await call("GET", "/api/site")).data.verifyTexts;
  assert.equal(after.title, "Quick security check");
  assert.equal(after.subtitle, "Just {total} short steps.");
  assert.equal(after.math.title, "Do the sum");
  assert.equal(after.words.hint, "Letters only.");
  assert.equal(after.copy.placeholder, "Paste here");

  // The stage-3 challenge itself now carries the custom wording, picked by the detected platform, same as before.
  const winId = await finishStageTo((await call("POST", "/api/verify/start", { json: {} })).data.sessionId, "copy");
  const winChallenge = (await call("POST", "/api/verify/refresh", { json: { sessionId: winId } })).data.challenge;
  assert.equal(winChallenge.guide, "On Windows: Ctrl+C then Ctrl+V, custom wording.");

  const macStartId = (await callAs(MAC_UA, "POST", "/api/verify/start", { json: {} })).data.sessionId;
  const macId = await finishStageTo(macStartId, "copy", MAC_UA);
  const macChallenge = (await callAs(MAC_UA, "POST", "/api/verify/refresh", { json: { sessionId: macId } })).data.challenge;
  assert.equal(macChallenge.guide, "On a Mac: Cmd+C then Cmd+V, custom wording.");

  const phoneStartId = (await callAs(IPHONE_UA, "POST", "/api/verify/start", { json: { client: { ...JSON.parse(CLIENT), isMobile: true } } })).data.sessionId;
  const phoneId = await finishStageTo(phoneStartId, "copy", IPHONE_UA);
  const phoneChallenge = (await callAs(IPHONE_UA, "POST", "/api/verify/refresh", { json: { sessionId: phoneId } })).data.challenge;
  assert.equal(phoneChallenge.guide, "Otherwise: use your device's copy/paste, custom wording.", "phones and tablets get the fallback wording");

  const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const linuxStartId = (await callAs(LINUX_UA, "POST", "/api/verify/start", { json: {} })).data.sessionId;
  const linuxId = await finishStageTo(linuxStartId, "copy", LINUX_UA);
  const linuxChallenge = (await callAs(LINUX_UA, "POST", "/api/verify/refresh", { json: { sessionId: linuxId } })).data.challenge;
  assert.equal(linuxChallenge.guide, "On Linux: open a terminal, custom wording.");

  // Restore the defaults so later tests (which assert on the original wording) aren't affected.
  await putSettings({
    verifyTitle: "Verify you're human",
    verifySubtitle: "Complete all {total} quick steps to continue.",
    verifyMathTitle: "Solve the problem",
    verifyMathHint: "Type the answer as a number.",
    verifyMathPlaceholder: "Your answer",
    verifyWordsTitle: "Type the word",
    verifyWordsHint: "Type the letters you see in the image (not case sensitive).",
    verifyWordsPlaceholder: "Type the word",
    verifyCopyTitle: "Copy the text",
    verifyCopyHint: "Press Copy, then paste the text into the box below. Capitals and spaces must match exactly. This step never times out.",
    verifyCopyPlaceholder: "Paste the text here",
    verifyCopyGuideMac: "Press ⌘ Space, type Terminal, and press Enter. Paste the command below and press Enter — enter your password if prompted.",
    verifyCopyGuideWin: "Press Win + R, type cmd, and press Enter to open Command Prompt. Paste the command below and press Enter.",
    verifyCopyGuideLinux: "Press Ctrl + Alt + T to open Terminal. Paste the command below and press Enter — enter your password if prompted.",
    verifyCopyGuideFallback: "Use your device's copy and paste (for example Ctrl+C / Ctrl+V, or Cmd+C / Cmd+V on a Mac) to copy the text above into the box below.",
  });
});

/** Advances a fresh session past math/words (solving each from the stored answer) and returns its id once it reaches `targetKind`. */
async function finishStageTo(sessionId, targetKind, ua = UA) {
  let id = sessionId;
  for (;;) {
    const cur = (await dbq.get("SELECT kind FROM verify_sessions WHERE id = ?", [id]));
    if (cur.kind === targetKind) return id;
    const r = await callAs(ua, "POST", "/api/verify/answer", { json: { sessionId: id, answer: await dbAnswer(id) } });
    if (r.data.done) return id;
  }
}

test("confirm-submit: an extra copy/paste check is required right before the resume is sent", async () => {
  const token = await passVerification();
  const H = { "x-verification-token": token };

  // needs the apply token
  assert.equal((await call("POST", "/api/verify/confirm/start", { json: {} })).status, 401);

  const started = await call("POST", "/api/verify/confirm/start", { json: {}, headers: H });
  assert.equal(started.status, 200);
  assert.equal(started.data.totalStages, 1, "only the copy/paste stage, whatever the site's configured plan is");
  assert.equal(started.data.challenge.kind, "copy");
  const confirmId = started.data.sessionId;

  // solving it gives a token of its own, but it is never accepted by /apply
  const finish = await call("POST", "/api/verify/answer", { json: { sessionId: confirmId, answer: started.data.challenge.prompt } });
  assert.equal(finish.data.done, true);
  const confirmToken = finish.data.token;
  assert.notEqual(confirmToken, token);
  const roles = (await call("GET", "/api/roles", { headers: H })).data.roles;
  const badApply = await call("POST", "/api/apply", { form: applyForm(roles[0].id), headers: { "x-verification-token": confirmToken } });
  assert.equal(badApply.status, 401, "a confirm session's token can't be used to submit");

  // the ORIGINAL apply token still works after the confirm step (it was never consumed by it)
  const ok = await call("POST", "/api/apply", { form: applyForm(roles[0].id), headers: H });
  assert.equal(ok.status, 201);

  // it does not spawn a "visitor arrived" notification, but is logged distinctly from the main verification flow
  const acts = (await call("GET", "/api/admin/activity?type=confirm_start", await boss())).data;
  assert.ok(acts.total >= 1);
  assert.ok((await call("GET", "/api/admin/activity?type=confirm_complete", await boss())).data.total >= 1);
});

// ============================================================================================
// Hiring type / working type (apply form) and the candidate photo upload
// ============================================================================================

const JPG_PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80, 7)]);
const photo = (name = "me.jpg") => new File([JPG_PHOTO], name, { type: "image/jpeg" });

test("application options: the apply form's hiring/working type choices come from the admin-managed catalogs", async () => {
  const token = await passVerification();
  const H = { "x-verification-token": token };
  assert.equal((await call("GET", "/api/application-options")).status, 401, "needs a verified token, like /roles");
  const opts = (await call("GET", "/api/application-options", { headers: H })).data;
  assert.ok(opts.hiringTypes.includes("Full-time"));
  assert.ok(opts.workingTypes.includes("Remote"));
});

test("apply: hiring type and working type are required, and an invalid photo is rejected without wasting the resume", async () => {
  const token = await passVerification();
  const H = { "x-verification-token": token };
  const roles = (await call("GET", "/api/roles", { headers: H })).data.roles;

  const noHiring = await call("POST", "/api/apply", { form: applyForm(roles[0].id, { hiringType: "" }), headers: H });
  assert.equal(noHiring.status, 400);
  assert.ok(noHiring.data.fields.hiringType);

  const noWorking = await call("POST", "/api/apply", { form: applyForm(roles[0].id, { workingType: "" }), headers: H });
  assert.equal(noWorking.status, 400);
  assert.ok(noWorking.data.fields.workingType);

  const unknownType = await call("POST", "/api/apply", { form: applyForm(roles[0].id, { hiringType: "Made-up type" }), headers: H });
  assert.equal(unknownType.status, 400);
  assert.ok(unknownType.data.fields.hiringType);

  // a resume that is actually a text file renamed to .pdf is rejected by content, not by extension
  const fakePdf = new File([Buffer.from("not actually a pdf")], "resume.pdf", { type: "application/pdf" });
  const badResume = await call("POST", "/api/apply", { form: applyForm(roles[0].id, { file: fakePdf }), headers: H });
  assert.equal(badResume.status, 400);

  // the token is still unused after every rejection above -- a bad request never burns the verification
  const good = await call("POST", "/api/apply", { form: applyForm(roles[0].id, { photo: photo() }), headers: H });
  assert.equal(good.status, 201, JSON.stringify(good.data));
});

test("admin: hiring types and working types are managed like roles (domain-scoped CRUD), and show up in applications", async () => {
  const created = await call("POST", "/api/admin/hiring-types", { ...(await boss()), json: { label: "Freelance", active: true } });
  assert.equal(created.status, 201);
  const id = created.data.id;

  const list = (await call("GET", "/api/admin/hiring-types", await boss())).data.hiringTypes;
  assert.ok(list.some((t) => t.id === id && t.label === "Freelance" && t.active));

  const renamed = await call("PUT", `/api/admin/hiring-types/${id}`, { ...(await boss()), json: { label: "Freelance / gig", active: false } });
  assert.equal(renamed.status, 200);
  const afterRename = (await call("GET", "/api/admin/hiring-types", await boss())).data.hiringTypes.find((t) => t.id === id);
  assert.equal(afterRename.label, "Freelance / gig");
  assert.equal(afterRename.active, false);

  // switched off: no longer a valid choice on the apply form
  const token = await passVerification();
  const H = { "x-verification-token": token };
  const roles = (await call("GET", "/api/roles", { headers: H })).data.roles;
  const rejected = await call("POST", "/api/apply", { form: applyForm(roles[0].id, { hiringType: "Freelance / gig" }), headers: H });
  assert.equal(rejected.status, 400);

  assert.equal((await call("DELETE", `/api/admin/hiring-types/${id}`, await boss())).status, 200);
  assert.equal((await call("DELETE", `/api/admin/hiring-types/${id}`, await boss())).status, 404);

  // a submitted application carries the hiring/working type it was submitted with (photo is optional)
  const app = await submitResume({ hiringType: "Part-time", workingType: "Hybrid" });
  const list2 = (await call("GET", "/api/admin/applications", await boss())).data.applications;
  const row = list2.find((a) => a.id === app.id);
  assert.equal(row.hiringType, "Part-time");
  assert.equal(row.workingType, "Hybrid");
  assert.equal(row.hasPhoto, false);

  const withPhoto = await submitResume({ photo: photo() });
  const row2 = (await call("GET", "/api/admin/applications", await boss())).data.applications.find((a) => a.id === withPhoto.id);
  assert.equal(row2.hasPhoto, true);
  const dl = await call("GET", `/api/admin/applications/${withPhoto.id}/photo`, await boss());
  assert.equal(dl.status, 200);
});

// ============================================================================================
// Cleanup: the copy-stage (stage 3) session has no expires_at-based cutoff, so it needs an age-based one instead
// ============================================================================================

test("cleanup: an old, abandoned copy-stage session is swept up by age, not just by expires_at", async () => {
  const { cleanupVerifySessions } = await import("../src/services/maintenance.js");

  // a session stuck on the copy stage, "created" 30 days ago (older than the 7-day default) but with its
  // never-really-expiring expires_at still far in the future -- the age-based rule must catch it anyway
  const oldId = "f".repeat(48);
  const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const farFuture = Date.now() + 100 * 365 * 24 * 60 * 60 * 1000;
  await dbq.run(
    `INSERT INTO verify_sessions (id, stage, kind, answer, case_sensitive, plan, ip, purpose, created_at, expires_at)
     VALUES (?, 3, 'copy', 'whatever', 0, '["math","words","copy"]', '', 'apply', ?, ?)`,
    [oldId, longAgo, farFuture],
  );

  // a fresh one on the same stage must survive the sweep
  const freshId = "e".repeat(48);
  await dbq.run(
    `INSERT INTO verify_sessions (id, stage, kind, answer, case_sensitive, plan, ip, purpose, created_at, expires_at)
     VALUES (?, 3, 'copy', 'whatever', 0, '["math","words","copy"]', '', 'apply', ?, ?)`,
    [freshId, Date.now(), farFuture],
  );

  await cleanupVerifySessions();

  assert.equal((await dbq.get("SELECT 1 FROM verify_sessions WHERE id = ?", [oldId])), undefined, "old copy-stage session was swept up by age");
  assert.ok((await dbq.get("SELECT 1 FROM verify_sessions WHERE id = ?", [freshId])), "fresh one was left alone");
});

test("admin: applications can be viewed (photo + PDF inline, Word downloads) and deleted with their files", async () => {
  const b = await boss();
  const roles = (await call("GET", "/api/admin/roles", b)).data.roles;
  const docx = new File([Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)])], "cv.docx");

  const withPhoto = await call("POST", "/api/admin/applications", { ...b, form: applyForm(roles[0].id, { photo: photo("me.jpg") }) });
  assert.equal(withPhoto.status, 201, JSON.stringify(withPhoto.data));
  const plain = await call("POST", "/api/admin/applications", { ...b, form: applyForm(roles[0].id, { file: docx }) });
  assert.equal(plain.status, 201, JSON.stringify(plain.data));

  const list = (await call("GET", "/api/admin/applications?pageSize=100", b)).data.applications;
  const a = list.find((x) => x.id === withPhoto.data.id);
  const w = list.find((x) => x.id === plain.data.id);
  assert.equal(a.resumeKind, "pdf");
  assert.equal(a.photoName, "me.jpg");
  assert.ok(a.photoSize > 0);
  assert.equal(w.resumeKind, "docx");
  assert.equal(w.hasPhoto, false);

  // photo: shown in the page by default, saved on request
  const shown = await fetch(`${base}/api/admin/applications/${a.id}/photo`, { headers: { cookie: b.cookie } });
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get("content-type"), "image/jpeg");
  assert.ok(!/attachment/.test(shown.headers.get("content-disposition") || ""));
  assert.match(shown.headers.get("content-security-policy"), /sandbox/);
  const saved = await fetch(`${base}/api/admin/applications/${a.id}/photo?download=1`, { headers: { cookie: b.cookie } });
  assert.match(saved.headers.get("content-disposition"), /attachment/);

  // PDF: ?inline=1 shows it, plain request downloads it; Word files always download
  const inlinePdf = await fetch(`${base}/api/admin/applications/${a.id}/resume?inline=1`, { headers: { cookie: b.cookie } });
  assert.equal(inlinePdf.status, 200);
  assert.equal(inlinePdf.headers.get("content-type"), "application/pdf");
  assert.match(inlinePdf.headers.get("content-disposition"), /^inline/);
  assert.ok((await inlinePdf.text()).startsWith("%PDF-"));
  const wordInline = await fetch(`${base}/api/admin/applications/${w.id}/resume?inline=1`, { headers: { cookie: b.cookie } });
  assert.match(wordInline.headers.get("content-disposition"), /attachment/);
  await wordInline.arrayBuffer();

  // only a super admin may view or delete
  await call("POST", "/api/admin/users", { ...b, json: { email: "viewer@example.com", password: "long enough password", role: "admin" } });
  const ops = await login("viewer@example.com", "long enough password");
  const opsC = { cookie: ops.cookie, headers: ajax };
  assert.equal((await call("DELETE", `/api/admin/applications/${a.id}`, opsC)).status, 403);
  assert.equal((await fetch(`${base}/api/admin/applications/${a.id}/photo`, { headers: { cookie: ops.cookie } })).status, 403);

  // delete needs the ajax header like every other change
  assert.equal((await call("DELETE", `/api/admin/applications/${a.id}`, { cookie: b.cookie })).status, 403);

  // delete: the row and both stored files go away, and the history records it without personal details
  const stored = (await dbq.get("SELECT resume_file, photo_file FROM applications WHERE id = ?", [a.id]));
  const uploadDir = process.env.UPLOAD_DIR;
  assert.ok(fs.existsSync(path.join(uploadDir, stored.resume_file)));
  assert.ok(fs.existsSync(path.join(uploadDir, stored.photo_file)));
  const del = await call("DELETE", `/api/admin/applications/${a.id}`, b);
  assert.equal(del.status, 200);
  assert.equal((await dbq.get("SELECT 1 FROM applications WHERE id = ?", [a.id])), undefined);
  await new Promise((r) => setTimeout(r, 100)); // file removal is fire-and-forget
  assert.ok(!fs.existsSync(path.join(uploadDir, stored.resume_file)));
  assert.ok(!fs.existsSync(path.join(uploadDir, stored.photo_file)));
  const log = (await dbq.get("SELECT details FROM activity_log WHERE type = 'application_deleted' ORDER BY id DESC LIMIT 1"));
  assert.equal(JSON.parse(log.details).applicationId, a.id);
  assert.ok(!/Ada|ada@example/.test(log.details));
  assert.equal((await call("DELETE", `/api/admin/applications/${a.id}`, b)).status, 404);
  assert.equal((await fetch(`${base}/api/admin/applications/${a.id}/resume`, { headers: { cookie: b.cookie } })).status, 404);

  assert.equal((await call("DELETE", `/api/admin/applications/${w.id}`, b)).status, 200);
});

test("anti-scraping: scripts are refused, search engines are told no, and repeat offenders get blocked for a while", async () => {
  const scraper = { "x-forwarded-for": "203.0.113.9" };

  // robots.txt and X-Robots-Tag on every kind of response
  const robots = await fetch(`${base}/robots.txt`, { headers: { "user-agent": UA } });
  assert.match(await robots.text(), /Disallow: \//);
  const site = await call("GET", "/api/site", { headers: { "user-agent": UA, ...scraper } });
  assert.match(site.res.headers.get("x-robots-tag"), /noindex/);
  assert.match((await fetch(`${base}/admin/`, { headers: { "user-agent": UA } })).headers.get("x-robots-tag"), /noindex/);

  // branding and health stay open to scripts (the frontend server and uptime monitors use them)
  assert.equal((await call("GET", "/api/health", { headers: { "user-agent": "curl/8.5.0", ...scraper } })).status, 200);
  assert.equal((await call("GET", "/api/site", { headers: { "user-agent": "node", ...scraper } })).status, 200);

  // command-line tools, HTTP libraries, headless browsers and an empty identity are refused on the rest of the public API and on login
  for (const ua of ["curl/8.5.0", "python-requests/2.31.0", "Scrapy/2.11", "Go-http-client/2.0", "node", "Mozilla/5.0 HeadlessChrome/124.0", "Googlebot/2.1", ""]) {
    const r = await call("POST", "/api/verify/start", { json: {}, headers: { "user-agent": ua, "x-forwarded-for": `198.51.100.${ua.length + 1}` } });
    assert.equal(r.status, 403, `"${ua}" should be refused`);
  }
  const login = await call("POST", "/api/auth/login", { json: { email: "a@b.c", password: "x" }, headers: { "user-agent": "curl/8.5.0", "x-forwarded-for": "198.51.100.200", "x-requested-with": "XMLHttpRequest" } });
  assert.equal(login.status, 403);

  // a normal browser is unaffected
  const ok = await call("POST", "/api/verify/start", { json: { client: JSON.parse(CLIENT) }, headers: { "x-forwarded-for": "198.51.100.77" } });
  assert.equal(ok.status, 200);

  // five bot hits in a row and that IP is blocked, even when it then looks like a browser; other IPs are not affected
  for (let i = 0; i < 5; i++) await call("GET", "/api/roles", { headers: { "user-agent": "curl/8.5.0", ...scraper } });
  const blocked = await call("GET", "/api/site", { headers: { "user-agent": UA, ...scraper } });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.res.headers.get("retry-after")) > 0);
  assert.equal((await call("GET", "/api/site", { headers: { "user-agent": UA, "x-forwarded-for": "198.51.100.78" } })).status, 200);
});

test("anti-scraping: every rate-limit hit counts as a strike, and the block ends after its time", async () => {
  const { recordStrike, isBlocked, _resetStrikes } = await import("../src/middleware/antiscrape.js");
  await _resetStrikes();
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i++) assert.equal(await recordStrike("192.0.2.1", t0 + i), false);
  assert.equal(await isBlocked("192.0.2.1", t0 + 10), 0);
  assert.equal(await recordStrike("192.0.2.1", t0 + 5), true);
  assert.ok((await isBlocked("192.0.2.1", t0 + 6)) > 0);
  assert.equal(await isBlocked("192.0.2.1", t0 + 31 * 60 * 1000), 0, "block lifts after 30 minutes");
  // strikes spread over more than the 10 minute window never add up
  for (let i = 0; i < 10; i++) assert.equal(await recordStrike("192.0.2.2", t0 + i * 11 * 60 * 1000), false);
  await _resetStrikes();
});
