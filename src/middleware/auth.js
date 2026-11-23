import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { db } from "../db.js";

export const COOKIE = "rp_admin";

const findUser = (id) => db.get("SELECT id, email, role FROM users WHERE id = ?", [id]);

export function issueSession(res, user) {
  const token = jwt.sign({ sub: user.id }, config.jwtSecret, {
    expiresIn: `${config.adminSessionHours}h`,
    algorithm: "HS256",
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: config.isProd,
    maxAge: config.adminSessionHours * 3600 * 1000,
    path: "/",
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: "/", httpOnly: true, sameSite: "strict", secure: config.isProd });
}

/** Loads the logged-in user from the cookie. The role is read from the DB each time, never from the token. */
export async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE];
  if (!token) return res.status(401).json({ error: "Please log in." });
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
  } catch {
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
  try {
    const user = await findUser(payload.sub);
    if (!user) return res.status(401).json({ error: "Please log in." });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export const requireSuperAdmin = (req, res, next) =>
  req.user?.role === "super_admin" ? next() : res.status(403).json({ error: "Super admin only." });
