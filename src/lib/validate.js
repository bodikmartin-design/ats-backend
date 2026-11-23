export const EMPLOYMENT_TYPES = ["Full-time", "Part-time", "Contract", "Internship", "Temporary"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Trim a string field and check its length. Returns [value, errorMessage|null]. */
export function text(value, label, { min = 0, max = 200, required = false } = {}) {
  const v = typeof value === "string" ? value.trim() : value == null ? "" : null;
  if (v === null) return ["", `${label} is invalid.`];
  if (required && v.length === 0) return ["", `${label} is required.`];
  if (v.length > 0 && v.length < min) return [v, `${label} must be at least ${min} characters.`];
  if (v.length > max) return [v, `${label} must be at most ${max} characters.`];
  return [v, null];
}

export function email(value, label = "Email", { required = true } = {}) {
  const [v, err] = text(value, label, { max: 254, required });
  if (err) return [v, err];
  if (v && !EMAIL_RE.test(v)) return [v, `${label} is not a valid email address.`];
  return [v, null];
}

export function url(value, label = "Website") {
  const [v, err] = text(value, label, { max: 300 });
  if (err || !v) return [v, err];
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
  } catch {
    return [v, `${label} must be a full http(s) URL.`];
  }
  return [v, null];
}

export function phone(value) {
  const [v, err] = text(value, "Phone", { max: 30 });
  if (err || !v) return [v, err];
  return /^[+()\d\s.-]{5,30}$/.test(v) ? [v, null] : [v, "Phone number looks invalid."];
}

export function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Runs several [value, error] checks and collects them. */
export function collect(checks) {
  const values = {};
  const errors = {};
  for (const [key, [value, err]] of Object.entries(checks)) {
    values[key] = value;
    if (err) errors[key] = err;
  }
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

/** Escape user input for a SQL LIKE pattern (used with ESCAPE '\'). */
export function likeTerm(term) {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

export function pageParams(query, maxSize = 100) {
  const page = Math.max(1, positiveInt(query.page) || 1);
  const pageSize = Math.min(maxSize, positiveInt(query.pageSize) || 25);
  return { page, pageSize, offset: (page - 1) * pageSize };
}
