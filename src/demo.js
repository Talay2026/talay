// Demo requests from the homepage form: POST talay.io/api/demo
// Writes one row to the Airtable table "Demo requests" (base AIRTABLE_BASE, token AIRTABLE_TOKEN).
// Spam protection: hidden honeypot field, max 5 requests per hour per IP,
// and Cloudflare Turnstile as soon as the secret TURNSTILE_SECRET is set in Cloudflare.

const TABLE = "Demo requests";
const ROLES = ["Owner", "Manager", "Staff", "Other"];
const ALLOWED_ORIGINS = ["https://talay.io", "https://www.talay.io"];
const MAX_PER_HOUR = 5;

export async function handleDemo(request, env, ctx) {
  if (request.method !== "POST") return reply({ ok: false, error: "method" }, 405);

  const origin = request.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return reply({ ok: false, error: "origin" }, 403);
  if (!env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE) return reply({ ok: false, error: "config" }, 500);

  let data;
  try { data = await request.json(); } catch { return reply({ ok: false, error: "invalid" }, 400); }

  // Honeypot: people never see this field, bots fill it in. Pretend it worked.
  if (clean(data.website, 200)) return reply({ ok: true });

  const f = {
    name: clean(data.name, 100),
    centre: clean(data.centre, 120),
    location: clean(data.location, 120),
    email: clean(data.email, 160),
    whatsapp: clean(data.whatsapp, 40),
    role: clean(data.role, 20),
    message: clean(data.message, 2000, true),
  };
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email);
  const phoneOk = /^[+0-9 ()\-.]{6,40}$/.test(f.whatsapp);
  if (!f.name || !f.centre || !f.location || !emailOk || !phoneOk) {
    return reply({ ok: false, error: "fields" }, 400);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (await tooMany(ip, ctx)) return reply({ ok: false, error: "rate" }, 429);

  if (env.TURNSTILE_SECRET) {
    const token = clean(data.turnstile, 4096);
    if (!token) return reply({ ok: false, error: "check" }, 400);
    const body = new FormData();
    body.append("secret", env.TURNSTILE_SECRET);
    body.append("response", token);
    if (ip) body.append("remoteip", ip);
    const check = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const result = await check.json().catch(() => ({}));
    if (!result.success) return reply({ ok: false, error: "check" }, 400);
  }

  const fields = {
    "Name": f.name,
    "Dive centre": f.centre,
    "Location": f.location,
    "Email": f.email,
    "WhatsApp": f.whatsapp,
    "Message": f.message,
    "Status": "New",
  };
  if (ROLES.includes(f.role)) fields["Role"] = f.role;

  const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent(TABLE)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (!res.ok) {
    console.log("Demo request: Airtable error", res.status, await res.text());
    return reply({ ok: false, error: "save" }, 502);
  }
  return reply({ ok: true });
}

function clean(value, max, multiline = false) {
  let s = typeof value === "string" ? value : "";
  s = multiline ? s.replace(/\r/g, "") : s.replace(/[\r\n\t]+/g, " ");
  return s.trim().slice(0, max);
}

// Best-effort limit per IP, kept in the Cloudflare cache for one hour.
async function tooMany(ip, ctx) {
  if (!ip) return false;
  const cache = caches.default;
  const key = new Request(`https://talay.io/__ratelimit/demo/${encodeURIComponent(ip)}`);
  const hit = await cache.match(key);
  const count = hit ? parseInt(await hit.text(), 10) || 0 : 0;
  if (count >= MAX_PER_HOUR) return true;
  const put = cache.put(key, new Response(String(count + 1), { headers: { "Cache-Control": "max-age=3600" } }));
  if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
  return false;
}

function reply(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}
