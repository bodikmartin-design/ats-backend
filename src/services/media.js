import crypto from "node:crypto";
import path from "node:path";
import { config } from "../config.js";
import { db } from "../db.js";
import * as storage from "../storage.js";
import { MEDIA_MIME } from "../storage.js";
import { claimPending, discardObjects, dropOwnerPending, registerPending } from "./pending.js";

/**
 * Logo and background uploads. The browser uploads straight to the public "media" bucket with a signed URL (see storage.js);
 * afterwards the server checks what actually arrived: the file type is decided from the file's first bytes, never from its
 * name or the browser's MIME type. SVG is deliberately not accepted: an SVG opened directly can run script on its origin.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** What a file really is, from its first bytes: { type: "image" | "video", ext } or null. */
export function sniffBytes(head) {
  if (!head || head.length < 12) return null;
  if (head.subarray(0, 8).equals(PNG)) return { type: "image", ext: ".png" };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { type: "image", ext: ".jpg" };
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") {
    return { type: "image", ext: ".webp" };
  }
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return { type: "video", ext: ".mp4" };
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { type: "video", ext: ".webm" };
  return null;
}

/** Shared with uploads.js: true if the bytes look like a PNG, JPG or WebP. */
export const looksLikeImageBytes = (head) => sniffBytes(head)?.type === "image";

const mb = (n) => `${Math.round((n / 1048576) * 10) / 10} MB`;
const LOGO_MSG = "Logo must be a PNG, JPG or WebP image.";
const BG_MSG = "Background must be a PNG, JPG or WebP image, or an MP4 / WebM video.";
const failMsg = (kind) => (kind === "logo" ? LOGO_MSG : BG_MSG);

const normExt = (name) => {
  const ext = path.extname(String(name || "")).toLowerCase();
  return ext === ".jpeg" ? ".jpg" : ext;
};

/**
 * Step 1 of a logo / background upload: a signed URL for a new object. `file` = { name, size } as the browser reports them.
 * Resolves to { key, upload } or { error }.
 */
export async function issueMediaUpload(kind, file, owner) {
  const ext = normExt(file?.name);
  const videoOk = kind === "background";
  if (!MEDIA_MIME[ext] || (!videoOk && (ext === ".mp4" || ext === ".webm"))) return { error: failMsg(kind) };
  const isVideo = ext === ".mp4" || ext === ".webm";
  const limit = kind === "logo" ? config.media.logoBytes : isVideo ? config.media.videoBytes : config.media.imageBytes;
  const size = Number(file?.size);
  if (!Number.isFinite(size) || size <= 0) return { error: "That file is empty." };
  if (size > limit) {
    return { error: kind === "logo" ? `Logo must be ${mb(limit)} or smaller.` : `Background ${isVideo ? "videos" : "images"} must be ${mb(limit)} or smaller.` };
  }
  await dropOwnerPending(owner);
  const key = `${crypto.randomUUID()}${ext}`;
  const upload = await storage.createUpload("media", key, { contentType: MEDIA_MIME[ext] });
  await registerPending({ bucket: config.storage.mediaBucket, path: key, kind: `media:${kind}`, owner, declaredName: String(file.name).slice(0, 200) });
  return { key, upload };
}

/**
 * Step 2: after the browser has uploaded, check what arrived. Resolves to { filename, type } or { error }.
 * On an error the uploaded object is deleted.
 */
export async function claimMediaUpload(kind, key, owner) {
  const bucket = config.storage.mediaBucket;
  const row = typeof key === "string" ? await claimPending({ bucket, path: key, kind: `media:${kind}`, owner }) : null;
  if (!row) return { error: "That upload isn't available any more. Please choose the file again." };
  const fail = async (error) => {
    await discardObjects([{ bucket, path: key }]);
    return { error };
  };
  const info = await storage.stat("media", key);
  if (!info) return fail("The file didn't arrive. Please try again.");
  const head = await storage.head("media", key, 16);
  const sniffed = sniffBytes(head);
  if (!sniffed) return fail(failMsg(kind));
  if (kind === "logo" && sniffed.type !== "image") return fail(LOGO_MSG);
  if (sniffed.ext !== normExt(key)) return fail(failMsg(kind)); // the name said one thing, the bytes another
  if (kind === "logo" && info.size > config.media.logoBytes) return fail(`Logo must be ${mb(config.media.logoBytes)} or smaller.`);
  if (sniffed.type === "image" && kind === "background" && info.size > config.media.imageBytes) {
    return fail(`Background images must be ${mb(config.media.imageBytes)} or smaller.`);
  }
  if (sniffed.type === "video" && info.size > config.media.videoBytes) {
    return fail(`Background videos must be ${mb(config.media.videoBytes)} or smaller.`);
  }
  return { filename: key, type: sniffed.type, ownerClaim: `claim:${owner}` };
}

/** The upload is now referenced by a setting: it is no longer "pending". */
export async function finishMediaUpload(filename) {
  await db.run("DELETE FROM pending_uploads WHERE bucket = ? AND path = ?", [config.storage.mediaBucket, filename]);
}

export async function removeMedia(filename) {
  if (filename) await discardObjects([{ bucket: config.storage.mediaBucket, path: path.basename(filename) }]);
}
