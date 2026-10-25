// Checks the translations of the intake form talay.io/start (public/start/i18n.js) against public/start/index.html.
// Run after every change to a text in the form: node tools/i18n/start-check.mjs
// Prints every text without a translation (all languages), a {placeholder} that is missing, or a straight " in a translation.
// With --keys it prints the English texts only.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(join(ROOT, "public/start/index.html"), "utf8");
const LANGS = ["es", "fr", "de", "nl", "th"];
// Texts that stay the same in every language
const SAME = new Set(["https://", "@yourcentre", "+66 81 234 5678", "Mia", "WhatsApp", "Instagram", "LINE", "Telegram", "SSI", "PADI", "RAID", "Logo", "Website"]);

const keys = new Set();
const add = (s) => { if (s && /[A-Za-z]/.test(s) && !SAME.has(s)) keys.add(s); };
const pick = (name) => { const m = html.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\n\\]);`)); return vm.runInNewContext(m[1]); };
for (const s of pick("SECTIONS")) {
  add(s.title); add(s.why);
  for (const f of s.fields || []) { add(f.sub); add(f.label); add(f.help); add(f.ph); (f.opts || []).forEach(add); }
}
for (const p of pick("PRODUCTS")) { add(p.name); add(p.dur); add(p.pre); }
const str = '"((?:[^"\\\\]|\\\\.)*)"';
for (const m of html.matchAll(new RegExp(`\\bL\\(${str}`, "g"))) add(JSON.parse(`"${m[1]}"`));
for (const m of html.matchAll(new RegExp(`(?:label|ph): ${str}`, "g"))) add(JSON.parse(`"${m[1]}"`));
for (const m of html.matchAll(/<(\w+)[^>]*\sdata-t[^>]*>([\s\S]*?)<\/\1>/g)) add(m[2].trim());
add(html.match(/<title>([^<]*)<\/title>/)[1]);
add(html.match(/<meta name="description" content="([^"]*)"/)[1]);

if (process.argv.includes("--keys")) { console.log(JSON.stringify([...keys], null, 1)); process.exit(0); }

const ctx = { window: {} };
vm.runInNewContext(readFileSync(join(ROOT, "public/start/i18n.js"), "utf8"), ctx);
const I18N = ctx.window.TALAY_START_I18N;
const holes = (x) => [...new Set(x.match(/\{\w+\}/g) || [])].sort().join();
let failed = false;
for (const k of keys) for (const l of LANGS) {
  const x = (I18N[l] || {})[k];
  if (!x) { console.error(`Missing ${l}: ${k}`); failed = true; continue; }
  if (x.includes('"') && !k.includes('"')) { console.error(`Straight " in ${l}: ${x}`); failed = true; }
  if (holes(x) !== holes(k)) { console.error(`Placeholders differ in ${l}: ${x}`); failed = true; }
}
if (failed) process.exit(1);
console.log(`OK: ${keys.size} texts in /start, translated in ${LANGS.join(", ")}.`);
