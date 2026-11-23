import crypto from "node:crypto";
import path from "node:path";
import { config } from "../config.js";
import * as storage from "../storage.js";
import { UPLOAD_MIME } from "../storage.js";
import { looksLikeImageBytes } from "./media.js";
import { claimPending, discardObjects, dropOwnerPending, registerPending } from "./pending.js";

/**
 * Resume and photo uploads. Browsers send the files straight to the private storage bucket (a Vercel function can't take a
 * request body over 4.5 MB, and a resume plus a photo can be 8 MB); the application form then only carries the object names.
 *
 *   1. issueApplicationUploads()  -> signed upload URLs (extension and size are checked first)
 *   2. the browser PUTs the files
 *   3. claimApplicationUploads()  -> the server looks at what actually arrived: its size and its first bytes
 *
 * An extension and a declared MIME type are both easy to fake, so the content is always checked again after the upload.
 */

const RESUME_EXT = new Set([".pdf", ".doc", ".docx"]);
const PHOTO_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:pdf|doc|docx|jpg|jpeg|png|webp)$/;

const mbText = (n) => `${Math.round((n / 1048576) * 10) / 10} MB`;
const RESUME_BAD = "That file doesn't look like a valid PDF, DOC or DOCX.";
const PHOTO_BAD = "That photo doesn't look like a valid JPG, PNG or WebP image, or it's too large.";

/** Names are shown in the admin UI and in Content-Disposition, so strip anything odd. */
export function safeDisplayName(name) {
  const base = path.basename(String(name || "resume")).replace(/[^\w.\- ()]/g, "_");
  return base.slice(0, 120) || "resume";
}

/** Check the file content matches its extension (extension and MIME type alone are easy to fake). */
export function looksLikeResumeBytes(ext, head) {
  if (!head) return false;
  if (ext === ".pdf") return head.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ext === ".docx") return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (ext === ".doc") return head.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  return false;
}

/**
 * Step 1. `resume` / `photo` = { name, size } as the browser reports them (photo is optional).
 * Resolves to { resume: { key, upload }, photo?: { key, upload } } or { fields: { resume?, photo? } } with messages.
 */
export async function issueApplicationUploads({ owner, resume, photo }) {
  const fields = {};
  const rExt = path.extname(String(resume?.name || "")).toLowerCase();
  const rSize = Number(resume?.size);
  if (!resume) fields.resume = "Please attach your resume.";
  else if (!RESUME_EXT.has(rExt)) fields.resume = "Resume must be a PDF, DOC or DOCX file.";
  else if (!Number.isFinite(rSize) || rSize <= 0) fields.resume = "That file is empty.";
  else if (rSize > config.maxResumeBytes) fields.resume = `Resume must be ${mbText(config.maxResumeBytes)} or smaller.`;

  let pExt = "";
  if (photo) {
    pExt = path.extname(String(photo.name || "")).toLowerCase();
    const pSize = Number(photo.size);
    if (!PHOTO_EXT.has(pExt)) fields.photo = "Photo must be a JPG, PNG or WebP image.";
    else if (!Number.isFinite(pSize) || pSize <= 0) fields.photo = "That file is empty.";
    else if (pSize > config.maxPhotoBytes) fields.photo = `Photo must be ${mbText(config.maxPhotoBytes)} or smaller.`;
  }
  if (Object.keys(fields).length) return { fields };

  await dropOwnerPending(owner); // new URLs replace whatever this owner asked for before and never used
  const bucket = config.storage.uploadsBucket;
  const out = {};
  for (const [kind, ext, file] of [["resume", rExt, resume], ...(photo ? [["photo", pExt, photo]] : [])]) {
    const key = `${crypto.randomUUID()}${ext}`;
    const upload = await storage.createUpload("uploads", key, { contentType: UPLOAD_MIME[ext] });
    await registerPending({ bucket, path: key, kind, owner, declaredName: String(file.name).slice(0, 200) });
    out[kind] = { key, upload };
  }
  return out;
}

/**
 * Step 3. Take over the uploaded objects and check them. Resolves to
 *   { resume: { filename, size }, photo: { filename, size } | null, discard() }   -- `discard()` deletes both objects
 * or { status, error, fields } (the objects are already deleted).
 * Whoever holds the result owns the files: call discard() if the application is not created after all.
 */
export async function claimApplicationUploads({ owner, resumeKey, photoKey }) {
  const bucket = config.storage.uploadsBucket;
  const keyOk = (k) => typeof k === "string" && KEY_RE.test(k);

  if (!keyOk(resumeKey) || !RESUME_EXT.has(path.extname(resumeKey))) {
    return { status: 400, error: "Please attach your resume.", fields: { resume: "Please attach your resume." } };
  }
  if (photoKey !== undefined && photoKey !== null && photoKey !== "" && (!keyOk(photoKey) || !PHOTO_EXT.has(path.extname(photoKey)))) {
    return { status: 400, error: PHOTO_BAD, fields: { photo: PHOTO_BAD } };
  }
  const wantPhoto = !!photoKey;

  const claimedResume = await claimPending({ bucket, path: resumeKey, kind: "resume", owner });
  const claimedPhoto = wantPhoto ? await claimPending({ bucket, path: photoKey, kind: "photo", owner }) : null;
  const mine = [claimedResume && { bucket, path: resumeKey }, claimedPhoto && { bucket, path: photoKey }].filter(Boolean);
  const fail = async (status, error, fields) => {
    await discardObjects(mine);
    return { status, error, fields };
  };

  if (!claimedResume) {
    return fail(400, "Your upload expired or was already used. Please attach your resume again.", { resume: "Please attach your resume again." });
  }
  if (wantPhoto && !claimedPhoto) return fail(400, PHOTO_BAD, { photo: PHOTO_BAD });

  const rInfo = await storage.stat("uploads", resumeKey);
  const rHead = rInfo ? await storage.head("uploads", resumeKey, 16) : null;
  if (!rInfo || rInfo.size <= 0 || rInfo.size > config.maxResumeBytes || !looksLikeResumeBytes(path.extname(resumeKey), rHead)) {
    return fail(400, RESUME_BAD, { resume: RESUME_BAD });
  }

  let pInfo = null;
  if (wantPhoto) {
    pInfo = await storage.stat("uploads", photoKey);
    const pHead = pInfo ? await storage.head("uploads", photoKey, 16) : null;
    // The photo is optional, but if one was attached it has to actually be a photo and within its own (smaller) size limit.
    if (!pInfo || pInfo.size <= 0 || pInfo.size > config.maxPhotoBytes || !looksLikeImageBytes(pHead)) {
      return fail(400, PHOTO_BAD, { photo: PHOTO_BAD });
    }
  }

  return {
    resume: { filename: resumeKey, size: rInfo.size, declaredName: claimedResume.declared_name },
    photo: pInfo ? { filename: photoKey, size: pInfo.size, declaredName: claimedPhoto.declared_name } : null,
    discard: () => discardObjects(mine),
  };
}
