import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

// Own process, own database.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-platform-test-"));
let server;
let base;
let db;
let getClientInfo;
let withReported;

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
  ({ getClientInfo, withReported } = await import("../src/services/clientInfo.js"));
  const { app } = await import("../src/server.js");
  ({ db } = await import("../src/db.js"));
  await (await import("../src/schema.js")).ensureReady();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const req = (headers, ip = "8.8.8.8") => ({ ip, get: (k) => headers[k.toLowerCase()] });

const UA = {
  chromeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.2478.67",
  chromeMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  androidChrome: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  chromeOs: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  firefoxLinux: "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
};
const BRAVE_HINTS = { "sec-ch-ua": '"Chromium";v="124", "Brave";v="124", "Not-A.Brand";v="99"', "sec-ch-ua-platform": '"Windows"', "sec-ch-ua-mobile": "?0" };

test("Chrome, Edge, Safari and Firefox are named from their User-Agent", () => {
  const chrome = getClientInfo(req({ "user-agent": UA.chromeWin }));
  assert.match(chrome.browser, /^Chrome 124/);
  assert.equal(chrome.osFamily, "Windows");
  assert.equal(chrome.os, "Windows 10");

  const edge = getClientInfo(req({ "user-agent": UA.edgeWin }));
  assert.match(edge.browser, /^Microsoft Edge 124/);

  const safari = getClientInfo(req({ "user-agent": UA.safariMac }));
  assert.match(safari.browser, /^Safari 17/);
  assert.equal(safari.osFamily, "macOS");

  const firefox = getClientInfo(req({ "user-agent": UA.firefoxLinux }));
  assert.match(firefox.browser, /^Firefox 125/);
  assert.equal(firefox.osFamily, "Linux");
});

test("Brave is recognised from its client hints, although its User-Agent says Chrome", () => {
  const brave = getClientInfo(req({ "user-agent": UA.chromeWin, ...BRAVE_HINTS }));
  assert.match(brave.browser, /^Brave 124/);
  assert.equal(brave.browserName, "Brave");
  assert.equal(brave.osFamily, "Windows");
  // without the hints it is indistinguishable from Chrome, and is reported as Chrome rather than guessed
  assert.equal(getClientInfo(req({ "user-agent": UA.chromeWin })).browserName, "Chrome");
});

test("the operating system comes from the client hint first, so a frozen User-Agent can't mislead", () => {
  // Windows 11 still says "Windows NT 10.0" in the User-Agent; the platform-version hint tells them apart
  const win11 = getClientInfo(req({ "user-agent": UA.chromeWin, "sec-ch-ua-platform": '"Windows"', "sec-ch-ua-platform-version": '"15.0.0"' }));
  assert.equal(win11.os, "Windows 11");
  const win10 = getClientInfo(req({ "user-agent": UA.chromeWin, "sec-ch-ua-platform": '"Windows"', "sec-ch-ua-platform-version": '"10.0.0"' }));
  assert.equal(win10.os, "Windows 10");

  // Chrome and Safari on every Mac say "Mac OS X 10_15_7" (Catalina): that must not be shown as the Mac's version
  for (const ua of [UA.chromeMac, UA.safariMac]) {
    const mac = getClientInfo(req({ "user-agent": ua }));
    assert.equal(mac.os, "macOS");
    assert.ok(!/catalina|10\.15/i.test(mac.os));
  }
  const sonoma = getClientInfo(req({ "user-agent": UA.chromeMac, "sec-ch-ua-platform": '"macOS"', "sec-ch-ua-platform-version": '"14.5.0"' }));
  assert.equal(sonoma.os, "macOS 14.5");

  // the hint wins over a User-Agent that was changed (e.g. a "desktop site" switch or an extension)
  const odd = getClientInfo(req({ "user-agent": UA.chromeWin, "sec-ch-ua-platform": '"Linux"' }));
  assert.equal(odd.osFamily, "Linux");

  assert.equal(getClientInfo(req({ "user-agent": UA.chromeOs })).osFamily, "Chrome OS");
});

test("phones and tablets are detected, including an iPad that presents itself as a Mac", () => {
  assert.equal(getClientInfo(req({ "user-agent": UA.iphone })).isMobile, true);
  assert.equal(getClientInfo(req({ "user-agent": UA.androidChrome })).isMobile, true);
  assert.equal(getClientInfo(req({ "user-agent": UA.androidChrome, "sec-ch-ua-mobile": "?1" })).isMobile, true);
  assert.equal(getClientInfo(req({ "user-agent": UA.chromeWin, "sec-ch-ua-mobile": "?0" })).isMobile, false);

  // iPadOS "Request Desktop Website": the headers alone say Mac...
  const ipadHeaders = req({ "user-agent": UA.safariMac });
  assert.equal(getClientInfo(ipadHeaders).isMobile, false);
  // ...the page knows better (touch points), and tells us:
  assert.equal(getClientInfo(ipadHeaders, { isMobile: true, platform: "MacIntel" }).isMobile, true);
  // and a later request without that report is re-evaluated with it
  const first = getClientInfo(ipadHeaders, { isMobile: true, platform: "MacIntel" });
  const later = withReported(getClientInfo(ipadHeaders), first.reported);
  assert.equal(later.isMobile, true);
  assert.equal(later.platform, "MacIntel");
});

test("what the page reports fills in what the headers don't say", () => {
  const nothing = getClientInfo(req({ "user-agent": "SomeUnknownBrowser/1.0" }), { platform: "Win32" });
  assert.equal(nothing.osFamily, "Windows");
  assert.equal(getClientInfo(req({ "user-agent": "x" }), { platform: "MacIntel" }).osFamily, "macOS");
  assert.equal(getClientInfo(req({ "user-agent": "x" }), { platform: "iPhone" }).isMobile, true);
});

// ---- the stage-3 guide, end to end -----------------------------------------------------------------------------------------

async function call(url, { json, headers = {} } = {}) {
  const res = await fetch(base + url, {
    method: json ? "POST" : "GET",
    headers: { "x-forwarded-for": "8.8.8.8", ...(json ? { "content-type": "application/json" } : {}), ...headers },
    body: json ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

const solveMath = (prompt) => {
  const [a, op, b] = prompt.replace(" = ?", "").split(" ");
  const x = Number(a);
  const y = Number(b);
  return String(op === "+" ? x + y : op === "-" ? x - y : x * y);
};

/** Runs a visitor through the first stages and returns the copy/paste challenge the server creates for them. */
async function copyChallengeFor(headers, client) {
  const start = await call("/api/verify/start", { json: { client }, headers });
  assert.equal(start.status, 200, JSON.stringify(start.data));
  let { sessionId, challenge } = start.data;
  for (let i = 0; i < 5 && challenge.kind !== "copy"; i++) {
    const answer = challenge.kind === "math" ? solveMath(challenge.prompt) : (await db.get("SELECT answer FROM verify_sessions WHERE id = ?", [sessionId])).answer;
    // the later steps are separate requests: they do NOT carry `client`
    const r = await call("/api/verify/answer", { json: { sessionId, answer }, headers });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    challenge = r.data.challenge;
  }
  assert.equal(challenge.kind, "copy");
  return challenge;
}

test("the copy/paste guide matches the visitor's platform even though it is created in a later request", async () => {
  const site = (await call("/api/site", { headers: { "user-agent": UA.chromeWin } })).data;
  const guides = site.verifyTexts.copy.guides;
  assert.ok(guides.mac && guides.win && guides.linux && guides.fallback);
  assert.equal(new Set([guides.mac, guides.win, guides.linux, guides.fallback]).size, 4, "the test needs different wording per platform");

  const win = await copyChallengeFor({ "user-agent": UA.chromeWin, "sec-ch-ua-platform": '"Windows"' }, { platform: "Win32", isMobile: false });
  assert.equal(win.guide, guides.win);
  assert.match(win.platform, /^Chrome on Windows/);

  const brave = await copyChallengeFor({ "user-agent": UA.chromeWin, ...BRAVE_HINTS }, { platform: "Windows", isMobile: false });
  assert.equal(brave.guide, guides.win);
  assert.match(brave.platform, /^Brave on Windows/);

  const edge = await copyChallengeFor({ "user-agent": UA.edgeWin }, { platform: "Win32", isMobile: false });
  assert.match(edge.platform, /^Microsoft Edge on Windows/);

  const safari = await copyChallengeFor({ "user-agent": UA.safariMac }, { platform: "MacIntel", isMobile: false });
  assert.equal(safari.guide, guides.mac);
  assert.equal(safari.platform, "Safari on macOS");

  const chromeMac = await copyChallengeFor({ "user-agent": UA.chromeMac, "sec-ch-ua-platform": '"macOS"' }, { platform: "macOS", isMobile: false });
  assert.equal(chromeMac.guide, guides.mac);

  const linux = await copyChallengeFor({ "user-agent": UA.firefoxLinux }, { platform: "Linux x86_64", isMobile: false });
  assert.equal(linux.guide, guides.linux);

  const chromeOs = await copyChallengeFor({ "user-agent": UA.chromeOs, "sec-ch-ua-platform": '"Chrome OS"' }, { platform: "Chrome OS", isMobile: false });
  assert.equal(chromeOs.guide, guides.fallback);

  const android = await copyChallengeFor({ "user-agent": UA.androidChrome, "sec-ch-ua-mobile": "?1", "sec-ch-ua-platform": '"Android"' }, { platform: "Android", isMobile: true });
  assert.equal(android.guide, guides.fallback);

  const iphone = await copyChallengeFor({ "user-agent": UA.iphone }, { platform: "iPhone", isMobile: true });
  assert.equal(iphone.guide, guides.fallback);
  assert.match(iphone.platform, /\(mobile\)$/);

  // the case that used to be wrong: an iPad in "desktop website" mode. Its headers say Mac; only the report made at the
  // start of the run says it is a tablet, and the guide is created several requests later.
  const ipad = await copyChallengeFor({ "user-agent": UA.safariMac }, { platform: "MacIntel", isMobile: true });
  assert.equal(ipad.guide, guides.fallback, "a tablet has no terminal; it must not get the Mac guide");
  assert.match(ipad.platform, /\(mobile\)$/);
});
