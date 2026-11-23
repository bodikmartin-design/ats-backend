import net from "node:net";
import { config } from "../config.js";
import { sameSecret } from "./site.js";

/**
 * Behind Vercel, the candidate site (Next.js) forwards /api calls to this backend, which is itself a Vercel project. The
 * backend then sees the frontend's address, not the visitor's. The frontend passes the visitor's address along in
 * X-Client-IP, and this believes it only when the request also carries the shared SITE_PROXY_KEY (the same secret that
 * already protects X-Site-Host) -- so a visitor can't pick their own address.
 */
export function trustedClientIp(req, _res, next) {
  if (config.siteProxyKey && sameSecret(req.get("x-site-key"), config.siteProxyKey)) {
    const ip = String(req.get("x-client-ip") || "").trim();
    if (ip && net.isIP(ip)) Object.defineProperty(req, "ip", { value: ip, configurable: true });
  }
  next();
}
