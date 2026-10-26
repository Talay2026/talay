// Checks the translations of the customer zone (src/zone-i18n.js) against the texts in src/zone.js.
// Run after every change to a text in the zone: node tools/i18n/zone-check.mjs
// Stops with an error when a text has no translation, a {placeholder} is missing, or a translation has a straight ".

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZONE_ROWS, ZONE_TH, ZONE_MORE } from "../../src/zone-i18n.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = readFileSync(join(ROOT, "src/zone.js"), "utf8");
const zone = src.slice(src.indexOf("function app(center")); // the zone page and its browser code (not Talay HQ)

const used = new Set();
const str = '"((?:[^"\\\\]|\\\\.)*)"';
for (const m of zone.matchAll(new RegExp(`\\b(?:t|T|tt|tr)\\(${str}`, "g"))) used.add(JSON.parse(`"${m[1]}"`));
for (const m of zone.matchAll(new RegExp(`\\btn\\([^"]*?,\\s*${str},\\s*${str}`, "g"))) { used.add(JSON.parse(`"${m[1]}"`)); used.add(JSON.parse(`"${m[2]}"`)); }

let failed = false;
const fail = (msg) => { console.error(msg); failed = true; };
const holes = (x) => [...new Set(x.match(/\{\w+\}/g) || [])].sort().join(); // the same {placeholder} may be used twice
const rows = new Map();
for (const r of ZONE_ROWS) {
  if (rows.has(r[0])) fail(`Twice: ${r[0]}`);
  rows.set(r[0], r);
  const want = holes(r[0]);
  ["es", "fr", "de", "nl"].forEach((l, i) => {
    const x = r[i + 1];
    if (!x) return fail(`Missing ${l}: ${r[0]}`);
    if (x.includes('"')) fail(`Straight " in ${l}: ${x}`);
    if (holes(x) !== want) fail(`Placeholders differ in ${l}: ${x}`);
  });
}
for (const [en, x] of Object.entries(ZONE_TH)) {
  if (!rows.has(en)) fail(`Thai for a text that has no row: ${en}`);
  if (x.includes('"')) fail(`Straight " in th: ${x}`);
  if (holes(x) !== holes(en)) fail(`Placeholders differ in th: ${x}`);
}
for (const k of rows.keys()) if (!ZONE_TH[k]) fail(`Missing th: ${k}`);
for (const [l, dict] of Object.entries(ZONE_MORE)) {
  for (const [en, x] of Object.entries(dict)) {
    if (!rows.has(en)) fail(`${l} for a text that has no row: ${en}`);
    if (x.includes('"')) fail(`Straight " in ${l}: ${x}`);
    if (holes(x) !== holes(en)) fail(`Placeholders differ in ${l}: ${x}`);
  }
  for (const k of rows.keys()) if (!dict[k]) fail(`Missing ${l}: ${k}`);
}
for (const k of used) if (!rows.has(k)) fail(`No translation: ${k}`);
if (failed) process.exit(1);
console.log(`OK: ${used.size} texts in the zone, ${rows.size} translated rows (es, fr, de, nl, th, ${Object.keys(ZONE_MORE).join(", ")}).`);
