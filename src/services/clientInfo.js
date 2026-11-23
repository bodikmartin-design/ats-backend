// geoip-country reads its .dat file from disk the moment it is imported. On Vercel that file may not be bundled, so load it
// defensively: on Vercel the country comes from the x-vercel-ip-country header instead, and this is only the fallback.
let geoip = null;
try {
  geoip = (await import("geoip-country")).default;
} catch (e) {
  console.warn(`[geoip] country database unavailable (${e.code || e.message}); using the platform country header only.`);
}
import Bowser from "bowser";

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function clip(value, max = 200) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function normalizeIp(ip) {
  if (!ip) return "";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function countryFor(ip, headerCountry) {
  let code = /^[A-Za-z]{2}$/.test(headerCountry || "") ? headerCountry.toUpperCase() : "";
  if (!code && ip && geoip) {
    try {
      code = geoip.lookup(ip)?.country || "";
    } catch {
      /* no database, no country */
    }
  }
  if (!code) return { country: "", countryName: "Unknown" };
  let countryName = code;
  try {
    countryName = regionNames.of(code) || code;
  } catch {
    /* keep the code */
  }
  return { country: code, countryName };
}

/** Only keep the fields we expect from the browser, trimmed, so the DB can't be stuffed with junk. */
export function sanitizeReported(raw) {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = {};
    }
  }
  if (!obj || typeof obj !== "object") obj = {};
  return {
    userAgent: clip(obj.userAgent, 400),
    platform: clip(obj.platform),
    language: clip(obj.language, 50),
    timezone: clip(obj.timezone, 80),
    screen: clip(obj.screen, 40),
    isMobile: obj.isMobile === true,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Browser / OS detection
//
// Browsers do not describe themselves the same way, so no single source is enough:
//  - Chrome, Edge, Brave, Opera (Chromium) freeze most of the User-Agent string and send the real platform, mobile flag and
//    brand list as "client hints" (Sec-CH-UA-*). Brave's User-Agent looks exactly like Chrome's; only the hints say "Brave".
//  - Safari and Firefox send no client hints, but their User-Agent is still accurate for the OS family. Safari on every Mac
//    claims "Mac OS X 10_15_7" (so the OS *version* in it is meaningless), and an iPad with "Desktop website" on claims to be a Mac.
//  - Only the page itself can tell an iPad from a Mac (touch points), which is why the browser also reports `isMobile`.
// Each source below is used where it is reliable and the next one is the fallback.
// ---------------------------------------------------------------------------------------------------------------------

/** "Windows" / "macOS" / "Linux" / "Chrome OS" / "Android" / "iOS" from a Sec-CH-UA-Platform value or navigator.platform. */
function osFromPlatformString(value) {
  const p = String(value || "").replace(/"/g, "").trim().toLowerCase();
  if (!p) return "";
  if (p.startsWith("win")) return "Windows";
  if (p.startsWith("mac") || p === "macos" || p === "darwin") return "macOS";
  if (p === "iphone" || p === "ipad" || p === "ipod" || p === "ios" || p === "ipados") return "iOS";
  if (p === "android") return "Android";
  if (p === "chrome os" || p === "chromeos" || p === "cros") return "Chrome OS";
  if (p.startsWith("linux") || p.includes("x11") || p === "ubuntu" || p === "fedora" || p === "debian") return p.includes("arm") && p.includes("v") ? "Android" : "Linux";
  return "";
}

/** The browsers that hide behind "Chrome" in the User-Agent but name themselves in the Sec-CH-UA brand list. */
const BRAND_PRIORITY = ["Brave", "Microsoft Edge", "Opera", "Vivaldi", "Samsung Internet", "Yandex"];

function brandsOf(header) {
  const out = [];
  for (const m of String(header || "").matchAll(/"([^"]+)"\s*;\s*v="([^"]*)"/g)) out.push({ brand: m[1], version: m[2] });
  return out;
}

/** What the request headers say. Pure data, kept on the client record so a later step can be re-evaluated with more information. */
function readSignals(req, reported) {
  return {
    userAgent: clip(req.get("user-agent") || reported.userAgent, 400),
    chUa: clip(req.get("sec-ch-ua"), 300),
    chPlatform: clip(req.get("sec-ch-ua-platform"), 40),
    chPlatformVersion: clip(req.get("sec-ch-ua-platform-version"), 40),
    chMobile: clip(req.get("sec-ch-ua-mobile"), 8),
    geoCountry: clip(req.get("x-vercel-ip-country"), 2),
  };
}

function buildClient(ip, signals, reported) {
  const { country, countryName } = countryFor(ip, signals.geoCountry);
  const parsed = Bowser.parse(signals.userAgent);

  // --- browser
  let browserName = parsed.browser.name || "";
  let browserVersion = parsed.browser.version || "";
  const brands = brandsOf(signals.chUa);
  const special = BRAND_PRIORITY.find((b) => brands.some((x) => x.brand === b));
  if (special && (browserName === "Chrome" || browserName === "Chromium" || browserName === "Microsoft Edge" || !browserName)) {
    browserName = special;
    browserVersion = browserVersion || brands.find((x) => x.brand === special)?.version || "";
  }
  const browser = [browserName, browserVersion].filter(Boolean).join(" ") || "Unknown";

  // --- operating system family: client hint, then User-Agent, then what the page reported (navigator.platform)
  const osFamily =
    osFromPlatformString(signals.chPlatform) || parsed.os.name || osFromPlatformString(reported.platform) || "";

  // --- OS version for display. Never show the frozen Mac version (it would name an OS from 2019 on every Mac).
  let osVersion = "";
  const hintVersion = String(signals.chPlatformVersion || "").replace(/"/g, "").trim();
  if (hintVersion) {
    const [major, minor] = hintVersion.split(".");
    if (osFamily === "Windows") osVersion = Number(major) >= 13 ? "11" : "10"; // Windows 11 still says "NT 10.0" in the User-Agent
    else if (osFamily === "macOS") osVersion = [major, minor].filter(Boolean).join(".");
    else osVersion = [major, minor].filter(Boolean).join(".");
  } else if (osFamily !== "macOS" && osFamily === parsed.os.name) {
    osVersion = parsed.os.versionName || parsed.os.version || "";
  }
  const os = [osFamily, osVersion].filter(Boolean).join(" ") || "Unknown";

  // --- phone or tablet?
  const deviceType = parsed.platform.type || "";
  const isMobile =
    reported.isMobile ||
    signals.chMobile === "?1" ||
    deviceType === "mobile" ||
    deviceType === "tablet" ||
    osFamily === "Android" ||
    osFamily === "iOS";

  const platform = reported.platform || osFamily || "Unknown";
  return { ip, country, countryName, browser, browserName, os, osFamily, platform, isMobile, userAgent: signals.userAgent, reported, signals };
}

/**
 * Build the client record for a request.
 * IP, country, browser and OS are derived on the server (the browser can't be trusted for those).
 * `reported` is what the browser says about itself and is kept alongside for reference; it also settles what the
 * request headers cannot (an iPad that presents itself as a Mac).
 */
export function getClientInfo(req, rawReported) {
  const reported = sanitizeReported(rawReported);
  return buildClient(normalizeIp(req.ip), readSignals(req, reported), reported);
}

/**
 * The same client, re-evaluated with what the browser reported at the start of the verification. The later steps (and the
 * stage-3 guide, which is created in one of them) are separate requests that don't carry that report.
 */
export function withReported(client, rawReported) {
  const stored = sanitizeReported(rawReported);
  const merged = {
    userAgent: client.reported?.userAgent || stored.userAgent,
    platform: client.reported?.platform || stored.platform,
    language: client.reported?.language || stored.language,
    timezone: client.reported?.timezone || stored.timezone,
    screen: client.reported?.screen || stored.screen,
    isMobile: !!client.reported?.isMobile || stored.isMobile,
  };
  return buildClient(client.ip, client.signals, merged);
}