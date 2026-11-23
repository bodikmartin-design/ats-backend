import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import http from "node:http";

// This file runs as its own process (see package.json: `node --test test/*.test.mjs` runs each matched file
// separately), so config.js reads these TLS env vars fresh when server.js is first imported below -- unlike
// smoke.test.mjs, which never sets them and therefore never starts a TLS listener.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-tls-test-"));
const certFile = path.join(tmp, "cert.pem");
const keyFile = path.join(tmp, "key.pem");

// A throwaway self-signed cert for this test only. Node's own TLS client (used below) deliberately does not trust
// it, so the test connects with rejectUnauthorized: false, the same way a developer would need a cert their own
// machine trusts (e.g. mkcert) rather than disabling verification in the app itself.
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", keyFile, "-out", certFile,
  "-days", "1", "-subj", "/CN=localhost",
]);

let httpServer;
let httpsServer;

before(async () => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DB_DRIVER: "pglite",
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: path.join(tmp, "storage"),
    JWT_SECRET: "test-secret",
    SUPERADMIN_EMAIL: "boss@example.com",
    SUPERADMIN_PASSWORD: "correct horse battery",
    PORT: "0",
    TLS_CERT_FILE: certFile,
    TLS_KEY_FILE: keyFile,
    TLS_PORT: "0",
  });
  const { startServers } = await import("../src/server.js");
  ({ httpServer, httpsServer } = startServers());
  await Promise.all(
    [httpServer, httpsServer].map((srv) => new Promise((resolve) => (srv.listening ? resolve() : srv.once("listening", resolve)))),
  );
});

after(() => {
  httpServer?.close();
  httpsServer?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function getJson(url, opts) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    lib.get(url, opts, (res) => {
      // Read the negotiated protocol now, while the socket is still attached to this response (it may be
      // detached/reused by the time the "end" event below fires).
      const protocol = typeof res.socket?.getProtocol === "function" ? res.socket.getProtocol() : null;
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, protocol, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

test("the backend can terminate TLS itself: a second listener comes up and actually speaks HTTPS", async () => {
  assert.ok(httpsServer, "startServers() should have started an HTTPS listener when TLS_CERT_FILE/TLS_KEY_FILE are set");
  const port = httpsServer.address().port;
  const res = await getJson(`https://127.0.0.1:${port}/api/health`, { rejectUnauthorized: false });
  assert.equal(res.status, 200);
  assert.match(res.body, /"ok":true/);
  // TLS 1.0/1.1 are refused; the negotiated protocol here must be 1.2 or newer.
  assert.match(res.protocol, /^TLSv1\.[23]$/);
});

test("the plain-http listener keeps working alongside the HTTPS one (for FORCE_HTTPS's redirect, or a proxy further out)", async () => {
  const port = httpServer.address().port;
  const res = await getJson(`http://127.0.0.1:${port}/api/health`);
  assert.equal(res.status, 200);
  assert.match(res.body, /"ok":true/);
});

test("connecting to the HTTPS listener with an outdated TLS version is refused", async () => {
  const port = httpsServer.address().port;
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      const req = https.get(`https://127.0.0.1:${port}/api/health`, { rejectUnauthorized: false, minVersion: "TLSv1", maxVersion: "TLSv1.1" }, resolve);
      req.on("error", reject);
    }),
  );
});
