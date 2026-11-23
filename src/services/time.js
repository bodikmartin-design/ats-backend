/**
 * Times are stored in the database as timestamptz (absolute moments). That stays correct even if the super admin
 * changes the time zone later. Everything people read (admin UI, Slack, Telegram) is converted to the configured zone.
 * These helpers accept a Date (what the database driver returns), an ISO string, or a "2026-10-13 14:05:09" UTC string.
 */

export function parseSqlUtc(value) {
  if (value instanceof Date) return value;
  const s = String(value);
  return new Date(/(?:z|[+-]\d\d(?::?\d\d)?)$/i.test(s) ? s.replace(" ", "T") : s.replace(" ", "T") + "Z");
}

export function toIso(sql) {
  const d = parseSqlUtc(sql);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** "2026-10-13 14:05:09" in the given zone. */
export function formatInZone(sql, tz) {
  if (!sql) return "";
  const d = parseSqlUtc(sql);
  if (Number.isNaN(d.getTime())) return String(sql);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: isValidTimeZone(tz) ? tz : "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export function listTimeZones() {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
}
