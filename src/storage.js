import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { Router } from "express";
import express from "express";
import { config } from "./config.js";

/**
 * File storage. Two buckets:
 *   "uploads"  PRIVATE  resumes and candidate photos. Only reachable through short-lived signed URLs the server hands out.
 *   "media"    PUBLIC   the logo / background shown on the candidate sites.
 *
 * Browsers upload straight to storage with a one-time signed URL created here (Vercel functions can't receive request
 * bodies bigger than 4.5 MB, and a resume plus a photo can be 8 MB), so nothing big ever passes through the server.
 *
 * Drivers: "supabase" (production) and "local" (a folder on disk, served by this API -- tests and local trials).
 */

const MB = 1024 * 1024;

export const UPLOAD_MIME = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
export const MEDIA_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** Logical bucket ("uploads" | "media") -> its settings. */
const BUCKETS = {
  uploads: {
    name: () => config.storage.uploadsBucket,
    public: false,
    sizeLimit: () => Math.max(config.maxResumeBytes, config.maxPhotoBytes),
    mimes: () => [...new Set(Object.values(UPLOAD_MIME))],
  },
  media: {
    name: () => config.storage.mediaBucket,
    public: true,
    sizeLimit: () => Math.max(config.media.logoBytes, config.media.imageBytes, config.media.videoBytes),
    mimes: () => [...new Set(Object.values(MEDIA_MIME))],
  },
};

const bucketOf = (kind) => {
  const b = BUCKETS[kind];
  if (!b) throw new Error(`Unknown bucket "${kind}"`);
  return b;
};

/** A fingerprint of the bucket settings, so changing a size limit in the environment updates the buckets once. */
export function bucketConfigHash() {
  const desc = Object.keys(BUCKETS).map((k) => {
    const b = BUCKETS[k];
    return [config.storage.driver, b.name(), b.public, b.sizeLimit(), b.mimes().join(",")].join("|");
  });
  return crypto.createHash("sha256").update(desc.join("\n")).digest("hex").slice(0, 16);
}

// ------------------------------------------------------------------------------------------------ Supabase driver

let client;
async function supabase() {
  if (client) return client;
  const { supabaseUrl, serviceRoleKey } = config.storage;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (Supabase > Project Settings > API).");
  }
  const { createClient } = await import("@supabase/supabase-js");
  client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
const sb = async (kind) => (await supabase()).storage.from(bucketOf(kind).name());

const isNotFound = (err) =>
  err && (String(err.statusCode) === "404" || err.status === 404 || /not.?found/i.test(err.message || ""));

/** Creates the bucket, or updates it when it already exists. Resolves to an error message, or "" on success. */
async function upsertBucket(root, name, options) {
  let { error } = await root.createBucket(name, options);
  if (error && /already exists|duplicate/i.test(error.message || "")) ({ error } = await root.updateBucket(name, options));
  return error ? error.message || "unknown error" : "";
}

const supabaseDriver = {
  async ensureBuckets() {
    const root = (await supabase()).storage;
    for (const kind of Object.keys(BUCKETS)) {
      const b = bucketOf(kind);
      const options = { public: b.public, fileSizeLimit: b.sizeLimit(), allowedMimeTypes: b.mimes() };
      const problem = await upsertBucket(root, b.name(), options);
      if (!problem) continue;
      // Free Supabase projects cap a single upload at 50 MB and refuse a larger bucket limit. Carry on without a bucket-level
      // size limit; the server still checks every file's size itself.
      const { fileSizeLimit: _unused, ...withoutLimit } = options;
      const retry = await upsertBucket(root, b.name(), withoutLimit);
      if (retry) throw new Error(`Could not set up the storage bucket "${b.name()}": ${problem}`);
      console.warn(`[storage] Bucket "${b.name()}" was set up without a size limit (${problem}).`);
    }
  },

  async createUpload(kind, objectPath, { contentType }) {
    const { data, error } = await (await sb(kind)).createSignedUploadUrl(objectPath);
    if (error) throw new Error(`Could not create an upload URL: ${error.message}`);
    const headers = { "Content-Type": contentType, "x-upsert": "false", "cache-control": "max-age=3600" };
    if (config.storage.anonKey) headers.apikey = config.storage.anonKey;
    return { url: data.signedUrl, method: "PUT", headers };
  },

  async stat(kind, objectPath) {
    const { data, error } = await (await sb(kind)).info(objectPath);
    if (error) {
      if (!isNotFound(error)) console.warn(`[storage] info(${objectPath}) failed:`, error.message);
      return null;
    }
    return { size: Number(data.size), contentType: data.contentType || "" };
  },

  async head(kind, objectPath, n = 16) {
    const { data, error } = await (await sb(kind)).createSignedUrl(objectPath, 60);
    if (error) return null;
    const res = await fetch(data.signedUrl, { headers: { Range: `bytes=0-${n - 1}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok || !res.body) return null;
    // A server that ignores Range sends the whole file; read only the first bytes and drop the rest.
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    while (got < n) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      got += value.length;
    }
    reader.cancel().catch(() => {});
    return Buffer.concat(chunks).subarray(0, n);
  },

  async download(kind, objectPath) {
    const { data, error } = await (await sb(kind)).download(objectPath);
    if (error) throw new Error(`Could not read ${objectPath} from storage: ${error.message}`);
    return Buffer.from(await data.arrayBuffer());
  },

  async remove(kind, paths) {
    if (!paths.length) return true;
    const { error } = await (await sb(kind)).remove(paths);
    if (error) {
      console.warn("[storage] remove failed:", error.message);
      return false;
    }
    return true;
  },

  async signedUrl(kind, objectPath, { expiresIn = 60, downloadName } = {}) {
    const { data, error } = await (await sb(kind)).createSignedUrl(objectPath, expiresIn, downloadName ? { download: downloadName } : undefined);
    if (error) throw new Error(`Could not create a download URL: ${error.message}`);
    return data.signedUrl;
  },

  async publicUrl(objectPath) {
    return (await sb("media")).getPublicUrl(objectPath).data.publicUrl;
  },
};

// ------------------------------------------------------------------------------------------------ local driver

const localFile = (kind, objectPath) => {
  const safe = path.basename(objectPath);
  return path.join(config.storage.localDir, bucketOf(kind).name(), safe);
};
const LOCAL_PREFIX = "/api/_local-storage";

const localDriver = {
  async ensureBuckets() {
    for (const kind of Object.keys(BUCKETS)) fs.mkdirSync(path.join(config.storage.localDir, bucketOf(kind).name()), { recursive: true });
  },

  async createUpload(kind, objectPath, { contentType }) {
    const token = jwt.sign({ k: kind, p: objectPath, ct: contentType }, config.jwtSecret, { expiresIn: "2h" });
    return { url: `${LOCAL_PREFIX}/upload/${token}`, method: "PUT", headers: { "Content-Type": contentType } };
  },

  async stat(kind, objectPath) {
    try {
      const st = fs.statSync(localFile(kind, objectPath));
      return { size: st.size, contentType: "" };
    } catch {
      return null;
    }
  },

  async head(kind, objectPath, n = 16) {
    try {
      const fd = fs.openSync(localFile(kind, objectPath), "r");
      try {
        const buf = Buffer.alloc(n);
        return buf.subarray(0, fs.readSync(fd, buf, 0, n, 0));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null;
    }
  },

  async download(kind, objectPath) {
    return fs.promises.readFile(localFile(kind, objectPath));
  },

  async remove(kind, paths) {
    await Promise.all(paths.map((p) => fs.promises.unlink(localFile(kind, p)).catch(() => {})));
    return true;
  },

  async signedUrl(kind, objectPath, { expiresIn = 60, downloadName } = {}) {
    const token = jwt.sign({ k: kind, p: objectPath, dn: downloadName || "" }, config.jwtSecret, { expiresIn });
    return `${LOCAL_PREFIX}/download/${token}`;
  },

  async publicUrl(objectPath) {
    return `/media/${path.basename(objectPath)}`;
  },
};

const drv = () => (config.storage.driver === "local" ? localDriver : supabaseDriver);

export const ensureBuckets = () => drv().ensureBuckets();
/** -> { url, method, headers }: what the browser needs to PUT the file. `contentType` is fixed by the server, from the file extension. */
export const createUpload = (kind, objectPath, opts) => drv().createUpload(kind, objectPath, opts);
/** -> { size, contentType } or null when there is no such object. */
export const stat = (kind, objectPath) => drv().stat(kind, objectPath);
/** The first `n` bytes of an object (to check what a file really is), or null. */
export const head = (kind, objectPath, n) => drv().head(kind, objectPath, n);
export const download = (kind, objectPath) => drv().download(kind, objectPath);
/** Deletes objects; resolves to false (never throws) when storage refused, so callers can retry later. */
export const remove = (kind, paths) => drv().remove(kind, paths).catch((err) => {
  console.warn("[storage] remove failed:", err.message);
  return false;
});
export const signedUrl = (kind, objectPath, opts) => drv().signedUrl(kind, objectPath, opts);
/** Public URL of an object in the media bucket. */
export const publicUrl = (objectPath) => drv().publicUrl(objectPath);

// ------------------------------------------------------------------------------------------------ local driver HTTP routes

/** Mounted only when STORAGE_DRIVER=local: stands in for Supabase's signed upload / download URLs. */
export function localStorageRoutes() {
  const router = Router();
  const verify = (token) => {
    try {
      return jwt.verify(token, config.jwtSecret);
    } catch {
      return null;
    }
  };

  router.put(
    "/upload/:token",
    express.raw({ type: () => true, limit: 60 * MB }),
    (req, res) => {
      const claims = verify(req.params.token);
      if (!claims || !claims.p || claims.dn !== undefined) return res.status(403).json({ error: "Invalid or expired upload URL." });
      if (req.get("content-type") !== claims.ct) return res.status(415).json({ error: "Wrong content type." });
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "Empty file." });
      const limit = bucketOf(claims.k).sizeLimit();
      if (req.body.length > limit) return res.status(413).json({ error: "That file is too large." });
      const file = localFile(claims.k, claims.p);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) return res.status(409).json({ error: "Already exists." });
      fs.writeFileSync(file, req.body);
      res.json({ Key: `${bucketOf(claims.k).name()}/${claims.p}` });
    },
  );

  router.get("/download/:token", (req, res) => {
    const claims = verify(req.params.token);
    if (!claims || !claims.p || claims.dn === undefined) return res.status(403).json({ error: "Invalid or expired link." });
    const file = localFile(claims.k, claims.p);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "File is missing." });
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (claims.dn) return res.download(file, claims.dn);
    res.sendFile(file, { dotfiles: "allow" });
  });

  return router;
}

export const LOCAL_STORAGE_PREFIX = LOCAL_PREFIX;

/** Path of a stored file on disk -- only meaningful for the local driver (used to serve /media with Range support). */
export const localPath = (kind, objectPath) => localFile(kind, objectPath);
