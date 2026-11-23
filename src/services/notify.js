import { config } from "../config.js";
import { download } from "../storage.js";
import { logEvent } from "./activity.js";
import { getNotificationConfig, getTimeZone } from "./settings.js";
import { getSiteById } from "./sites.js";
import { formatInZone } from "./time.js";
import { VERIFY_KINDS } from "./challenges.js";

const TIMEOUT_MS = 10_000;

const escSlack = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escHtml = escSlack;

/** Which channels are actually usable right now: turned on in Settings AND have credentials. */
export async function notificationsEnabled(siteId = null) {
  const n = await getNotificationConfig(siteId);
  return {
    slack: n.slack.enabled && !!n.slack.webhookUrl,
    telegram: n.telegram.enabled && !!(n.telegram.botToken && n.telegram.chatId),
  };
}

/** "example.com" for a registered domain, "" for the default settings. Added to messages so a shared channel shows where an event came from. */
const siteDomain = async (siteId) => (siteId ? (await getSiteById(siteId))?.domain || "" : "");
const tagged = (domain, text) => (domain ? `[${domain}] ${text}` : text);

/**
 * Sends a short text message to every enabled channel of this domain. Failures are logged, never thrown.
 * Resolves once every channel has answered (callers hand this to background() so it can finish after the response).
 */
async function broadcast(text, client, logType, details, siteId = null) {
  const n = await getNotificationConfig(siteId);
  const enabled = await notificationsEnabled(siteId);
  const message = tagged(await siteDomain(siteId), text);
  const jobs = [];
  if (enabled.slack) {
    jobs.push(
      postSlack(n.slack.webhookUrl, { text: message }).then(
        () => logEvent(logType, client, { siteId, details: { ...details, channel: "slack" } }),
        (err) => logEvent(`${logType}_failed`, client, { siteId, details: { ...details, channel: "slack", error: err.message } }),
      ),
    );
  }
  if (enabled.telegram) {
    jobs.push(
      postTelegramMessage(n.telegram, escHtml(message)).then(
        () => logEvent(logType, client, { siteId, details: { ...details, channel: "telegram" } }),
        (err) => logEvent(`${logType}_failed`, client, { siteId, details: { ...details, channel: "telegram", error: err.message } }),
      ),
    );
  }
  await Promise.all(jobs);
}

const clientLine = (client) =>
  `${client.country || "Unknown"} · ${client.browser || "-"} · ${client.platform || "-"}${client.isMobile ? " (mobile)" : ""} · IP ${client.ip || "-"}`;

/** A visitor loaded the apply page (there is no reliable server-side way to detect them leaving). */
export async function notifyVisit(client, siteId = null) {
  if (!(await getNotificationConfig(siteId)).events.visit) return;
  await broadcast(`A new visitor arrived at the apply page. ${clientLine(client)}`, client, "notify_visit", {}, siteId);
}

/** A visitor passed one human-verification step. */
export async function notifyVerifyStep(client, { stage, totalStages, kind, done }, siteId = null) {
  if (!(await getNotificationConfig(siteId)).events.verifyStep) return;
  const label = VERIFY_KINDS.find((k) => k.id === kind)?.label || kind;
  const text = done
    ? `Visitor passed the final verification step (${stage}/${totalStages}: ${label}) and is now verified. ${clientLine(client)}`
    : `Visitor passed verification step ${stage}/${totalStages} (${label}). ${clientLine(client)}`;
  await broadcast(text, client, "notify_verify_step", { stage, totalStages, kind, done }, siteId);
}

async function summary(app) {
  const tz = await getTimeZone(app.site_id);
  return [
    ["Time", `${formatInZone(app.created_at, tz)} (${tz})`],
    ["Domain", app.site_domain || "default"],
    ["Name", app.name],
    ["Email", app.email],
    ["Phone", app.phone || "-"],
    ["Role", `${app.role_title} at ${app.company_name}`],
    ["Hiring type", app.hiring_type || "-"],
    ["Working type", app.working_type || "-"],
    ["Source", app.source === "admin" ? `Admin (${app.submitted_by_email || "unknown"})` : "Website"],
    ["IP", app.ip || "-"],
    ["Country", app.country_name || "Unknown"],
    ["Browser", app.browser],
    ["Platform", `${app.platform} (${app.os})${app.is_mobile ? ", mobile" : ""}`],
    ["Resume", `${app.resume_name} (${Math.max(1, Math.round(app.resume_size / 1024))} KB)`],
    ["Photo", app.photo_file ? `${app.photo_name} (${Math.max(1, Math.round(app.photo_size / 1024))} KB)` : "Not provided"],
  ];
}

async function postSlack(webhookUrl, body) {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Slack responded ${res.status}`);
}

async function sendSlack(app) {
  const { webhookUrl } = (await getNotificationConfig(app.site_id)).slack;
  const lines = (await summary(app)).map(([k, v]) => `*${k}:* ${escSlack(v)}`);
  await postSlack(webhookUrl, {
    text: `New resume from ${app.name} for ${app.role_title}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "New resume submitted" } },
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `Open the <${config.publicBaseUrl}/admin/|admin UI> to download the resume (login required).` }],
      },
    ],
  });
}

async function postTelegramMessage(t, text) {
  const res = await fetch(`${t.apiBase}/bot${t.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: t.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json()).description || "";
    } catch {
      /* no body */
    }
    throw new Error(`Telegram sendMessage responded ${res.status}${detail ? `: ${detail}` : ""}`);
  }
}

async function sendTelegram(app) {
  const t = (await getNotificationConfig(app.site_id)).telegram;
  const text =
    "<b>New resume submitted</b>\n" +
    (await summary(app)).map(([k, v]) => `<b>${escHtml(k)}:</b> ${escHtml(v)}`).join("\n");
  await postTelegramMessage(t, text);

  if (t.sendFile) {
    const buf = await download("uploads", app.resume_file);
    const form = new FormData();
    form.append("chat_id", t.chatId);
    form.append("document", new Blob([buf]), app.resume_name);
    const doc = await fetch(`${t.apiBase}/bot${t.botToken}/sendDocument`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS * 3),
    });
    if (!doc.ok) throw new Error(`Telegram sendDocument responded ${doc.status}`);
  }
}

/**
 * Tells Slack and Telegram about a new application, using the credentials that are saved right now. A failing channel never
 * breaks the upload; the failure goes to the activity log. Resolves when both channels have answered -- hand it to
 * background() so it can finish after the response was sent.
 */
export async function notifyNewApplication(app, client) {
  const siteId = app.site_id ?? null;
  if (!(await getNotificationConfig(siteId)).events.application) return;
  const enabled = await notificationsEnabled(siteId);
  const jobs = [];
  if (enabled.slack) jobs.push(["slack", sendSlack]);
  if (enabled.telegram) jobs.push(["telegram", sendTelegram]);

  await Promise.all(
    jobs.map(([channel, send]) =>
      send(app).then(
        () => logEvent("notify_sent", client, { siteId, details: { channel, applicationId: app.id } }),
        (err) => {
          console.error(`[notify] ${channel} failed:`, err.message);
          return logEvent("notify_failed", client, { siteId, details: { channel, applicationId: app.id, error: err.message } });
        },
      ),
    ),
  );
}

/** Used by the Settings page "Send test" buttons. Resolves to { ok: true } or { ok: false, error }. */
export async function sendTestNotification(channel, siteId = null) {
  const n = await getNotificationConfig(siteId);
  const tz = await getTimeZone(siteId);
  const domain = await siteDomain(siteId);
  const where = domain ? ` for ${domain}` : "";
  const when = `${formatInZone(new Date().toISOString().slice(0, 19).replace("T", " "), tz)} (${tz})`;
  try {
    if (channel === "slack") {
      if (!n.slack.enabled) return { ok: false, error: "Slack notifications are switched off." };
      if (!n.slack.webhookUrl) return { ok: false, error: "No Slack webhook URL is set." };
      await postSlack(n.slack.webhookUrl, { text: `Test message from the Resume Portal admin${escSlack(where)}. Slack is connected. (${escSlack(when)})` });
    } else if (channel === "telegram") {
      if (!n.telegram.enabled) return { ok: false, error: "Telegram notifications are switched off." };
      if (!n.telegram.botToken || !n.telegram.chatId) return { ok: false, error: "Set both the bot token and the chat ID first." };
      await postTelegramMessage(n.telegram, `<b>Test message</b> from the Resume Portal admin${escHtml(where)}. Telegram is connected. (${escHtml(when)})`);
    } else {
      return { ok: false, error: "Unknown channel." };
    }
    return { ok: true };
  } catch (err) {
    // Telegram errors can echo the request URL, which contains the bot token
    const message = String(err.message || "Request failed").split(n.telegram.botToken || "\u0000").join("***");
    return { ok: false, error: message };
  }
}
