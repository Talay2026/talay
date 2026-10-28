// Onboarding form for a new dive centre: POST talay.io/api/intake (page: public/start/index.html)
// Writes one row to the Airtable table "Intake" (base AIRTABLE_BASE, token AIRTABLE_TOKEN):
// Centre, Name, Email, WhatsApp, Status = New, Data (all answers as JSON) and Summary (readable text).
// Spam protection as in demo.js: honeypot, max 5 saved forms per hour per IP, Turnstile when TURNSTILE_SECRET is set.

const TABLE = "Intake";
const ALLOWED_ORIGINS = ["https://talay.io", "https://www.talay.io"];
const MAX_PER_HOUR = 5; // only saved forms count
const MAX_KEYS = 300;
const MAX_VALUE = 3000;

export async function handleIntake(request, env, ctx) {
  if (request.method !== "POST") return reply({ ok: false, error: "method" }, 405);

  const origin = request.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return reply({ ok: false, error: "origin" }, 403);
  if (!env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE) return reply({ ok: false, error: "config" }, 500);

  let data;
  try { data = await request.json(); } catch { return reply({ ok: false, error: "invalid" }, 400); }

  // Honeypot: people never see this field, bots fill it in. Pretend it worked.
  if (clean(data.website, 200)) return reply({ ok: true });

  // Keep only simple keys with a string or a short list of strings.
  const answers = {};
  const raw = data.answers && typeof data.answers === "object" ? data.answers : {};
  for (const [k, v] of Object.entries(raw).slice(0, MAX_KEYS)) {
    if (!/^[a-z0-9_]{1,60}$/i.test(k)) continue;
    if (Array.isArray(v)) answers[k] = v.slice(0, 20).map(x => clean(x, 300)).filter(Boolean);
    else answers[k] = clean(v, MAX_VALUE, true);
  }

  const centre = clean(answers.centre_name, 120);
  const name = clean(answers.contact_name, 100);
  const email = clean(answers.contact_email, 160);
  const whatsapp = clean(answers.contact_whatsapp, 40);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const phoneOk = /^[+0-9 ()\-.]{6,40}$/.test(whatsapp);
  if (!centre || !name || !emailOk || !phoneOk) return reply({ ok: false, error: "fields" }, 400);

  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (await tooMany(ip)) return reply({ ok: false, error: "rate" }, 429);

  const secret = String(env.TURNSTILE_SECRET || "").trim();
  if (secret) {
    const token = clean(data.turnstile, 4096);
    if (!token) return reply({ ok: false, error: "check", codes: ["no-token"] }, 400);
    const body = new FormData();
    body.append("secret", secret);
    body.append("response", token);
    if (ip) body.append("remoteip", ip);
    const check = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const result = await check.json().catch(() => ({}));
    if (!result.success) {
      console.log("Intake Turnstile failed:", JSON.stringify(result["error-codes"] || result));
      return reply({ ok: false, error: "check", codes: result["error-codes"] || [] }, 400);
    }
  }

  const fields = {
    "Centre": centre,
    "Name": name,
    "Email": email,
    "WhatsApp": whatsapp,
    "Status": "New",
    "Data": JSON.stringify({ form_version: Number(data.form_version) || 1, answers }, null, 1).slice(0, 99000),
    "Summary": summary(answers).slice(0, 99000),
  };

  const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent(TABLE)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (!res.ok) {
    console.log("Intake: Airtable error", res.status, await res.text());
    return reply({ ok: false, error: "save" }, 502);
  }
  await countRequest(ip, ctx);
  return reply({ ok: true });
}

// One line per answer that was filled in, products grouped, for reading in Airtable.
// Own products of the centre (p_X1_…, form version 3) also show where they belong on the booking page
// (group: New, Certified, Level up) and their description.
function summary(a) {
  const lines = [];
  const products = {};
  for (const [k, v] of Object.entries(a)) {
    const val = Array.isArray(v) ? v.join(", ") : v;
    const m = k.match(/^p_([A-Z0-9]+)_(.+)$/);
    if (m) { (products[m[1]] = products[m[1]] || {})[m[2]] = val; continue; }
    if (val) lines.push(`${k}: ${val}`);
  }
  lines.push("", "PRODUCTS");
  for (const [code, p] of Object.entries(products)) {
    if (!p.offer) { lines.push(`${code}: not offered`); continue; }
    const own = /^X\d+$/.test(code) ? ` (own product, for ${p.group || "-"}: ${p.description || "no description"})` : "";
    lines.push(`${code}${own}: ${p.name || "-"} · ${p.price || "?"} THB · ${p.duration || "-"} · check-in ${p.checkin || "-"} · online ${p.online ? "yes" : "no"} · min age ${p.min_age || "-"} · who ${p.requirements || "-"} · includes ${p.included || "-"} · not included ${p.not_included || "-"}`);
  }
  return lines.join("\n");
}

function clean(value, max, multiline = false) {
  let s = typeof value === "string" ? value : "";
  s = multiline ? s.replace(/\r/g, "") : s.replace(/[\r\n\t]+/g, " ");
  return s.trim().slice(0, max);
}

// Best-effort limit per IP, kept in the Cloudflare cache for one hour (same approach as demo.js).
const rlKey = (ip) => new Request(`https://talay.io/__ratelimit/intake1/${encodeURIComponent(ip)}`);

async function readCount(ip) {
  const hit = await caches.default.match(rlKey(ip));
  return hit ? parseInt(await hit.text(), 10) || 0 : 0;
}

async function tooMany(ip) {
  if (!ip) return false;
  return (await readCount(ip)) >= MAX_PER_HOUR;
}

async function countRequest(ip, ctx) {
  if (!ip) return;
  const next = (await readCount(ip)) + 1;
  const put = caches.default.put(rlKey(ip), new Response(String(next), { headers: { "Cache-Control": "max-age=3600" } }));
  if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
}

function reply(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
