/**
 * Theme presets, used by BOTH the candidate site and the admin UI so they share one set of colors.
 * Only the base colors are listed here. Hover, soft and focus colors are derived in CSS with color-mix().
 */
export const THEMES = {
  light: {
    label: "Light",
    vars: { bg: "#f3f5f9", card: "#ffffff", text: "#1c2333", muted: "#6b7489", border: "#d9deea", accent: "#3b6cf6", input: "#ffffff", ok: "#1f9d63", err: "#d63c4a", side: "#161b2b", sideText: "#cdd3e4", scheme: "light" },
  },
  dark: {
    label: "Dark",
    vars: { bg: "#0f1320", card: "#1a2033", text: "#e8ebf5", muted: "#9aa3bb", border: "#2c3550", accent: "#6b8cff", input: "#141a2b", ok: "#3ccf91", err: "#ff6b78", side: "#0a0d17", sideText: "#b9c0d6", scheme: "dark" },
  },
  midnight: {
    label: "Midnight",
    vars: { bg: "#0b1226", card: "#111b38", text: "#e6ecff", muted: "#8fa0cf", border: "#243257", accent: "#38bdf8", input: "#0d1630", ok: "#3ccf91", err: "#ff6b78", side: "#070c1b", sideText: "#aab8e0", scheme: "dark" },
  },
  ocean: {
    label: "Ocean",
    vars: { bg: "#e8f3fb", card: "#ffffff", text: "#0f2a3d", muted: "#58758a", border: "#c6dcec", accent: "#0a84c6", input: "#ffffff", ok: "#1f9d63", err: "#d63c4a", side: "#0b3a5a", sideText: "#c4dcee", scheme: "light" },
  },
  forest: {
    label: "Forest",
    vars: { bg: "#eef5ef", card: "#ffffff", text: "#17301f", muted: "#5a7561", border: "#cfe0d2", accent: "#2f8f4e", input: "#ffffff", ok: "#1f9d63", err: "#d63c4a", side: "#173a24", sideText: "#c6dccb", scheme: "light" },
  },
  violet: {
    label: "Violet",
    vars: { bg: "#f4f0fb", card: "#ffffff", text: "#241a3a", muted: "#756a92", border: "#dcd3ee", accent: "#7c4dff", input: "#ffffff", ok: "#1f9d63", err: "#d63c4a", side: "#2a1d4d", sideText: "#d3caec", scheme: "light" },
  },
  rose: {
    label: "Rose",
    vars: { bg: "#fbf0f3", card: "#ffffff", text: "#3a1a25", muted: "#8f6b78", border: "#efd3db", accent: "#e0426f", input: "#ffffff", ok: "#1f9d63", err: "#c93550", side: "#4a1d2c", sideText: "#efd0d9", scheme: "light" },
  },
};

export const DEFAULT_THEME = "light";
export const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Black or white, whichever is easier to read on top of this color (WCAG relative luminance). */
export function readableOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.4 ? "#111111" : "#ffffff";
}

/** CSS custom properties for a theme, with an optional custom accent color on top. */
export function themeVars(themeId, accent = "") {
  const t = (THEMES[themeId] || THEMES[DEFAULT_THEME]).vars;
  const a = HEX_RE.test(accent) ? accent.toLowerCase() : t.accent;
  return {
    "--bg": t.bg,
    "--card": t.card,
    "--text": t.text,
    "--muted": t.muted,
    "--border": t.border,
    "--accent": a,
    "--on-accent": readableOn(a),
    "--input-bg": t.input,
    "--ok": t.ok,
    "--err": t.err,
    "--side": t.side,
    "--side-text": t.sideText,
    "--scheme": t.scheme,
  };
}

/** What the admin UI needs to draw the theme picker and preview a theme before saving. */
export function themeCatalog() {
  return Object.entries(THEMES).map(([id, t]) => ({ id, label: t.label, vars: themeVars(id) }));
}
