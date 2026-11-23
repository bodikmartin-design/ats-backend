import crypto from "node:crypto";
import { Router } from "express";
import { config } from "../config.js";
import { runMaintenance } from "../services/maintenance.js";
import { asyncRoutes } from "../middleware/security.js";

const router = asyncRoutes(Router());

function authorized(req) {
  const given = Buffer.from(String(req.get("authorization") || ""));
  const wanted = Buffer.from(`Bearer ${config.cronSecret}`);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

/**
 * Vercel Cron calls this once a day (see vercel.json) with "Authorization: Bearer <CRON_SECRET>". It removes expired
 * verification sessions and abandoned uploads, retries file deletions that failed earlier, and enforces the storage limit.
 * With no CRON_SECRET set the endpoint is off. Instances also run the same cleanup by themselves about once an hour.
 */
router.get("/maintenance", async (req, res) => {
  if (!config.cronSecret) return res.status(404).json({ error: "Not found" });
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
  res.json({ ok: true, ...(await runMaintenance()) });
});

export default router;
