// Builds the translated homepages public/fr/, de/, es/, nl/, th/, zh/, ru/, it/ and ko/ from public/index.html.
// Run after every change to the English homepage or to home.mjs: node tools/i18n/build.mjs
// The script stops with an error when an English piece is no longer found, so nothing goes out half translated.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import STRINGS from "./home.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LANGS = ["fr", "de", "es", "nl", "th", "zh", "ru", "it", "ko"];
// Thousands separator per language in the example prices (12,500 THB)
const SEP = { fr: " ", de: ".", es: ".", nl: ".", th: "," };
const THAI_FONT = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;500;600;700&display=swap" rel="stylesheet">';

const source = readFileSync(join(ROOT, "public/index.html"), "utf8");
// The <style> block holds the embedded fonts: never translate inside it
const styleStart = source.indexOf("<style>"), styleEnd = source.indexOf("</style>") + "</style>".length;

const longestFirst = [...STRINGS].sort((a, b) => b.en.length - a.en.length);
let failed = false;
for (const s of STRINGS) {
  for (const l of LANGS) {
    if (!s[l]) { console.error(`Missing ${l}: ${s.en}`); failed = true; }
    else if (!s.url && s[l].includes("'") && !(s.en.startsWith("'"))) { console.error(`Straight ' in ${l}: ${s[l]}`); failed = true; }
  }
  if (!source.includes(s.en)) { console.error(`Not found in index.html: ${s.en}`); failed = true; }
}
if (failed) process.exit(1);

function translate(part, l) {
  for (const s of longestFirst) {
    if (!s.en.length) continue;
    const to = s.url ? s.en.startsWith("?") ? "?subject=" + encodeURIComponent(s[l].slice(9)) : encodeURIComponent(s[l]) : s[l];
    part = part.split(s.en).join(to);
  }
  return part;
}

for (const l of LANGS) {
  let head = source.slice(0, styleStart), style = source.slice(styleStart, styleEnd), body = source.slice(styleEnd);
  head = translate(head, l)
    .replace('<html lang="en">', `<html lang="${l}">`)
    .replace('<link rel="canonical" href="https://talay.io/">', `<link rel="canonical" href="https://talay.io/${l}/">`)
    .replace('<meta property="og:url" content="https://talay.io/">', `<meta property="og:url" content="https://talay.io/${l}/">`);
  // The browser-language redirect only belongs on the English page
  head = head.replace(/<!-- i18n:redirect -->[\s\S]*?<!-- \/i18n:redirect -->\n?/, "");
  if (l === "th") head += THAI_FONT + "\n";
  body = translate(body, l)
    .replace('<option value="en" selected>', '<option value="en">')
    .replace(`<option value="${l}">`, `<option value="${l}" selected>`);
  // Example prices: 12,500 -> 12.500 (outside the script, which has no prices)
  const scriptAt = body.indexOf("<script>\n/* ---- Settings");
  body = body.slice(0, scriptAt).replace(/(\d),(\d{3})/g, `$1${SEP[l]}$2`) + body.slice(scriptAt);
  const out = join(ROOT, "public", l, "index.html");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, head + style + body);
  console.log(`public/${l}/index.html`);
}
