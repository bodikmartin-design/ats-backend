import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Companies and roles are managed per domain. Own process, own database.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-domains-test-"));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
let server;
let base;
let db;
let cookie;
let A; // domain ids
let B;

before(async () => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DB_DRIVER: "pglite",
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: path.join(tmp, "storage"),
    SETTINGS_CACHE_MS: "0",
    JWT_SECRET: "test-secret",
    SUPERADMIN_EMAIL: "boss@example.com",
    SUPERADMIN_PASSWORD: "correct horse battery",
  });
  const { app } = await import("../src/server.js");
  ({ db } = await import("../src/db.js"));
  await (await import("../src/schema.js")).ensureReady();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", "user-agent": UA },
    body: JSON.stringify({ email: "boss@example.com", password: "correct horse battery" }),
  });
  cookie = login.headers.getSetCookie()[0].split(";")[0];
  A = (await admin("POST", "/api/admin/sites", { name: "Alpha", domain: "alpha.test", active: true })).data.id;
  B = (await admin("POST", "/api/admin/sites", { name: "Beta", domain: "beta.test", active: true })).data.id;
});

after(async () => {
  server?.close();
  await db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function admin(method, url, json) {
  const res = await fetch(base + url, {
    method,
    headers: { "user-agent": UA, "x-requested-with": "XMLHttpRequest", cookie, ...(json ? { "content-type": "application/json" } : {}) },
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

const company = (name, siteId) => admin("POST", "/api/admin/companies", { name, siteId, active: true });
const role = (companyId, title, siteId) => admin("POST", "/api/admin/roles", { companyId, title, siteId, employmentType: "Full-time", active: true });

/** A visitor of one domain: verified, then searching roles / applying, the way the candidate site does. */
async function visitor(host) {
  const headers = { "user-agent": UA, "x-forwarded-for": "8.8.8.8", "x-site-host": host, "content-type": "application/json" };
  const post = (url, body, extra = {}) => fetch(base + url, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  const start = (await post("/api/verify/start", {})).data;
  let { sessionId, challenge } = start;
  for (let i = 0; i < 5; i++) {
    let answer;
    if (challenge.kind === "math") {
      const [a, op, b] = challenge.prompt.replace(" = ?", "").split(" ");
      answer = String(op === "+" ? +a + +b : op === "-" ? +a - +b : +a * +b);
    } else if (challenge.kind === "copy") answer = challenge.prompt;
    else answer = (await db.get("SELECT answer FROM verify_sessions WHERE id = ?", [sessionId])).answer;
    const r = (await post("/api/verify/answer", { sessionId, answer })).data;
    if (r.done) return { token: r.token, headers, post };
    challenge = r.challenge;
  }
  throw new Error("verification did not finish");
}
// the search returns at most 20 roles, so look for the test's own roles by name
const rolesSeenBy = async (v) => {
  const seen = [];
  for (const q of ["Alpha Engineer", "Beta Engineer", "Shared On Beta", "Shared Everywhere", "Leaky Role"]) {
    const res = await fetch(`${base}/api/roles?q=${encodeURIComponent(q)}`, { headers: { ...v.headers, "x-verification-token": v.token } });
    assert.equal(res.status, 200);
    seen.push(...(await res.json()).roles.map((r) => r.title));
  }
  return seen;
};

test("companies are created on a domain (or shared) and listed per domain", async () => {
  const ca = (await company("Alpha Corp", A)).data.id;
  const cb = (await company("Beta Corp", B)).data.id;
  const cs = (await company("Shared Corp", "")).data.id;
  assert.ok(ca && cb && cs);

  // (the first-start sample data adds two more shared companies: "Sample Company" and "Blockchain Project")
  const names = async (qs) => (await admin("GET", `/api/admin/companies${qs}`)).data.companies.map((c) => c.name);
  assert.deepEqual(await names(`?siteId=${A}`), ["Alpha Corp"]);
  assert.deepEqual(await names(`?siteId=${B}`), ["Beta Corp"]);
  assert.deepEqual(await names(`?siteId=${A}&withShared=1`), ["Alpha Corp", "Blockchain Project", "Sample Company", "Shared Corp"]);
  assert.deepEqual(await names("?siteId=none"), ["Blockchain Project", "Sample Company", "Shared Corp"]);
  assert.ok((await names("")).includes("Beta Corp") && (await names("")).includes("Alpha Corp"), "no filter lists every domain's companies");

  const row = (await admin("GET", `/api/admin/companies?siteId=${A}`)).data.companies[0];
  assert.equal(row.siteId, A);
  assert.equal(row.siteDomain, "alpha.test");

  assert.equal((await company("Nowhere Inc", 99999)).status, 400, "unknown domain refused");
});

test("a role lives on its company's domain", async () => {
  const ca = (await admin("GET", `/api/admin/companies?siteId=${A}`)).data.companies[0].id;
  const cs = (await admin("GET", "/api/admin/companies?siteId=none")).data.companies.find((c) => c.name === "Shared Corp").id;

  // left empty, the role takes the company's domain
  const r1 = await role(ca, "Alpha Engineer", "");
  assert.equal(r1.status, 201, JSON.stringify(r1.data));
  assert.equal((await admin("GET", `/api/admin/roles?siteId=${A}`)).data.roles.find((r) => r.title === "Alpha Engineer").siteId, A);

  // another domain than the company's is refused
  const bad = await role(ca, "Wrong place", B);
  assert.equal(bad.status, 400);
  assert.match(bad.data.fields.siteId, /alpha\.test/);

  // a shared company's roles may be on one domain, or shared
  assert.equal((await role(cs, "Shared On Beta", B)).status, 201);
  assert.equal((await role(cs, "Shared Everywhere", "")).status, 201);
  const roles = (await admin("GET", `/api/admin/roles?siteId=${B}`)).data.roles.map((r) => r.title);
  assert.ok(roles.includes("Shared On Beta") && !roles.includes("Alpha Engineer"));

  // editing a role can't move it away from its company's domain either
  const id = (await admin("GET", `/api/admin/roles?siteId=${A}`)).data.roles.find((r) => r.title === "Alpha Engineer").id;
  assert.equal((await admin("PUT", `/api/admin/roles/${id}`, { companyId: ca, title: "Alpha Engineer", siteId: B, employmentType: "Full-time", active: true })).status, 400);
});

test("candidates only see their own domain's roles and companies, plus shared ones", async () => {
  const cb = (await admin("GET", `/api/admin/companies?siteId=${B}`)).data.companies[0].id;
  assert.equal((await role(cb, "Beta Engineer", "")).status, 201);

  const alpha = await visitor("alpha.test");
  const beta = await visitor("beta.test");
  const onAlpha = await rolesSeenBy(alpha);
  const onBeta = await rolesSeenBy(beta);
  assert.ok(onAlpha.includes("Alpha Engineer") && onAlpha.includes("Shared Everywhere"));
  assert.ok(!onAlpha.includes("Beta Engineer") && !onAlpha.includes("Shared On Beta"));
  assert.ok(onBeta.includes("Beta Engineer") && onBeta.includes("Shared On Beta") && onBeta.includes("Shared Everywhere"));
  assert.ok(!onBeta.includes("Alpha Engineer"));

  // belt and braces: even a role with no domain under another domain's company (which the admin can't create) stays hidden
  const betaCompany = (await admin("GET", `/api/admin/companies?siteId=${B}`)).data.companies[0].id;
  await db.run("INSERT INTO roles (company_id, title, site_id) VALUES (?, 'Leaky Role', NULL)", [betaCompany]);
  assert.ok(!(await rolesSeenBy(alpha)).includes("Leaky Role"), "a domain's company never shows on another domain");
  assert.ok(!(await rolesSeenBy(await visitor("gamma-unregistered.test"))).includes("Leaky Role"));
  await db.run("DELETE FROM roles WHERE title = 'Leaky Role'");

  // applying for another domain's role is refused
  const betaRole = (await admin("GET", `/api/admin/roles?siteId=${B}`)).data.roles.find((r) => r.title === "Beta Engineer").id;
  const slots = await alpha.post("/api/uploads", { resume: { name: "cv.pdf", size: 1000 } }, { "x-verification-token": alpha.token });
  assert.equal(slots.status, 200);
  const put = await fetch(base + slots.data.resume.upload.url, { method: "PUT", headers: slots.data.resume.upload.headers, body: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(991, 32)]) });
  assert.equal(put.status, 200);
  const apply = await alpha.post(
    "/api/apply",
    { name: "Ada Lovelace", email: "ada@example.com", roleId: betaRole, hiringType: "Full-time", workingType: "Remote", resumeKey: slots.data.resume.key },
    { "x-verification-token": alpha.token },
  );
  assert.equal(apply.status, 400);
  assert.ok(apply.data.fields.roleId);
});

test("moving a company to another domain moves its roles with it", async () => {
  const ca = (await admin("GET", `/api/admin/companies?siteId=${A}`)).data.companies[0];
  const moved = await admin("PUT", `/api/admin/companies/${ca.id}`, { name: ca.name, siteId: B, active: true });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.rolesMoved, 1);
  const alphaRole = (await admin("GET", `/api/admin/roles?siteId=${B}`)).data.roles.find((r) => r.title === "Alpha Engineer");
  assert.ok(alphaRole, "the role now lives on the new domain");
  assert.equal((await admin("GET", `/api/admin/roles?siteId=${A}`)).data.roles.some((r) => r.title === "Alpha Engineer"), false);
  // and back
  await admin("PUT", `/api/admin/companies/${ca.id}`, { name: ca.name, siteId: A, active: true });
});

test("a domain that still has companies or roles can't be deleted (they would silently become shared)", async () => {
  const del = await admin("DELETE", `/api/admin/sites/${A}`);
  assert.equal(del.status, 409);
  assert.match(del.data.error, /compan/);
  assert.ok(await db.get("SELECT 1 AS x FROM sites WHERE id = ?", [A]));

  const empty = (await admin("POST", "/api/admin/sites", { name: "Empty", domain: "empty.test", active: true })).data.id;
  assert.equal((await admin("DELETE", `/api/admin/sites/${empty}`)).status, 200);
});

test("the blockchain role catalog can be added to one domain (a Blockchain Project company of its own)", async () => {
  const first = await admin("POST", "/api/admin/roles/import-blockchain", { siteId: B });
  assert.equal(first.status, 200);
  assert.ok(first.data.added > 50);
  const company = await db.get("SELECT id, site_id FROM companies WHERE id = ?", [first.data.companyId]);
  assert.equal(company.site_id, B);
  const sites = (await db.all("SELECT DISTINCT site_id FROM roles WHERE company_id = ?", [company.id])).map((r) => r.site_id);
  assert.deepEqual(sites, [B]);
  // the shared one made at first start is a different company and was left alone
  const shared = await db.get("SELECT id FROM companies WHERE name = 'Blockchain Project' AND site_id IS NULL");
  assert.ok(shared && shared.id !== company.id);

  const again = await admin("POST", "/api/admin/roles/import-blockchain", { siteId: B });
  assert.equal(again.data.added, 0, "no duplicates");
  assert.equal(again.data.companyId, first.data.companyId);
});

test("upgrading: a company whose roles all belong to one domain is assigned to that domain", async () => {
  const { ensureReady, _resetReady } = await import("../src/schema.js");
  const only = await db.insert("INSERT INTO companies (name) VALUES ('Old Only-Alpha')");
  await db.run("INSERT INTO roles (company_id, title, site_id) VALUES (?, 'x1', ?), (?, 'x2', ?)", [only, A, only, A]);
  const mixed = await db.insert("INSERT INTO companies (name) VALUES ('Old Mixed')");
  await db.run("INSERT INTO roles (company_id, title, site_id) VALUES (?, 'y1', ?), (?, 'y2', NULL)", [mixed, A, mixed]);
  const twoSites = await db.insert("INSERT INTO companies (name) VALUES ('Old Two Domains')");
  await db.run("INSERT INTO roles (company_id, title, site_id) VALUES (?, 'z1', ?), (?, 'z2', ?)", [twoSites, A, twoSites, B]);
  const empty = await db.insert("INSERT INTO companies (name) VALUES ('Old Empty')");

  await db.run("UPDATE settings SET value = '2' WHERE key = 'schema_version'"); // as a database from the previous version
  _resetReady();
  await ensureReady();

  const siteOf = async (id) => (await db.get("SELECT site_id FROM companies WHERE id = ?", [id])).site_id;
  assert.equal(await siteOf(only), A);
  assert.equal(await siteOf(mixed), null, "shared roles keep the company shared");
  assert.equal(await siteOf(twoSites), null);
  assert.equal(await siteOf(empty), null);
  assert.equal((await db.get("SELECT value FROM settings WHERE key = 'schema_version'")).value, "3");
});
