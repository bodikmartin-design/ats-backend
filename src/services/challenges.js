import crypto from "node:crypto";
import svgCaptcha from "svg-captcha";

const WORDS = [
  "garden", "planet", "silver", "bridge", "orange", "window", "forest",
  "coffee", "pocket", "island", "rocket", "yellow", "winter", "market",
  "candle", "meadow", "thunder", "pencil", "castle", "anchor", "violet", "harbor",
];
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

const pick = (arr) => arr[crypto.randomInt(arr.length)];
const between = (min, max) => crypto.randomInt(min, max + 1);

function randomCode(len) {
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return out;
}

/** Stage 1: number problem. The browser gets the question only. */
function math() {
  const op = pick(["+", "-", "×"]);
  let a;
  let b;
  let result;
  if (op === "+") {
    a = between(2, 30);
    b = between(2, 30);
    result = a + b;
  } else if (op === "-") {
    a = between(10, 40);
    b = between(1, a - 1);
    result = a - b;
  } else {
    a = between(2, 9);
    b = between(2, 9);
    result = a * b;
  }
  return {
    kind: "math",
    answer: String(result),
    caseSensitive: false,
    public: { kind: "math", prompt: `${a} ${op} ${b} = ?` },
  };
}

/** Stage 2: distorted word. The word is drawn as vector paths (no <text>), so it can't be read from the markup. */
function words() {
  const word = pick(WORDS);
  const svg = svgCaptcha(word, {
    width: 300,
    height: 90,
    fontSize: 58,
    noise: 4,
    color: true,
    background: "#fafbfd",
  });
  const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  return { kind: "words", answer: word, caseSensitive: false, public: { kind: "words", image } };
}

/**
 * Copy & paste guidance for the platform the request came from, so the instructions match what the visitor
 * actually sees on their screen. The
 * detected platform/browser label is never editable (it's data, not copy); the wording for each bucket is --
 * see getVerifyTexts() in settings.js, edited from Admin > Settings > Verification.
 */
function copyGuide(client, guides) {
  const family = (client?.osFamily || "").toLowerCase();
  const platform = [client?.browserName || client?.browser, client?.os].filter(Boolean).join(" on ") || "your device";
  const label = `${platform}${client?.isMobile ? " (mobile)" : ""}`;

  // The stage-3 guide tells the visitor how to open a terminal on their computer, so it follows the operating system:
  // macOS, Windows and Linux each have their own (editable in Admin > Settings > Verification). A phone or tablet has no
  // terminal to open, whatever it calls itself (an iPad in "desktop website" mode says it is a Mac), and Chrome OS and
  // anything unrecognised don't either: those get the generic copy-and-paste text.
  const touchDevice = client?.isMobile || family === "android" || family === "ios" || family === "windows phone";
  let guide;
  if (touchDevice) guide = guides.fallback;
  else if (family === "macos") guide = guides.mac;
  else if (family === "windows") guide = guides.win;
  else if (family === "linux") guide = guides.linux;
  else guide = guides.fallback;
  return { label, guide };
}

/**
 * Stage 3: text to copy and paste exactly (case sensitive). The public challenge also carries the detected
 * platform and a matching copy/paste guide, and this stage never expires (see assign() in verification.js) so a
 * visitor who steps away to paste elsewhere isn't timed out mid-step.
 */
function copy(client, texts) {
  const phrase = `${pick(WORDS)} ${randomCode(5)} ${pick(WORDS)} ${between(10, 99)}`;
  const { label, guide } = copyGuide(client, texts.copy.guides);
  return { kind: "copy", answer: phrase, caseSensitive: true, public: { kind: "copy", prompt: phrase, platform: label, guide } };
}

/** The checks a super admin can switch on. They always run in this order. */
export const VERIFY_KINDS = [
  { id: "math", label: "Number problem", help: "Solve a short sum." },
  { id: "words", label: "Word image", help: "Type the word shown in a distorted image." },
  { id: "copy", label: "Copy text", help: "Copy a text exactly as shown (case sensitive). Visitors get a Copy button and can paste." },
];

/** `texts`: the editable verification copy for this domain, from getVerifyTexts() in settings.js. */
export function createChallenge(kind, client, texts) {
  if (kind === "math") return math();
  if (kind === "words") return words();
  return copy(client, texts);
}

export function isCorrect(expected, caseSensitive, input) {
  if (typeof input !== "string" || input.length > 200) return false;
  let value = input.trim().replace(/\s+/g, " ");
  let target = expected;
  if (!caseSensitive) {
    value = value.toLowerCase();
    target = target.toLowerCase();
  }
  const a = Buffer.from(value);
  const b = Buffer.from(target);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
