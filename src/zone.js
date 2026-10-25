// Talay customer zone: talay.io/zone
// For dive center staff: the conversations they can still answer (WhatsApp allows
// free replies until 24 h after the diver's last message), the full chat, a reply
// box, and the results dashboard.
//
// Login: Cloudflare Access (email + one-time code) protects /zone. This file checks
// the Access token itself, so nothing is shown if Access is missing or misconfigured.
// Which center someone sees: Airtable Centers, field "Staff emails" (one or more
// email addresses, separated by commas or new lines).
//
// Needed in Cloudflare (Settings -> Variables and Secrets):
//   ACCESS_TEAM_DOMAIN  e.g. talay.cloudflareaccess.com
//   ACCESS_AUD          optional: the "Application Audience (AUD) Tag" of the Access app
//   RESPONDIO_TOKEN     respond.io Developer API token (secret)
//   AIRTABLE_TOKEN      needs data.records:read AND data.records:write on TALAY
//
// Airtable tables used:
//   Chat:    Text, Direction (Customer | Mia | Team), Contact ID, Center (slug), Sent at
//   Leads:   External ID (= respond.io Contact ID), Name, Language, Cert level, Status,
//            Handover at, Human took over, Human took over at, Opted out
//   Centers: Slug, Name, Assistant name, Staff emails, Logo

import { teamFor, whatsappTeam, template, WORDS } from "./notify.js";
import { ZONE_LANGS, ZONE_LOCALE, ZONE_TEXT, zoneLang, zoneT } from "./zone-i18n.js";

const WINDOW_H = 24; // WhatsApp customer service window
const splitEmails = (v) => String(v || "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
const okId = (v) => /^[A-Za-z0-9:_-]{1,64}$/.test(String(v || ""));
const first = (v) => (Array.isArray(v) ? v[0] : v);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const q = (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});

export async function handleZone(request, env, ctx) {
  const url = new URL(request.url);
  const asset = zoneAsset(url);
  if (asset) return asset;
  try {
    if (!env.ACCESS_TEAM_DOMAIN) {
      return text("The customer zone is not set up yet (Access settings missing).", 503);
    }
    const email = await accessEmail(request, env);
    if (!email) return text("Please sign in again: open talay.io/zone.", 401);

    const role = await hqRole(env, email); // Talay HQ: "owner", "staff" or null
    const superadmin = !!role;
    const p0 = url.pathname.replace(/\/+$/, "");
    if (p0 === "/zone/admin" || p0.startsWith("/zone/admin/")) {
      if (!superadmin) return html(noAccess(email), 403);
      return await handleAdmin(request, env, url, p0, email, role);
    }

    // Talay HQ sees every center in the zone, as an admin of each.
    const centers = superadmin ? await allCenters(env) : await centersFor(env, email);
    if (!centers.length) {
      return html(noAccess(email), 403);
    }
    const wanted = (url.searchParams.get("center") || "").toLowerCase();
    const center = centers.find((c) => c.slug === wanted) || centers[0];

    const p = url.pathname.replace(/\/+$/, "") || "/zone";
    if (p === "/zone") return html(app(center, centers, email, superadmin, zoneLang(request)));
    const fresh = url.searchParams.get("fresh") === "1";
    if (p === "/zone/api/conversations") {
      const view = url.searchParams.get("view") === "all" ? "all" : "open";
      return json(await cached(env, `conv/${center.slug}/${view}`, view === "all" ? 60 : 20,
        () => conversations(env, center, view), fresh));
    }
    if (p === "/zone/api/chat") {
      const id = url.searchParams.get("c");
      if (!okId(id)) return json({ error: "Unknown conversation" });
      return json(await cached(env, `chat/${center.slug}/${id}`, 20, async () => publicChat(await chat(env, center, id)), fresh));
    }
    if (p === "/zone/api/products") {
      const id = url.searchParams.get("c");
      if (!okId(id)) return json({ error: "Bad request" });
      return json(await cached(env, `prod/${center.slug}/${id}`, 300, () => products(env, center, id), fresh));
    }
    if (p === "/zone/api/bookings") return json(await cached(env, `book/${center.slug}`, 60, () => bookings(env, center), fresh));
    if (p === "/zone/api/dashboard") {
      const per = /^\d{4}-\d{2}$/.test(url.searchParams.get("period") || "") ? url.searchParams.get("period") : "";
      return json(await cached(env, `dash/v5/${center.slug}/${per || "30d"}`, 120, () => dashboard(env, center, per), fresh));
    }
    if (p === "/zone/api/arriving") return json(await cached(env, `arr/${center.slug}`, 300, () => arriving(env, center), fresh));
    if (p === "/zone/api/milestones") return json(await cached(env, `ms/${center.slug}`, 600, () => milestones(env, center), fresh));
    if (p === "/zone/api/daystats") return json(await cached(env, `day/${center.slug}`, 60, () => dayStats(env, center), fresh));
    if (p === "/zone/api/overnight") return json(await cached(env, `night/${center.slug}`, 120, () => overnight(env, center), fresh));
    if (p === "/zone/api/unfinished") return json(await cached(env, `unf/${center.slug}`, 180, () => unfinished(env, center), fresh));
    if (p === "/zone/api/tickets") return json(await cached(env, `tick/${center.slug}`, 30, () => tickets(env, center), fresh));
    if (p === "/zone/api/ticket" && request.method === "GET") return json(await ticketDetail(env, center, url.searchParams.get("id")));
    if (p === "/zone/api/ticket" && request.method === "POST") return await ticketAction(request, env, center, email, "create");
    if (p === "/zone/api/ticket-message" && request.method === "POST") return await ticketAction(request, env, center, email, "message");
    if (p === "/zone/api/ticket-approve" && request.method === "POST") return await ticketAction(request, env, center, email, "approve");
    if (p === "/zone/api/ticket-close" && request.method === "POST") return await ticketAction(request, env, center, email, "close");
    if (p === "/zone/api/settings" && request.method === "GET") return json(await settings(env, center));
    if (p === "/zone/api/settings" && request.method === "POST") return await saveSettings(request, env, center, email);
    if (p === "/zone/api/push-key") return json({ key: env.VAPID_PRIVATE ? await vapidPublic(env) : "" });
    if (p === "/zone/api/push-latest") {
      const d = await conversations(env, center, "open");
      const need = d.conversations.filter((c) => c.needsYou || c.waitingMin > 0);
      if (!need.length) return json({ title: "", body: "" });
      const c = need[0];
      return json({
        title: need.length > 1 ? `${need.length} divers need your team` : `${c.name || "A diver"} needs your team`,
        body: need.length > 1 ? `Latest: ${c.name || "a diver"}: “${String(c.preview || "").slice(0, 80)}”` : `“${String(c.preview || "").slice(0, 100)}”`,
      });
    }
    if (request.method === "POST") {
      if (p === "/zone/api/push-subscribe") return await pushSubscribe(request, env, center, email);
      if (p === "/zone/api/push-unsubscribe") return await pushUnsubscribe(request, env);
      if (p === "/zone/api/push-test") {
        const n = await pushToCenter(env, center.slug, email);
        return json(n ? { ok: true, sent: n } : { error: "This device isn't registered yet. Tap Turn on notifications first." }, n ? 200 : 400);
      }
      if (p === "/zone/api/reply") return await reply(request, env, center);
      if (p === "/zone/api/handback") return await leadAction(request, env, center, "handback");
      if (p === "/zone/api/handled") return await leadAction(request, env, center, "handled");
      if (p === "/zone/api/lead-team") return await leadTeam(request, env, center);
    }
    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error(err);
    if (url.pathname.startsWith("/zone/api/")) return json({ error: "Something went wrong. Try again." }, 502);
    return text("Something went wrong. Refresh the page.", 502);
  }
}


// ---------- App on the phone ----------
// Installable as an app (Add to Home Screen). These files are not sensitive, so they are
// served before the sign-in check (Cloudflare Access still protects /zone).
const ICONS = {"icon-192.png": "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", "icon-512.png": "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", "apple-touch-icon.png": "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"};
function b64bytes(b) { const s = atob(b); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
function zoneAsset(url) {
  const p = url.pathname;
  const name = p.slice("/zone/".length);
  if (ICONS[name]) {
    return new Response(b64bytes(ICONS[name]), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });
  }
  if (name === "manifest.webmanifest") {
    const n = (url.searchParams.get("n") || "Talay").replace(/[^\p{L}\p{N} .&'-]/gu, "").slice(0, 40) || "Talay";
    return new Response(JSON.stringify({
      name: n + " · Talay", short_name: n.length > 12 ? n.split(" ")[0] : n,
      start_url: "/zone", scope: "/zone", display: "standalone",
      background_color: "#0A2029", theme_color: "#0A2029",
      icons: [
        { src: "/zone/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
        { src: "/zone/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
      ],
    }), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" } });
  }
  if (name === "sw.js") {
    return new Response(SW, { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/zone" } });
  }
  return null;
}
// Network first; when the phone is offline, a page opened from the home screen shows a
// short message instead of a browser error. Nothing is stored offline.
const SW = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
// Push without payload: look up who needs the team, else show a general message.
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let title = "A diver needs your team", body = "Open Conversations → Needs you.";
    try {
      const r = await fetch("/zone/api/push-latest", { credentials: "same-origin", cache: "no-store" });
      if (r.ok) { const d = await r.json(); if (d.title) { title = d.title; body = d.body || body; } }
    } catch (err) {}
    await self.registration.showNotification(title, { body, icon: "/zone/icon-192.png", badge: "/zone/icon-192.png", tag: "talay-needs-you", renotify: true, data: { url: "/zone" } });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if (c.url.includes("/zone")) { await c.focus(); return; } }
    await self.clients.openWindow("/zone");
  })());
});
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0A2029;color:#F4F0E6;font-family:system-ui;text-align:center;padding:24px"><div><h1>No connection</h1><p>Check your internet and try again.</p><button onclick="location.reload()" style="font:inherit;font-weight:700;border:0;border-radius:999px;padding:12px 22px;background:#E8B04B;color:#0A2029">Try again</button></div>',
    { headers: { "Content-Type": "text/html; charset=utf-8" } })));
});`;

// ---------- Cloudflare Access ----------

async function accessEmail(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion") ||
    (request.headers.get("Cookie") || "").match(/CF_Authorization=([^;]+)/)?.[1];
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const dec = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));
  let header, payload;
  try { header = dec(parts[0]); payload = dec(parts[1]); } catch { return null; }

  const team = String(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  // ACCESS_AUD is optional: with it, only tokens for this one Access app count.
  // Without it, any valid token from the Talay team domain counts (signature and
  // issuer are always checked).
  if (env.ACCESS_AUD && !aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== `https://${team}`) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;

  const res = await fetch(`https://${team}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600 } });
  if (!res.ok) return null;
  const { keys = [] } = await res.json();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  return ok && payload.email ? String(payload.email).toLowerCase() : null;
}

function b64url(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

// ---------- Airtable ----------

async function at(env, table, { formula, fields, sort, max = 500 } = {}) {
  const out = [];
  let offset = "";
  do {
    const api = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}`);
    if (formula) api.searchParams.set("filterByFormula", formula);
    (fields || []).forEach((f) => api.searchParams.append("fields[]", f));
    (sort || []).forEach((s, i) => {
      api.searchParams.set(`sort[${i}][field]`, s.field);
      api.searchParams.set(`sort[${i}][direction]`, s.direction || "asc");
    });
    api.searchParams.set("pageSize", "100");
    if (offset) api.searchParams.set("offset", offset);
    let res = await fetch(api, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
    // Airtable allows 5 calls per second per base; the zone loads several panels at once.
    for (let i = 0; res.status === 429 && i < 2; i++) {
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
      res = await fetch(api, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
    }
    if (!res.ok) throw new Error(`Airtable ${table}: ${res.status} ${await res.text()}`);
    const body = await res.json();
    out.push(...(body.records || []));
    offset = body.offset || "";
  } while (offset && out.length < max);
  return out;
}

// Leads and Bookings → "Made at" (formula: IF({Seed at}, {Seed at}, CREATED_TIME())) is when a row
// counts as made, so demo rows can be dated in the past. Without that field: CREATED_TIME().
async function atMade(env, table, opts, build) {
  try {
    return await at(env, table, { ...opts, formula: build("{Made at}"), fields: opts.fields && [...opts.fields, "Made at"] });
  } catch (e) {
    if (!/: 422 /.test(String(e.message))) throw e;
    return at(env, table, { ...opts, formula: build("CREATED_TIME()") });
  }
}
const madeOf = (r) => String(first(r.fields["Made at"]) || r.createdTime);

// Photos and PDFs the team can send from a conversation (respond.io attachment type per content type).
const FILE_TYPES = { "image/jpeg": "image", "image/png": "image", "image/webp": "image", "application/pdf": "file" };
const FILE_MAX = 5 * 1024 * 1024; // Airtable's upload limit per file

// Airtable content API: puts a base64 file into an attachment field and returns its (temporary) URL.
async function uploadAttachment(env, table, recordId, field, contentType, base64, filename) {
  const res = await fetch(`https://content.airtable.com/v0/${env.AIRTABLE_BASE}/${recordId}/${encodeURIComponent(field)}/uploadAttachment`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ contentType, file: base64, filename }),
  });
  if (!res.ok) { console.error("Airtable upload", table, res.status, await res.text()); return ""; }
  const body = await res.json();
  const list = Object.values(body.fields || {}).find((v) => Array.isArray(v)) || [];
  return (list[list.length - 1] || {}).url || "";
}

async function atWrite(env, table, method, records) {
  const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}`, {
    method,
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records, typecast: true }),
  });
  if (!res.ok) throw new Error(`Airtable ${method} ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function centersFor(env, email) {
  const recs = await at(env, "Centers", {
    formula: `FIND('${q(email)}', LOWER({Staff emails}))`,
  });
  return recs
    .filter((r) => String(r.fields["Staff emails"] || "").toLowerCase()
      .split(/[\s,;]+/).includes(email))
    .map((r) => centerOut(r, splitEmails(r.fields["Admin emails"]).includes(email)))
    .filter((c) => /^[a-z0-9-]{1,60}$/.test(c.slug));
}
async function allCenters(env) {
  const recs = await at(env, "Centers", { sort: [{ field: "Name" }] });
  return recs.map((r) => centerOut(r, true)).filter((c) => /^[a-z0-9-]{1,60}$/.test(c.slug));
}
function centerOut(r, admin) {
  return {
    id: r.id,
    slug: String(first(r.fields["Slug"]) || "").toLowerCase(),
    name: first(r.fields["Name"]) || "Dive center",
    channel: Number(first(r.fields["Channel ID"])) || 0, // respond.io channel = this center's WhatsApp number
    assistant: first(r.fields["Assistant name"]) || "Mia",
    admin,
    logo: first(r.fields["Logo"])?.thumbnails?.large?.url || first(r.fields["Logo"])?.url || "",
    live: !!r.fields["Stripe live"], // Stripe live key for this center; otherwise the test key
  };
}

// Exact match on the linked Center: FIND on the name would also match "Simple Life Divers" for "Simple Life".
const ofCenter = (center) => `ARRAYJOIN({Center}) & '' = '${q(center.name)}'`;


// ---------- Cache ----------
// Airtable allows 100,000 API calls per month on the Team plan and 5 per second per base,
// and Make needs most of those. The zone therefore keeps short-lived copies in the
// Cloudflare cache, shared by everyone of the same center; own actions clear them.

const CACHE_HOST = "https://zone-cache.talay.internal/";
async function cached(env, key, ttl, fn, fresh = false) {
  const req = new Request(CACHE_HOST + env.AIRTABLE_BASE + "/" + key);
  const cache = caches.default;
  if (!fresh) {
    const hit = await cache.match(req);
    if (hit) return hit.json();
  }
  const value = await fn();
  await cache.put(req, new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` },
  }));
  return value;
}
async function forget(env, keys) {
  await Promise.all(keys.map((k) => caches.default.delete(new Request(CACHE_HOST + env.AIRTABLE_BASE + "/" + k))));
}
const forgetConversation = (env, center, id) => forget(env, [
  `conv/${center.slug}/open`, `conv/${center.slug}/all`, `chat/${center.slug}/${id}`, `lead/${center.slug}/${id}`,
]);

// ---------- API ----------

const DAY = 24 * 3600 * 1000;
const LANG_WORDS = { english: "en", dutch: "nl", nederlands: "nl", french: "fr", francais: "fr", "français": "fr",
  german: "de", deutsch: "de", spanish: "es", "español": "es", espanol: "es" };
function langCode(v) {
  const s = String(v || "").trim().toLowerCase();
  if (LANG_WORDS[s]) return LANG_WORDS[s];
  const two = s.slice(0, 2);
  return ["en", "fr", "de", "es", "nl"].includes(two) ? two : "en";
}

async function leadsFor(env, center, ids) {
  const map = {};
  // One respond.io contact can talk to several centers: a lead is contact + center.
  // Leads change rarely between messages: keep each one 5 minutes in the cache.
  const key = (id) => new Request(CACHE_HOST + env.AIRTABLE_BASE + "/lead/" + center.slug + "/" + id);
  // Each cache read and write is a subrequest (Workers cap them per request): with many contacts
  // (the "All" view) fetch straight from Airtable instead.
  if (ids.length > 15) return leadsFetch(env, center, ids);
  const missing = [];
  await Promise.all(ids.map(async (id) => {
    const hit = await caches.default.match(key(id));
    if (hit) { const r = await hit.json(); if (r) map[id] = r; } else missing.push(id);
  }));
  const fetched = await leadsFetch(env, center, missing);
  await Promise.all(missing.map((id) => caches.default.put(
    key(id),
    new Response(JSON.stringify(fetched[id] || null), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300" } }),
  )));
  return Object.assign(map, fetched);
}

async function leadsFetch(env, center, ids) {
  const map = {};
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40);
    const recs = await at(env, "Leads", {
      formula: `AND(${ofCenter(center)}, OR(${part.map((id) => `{External ID} & '' = '${q(id)}'`).join(",")}))`,
    });
    for (const r of recs) {
      const id = String(first(r.fields["External ID"]) || "");
      // Keep the most recently created lead per contact.
      if (!map[id] || Date.parse(r.createdTime) > Date.parse(map[id].createdTime)) map[id] = r;
    }
  }
  return map;
}

function leadInfo(r) {
  const f = r?.fields || {};
  const s = (k) => { const v = first(f[k]); return v == null ? "" : String(v); };
  return {
    name: s("Name"), language: s("Language"), cert: s("Cert level"), status: s("Status"),
    dates: s("Dates on island"), group: s("Group size"), interested: s("Interested in"), contact: s("Contact"),
    handoverAt: s("Handover at"), humanAt: s("Human took over at"),
    human: !!f["Human took over"], optedOut: !!f["Opted out"], channel: s("Channel"),
    note: s("Team note"), assigned: s("Assigned to").toLowerCase(),
  };
}

// One summary per contact, newest first. view "open" = customer wrote in the last
// 24 h (team can reply); view "all" = any message in the last 30 days.
async function conversations(env, center, view) {
  const days = view === "all" ? 30 : 1;
  const rows = await at(env, "Chat", {
    formula: `AND({Center} = '${q(center.slug)}', IS_AFTER({Sent at}, DATEADD(NOW(), -${days * 24}, 'hours')))`,
    fields: ["Text", "Direction", "Contact ID", "Sent at"],
    sort: [{ field: "Sent at", direction: "desc" }],
    max: 2000,
  });

  const byContact = new Map();
  for (const r of rows) {
    const id = String(r.fields["Contact ID"] || "");
    if (!okId(id)) continue;
    const dir = r.fields["Direction"] || "";
    const when = r.fields["Sent at"] || r.createdTime;
    if (!byContact.has(id)) byContact.set(id, { id, last: null, lastCustomer: null, ask: "", lastTeam: null, hay: "" });
    const c = byContact.get(id);
    if (!c.last) c.last = { text: r.fields["Text"] || "", dir, at: when };
    if (dir === "Customer" && !c.lastCustomer) { c.lastCustomer = when; c.ask = String(r.fields["Text"] || "").slice(0, 140); }
    if (dir === "Team" && !c.lastTeam) c.lastTeam = when;
    if (c.hay.length < 3000) c.hay += " " + String(r.fields["Text"] || "").toLowerCase();
  }

  let list = [...byContact.values()];
  if (view !== "all") list = list.filter((c) => c.lastCustomer);
  const leads = await leadsFor(env, center, list.map((c) => c.id));
  const now = Date.now();

  list = list.map((c) => {
    const lead = leadInfo(leads[c.id]);
    const closes = c.lastCustomer ? Date.parse(c.lastCustomer) + DAY : 0;
    const open = closes > now;
    const teamAt = Math.max(Date.parse(c.lastTeam || 0) || 0, Date.parse(lead.humanAt || 0) || 0);
    const handover = Date.parse(lead.handoverAt || 0) || 0;
    return {
      id: c.id, name: lead.name || lead.contact, language: lead.language, status: lead.status, assigned: lead.assigned,
      needsYou: open && handover > teamAt && !lead.optedOut,
      teamActive: lead.human, open,
      // Mia is paused, the diver wrote last and nobody answered for 15 minutes: nobody will unless the team looks.
      waitingMin: open && lead.human && !lead.optedOut && c.last.dir === "Customer" && Date.parse(c.last.at) < now - WAIT_MIN * 60000
        ? Math.round((now - Date.parse(c.last.at)) / 60000) : 0,
      preview: String(c.last.text).slice(0, 140), previewDir: c.last.dir, lastAt: c.last.at, ask: c.ask,
      cc: (countryOf(lead.contact) || [""])[0],
      closesAt: closes ? new Date(closes).toISOString() : null,
      hay: (lead.name.toLowerCase() + " " + c.hay).slice(0, 3000),
    };
  });
  const urgent = (c) => c.needsYou || c.waitingMin > 0;
  list.sort((a, b) => (urgent(b) - urgent(a)) || (Date.parse(b.lastAt) - Date.parse(a.lastAt)));
  return { conversations: list, needsCount: list.filter(urgent).length };
}

// Linked "Interested in" values come back as record ids (recXXXXXXXXXXXXXX): look up the product names.
async function productNames(env, ids) {
  const want = [...new Set(ids.filter((x) => /^rec[A-Za-z0-9]{14}$/.test(String(x || ""))))].slice(0, 50);
  if (!want.length) return {};
  const rows = await at(env, "Products", { formula: `OR(${want.map((id) => `RECORD_ID() = '${id}'`).join(",")})`, fields: ["Name"], max: 50 }).catch(() => []);
  const out = {};
  rows.forEach((r) => { out[r.id] = String(first(r.fields["Name"]) || ""); });
  return out;
}

async function chat(env, center, id) {
  if (!okId(id)) return { error: "Unknown conversation" };
  const opts = (fields) => ({
    formula: `AND({Center} = '${q(center.slug)}', {Contact ID} = '${q(id)}')`,
    fields, sort: [{ field: "Sent at", direction: "asc" }], max: 300,
  });
  // Chat → Attachment (attachment field): photos and files, sent from the zone or by the diver.
  const rows = await at(env, "Chat", opts(["Text", "Direction", "Sent at", "Attachment"])).catch((e) => {
    if (!/: 422 /.test(String(e.message))) throw e;
    return at(env, "Chat", opts(["Text", "Direction", "Sent at"]));
  });
  if (!rows.length) return { error: "Unknown conversation" };
  const leads = await leadsFor(env, center, [id]);
  const messages = rows.map((r) => ({
    text: r.fields["Text"] || "", dir: r.fields["Direction"] || "", at: r.fields["Sent at"] || r.createdTime,
    files: (r.fields["Attachment"] || []).map((a) => ({ url: a.url, name: a.filename || "", type: a.type || "", thumb: a.thumbnails?.large?.url || "" })),
  }));
  const lastCustomer = [...messages].reverse().find((m) => m.dir === "Customer");
  const lastTeam = [...messages].reverse().find((m) => m.dir === "Team");
  const closesAt = lastCustomer ? new Date(Date.parse(lastCustomer.at) + DAY).toISOString() : null;
  const canReply = !!closesAt && Date.parse(closesAt) > Date.now();
  const lead = leadInfo(leads[id]);
  if (/^rec[A-Za-z0-9]{14}$/.test(lead.interested)) lead.interested = (await productNames(env, [lead.interested]))[lead.interested] || "";
  const diverBookings = await (async () => {
    const c = String(lead.contact || "").trim();
    if (!/^\+?[0-9 ]{6,20}$/.test(c)) return [];
    const flat = c.replace(/\s+/g, "");
    const rows = await at(env, "Bookings", {
      formula: `AND(${ofCenter(center)}, OR({Payer phone} & '' = '${q(c)}', SUBSTITUTE({Payer phone} & '', ' ', '') = '${q(flat)}'))`,
      fields: ["Ref", "Activity date", "P name", "Group size", "Deposit paid THB", "Balance at shop", "Total value THB", "Status", "Refunded THB", "Manage token"],
      sort: [{ field: "Activity date", direction: "desc" }], max: 20,
    }).catch(() => []);
    const n = (v) => Number(first(v)) || 0;
    return rows.map((r) => {
      const f = r.fields, token = String(first(f["Manage token"]) || "");
      return {
        ref: first(f["Ref"]) || "", date: String(first(f["Activity date"]) || "").slice(0, 10), product: String(first(f["P name"]) || ""),
        divers: n(f["Group size"]) || 1, deposit: n(f["Deposit paid THB"]), balance: n(f["Balance at shop"]), total: n(f["Total value THB"]),
        refunded: n(f["Refunded THB"]), status: String(first(f["Status"]) || "Confirmed"),
        manage: /^[0-9a-fA-F-]{20,64}$/.test(token) ? `/b/manage?t=${token}` : "",
      };
    });
  })();
  const teamAt = Math.max(Date.parse(lastTeam?.at || 0) || 0, Date.parse(lead.humanAt || 0) || 0);
  const handover = Date.parse(lead.handoverAt || 0) || 0;
  return {
    id, lead, hasLead: !!leads[id], messages, closesAt, canReply,
    needsYou: canReply && handover > teamAt && !lead.optedOut,
    cc: (countryOf(lead.contact) || [""])[0],
    bookings: diverBookings,
    _leadRec: leads[id] || null,
  };
}

function publicChat(c) {
  const { _leadRec, ...rest } = c;
  return rest;
}

async function readBody(request) {
  try { return await request.json(); } catch { return null; }
}

async function reply(request, env, center) {
  if (!env.RESPONDIO_TOKEN) return json({ error: "Replies are not set up yet." }, 503);
  const body = await readBody(request);
  if (!body) return json({ error: "Bad request" }, 400);
  const id = String(body.c || "");
  const msg = String(body.text || "").trim().slice(0, 4000);
  const file = body.file && typeof body.file === "object" ? body.file : null;
  if (file) {
    if (!FILE_TYPES[file.type] || typeof file.data !== "string") return json({ error: "Send a photo (JPG, PNG, WEBP) or a PDF." }, 400);
    if (file.data.length > FILE_MAX * 4 / 3 + 8) return json({ error: "That file is too big (max 5 MB)." }, 400);
  }
  if (!okId(id) || (!msg && !file)) return json({ error: "Type a message first." }, 400);

  const c = await chat(env, center, id);
  if (c.error) return json({ error: c.error }, 404);
  if (!c.canReply) {
    return json({ error: "More than 24 hours since the diver's last message: WhatsApp, Instagram and Messenger no longer allow a free reply." }, 409);
  }

  const contact = id.includes(":") ? id : `id:${id}`;
  const channel = Number(first(c._leadRec?.fields?.["Lead channel ID"])) || center.channel;
  // Send on the channel the diver wrote on (WhatsApp, Instagram, Messenger), else this center's number;
  // without channelId respond.io uses the contact's last channel.
  const sendOne = async (message) => {
    const res = await fetch(`https://api.respond.io/v2/contact/${encodeURIComponent(contact)}/message`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESPONDIO_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...(channel ? { channelId: channel } : {}), message }),
    });
    if (!res.ok) console.error("respond.io", res.status, await res.text());
    return res.ok;
  };
  const notSent = () => json({ error: "The message was not accepted. Try again, or answer in respond.io." }, 502);

  const writes = [];
  if (file) {
    // The file goes into Chat → Attachment first: Airtable hosts it and gives respond.io a link to fetch.
    const name = String(file.name || "file").replace(/[^\w .()-]/g, "_").slice(0, 80) || "file";
    const rec = (await atWrite(env, "Chat", "POST", [{
      fields: { Text: msg || `📎 ${name}`, Direction: "Team", "Contact ID": id, Center: center.slug },
    }])).records[0];
    const url = await uploadAttachment(env, "Chat", rec.id, "Attachment", file.type, file.data, name);
    if (!url || !(await sendOne({ type: "attachment", attachment: { type: FILE_TYPES[file.type], url } })) || (msg && !(await sendOne({ type: "text", text: msg })))) {
      await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/Chat/${rec.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } }).catch(() => {});
      return url ? notSent() : json({ error: "Sending files is not set up yet: ask Talay to add the field Attachment to the table Chat." }, 503);
    }
  } else {
    if (!(await sendOne({ type: "text", text: msg }))) return notSent();
    writes.push(atWrite(env, "Chat", "POST", [{
      fields: { Text: msg, Direction: "Team", "Contact ID": id, Center: center.slug },
    }]));
  }

  const now = new Date().toISOString();
  if (c._leadRec) {
    // Same effect as a staff message in respond.io: Mia goes quiet until the team
    // hands back, Close in respond.io, or "release handovers" gives it back to her.
    writes.push(atWrite(env, "Leads", "PATCH", [{
      id: c._leadRec.id, fields: { "Human took over": true, "Human took over at": now },
    }]));
  }
  await Promise.all(writes);
  await forgetConversation(env, center, id);
  return json({ ok: true });
}

// "Let Mia take over again" and "Mark as handled". Both set Human took over at = now,
// which also clears "Needs you" and stops the handover reminder; hand back also
// switches Mia on again for this diver.
async function leadAction(request, env, center, action) {
  const body = await readBody(request);
  const id = String(body?.c || "");
  if (!okId(id)) return json({ error: "Bad request" }, 400);
  const c = await chat(env, center, id);
  if (c.error) return json({ error: c.error }, 404);
  if (!c._leadRec) return json({ error: "No lead found for this conversation." }, 404);
  const fields = { "Human took over at": new Date().toISOString() };
  if (action === "handback") fields["Human took over"] = false;
  await atWrite(env, "Leads", "PATCH", [{ id: c._leadRec.id, fields }]);
  await forgetConversation(env, center, id);
  return json({ ok: true });
}

// Team-only fields on the lead: Leads → Team note (long text) and Assigned to (an e-mail of this
// center's team, or empty). Divers never see them.
async function leadTeam(request, env, center) {
  const body = await readBody(request);
  const id = String(body?.c || "");
  if (!okId(id)) return json({ error: "Bad request" }, 400);
  const fields = {};
  if (typeof body.note === "string") fields["Team note"] = body.note.trim().slice(0, 2000);
  if (typeof body.assign === "string") {
    const who = body.assign.trim().toLowerCase();
    if (who) {
      const set = await settings(env, center);
      if (![...set.staff, ...set.admins].map((e) => e.toLowerCase()).includes(who)) return json({ error: "That person is not in your team." }, 400);
    }
    fields["Assigned to"] = who;
  }
  if (!Object.keys(fields).length) return json({ error: "Bad request" }, 400);
  const leads = await leadsFetch(env, center, [id]);
  if (!leads[id]) return json({ error: "No lead found for this conversation." }, 404);
  try {
    await atWrite(env, "Leads", "PATCH", [{ id: leads[id].id, fields }]);
  } catch (e) {
    if (/: 422 /.test(String(e.message))) return json({ error: "Notes and assigning are not set up yet: ask Talay to add the fields Team note and Assigned to in Leads." }, 503);
    throw e;
  }
  await forgetConversation(env, center, id);
  return json({ ok: true });
}

const LINK_TEXT = {
  en: (n, l) => `Here's the link to book ${n} 👇\n${l}`,
  nl: (n, l) => `Hier is de link om ${n} te boeken 👇\n${l}`,
  fr: (n, l) => `Voici le lien pour réserver ${n} 👇\n${l}`,
  de: (n, l) => `Hier ist der Link, um ${n} zu buchen 👇\n${l}`,
  es: (n, l) => `Aquí tienes el enlace para reservar ${n} 👇\n${l}`,
};

// Products of this center, each with a ready message (in the diver's language)
// containing the booking link, so the team can drop it into the reply box.
async function products(env, center, id) {
  if (!okId(id)) return { error: "Bad request" };
  const [recs, leads] = await Promise.all([
    at(env, "Products", { formula: `ARRAYJOIN({C slug}) & '' = '${q(center.slug)}'` }),
    leadsFor(env, center, [id]),
  ]);
  const f = leads[id]?.fields || {};
  const lang = langCode(first(f["Language"]));
  // Reuse the lead code the system already puts in this lead's booking link (c=...).
  const ref = String(first(f["Booking link"]) || "").match(/[?&]c=([A-Za-z0-9_-]{1,64})/)?.[1] || "";
  const list = recs.map((r) => {
    const p = r.fields;
    const code = String(first(p["Code"]) || "").toUpperCase();
    if (!/^[A-Z0-9]{1,12}$/.test(code) || !p["Active"]) return null;
    const name = (lang !== "en" && first(p[`Name ${lang.toUpperCase()}`])) || first(p["Name"]) || code;
    const link = `https://talay.io/b/${center.slug}?p=${code}${ref ? `&c=${ref}` : ""}&l=${lang}`;
    return { code, name: first(p["Name"]) || code, price: Number(first(p["Price THB"])) || 0,
      text: LINK_TEXT[lang](name, link) };
  }).filter(Boolean);
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { lang, products: list };
}


// ---------- Bookings ----------
// Airtable Bookings: Ref, Activity date, Product (link), Group size, Payer name, Payer phone,
// Total value THB, Deposit paid THB, Balance at shop, Status, Refunded THB, Manage token,
// Late change, Center (link, shows the center Name).

const thaiDate = (ms) => new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 10);

async function bookings(env, center) {
  const now = Date.now();
  const from = thaiDate(now - 31 * DAY), to = thaiDate(now + 91 * DAY);
  const recs = await at(env, "Bookings", {
    formula: `AND(${ofCenter(center)}, ` +
      `IS_AFTER({Activity date}, DATETIME_PARSE('${from}', 'YYYY-MM-DD')), ` +
      `IS_BEFORE({Activity date}, DATETIME_PARSE('${to}', 'YYYY-MM-DD')))`,
    fields: ["Ref", "Activity date", "P name", "Group size", "Payer name", "Payer phone", "Total value THB",
      "Deposit paid THB", "Balance at shop", "Status", "Refunded THB", "Manage token", "Late change"],
    sort: [{ field: "Activity date", direction: "asc" }],
    max: 1000,
  });

  // Link each booking to its WhatsApp conversation via the phone number.
  const phones = [...new Set(recs.map((r) => String(first(r.fields["Payer phone"]) || "")).filter((p) => /^\+?[0-9 ]{6,20}$/.test(p)))];
  const byPhone = {};
  for (let i = 0; i < phones.length; i += 40) {
    const part = phones.slice(i, i + 40);
    const leads = await at(env, "Leads", {
      formula: `AND(${ofCenter(center)}, OR(${part.map((p) => `{Contact} & '' = '${q(p)}'`).join(",")}))`,
      fields: ["Contact", "External ID"],
    });
    for (const l of leads) {
      const id = String(first(l.fields["External ID"]) || "");
      if (okId(id)) byPhone[String(first(l.fields["Contact"]) || "")] = id;
    }
  }

  const n = (v) => Number(first(v)) || 0;
  return {
    today: thaiDate(now), tomorrow: thaiDate(now + DAY),
    bookings: recs.map((r) => {
      const f = r.fields;
      const phone = String(first(f["Payer phone"]) || "");
      const token = String(first(f["Manage token"]) || "");
      return {
        ref: first(f["Ref"]) || "", date: first(f["Activity date"]) || "",
        product: String(first(f["P name"]) || ""), divers: n(f["Group size"]) || 1,
        name: first(f["Payer name"]) || "", phone,
        total: n(f["Total value THB"]), deposit: n(f["Deposit paid THB"]), balance: n(f["Balance at shop"]),
        refunded: n(f["Refunded THB"]), status: first(f["Status"]) || "", late: !!f["Late change"],
        manage: /^[0-9a-fA-F-]{20,64}$/.test(token) ? `/b/manage?t=${token}` : "",
        chat: byPhone[phone] || "",
      };
    }),
  };
}




// ---------- Dashboard ----------
// Leads fields used: Status, Response seconds, Outside hours (1/0), Handed over (1/0),
// Handover at, Follow-ups sent, Language, Center (link). Bookings: Total value THB,
// Deposit paid THB, Commission THB, Refunded THB, Status, Group size, P name, Ref,
// Activity date, Payer name. Periods follow Koh Tao time and the record's creation date.

function periodRange(period) {
  const TZ = 7 * 3600 * 1000;
  const nowThai = new Date(Date.now() + TZ);
  let start, end, label;
  const m = String(period || "").match(/^(\d{4})-(\d{2})$/);
  if (m) {
    start = Date.UTC(+m[1], +m[2] - 1, 1) - TZ;
    end = Date.UTC(+m[1], +m[2], 1) - TZ;
    label = new Date(Date.UTC(+m[1], +m[2] - 1, 15)).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  } else {
    end = Date.now();
    start = end - 30 * DAY;
    label = "Last 30 days";
  }
  const months = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(Date.UTC(nowThai.getUTCFullYear(), nowThai.getUTCMonth() - i, 15));
    months.push({ value: d.toISOString().slice(0, 7), label: d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }) });
  }
  return { start, end, label, months };
}

// Country from a phone number's dialling code (longest prefix wins). Flag drawn in the browser.
const DIAL = { "1": ["US", "USA / Canada"], "7": ["RU", "Russia / Kazakhstan"], "20": ["EG", "Egypt"], "27": ["ZA", "South Africa"], "30": ["GR", "Greece"], "31": ["NL", "Netherlands"], "32": ["BE", "Belgium"], "33": ["FR", "France"], "34": ["ES", "Spain"], "36": ["HU", "Hungary"], "39": ["IT", "Italy"], "40": ["RO", "Romania"], "41": ["CH", "Switzerland"], "43": ["AT", "Austria"], "44": ["GB", "United Kingdom"], "45": ["DK", "Denmark"], "46": ["SE", "Sweden"], "47": ["NO", "Norway"], "48": ["PL", "Poland"], "49": ["DE", "Germany"], "51": ["PE", "Peru"], "52": ["MX", "Mexico"], "54": ["AR", "Argentina"], "55": ["BR", "Brazil"], "56": ["CL", "Chile"], "57": ["CO", "Colombia"], "60": ["MY", "Malaysia"], "61": ["AU", "Australia"], "62": ["ID", "Indonesia"], "63": ["PH", "Philippines"], "64": ["NZ", "New Zealand"], "65": ["SG", "Singapore"], "66": ["TH", "Thailand"], "81": ["JP", "Japan"], "82": ["KR", "South Korea"], "84": ["VN", "Vietnam"], "86": ["CN", "China"], "90": ["TR", "Turkey"], "91": ["IN", "India"], "351": ["PT", "Portugal"], "352": ["LU", "Luxembourg"], "353": ["IE", "Ireland"], "354": ["IS", "Iceland"], "358": ["FI", "Finland"], "359": ["BG", "Bulgaria"], "370": ["LT", "Lithuania"], "371": ["LV", "Latvia"], "372": ["EE", "Estonia"], "380": ["UA", "Ukraine"], "381": ["RS", "Serbia"], "385": ["HR", "Croatia"], "386": ["SI", "Slovenia"], "420": ["CZ", "Czechia"], "421": ["SK", "Slovakia"], "852": ["HK", "Hong Kong"], "886": ["TW", "Taiwan"], "971": ["AE", "UAE"], "972": ["IL", "Israel"] };
function countryOf(phone) {
  let d = String(phone || "").replace(/[^\d+]/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2); else if (d.startsWith("+")) d = d.slice(1); else if (d.startsWith("0")) return null;
  for (const len of [3, 2, 1]) { const c = DIAL[d.slice(0, len)]; if (c) return c; }
  return null;
}

// Same rule as the booking page: "Stripe live" in Centers and a live key set, otherwise the test key.
const stripeKeyOf = (env, center) => (center.live && env.STRIPE_LIVE_KEY ? env.STRIPE_LIVE_KEY : env.STRIPE_SECRET_KEY) || "";

// Stripe Checkout sessions created between start and end (ms), newest first, at most 500.
async function checkoutSessions(env, center, start, end) {
  const key = stripeKeyOf(env, center);
  if (!key) return [];
  const out = [];
  let after = "";
  for (let page = 0; page < 5; page++) {
    const u = new URL("https://api.stripe.com/v1/checkout/sessions");
    u.searchParams.set("limit", "100");
    u.searchParams.set("created[gte]", String(Math.floor(start / 1000)));
    u.searchParams.set("created[lt]", String(Math.floor(end / 1000)));
    if (after) u.searchParams.set("starting_after", after);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`Stripe: ${res.status}`);
    const body = await res.json();
    out.push(...(body.data || []));
    if (!body.has_more || !body.data?.length) break;
    after = body.data[body.data.length - 1].id;
  }
  return out;
}

async function dashboard(env, center, period) {
  const { start, end, label, months } = periodRange(period);
  const iso = (ms) => new Date(ms).toISOString();
  const inPeriod = (m) => `IS_AFTER(${m}, DATETIME_PARSE('${iso(start - 1000)}')), IS_BEFORE(${m}, DATETIME_PARSE('${iso(end)}'))`;
  const [leads, books, linkMsgs, sessions] = await Promise.all([
    atMade(env, "Leads", { max: 5000 }, (m) => `AND(${ofCenter(center)}, ${inPeriod(m)})`),
    atMade(env, "Bookings", { max: 5000 }, (m) => `AND(${ofCenter(center)}, ${inPeriod(m)})`),
    at(env, "Chat", {
      formula: `AND({Center} = '${q(center.slug)}', FIND('talay.io/b/', {Text}), {Direction} != 'Customer', IS_AFTER({Sent at}, DATETIME_PARSE('${iso(start - 1000)}')), IS_BEFORE({Sent at}, DATETIME_PARSE('${iso(end)}')))`,
      fields: ["Contact ID"], max: 5000,
    }).catch(() => []),
    checkoutSessions(env, center, start, end).catch(() => []),
  ]);
  const n = (v) => Number(first(v)) || 0;
  const cx = (b) => /cancel|refund/i.test(String(first(b.fields["Status"]) || ""));
  const live = books.filter((b) => !cx(b));

  const resp = leads.map((l) => n(l.fields["Response seconds"])).filter((x) => x > 0 && x < 3600);
  const booked = leads.filter((l) => /booked/i.test(String(first(l.fields["Status"]) || "")));
  const langs = {}, prods = {};
  leads.forEach((l) => { const k = String(first(l.fields["Language"]) || "?").toUpperCase(); langs[k] = (langs[k] || 0) + 1; });
  live.forEach((b) => {
    const k = String(first(b.fields["P name"]) || "Other");
    prods[k] = prods[k] || { bookings: 0, divers: 0, value: 0 };
    prods[k].bookings++; prods[k].divers += n(b.fields["Group size"]) || 1; prods[k].value += n(b.fields["Total value THB"]);
  });

  // Weekly series (Monday-based weeks, Koh Tao time).
  const TZ = 7 * 3600 * 1000;
  const weekKey = (ms) => { const d = new Date(ms + TZ); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); };
  const weeks = {};
  for (let t = start; t < end; t += DAY) weeks[weekKey(t)] = { week: weekKey(t), conversations: 0, bookings: 0 };
  leads.forEach((l) => { const k = weekKey(Date.parse(madeOf(l))); if (weeks[k]) weeks[k].conversations++; });
  live.forEach((b) => { const k = weekKey(Date.parse(madeOf(b))); if (weeks[k]) weeks[k].bookings++; });

  const sum = (arr, k) => arr.reduce((a, b) => a + n(b.fields[k]), 0);
  const statement = books.map((b) => {
    const f = b.fields;
    return {
      ref: first(f["Ref"]) || "", created: madeOf(b), date: first(f["Activity date"]) || "",
      product: String(first(f["P name"]) || ""), name: first(f["Payer name"]) || "",
      divers: n(f["Group size"]) || 1, total: n(f["Total value THB"]), commission: n(f["Commission THB"]) || n(f["Deposit paid THB"]),
      refunded: n(f["Refunded THB"]), status: first(f["Status"]) || "Confirmed", cancelled: cx(b),
    };
  }).sort((a, b) => a.created.localeCompare(b.created));

  return {
    label, months, period: period || "30d", center: center.name,
    kpiPrev: await (async () => {
      try {
        const len = end - start, ps = start - len, pe = start;
        const inPrev = (m) => `IS_AFTER(${m}, DATETIME_PARSE('${iso(ps - 1000)}')), IS_BEFORE(${m}, DATETIME_PARSE('${iso(pe)}'))`;
        const [pl, pb] = await Promise.all([
          atMade(env, "Leads", { fields: ["Status", "Response seconds", "Outside hours"], max: 5000 }, (m) => `AND(${ofCenter(center)}, ${inPrev(m)})`),
          atMade(env, "Bookings", { fields: ["Status", "Group size", "Total value THB", "Balance at shop"], max: 5000 }, (m) => `AND(${ofCenter(center)}, ${inPrev(m)})`),
        ]);
        const pLive = pb.filter((b) => !cx(b));
        const pResp = pl.map((l) => n(l.fields["Response seconds"])).filter((x) => x > 0 && x < 3600);
        const pBooked = pl.filter((l) => /booked/i.test(String(first(l.fields["Status"]) || "")));
        return {
          conversations: pl.length,
          bookings: pLive.length,
          divers: pLive.reduce((a, b) => a + (n(b.fields["Group size"]) || 1), 0),
          revenue: pLive.reduce((a, b) => a + n(b.fields["Total value THB"]), 0),
          atShop: pLive.reduce((a, b) => a + n(b.fields["Balance at shop"]), 0),
          conversion: pl.length ? Math.round((pBooked.length / pl.length) * 1000) / 10 : 0,
          avgResponse: pResp.length ? Math.round(pResp.reduce((a, b) => a + b, 0) / pResp.length) : null,
        };
      } catch (e) { return null; }
    })(),
    kpi: {
      conversations: leads.length,
      outsideHours: sum(leads, "Outside hours"),
      handedOver: leads.filter((l) => n(l.fields["Handed over"]) || first(l.fields["Handover at"])).length,
      avgResponse: resp.length ? Math.round(resp.reduce((a, b) => a + b, 0) / resp.length) : null,
      bookings: live.length,
      divers: live.reduce((a, b) => a + (n(b.fields["Group size"]) || 1), 0),
      conversion: leads.length ? Math.round((booked.length / leads.length) * 1000) / 10 : 0,
      afterFollowUp: booked.filter((l) => n(l.fields["Follow-ups sent"]) > 0).length,
      revenue: sum(live, "Total value THB"),
      atShop: live.reduce((a, b) => a + n(b.fields["Balance at shop"]), 0),
      commission: statement.reduce((a, r) => a + r.commission, 0),
      refunded: statement.reduce((a, r) => a + r.refunded, 0),
    },
    funnel: (() => {
      const mine = sessions.filter((s) => (s.metadata || {}).center_slug === center.slug);
      const opened = new Set(mine.map((s) => (s.metadata || {}).lead_ref || s.id)).size;
      const links = new Set(linkMsgs.map((m) => String(m.fields["Contact ID"] || "")).filter(Boolean)).size;
      // Links and payment pages in this period can belong to divers who first wrote earlier, so keep
      // every step a subset of the one before: the funnel never goes above 100%.
      const booked = live.length, open = Math.max(opened, booked);
      const link = Math.max(Math.min(links, leads.length), open);
      return { conversations: Math.max(leads.length, link), linkSent: link, opened: open, booked };
    })(),
    languages: Object.entries(langs).sort((a, b) => b[1] - a[1]),
    heat: (() => {
      const h = Array.from({ length: 7 }, () => Array(24).fill(0));
      leads.forEach((l) => { const d = new Date(Date.parse(madeOf(l)) + 7 * 3600 * 1000); h[(d.getUTCDay() + 6) % 7][d.getUTCHours()]++; });
      return h;
    })(),
    countries: (() => {
      const c = {};
      leads.forEach((l) => { const k = countryOf(first(l.fields["Contact"])); if (k) { c[k[0]] = c[k[0]] || [k[0], k[1], 0]; c[k[0]][2]++; } });
      return Object.values(c).sort((a, b) => b[2] - a[2]).slice(0, 8);
    })(),
    products: Object.entries(prods).sort((a, b) => b[1].value - a[1].value),
    weeks: Object.values(weeks),
    statement,
  };
}

// ---------- Arriving soon, not booked yet ----------
// Divers who told the assistant when they are on the island, haven't booked and arrive within
// 14 days (or are on the island now). Dates come from Leads → "Arrival date" (a date field, if
// it exists) or are read from the free text in "Dates on island" ("18–24 Nov", "Nov 18-24",
// "18/11 - 2/12", "2026-11-18"). Text it can't read is skipped.
const MONTHS = { jan: 1, feb: 2, fev: 2, "fév": 2, mar: 3, mrt: 3, "mär": 3, maa: 3, apr: 4, avr: 4, abr: 4, may: 5, mai: 5, mei: 5, jun: 6, jui: 7, jul: 7, aug: 8, aou: 8, "aoû": 8, ago: 8, sep: 9, okt: 10, oct: 10, nov: 11, dec: 12, dez: 12, "déc": 12, dic: 12, ene: 1, juin: 6, juil: 7 };
function monthOf(w) {
  w = String(w || "").toLowerCase().replace(/\./g, "");
  if (w.startsWith("juin") || w.startsWith("juni") || w === "june") return 6;
  if (w.startsWith("juil") || w.startsWith("juli") || w === "july") return 7;
  const k = w.slice(0, 3);
  return MONTHS[k] || null;
}
function parseStay(text, createdMs) {
  const s = String(text || "").toLowerCase();
  if (!s) return null;
  const pts = [];
  const created = new Date(createdMs + 7 * 3600 * 1000);
  const push = (y, m, d) => { if (m >= 1 && m <= 12 && d >= 1 && d <= 31) pts.push([y, m, d]); };
  let r;
  const iso = /(\d{4})-(\d{2})-(\d{2})/g;
  while ((r = iso.exec(s))) push(+r[1], +r[2], +r[3]);
  if (!pts.length) {
    const w = "([a-zà-ÿ]{3,9})\\.?";
    const range1 = new RegExp("(\\d{1,2})\\s*(?:st|nd|rd|th|e|er)?\\s*(?:-|–|—|to|tot|bis|au|al|until|till)\\s*(\\d{1,2})\\s*(?:st|nd|rd|th|e|er)?\\s+(?:of\\s+)?" + w, "g");
    const range2 = new RegExp(w + "\\s*(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s*(?:-|–|—|to|until)\\s*(\\d{1,2})(?!\\s*[a-z/.])", "g");
    const dm = new RegExp("(\\d{1,2})\\s*(?:st|nd|rd|th|e|er)?\\s+(?:of\\s+)?" + w, "g");
    const md = new RegExp(w + "\\s*(\\d{1,2})(?!\\d)", "g");
    let m1 = range1.exec(s), m2 = range2.exec(s);
    if (m1 && monthOf(m1[3])) { push(0, monthOf(m1[3]), +m1[1]); push(0, monthOf(m1[3]), +m1[2]); }
    else if (m2 && monthOf(m2[1])) { push(0, monthOf(m2[1]), +m2[2]); push(0, monthOf(m2[1]), +m2[3]); }
    else {
      const found = [];
      while ((r = dm.exec(s))) if (monthOf(r[2])) found.push([r.index, monthOf(r[2]), +r[1]]);
      while ((r = md.exec(s))) if (monthOf(r[1])) found.push([r.index, monthOf(r[1]), +r[2]]);
      found.sort((a, b) => a[0] - b[0]).forEach((f) => push(0, f[1], f[2]));
      if (!found.length) {
        const num = /(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/g;
        while ((r = num.exec(s))) push(r[3] ? (+r[3] < 100 ? 2000 + +r[3] : +r[3]) : 0, +r[2], +r[1]);
      }
    }
  }
  if (!pts.length) return null;
  const toIso = ([y, m, d]) => {
    let yr = y || created.getUTCFullYear();
    let dt = Date.UTC(yr, m - 1, d);
    if (!y && dt < createdMs - 10 * DAY) dt = Date.UTC(yr + 1, m - 1, d);
    return new Date(dt).toISOString().slice(0, 10);
  };
  const from = toIso(pts[0]);
  let to = pts.length > 1 ? toIso(pts[pts.length - 1]) : "";
  if (!to || to < from) { const d = new Date(from + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 5); to = d.toISOString().slice(0, 10); }
  return [from, to];
}
async function arriving(env, center) {
  const leads = await atMade(env, "Leads", { max: 3000 }, (m) => `AND(${ofCenter(center)}, IS_AFTER(${m}, DATEADD(NOW(), -60, 'days')))`);
  const today = thaiDate(Date.now());
  const limit = thaiDate(Date.now() + 14 * DAY);
  const s = (f, k) => { const v = first(f[k]); return v == null ? "" : String(v); };
  const items = [];
  for (const r of leads) {
    const f = r.fields;
    if (/booked|lost|closed|spam/i.test(s(f, "Status")) || f["Opted out"]) continue;
    const text = s(f, "Dates on island");
    const range = parseStay(s(f, "Arrival date") || text, Date.parse(madeOf(r)));
    if (!range) continue;
    const [from, to] = range;
    if (to < today || from > limit) continue;
    const chat = s(f, "External ID");
    const last = Date.parse(s(f, "Last message at") || 0) || 0;
    items.push({
      name: s(f, "Name"), phone: s(f, "Contact"), language: s(f, "Language") ? langCode(s(f, "Language")) : "", cert: s(f, "Cert level"),
      group: s(f, "Group size"), interested: s(f, "Interested in"), dates: text, from, to, here: from <= today,
      chat: okId(chat) ? chat : "", canMessage: last > 0 && Date.now() - last < DAY,
    });
  }
  const names = await productNames(env, items.map((i) => i.interested));
  items.forEach((i) => { if (names[i.interested] !== undefined) i.interested = names[i.interested]; else if (/^rec[A-Za-z0-9]{14}$/.test(i.interested)) i.interested = ""; });
  items.sort((a, b) => a.from.localeCompare(b.from));
  return { today, items };
}

// ---------- Milestones ----------
// All-time totals through Talay and the milestones they crossed (with the day they were reached),
// plus progress towards the next one.
const MS_STEPS = {
  divers: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  revenue: [50000, 100000, 250000, 500000, 1000000, 2500000, 5000000],
  conversations: [100, 250, 500, 1000, 2500, 5000, 10000],
};
async function milestones(env, center) {
  const [books, leads] = await Promise.all([
    atMade(env, "Bookings", { fields: ["Group size", "Total value THB", "Status"], max: 10000 }, () => ofCenter(center)),
    atMade(env, "Leads", { fields: ["Status"], max: 20000 }, () => ofCenter(center)),
  ]);
  const n = (v) => Number(first(v)) || 0;
  const live = books.filter((b) => !/cancel|refund/i.test(String(first(b.fields["Status"]) || "")))
    .sort((a, b) => madeOf(a).localeCompare(madeOf(b)));
  const series = {
    divers: live.map((b) => [madeOf(b), n(b.fields["Group size"]) || 1]),
    revenue: live.map((b) => [madeOf(b), n(b.fields["Total value THB"])]),
    conversations: [...leads].sort((a, b) => madeOf(a).localeCompare(madeOf(b))).map((l) => [madeOf(l), 1]),
  };
  const out = {};
  for (const [k, rows] of Object.entries(series)) {
    let sum = 0, reached = null;
    const steps = MS_STEPS[k];
    let si = 0;
    for (const [when, v] of rows) {
      sum += v;
      while (si < steps.length && sum >= steps[si]) { reached = { value: steps[si], at: when }; si++; }
    }
    out[k] = { total: sum, reached, next: steps[si] || null };
  }
  return out;
}

// ---------- Push notifications ("Needs you") ----------
// Web push without payload: the phone's service worker asks /zone/api/push-latest what to show.
// Secrets: VAPID_PRIVATE = a P-256 private key in PKCS8 PEM (openssl), PUSH_KEY = key for Make.
// Airtable table "Push subscriptions": Endpoint (primary), Center (text), Email (text).
// Make calls  GET talay.io/api/push?key=PUSH_KEY&center=<slug>  when a conversation is handed over.
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function vapidKey(env) {
  const pem = String(env.VAPID_PRIVATE || "").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
}
async function vapidPublic(env) {
  const jwk = await crypto.subtle.exportKey("jwk", await vapidKey(env));
  const x = fromB64u(jwk.x), y = fromB64u(jwk.y);
  const raw = new Uint8Array(65); raw[0] = 4; raw.set(x, 1); raw.set(y, 33);
  return b64u(raw);
}
async function vapidAuth(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const enc = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ typ: "JWT", alg: "ES256" });
  const body = enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:info@talay.io" });
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await vapidKey(env), new TextEncoder().encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${await vapidPublic(env)}`;
}
const okEndpoint = (u) => { try { const x = new URL(u); return x.protocol === "https:" && u.length < 1000; } catch { return false; } };
async function pushSubscribe(request, env, center, email) {
  const b = await readBody(request);
  const endpoint = String(b?.endpoint || "");
  if (!okEndpoint(endpoint)) return json({ error: "Bad subscription" }, 400);
  const found = await at(env, "Push subscriptions", { formula: `{Endpoint} = '${q(endpoint)}'`, max: 1 });
  const fields = { "Endpoint": endpoint, "Center": center.slug, "Email": email };
  if (found.length) await atWrite(env, "Push subscriptions", "PATCH", [{ id: found[0].id, fields }]);
  else await atWrite(env, "Push subscriptions", "POST", [{ fields }]);
  return json({ ok: true });
}
async function pushUnsubscribe(request, env) {
  const b = await readBody(request);
  const endpoint = String(b?.endpoint || "");
  if (!okEndpoint(endpoint)) return json({ ok: true });
  const found = await at(env, "Push subscriptions", { formula: `{Endpoint} = '${q(endpoint)}'`, max: 5 });
  if (found.length) await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/Push%20subscriptions?${found.map((r) => "records[]=" + r.id).join("&")}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  return json({ ok: true });
}
export async function pushToCenter(env, slug, onlyEmail) {
  if (!env.VAPID_PRIVATE) return 0;
  let formula = `{Center} = '${q(slug)}'`;
  if (onlyEmail) formula = `AND(${formula}, LOWER({Email}) = '${q(onlyEmail.toLowerCase())}')`;
  const subs = await at(env, "Push subscriptions", { formula, max: 200 });
  let sent = 0;
  const gone = [];
  await Promise.all(subs.map(async (r) => {
    const endpoint = String(r.fields["Endpoint"] || "");
    if (!okEndpoint(endpoint)) return;
    const res = await fetch(endpoint, { method: "POST", headers: { TTL: "3600", Urgency: "high", Authorization: await vapidAuth(env, endpoint), "Content-Length": "0" } });
    if (res.status === 404 || res.status === 410) gone.push(r.id);
    else if (res.ok) sent++;
    else console.log("Push failed", res.status, await res.text());
  }));
  if (gone.length) await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/Push%20subscriptions?${gone.slice(0, 10).map((id) => "records[]=" + id).join("&")}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  return sent;
}
// For Make: GET talay.io/api/push?key=PUSH_KEY&center=<slug>
export async function handlePush(request, env, ctx) {
  const url = new URL(request.url);
  const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (!env.PUSH_KEY || url.searchParams.get("key") !== env.PUSH_KEY) return out({ error: "forbidden" }, 403);
  const slug = String(url.searchParams.get("center") || "").toLowerCase();
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return out({ error: "center missing" }, 400);
  await forget(env, [`conv/${slug}/open`]).catch(() => {});
  return out({ ok: true, sent: await pushToCenter(env, slug) });
}

// ---------- Weekly summary e-mail ----------
// GET talay.io/api/weekly?key=WEEKLY_KEY  (called by Make every Monday morning)
// Returns one ready-made e-mail per center: { week, emails: [{ center, to, subject, html }] }.
// Recipients: Centers → Admin emails, else Alert Email. A center with the checkbox
// "No weekly summary" is skipped. Add &only=you@example.com to send every e-mail to one address (test).
export async function handleWeekly(request, env, ctx) {
  const url = new URL(request.url);
  const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (!env.WEEKLY_KEY || url.searchParams.get("key") !== env.WEEKLY_KEY) return reply({ error: "forbidden" }, 403);
  const only = String(url.searchParams.get("only") || "").trim();
  if (only && !EMAIL.test(only)) return reply({ error: "only must be an e-mail address" }, 400);

  const TZ = 7 * 3600 * 1000;
  const t = new Date(Date.now() + TZ);
  const todayMid = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - TZ;
  const dow = (t.getUTCDay() + 6) % 7; // Monday = 0
  const end = todayMid - dow * DAY;    // this Monday 00:00 Koh Tao time
  const start = end - 7 * DAY;         // last Monday
  const fmt = (ms, o) => new Date(ms + TZ).toLocaleDateString("en-GB", { timeZone: "UTC", ...o });
  const week = fmt(start, { day: "numeric", month: "short" }) + " – " + fmt(end - 1, { day: "numeric", month: "short" });

  const recs = await at(env, "Centers", { formula: "{Slug} != ''" });
  const emails = [];
  for (const r of recs) {
    const f = r.fields;
    if (f["No weekly summary"]) continue;
    const center = {
      id: r.id, slug: String(first(f["Slug"]) || "").toLowerCase(), name: first(f["Name"]) || "Dive center",
      assistant: first(f["Assistant name"]) || "Mia",
    };
    if (!/^[a-z0-9-]{1,60}$/.test(center.slug)) continue;
    let to = splitEmails(f["Admin emails"]);
    if (!to.length && first(f["Alert Email"])) to = splitEmails(f["Alert Email"]);
    if (only) to = [only];
    if (!to.length) continue;
    const s = await weekStats(env, center, start, end).catch((e) => ({ error: String(e.message || e) }));
    if (s.error) continue;
    emails.push({ center: center.name, to: to.join(", "), subject: weeklySubject(center, s), html: weeklyHtml(center, s, week) });
  }
  return reply({ week, emails });
}

async function weekStats(env, center, start, end) {
  const iso = (ms) => new Date(ms).toISOString();
  const inP = (m) => `IS_AFTER(${m}, DATETIME_PARSE('${iso(start - 1000)}')), IS_BEFORE(${m}, DATETIME_PARSE('${iso(end)}'))`;
  const [leads, books, arr] = await Promise.all([
    atMade(env, "Leads", { max: 5000 }, (m) => `AND(${ofCenter(center)}, ${inP(m)})`),
    atMade(env, "Bookings", { max: 5000 }, (m) => `AND(${ofCenter(center)}, ${inP(m)})`),
    arriving(env, center).catch(() => ({ items: [] })),
  ]);
  const n = (v) => Number(first(v)) || 0;
  const live = books.filter((b) => !/cancel|refund/i.test(String(first(b.fields["Status"]) || "")));
  const resp = leads.map((l) => n(l.fields["Response seconds"])).filter((x) => x > 0 && x < 3600);
  const prods = {};
  live.forEach((b) => { const k = String(first(b.fields["P name"]) || "Other"); prods[k] = (prods[k] || 0) + (n(b.fields["Group size"]) || 1); });
  const top = Object.entries(prods).sort((a, b) => b[1] - a[1])[0];
  return {
    conversations: leads.length,
    outsideHours: leads.reduce((a, l) => a + n(l.fields["Outside hours"]), 0),
    handedOver: leads.filter((l) => n(l.fields["Handed over"]) || first(l.fields["Handover at"])).length,
    avgResponse: resp.length ? Math.round(resp.reduce((a, b) => a + b, 0) / resp.length) : null,
    bookings: live.length,
    divers: live.reduce((a, b) => a + (n(b.fields["Group size"]) || 1), 0),
    revenue: live.reduce((a, b) => a + n(b.fields["Total value THB"]), 0),
    atShop: live.reduce((a, b) => a + n(b.fields["Balance at shop"]), 0),
    topProduct: top ? top[0] : "",
    arriving: (arr.items || []).length,
  };
}

function weeklySubject(center, s) {
  const thb = Math.round(s.revenue).toLocaleString("en-US");
  if (s.bookings) return `Your week with Talay: ${s.bookings} ${s.bookings === 1 ? "booking" : "bookings"}, ${thb} THB`;
  return `Your week with Talay: ${s.conversations} ${s.conversations === 1 ? "conversation" : "conversations"}`;
}

function weeklyHtml(center, s, week) {
  const e = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v) => Math.round(v).toLocaleString("en-US");
  const sec = (x) => x == null ? "–" : x < 60 ? `${x} s` : `${Math.floor(x / 60)} min ${x % 60} s`;
  const pct = (a, b) => b ? Math.round(a / b * 100) + "%" : "–";
  const cell = (big, label, gold) => `<td width="33%" style="padding:16px 8px;text-align:left;vertical-align:top"><div style="font-size:28px;line-height:32px;font-weight:bold;color:${gold ? "#DCA44A" : "#F7F3EA"}">${big}</div><div style="font-size:12px;line-height:16px;color:#A9BDC1">${label}</div></td>`;
  const row = (label, value) => `<tr><td style="padding:10px 0;border-bottom:1px solid #E7E0D3;font-size:14px;color:#5B6B70">${label}</td><td style="padding:10px 0;border-bottom:1px solid #E7E0D3;font-size:14px;color:#09262F;font-weight:bold;text-align:right">${value}</td></tr>`;
  const tips = [];
  if (s.handedOver) tips.push(`${s.handedOver} ${s.handedOver === 1 ? "conversation was" : "conversations were"} handed to your team.`);
  if (s.arriving) tips.push(`${s.arriving} ${s.arriving === 1 ? "diver arrives" : "divers arrive"} in the next 14 days without a booking. See <b>Bookings → Arriving soon</b>.`);
  return `<!doctype html><html><body style="margin:0;padding:0;background:#F7F3EA">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F7F3EA"><tr><td align="center" style="padding:28px 12px">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:100%;font-family:Arial,Helvetica,sans-serif;color:#09262F">
<tr><td style="padding:0 4px 16px;font-size:13px;color:#5B6B70">${e(center.name)} · ${e(week)}</td></tr>
<tr><td style="background:#09262F;border-radius:16px;padding:24px 24px 12px">
<div style="font-size:13px;color:#DCA44A;font-weight:bold">Your week with Talay</div>
<div style="font-size:22px;line-height:28px;font-weight:bold;color:#F7F3EA;padding-top:6px">${s.bookings ? `${s.bookings} new ${s.bookings === 1 ? "booking" : "bookings"} through ${e(center.assistant)}` : `${e(center.assistant)} answered ${s.conversations} ${s.conversations === 1 ? "diver" : "divers"}`}</div>
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px"><tr>${cell(s.conversations, "conversations")}${cell(s.bookings, s.bookings === 1 ? "booking" : "bookings")}${cell(num(s.revenue), "THB booked", true)}</tr></table>
</td></tr>
<tr><td style="padding:20px 4px 0">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
${row("Divers booked", s.divers)}
${row("Collected at your shop", num(s.atShop) + " THB")}
${row("Conversations outside office hours", `${s.outsideHours} (${pct(s.outsideHours, s.conversations)})`)}
${row(`${e(center.assistant)}'s average first reply`, sec(s.avgResponse))}
${s.topProduct ? row("Most booked", e(s.topProduct)) : ""}
</table>
</td></tr>
${tips.length ? `<tr><td style="padding:18px 4px 0;font-size:14px;line-height:21px;color:#09262F">${tips.join("<br>")}</td></tr>` : ""}
<tr><td style="padding:22px 4px 0"><a href="https://talay.io/zone" style="display:inline-block;background:#DCA44A;color:#09262F;font-size:14px;font-weight:bold;text-decoration:none;padding:11px 20px;border-radius:12px">Open your customer zone</a></td></tr>
<tr><td style="padding:26px 4px 0;font-size:12px;line-height:18px;color:#8A9BA0">Sent every Monday by Talay. Questions? Reply to this e-mail.</td></tr>
</table></td></tr></table></body></html>`;
}

// ---------- Today so far ----------
// Conversations, replies and bookings since midnight (Koh Tao time), and how many bookings came in
// outside office hours (Centers → Escalation hours).
async function dayStats(env, center) {
  const f = await centerRecord(env, center);
  const hm = String(first(f["Escalation hours"]) || "").match(/(\d{1,2}):(\d{2}).*?(\d{1,2}):(\d{2})/);
  let open = hm ? (+hm[1]) * 60 + (+hm[2]) : 9 * 60, close = hm ? (+hm[3]) * 60 + (+hm[4]) : 18 * 60;
  if (close <= open) { open = 9 * 60; close = 18 * 60; }
  const TZ = 7 * 3600 * 1000, now = Date.now(), t = new Date(now + TZ);
  const start = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - TZ;
  const iso = (ms) => new Date(ms).toISOString();
  const win = (field) => `IS_AFTER(${field}, DATETIME_PARSE('${iso(start - 1000)}')), IS_BEFORE(${field}, DATETIME_PARSE('${iso(now + 60000)}'))`;
  const [msgs, leads, books] = await Promise.all([
    at(env, "Chat", { formula: `AND({Center} = '${q(center.slug)}', ${win("{Sent at}")})`, fields: ["Direction", "Contact ID"], max: 3000 }),
    atMade(env, "Leads", { fields: ["Handed over", "Handover at"], max: 2000 }, (m) => `AND(${ofCenter(center)}, ${win(m)})`),
    atMade(env, "Bookings", { fields: ["Group size", "Total value THB", "Status"], max: 1000 }, (m) => `AND(${ofCenter(center)}, ${win(m)})`),
  ]);
  const n = (v) => Number(first(v)) || 0;
  const people = new Set(msgs.filter((m) => m.fields["Direction"] === "Customer").map((m) => String(m.fields["Contact ID"] || "")));
  people.delete("");
  const live = books.filter((b) => !/cancel|refund/i.test(String(first(b.fields["Status"]) || "")));
  const outside = live.filter((b) => { const d = new Date(Date.parse(madeOf(b)) + TZ); const m = d.getUTCHours() * 60 + d.getUTCMinutes(); return m < open || m >= close; });
  return {
    date: iso(start),
    conversations: people.size,
    replies: msgs.filter((m) => m.fields["Direction"] === "Mia").length,
    bookings: live.length,
    divers: live.reduce((a, b) => a + (n(b.fields["Group size"]) || 1), 0),
    revenue: live.reduce((a, b) => a + n(b.fields["Total value THB"]), 0),
    outsideBookings: outside.length,
    outsideRevenue: outside.reduce((a, b) => a + n(b.fields["Total value THB"]), 0),
    handedOver: leads.filter((l) => n(l.fields["Handed over"]) || first(l.fields["Handover at"])).length,
  };
}

// ---------- While you were diving ----------
// What the assistant did while the team was off: from last night's closing time until this
// morning's opening time (office hours from Centers → Escalation hours, Koh Tao time).
// After closing time (and before opening) it shows "tonight so far".
async function overnight(env, center) {
  const f = await centerRecord(env, center);
  const hm = String(first(f["Escalation hours"]) || "").match(/(\d{1,2}):(\d{2}).*?(\d{1,2}):(\d{2})/);
  let open = hm ? (+hm[1]) * 60 + (+hm[2]) : 9 * 60;
  let close = hm ? (+hm[3]) * 60 + (+hm[4]) : 18 * 60;
  if (close <= open) { open = 9 * 60; close = 18 * 60; }
  const TZ = 7 * 3600 * 1000, MIN = 60000, now = Date.now();
  const t = new Date(now + TZ);
  const minNow = t.getUTCHours() * 60 + t.getUTCMinutes();
  const midnight = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - TZ;
  let start, end, live = false;
  if (minNow >= close) { start = midnight + close * MIN; end = now; live = true; }
  else if (minNow < open) { start = midnight - DAY + close * MIN; end = now; live = true; }
  else { start = midnight - DAY + close * MIN; end = midnight + open * MIN; }
  const iso = (ms) => new Date(ms).toISOString();
  const win = (field) => `IS_AFTER(${field}, DATETIME_PARSE('${iso(start - 1000)}')), IS_BEFORE(${field}, DATETIME_PARSE('${iso(end)}'))`;
  const [msgs, leads, books] = await Promise.all([
    at(env, "Chat", { formula: `AND({Center} = '${q(center.slug)}', ${win("{Sent at}")})`, fields: ["Direction", "Contact ID"], max: 3000 }),
    atMade(env, "Leads", { max: 2000 }, (m) => `AND(${ofCenter(center)}, ${win(m)})`),
    atMade(env, "Bookings", { max: 1000 }, (m) => `AND(${ofCenter(center)}, ${win(m)})`),
  ]);
  const n = (v) => Number(first(v)) || 0;
  const people = new Set(msgs.filter((m) => m.fields["Direction"] === "Customer").map((m) => String(m.fields["Contact ID"] || "")));
  people.delete("");
  const live2 = books.filter((b) => !/cancel|refund/i.test(String(first(b.fields["Status"]) || "")));
  const resp = leads.map((l) => n(l.fields["Response seconds"])).filter((x) => x > 0 && x < 3600);
  const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  return {
    live, from: iso(start), to: iso(end), closeAt: hhmm(close), openAt: hhmm(open),
    conversations: people.size,
    newDivers: leads.length,
    replies: msgs.filter((m) => m.fields["Direction"] === "Mia").length,
    bookings: live2.length,
    divers: live2.reduce((a, b) => a + (n(b.fields["Group size"]) || 1), 0),
    revenue: live2.reduce((a, b) => a + n(b.fields["Total value THB"]), 0),
    handedOver: leads.filter((l) => n(l.fields["Handed over"]) || first(l.fields["Handover at"])).length,
    avgResponse: resp.length ? Math.round(resp.reduce((a, b) => a + b, 0) / resp.length) : null,
  };
}

// ---------- Unfinished bookings ----------
// Stripe Checkout sessions of the last 7 days for this center that were never paid:
// the diver picked a product, date and number of divers, then left the payment page.
// Linked to the lead via lead_ref (the c=... code in the booking link).

const REMIND = {
  en: (p, d, l) => `Hi! I saw you picked *${p}* for ${d}, but the booking didn't go through, so your spot isn't reserved yet. You can finish it here 👇\n${l}`,
  nl: (p, d, l) => `Hoi! Ik zag dat je *${p}* koos voor ${d}, maar de boeking is niet afgerond, dus je plaats is nog niet gereserveerd. Je kan je boeking hier afronden 👇\n${l}`,
  fr: (p, d, l) => `Bonjour ! J'ai vu que vous avez choisi *${p}* pour le ${d}, mais la réservation n'a pas abouti : votre place n'est donc pas encore réservée. Vous pouvez la finaliser ici 👇\n${l}`,
  de: (p, d, l) => `Hi! Ich habe gesehen, dass du *${p}* für ${d} ausgewählt hast, aber die Buchung wurde nicht abgeschlossen, dein Platz ist also noch nicht reserviert. Hier kannst du sie abschließen 👇\n${l}`,
  es: (p, d, l) => `¡Hola! Vi que elegiste *${p}* para el ${d}, pero la reserva no se completó, así que tu plaza aún no está reservada. Puedes terminarla aquí 👇\n${l}`,
};
const LOCALE = { en: "en-GB", nl: "nl-BE", fr: "fr-FR", de: "de-DE", es: "es-ES" };

async function unfinished(env, center) {
  const key = stripeKeyOf(env, center);
  if (!key) return { items: [] };
  const since = Math.floor((Date.now() - 7 * DAY) / 1000);
  const sessions = [];
  let after = "";
  for (let page = 0; page < 5; page++) {
    const u = new URL("https://api.stripe.com/v1/checkout/sessions");
    u.searchParams.set("limit", "100");
    u.searchParams.set("created[gte]", String(since));
    if (after) u.searchParams.set("starting_after", after);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw new Error(`Stripe: ${res.status} ${await res.text()}`);
    const body = await res.json();
    sessions.push(...(body.data || []));
    if (!body.has_more || !body.data?.length) break;
    after = body.data[body.data.length - 1].id;
  }
  const mine = sessions.filter((s) => (s.metadata || {}).center_slug === center.slug);
  const today = thaiDate(Date.now());

  // Newest first; keep one unpaid attempt per diver, and drop it if the diver paid later.
  mine.sort((a, b) => b.created - a.created);
  const paidAfter = {};
  const items = [];
  const seen = new Set();
  for (const s of mine) {
    const m = s.metadata || {};
    const key = m.lead_ref || s.id;
    if (s.status === "complete") { if (!(key in paidAfter)) paidAfter[key] = s.created; continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    if (paidAfter[key] && paidAfter[key] > s.created) continue;
    if (!m.activity_date || m.activity_date < today) continue;
    items.push({
      id: s.id, ref: m.lead_ref || "", at: new Date(s.created * 1000).toISOString(),
      state: s.status === "open" ? "open" : "expired",
      code: String(m.product_code || ""), product: String(m.product_name || m.product_code || ""),
      date: m.activity_date, divers: Number(m.divers) || 1,
      total: Number(m.total_thb) || 0, deposit: Number(m.deposit_thb) || 0,
      lang: ["en", "nl", "fr", "de", "es"].includes(m.lang) ? m.lang : "en",
    });
  }

  // Find the lead behind each lead_ref through the c=... code in its booking link.
  const refs = [...new Set(items.map((i) => i.ref).filter((r) => /^[A-Za-z0-9_-]{1,64}$/.test(r)))];
  const byRef = {};
  // The lead code in booking links is the respond.io Contact ID (Leads → External ID).
  const direct = await leadsFor(env, center, refs.filter(okId));
  for (const [id, rec] of Object.entries(direct)) byRef[id] = rec.fields;
  const rest = refs.filter((r) => !byRef[r]);
  for (let i = 0; i < rest.length; i += 30) {
    const part = rest.slice(i, i + 30);
    const leads = await at(env, "Leads", {
      formula: `AND(${ofCenter(center)}, OR(${part.map((r) => `FIND('c=${q(r)}&', {Booking link} & '&')`).join(",")}))`,
      fields: ["Name", "Contact", "External ID", "Language", "Last message at", "Booking link", "Status"],
    });
    for (const l of leads) {
      const r = String(first(l.fields["Booking link"]) || "").match(/[?&]c=([A-Za-z0-9_-]{1,64})/)?.[1];
      if (r) byRef[r] = l.fields;
    }
  }

  const check = {
    stripeMode: key.startsWith("sk_test_") ? "test" : key.slice(0, 3),
    sessions7d: sessions.length, forThisCenter: mine.length,
    unpaid: mine.filter((s) => s.status !== "complete").length,
    centersSeen: [...new Set(sessions.map((s) => (s.metadata || {}).center_slug || "(none)"))].slice(0, 10),
  };
  return {
    check,
    items: items.map((i) => {
      const f = byRef[i.ref] || {};
      const chat = String(first(f["External ID"]) || "");
      const last = Date.parse(first(f["Last message at"]) || 0) || 0;
      const lang = first(f["Language"]) ? langCode(first(f["Language"])) : i.lang;
      const when = new Date(i.date + "T12:00:00Z").toLocaleDateString(LOCALE[lang] || "en-GB", { weekday: "long", day: "numeric", month: "long" });
      const link = `https://talay.io/b/${center.slug}?p=${encodeURIComponent(i.code)}${i.ref ? `&c=${i.ref}` : ""}&l=${lang}`;
      return {
        ...i, name: String(first(f["Name"]) || ""), phone: String(first(f["Contact"]) || ""),
        chat: okId(chat) ? chat : "", canMessage: last > 0 && Date.now() - last < DAY,
        booked: /booked/i.test(String(first(f["Status"]) || "")),
        reminder: (REMIND[lang] || REMIND.en)(i.product, when, link),
      };
    }),
  };
}


// ---------- Support tickets ----------
// Airtable table "Tickets": Title, Number (autonumber), Center (slug), Type, Priority, Status
// (New | In progress | Waiting for you | Done), Description, Created by, Contact ID, Context,
// Quote, Approved (checkbox), Record ID (formula RECORD_ID()), Created at, Updated at.
// Table "Ticket messages": Text, Ticket (link to Tickets), Ticket ID (lookup of Record ID),
// Author, From Talay (checkbox), Sent at.

const T_TYPES = ["Bug", "Wrong answer", "Improvement", "Custom request", "Question"];
const T_PRIOS = ["Low", "Normal", "Urgent"];
const okRec = (v) => /^rec[A-Za-z0-9]{10,20}$/.test(String(v || ""));

function ticketOut(r) {
  const f = r.fields;
  return {
    id: r.id, number: first(f["Number"]) || "", title: first(f["Title"]) || "", type: first(f["Type"]) || "",
    priority: first(f["Priority"]) || "Normal", status: first(f["Status"]) || "New",
    description: first(f["Description"]) || "", by: first(f["Created by"]) || "", contact: first(f["Contact ID"]) || "",
    context: first(f["Context"]) || "", quote: first(f["Quote"]) || "", approved: !!f["Approved"],
    created: first(f["Created at"]) || r.createdTime, updated: first(f["Updated at"]) || r.createdTime,
  };
}

async function tickets(env, center) {
  const recs = await at(env, "Tickets", { formula: `{Center} = '${q(center.slug)}'`, max: 500 });
  const list = recs.map(ticketOut).sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return { tickets: list, waiting: list.filter((t) => t.status === "Waiting for you").length };
}

async function ticketFor(env, center, id) {
  if (!okRec(id)) return null;
  const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/Tickets/${id}`,
    { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  if (!res.ok) return null;
  const r = await res.json();
  return String(first(r.fields["Center"]) || "") === center.slug ? r : null;
}

async function ticketDetail(env, center, id) {
  const r = await ticketFor(env, center, id);
  if (!r) return { error: "Ticket not found." };
  const msgs = await at(env, "Ticket messages", {
    formula: `{Ticket ID} & '' = '${q(id)}'`, sort: [{ field: "Sent at", direction: "asc" }], max: 300,
  });
  return {
    ticket: ticketOut(r),
    messages: msgs.map((m) => ({
      text: first(m.fields["Text"]) || "", author: first(m.fields["Author"]) || "",
      talay: !!m.fields["From Talay"], at: first(m.fields["Sent at"]) || m.createdTime,
    })),
  };
}

async function ticketAction(request, env, center, email, kind) {
  const b = await readBody(request);
  if (!b) return json({ error: "Bad request" }, 400);
  const clip = (v, n) => String(v || "").trim().slice(0, n);
  if (kind === "create") {
    const title = clip(b.title, 140), description = clip(b.description, 5000);
    if (!title) return json({ error: "Give the ticket a short title." }, 400);
    const fields = {
      Title: title, Description: description, Center: center.slug,
      Type: T_TYPES.includes(b.type) ? b.type : "Question",
      Priority: T_PRIOS.includes(b.priority) ? b.priority : "Normal",
      Status: "New", "Created by": email,
    };
    if (okId(b.contact)) fields["Contact ID"] = String(b.contact);
    if (b.context) fields["Context"] = clip(b.context, 5000);
    const out = await atWrite(env, "Tickets", "POST", [{ fields }]);
    await forget(env, [`tick/${center.slug}`]);
    return json({ ok: true, id: out.records?.[0]?.id });
  }
  const r = await ticketFor(env, center, b.id);
  if (!r) return json({ error: "Ticket not found." }, 404);
  if (kind === "message") {
    const text = clip(b.text, 5000);
    if (!text) return json({ error: "Type a message first." }, 400);
    await atWrite(env, "Ticket messages", "POST", [{ fields: { Text: text, Ticket: [r.id], Author: email } }]);
    const st = first(r.fields["Status"]);
    if (st === "Waiting for you" || st === "Done") await atWrite(env, "Tickets", "PATCH", [{ id: r.id, fields: { Status: "In progress" } }]);
  } else if (kind === "approve") {
    if (!center.admin) return json({ error: "Only an admin of your dive center can approve a quote." }, 403);
    await atWrite(env, "Tickets", "PATCH", [{ id: r.id, fields: { Approved: true, Status: "In progress" } }]);
    await atWrite(env, "Ticket messages", "POST", [{ fields: { Text: "✅ Quote approved.", Ticket: [r.id], Author: email } }]);
  } else if (kind === "close") {
    await atWrite(env, "Tickets", "PATCH", [{ id: r.id, fields: { Status: "Done" } }]);
  }
  await forget(env, [`tick/${center.slug}`]);
  return json({ ok: true });
}

// ---------- Settings ----------
// Centers fields: Staff emails, Alert Email, Escalation hours (+ FR/DE/ES/NL), Mia paused,
// Outside hours only (checkbox: the assistant stays silent during office hours, checked in Make)
// (checkbox), and read-only info shown to the team.

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
const HOURS_TEXT = {
  "": (a, b) => `daily from ${a} to ${b} (Thai time)`,
  NL: (a, b) => `elke dag van ${a.replace(":", ".")} tot ${b.replace(":", ".")} uur (Thaise tijd)`,
  FR: (a, b) => `tous les jours de ${a.replace(":", "h")} à ${b.replace(":", "h")} (heure thaïlandaise)`,
  DE: (a, b) => `täglich von ${a} bis ${b} Uhr (thailändische Zeit)`,
  ES: (a, b) => `todos los días de ${a} a ${b} (hora de Tailandia)`,
};
const hhmm = (v) => { const m = String(v || "").match(/^(\d{1,2}):(\d{2})$/); return m && +m[1] < 24 && +m[2] < 60 ? `${+m[1]}:${m[2]}` : null; };

async function centerRecord(env, center) {
  const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/Centers/${center.id}`,
    { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  if (!res.ok) throw new Error(`Airtable Centers: ${res.status} ${await res.text()}`);
  return (await res.json()).fields || {};
}

async function settings(env, center) {
  const f = await centerRecord(env, center);
  const hours = String(first(f["Escalation hours"]) || "").match(/(\d{1,2}:\d{2}).*?(\d{1,2}:\d{2})/);
  const s = (k) => String(first(f[k]) ?? "");
  const prods = await at(env, "Products", { formula: `FIND('${q(center.slug)}', ARRAYJOIN({C slug}))` });
  const products = prods.map((r) => {
    const p = r.fields;
    return {
      id: r.id, code: String(first(p["Code"]) || ""), name: String(first(p["Name"]) || ""),
      category: String(first(p["Category"]) || ""),
      price: Number(first(p["Price THB"])) || 0, deposit: Number(first(p["Deposit THB"])) || 0,
      pct: Math.round((Number(first(p["Commission pct"])) || 0) * 1000) / 10,
      cutoff: Number(first(p["Cutoff hour"])) || 15, active: !!p["Active"],
    };
  }).sort((a, b) => a.price - b.price);
  const staff = splitEmails(f["Staff emails"]);
  return {
    admin: center.admin, admins: splitEmails(f["Admin emails"]), products,
    staff, team: await teamDetails(env, center, staff),
    alert: s("Alert Email"),
    hoursText: s("Escalation hours"),
    from: hours ? hours[1].padStart(5, "0") : "09:00",
    to: hours ? hours[2].padStart(5, "0") : "18:00",
    paused: !!f["Mia paused"],
    outsideOnly: !!f["Outside hours only"],
    info: {
      assistant: s("Assistant name"), languages: s("Languages spoken"), meeting: s("Meeting point"),
      sites: s("Dive sites"), boats: s("Boat departure times"), emergency: s("Center emergency phone"),
    },
  };
}

// Team details live in the Airtable table "Notify" (one row per person per center, also used by
// /api/notify for WhatsApp and push). Staff emails on Centers stays the list of who may sign in.
const ROLES = ["Owner", "Office", "Instructor"];
const TOPICS = ["Needs you", "Bookings", "Morning summary", "Escalation"];
const CHANNELS = ["WhatsApp", "Push", "Email"];
const NLANGS = ["EN", "FR", "ES", "DE", "NL", "TH"];
async function notifyRows(env, center) {
  return at(env, "Notify", { formula: `ARRAYJOIN({Center}) & '' = '${q(center.name)}'`, max: 100 });
}
async function teamDetails(env, center, staff) {
  let rows = [];
  try { rows = await notifyRows(env, center); } catch (e) { return null; } // table not there yet
  const byMail = {};
  rows.forEach((r) => { const m = String(r.fields["Email"] || "").trim().toLowerCase(); if (m && !byMail[m]) byMail[m] = r; });
  return staff.map((e) => {
    const r = byMail[e], g = (r && r.fields) || {};
    return {
      email: e, id: r ? r.id : "", name: String(g["Name"] || ""), role: String(g["Role"] || ""),
      whatsapp: String(g["WhatsApp"] || ""), language: String(g["Language"] || ""),
      topics: g["Topics"] || [], channels: g["Channels"] || [], evenings: !!g["Evenings"], active: r ? !!g["Active"] : false,
    };
  });
}
async function saveMember(env, center, email, body) {
  const m = String(body.email || "").trim().toLowerCase();
  if (!EMAIL.test(m)) return json({ error: "Enter a valid email address." }, 400);
  const phone = String(body.whatsapp || "").replace(/[^\d+]/g, "");
  if (phone && !/^\+\d{8,15}$/.test(phone)) return json({ error: "Write the WhatsApp number with the country code, for example +66 81 234 5678." }, 400);
  const pick = (v, list) => (Array.isArray(v) ? v : []).filter((x) => list.includes(x));
  const fields = {
    Name: String(body.name || "").trim().slice(0, 80), Email: m, WhatsApp: phone,
    Role: ROLES.includes(body.role) ? body.role : null, Language: NLANGS.includes(body.language) ? body.language : null,
    Topics: pick(body.topics, TOPICS), Channels: pick(body.channels, CHANNELS),
    Evenings: !!body.evenings, Active: body.active !== false,
  };
  try {
    const f = await centerRecord(env, center), staff = splitEmails(f["Staff emails"]);
    if (!staff.includes(m)) {
      if (staff.length >= 50) return json({ error: "Maximum 50 team members." }, 400);
      await atPatch(env, "Centers", center.id, { "Staff emails": staff.concat([m]).join("\n") });
    }
    const row = (await notifyRows(env, center)).find((r) => String(r.fields["Email"] || "").trim().toLowerCase() === m);
    if (row) await atPatch(env, "Notify", row.id, fields);
    else await atWrite(env, "Notify", "POST", [{ fields: { ...fields, Center: [center.id] } }]);
  } catch (e) {
    console.error("member", e.message);
    if (/: (404|403|422) /.test(e.message)) return json({ error: "Team details aren't available yet. Ask Jonas to finish the setup." }, 500);
    return json({ error: "Could not save. Try again." }, 502);
  }
  await logChange(env, center, email, `team member: ${m}`);
  return json({ ok: true });
}

async function saveSettings(request, env, center, email) {
  const body = await readBody(request);
  if (!body) return json({ error: "Bad request" }, 400);
  if (body.action !== "mia" && !center.admin) {
    return json({ error: "Only an admin of your dive center can change this." }, 403);
  }
  if (body.action === "product") return await saveProduct(env, center, email, body);
  if (body.action === "member") return await saveMember(env, center, email, body);
  const fields = {};
  if (body.action === "team") {
    const list = [...new Set(splitEmails((body.emails || []).join("\n")))];
    const bad = list.find((e) => !EMAIL.test(e));
    if (bad) return json({ error: `"${bad}" is not a valid email address.` }, 400);
    if (!list.includes(email)) return json({ error: "You can't remove yourself. Ask a colleague to do that." }, 400);
    if (list.length > 50) return json({ error: "Maximum 50 team members." }, 400);
    fields["Staff emails"] = list.join("\n");
    try {
      const gone = (await notifyRows(env, center)).filter((r) => { const m = String(r.fields["Email"] || "").trim().toLowerCase(); return m && !list.includes(m); });
      for (const r of gone) {
        await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/Notify/${r.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
      }
    } catch (e) { /* no Notify table yet */ }
  } else if (body.action === "alert") {
    const a = String(body.email || "").trim().toLowerCase();
    if (!EMAIL.test(a)) return json({ error: "Enter one valid email address." }, 400);
    fields["Alert Email"] = a;
  } else if (body.action === "hours") {
    const a = hhmm(body.from), b = hhmm(body.to);
    if (!a || !b) return json({ error: "Choose an opening and a closing time." }, 400);
    for (const [suffix, fn] of Object.entries(HOURS_TEXT)) fields[`Escalation hours${suffix ? " " + suffix : ""}`] = fn(a, b);
  } else if (body.action === "mode") {
    fields["Outside hours only"] = !!body.outsideOnly;
  } else if (body.action === "mia") {
    fields["Mia paused"] = !!body.paused;
  } else {
    return json({ error: "Unknown setting." }, 400);
  }
  const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/Centers/${center.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("settings", res.status, t);
    if (/UNKNOWN_FIELD_NAME/.test(t)) return json({ error: "This setting isn't available yet. Ask Jonas to finish the setup." }, 500);
    return json({ error: "Could not save. Try again." }, 502);
  }
  await logChange(env, center, email, describe(body));
  return json({ ok: true });
}


function describe(b) {
  if (b.action === "team") return `team: ${(b.emails || []).join(", ")}`;
  if (b.action === "alert") return `alert email: ${b.email}`;
  if (b.action === "hours") return `office hours: ${b.from}–${b.to}`;
  if (b.action === "mode") return b.outsideOnly ? "assistant answers only outside office hours" : "assistant answers day and night";
  if (b.action === "mia") return b.paused ? "paused the assistant" : "turned the assistant back on";
  return b.action;
}

// Appends one line to Centers → "Change log" (long text). Skipped quietly if the field is missing.
async function logChange(env, center, email, what) {
  try {
    const f = await centerRecord(env, center);
    const stamp = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
    const line = `${stamp} (Thai time) ${email}: ${what}`;
    const log = (line + "\n" + String(f["Change log"] || "")).slice(0, 20000);
    await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/Centers/${center.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { "Change log": log } }),
    });
  } catch (e) { console.error("log", e); }
}

// Price, booking deadline and "bookable online" per product. The deposit is a formula in
// Airtable (price × commission %), so it follows the price. The matching price field in
// Centers (OW price, DSD price, …) is updated too, because texts read it.
const CENTER_PRICE = { OW: "OW price", DSD: "DSD price", FUN: "FUN price", FUN10: "FUN10 price", AOW: "AOW price" };
async function saveProduct(env, center, email, b) {
  if (!/^rec[A-Za-z0-9]{10,20}$/.test(String(b.id || ""))) return json({ error: "Bad request" }, 400);
  const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/Products/${b.id}`,
    { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  if (!res.ok) return json({ error: "Product not found." }, 404);
  const p = (await res.json()).fields || {};
  if (!String(p["C slug"] || "").includes(center.slug)) return json({ error: "Product not found." }, 404);
  const price = Math.round(Number(b.price));
  const cutoff = Math.round(Number(b.cutoff));
  if (!(price >= 100 && price <= 500000)) return json({ error: "Enter a price between 100 and 500,000 THB." }, 400);
  if (!(cutoff >= 0 && cutoff <= 23)) return json({ error: "Choose a booking deadline between 0:00 and 23:00." }, 400);
  const fields = { "Price THB": price, "Cutoff hour": cutoff, Active: !!b.active };
  const up = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/Products/${b.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!up.ok) { console.error("product", up.status, await up.text()); return json({ error: "Could not save. Try again." }, 502); }
  // If Deposit THB is a plain number (not a formula), keep it at price × commission %.
  // When it is a formula, Airtable refuses this write and the formula does the job.
  const pct = Number(first(p["Commission pct"])) || 0;
  if (pct > 0) {
    await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/Products/${b.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { "Deposit THB": Math.round(price * pct) } }),
    }).catch(() => {});
  }
  const code = String(first(p["Code"]) || "").toUpperCase();
  if (CENTER_PRICE[code]) {
    await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/Centers/${center.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { [CENTER_PRICE[code]]: price.toLocaleString("en-US") }, typecast: true }),
    }).catch(() => {});
  }
  const old = Number(first(p["Price THB"])) || 0, oldCut = Number(first(p["Cutoff hour"])) || 0, oldAct = !!p["Active"];
  const parts = [];
  if (old !== price) parts.push(`price ${old.toLocaleString("en-US")} → ${price.toLocaleString("en-US")} THB`);
  if (oldCut !== cutoff) parts.push(`deadline ${oldCut}:00 → ${cutoff}:00`);
  if (oldAct !== !!b.active) parts.push(b.active ? "bookable online" : "online booking closed");
  if (parts.length) await logChange(env, center, email, `${first(p["Name"]) || code}: ${parts.join(", ")}`);
  return json({ ok: true });
}

// ---------- Pages ----------

// ---------- Talay HQ: talay.io/zone/admin ----------
// The back office for Talay itself, across all centers: overview with health check and
// numbers, one inbox over every center, search, a page per center, bookings, commission
// (CSV for invoicing), sign-ups from talay.io/start, system status and the HQ team.
//
// Who gets in: SUPERADMIN_EMAILS (Cloudflare variable, default jonas@talay.io) as Owner,
// plus Airtable table "HQ team" (Email, Name, Role = Owner | Staff). Owners manage the team;
// everyone in HQ can see everything and pause or resume an assistant. They also need to be
// allowed by the Cloudflare Access policy of /zone.
// Optional Centers field "Type" (Demo, Test, Pilot, Live): Demo and Test centers stay out
// of the totals unless "Ook demo/test" is ticked.

const ADMIN_CACHE = "admin/overview/v4";
const SORRY = /^sorry, something went wrong on our side/i; // v2 error handler (HTTP 3 → Respond.io 13)
const WAIT_MIN = 15; // a diver's message without any answer for this long counts as waiting
const HQ_ROLES = ["Owner", "Staff"];
const TZ_MS = 7 * 3600 * 1000;
const isoT = (ms) => new Date(ms).toISOString();

// "owner", "staff" or null. Kept for a minute per address, so zone requests stay cheap.
async function hqRole(env, email) {
  if (splitEmails(env.SUPERADMIN_EMAILS || "jonas@talay.io").includes(email)) return "owner";
  const r = await cached(env, `hq/role/${encodeURIComponent(email)}`, 60, async () => {
    try {
      const recs = await at(env, "HQ team", { formula: `LOWER(TRIM({Email} & '')) = '${q(email)}'`, max: 1 });
      if (!recs.length) return { role: null };
      return { role: /owner/i.test(String(first(recs[0].fields["Role"]) || "")) ? "owner" : "staff" };
    } catch (e) { return { role: null }; } // table not made yet
  });
  return r.role;
}

async function handleAdmin(request, env, url, p, email, role) {
  if (p === "/zone/admin") return html(adminApp(email, role));
  const fresh = url.searchParams.get("fresh") === "1";
  const get = request.method === "GET";
  if (get && p === "/zone/admin/api/overview") return json(await cached(env, ADMIN_CACHE, 120, () => adminOverview(env), fresh));
  if (get && p === "/zone/admin/api/inbox") return json(await adminInbox(env, fresh));
  if (get && p === "/zone/admin/api/search") return json(await adminSearch(env, url.searchParams.get("q")));
  if (get && p === "/zone/admin/api/center") {
    const slug = String(url.searchParams.get("slug") || "").toLowerCase();
    if (!/^[a-z0-9-]{1,60}$/.test(slug)) return json({ error: "Onbekend center." }, 400);
    return json(await cached(env, `admin/center/${slug}`, 60, () => adminCenter(env, slug), fresh));
  }
  if (get && p === "/zone/admin/api/bookings") {
    const m = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : thaiMonth(Date.now());
    return json(await cached(env, `admin/book/${m}`, 60, () => adminBookings(env, m), fresh));
  }
  if (get && p === "/zone/admin/api/intake") return json(await adminIntake(env));
  if (get && p === "/zone/admin/api/team") return json(await adminTeam(env));
  if (get && p === "/zone/admin/api/pipeline") return json(await adminPipeline(env));
  if (get && p === "/zone/admin/api/outreach") return json(await adminOutreach(env, fresh));
  if (get && p === "/zone/admin/api/conversion") {
    const per = /^\d{4}-\d{2}$/.test(url.searchParams.get("period") || "") ? url.searchParams.get("period") : "";
    return json(await adminConversion(env, per, fresh));
  }
  if (get && p === "/zone/admin/api/costs") {
    const m = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "") ? url.searchParams.get("month") : thaiMonth(Date.now());
    return json(await cached(env, `admin/costs/${m}`, 600, () => adminCosts(env, m), fresh));
  }
  if (request.method === "POST") {
    const body = await readBody(request);
    if (!body) return json({ error: "Bad request" }, 400);
    if (p === "/zone/admin/api/pause") return await adminPause(env, email, body);
    if (p === "/zone/admin/api/intake") return await adminIntakeStatus(env, body);
    if (p === "/zone/admin/api/pipeline") return await adminPipelineChange(env, email, body);
    if (p === "/zone/admin/api/pipeline/ai") return await adminPipelineAi(env, body);
    if (p === "/zone/admin/api/outreach") return await adminOutreachChange(env, email, body);
    if (p === "/zone/admin/api/alert-test") return await adminAlertTest(env);
    if (p === "/zone/admin/api/team") {
      if (role !== "owner") return json({ error: "Alleen een eigenaar kan het team aanpassen." }, 403);
      return await adminTeamChange(env, email, body);
    }
  }
  return json({ error: "Not found" }, 404);
}

const thaiMonth = (ms) => new Date(ms + TZ_MS).toISOString().slice(0, 7);
async function atPatch(env, table, id, fields) {
  const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) throw new Error(`Airtable PATCH ${table}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function adminPause(env, email, body) {
  const center = (await allCenters(env)).find((c) => c.slug === String(body.slug || "").toLowerCase());
  if (!center) return json({ error: "Onbekend center." }, 400);
  try { await atPatch(env, "Centers", center.id, { "Mia paused": !!body.paused }); }
  catch (e) { console.error("admin pause", e); return json({ error: "Opslaan lukte niet. Probeer opnieuw." }, 502); }
  await logChange(env, center, email, describe({ action: "mia", paused: !!body.paused }));
  await forget(env, [ADMIN_CACHE, `admin/center/${center.slug}`]);
  return json({ ok: true, paused: !!body.paused });
}

// Periods in Koh Tao time. "prev" is the same stretch of the period before: yesterday until
// this time, last week until this weekday and time, last month until this day and time.
function adminPeriods(now) {
  const t = new Date(now + TZ_MS);
  const today = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - TZ_MS;
  const week = today - ((t.getUTCDay() + 6) % 7) * DAY;
  const month = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1) - TZ_MS;
  const prevMonth = Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1) - TZ_MS;
  return {
    today: { start: today, end: now, prev: [today - DAY, now - DAY] },
    week: { start: week, end: now, prev: [week - 7 * DAY, now - 7 * DAY] },
    month: { start: month, end: now, prev: [prevMonth, Math.min(prevMonth + (now - month), month)] },
  };
}

const num = (v) => Number(first(v)) || 0;
const str = (f, k) => String(first(f[k]) ?? "");
const msOf = (v) => Date.parse(first(v) || "") || 0;
const madeAt = (r) => Date.parse(r.createdTime) || 0;
const cancelled = (b) => /cancel|refund/i.test(str(b.fields, "Status"));
const handedOver = (l) => num(l.fields["Handed over"]) || first(l.fields["Handover at"]);
const median = (a) => {
  if (!a.length) return null;
  a = a.slice().sort((x, y) => x - y);
  const m = a.length >> 1;
  return Math.round(a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2);
};
// Seconds from the diver's first message to the first answer (Leads → First message at /
// First reply at), else the older "Response seconds".
const firstReply = (l) => {
  const d = (msOf(l.fields["First reply at"]) - msOf(l.fields["First message at"])) / 1000;
  return d > 0 && d < 7 * 86400 ? d : (num(l.fields["Response seconds"]) || null);
};
// Seconds between a diver's message and the assistant's answer to it, from Chat. Leads →
// First message at / First reply at are written in the same minute, so they always give 0.
function replyDelays(rows) {
  const open = {}, out = [];
  for (const m of rows) {
    const f = m.fields, id = String(f["Contact ID"] || ""), slug = String(f["Center"] || "").toLowerCase();
    const t = msOf(f["Sent at"]);
    if (!id || !t) continue;
    const k = slug + "/" + id;
    if (f["Direction"] === "Customer") { if (!open[k]) open[k] = t; continue; }
    if (open[k] && f["Direction"] === "Mia") {
      const d = (t - open[k]) / 1000;
      if (d >= 0 && d < 86400) out.push({ slug, at: t, sec: d });
    }
    delete open[k];
  }
  return out;
}
const commissionOf = (b) => num(b.fields["Commission THB"]) || num(b.fields["Deposit paid THB"]);
// A record belongs to a center through the linked Center (record id), else the C slug lookup.
const ownedBy = (r, c) => (Array.isArray(r.fields["Center"]) && r.fields["Center"].includes(c.id)) ||
  String(first(r.fields["C slug"]) || "").toLowerCase() === c.slug;
const centerMeta = (r) => {
  const f = r.fields, type = str(f, "Type");
  return {
    id: r.id, slug: str(f, "Slug").toLowerCase(), name: str(f, "Name") || str(f, "Slug") || "Center zonder naam",
    type, test: /demo|test/i.test(type), assistant: str(f, "Assistant name") || "Mia",
  };
};

async function adminOverview(env) {
  const now = Date.now();
  const P = adminPeriods(now);
  const from = Math.min(P.month.prev[0], P.week.prev[0], now - 30 * DAY);
  const [centerRecs, leads, books, msgs, talk] = await Promise.all([
    at(env, "Centers", { sort: [{ field: "Name" }] }),
    at(env, "Leads", { formula: `IS_AFTER(CREATED_TIME(), DATETIME_PARSE('${isoT(from - 1000)}'))`, max: 20000 }),
    at(env, "Bookings", { formula: `IS_AFTER(CREATED_TIME(), DATETIME_PARSE('${isoT(from - 1000)}'))`, max: 20000 }),
    at(env, "Chat", {
      formula: `IS_AFTER({Sent at}, DATETIME_PARSE('${isoT(now - DAY)}'))`,
      fields: ["Direction", "Contact ID", "Center", "Sent at", "Text"], sort: [{ field: "Sent at" }], max: 5000,
    }).catch(() => null),
    at(env, "Chat", {
      formula: `IS_AFTER({Sent at}, DATETIME_PARSE('${isoT(Math.min(P.month.start, P.week.start) - DAY)}'))`,
      fields: ["Direction", "Contact ID", "Center", "Sent at"], sort: [{ field: "Sent at" }], max: 20000,
    }).catch(() => null),
  ]);
  const delays = talk ? replyDelays(talk) : null;
  const replyOf = (list, a, b) => median(list.filter((d) => d.at >= a && d.at < b).map((d) => d.sec));

  const stats = (ls, bs, a, b) => {
    const L = ls.filter((l) => madeAt(l) >= a && madeAt(l) < b);
    const B = bs.filter((x) => madeAt(x) >= a && madeAt(x) < b && !cancelled(x));
    const booked = L.filter((l) => /booked/i.test(str(l.fields, "Status")));
    return {
      conversations: L.length,
      handedOver: L.filter(handedOver).length,
      bookings: B.length,
      divers: B.reduce((t, x) => t + (num(x.fields["Group size"]) || 1), 0),
      value: B.reduce((t, x) => t + num(x.fields["Total value THB"]), 0),
      commission: B.reduce((t, x) => t + commissionOf(x), 0),
      outsideHours: L.reduce((t, l) => t + num(l.fields["Outside hours"]), 0),
      afterFollowUp: booked.filter((l) => num(l.fields["Follow-ups sent"]) > 0).length,
      booked: booked.length,
      replySeconds: median(L.map(firstReply).filter(Boolean)),
      team: L.map((l) => (msOf(l.fields["Human took over at"]) - msOf(l.fields["Handover at"])) / 60000)
        .filter((x) => x > 0 && x < 7 * 24 * 60),
    };
  };
  const periodStats = (ls, bs, slug) => {
    const out = {};
    const mine = delays && delays.filter((d) => d.slug === slug);
    for (const [k, p] of Object.entries(P)) {
      const cur = stats(ls, bs, p.start, p.end + 1), prev = stats(ls, bs, p.prev[0], p.prev[1] + 1);
      if (mine) cur.replySeconds = replyOf(mine, p.start, p.end + 1);
      cur.teamMinutes = median(cur.team); cur.teamCount = cur.team.length; delete cur.team; delete prev.team;
      out[k] = { ...cur, prev };
    }
    return out;
  };
  // Last 30 days, one entry per Koh Tao day: [new conversations, bookings, booking value].
  const day0 = P.today.start - 29 * DAY;
  const daily = (ls, bs) => {
    const d = Array.from({ length: 30 }, () => [0, 0, 0]);
    ls.forEach((l) => { const i = Math.floor((madeAt(l) - day0) / DAY); if (i >= 0 && i < 30) d[i][0]++; });
    bs.forEach((b) => { if (cancelled(b)) return; const i = Math.floor((madeAt(b) - day0) / DAY); if (i >= 0 && i < 30) { d[i][1]++; d[i][2] += num(b.fields["Total value THB"]); } });
    return d;
  };

  const byContact = {};
  leads.forEach((l) => { const id = str(l.fields, "External ID"); if (id) byContact[id] = l; });

  const centers = centerRecs.map((r) => {
    const f = r.fields, c = centerMeta(r);
    const ls = leads.filter((l) => ownedBy(l, c));
    const bs = books.filter((b) => ownedBy(b, c));
    let health = null;
    if (msgs) {
      const mine = msgs.filter((m) => String(m.fields["Center"] || "").toLowerCase() === c.slug);
      const mia = mine.filter((m) => m.fields["Direction"] === "Mia");
      const lastBy = {};
      mine.forEach((m) => { const id = String(m.fields["Contact ID"] || ""); if (id) lastBy[id] = m; });
      const waiting = Object.entries(lastBy).filter(([id, m]) => {
        const l = byContact[id];
        return m.fields["Direction"] === "Customer" && msOf(m.fields["Sent at"]) < now - WAIT_MIN * 60000 &&
          !(l && (l.fields["Human took over"] || l.fields["Opted out"]));
      });
      const latest = (list) => { const t = list.reduce((a, m) => Math.max(a, msOf(m.fields["Sent at"])), 0); return t ? isoT(t) : null; };
      health = {
        errors: mia.filter((m) => SORRY.test(String(m.fields["Text"] || "").trim())).length,
        replies: mia.length,
        divers: new Set(mine.filter((m) => m.fields["Direction"] === "Customer").map((m) => String(m.fields["Contact ID"] || ""))).size,
        waiting: waiting.length,
        lastMia: latest(mia),
        lastCustomer: latest(mine.filter((m) => m.fields["Direction"] === "Customer")),
      };
    }
    const open = ls.filter((l) => handedOver(l) && madeAt(l) >= now - 7 * DAY &&
      !l.fields["Opted out"] && !l.fields["Human took over"] && !first(l.fields["Human took over at"]) &&
      !/booked|lost|closed|spam/i.test(str(l.fields, "Status")));
    const late = open.filter((l) => msOf(l.fields["Handover at"]) < now - ALERT_HANDOVER_MIN * 60000 && msOf(l.fields["Handover at"]) > now - DAY).length;
    const last = ls.reduce((a, l) => Math.max(a, madeAt(l)), 0);
    return {
      ...c, channel: num(f["Channel ID"]) || null, paused: !!f["Mia paused"],
      staff: splitEmails(f["Staff emails"]).length, admins: splitEmails(f["Admin emails"]).length,
      validSlug: /^[a-z0-9-]{1,60}$/.test(c.slug), logo: first(f["Logo"])?.thumbnails?.small?.url || "",
      periods: periodStats(ls, bs, c.slug), daily: daily(ls, bs),
      health, openHandovers: open.length, lateHandovers: late, lastConversation: last ? isoT(last) : null,
    };
  });

  // Median reply time over all centers and over the real ones only (medians can't be summed).
  const testIds = new Set(centers.filter((c) => c.test).map((c) => c.id));
  const testSlugs = new Set(centers.filter((c) => c.test).map((c) => c.slug));
  const isTest = (l) => (Array.isArray(l.fields["Center"]) && l.fields["Center"].some((id) => testIds.has(id))) ||
    testSlugs.has(String(first(l.fields["C slug"]) || "").toLowerCase());
  const reply = { all: {}, live: {} };
  for (const [k, p] of Object.entries(P)) {
    if (delays) {
      reply.all[k] = replyOf(delays, p.start, p.end + 1);
      reply.live[k] = replyOf(delays.filter((d) => !testSlugs.has(d.slug)), p.start, p.end + 1);
      continue;
    }
    const L = leads.filter((l) => madeAt(l) >= p.start);
    reply.all[k] = median(L.map(firstReply).filter(Boolean));
    reply.live[k] = median(L.filter((l) => !isTest(l)).map(firstReply).filter(Boolean));
  }

  // Latest changes made in the zones (Centers → Change log), newest first.
  const activity = [];
  centerRecs.forEach((r) => {
    const name = str(r.fields, "Name");
    String(r.fields["Change log"] || "").split("\n").slice(0, 30).forEach((line) => {
      const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \(Thai time\) ([^:]+): (.*)$/);
      if (m) activity.push({ at: m[1], who: m[2], what: m[3], center: name });
    });
  });
  activity.sort((a, b) => b.at.localeCompare(a.at));

  return {
    updated: isoT(now), day0: isoT(day0), healthOk: !!msgs, waitMin: WAIT_MIN,
    centers, reply, activity: activity.slice(0, 40), system: adminSystem(env),
  };
}

function adminSystem(env) {
  const key = String(env.STRIPE_SECRET_KEY || ""), liveKey = String(env.STRIPE_LIVE_KEY || "");
  return {
    // "live" = a live key is set; it only takes payments for centers with "Stripe live" ticked.
    stripe: /^(sk|rk)_live_/.test(liveKey) ? "live" : /^(sk|rk)_live_/.test(key) ? "live" : key ? "test" : "missing",
    push: !!env.VAPID_PRIVATE, respondio: !!env.RESPONDIO_TOKEN, accessAud: !!env.ACCESS_AUD,
    alerts: !!env.ALERT_WEBHOOK, alertsTest: env.ALERT_INCLUDE_TEST === "1", budget: Number(env.CLAUDE_BUDGET_USD) || 0,
    base: String(env.AIRTABLE_BASE || ""),
  };
}

// Every conversation across the centers that the team can still answer (customer wrote in
// the last 24 h), built from the same per-center lists the zone uses (and caches).
async function adminInbox(env, fresh) {
  const centers = (await at(env, "Centers", { sort: [{ field: "Name" }] })).map(centerMeta)
    .filter((c) => /^[a-z0-9-]{1,60}$/.test(c.slug));
  const now = Date.now();
  const lists = await Promise.all(centers.map((c) =>
    cached(env, `conv/${c.slug}/open`, 20, () => conversations(env, c, "open"), fresh)
      .then((d) => d.conversations.map((x) => ({ ...x, slug: c.slug, center: c.name, test: c.test })))
      .catch(() => [])));
  const items = lists.flat().map((x) => {
    const waiting = x.previewDir === "Customer" && Date.parse(x.lastAt) < now - WAIT_MIN * 60000 && !x.teamActive;
    const { hay, ...rest } = x;
    return { ...rest, waiting };
  });
  items.sort((a, b) => (b.needsYou - a.needsYou) || (b.waiting - a.waiting) || (Date.parse(b.lastAt) - Date.parse(a.lastAt)));
  return { items, updated: isoT(now), waitMin: WAIT_MIN };
}

// Divers (name, phone, contact id) and bookings (ref, payer) across all centers.
async function adminSearch(env, raw) {
  const term = String(raw || "").trim().toLowerCase().slice(0, 60);
  if (term.length < 2) return { leads: [], bookings: [] };
  const digits = term.replace(/\D/g, "");
  const t = q(term);
  const leadF = [`FIND('${t}', LOWER({Name} & ''))`, `{External ID} & '' = '${t}'`];
  if (digits.length >= 4) leadF.push(`FIND('${digits}', REGEX_REPLACE({Contact} & '', '[^0-9]', ''))`);
  const [centerRecs, leads, books] = await Promise.all([
    at(env, "Centers"),
    at(env, "Leads", { formula: `OR(${leadF.join(", ")})`, max: 30 }),
    at(env, "Bookings", { formula: `OR(FIND('${t}', LOWER({Ref} & '')), FIND('${t}', LOWER({Payer name} & '')))`, max: 30 }),
  ]);
  const centers = centerRecs.map(centerMeta);
  const of = (r) => centers.find((c) => ownedBy(r, c)) || { slug: "", name: "?" };
  return {
    leads: leads.sort((a, b) => madeAt(b) - madeAt(a)).slice(0, 25).map((l) => {
      const f = l.fields, c = of(l);
      return {
        id: str(f, "External ID"), name: str(f, "Name"), contact: str(f, "Contact"), status: str(f, "Status"),
        language: str(f, "Language"), created: l.createdTime, slug: c.slug, center: c.name,
      };
    }),
    bookings: books.sort((a, b) => madeAt(b) - madeAt(a)).slice(0, 25).map((b) => bookingOut(b, of(b))),
  };
}

function bookingOut(b, c) {
  const f = b.fields;
  return {
    ref: str(f, "Ref"), created: b.createdTime, date: str(f, "Activity date"), product: str(f, "P name"),
    name: str(f, "Payer name"), divers: num(f["Group size"]) || 1, total: num(f["Total value THB"]),
    commission: commissionOf(b), refunded: num(f["Refunded THB"]), status: str(f, "Status") || "Confirmed",
    cancelled: cancelled(b), slug: c.slug, center: c.name, test: !!c.test,
  };
}

async function adminCenter(env, slug) {
  const c = (await allCenters(env)).find((x) => x.slug === slug);
  if (!c) return { error: "Onbekend center." };
  const now = Date.now();
  const since = `IS_AFTER(CREATED_TIME(), DATETIME_PARSE('${isoT(now - 30 * DAY)}'))`;
  const [f, set, leads, books] = await Promise.all([
    centerRecord(env, c),
    settings(env, c),
    at(env, "Leads", { formula: `AND(${ofCenter(c)}, ${since})`, max: 1000 }),
    at(env, "Bookings", { formula: `AND(${ofCenter(c)}, ${since})`, max: 1000 }),
  ]);
  return {
    slug, name: c.name, assistant: c.assistant, channel: c.channel, type: str(f, "Type"),
    paused: !!f["Mia paused"], logo: c.logo,
    settings: { staff: set.staff, admins: set.admins, alert: set.alert, hours: set.hoursText, outsideOnly: set.outsideOnly, info: set.info },
    products: set.products,
    leads: leads.sort((a, b) => madeAt(b) - madeAt(a)).slice(0, 30).map((l) => {
      const x = l.fields;
      return {
        id: str(x, "External ID"), name: str(x, "Name") || str(x, "Contact"), language: str(x, "Language"),
        status: str(x, "Status"), created: l.createdTime, handover: !!handedOver(l), team: !!x["Human took over"],
        outside: !!num(x["Outside hours"]), reply: firstReply(l),
      };
    }),
    bookings: books.sort((a, b) => madeAt(b) - madeAt(a)).slice(0, 30).map((b) => bookingOut(b, c)),
    log: String(f["Change log"] || "").split("\n").filter(Boolean).slice(0, 25),
  };
}

// All bookings made in one month (Koh Tao time), for the bookings list and commission.
async function adminBookings(env, month) {
  const { start, end, label, months } = periodRange(month);
  const [centerRecs, books] = await Promise.all([
    at(env, "Centers"),
    at(env, "Bookings", {
      formula: `AND(IS_AFTER(CREATED_TIME(), DATETIME_PARSE('${isoT(start - 1000)}')), IS_BEFORE(CREATED_TIME(), DATETIME_PARSE('${isoT(end)}')))`,
      max: 20000,
    }),
  ]);
  const centers = centerRecs.map(centerMeta);
  const of = (r) => centers.find((c) => ownedBy(r, c)) || { slug: "", name: "Zonder center", test: false };
  return {
    month, label, months, system: adminSystem(env),
    centers: centers.map((c) => ({ slug: c.slug, name: c.name, test: c.test })),
    bookings: books.sort((a, b) => madeAt(b) - madeAt(a)).map((b) => bookingOut(b, of(b))),
  };
}

// Sign-ups from talay.io/start (Airtable table "Intake"). Missing table = not set up yet.
async function adminIntake(env) {
  try {
    const recs = await at(env, "Intake", { max: 200 });
    return {
      items: recs.sort((a, b) => madeAt(b) - madeAt(a)).map((r) => {
        const f = r.fields;
        return {
          id: r.id, centre: str(f, "Centre"), name: str(f, "Name"), email: str(f, "Email"),
          whatsapp: str(f, "WhatsApp"), status: str(f, "Status") || "New", summary: str(f, "Summary"),
          received: str(f, "Received") || r.createdTime,
        };
      }),
    };
  } catch (e) {
    if (/NOT_FOUND|404|INVALID_PERMISSIONS|403/.test(String(e.message))) return { missing: true, items: [] };
    throw e;
  }
}
async function adminIntakeStatus(env, body) {
  const status = ["New", "In progress", "Live", "Declined"].find((s) => s === body.status);
  if (!status || !/^rec[A-Za-z0-9]{10,20}$/.test(String(body.id || ""))) return json({ error: "Bad request" }, 400);
  try { await atPatch(env, "Intake", body.id, { Status: status }); }
  catch (e) { console.error("intake", e); return json({ error: "Opslaan lukte niet." }, 502); }
  return json({ ok: true, status });
}

async function adminTeam(env) {
  const owners = splitEmails(env.SUPERADMIN_EMAILS || "jonas@talay.io");
  let rows = [], missing = false;
  try { rows = await at(env, "HQ team", { max: 200 }); } catch (e) { missing = true; }
  const members = rows.map((r) => ({
    id: r.id, email: str(r.fields, "Email").trim().toLowerCase(), name: str(r.fields, "Name"),
    role: /owner/i.test(str(r.fields, "Role")) ? "Owner" : "Staff", added: r.createdTime,
  })).filter((m) => m.email);
  return { owners, members, missing };
}
async function adminTeamChange(env, email, b) {
  const EMAILRE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
  const role = HQ_ROLES.find((r) => r === b.role) || "Staff";
  try {
    if (b.action === "add") {
      const e = String(b.email || "").trim().toLowerCase();
      if (!EMAILRE.test(e)) return json({ error: "Geef één geldig e-mailadres." }, 400);
      const { members } = await adminTeam(env);
      if (members.some((m) => m.email === e)) return json({ error: "Dit adres staat al in het team." }, 400);
      await atWrite(env, "HQ team", "POST", [{ fields: { Email: e, Name: String(b.name || "").slice(0, 80), Role: role } }]);
    } else if (b.action === "role" && /^rec[A-Za-z0-9]{10,20}$/.test(String(b.id || ""))) {
      await atPatch(env, "HQ team", b.id, { Role: role });
    } else if (b.action === "remove" && /^rec[A-Za-z0-9]{10,20}$/.test(String(b.id || ""))) {
      const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent("HQ team")}/${b.id}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` },
      });
      if (!res.ok) throw new Error(`Airtable DELETE: ${res.status}`);
    } else {
      return json({ error: "Onbekende actie." }, 400);
    }
  } catch (e) {
    console.error("hq team", e);
    if (/NOT_FOUND|404/.test(String(e.message))) return json({ error: "De tabel HQ team bestaat nog niet in Airtable." }, 500);
    return json({ error: "Opslaan lukte niet. Probeer opnieuw." }, 502);
  }
  return json({ ok: true });
}

// ---------- Pijplijn: the dive centers Talay is talking to ----------
// Airtable table "Prospects": Name (primary), Stage (To contact, Pitched, Talking, Trial,
// Signed, Live, No), Priority (number), Area, Language, Contact person, WhatsApp, Email,
// Instagram, Owner (who at Talay follows up), Next step, Next date (date), Last contact (date),
// Notes (long text, newest line first). Stage options are made by typecast when missing.
const STAGES = ["To contact", "Pitched", "Talking", "Trial", "Signed", "Live", "No"];
const STAGE_NL = { "To contact": "Te benaderen", Pitched: "Gepitcht", Talking: "In gesprek", Trial: "Proef", Signed: "Getekend", Live: "Live", No: "Nee" };
const PROSPECT_TEXT = {
  area: "Area", language: "Language", contact: "Contact person", whatsapp: "WhatsApp", email: "Email",
  instagram: "Instagram", owner: "Owner", next: "Next step",
};
const thaiDay = (ms) => new Date(ms + TZ_MS).toISOString().slice(0, 10);
const thaiStamp = (ms) => new Date(ms + TZ_MS).toISOString().slice(0, 16).replace("T", " ");
const missingTable = (e) => /NOT_FOUND|404|INVALID_PERMISSIONS|403/.test(String(e && e.message));

function prospectOut(r) {
  const f = r.fields, out = { id: r.id, name: str(f, "Name"), created: r.createdTime };
  out.stage = STAGES.find((s) => s === str(f, "Stage")) || "To contact";
  out.priority = num(f["Priority"]) || null;
  for (const [k, field] of Object.entries(PROSPECT_TEXT)) out[k] = str(f, field);
  out.nextDate = str(f, "Next date").slice(0, 10);
  out.last = str(f, "Last contact").slice(0, 10);
  out.notes = str(f, "Notes");
  return out;
}
async function adminPipeline(env) {
  try {
    const recs = await at(env, "Prospects", { max: 2000 });
    return { today: thaiDay(Date.now()), items: recs.map(prospectOut).filter((p) => p.name) };
  } catch (e) {
    if (missingTable(e)) return { missing: true, today: thaiDay(Date.now()), items: [] };
    throw e;
  }
}
// add: a new center; update: any of the fields above, plus "note" (added on top of Notes,
// with date and who, and Last contact = today). A stage change is noted in Notes too.
async function adminPipelineChange(env, email, b) {
  const now = Date.now(), who = email.split("@")[0], fields = {};
  if (b.stage !== undefined) {
    if (!STAGES.includes(b.stage)) return json({ error: "Onbekende fase." }, 400);
    fields["Stage"] = b.stage;
  }
  for (const [k, field] of Object.entries(PROSPECT_TEXT)) if (b[k] !== undefined) fields[field] = String(b[k] ?? "").trim().slice(0, 500);
  if (b.nextDate !== undefined) {
    const d = String(b.nextDate || "");
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return json({ error: "Datum klopt niet." }, 400);
    fields["Next date"] = d || null;
  }
  if (b.priority !== undefined) fields["Priority"] = Number(b.priority) || null;
  const note = String(b.note || "").trim().slice(0, 2000);
  try {
    if (b.action === "add") {
      const name = String(b.name || "").trim().slice(0, 120);
      if (!name) return json({ error: "Geef de naam van het center." }, 400);
      const { items } = await adminPipeline(env);
      if (items.some((p) => p.name.toLowerCase() === name.toLowerCase())) return json({ error: "Dit center staat al in de pijplijn." }, 400);
      fields["Name"] = name;
      fields["Stage"] = fields["Stage"] || "To contact";
      if (note) { fields["Notes"] = `${thaiStamp(now)} ${who}: ${note}`; fields["Last contact"] = thaiDay(now); }
      await atWrite(env, "Prospects", "POST", [{ fields }]);
    } else if (b.action === "update" && okRec(b.id)) {
      const cur = await at(env, "Prospects", { formula: `RECORD_ID() = '${b.id}'`, max: 1 });
      if (!cur.length) return json({ error: "Dit center bestaat niet meer." }, 404);
      const old = prospectOut(cur[0]), lines = [];
      if (fields["Stage"] && fields["Stage"] !== old.stage) lines.push(`${thaiStamp(now)} ${who}: fase ${STAGE_NL[old.stage]} → ${STAGE_NL[fields["Stage"]]}`);
      if (note) { lines.unshift(`${thaiStamp(now)} ${who}: ${note}`); fields["Last contact"] = thaiDay(now); }
      if (lines.length) fields["Notes"] = (lines.join("\n") + (old.notes ? "\n" + old.notes : "")).slice(0, 90000);
      if (Object.keys(fields).length) await atPatch(env, "Prospects", b.id, fields);
    } else {
      return json({ error: "Onbekende actie." }, 400);
    }
  } catch (e) {
    console.error("pipeline", e);
    if (missingTable(e)) return json({ error: "De tabel Prospects bestaat nog niet in Airtable." }, 500);
    return json({ error: "Opslaan lukte niet. Probeer opnieuw." }, 502);
  }
  return json({ ok: true });
}

// ---------- Pijplijn: Claude proposes the next step ----------
// Claude never sends anything. It drafts the next message (mode "next") or reads a reply that
// Jonas pasted (mode "reply"), and proposes stage, next step, date and owner. HQ shows the
// proposal; Jonas sends the message himself and takes the proposal over with one click.
// Needs the Cloudflare secret ANTHROPIC_API_KEY.
const MAX_NUDGES = 1; // reminders by message after the pitch without an answer; then John visits
const SENT_RE = /\[verstuurd\]/, REPLY_RE = /\[antwoord\]/; // tags HQ writes in Notes
const PROSPECT_KINDS = ["interested", "question", "later", "no", "human_touch", "no_real_answer", "none"];
const PROSPECT_PROMPT = `You help Jonas, founder of Talay, follow up with dive centres on Koh Tao (Thailand). Talay is an assistant made only for dive centres: it answers their WhatsApp, Instagram and Facebook messages in seconds, under their own name, based on their own courses, prices, schedules and rules, with a booking link with a deposit.

What Jonas may say (and nothing else about money): free, dashboard included; switch it on and off any time; direct bookings stay exactly as they are; nothing changes in how they work; only a small commission on bookings that come in through Talay, otherwise nothing; built only for diving; parameters set per centre; "we're choosing our first pilot centres now". Never write a percentage or a price. Never claim existing pilots or customers. A "night mode" exists: Talay can answer only outside office hours, so the team keeps every daytime chat. The demo centre is Ridgefin Divers: WhatsApp +32 456 90 00 33 or Instagram @ridgefin.divers, anyone can message the assistant Mia as if they were a diver. Mystery-shop finding on Koh Tao: messages sent at night waited about 7 hours for a real answer.

Koh Tao is small and personal. Several centres said no because they prefer the human touch or "do it ourselves". So: write like one person to another, short (2 to 5 sentences), warm, no marketing tone, no emojis unless the centre used them, no bullet points, no links except the demo when it helps. Start with something specific to that centre when the notes give you something. Sign as Jonas only in an e-mail. Write in the centre's language (field Language; English when unknown). For a "no" or "human touch": thank them, respect it, mention the night-only mode at most once, and leave the door open; no further chasing. After the pitch, at most ${MAX_NUDGES} reminder by message; when that got no answer, the next step is a visit by John (he visits centres in person from 26 October 2026), not another message. Jonas himself is on Koh Tao from early November 2026.

Channel: prefer the channel already used in the notes; otherwise WhatsApp when a number is known, then Instagram, then e-mail. Choose "Visit" when the next step is John (or Jonas) going by; then the message is a short briefing in Dutch for John instead of a message to the centre.

Return: summary (Dutch, 1 or 2 sentences: what is going on and why this step), kind (for mode "reply": how the reply reads; "no_real_answer" for an auto-reply, a "seen" or something off-topic; for mode "next": "none"), stage, next (the next step in Dutch, short, like "John gaat langs" or "Wachten op antwoord, dan John"), days (days from today until the next action; 0 = today), owner (Jonas or John), channel, message (the text to send, ready to paste; empty when nothing should be sent).`;
const PROSPECT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["summary", "kind", "stage", "next", "days", "owner", "channel", "message"],
  properties: {
    summary: { type: "string" }, kind: { type: "string", enum: PROSPECT_KINDS }, stage: { type: "string", enum: STAGES },
    next: { type: "string" }, days: { type: "integer" }, owner: { type: "string", enum: ["Jonas", "John"] },
    channel: { type: "string", enum: ["WhatsApp", "Instagram", "Email", "Visit"] }, message: { type: "string" },
  },
};
// Reminders sent since the last reply, read from Notes (newest line first).
function nudgesSinceReply(notes) {
  let n = 0;
  for (const line of String(notes || "").split("\n")) {
    if (REPLY_RE.test(line)) break;
    if (SENT_RE.test(line)) n++;
  }
  return n;
}
async function adminPipelineAi(env, b) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "Claude is nog niet gekoppeld: zet het geheim ANTHROPIC_API_KEY in Cloudflare." }, 500);
  if (!okRec(b.id)) return json({ error: "Onbekend center." }, 400);
  const mode = b.mode === "reply" ? "reply" : "next";
  const reply = String(b.reply || "").trim().slice(0, 4000);
  if (mode === "reply" && !reply) return json({ error: "Plak eerst het antwoord van het center." }, 400);
  let p;
  try {
    const cur = await at(env, "Prospects", { formula: `RECORD_ID() = '${b.id}'`, max: 1 });
    if (!cur.length) return json({ error: "Dit center bestaat niet meer." }, 404);
    p = prospectOut(cur[0]);
  } catch (e) {
    console.error("pipeline ai", e);
    return json({ error: "Airtable gaf een fout. Probeer opnieuw." }, 502);
  }
  const today = thaiDay(Date.now());
  const card = [
    `Today (Koh Tao): ${today}`, `Mode: ${mode}`, `Centre: ${p.name}`, `Stage: ${p.stage}`, `Area: ${p.area || "-"}`, `Language: ${p.language || "-"}`,
    `Contact person: ${p.contact || "-"}`, `Known channels: ${[p.whatsapp && "WhatsApp", p.instagram && "Instagram", p.email && "Email"].filter(Boolean).join(", ") || "none"}`,
    `Who follows up: ${p.owner || "-"}`, `Next step now: ${p.next || "-"} (${p.nextDate || "no date"})`, `Last contact: ${p.last || "-"}`,
    `Reminders sent since the last reply (logged in HQ): ${nudgesSinceReply(p.notes)}`,
    `Notes (newest first):\n${p.notes.slice(0, 6000) || "-"}`,
  ];
  if (mode === "reply") card.push(`\nThe centre just replied:\n"""${reply}"""`);
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2026-10-21" },
      body: JSON.stringify({
        model: "claude-opus-5-5", max_tokens: 4000, system: PROSPECT_PROMPT,
        output_config: { effort: "low", format: { type: "json_schema", schema: PROSPECT_SCHEMA } },
        messages: [{ role: "user", content: card.join("\n") }],
      }),
    });
  } catch (e) {
    return json({ error: "Claude is niet bereikbaar. Probeer opnieuw." }, 502);
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("pipeline ai", r.status, JSON.stringify(d).slice(0, 500));
    const credit = /credit|balance/i.test(String(d.error && d.error.message));
    return json({ error: credit ? "Het API-tegoed van Claude is op." : `Claude gaf een fout (${r.status}).` }, 502);
  }
  if (d.stop_reason === "refusal") return json({ error: "Claude wilde hier geen voorstel voor maken." }, 502);
  let out;
  try { out = JSON.parse((d.content || []).filter((c) => c.type === "text").map((c) => c.text).join("")); } catch (e) { out = null; }
  if (!out) return json({ error: "Claude gaf geen bruikbaar voorstel. Probeer opnieuw." }, 502);
  const days = Math.max(0, Math.min(120, Number(out.days) || 0));
  out.nextDate = thaiDay(Date.now() + days * 864e5);
  out.mode = mode;
  return json(out);
}

// ---------- Mailcampagne: cold mail from Instantly, followed up in HQ ----------
// Airtable table "Outreach" (made from the campaign CSV): Email, Company, Lead ID, Campaign, Wave,
// Region, Country, Town, Status, Step, Last event, Last event at, Reply, Interest, Notes. The cron
// copies each lead's state from the Instantly API (key INSTANTLY_API_KEY, scope all:read) into
// Status, Interest, Last event (at) and Reply. Nothing is sent from here: Jonas answers in the
// Instantly Unibox, and the interest label he sets there comes back as Interest.
const OUTREACH_STATUSES = ["Interested", "Replied", "Out of office", "Wrong person", "Not interested", "Bounced", "Unsubscribed", "Sent", "No reply", "Queued", "Skipped"];
const INTEREST = { 1: "Interested", 2: "Meeting booked", 3: "Meeting completed", 4: "Won", 0: "Out of office", "-1": "Not interested", "-2": "Wrong person", "-3": "Lost", "-4": "No show" };
const OUTREACH_WRITES = 15; // Airtable batches of 10 per run: the cron shares its subrequests with the alerts

async function instantly(env, path, body) {
  const opt = { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${env.INSTANTLY_API_KEY}`, "Content-Type": "application/json" } };
  if (body) opt.body = JSON.stringify(body);
  let res = await fetch("https://api.instantly.ai/api/v2/" + path, opt);
  if (res.status === 429) { await new Promise((r) => setTimeout(r, 3000)); res = await fetch("https://api.instantly.ai/api/v2/" + path, opt); }
  if (!res.ok) throw new Error(`Instantly ${path.split("?")[0]}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
function outreachStatus(l) {
  if (l.status === -1) return "Bounced";
  if (l.status === -2) return "Unsubscribed";
  const i = l.lt_interest_status;
  if (i >= 1 && i <= 4) return "Interested";
  if (i === 0 && l.email_reply_count > 0) return "Out of office"; // 0 can also mean "no label yet"
  if (i === -2) return "Wrong person";
  if (i <= -1) return "Not interested";
  if (l.email_reply_count > 0) return "Replied";
  if (l.status === 3) return "No reply";
  if (l.timestamp_last_contact) return "Sent";
  if (l.status === -3) return "Skipped";
  return "Queued";
}
const outreachTime = (iso) => (iso ? thaiStamp(Date.parse(iso)) : "");

export async function runOutreachSync(env) {
  if (!env.INSTANTLY_API_KEY || !env.AIRTABLE_TOKEN) return { skipped: true };
  const camps = ((await instantly(env, "campaigns?limit=100")).items || []).filter((c) => !/\bTEST\b/.test(c.name || "")); // "Talay TEST" = own addresses ("W1b ID-Test" is a real campaign)
  const leads = new Map();
  for (const c of camps) {
    let after = "";
    for (let page = 0; page < 20; page++) {
      const d = await instantly(env, "leads/list", { campaign: c.id, limit: 100, ...(after ? { starting_after: after } : {}) });
      for (const l of d.items || []) if (l.email) leads.set(l.email.toLowerCase(), { ...l, campaignName: c.name });
      after = d.next_starting_after || "";
      if (!after || !(d.items || []).length) break;
    }
  }
  // The latest received mail per lead (one page: replies come in slowly, the cron runs every 15 minutes).
  const replies = new Map();
  try {
    const d = await instantly(env, "emails?email_type=received&limit=100&sort_order=desc");
    for (const m of d.items || []) {
      const k = String(m.lead || "").toLowerCase();
      if (k && leads.has(k) && !replies.has(k)) replies.set(k, String(m.content_preview || (m.body && m.body.text) || m.subject || "").replace(/\s+/g, " ").trim().slice(0, 1000));
    }
  } catch (e) { console.error("outreach replies", e); }

  const rows = await at(env, "Outreach", { max: 10000 });
  const byEmail = new Map(rows.map((r) => [str(r.fields, "Email").trim().toLowerCase(), r]));
  const patches = [], adds = [], news = [];
  for (const [email, l] of leads) {
    const status = outreachStatus(l), replied = !!l.timestamp_last_reply;
    const f = {
      "Status": status, "Campaign": l.campaignName,
      "Interest": l.lt_interest_status != null && (l.lt_interest_status !== 0 || l.email_reply_count > 0) ? INTEREST[l.lt_interest_status] || String(l.lt_interest_status) : "",
      "Last event": replied ? "Replied" : l.timestamp_last_contact ? "Mail sent" : "",
      "Last event at": outreachTime(l.timestamp_last_reply || l.timestamp_last_contact),
    };
    if (replies.has(email)) f["Reply"] = replies.get(email);
    const r = byEmail.get(email);
    if (!r) { adds.push({ fields: { "Email": l.email, "Company": l.company_name || "", ...f } }); continue; }
    const ch = {};
    for (const [k, v] of Object.entries(f)) if (str(r.fields, k) !== v) ch[k] = v;
    if (!Object.keys(ch).length) continue;
    if (ch["Status"] && ["Interested", "Replied"].includes(status) && !["Interested", "Replied"].includes(str(r.fields, "Status")))
      news.push({ company: str(r.fields, "Company") || email, status, reply: f["Reply"] || "" });
    patches.push({ id: r.id, fields: ch });
  }
  let batches = 0;
  for (let i = 0; i < patches.length && batches < OUTREACH_WRITES; i += 10, batches++) await atWrite(env, "Outreach", "PATCH", patches.slice(i, i + 10));
  for (let i = 0; i < adds.length && batches < OUTREACH_WRITES; i += 10, batches++) await atWrite(env, "Outreach", "POST", adds.slice(i, i + 10));
  if (news.length && env.ALERT_WEBHOOK) {
    const subject = news.length === 1 ? `Talay HQ: antwoord van ${news[0].company}` : `Talay HQ: ${news.length} nieuwe antwoorden op de mailcampagne`;
    const text = news.map((n) => `- ${n.company} (${n.status}): ${n.reply.slice(0, 300)}`).join("\n") + "\n\nAntwoorden in de Instantly Unibox, opvolgen in https://talay.io/zone/admin#/mail";
    const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#09262F">` + news.map((n) => `<p style="margin:0 0 14px"><b>${esc(n.company)}</b> · ${esc(n.status)}<br>${esc(n.reply.slice(0, 300))}</p>`).join("") +
      `<p>Antwoorden doe je in de Instantly Unibox. Opvolgen: <a href="https://talay.io/zone/admin#/mail">Talay HQ → Mailcampagne</a></p></div>`;
    await sendAlerts(env, { subject, text, html, count: news.length, alerts: [] }).catch((e) => console.error("outreach alert", e));
  }
  await forget(env, ["admin/outreach"]);
  return { leads: leads.size, patched: Math.min(patches.length, OUTREACH_WRITES * 10), added: adds.length, left: Math.max(0, patches.length + adds.length - batches * 10), news: news.length };
}

function outreachOut(r) {
  const f = r.fields, out = { id: r.id };
  for (const [k, field] of Object.entries({ email: "Email", company: "Company", lead: "Lead ID", campaign: "Campaign", wave: "Wave", region: "Region", country: "Country", town: "Town", status: "Status", interest: "Interest", event: "Last event", eventAt: "Last event at", reply: "Reply", notes: "Notes" }))
    out[k] = str(f, field);
  if (!OUTREACH_STATUSES.includes(out.status)) out.status = "Queued";
  out.inPipeline = /\[pijplijn\]/.test(out.notes);
  return out;
}
async function adminOutreach(env, fresh) {
  try {
    return await cached(env, "admin/outreach", 120, async () => {
      const recs = await at(env, "Outreach", { max: 10000 });
      return { items: recs.map(outreachOut).filter((o) => o.email), synced: !!env.INSTANTLY_API_KEY };
    }, fresh);
  } catch (e) {
    if (missingTable(e)) return { missing: true, items: [], synced: !!env.INSTANTLY_API_KEY };
    throw e;
  }
}
// sync: run the Instantly sync now. pipeline: put this center in Pijplijn (Prospects, stage Talking)
// with the reply in its notes, and mark the Outreach row with [pijplijn]. note: add a dated line.
async function adminOutreachChange(env, email, b) {
  const now = Date.now(), who = email.split("@")[0];
  try {
    if (b.action === "sync") {
      if (!env.INSTANTLY_API_KEY) return json({ error: "De Instantly-sleutel (INSTANTLY_API_KEY) staat nog niet in Cloudflare." }, 400);
      return json({ ok: true, ...(await runOutreachSync(env)) });
    }
    if (!okRec(b.id)) return json({ error: "Onbekende rij." }, 400);
    const cur = await at(env, "Outreach", { formula: `RECORD_ID() = '${b.id}'`, max: 1 });
    if (!cur.length) return json({ error: "Deze rij bestaat niet meer." }, 404);
    const o = outreachOut(cur[0]);
    const line = (t) => `${thaiStamp(now)} ${who}: ${t}`;
    if (b.action === "note") {
      const note = String(b.note || "").trim().slice(0, 2000);
      if (!note) return json({ error: "Schrijf eerst een notitie." }, 400);
      await atPatch(env, "Outreach", b.id, { "Notes": (line(note) + (o.notes ? "\n" + o.notes : "")).slice(0, 90000) });
    } else if (b.action === "pipeline") {
      if (o.inPipeline) return json({ error: "Dit center staat al in de pijplijn." }, 400);
      const name = o.company || o.email;
      const { items } = await adminPipeline(env);
      const old = items.find((p) => p.name.toLowerCase() === name.toLowerCase());
      const note = line(`[antwoord] via mailcampagne (${o.campaign}): ${(o.reply || o.status).slice(0, 600)}`);
      if (old) await atPatch(env, "Prospects", old.id, { "Stage": "Talking", "Email": old.email || o.email, "Last contact": thaiDay(now), "Notes": (note + (old.notes ? "\n" + old.notes : "")).slice(0, 90000) });
      else await atWrite(env, "Prospects", "POST", [{ fields: { "Name": name, "Stage": "Talking", "Email": o.email, "Area": [o.town, o.country].filter(Boolean).join(", "), "Next step": "Antwoord opvolgen", "Next date": thaiDay(now), "Last contact": thaiDay(now), "Notes": note } }]);
      await atPatch(env, "Outreach", b.id, { "Notes": (line("[pijplijn] naar Pijplijn gezet") + (o.notes ? "\n" + o.notes : "")).slice(0, 90000) });
    } else {
      return json({ error: "Onbekende actie." }, 400);
    }
  } catch (e) {
    console.error("outreach", e);
    if (missingTable(e)) return json({ error: "De tabel Outreach (of Prospects) bestaat nog niet in Airtable." }, 500);
    return json({ error: "Dat lukte niet: " + String(e.message).slice(0, 200) }, 502);
  }
  await forget(env, ["admin/outreach"]);
  return json({ ok: true });
}

// ---------- Conversie: from question to booking, per center ----------
// The same numbers as the dashboard in each center's zone (and the same cache).
async function hqCenters(env) {
  const recs = await at(env, "Centers", { sort: [{ field: "Name" }] });
  return recs.map((r) => ({ ...centerOut(r, true), ...centerMeta(r), outsideOnly: !!r.fields["Outside hours only"], paused: !!r.fields["Mia paused"] }))
    .filter((c) => /^[a-z0-9-]{1,60}$/.test(c.slug));
}
async function adminConversion(env, per, fresh) {
  const centers = await hqCenters(env);
  const { label, months } = periodRange(per);
  const rows = await Promise.all(centers.map(async (c) => {
    try {
      const d = await cached(env, `dash/v5/${c.slug}/${per || "30d"}`, 120, () => dashboard(env, c, per), fresh);
      const k = d.kpi || {};
      return {
        slug: c.slug, name: c.name, type: c.type, test: c.test, funnel: d.funnel,
        conversations: k.conversations || 0, outsideHours: k.outsideHours || 0, handedOver: k.handedOver || 0,
        bookings: k.bookings || 0, divers: k.divers || 0, afterFollowUp: k.afterFollowUp || 0,
        value: k.revenue || 0, commission: k.commission || 0,
      };
    } catch (e) {
      console.error("conversion", c.slug, e);
      return { slug: c.slug, name: c.name, type: c.type, test: c.test, error: true };
    }
  }));
  return { period: per || "30d", label: per ? label : "Laatste 30 dagen", months, centers: rows };
}

// ---------- Claude costs, from the Log table ----------
// Make (inbound v2, Airtable 51 "Create in Log") writes per message: Center (slug) and from the
// Anthropic call: Input tokens, Cache read tokens, Cache write tokens, Output tokens.
// Older rows without Center are matched to a center through Leads → External ID.
// Prices of claude-sonnet-5-5 in USD per million tokens (cache write = 5-minute cache).
const CLAUDE_PRICE = { input: 2, write: 2.5, read: 0.2, output: 10 };
const THB_PER_USD = 33; // rough, only to compare with the commission in baht
const usdOf = (t) => (t.input * CLAUDE_PRICE.input + t.write * CLAUDE_PRICE.write + t.read * CLAUDE_PRICE.read + t.output * CLAUDE_PRICE.output) / 1e6;
async function adminCosts(env, month) {
  const now = Date.now();
  const cur = thaiMonth(now), m = /^\d{4}-\d{2}$/.test(month || "") ? month : cur;
  const { start, end, months } = periodRange(m);
  const stop = Math.min(end, now);
  const inP = `IS_AFTER(CREATED_TIME(), DATETIME_PARSE('${isoT(start - 1000)}')), IS_BEFORE(CREATED_TIME(), DATETIME_PARSE('${isoT(end)}'))`;
  const [centers, logs, leads, books] = await Promise.all([
    hqCenters(env),
    at(env, "Log", { formula: `AND(${inP})`, max: 50000 }),
    at(env, "Leads", { formula: `IS_AFTER(CREATED_TIME(), DATETIME_PARSE('${isoT(start - 90 * DAY)}'))`, max: 50000 }),
    at(env, "Bookings", { formula: `AND(${inP})`, max: 20000 }),
  ]);
  const bySlug = {};
  centers.forEach((c) => { bySlug[c.slug] = c; });
  const leadCenter = {};
  leads.forEach((l) => {
    const c = centers.find((x) => ownedBy(l, x)), id = str(l.fields, "External ID");
    if (c && id && !leadCenter[id]) leadCenter[id] = c.slug;
  });
  const zero = () => ({ calls: 0, tracked: 0, input: 0, read: 0, write: 0, output: 0 });
  const per = {}, days = Math.max(1, Math.ceil((end - start) / DAY)), daily = Array.from({ length: days }, () => 0);
  for (const r of logs) {
    const f = r.fields;
    const slug = String(first(f["Center"]) || "").toLowerCase() || leadCenter[str(f, "Contact")] || "";
    const k = bySlug[slug] ? slug : "";
    const t = per[k] = per[k] || zero();
    t.calls++;
    const u = { input: num(f["Input tokens"]), read: num(f["Cache read tokens"]), write: num(f["Cache write tokens"]), output: num(f["Output tokens"]) };
    if (u.input + u.read + u.write + u.output > 0) {
      t.tracked++; t.input += u.input; t.read += u.read; t.write += u.write; t.output += u.output;
      const i = Math.floor((madeAt(r) - start) / DAY);
      if (i >= 0 && i < days) daily[i] += usdOf(u);
    }
  }
  const rows = centers.map((c) => {
    const t = per[c.slug] || zero();
    const ls = leads.filter((l) => ownedBy(l, c) && madeAt(l) >= start && madeAt(l) < end);
    const bs = books.filter((b) => ownedBy(b, c) && !cancelled(b));
    return { slug: c.slug, name: c.name, type: c.type, test: c.test, ...t, usd: usdOf(t),
      conversations: ls.length, bookings: bs.length, commission: bs.reduce((a, b) => a + commissionOf(b), 0) };
  });
  if (per[""]) rows.push({ slug: "", name: "Zonder center", type: "", test: false, ...per[""], usd: usdOf(per[""]), conversations: 0, bookings: 0, commission: 0 });
  const budget = Number(env.CLAUDE_BUDGET_USD) || 0;
  return {
    month: m, months, current: m === cur, day0: isoT(start), days: Math.ceil((stop - start) / DAY), daily,
    price: CLAUDE_PRICE, thbPerUsd: THB_PER_USD, budget, centers: rows,
  };
}

// ---------- Alerts (e-mail through Make) ----------
// Every 15 minutes (Cloudflare cron, see wrangler.jsonc) Talay HQ looks for:
//   - a handover nobody picked up: Handover at more than 30 min ago, no team reply, not handled;
//   - the assistant's "sorry" message (Anthropic credit or Make failing);
//   - a diver without any answer for 30 min (not for centers in outside-hours mode, and not
//     after a short "ok" or "thanks");
//   - once a day at 08:00 Koh Tao time: Claude costs this month above 80% of CLAUDE_BUDGET_USD.
// Each run only reports what crossed its limit in the last 15 minutes, so nothing is sent twice
// and nothing needs to be remembered. New alerts are POSTed as one JSON message to
// ALERT_WEBHOOK (a Make custom webhook, which sends the e-mail). Without ALERT_WEBHOOK it does
// nothing. Demo and Test centers only count with ALERT_INCLUDE_TEST = 1.
const ALERT_EVERY = 15 * 60000, ALERT_HANDOVER_MIN = 30, ALERT_WAIT_MIN = 30;
const SMALL_TALK = /^(ok(ay)?|oke|k|thanks?( you)?|thx|ty|merci|danke|gracias|dank ?je(wel)?|bedankt|perfect|great|cool|super|top|nice|👍|🙏|❤️|😊|🙂)[\s!.👍🙏😊🙂❤️]*$/i;
async function hqAlerts(env, at0, { since, withTest = false } = {}) {
  const from = since || at0 - ALERT_EVERY;
  const [centers, leads, chat] = await Promise.all([
    hqCenters(env),
    at(env, "Leads", { formula: `IS_AFTER({Handover at}, DATETIME_PARSE('${isoT(from - ALERT_HANDOVER_MIN * 60000 - 60000)}'))`, max: 500 }),
    at(env, "Chat", {
      formula: `IS_AFTER({Sent at}, DATETIME_PARSE('${isoT(from - Math.max(ALERT_HANDOVER_MIN, ALERT_WAIT_MIN) * 60000 - 3 * 3600000)}'))`,
      fields: ["Direction", "Contact ID", "Center", "Sent at", "Text"], sort: [{ field: "Sent at" }], max: 5000,
    }),
  ]);
  const use = centers.filter((c) => withTest || !c.test);
  const bySlug = {};
  use.forEach((c) => { bySlug[c.slug] = c; });
  const of = (r) => use.find((c) => ownedBy(r, c));
  const crossed = (t, min) => t && t + min * 60000 >= from && t + min * 60000 < at0;
  const msgs = {};
  chat.forEach((m) => {
    const slug = String(m.fields["Center"] || "").toLowerCase(), id = String(m.fields["Contact ID"] || "");
    if (bySlug[slug] && id) (msgs[slug + "/" + id] = msgs[slug + "/" + id] || []).push(m);
  });
  const leadOf = {};
  const alerts = [];
  for (const l of leads) {
    const c = of(l), f = l.fields, id = str(f, "External ID");
    if (!c || !id) continue;
    leadOf[c.slug + "/" + id] = l;
    if (f["Seed at"]) continue; // demo data (script "Demodata Ridgefin"), not a real diver
    const t = msOf(f["Handover at"]);
    if (!crossed(t, ALERT_HANDOVER_MIN) || f["Human took over"] || f["Opted out"] || msOf(f["Human took over at"]) >= t) continue;
    if (/booked|lost|closed|spam/i.test(str(f, "Status"))) continue;
    if ((msgs[c.slug + "/" + id] || []).some((m) => m.fields["Direction"] === "Team" && msOf(m.fields["Sent at"]) >= t)) continue;
    const asked = (msgs[c.slug + "/" + id] || []).filter((m) => m.fields["Direction"] === "Customer" && msOf(m.fields["Sent at"]) <= t + 60000).pop();
    alerts.push({ kind: "handover", center: c.name, slug: c.slug, id, test: c.test, at: isoT(t),
      name: str(f, "Name") || str(f, "Contact") || "Een duiker", question: String(asked?.fields["Text"] || ""),
      text: `${str(f, "Name") || "Een duiker"} wacht al ${ALERT_HANDOVER_MIN} min op het team van ${c.name}.` });
  }
  for (const [k, list] of Object.entries(msgs)) {
    const [slug, id] = k.split("/"), c = bySlug[slug];
    list.forEach((m) => {
      const t = msOf(m.fields["Sent at"]);
      if (m.fields["Direction"] === "Mia" && t >= from && t < at0 && SORRY.test(String(m.fields["Text"] || "").trim()))
        alerts.push({ kind: "sorry", center: c.name, slug, id, test: c.test, at: isoT(t), text: `${c.assistant} stuurde het sorry-bericht bij ${c.name}. Kijk eerst naar het API-tegoed van Anthropic en Make (inbound v2).` });
    });
    if (c.paused || c.outsideOnly) continue;
    const last = list[list.length - 1], t = msOf(last.fields["Sent at"]), l = leadOf[k];
    if (last.fields["Direction"] !== "Customer" || !crossed(t, ALERT_WAIT_MIN)) continue;
    if (SMALL_TALK.test(String(last.fields["Text"] || "").trim())) continue;
    if (l && (l.fields["Human took over"] || l.fields["Opted out"])) continue;
    alerts.push({ kind: "waiting", center: c.name, slug, id, test: c.test, at: isoT(t),
      text: `Een duiker bij ${c.name} kreeg ${ALERT_WAIT_MIN} min geen antwoord: “${String(last.fields["Text"] || "").slice(0, 120)}”` });
  }
  // Claude budget, once a day in the run that starts at 08:00 Koh Tao time.
  const budget = Number(env.CLAUDE_BUDGET_USD) || 0, th = new Date(at0 + TZ_MS);
  if (budget && (since || (th.getUTCHours() === 8 && th.getUTCMinutes() < 15))) {
    const d = await adminCosts(env, thaiMonth(at0)).catch(() => null);
    const usd = d ? d.centers.reduce((a, c) => a + c.usd, 0) : 0;
    if (usd >= budget * 0.8) alerts.push({ kind: "budget", center: "", slug: "", at: isoT(at0),
      text: `Claude-kosten deze maand: $${usd.toFixed(2)} van een budget van $${budget} (${Math.round(usd / budget * 100)}%). Kijk het tegoed na in de Anthropic Console.` });
  }
  return alerts;
}
const ALERT_TITLE = { handover: "Overdracht zonder reactie", sorry: "Sorry-bericht", waiting: "Duiker zonder antwoord", budget: "Claude-budget" };
function alertMessage(alerts, test) {
  const link = (a) => a.slug && a.id ? `https://talay.io/zone?center=${encodeURIComponent(a.slug)}&c=${encodeURIComponent(a.id)}` : "https://talay.io/zone/admin";
  const subject = (test ? "[Test] " : "") + (alerts.length === 1 ? `Talay HQ: ${ALERT_TITLE[alerts[0].kind]}${alerts[0].center ? " bij " + alerts[0].center : ""}` : `Talay HQ: ${alerts.length} meldingen`);
  const text = alerts.map((a) => `- ${ALERT_TITLE[a.kind]}: ${a.text}\n  ${link(a)}`).join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#09262F">` +
    (test ? `<p style="color:#B4561B"><b>Test vanuit Talay HQ.</b> Hieronder wat er de laatste 24 uur gemeld zou zijn${alerts.length ? "" : " (niets)"}.</p>` : "") +
    alerts.map((a) => `<p style="margin:0 0 14px"><b>${esc(ALERT_TITLE[a.kind])}</b>${a.center ? " · " + esc(a.center) : ""}<br>${esc(a.text)}<br><a href="${esc(link(a))}">Open het gesprek</a></p>`).join("") +
    `<p style="color:#5B6B70;font-size:13px">Talay HQ · <a href="https://talay.io/zone/admin">talay.io/zone/admin</a></p></div>`;
  return { subject, text, html, count: alerts.length, alerts };
}
async function sendAlerts(env, msg) {
  const res = await fetch(env.ALERT_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) });
  if (!res.ok) throw new Error(`Alert webhook: ${res.status}`);
}
// Cloudflare cron (src/index.js → scheduled). Also the WhatsApp escalation and morning summary
// for the dive center teams (table Notify, see src/notify.js); those include demo and test centers.
export async function runHqAlerts(env, scheduledTime) {
  if (!env.AIRTABLE_TOKEN) return;
  const at0 = Math.floor((scheduledTime || Date.now()) / 60000) * 60000;
  const alerts = await hqAlerts(env, at0, { withTest: true });
  const hq = alerts.filter((a) => env.ALERT_INCLUDE_TEST === "1" || !a.test);
  if (env.ALERT_WEBHOOK && hq.length) await sendAlerts(env, alertMessage(hq, false));
  await teamEscalations(env, alerts, at0).catch((e) => console.error("escalation", e));
  await morningSummaries(env, at0).catch((e) => console.error("morning", e));
  await pausedWaitPush(env, at0).catch((e) => console.error("paused wait push", e));
}

// Mia is paused (the team took over) and the diver wrote again without an answer: one push to the
// center's phones when that wait crosses WAIT_MIN in this cron window (/zone/api/push-latest names the diver).
async function pausedWaitPush(env, at0) {
  if (!env.VAPID_PRIVATE) return;
  const centers = (await at(env, "Centers", { sort: [{ field: "Name" }] })).map(centerMeta)
    .filter((c) => /^[a-z0-9-]{1,60}$/.test(c.slug));
  for (const c of centers) {
    const d = await cached(env, `conv/${c.slug}/open`, 20, () => conversations(env, c, "open"), true).catch(() => null);
    const hit = (d?.conversations || []).some((x) => {
      const due = Date.parse(x.lastAt) + WAIT_MIN * 60000;
      return x.waitingMin > 0 && due >= at0 - ALERT_EVERY && due < at0;
    });
    if (hit) await pushToCenter(env, c.slug).catch((e) => console.error("push", c.slug, e));
  }
}

// ---------- Notifications for the dive center team (WhatsApp, table Notify) ----------
// Office hours from Centers → Escalation hours ("… 9:00 … 18:00"), in minutes since midnight.
function officeHours(f) {
  const hm = String(first(f["Escalation hours"]) || "").match(/(\d{1,2}):(\d{2}).*?(\d{1,2}):(\d{2})/);
  let open = hm ? (+hm[1]) * 60 + (+hm[2]) : 9 * 60, close = hm ? (+hm[3]) * 60 + (+hm[4]) : 18 * 60;
  if (close <= open) { open = 9 * 60; close = 18 * 60; }
  return { open, close };
}
const thaiMinutes = (ms) => { const t = new Date(ms + TZ_MS); return t.getUTCHours() * 60 + t.getUTCMinutes(); };

// A handover with no team reply after 30 minutes (the same check as the HQ alert), only within
// the center's office hours: template talay_still_waiting to everyone with the topic Escalation.
async function teamEscalations(env, alerts, at0) {
  const list = alerts.filter((a) => a.kind === "handover");
  if (!list.length) return;
  const centers = await at(env, "Centers", { formula: `OR(${[...new Set(list.map((a) => a.slug))].map((s) => `{Slug} = '${q(s)}'`).join(",")})` });
  for (const a of list) {
    const r = centers.find((c) => String(first(c.fields["Slug"]) || "").toLowerCase() === a.slug);
    if (!r) continue;
    const { open, close } = officeHours(r.fields), m = thaiMinutes(at0);
    if (m < open || m >= close) continue;
    const name = String(first(r.fields["Name"]) || a.center);
    const people = await teamFor(env, name, "Escalation");
    const link = `?center=${encodeURIComponent(a.slug)}&c=${encodeURIComponent(a.id)}`;
    const who = a.name === "Een duiker" ? "" : a.name;
    await whatsappTeam(env, people, (l) => template("talay_still_waiting",
      [name, who || WORDS[l].diver, ALERT_HANDOVER_MIN, a.question || WORDS[l].seeChat], link, l));
  }
}

// Every morning, in the run that starts 30 to 15 minutes before opening time: what happened
// while the team was off (template talay_morning, topic Morning summary). Skipped when nothing happened.
async function morningSummaries(env, at0) {
  const now = thaiMinutes(at0);
  if (now < 4 * 60 || now >= 12 * 60) return; // opening times are in the morning: no Centers call the rest of the day
  const recs = await at(env, "Centers", { formula: "{Slug} != ''" });
  for (const r of recs) {
    const { open } = officeHours(r.fields);
    if (now < open - 30 || now >= open - 15) continue;
    const center = centerOut(r, true);
    const people = await teamFor(env, center.name, "Morning summary");
    if (!people.length) continue;
    const today = thaiDate(at0);
    const [night, open2, boat] = await Promise.all([
      overnight(env, center),
      conversations(env, center, "open"),
      at(env, "Bookings", { formula: `AND(${ofCenter(center)}, DATETIME_FORMAT({Activity date}, 'YYYY-MM-DD') = '${today}')`, fields: ["Group size", "Status"], max: 500 }),
    ]);
    const onBoat = boat.filter((b) => !/cancel|refund/i.test(String(first(b.fields["Status"]) || "")))
      .reduce((a, b) => a + (Number(first(b.fields["Group size"])) || 1), 0);
    const waiting = open2.needsCount || 0;
    if (!night.conversations && !night.bookings && !waiting && !onBoat) continue;
    await whatsappTeam(env, people, (l) => {
      const w = WORDS[l], divers = (n) => `${n} ${n === 1 ? w.one : w.many}`;
      return template("talay_morning", [
        center.name,
        night.conversations,
        night.bookings ? `${night.bookings} (${Math.round(night.revenue).toLocaleString("en-US")} THB)` : w.none,
        waiting ? divers(waiting) : w.nobody,
        onBoat ? divers(onBoat) : w.noBoat,
      ], "", l);
    });
  }
}
// "Stuur een testmelding" on the Systeem page: the last 24 hours, demo and test included.
async function adminAlertTest(env) {
  if (!env.ALERT_WEBHOOK) return json({ error: "ALERT_WEBHOOK is nog niet ingesteld in Cloudflare." }, 400);
  const now = Date.now();
  try {
    const alerts = await hqAlerts(env, now, { since: now - DAY, withTest: true });
    await sendAlerts(env, alertMessage(alerts, true));
    return json({ ok: true, count: alerts.length });
  } catch (e) {
    console.error("alert test", e);
    return json({ error: "Versturen lukte niet: " + String(e.message || e).slice(0, 120) }, 502);
  }
}

const HQ_ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  centers: '<path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-7h6v7"/>',
  bookings: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  intake: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M9 14h6M9 18h4"/>',
  system: '<path d="M22 12h-4l-3 8-6-16-3 8H2"/>',
  team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  zone: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  out: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 17l5-5-5-5M15 12H3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  pipeline: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/>',
  funnel: '<path d="M3 4h18l-7 8v6l-4 2v-8z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  cost: '<circle cx="12" cy="12" r="9"/><path d="M15 9.2a3 3 0 0 0-3-1.7c-1.7 0-3 .9-3 2.2 0 3 6 1.6 6 4.6 0 1.3-1.3 2.2-3 2.2a3.2 3.2 0 0 1-3.2-1.8M12 6v1.5M12 16.5V18"/>',
};
const hqIcon = (k) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${HQ_ICONS[k]}</svg>`;

function adminApp(email, role) {
  const nav = [
    ["overzicht", "Overzicht", "home"], ["inbox", "Inbox", "inbox"], ["zoeken", "Zoeken", "search"],
    ["pijplijn", "Pijplijn", "pipeline"], ["mail", "Mailcampagne", "mail"], ["centra", "Centra", "centers"], ["conversie", "Conversie", "funnel"],
    ["boekingen", "Boekingen", "bookings"], ["commissie", "Commissie", "money"], ["kosten", "Claude-kosten", "cost"],
    ["aanmeldingen", "Aanmeldingen", "intake"], ["systeem", "Systeem", "system"],
  ];
  if (role === "owner") nav.push(["team", "Team", "team"]);
  const cfg = { email, role, icons: HQ_ICONS };
  return `<!doctype html><html lang="nl"><head>${HEAD}
<title>Talay HQ</title>
<link rel="icon" type="image/png" href="/zone/icon-192.png">
<meta name="theme-color" content="#09262F">
<style>
:root{--deep:#09262F;--paper:#F7F3EA;--paper-2:#FBF8F2;--card:#fff;--muted:#5B6B70;--line:#E7E0D3;--ok:#23855A;--okbg:#E2F1E8;--warn:#B4561B;--warnbg:#FBEADF;--bad:#B3261E;--badbg:#FBE4E1;--sand:#DCA44A;--side:#09262F;--side-2:#103540;--bar:#2E7686;--shadow:0 1px 2px rgba(9,38,47,.05),0 4px 16px -8px rgba(9,38,47,.12);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--deep:#F2EEE4;--paper:#0A1E25;--paper-2:#0E252D;--card:#12303A;--muted:#9DB0B5;--line:#1F3E48;--ok:#46B884;--okbg:#173B2E;--warn:#E8A06A;--warnbg:#3D2A1C;--bad:#F2847A;--badbg:#45201D;--side:#061519;--side-2:#0D2C35;--bar:#6FB8C6;--shadow:0 1px 2px rgba(0,0,0,.25);color-scheme:dark}}
*{box-sizing:border-box}
html{background:var(--paper)}
body{margin:0;background:var(--paper);color:var(--deep);font-family:"Schibsted Grotesk",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.45;-webkit-font-smoothing:antialiased;letter-spacing:-.003em}
a{color:inherit}
button,input,select,textarea{font:inherit;color:inherit}
::selection{background:rgba(220,164,74,.35)}
/* shell */
.side{background:var(--side);color:#F7F3EA;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:11px;padding:20px 20px 18px}
.brand svg{flex:none}
.brand b{display:block;font-size:15px;font-weight:700;letter-spacing:-.01em}
.brand small{display:block;font-size:12px;color:#93A9AE}
.nav{display:flex;flex-direction:column;gap:2px;padding:4px 12px}
.nav a{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:10px;color:#A9BDC1;text-decoration:none;font-size:14.5px;font-weight:600}
.nav a:hover{background:rgba(247,243,234,.06);color:#F7F3EA}
.nav a.on{background:rgba(220,164,74,.14);color:#F7F3EA}
.nav a.on svg{color:var(--sand)}
.nav .count{margin-left:auto;min-width:20px;padding:0 6px;border-radius:999px;background:var(--sand);color:#09262F;font-size:12px;font-weight:700;line-height:20px;text-align:center}
.nav .dot{margin-left:auto;width:8px;height:8px;border-radius:50%;background:#F2847A}
.tools{margin-top:auto;display:flex;flex-direction:column;gap:2px;padding:12px 12px 16px;border-top:1px solid rgba(247,243,234,.08)}
.tools a,.tools label{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:9px;color:#B7C7CB;font-size:13.5px;text-decoration:none;cursor:pointer}
.tools a:hover,.tools label:hover{background:rgba(247,243,234,.07);color:#F7F3EA}
.nav a.mob,.top .chk.mob{display:none}
.tools .who{font-size:12px;color:#7F979C;padding:6px 12px 0;overflow-wrap:anywhere}
main{min-width:0}
.top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:20px 28px 0}
.top h1{margin:0;font-size:24px;font-weight:700;letter-spacing:-.02em;flex:1;min-width:0}
.top .upd{font-size:13px;color:var(--muted)}
.gsearch{position:relative}
.gsearch input{width:240px;border:1px solid var(--line);background:var(--card);border-radius:10px;padding:8px 12px 8px 34px}
.gsearch svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted)}
.page{padding:16px 28px 48px;max-width:1240px}
@media (min-width:861px){
 body{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh;background:linear-gradient(90deg,var(--side) 236px,var(--paper) 236px)}
 .side{position:sticky;top:0;height:100vh;overflow-y:auto}
}
@media (max-width:860px){
 .side{position:sticky;top:0;z-index:5}
 .brand{padding:calc(12px + env(safe-area-inset-top,0px)) 16px 8px}
 .nav{flex-direction:row;overflow-x:auto;scrollbar-width:none;padding:0 10px 8px}
 .nav::-webkit-scrollbar{display:none}
 .nav a{flex:none;padding:7px 11px;font-size:14px}
 .nav a .count{margin-left:6px}.nav a .dot{margin-left:6px}
 .tools{display:none}
 .nav a.mob{display:flex}
 .t td{white-space:nowrap}
 .top .chk.mob{display:inline-flex}
 .top{padding:16px 16px 0}.top h1{font-size:21px}
 .gsearch{display:none}
 .page{padding:12px 16px 40px}
}
/* controls */
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:16px}
.bar .sp{flex:1}
.seg{display:inline-flex;background:var(--card);border:1px solid var(--line);border-radius:11px;padding:3px;box-shadow:var(--shadow)}
.seg button{border:0;background:none;color:var(--muted);padding:6px 12px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600}
.seg button.on{background:var(--side);color:#F7F3EA}
.btn{display:inline-flex;align-items:center;gap:7px;font-size:13.5px;font-weight:600;border:1px solid var(--line);background:var(--card);color:var(--deep);padding:7px 12px;border-radius:9px;cursor:pointer;text-decoration:none;white-space:nowrap}
.btn:hover{border-color:var(--deep)}
.btn.primary{background:var(--sand);border-color:var(--sand);color:#09262F}
.btn.danger{color:var(--bad)}
.btn:disabled{opacity:.5;cursor:default}
select.in,input.in{border:1px solid var(--line);background:var(--card);border-radius:9px;padding:7px 10px;font-size:14px;max-width:100%}
.chk{display:inline-flex;align-items:center;gap:6px;font-size:13.5px;color:var(--muted);cursor:pointer}
/* blocks */
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);min-width:0}
.card>h2,.sec>h2{font-size:14px;font-weight:700;margin:0;padding:14px 16px 0;display:flex;align-items:center;gap:8px}
.sec{margin-top:22px}
.sec>h2{padding:0 0 10px;font-size:15px}
.card.sec>h2{padding:14px 16px 0;font-size:14px}
.sec>h2 a{margin-left:auto;font-size:13px;font-weight:600;color:var(--muted)}
.pad{padding:14px 16px}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.grid3{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
@media (max-width:900px){.grid2{grid-template-columns:1fr}}
.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}
@media (max-width:1180px){.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:560px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kpi{padding:13px 14px}
.kpi span{display:block;color:var(--muted);font-size:12.5px}
.kpi b{display:block;font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em;margin-top:2px;overflow-wrap:anywhere}
.kpi b small{font-size:13px;font-weight:500;color:var(--muted)}
.d{display:block;font-size:12px;color:var(--muted);margin-top:2px}.d.up{color:var(--ok)}.d.down{color:var(--warn)}
.alert{border-radius:14px;padding:12px 16px;margin-bottom:16px;display:flex;gap:12px;align-items:flex-start;font-size:14px}
.alert.ok{background:var(--okbg);color:var(--ok)}.alert.warn{background:var(--warnbg);color:var(--warn)}.alert.bad{background:var(--badbg);color:var(--bad)}
.alert b{display:block;font-size:14.5px}
.alert .x{flex:1;min-width:0}
.alert a{font-weight:700}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap;background:var(--paper);color:var(--muted);border:1px solid var(--line)}
.pill.ok{background:var(--okbg);color:var(--ok);border-color:transparent}.pill.warn{background:var(--warnbg);color:var(--warn);border-color:transparent}.pill.bad{background:var(--badbg);color:var(--bad);border-color:transparent}
.pill.sand{background:var(--sand);color:#09262F;border-color:transparent}
.muted{color:var(--muted)}
.empty{padding:22px 16px;color:var(--muted);text-align:center}
.err{background:var(--warnbg);color:var(--warn);padding:10px 12px;border-radius:10px;margin-bottom:12px}
.skel{height:120px;border-radius:16px;background:linear-gradient(90deg,var(--card),var(--paper-2),var(--card));background-size:200% 100%;animation:sk 1.2s infinite linear;border:1px solid var(--line)}
@keyframes sk{to{background-position:-200% 0}}
/* tables */
.tw{overflow-x:auto}
table.t{width:100%;border-collapse:collapse;font-size:14px}
.t th{text-align:left;font-size:12px;color:var(--muted);font-weight:600;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
.t td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
.t tr:last-child td{border-bottom:0}
.t .n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.t tr.link{cursor:pointer}.t tr.link:hover td{background:var(--paper-2)}
.t tfoot td{font-weight:700;border-top:2px solid var(--line)}
.t .nm b{display:block}.t .nm small{color:var(--muted)}
.strike{text-decoration:line-through;color:var(--muted)}
/* chart */
.chart{position:relative;padding:8px 16px 12px}
.chart svg{display:block;width:100%;height:150px;overflow:visible}
.chart .axis{font-size:11px;fill:var(--muted)}
.chart .tot{font-size:13px;color:var(--muted);padding:0 16px}
.chart .tot b{color:var(--deep);font-size:18px}
.tip{position:fixed;pointer-events:none;background:var(--side);color:#F7F3EA;border-radius:9px;padding:6px 10px;font-size:12.5px;z-index:20;box-shadow:0 6px 20px rgba(0,0,0,.2);display:none;white-space:nowrap}
.tip b{display:block;font-size:14px}
/* lists */
.rows{display:flex;flex-direction:column}
.row{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;border-bottom:1px solid var(--line);text-decoration:none;color:inherit}
.row:last-child{border-bottom:0}
a.row:hover{background:var(--paper-2)}
.row .x{flex:1;min-width:0}
.row .l1{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.row .l1 b{font-weight:700}
.row .pv{color:var(--muted);font-size:14px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.row .tm{font-size:12.5px;color:var(--muted);white-space:nowrap}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{font-size:13px;font-weight:600;border:1px solid var(--line);background:var(--card);border-radius:999px;padding:5px 12px;cursor:pointer}
.chip.on{background:var(--side);color:#F7F3EA;border-color:var(--side)}
.chip .c{margin-left:6px;opacity:.8}
/* center cards */
.cc{padding:16px;display:flex;flex-direction:column;gap:12px;text-decoration:none;color:inherit}
.cc:hover{border-color:var(--muted)}
.cc .hd{display:flex;gap:10px;align-items:flex-start}
.cc .hd .x{flex:1;min-width:0}
.cc .hd b{font-size:16.5px;display:block}
.cc .hd small{color:var(--muted);font-size:12.5px}
.av{flex:none;width:38px;height:38px;border-radius:50%;background:var(--paper);border:1px solid var(--line);display:grid;place-items:center;font-weight:700;color:var(--muted);overflow:hidden}
.av img{width:100%;height:100%;object-fit:cover}
.mini{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.mini span{display:block;font-size:12px;color:var(--muted)}.mini b{font-variant-numeric:tabular-nums}
.dl{display:grid;grid-template-columns:minmax(120px,auto) 1fr;gap:6px 14px;font-size:14px}
.dl dt{color:var(--muted)}.dl dd{margin:0;overflow-wrap:anywhere}
.log{font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--muted);max-height:320px;overflow:auto}
.form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.form input.in{flex:1;min-width:160px}
.back{display:inline-flex;align-items:center;gap:6px;color:var(--muted);text-decoration:none;font-size:14px;margin-bottom:6px}
.big{width:100%;border:1px solid var(--line);background:var(--card);border-radius:12px;padding:12px 14px;font-size:16px;box-shadow:var(--shadow)}
.sum{white-space:pre-wrap;font-size:13.5px;color:var(--muted);margin-top:8px;max-height:0;overflow:hidden}
.sum.open{max-height:none}
/* demo/test band */
.tb{padding:0 28px;max-width:1240px}
.tb .alert{margin:14px 0 0;flex-wrap:wrap}
.tb .alert .btn{margin-left:auto;flex:none}
@media (max-width:860px){.tb{padding:0 16px}}
/* pipeline */
.fol .row{align-items:center}
.due{font-size:12.5px;font-weight:600;white-space:nowrap}.due.late{color:var(--bad)}.due.today{color:var(--warn)}
.st-To{background:var(--paper)}.pill.st-Pitched{background:#E4EEF6;color:#2E5F86;border-color:transparent}.pill.st-Talking{background:var(--sand);color:#09262F;border-color:transparent}
.pill.st-Trial,.pill.st-Signed,.pill.st-Live{background:var(--okbg);color:var(--ok);border-color:transparent}.pill.st-No{background:var(--badbg);color:var(--bad);border-color:transparent}
@media (prefers-color-scheme:dark){.pill.st-Pitched{background:#1D3546;color:#9CC3E4}}
dialog.dlg{border:0;border-radius:18px;padding:0;width:min(640px,calc(100vw - 24px));max-height:calc(100vh - 32px);background:var(--card);color:var(--deep);box-shadow:0 20px 60px rgba(0,0,0,.3)}
dialog.dlg::backdrop{background:rgba(9,38,47,.45)}
.dlg form{display:flex;flex-direction:column;gap:12px;padding:18px}
.dlg h3{margin:0;font-size:18px;display:flex;align-items:center;gap:10px}
.dlg h3 .x{margin-left:auto}
.dlg .fg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media (max-width:560px){.dlg .fg{grid-template-columns:1fr}}
.dlg label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--muted);font-weight:600}
.dlg label .in,.dlg textarea{width:100%}
.dlg textarea{border:1px solid var(--line);background:var(--card);border-radius:9px;padding:8px 10px;font-size:14px;min-height:64px;resize:vertical}
.dlg .links{display:flex;gap:8px;flex-wrap:wrap}
.dlg .acts{display:flex;gap:8px;justify-content:flex-end}
.dlg .log{max-height:200px;border:1px solid var(--line);border-radius:10px;padding:10px}
.ait{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ait .btn{margin-left:auto}
.fit{border-bottom:1px solid var(--line)}.fit:last-child{border-bottom:0}.fit .row{border-bottom:0}
.aiw:empty{display:none}.aiw{padding:0 16px 14px}
.ptop{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.ptop .sp{flex:1}
.prw{display:flex;flex-direction:column;gap:8px}
.dlg .fg3{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:10px}
@media (max-width:560px){.dlg .fg3{grid-template-columns:1fr}}
.dlg .pfull .in{width:100%}.dlg textarea[rows="2"]{min-height:44px}
.pdet{border:1px solid var(--line);border-radius:10px;padding:8px 12px}
.pdet summary{cursor:pointer;font-size:13.5px;font-weight:600;display:flex;gap:10px;align-items:baseline}
.pdet summary .muted{font-weight:400;font-size:12.5px}
.pdet[open] summary{margin-bottom:10px}
.aip{display:flex;flex-direction:column;gap:10px;border:1px solid var(--line);border-radius:12px;padding:12px;background:var(--paper)}
.aip label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--muted);font-weight:600}
.aip textarea{width:100%;border:1px solid var(--line);background:var(--card);border-radius:9px;padding:8px 10px;font-size:14px;resize:vertical;font-weight:400;color:var(--deep)}
.aip .in{width:100%}
.aifg{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media (max-width:560px){.aifg{grid-template-columns:1fr}}
.aisum{margin:0;font-size:14px}
.aiacts{display:flex;gap:8px;flex-wrap:wrap}.aiacts.end{justify-content:flex-end}
/* funnel */
.fun{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:14px 16px}
@media (max-width:700px){.fun{grid-template-columns:repeat(2,minmax(0,1fr))}}
.fun .st b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
.fun .st span{display:block;font-size:12.5px;color:var(--muted)}
.fun .st i{display:block;height:8px;border-radius:5px;background:var(--paper);margin:6px 0 4px;overflow:hidden}
.fun .st i em{display:block;height:100%;background:var(--bar);border-radius:5px}
.fun .st small{font-size:12px;color:var(--muted)}
.meter{height:10px;border-radius:6px;background:var(--paper);overflow:hidden;margin-top:6px}
.meter span{display:block;height:100%;background:var(--bar)}.meter span.warn{background:var(--warn)}.meter span.bad{background:var(--bad)}
</style></head><body>
<aside class="side">
  <div class="brand"><svg width="30" height="30" viewBox="0 0 100 100" aria-hidden="true"><path d="M 12 50 A 38 38 0 0 0 88 50 Z" fill="#DCA44A"/><circle cx="50" cy="50" r="38" fill="none" stroke="#F7F3EA" stroke-width="10"/><line x1="6" y1="50" x2="94" y2="50" stroke="#F7F3EA" stroke-width="10" stroke-linecap="round"/></svg>
  <span><b>Talay HQ</b><small>${role === "owner" ? "Eigenaar" : "Medewerker"}</small></span></div>
  <nav class="nav" id="nav">${nav.map(([k, label, ic]) => `<a href="#/${k}" data-k="${k}">${hqIcon(ic)}<span>${label}</span><span class="count" id="n-${k}" hidden></span></a>`).join("")}<a class="mob" href="/zone">${hqIcon("zone")}<span>Klantenzone</span></a><a class="mob" href="/cdn-cgi/access/logout">${hqIcon("out")}<span>Afmelden</span></a></nav>
  <div class="tools">
    <label><input type="checkbox" id="withTest"> Ook demo/test meetellen</label>
    <a href="/zone">${hqIcon("zone")} Klantenzone</a>
    <a href="/cdn-cgi/access/logout">${hqIcon("out")} Afmelden</a>
    <div class="who">${esc(email)}</div>
  </div>
</aside>
<main>
  <div class="top"><h1 id="title">Overzicht</h1><span class="upd" id="upd"></span><label class="chk mob"><input type="checkbox" id="withTest2"> Ook demo/test</label>
  <form class="gsearch" id="gs"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input type="search" id="gq" placeholder="Zoek duiker, nummer of ref" aria-label="Zoeken"></form>
  <button class="btn" id="refresh" type="button" title="Vernieuwen">${hqIcon("refresh")}<span>Vernieuwen</span></button></div>
  <div class="tb" id="tb"></div>
  <div class="page" id="page"><div class="skel"></div></div>
</main>
<div class="tip" id="tip"></div>
<script>var __name = function (f) { return f; }; // Wrangler adds __name(...) calls when bundling
(${hqClient.toString()})(${JSON.stringify(cfg).replace(/</g, "\\u003c")});</script>
</body></html>`;
}

function hqClient(cfg) {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var nf = new Intl.NumberFormat("nl-BE");
  var thb = function (v) { return "฿ " + nf.format(Math.round(v || 0)); };
  var secs = function (v) { return v == null ? "–" : v < 60 ? Math.round(v) + " s" : v < 3600 ? Math.round(v / 6) / 10 + " min" : Math.round(v / 360) / 10 + " u"; };
  var mins = function (v) { return v == null ? "–" : v < 60 ? v + " min" : Math.round(v / 6) / 10 + " u"; };
  var ago = function (iso) {
    if (!iso) return "nog geen";
    var d = (Date.now() - Date.parse(iso)) / 60000;
    if (d < 1) return "net nu";
    if (d < 60) return Math.round(d) + " min geleden";
    if (d < 48 * 60) return Math.round(d / 60) + " u geleden";
    return Math.round(d / 1440) + " dagen geleden";
  };
  var date = function (iso, time) {
    if (!iso) return "";
    var o = { day: "numeric", month: "short" };
    if (time) { o.hour = "2-digit"; o.minute = "2-digit"; }
    return new Date(iso).toLocaleString("nl-BE", o);
  };
  var icon = function (k, s) { return '<svg width="' + (s || 16) + '" height="' + (s || 16) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + cfg.icons[k] + "</svg>"; };
  var store = { get: function (k, d) { try { var v = localStorage.getItem("hq." + k); return v == null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem("hq." + k, v); } catch (e) {} } };

  var state = { per: store.get("per", "today"), withTest: store.get("test", "") === "1", ov: null, cache: {} };
  var LABEL = { today: "vandaag", week: "deze week", month: "deze maand" };
  var PREV = { today: "gisteren", week: "vorige week", month: "vorige maand" };

  function api(path, opt) {
    return fetch("/zone/admin/api/" + path, Object.assign({ credentials: "same-origin" }, opt || {})).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error("auth"); }
      return r.json().then(function (j) { if (!r.ok || j.error) throw new Error(j.error || "Er ging iets mis."); return j; });
    });
  }
  function post(path, body) { return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  // Cached GET per page, so switching pages is instant; Vernieuwen fetches fresh.
  function load(key, path, fresh) {
    var c = state.cache[key];
    if (c && !fresh && Date.now() - c.t < 60000) return Promise.resolve(c.v);
    return api(path + (fresh ? (path.indexOf("?") > -1 ? "&" : "?") + "fresh=1" : "")).then(function (v) { state.cache[key] = { t: Date.now(), v: v }; return v; });
  }
  function overview(fresh) {
    return load("ov", "overview", fresh).then(function (d) { state.ov = d; badges(); banner(); return d; });
  }

  // ---------- helpers for the pages ----------
  var page = $("#page");
  function setPage(title, h) { $("#title").textContent = title; page.innerHTML = h; }
  function fail(e) { if (e && e.message === "auth") return; page.innerHTML = '<div class="err">' + esc(e && e.message || "Laden lukte niet.") + "</div>"; }
  function counted(list) { return list.filter(function (c) { return state.withTest || !c.test; }); }
  function hasTest() { return state.ov && state.ov.centers.some(function (c) { return c.test; }); }
  function kpi(name, value, extra) { return '<div class="card kpi"><span>' + name + "</span><b>" + value + "</b>" + (extra || "") + "</div>"; }
  function delta(cur, prev, money) {
    var diff = cur - prev, cls = diff > 0 ? "up" : diff < 0 ? "down" : "";
    return '<span class="d ' + cls + '">' + (diff > 0 ? "▲ " : diff < 0 ? "▼ " : "") + PREV[state.per] + ": " + (money ? thb(prev) : nf.format(prev)) + "</span>";
  }
  function seg() {
    return '<div class="seg" id="seg">' + ["today", "week", "month"].map(function (k) {
      return '<button type="button" data-p="' + k + '" class="' + (state.per === k ? "on" : "") + '">' + { today: "Vandaag", week: "Deze week", month: "Deze maand" }[k] + "</button>";
    }).join("") + "</div>";
  }
  function bindSeg(again) {
    $$("#seg button").forEach(function (b) {
      b.onclick = function () { state.per = b.getAttribute("data-p"); store.set("per", state.per); again(); };
    });
  }
  function miaPill(c) { return '<span class="pill ' + (c.paused ? "warn" : "ok") + '">' + esc(c.assistant) + (c.paused ? " gepauzeerd" : " actief") + "</span>"; }
  function typePill(t) { return t ? '<span class="pill">' + esc(t) + "</span>" : ""; }
  function avatar(c) { return '<span class="av">' + (c.logo ? '<img src="' + esc(c.logo) + '" alt="">' : esc((c.name || "?").charAt(0))) + "</span>"; }
  function zoneLink(slug, id) { return "/zone?center=" + encodeURIComponent(slug) + (id ? "&c=" + encodeURIComponent(id) : ""); }
  function sum(list, which) {
    var keys = ["conversations", "handedOver", "bookings", "divers", "value", "commission", "booked"], t = {};
    keys.forEach(function (k) { t[k] = 0; });
    list.forEach(function (c) { var x = which === "prev" ? c.periods[state.per].prev : c.periods[state.per]; keys.forEach(function (k) { t[k] += x[k] || 0; }); });
    return t;
  }
  function pause(c, btn, done) {
    var to = !c.paused;
    if (to && !confirm(c.assistant + " pauzeren voor " + c.name + "? Dan antwoordt ze niemand meer tot je haar weer aanzet.")) return;
    btn.disabled = true;
    post("pause", { slug: c.slug, paused: to }).then(function (d) {
      c.paused = d.paused;
      if (state.ov) state.ov.centers.forEach(function (x) { if (x.slug === c.slug) x.paused = d.paused; });
      delete state.cache["c:" + c.slug];
      done();
    }).catch(function (e) { btn.disabled = false; alert(e.message); });
  }
  function csv(name, rows) {
    var text = rows.map(function (r) { return r.map(function (v) { v = String(v == null ? "" : v); return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(";"); }).join("\r\n");
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + text], { type: "text/csv;charset=utf-8" }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- bar chart (one series, hover tooltip) ----------
  var charts = {};
  function chart(id, values, fmt, day0, endLabel) {
    charts[id] = { values: values, fmt: fmt, day0: day0 };
    var max = Math.max.apply(null, values.concat([1])), n = values.length, W = 600, H = 150, pb = 18;
    var bw = W / n, h = "";
    values.forEach(function (v, i) {
      var bh = v ? Math.max(3, (v / max) * (H - pb - 6)) : 0, x = i * bw + 1, w = Math.max(2, bw - 2);
      if (bh) h += '<path d="M' + x + "," + (H - pb) + "V" + (H - pb - bh + 3) + "q0,-3 3,-3h" + (w - 6) + "q3,0 3,3V" + (H - pb) + 'Z" fill="var(--bar)"/>';
      h += '<rect x="' + (i * bw) + '" y="0" width="' + bw + '" height="' + H + '" fill="transparent" data-i="' + i + '" tabindex="-1"/>';
    });
    h += '<line x1="0" x2="' + W + '" y1="' + (H - pb) + '" y2="' + (H - pb) + '" stroke="var(--line)"/>';
    var d0 = new Date(Date.parse(day0) + 12 * 36e5), dN = new Date(Date.parse(day0) + (n - 1) * 864e5);
    h += '<text class="axis" x="0" y="' + (H - 3) + '">' + esc(date(d0.toISOString())) + "</text>";
    h += '<text class="axis" x="' + W + '" y="' + (H - 3) + '" text-anchor="end">' + esc(endLabel || "vandaag") + "</text>";
    return '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" data-chart="' + id + '" role="img" aria-label="Staafdiagram per dag, laatste ' + n + ' dagen">' + h + "</svg>";
  }
  document.addEventListener("pointermove", function (e) {
    var tip = $("#tip"), t = e.target;
    var svg = t && t.closest ? t.closest("svg[data-chart]") : null;
    if (!svg || !t.hasAttribute("data-i")) { tip.style.display = "none"; return; }
    var c = charts[svg.getAttribute("data-chart")], i = +t.getAttribute("data-i");
    var d = new Date(Date.parse(c.day0) + i * 864e5 + 12 * 36e5);
    tip.innerHTML = "<b>" + esc(c.fmt(c.values[i])) + "</b>" + esc(d.toLocaleDateString("nl-BE", { weekday: "short", day: "numeric", month: "short" }));
    tip.style.display = "block";
    var x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = x + "px"; tip.style.top = (e.clientY - tip.offsetHeight - 10) + "px";
  });

  // ---------- nav badges ----------
  function badges() {
    var ov = state.ov; if (!ov) return;
    var sysBad = ov.centers.some(function (c) { return c.health && (c.health.errors || (c.health.waiting && !c.paused)); }) || !ov.healthOk;
    var n = $("#n-systeem"); if (n) { n.hidden = !sysBad; n.className = "dot"; n.textContent = ""; }
  }
  function inboxBadge(items) {
    var n = $("#n-inbox"); if (!n) return;
    var k = items.filter(function (x) { return (x.needsYou || x.waiting) && (state.withTest || !x.test); }).length;
    n.hidden = !k; n.textContent = k;
  }

  // ---------- Overzicht ----------
  function pOverview(fresh) {
    if (!state.ov) setPage("Overzicht", '<div class="skel"></div>');
    overview(fresh).then(function (ov) {
      if (route().k !== "overzicht") return;
      var list = counted(ov.centers), t = sum(list), pv = sum(list, "prev");
      var open = list.reduce(function (a, c) { return a + c.openHandovers; }, 0);
      var reply = (state.withTest || !hasTest() ? ov.reply.all : ov.reply.live)[state.per];
      var daily = Array.from({ length: 30 }, function () { return [0, 0, 0]; });
      list.forEach(function (c) { c.daily.forEach(function (d, i) { daily[i][0] += d[0]; daily[i][1] += d[1]; daily[i][2] += d[2]; }); });
      var conv30 = daily.reduce(function (a, d) { return a + d[0]; }, 0), val30 = daily.reduce(function (a, d) { return a + d[2]; }, 0);

      var h = '<div class="bar">' + seg() + '<span class="sp"></span>' + "" + "</div>";
      h += healthBox(ov, false);
      h += '<div class="kpis">' +
        kpi("Nieuwe gesprekken", nf.format(t.conversations), delta(t.conversations, pv.conversations)) +
        kpi("Boekingen", nf.format(t.bookings) + " <small>" + nf.format(t.divers) + " duikers</small>", delta(t.bookings, pv.bookings)) +
        kpi("Boekingswaarde", thb(t.value), delta(t.value, pv.value, true)) +
        kpi("Commissie Talay", thb(t.commission), delta(t.commission, pv.commission, true)) +
        kpi("Overdrachten", nf.format(t.handedOver) + (open ? " <small>" + open + " open</small>" : ""), delta(t.handedOver, pv.handedOver)) +
        kpi("Antwoordtijd", secs(reply), '<span class="d">mediaan, ' + LABEL[state.per] + "</span>") + "</div>";
      h += '<div class="grid2 sec">' +
        '<div class="card"><h2>Nieuwe gesprekken per dag</h2><div class="chart"><div class="tot"><b>' + nf.format(conv30) + "</b> in 30 dagen</div>" +
          chart("conv", daily.map(function (d) { return d[0]; }), function (v) { return nf.format(v) + " gesprekken"; }, ov.day0) + "</div></div>" +
        '<div class="card"><h2>Boekingswaarde per dag</h2><div class="chart"><div class="tot"><b>' + thb(val30) + "</b> in 30 dagen</div>" +
          chart("val", daily.map(function (d) { return d[2]; }), thb, ov.day0) + "</div></div></div>";
      h += '<div class="sec"><h2>Centra, ' + LABEL[state.per] + ' <a href="#/centra">Alle centra →</a></h2><div class="card tw"><table class="t"><thead><tr><th>Center</th><th>Assistent</th><th class="n">Gesprekken</th><th class="n">Boekingen</th><th class="n">Waarde</th><th class="n">Commissie</th><th class="n">Antwoordtijd</th><th>Signalen</th></tr></thead><tbody>' +
        ov.centers.map(function (c) {
          var x = c.periods[state.per], hl = c.health || {}, sig = [];
          if (hl.errors) sig.push('<span class="pill bad">' + hl.errors + " fout" + (hl.errors > 1 ? "en" : "") + "</span>");
          if (hl.waiting && !c.paused) sig.push('<span class="pill warn">' + hl.waiting + " wacht</span>");
          if (c.openHandovers) sig.push('<span class="pill ' + (c.lateHandovers ? "warn" : "sand") + '">' + c.openHandovers + " overdracht" + (c.lateHandovers ? ", " + c.lateHandovers + " te laat" : "") + "</span>");
          return '<tr class="link' + (c.test && !state.withTest ? " muted" : "") + '" data-href="#/centra/' + esc(c.slug) + '"><td class="nm"><b>' + esc(c.name) + "</b><small>" + esc(c.type || c.slug) + "</small></td><td>" + miaPill(c) + '</td><td class="n">' + nf.format(x.conversations) +
            '</td><td class="n">' + nf.format(x.bookings) + '</td><td class="n">' + thb(x.value) + '</td><td class="n">' + thb(x.commission) + '</td><td class="n">' + secs(x.replySeconds) + "</td><td>" + (sig.join(" ") || '<span class="muted">–</span>') + "</td></tr>";
        }).join("") + "</tbody></table></div></div>";
      if (ov.activity.length) h += '<div class="sec"><h2>Laatste wijzigingen in de zones <a href="#/systeem">Alles →</a></h2><div class="card rows">' + ov.activity.slice(0, 6).map(actRow).join("") + "</div></div>";
      setPage("Overzicht", h);
      bindSeg(pOverview);
      $$("tr[data-href]").forEach(function (r) { r.onclick = function () { location.hash = r.getAttribute("data-href"); }; });
    }).catch(fail);
  }
  function actRow(a) {
    return '<div class="row"><div class="x"><div class="l1"><b>' + esc(a.center) + '</b><span class="muted">' + esc(a.who) + "</span></div><div class=\"pv\">" + esc(a.what) + '</div></div><span class="tm">' + esc(a.at.slice(5).replace("-", "/")) + "</span></div>";
  }
  function healthBox(ov, full) {
    if (!ov.healthOk) return '<div class="alert warn"><div class="x"><b>Systeemcheck niet beschikbaar</b>De tabel Chat kon niet gelezen worden.</div></div>';
    var errs = ov.centers.filter(function (c) { return c.health && c.health.errors; });
    var wait = ov.centers.filter(function (c) { return c.health && c.health.waiting && !c.paused; });
    var paused = ov.centers.filter(function (c) { return c.paused && !c.test; });
    var late = ov.centers.filter(function (c) { return c.lateHandovers && (state.withTest || !c.test); });
    var h = "";
    if (errs.length) h += '<div class="alert bad"><div class="x"><b>' + esc(ov.centers[0] && errs[0].assistant || "Mia") + ' stuurde het sorry-bericht</b>' +
      errs.map(function (c) { return esc(c.name) + ": " + c.health.errors + "×"; }).join(" · ") + " in de laatste 24 uur. Kijk eerst naar het API-tegoed van Anthropic en Make (inbound v2).</div></div>";
    if (wait.length) h += '<div class="alert warn"><div class="x"><b>Duikers zonder antwoord</b>' +
      wait.map(function (c) { return esc(c.name) + ": " + c.health.waiting; }).join(" · ") + " (langer dan " + ov.waitMin + ' min). <a href="#/inbox">Open de inbox →</a></div></div>';
    if (late.length) h += '<div class="alert warn"><div class="x"><b>Overdracht zonder reactie</b>' +
      late.map(function (c) { return esc(c.name) + ": " + c.lateHandovers; }).join(" · ") + ' (langer dan 30 min, niemand van het team nam over). <a href="#/inbox">Open de inbox →</a></div></div>';
    if (paused.length && full) h += '<div class="alert warn"><div class="x"><b>Gepauzeerd</b>' + paused.map(function (c) { return esc(c.name); }).join(", ") + "</div></div>";
    if (!h) {
      var replies = ov.centers.reduce(function (a, c) { return a + (c.health ? c.health.replies : 0); }, 0);
      h = '<div class="alert ok"><div class="x"><b>Alles draait</b>Geen foutmeldingen en geen duikers zonder antwoord in de laatste 24 uur · ' + nf.format(replies) + " antwoorden verstuurd.</div></div>";
    }
    return h;
  }

  // ---------- Inbox ----------
  var inboxFilter = store.get("inbox", "all"), inboxCenter = "";
  function pInbox(fresh) {
    if (!state.cache.inbox) setPage("Inbox", '<div class="skel"></div>');
    load("inbox", "inbox", fresh).then(function (d) {
      inboxBadge(d.items);
      if (route().k !== "inbox") return;
      var all = d.items.filter(function (x) { return state.withTest || !x.test; });
      var need = all.filter(function (x) { return x.needsYou; }), wait = all.filter(function (x) { return x.waiting && !x.needsYou; });
      var list = inboxFilter === "need" ? need : inboxFilter === "wait" ? wait : all;
      if (inboxCenter) list = list.filter(function (x) { return x.slug === inboxCenter; });
      var centers = {}; all.forEach(function (x) { centers[x.slug] = x.center; });
      var h = '<div class="bar"><div class="chips">' +
        [["all", "Alle open gesprekken", all.length], ["need", "Team nodig", need.length], ["wait", "Zonder antwoord", wait.length]].map(function (f) {
          return '<button class="chip' + (inboxFilter === f[0] ? " on" : "") + '" data-f="' + f[0] + '">' + f[1] + '<span class="c">' + f[2] + "</span></button>";
        }).join("") + '</div><span class="sp"></span><select class="in" id="ic"><option value="">Alle centra</option>' +
        Object.keys(centers).map(function (s) { return '<option value="' + esc(s) + '"' + (s === inboxCenter ? " selected" : "") + ">" + esc(centers[s]) + "</option>"; }).join("") + "</select></div>";
      h += '<p class="muted" style="margin:-6px 0 12px;font-size:13.5px">Gesprekken waarin de duiker de laatste 24 uur schreef: daarin mag het team nog vrij antwoorden. Een klik opent het gesprek in de zone van dat center.</p>';
      h += '<div class="card rows">' + (list.map(function (x) {
        var tags = (x.needsYou ? '<span class="pill sand">Team nodig</span>' : "") + (x.waiting ? '<span class="pill warn">Geen antwoord</span>' : "") +
          (x.teamActive ? '<span class="pill ok">Team neemt over</span>' : "") + (x.language ? '<span class="pill">' + esc(String(x.language).toUpperCase()) + "</span>" : "");
        var left = x.closesAt ? (Date.parse(x.closesAt) - Date.now()) / 36e5 : 0;
        return '<a class="row" target="_blank" rel="noopener" href="' + zoneLink(x.slug, x.id) + '"><div class="x"><div class="l1"><b>' + esc(x.name || "Duiker") + '</b><span class="muted">' + esc(x.center) + "</span>" + tags + '</div><div class="pv">' +
          (x.previewDir === "Customer" ? "" : esc(x.previewDir === "Mia" ? "Assistent: " : "Team: ")) + esc(x.preview) + '</div></div><span class="tm">' + esc(ago(x.lastAt)) +
          (left > 0 ? '<br><span style="color:' + (left < 3 ? "var(--warn)" : "inherit") + '">nog ' + (left < 1 ? Math.max(1, Math.round(left * 60)) + " min" : Math.floor(left) + " u") + "</span>" : "") + "</span></a>";
      }).join("") || '<div class="empty">Niets open. Alles is beantwoord.</div>') + "</div>";
      setPage("Inbox", h);
      $$(".chip[data-f]").forEach(function (b) { b.onclick = function () { inboxFilter = b.getAttribute("data-f"); store.set("inbox", inboxFilter); pInbox(); }; });
      $("#ic").onchange = function () { inboxCenter = this.value; pInbox(); };
    }).catch(fail);
  }

  // ---------- Zoeken ----------
  function pSearch() {
    var qv = decodeURIComponent((location.hash.split("?q=")[1] || ""));
    setPage("Zoeken", '<form id="sf"><input class="big" id="sq" type="search" placeholder="Naam van een duiker, telefoonnummer, contact-ID of boekingsref" value="' + esc(qv) + '" autofocus></form><div id="sr" class="sec"></div>');
    $("#sf").onsubmit = function (e) { e.preventDefault(); location.hash = "#/zoeken?q=" + encodeURIComponent($("#sq").value.trim()); };
    if (qv.length < 2) { $("#sr").innerHTML = '<p class="muted">Zoekt in alle centra: duikers (naam, nummer, contact-ID) en boekingen (ref, naam van de betaler).</p>'; return; }
    $("#sr").innerHTML = '<div class="skel"></div>';
    api("search?q=" + encodeURIComponent(qv)).then(function (d) {
      var h = '<div class="grid2"><div class="card"><h2>Duikers <span class="muted">' + d.leads.length + '</span></h2><div class="rows">' +
        (d.leads.map(function (l) {
          return '<a class="row" target="_blank" rel="noopener" href="' + zoneLink(l.slug, l.id) + '"><div class="x"><div class="l1"><b>' + esc(l.name || l.contact || "Duiker") + '</b>' + (l.status ? '<span class="pill">' + esc(l.status) + "</span>" : "") +
            '</div><div class="pv">' + esc(l.center) + (l.contact ? " · " + esc(l.contact) : "") + '</div></div><span class="tm">' + esc(date(l.created)) + "</span></a>";
        }).join("") || '<div class="empty">Geen duikers gevonden.</div>') + '</div></div><div class="card"><h2>Boekingen <span class="muted">' + d.bookings.length + '</span></h2><div class="rows">' +
        (d.bookings.map(function (b) {
          return '<div class="row"><div class="x"><div class="l1"><b>' + esc(b.ref || "–") + "</b><span>" + esc(b.name) + "</span>" + (b.cancelled ? '<span class="pill warn">' + esc(b.status) + "</span>" : "") +
            '</div><div class="pv">' + esc(b.center) + " · " + esc(b.product) + " · " + b.divers + " duiker" + (b.divers > 1 ? "s" : "") + (b.date ? " · " + esc(b.date) : "") + '</div></div><span class="tm">' + thb(b.total) + "</span></div>";
        }).join("") || '<div class="empty">Geen boekingen gevonden.</div>') + "</div></div></div>";
      $("#sr").innerHTML = h;
    }).catch(function (e) { $("#sr").innerHTML = '<div class="err">' + esc(e.message) + "</div>"; });
  }

  // ---------- Centra ----------
  function pCenters(fresh) {
    if (!state.ov) setPage("Centra", '<div class="skel"></div>');
    overview(fresh).then(function (ov) {
      if (route().k !== "centra" || route().id) return;
      var h = '<div class="grid3">' + ov.centers.map(function (c) {
        var m = c.periods.month, hl = c.health || {};
        return '<a class="card cc" href="#/centra/' + esc(c.slug) + '"><div class="hd">' + avatar(c) + '<div class="x"><b>' + esc(c.name) + "</b><small>" + esc(c.slug) + (c.channel ? " · kanaal " + esc(c.channel) : " · geen kanaal") + '</small></div><div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">' + miaPill(c) + typePill(c.type) + "</div></div>" +
          '<div class="mini"><div><span>Gesprekken (maand)</span><b>' + nf.format(m.conversations) + "</b></div><div><span>Boekingen</span><b>" + nf.format(m.bookings) + "</b></div><div><span>Commissie</span><b>" + thb(m.commission) + "</b></div></div>" +
          '<div class="muted" style="font-size:13px">Team ' + c.staff + " · admins " + c.admins + " · laatste antwoord " + esc(ago(hl.lastMia)) + "</div></a>";
      }).join("") + "</div>";
      h += '<p class="muted" style="font-size:13.5px;margin-top:16px">Een nieuw center toevoegen gaat via het stappenplan (talay.io/start → CSV-import → kanaal in respond.io). Zet het veld Type in Centers op Demo, Test, Pilot of Live.</p>';
      setPage("Centra", h);
    }).catch(fail);
  }

  function pCenter(slug, fresh) {
    if (!state.cache["c:" + slug]) setPage("Center", '<div class="skel"></div>');
    Promise.all([overview(fresh), load("c:" + slug, "center?slug=" + encodeURIComponent(slug), fresh)]).then(function (r) {
      var ov = r[0], d = r[1];
      if (route().id !== slug) return;
      var c = ov.centers.find(function (x) { return x.slug === slug; }) || {};
      var x = c.periods ? c.periods[state.per] : null, hl = c.health || {};
      var h = '<a class="back" href="#/centra">← Alle centra</a>';
      h += '<div class="bar"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' + avatar(c.name ? c : d) + miaPill({ assistant: d.assistant, paused: d.paused }) + typePill(d.type) +
        '<span class="muted" style="font-size:13px">' + esc(slug) + (d.channel ? " · kanaal " + esc(d.channel) : "") + '</span></div><span class="sp"></span>' +
        '<a class="btn" target="_blank" rel="noopener" href="' + zoneLink(slug) + '">' + icon("zone") + " Open zone</a>" +
        '<button class="btn' + (d.paused ? " primary" : "") + '" id="pz">' + (d.paused ? esc(d.assistant) + " weer aanzetten" : esc(d.assistant) + " pauzeren") + "</button></div>";
      if (x) {
        h += '<div class="bar">' + seg() + "</div>";
        h += '<div class="kpis">' +
          kpi("Nieuwe gesprekken", nf.format(x.conversations), delta(x.conversations, x.prev.conversations)) +
          kpi("Boekingen", nf.format(x.bookings) + " <small>" + nf.format(x.divers) + " duikers</small>", delta(x.bookings, x.prev.bookings)) +
          kpi("Boekingswaarde", thb(x.value), delta(x.value, x.prev.value, true)) +
          kpi("Commissie", thb(x.commission), delta(x.commission, x.prev.commission, true)) +
          kpi("Antwoordtijd", secs(x.replySeconds), '<span class="d">mediaan per bericht</span>') +
          kpi("Team na overdracht", mins(x.teamMinutes), '<span class="d">' + (x.teamCount ? "mediaan van " + x.teamCount : "nog geen overdrachten") + "</span>") + "</div>";
        h += '<div class="grid2 sec"><div class="card"><h2>Boekingswaarde per dag</h2><div class="chart">' + chart("cv", c.daily.map(function (q) { return q[2]; }), thb, ov.day0) + "</div></div>" +
          '<div class="card"><h2>Gezondheid (24 u)</h2><div class="pad"><dl class="dl">' +
          "<dt>Laatste klantbericht</dt><dd>" + esc(ago(hl.lastCustomer)) + "</dd><dt>Laatste antwoord " + esc(d.assistant) + "</dt><dd>" + esc(ago(hl.lastMia)) + "</dd>" +
          "<dt>Antwoorden verstuurd</dt><dd>" + nf.format(hl.replies || 0) + "</dd><dt>Sorry-berichten</dt><dd>" + (hl.errors ? '<span class="pill bad">' + hl.errors + "</span>" : "0") + "</dd>" +
          "<dt>Zonder antwoord</dt><dd>" + (hl.waiting ? '<span class="pill warn">' + hl.waiting + "</span>" : "0") + "</dd><dt>Open overdrachten (7 d)</dt><dd>" + nf.format(c.openHandovers || 0) + "</dd>" +
          "<dt>Conversie</dt><dd>" + (x.conversations ? nf.format(Math.round(x.booked / x.conversations * 1000) / 10) + " %" : "–") + "</dd><dt>Buiten kantooruren</dt><dd>" + nf.format(x.outsideHours) + "</dd>" +
          "</dl></div></div></div>";
      }
      h += '<div class="grid2 sec"><div class="card"><h2>Recente gesprekken <span class="muted">30 d</span></h2><div class="rows">' +
        (d.leads.slice(0, 12).map(function (l) {
          return '<a class="row" target="_blank" rel="noopener" href="' + zoneLink(slug, l.id) + '"><div class="x"><div class="l1"><b>' + esc(l.name || "Duiker") + "</b>" + (l.language ? '<span class="pill">' + esc(l.language.toUpperCase()) + "</span>" : "") +
            (l.status ? '<span class="pill">' + esc(l.status) + "</span>" : "") + (l.handover ? '<span class="pill sand">Overdracht</span>' : "") + (l.outside ? '<span class="pill">Buiten uren</span>' : "") +
            '</div></div><span class="tm">' + esc(date(l.created, true)) + "</span></a>";
        }).join("") || '<div class="empty">Geen gesprekken in 30 dagen.</div>') + "</div></div>" +
        '<div class="card"><h2>Recente boekingen <span class="muted">30 d</span></h2><div class="tw"><table class="t"><tbody>' +
        (d.bookings.slice(0, 12).map(function (b) {
          return '<tr><td class="nm"><b' + (b.cancelled ? ' class="strike"' : "") + ">" + esc(b.name || b.ref) + "</b><small>" + esc(b.product) + " · " + b.divers + "×" + (b.date ? " · " + esc(b.date) : "") + '</small></td><td class="n">' + thb(b.total) + '<br><small class="muted">' + thb(b.commission) + "</small></td></tr>";
        }).join("") || '<tr><td class="empty">Geen boekingen in 30 dagen.</td></tr>') + "</tbody></table></div></div></div>";
      var s = d.settings, inf = s.info || {};
      h += '<div class="grid2 sec"><div class="card"><h2>Instellingen</h2><div class="pad"><dl class="dl">' +
        "<dt>Assistent</dt><dd>" + esc(inf.assistant || d.assistant) + "</dd><dt>Kantooruren</dt><dd>" + esc(s.hours || "–") + "</dd><dt>Antwoordt</dt><dd>" + (s.outsideOnly ? "alleen buiten kantooruren" : "dag en nacht") + "</dd><dt>Meldingen naar</dt><dd>" + esc(s.alert || "–") + "</dd>" +
        "<dt>Admins</dt><dd>" + esc(s.admins.join(", ") || "–") + "</dd><dt>Team</dt><dd>" + esc(s.staff.join(", ") || "–") + "</dd>" +
        "<dt>Afspraakpunt</dt><dd>" + esc(inf.meeting || "–") + "</dd><dt>Talen</dt><dd>" + esc(inf.languages || "–") + "</dd><dt>Noodnummer</dt><dd>" + esc(inf.emergency || "–") + "</dd>" +
        "</dl></div></div>" +
        '<div class="card"><h2>Producten</h2><div class="tw"><table class="t"><thead><tr><th>Product</th><th class="n">Prijs</th><th class="n">Aanbetaling</th><th class="n">Comm.</th><th>Online</th></tr></thead><tbody>' +
        (d.products.map(function (p) {
          return "<tr><td>" + esc(p.name) + ' <small class="muted">' + esc(p.code) + '</small></td><td class="n">' + thb(p.price) + '</td><td class="n">' + thb(p.deposit) + '</td><td class="n">' + nf.format(p.pct) + " %</td><td>" + (p.active ? '<span class="pill ok">aan</span>' : '<span class="pill">uit</span>') + "</td></tr>";
        }).join("") || '<tr><td class="empty" colspan="5">Geen producten.</td></tr>') + "</tbody></table></div></div></div>";
      h += '<div class="sec card"><h2>Wijzigingslog</h2><div class="pad log">' + (d.log.length ? esc(d.log.join("\n")) : "Nog geen wijzigingen.") + "</div></div>";
      setPage(d.name, h);
      bindSeg(function () { pCenter(slug); });
      $("#pz").onclick = function () { pause(d, this, function () { pCenter(slug); }); };
    }).catch(fail);
  }

  // ---------- Boekingen + Commissie ----------
  var bookMonth = "", bookCenter = "", bookStatus = "all";
  function monthBar(d, extra) {
    return '<select class="in" id="bm">' + d.months.map(function (m) { return '<option value="' + m.value + '"' + (m.value === d.month ? " selected" : "") + ">" + esc(monthName(m.value)) + "</option>"; }).join("") + "</select>" + (extra || "");
  }
  function monthName(v) { return new Date(v + "-15T12:00:00Z").toLocaleDateString("nl-BE", { month: "long", year: "numeric" }); }
  function bindMonth(again) { $("#bm").onchange = function () { bookMonth = this.value; again(); }; }
  function stripeNote(d) { return d.system.stripe === "test" ? '<div class="alert warn"><div class="x"><b>Stripe staat in testmodus</b>Bedragen en boekingen hieronder zijn testdata.</div></div>' : ""; }
  function bookingsData(fresh) { return load("b:" + (bookMonth || "now"), "bookings" + (bookMonth ? "?month=" + bookMonth : ""), fresh); }

  function pBookings(fresh) {
    setPage("Boekingen", '<div class="skel"></div>');
    bookingsData(fresh).then(function (d) {
      if (route().k !== "boekingen") return;
      bookMonth = d.month;
      var list = d.bookings.filter(function (b) { return state.withTest || !b.test; });
      if (bookCenter) list = list.filter(function (b) { return b.slug === bookCenter; });
      if (bookStatus === "live") list = list.filter(function (b) { return !b.cancelled; });
      if (bookStatus === "cx") list = list.filter(function (b) { return b.cancelled; });
      var live = list.filter(function (b) { return !b.cancelled; });
      var s = function (arr, k) { return arr.reduce(function (a, b) { return a + (b[k] || 0); }, 0); };
      var h = '<div class="bar">' + monthBar(d) + '<select class="in" id="bc"><option value="">Alle centra</option>' +
        d.centers.filter(function (c) { return state.withTest || !c.test; }).map(function (c) { return '<option value="' + esc(c.slug) + '"' + (c.slug === bookCenter ? " selected" : "") + ">" + esc(c.name) + "</option>"; }).join("") + "</select>" +
        '<div class="chips">' + [["all", "Alle"], ["live", "Actief"], ["cx", "Geannuleerd"]].map(function (f) { return '<button class="chip' + (bookStatus === f[0] ? " on" : "") + '" data-s="' + f[0] + '">' + f[1] + "</button>"; }).join("") + "</div>" +
        '<span class="sp"></span><button class="btn" id="bx">CSV exporteren</button></div>';
      h += stripeNote(d);
      h += '<div class="kpis">' + kpi("Boekingen", nf.format(live.length)) + kpi("Duikers", nf.format(s(live, "divers"))) + kpi("Waarde", thb(s(live, "total"))) +
        kpi("Commissie", thb(s(live, "commission"))) + kpi("Geannuleerd", nf.format(list.length - live.length)) + kpi("Terugbetaald", thb(s(list, "refunded"))) + "</div>";
      h += '<div class="sec card tw"><table class="t"><thead><tr><th>Gemaakt</th><th>Center</th><th>Ref</th><th>Klant</th><th>Product</th><th>Datum</th><th class="n">Duikers</th><th class="n">Waarde</th><th class="n">Commissie</th><th>Status</th></tr></thead><tbody>' +
        (list.map(function (b) {
          return "<tr><td>" + esc(date(b.created, true)) + "</td><td>" + esc(b.center) + "</td><td>" + esc(b.ref) + "</td><td>" + esc(b.name) + "</td><td>" + esc(b.product) + "</td><td>" + esc(b.date) + '</td><td class="n">' + b.divers + '</td><td class="n' + (b.cancelled ? " strike" : "") + '">' + thb(b.total) +
            '</td><td class="n">' + thb(b.commission) + "</td><td>" + (b.cancelled ? '<span class="pill warn">' + esc(b.status) + "</span>" : '<span class="pill ok">' + esc(b.status) + "</span>") + "</td></tr>";
        }).join("") || '<tr><td colspan="10" class="empty">Geen boekingen in ' + esc(monthName(d.month)) + ".</td></tr>") + "</tbody></table></div>";
      setPage("Boekingen", h);
      bindMonth(pBookings);
      $("#bc").onchange = function () { bookCenter = this.value; pBookings(); };
      $$(".chip[data-s]").forEach(function (b) { b.onclick = function () { bookStatus = b.getAttribute("data-s"); pBookings(); }; });
      $("#bx").onclick = function () {
        csv("talay-boekingen-" + d.month + ".csv", [["Gemaakt", "Center", "Ref", "Klant", "Product", "Activiteitsdatum", "Duikers", "Waarde THB", "Commissie THB", "Terugbetaald THB", "Status"]].concat(
          list.map(function (b) { return [b.created.slice(0, 16).replace("T", " "), b.center, b.ref, b.name, b.product, b.date, b.divers, b.total, b.commission, b.refunded, b.status]; })));
      };
    }).catch(fail);
  }

  function pCommission(fresh) {
    setPage("Commissie", '<div class="skel"></div>');
    bookingsData(fresh).then(function (d) {
      if (route().k !== "commissie") return;
      bookMonth = d.month;
      var rows = d.centers.filter(function (c) { return state.withTest || !c.test; }).map(function (c) {
        var bs = d.bookings.filter(function (b) { return b.slug === c.slug; }), live = bs.filter(function (b) { return !b.cancelled; });
        var r = { c: c, n: live.length, cx: bs.length - live.length, divers: 0, value: 0, gross: 0, refunded: 0, list: bs };
        live.forEach(function (b) { r.divers += b.divers; r.value += b.total; });
        bs.forEach(function (b) { r.gross += b.commission; r.refunded += b.refunded; });
        r.net = r.gross - r.refunded;
        return r;
      });
      var tot = rows.reduce(function (a, r) { ["n", "cx", "divers", "value", "gross", "refunded", "net"].forEach(function (k) { a[k] += r[k]; }); return a; }, { n: 0, cx: 0, divers: 0, value: 0, gross: 0, refunded: 0, net: 0 });
      var h = '<div class="bar">' + monthBar(d) + '<span class="sp"></span><button class="btn primary" id="cx">CSV voor facturatie</button></div>';
      h += stripeNote(d);
      h += '<div class="kpis">' + kpi("Netto commissie", thb(tot.net)) + kpi("Bruto commissie", thb(tot.gross)) + kpi("Terugbetaald", thb(tot.refunded)) + kpi("Boekingswaarde", thb(tot.value)) + kpi("Boekingen", nf.format(tot.n)) + kpi("Geannuleerd", nf.format(tot.cx)) + "</div>";
      h += '<div class="sec card tw"><table class="t"><thead><tr><th>Center</th><th class="n">Boekingen</th><th class="n">Geannuleerd</th><th class="n">Duikers</th><th class="n">Waarde</th><th class="n">Commissie</th><th class="n">Terugbetaald</th><th class="n">Netto</th><th></th></tr></thead><tbody>' +
        rows.map(function (r) {
          return '<tr><td class="nm"><b>' + esc(r.c.name) + '</b></td><td class="n">' + r.n + '</td><td class="n">' + r.cx + '</td><td class="n">' + r.divers + '</td><td class="n">' + thb(r.value) + '</td><td class="n">' + thb(r.gross) + '</td><td class="n">' + thb(r.refunded) + '</td><td class="n"><b>' + thb(r.net) + '</b></td><td class="n"><button class="btn" data-csv="' + esc(r.c.slug) + '"' + (r.list.length ? "" : " disabled") + ">CSV</button></td></tr>";
        }).join("") + '</tbody><tfoot><tr><td>Totaal</td><td class="n">' + tot.n + '</td><td class="n">' + tot.cx + '</td><td class="n">' + tot.divers + '</td><td class="n">' + thb(tot.value) + '</td><td class="n">' + thb(tot.gross) + '</td><td class="n">' + thb(tot.refunded) + '</td><td class="n">' + thb(tot.net) + "</td><td></td></tr></tfoot></table></div>";
      h += '<p class="muted" style="font-size:13.5px">Per maand van aanmaak van de boeking (Koh Tao-tijd). Commissie = Commission THB, anders de betaalde aanbetaling. Netto = commissie min terugbetaald.</p>';
      setPage("Commissie", h);
      bindMonth(pCommission);
      var lines = function (list) { return list.map(function (b) { return [b.center, b.created.slice(0, 10), b.ref, b.name, b.product, b.date, b.divers, b.total, b.commission, b.refunded, b.commission - b.refunded, b.status]; }); };
      var head = [["Center", "Gemaakt", "Ref", "Klant", "Product", "Activiteitsdatum", "Duikers", "Waarde THB", "Commissie THB", "Terugbetaald THB", "Netto THB", "Status"]];
      $("#cx").onclick = function () { csv("talay-commissie-" + d.month + ".csv", head.concat(lines([].concat.apply([], rows.map(function (r) { return r.list; }))))); };
      $$("[data-csv]").forEach(function (b) { b.onclick = function () { var r = rows.find(function (x) { return x.c.slug === b.getAttribute("data-csv"); }); csv("talay-commissie-" + r.c.slug + "-" + d.month + ".csv", head.concat(lines(r.list))); }; });
    }).catch(fail);
  }

  // ---------- Pijplijn ----------
  var STAGES = ["To contact", "Pitched", "Talking", "Trial", "Signed", "Live", "No"];
  var STAGE_NL = { "To contact": "Te benaderen", Pitched: "Gepitcht", Talking: "In gesprek", Trial: "Proef", Signed: "Getekend", Live: "Live", No: "Nee" };
  var pipeStage = store.get("pipe", "active"), pipeQ = "";
  function stagePill(s) { return '<span class="pill st-' + esc(s.split(" ")[0]) + '">' + esc(STAGE_NL[s] || s) + "</span>"; }
  function pipeOpen(p) { return p.stage !== "No" && p.stage !== "Live"; }
  function dueOf(p, today) { return p.nextDate && pipeOpen(p) ? (p.nextDate < today ? "late" : p.nextDate === today ? "today" : "later") : ""; }
  function dueText(p, today) {
    var k = dueOf(p, today); if (!k) return p.nextDate ? esc(date(p.nextDate + "T12:00:00Z")) : "";
    var days = Math.round((Date.parse(p.nextDate + "T12:00:00Z") - Date.parse(today + "T12:00:00Z")) / 864e5);
    return '<span class="due ' + k + '">' + (k === "today" ? "vandaag" : k === "late" ? -days + " d te laat" : esc(date(p.nextDate + "T12:00:00Z"))) + "</span>";
  }
  function pipeBadge(d) {
    var n = $("#n-pijplijn"); if (!n || !d || d.missing) return;
    var k = d.items.filter(function (p) { var x = dueOf(p, d.today); return x === "late" || x === "today"; }).length;
    n.hidden = !k; n.className = "count"; n.textContent = k;
  }
  // Claude's proposal for one center: a draft to send yourself, plus stage, next step, date and owner.
  // Nothing is sent from HQ. "Verstuurd" logs the message in Notes with the tag [verstuurd],
  // a pasted reply is logged with [antwoord]; the server counts reminders from those tags.
  var drafts = {};
  var CH_NL = { WhatsApp: "WhatsApp", Instagram: "Instagram", Email: "e-mail", Visit: "bezoek" };
  function aiAsk(p, reply) {
    return post("pipeline/ai", { id: p.id, mode: reply ? "reply" : "next", reply: reply || "" })
      .then(function (r) { r.reply = reply || ""; drafts[p.id] = r; return r; });
  }
  function aiBox(p, r) {
    var wa = String(p.whatsapp || "").replace(/[^\d]/g, ""), ig = String(p.instagram || "").replace(/^https?:\/\//, "").replace(/^@/, "");
    if (ig && ig.indexOf("/") < 0) ig = "instagram.com/" + ig;
    var send = r.channel !== "Visit" && r.message;
    var h = '<div class="aip"><p class="aisum">' + esc(r.summary) + "</p>";
    if (r.message) h += '<label>' + (r.channel === "Visit" ? "Briefing voor John" : "Bericht via " + esc(CH_NL[r.channel] || r.channel)) + '<textarea class="aim" rows="5">' + esc(r.message) + "</textarea></label>";
    h += '<div class="aiacts">' + (r.message ? '<button type="button" class="btn" data-a="copy">Kopieer</button>' : "") +
      (send && r.channel === "WhatsApp" && wa ? '<a class="btn" data-a="open" target="_blank" rel="noopener" href="#">Open in WhatsApp</a>' : "") +
      (send && r.channel === "Email" && p.email ? '<a class="btn" data-a="open" href="#">Open mail</a>' : "") +
      (send && r.channel === "Instagram" && ig ? '<a class="btn" data-a="open" target="_blank" rel="noopener" href="https://' + esc(ig) + '">Kopieer en open Instagram</a>' : "") + "</div>";
    h += '<div class="fg aifg"><label>Fase<select class="in" data-f="stage">' + STAGES.map(function (s) { return '<option value="' + s + '"' + (s === r.stage ? " selected" : "") + ">" + STAGE_NL[s] + "</option>"; }).join("") + "</select></label>" +
      '<label>Wie volgt op<input class="in" data-f="owner" value="' + esc(r.owner) + '"></label>' +
      '<label>Volgende stap<input class="in" data-f="next" value="' + esc(r.next) + '"></label>' +
      '<label>Wanneer<input class="in" type="date" data-f="nextDate" value="' + esc(r.nextDate) + '"></label></div>';
    h += '<div class="err" hidden></div><div class="aiacts end">' + (send ? '<button type="button" class="btn primary" data-a="sent">Verstuurd, voorstel bewaren</button><button type="button" class="btn" data-a="save">Alleen voorstel bewaren</button>' : '<button type="button" class="btn primary" data-a="save">Voorstel bewaren</button>') +
      '<button type="button" class="btn" data-a="drop">Weg</button></div></div>';
    return h;
  }
  // Fills el with the proposal and wires its buttons; done() runs after saving or dropping.
  function aiBind(el, p, r, done) {
    el.innerHTML = aiBox(p, r);
    var msg = function () { var t = el.querySelector(".aim"); return t ? t.value.trim() : ""; };
    var copy = function () { try { navigator.clipboard.writeText(msg()); } catch (e) {} };
    var a = function (k) { return el.querySelector('[data-a="' + k + '"]'); };
    if (a("copy")) a("copy").onclick = function () { copy(); this.textContent = "Gekopieerd"; };
    if (a("open")) a("open").onclick = function (e) {
      var wa = String(p.whatsapp || "").replace(/[^\d]/g, "");
      if (r.channel === "WhatsApp") this.href = "https://wa.me/" + wa + "?text=" + encodeURIComponent(msg());
      else if (r.channel === "Email") this.href = "mailto:" + p.email + "?subject=" + encodeURIComponent("Talay") + "&body=" + encodeURIComponent(msg());
      else copy();
    };
    var save = function (sent) {
      var f = function (k) { return el.querySelector('[data-f="' + k + '"]').value; }, lines = [];
      if (r.reply) lines.push("[antwoord] " + r.reply.replace(/\s+/g, " ").slice(0, 600));
      lines.push("Claude: " + r.summary);
      if (sent) lines.push("[verstuurd] via " + (CH_NL[r.channel] || r.channel) + ": " + msg().replace(/\s+/g, " ").slice(0, 600));
      var body = { action: "update", id: p.id, stage: f("stage"), owner: f("owner"), next: f("next"), nextDate: f("nextDate"), note: lines.join("\n") };
      el.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
      post("pipeline", body).then(function () { delete drafts[p.id]; delete state.cache.pipe; done(true); })
        .catch(function (x) { el.querySelectorAll("button").forEach(function (b) { b.disabled = false; }); var er = el.querySelector(".err"); er.hidden = false; er.textContent = x.message; });
    };
    if (a("sent")) a("sent").onclick = function () { save(true); };
    a("save").onclick = function () { save(false); };
    a("drop").onclick = function () { delete drafts[p.id]; done(false); };
  }
  function aiFill(el, p, reply, done) {
    el.innerHTML = '<p class="muted aisum">Claude denkt na…</p>';
    return aiAsk(p, reply).then(function (r) { aiBind(el, p, r, done); })
      .catch(function (x) { el.innerHTML = '<div class="err">' + esc(x.message) + "</div>"; });
  }
  function pPipeline(fresh) {
    if (!state.cache.pipe) setPage("Pijplijn", '<div class="skel"></div>');
    load("pipe", "pipeline", fresh).then(function (d) {
      pipeBadge(d);
      if (route().k !== "pijplijn") return;
      if (d.missing) { setPage("Pijplijn", '<div class="alert warn"><div class="x"><b>Nog niet ingesteld</b>De pijplijn staat in de Airtable-tabel Prospects. Die tabel bestaat nog niet: maak hem aan en importeer de CSV uit de leadlijst (zie de stappen in de PR).</div></div>'); return; }
      var today = d.today, all = d.items;
      var count = function (f) { return all.filter(f).length; };
      var follow = all.filter(function (p) { var k = dueOf(p, today); return k === "late" || k === "today"; })
        .sort(function (a, b) { return a.nextDate.localeCompare(b.nextDate); });
      var h = '<div class="kpis">' +
        kpi("Gepitcht", nf.format(count(function (p) { return p.stage === "Pitched"; }))) +
        kpi("In gesprek", nf.format(count(function (p) { return p.stage === "Talking"; }))) +
        kpi("Proef", nf.format(count(function (p) { return p.stage === "Trial"; }))) +
        kpi("Getekend of live", nf.format(count(function (p) { return p.stage === "Signed" || p.stage === "Live"; }))) +
        kpi("Op te volgen", nf.format(follow.length), '<span class="d' + (follow.some(function (p) { return dueOf(p, today) === "late"; }) ? " down" : "") + '">vandaag of te laat</span>') +
        kpi("Nee", nf.format(count(function (p) { return p.stage === "No"; }))) + "</div>";
      if (follow.length) h += '<div class="sec"><div class="ait"><h2>Vandaag opvolgen</h2><button class="btn" id="pall">Concepten klaarzetten</button></div><div class="card rows fol">' + follow.map(function (p) {
        return '<div class="fit"><a class="row" href="#/pijplijn" data-p="' + esc(p.id) + '"><div class="x"><div class="l1"><b>' + esc(p.name) + "</b>" + stagePill(p.stage) + (p.owner ? '<span class="muted">' + esc(p.owner) + "</span>" : "") +
          '</div><div class="pv">' + esc(p.next || "Geen volgende stap ingevuld") + "</div></div>" + dueText(p, today) + '<button class="btn" data-ai="' + esc(p.id) + '">Concept</button></a><div class="aiw" data-w="' + esc(p.id) + '"></div></div>';
      }).join("") + "</div></div>";
      var chips = [["active", "Actief", count(pipeOpen)]].concat(STAGES.map(function (s) { return [s, STAGE_NL[s], count(function (p) { return p.stage === s; })]; })).concat([["all", "Alle", all.length]]);
      h += '<div class="sec bar"><div class="chips">' + chips.map(function (c) {
        return '<button class="chip' + (pipeStage === c[0] ? " on" : "") + '" data-st="' + esc(c[0]) + '">' + esc(c[1]) + '<span class="c">' + c[2] + "</span></button>";
      }).join("") + '</div></div><div class="bar"><input class="in" id="pq" type="search" placeholder="Zoek center" value="' + esc(pipeQ) + '"><span class="sp"></span><button class="btn" id="px">CSV</button><button class="btn primary" id="padd">+ Center</button></div>';
      var list = all.filter(function (p) { return pipeStage === "all" ? true : pipeStage === "active" ? pipeOpen(p) : p.stage === pipeStage; });
      if (pipeQ) list = list.filter(function (p) { return (p.name + " " + p.area + " " + p.contact).toLowerCase().indexOf(pipeQ.toLowerCase()) > -1; });
      var ord = function (p) { return STAGES.indexOf(p.stage); };
      list.sort(function (a, b) {
        return (ord(b) - ord(a)) || ((a.nextDate || "9") > (b.nextDate || "9") ? 1 : (a.nextDate || "9") < (b.nextDate || "9") ? -1 : 0) || ((a.priority || 9) - (b.priority || 9)) || a.name.localeCompare(b.name);
      });
      h += '<div class="card tw"><table class="t"><thead><tr><th>Center</th><th>Fase</th><th>Volgende stap</th><th>Wanneer</th><th>Wie</th><th>Laatste contact</th></tr></thead><tbody>' +
        (list.map(function (p) {
          return '<tr class="link" data-p="' + esc(p.id) + '"><td class="nm"><b>' + esc(p.name) + "</b><small>" + esc([p.area, p.language].filter(Boolean).join(" · ")) + "</small></td><td>" + stagePill(p.stage) +
            "</td><td>" + esc(p.next) + "</td><td>" + dueText(p, today) + "</td><td>" + esc(p.owner) + "</td><td>" + (p.last ? esc(date(p.last + "T12:00:00Z")) : '<span class="muted">–</span>') + "</td></tr>";
        }).join("") || '<tr><td colspan="6" class="empty">Geen centra in deze selectie.</td></tr>') + "</tbody></table></div>";
      h += '<p class="muted" style="font-size:13.5px">Klik op een center om de fase, de volgende stap of een notitie te bewaren. Alles staat in de Airtable-tabel Prospects.</p>';
      setPage("Pijplijn", h);
      $$(".chip[data-st]").forEach(function (b) { b.onclick = function () { pipeStage = b.getAttribute("data-st"); store.set("pipe", pipeStage); pPipeline(); }; });
      $("#pq").oninput = function () { var v = this.value, pos = this.selectionStart; pipeQ = v; pPipeline(); var i = $("#pq"); i.focus(); try { i.setSelectionRange(pos, pos); } catch (e) {} };
      $$("[data-p]").forEach(function (r) { r.onclick = function (e) { e.preventDefault(); prospectDialog(all.find(function (p) { return p.id === r.getAttribute("data-p"); }), today); }; });
      $("#padd").onclick = function () { prospectDialog(null, today); };
      var box = function (id) { return document.querySelector('[data-w="' + id + '"]'); };
      var after = function (saved) { if (saved) pPipeline(true); else pPipeline(); };
      follow.forEach(function (p) { if (drafts[p.id]) aiBind(box(p.id), p, drafts[p.id], after); });
      $$("[data-ai]").forEach(function (b) {
        b.onclick = function (e) { e.preventDefault(); e.stopPropagation(); var p = all.find(function (x) { return x.id === b.getAttribute("data-ai"); }); aiFill(box(p.id), p, "", after); };
      });
      if ($("#pall")) $("#pall").onclick = function () {
        var todo = follow.filter(function (p) { return !drafts[p.id]; }), btn = this, left = todo.length;
        if (!left) return;
        btn.disabled = true; btn.textContent = "Bezig: " + left + " te gaan";
        var next = function () {
          var p = todo.shift(); if (!p) return Promise.resolve();
          return aiFill(box(p.id), p, "", after).then(function () { left--; btn.textContent = left ? "Bezig: " + left + " te gaan" : "Klaar"; return next(); });
        };
        Promise.all([next(), next()]);
      };
      $("#px").onclick = function () {
        csv("talay-pijplijn-" + today + ".csv", [["Center", "Fase", "Prioriteit", "Gebied", "Taal", "Contactpersoon", "WhatsApp", "E-mail", "Instagram", "Wie", "Volgende stap", "Datum", "Laatste contact", "Notities"]].concat(
          all.map(function (p) { return [p.name, STAGE_NL[p.stage], p.priority || "", p.area, p.language, p.contact, p.whatsapp, p.email, p.instagram, p.owner, p.next, p.nextDate, p.last, p.notes]; })));
      };
    }).catch(fail);
  }
  function prospectDialog(p, today) {
    var isNew = !p; p = p || { stage: "To contact" };
    var dlg = $("#pdlg");
    if (!dlg) { dlg = document.createElement("dialog"); dlg.id = "pdlg"; dlg.className = "dlg"; document.body.appendChild(dlg); }
    var wa = String(p.whatsapp || "").replace(/[^\d]/g, ""), ig = String(p.instagram || "").replace(/^https?:\/\//, "");
    var field = function (k, label, type) { return '<label>' + label + '<input class="in" name="' + k + '" type="' + (type || "text") + '" value="' + esc(p[k] || "") + '"></label>'; };
    var sel = '<select class="in" name="stage">' + STAGES.map(function (s) { return '<option value="' + s + '"' + (s === p.stage ? " selected" : "") + ">" + STAGE_NL[s] + "</option>"; }).join("") + "</select>";
    dlg.innerHTML = '<form method="dialog" id="pf"><h3>' + (isNew ? '<input class="in" name="name" placeholder="Naam van het center" required style="flex:1">' : esc(p.name) + " " + stagePill(p.stage)) + '<button type="button" class="btn x" id="pc">Sluiten</button></h3>' +
      (isNew ? "" : '<div class="ptop"><button type="button" class="btn primary" id="pnx">Concept volgend bericht</button><button type="button" class="btn" id="pro">Antwoord plakken</button><span class="sp"></span>' +
        (wa ? '<a class="btn" target="_blank" rel="noopener" href="https://wa.me/' + wa + '">WhatsApp</a>' : "") + (p.email ? '<a class="btn" href="mailto:' + esc(p.email) + '">Mail</a>' : "") + (ig ? '<a class="btn" target="_blank" rel="noopener" href="https://' + esc(ig) + '">IG</a>' : "") + "</div>" +
        '<div class="prw" id="prw" hidden><textarea id="prp" placeholder="Plak hier wat het center antwoordde (of niet echt antwoordde). Claude vat het samen en stelt de volgende stap voor."></textarea><div class="aiacts end"><button type="button" class="btn primary" id="prb">Analyseer antwoord</button></div></div>' +
        '<div id="pai"></div>') +
      '<div class="fg3"><label>Fase' + sel + "</label>" + field("owner", "Wie volgt op") + field("nextDate", "Wanneer", "date") + "</div>" +
      '<label class="pfull">Volgende stap<input class="in" name="next" value="' + esc(p.next || "") + '" placeholder="bv. John gaat langs"></label>' +
      '<label class="pfull">Notitie toevoegen<textarea name="note" rows="2" placeholder="Wat werd er gezegd? Komt bovenaan de notities, met datum en je naam."></textarea></label>' +
      '<details class="pdet"' + (isNew ? " open" : "") + "><summary>Contactgegevens" + (isNew ? "" : '<span class="muted">' + esc([p.contact, p.area, p.language].filter(Boolean).join(" · ")) + "</span>") + '</summary><div class="fg">' +
      field("contact", "Contactpersoon") + field("whatsapp", "WhatsApp") + field("email", "E-mail", "email") + field("instagram", "Instagram") + field("area", "Gebied") + field("language", "Taal") + "</div></details>" +
      (p.notes ? '<div class="log">' + esc(p.notes) + "</div>" : "") +
      '<div class="err" id="perr" hidden></div><div class="acts"><button type="submit" class="btn primary" id="ps">Bewaren</button></div></form>';
    dlg.showModal();
    $("#pc").onclick = function () { dlg.close(); };
    if (!isNew) {
      var done = function (saved) { if (saved) { dlg.close(); pPipeline(true); } else $("#pai").innerHTML = ""; };
      if (drafts[p.id]) aiBind($("#pai"), p, drafts[p.id], done);
      $("#pnx").onclick = function () { aiFill($("#pai"), p, "", done); };
      $("#pro").onclick = function () { var w = $("#prw"); w.hidden = !w.hidden; if (!w.hidden) $("#prp").focus(); };
      $("#prb").onclick = function () { var t = $("#prp").value.trim(); if (t) aiFill($("#pai"), p, t, done); else $("#prp").focus(); };
    }
    $("#pf").onsubmit = function (e) {
      e.preventDefault();
      var f = e.target, body = { action: isNew ? "add" : "update", id: p.id };
      ["stage", "owner", "next", "nextDate", "contact", "whatsapp", "email", "instagram", "area", "language", "note"].forEach(function (k) { body[k] = f.elements[k].value; });
      if (isNew) body.name = f.elements.name.value;
      var b = $("#ps"); b.disabled = true;
      post("pipeline", body).then(function () { dlg.close(); delete state.cache.pipe; pPipeline(true); })
        .catch(function (x) { b.disabled = false; var er = $("#perr"); er.hidden = false; er.textContent = x.message; });
    };
  }

  // ---------- Mailcampagne ----------
  // Table Outreach, kept up to date from Instantly by the cron. Replies are answered in the
  // Instantly Unibox; here you see who answered and put interested centers in Pijplijn.
  var OST = ["Interested", "Replied", "Out of office", "Wrong person", "Not interested", "Bounced", "Unsubscribed", "Sent", "No reply", "Queued", "Skipped"];
  var OST_NL = { Interested: "Interesse", Replied: "Antwoord", "Out of office": "Afwezig", "Wrong person": "Verkeerde persoon", "Not interested": "Geen interesse", Bounced: "Bounce", Unsubscribed: "Uitgeschreven", Sent: "Gemaild", "No reply": "Geen antwoord", Queued: "Nog niet gemaild", Skipped: "Overgeslagen" };
  var OST_PILL = { Interested: "ok", Replied: "sand", "Not interested": "bad", Bounced: "bad", Unsubscribed: "bad", "Out of office": "warn", "Wrong person": "warn" };
  var ANSWERED = { Interested: 1, Replied: 1, "Out of office": 1, "Wrong person": 1, "Not interested": 1 };
  var mailSt = store.get("mail", "all"), mailQ = "";
  function oPill(s) { return '<span class="pill ' + (OST_PILL[s] || "") + '">' + esc(OST_NL[s] || s) + "</span>"; }
  function mailed(o) { return o.status !== "Queued" && o.status !== "Skipped"; }
  function pOutreach(fresh) {
    if (!state.cache.mail) setPage("Mailcampagne", '<div class="skel"></div>');
    load("mail", "outreach", fresh).then(function (d) {
      if (route().k !== "mail") return;
      if (d.missing) { setPage("Mailcampagne", '<div class="alert warn"><div class="x"><b>Nog niet ingesteld</b>Maak in Airtable de tabel <b>Outreach</b> door de campagne-CSV te importeren (zie de stappen in de PR).</div></div>'); return; }
      var all = d.items, count = function (f) { return all.filter(f).length; };
      var sent = count(mailed), ans = count(function (o) { return ANSWERED[o.status]; });
      var h = d.synced ? "" : '<div class="alert warn"><div class="x"><b>Nog geen koppeling met Instantly</b>Zet de sleutel INSTANTLY_API_KEY als Secret in Cloudflare. Tot dan blijven de statussen staan zoals in de CSV.</div></div>';
      h += '<div class="kpis">' +
        kpi("Gemaild", nf.format(sent) + " <small>van " + nf.format(all.length) + "</small>") +
        kpi("Antwoorden", nf.format(ans), '<span class="d">' + (sent ? Math.round(ans / sent * 1000) / 10 + "% van gemaild" : "nog niets gemaild") + "</span>") +
        kpi("Interesse", nf.format(count(function (o) { return o.status === "Interested"; }))) +
        kpi("Geen interesse", nf.format(count(function (o) { return o.status === "Not interested" || o.status === "Wrong person"; }))) +
        kpi("Bounces", nf.format(count(function (o) { return o.status === "Bounced"; })), '<span class="d' + (sent && count(function (o) { return o.status === "Bounced"; }) / sent > 0.03 ? " down" : "") + '">houd onder 3%</span>') +
        kpi("Uitgeschreven", nf.format(count(function (o) { return o.status === "Unsubscribed"; }))) + "</div>";
      var todo = all.filter(function (o) { return (o.status === "Interested" || o.status === "Replied") && !o.inPipeline; })
        .sort(function (a, b) { return b.eventAt.localeCompare(a.eventAt); });
      h += '<div class="sec"><div class="ait"><h2>Op te volgen</h2><a class="btn" target="_blank" rel="noopener" href="https://app.instantly.ai/app/unibox">Open Unibox</a></div>';
      h += todo.length ? '<div class="card rows fol">' + todo.map(function (o) {
        return '<div class="fit"><div class="row"><div class="x"><div class="l1"><b>' + esc(o.company || o.email) + "</b>" + oPill(o.status) + '<span class="muted">' + esc([o.town, o.country].filter(Boolean).join(", ")) + "</span></div>" +
          '<div class="pv">' + esc(o.reply || "Geen tekst opgehaald, kijk in de Unibox.") + '</div></div><span class="muted">' + esc(o.eventAt) + '</span><button class="btn primary" data-pipe="' + esc(o.id) + '">Naar Pijplijn</button><button class="btn" data-note="' + esc(o.id) + '">Notitie</button></div></div>';
      }).join("") + "</div>" : '<div class="card pad muted">Nog geen antwoorden die opvolging vragen.</div>';
      h += "</div>";
      var camps = {};
      all.forEach(function (o) {
        var c = camps[o.campaign || "–"] = camps[o.campaign || "–"] || { n: 0, sent: 0, ans: 0, int: 0, bounce: 0 };
        c.n++; if (mailed(o)) c.sent++; if (ANSWERED[o.status]) c.ans++; if (o.status === "Interested") c.int++; if (o.status === "Bounced") c.bounce++;
      });
      h += '<div class="sec card tw"><table class="t"><thead><tr><th>Campagne</th><th class="n">Centra</th><th class="n">Gemaild</th><th class="n">Antwoorden</th><th class="n">Interesse</th><th class="n">Bounces</th></tr></thead><tbody>' +
        Object.keys(camps).sort().map(function (k) { var c = camps[k]; return "<tr><td><b>" + esc(k) + '</b></td><td class="n">' + c.n + '</td><td class="n">' + c.sent + '</td><td class="n">' + c.ans + (c.sent ? ' <small class="muted">' + Math.round(c.ans / c.sent * 100) + "%</small>" : "") + '</td><td class="n">' + c.int + '</td><td class="n">' + c.bounce + "</td></tr>"; }).join("") + "</tbody></table></div>";
      var chips = [["all", "Alle", all.length], ["answered", "Geantwoord", ans]].concat(OST.map(function (s) { return [s, OST_NL[s], count(function (o) { return o.status === s; })]; }).filter(function (c) { return c[2]; }));
      h += '<div class="sec bar"><div class="chips">' + chips.map(function (c) {
        return '<button class="chip' + (mailSt === c[0] ? " on" : "") + '" data-ms="' + esc(c[0]) + '">' + esc(c[1]) + '<span class="c">' + c[2] + "</span></button>";
      }).join("") + '</div></div><div class="bar"><input class="in" id="mq" type="search" placeholder="Zoek center, e-mail of plaats" value="' + esc(mailQ) + '"><span class="sp"></span><button class="btn" id="mx">CSV</button><button class="btn primary" id="msync"' + (d.synced ? "" : " disabled") + ">Nu synchroniseren</button></div>";
      var list = all.filter(function (o) { return mailSt === "all" ? true : mailSt === "answered" ? ANSWERED[o.status] : o.status === mailSt; });
      if (mailQ) list = list.filter(function (o) { return (o.company + " " + o.email + " " + o.town + " " + o.country).toLowerCase().indexOf(mailQ.toLowerCase()) > -1; });
      list.sort(function (a, b) { return (OST.indexOf(a.status) - OST.indexOf(b.status)) || b.eventAt.localeCompare(a.eventAt) || a.company.localeCompare(b.company); });
      h += '<div class="card tw"><table class="t"><thead><tr><th>Center</th><th>Campagne</th><th>Status</th><th>Laatste</th><th>Antwoord</th></tr></thead><tbody>' +
        (list.slice(0, 500).map(function (o) {
          return '<tr><td class="nm"><b>' + esc(o.company || o.email) + "</b><small>" + esc([o.email, o.town, o.country].filter(Boolean).join(" · ")) + "</small></td><td>" + esc(o.campaign) + "</td><td>" + oPill(o.status) + (o.inPipeline ? ' <span class="pill st-Talking">Pijplijn</span>' : "") +
            "</td><td>" + esc(o.eventAt) + '</td><td class="muted">' + esc(o.reply.slice(0, 140)) + "</td></tr>";
        }).join("") || '<tr><td colspan="5" class="empty">Geen centra in deze selectie.</td></tr>') + "</tbody></table></div>";
      h += '<p class="muted" style="font-size:13.5px">Statussen komen elke 15 minuten uit Instantly. Antwoorden doe je zelf in de Unibox; zet daar ook het label (Interested, Not interested…), dat komt hier terug. Alles staat in de Airtable-tabel Outreach.</p>';
      setPage("Mailcampagne", h);
      $$(".chip[data-ms]").forEach(function (b) { b.onclick = function () { mailSt = b.getAttribute("data-ms"); store.set("mail", mailSt); pOutreach(); }; });
      $("#mq").oninput = function () { var pos = this.selectionStart; mailQ = this.value; pOutreach(); var i = $("#mq"); i.focus(); try { i.setSelectionRange(pos, pos); } catch (e) {} };
      var again = function () { delete state.cache.mail; delete state.cache.pipe; pOutreach(true); };
      $$("[data-pipe]").forEach(function (b) {
        b.onclick = function () { b.disabled = true; post("outreach", { action: "pipeline", id: b.getAttribute("data-pipe") }).then(again).catch(function (x) { b.disabled = false; alert(x.message); }); };
      });
      $$("[data-note]").forEach(function (b) {
        b.onclick = function () { var t = prompt("Notitie (komt met datum en je naam in Outreach → Notes):"); if (!t) return; post("outreach", { action: "note", id: b.getAttribute("data-note"), note: t }).then(again).catch(function (x) { alert(x.message); }); };
      });
      $("#msync").onclick = function () {
        var b = this; b.disabled = true; b.textContent = "Bezig…";
        post("outreach", { action: "sync" }).then(function (r) { if (r.left) alert("Nog " + r.left + " rijen te verwerken: die volgen bij de volgende sync."); again(); })
          .catch(function (x) { b.disabled = false; b.textContent = "Nu synchroniseren"; alert(x.message); });
      };
      $("#mx").onclick = function () {
        csv("talay-mailcampagne-" + new Date().toISOString().slice(0, 10) + ".csv", [["Center", "E-mail", "Lead ID", "Campagne", "Plaats", "Land", "Status", "Interesse", "Laatste", "Antwoord", "Notities"]].concat(
          all.map(function (o) { return [o.company, o.email, o.lead, o.campaign, o.town, o.country, OST_NL[o.status] || o.status, o.interest, o.eventAt, o.reply, o.notes]; })));
      };
    }).catch(fail);
  }

  // ---------- Conversie ----------
  var convPer = "";
  function pConversion(fresh) {
    setPage("Conversie", '<div class="skel"></div>');
    load("conv:" + (convPer || "30d"), "conversion" + (convPer ? "?period=" + convPer : ""), fresh).then(function (d) {
      if (route().k !== "conversie") return;
      var rows = d.centers.filter(function (c) { return state.withTest || !c.test; });
      var t = { conversations: 0, linkSent: 0, opened: 0, booked: 0, outsideHours: 0, afterFollowUp: 0, handedOver: 0, value: 0 };
      rows.forEach(function (c) {
        if (c.error) return;
        t.conversations += c.conversations; t.linkSent += c.funnel.linkSent; t.opened += c.funnel.opened; t.booked += c.funnel.booked;
        t.outsideHours += c.outsideHours; t.afterFollowUp += c.afterFollowUp; t.handedOver += c.handedOver; t.value += c.value;
      });
      var pct = function (a, b) { return b ? nf.format(Math.round(a / b * 1000) / 10) + " %" : "–"; };
      var h = '<div class="bar"><select class="in" id="cp"><option value="">Laatste 30 dagen</option>' + d.months.map(function (m) { return '<option value="' + m.value + '"' + (m.value === convPer ? " selected" : "") + ">" + esc(monthName(m.value)) + "</option>"; }).join("") + "</select></div>";
      var steps = [["Gesprekken", t.conversations, "duikers die schreven"], ["Boekingslink gekregen", t.linkSent, "van de assistent of het team"], ["Betaalpagina geopend", t.opened, "datum en duikers gekozen"], ["Geboekt", t.booked, "aanbetaling betaald"]];
      h += '<div class="card"><h2>Van vraag tot boeking</h2><div class="fun">' + steps.map(function (s, i) {
        return '<div class="st"><b>' + nf.format(s[1]) + "</b><span>" + s[0] + '</span><i><em style="width:' + (t.conversations ? Math.max(2, Math.round(s[1] / t.conversations * 100)) : 0) + '%"></em></i><small>' +
          (i ? pct(s[1], steps[i - 1][1]) + " van de stap ervoor" : esc(s[2])) + "</small></div>";
      }).join("") + "</div></div>";
      h += '<div class="kpis sec">' + kpi("Conversie", pct(t.booked, t.conversations), '<span class="d">gesprek → boeking</span>') +
        kpi("Buiten kantooruren", nf.format(t.outsideHours), '<span class="d">' + pct(t.outsideHours, t.conversations) + " van de gesprekken</span>") +
        kpi("Geboekt na follow-up", nf.format(t.afterFollowUp), '<span class="d">zonder follow-up gemist</span>') +
        kpi("Overdrachten", nf.format(t.handedOver), '<span class="d">' + pct(t.handedOver, t.conversations) + " naar het team</span>") +
        kpi("Boekingswaarde", thb(t.value)) + kpi("Waarde per gesprek", t.conversations ? thb(t.value / t.conversations) : "–") + "</div>";
      h += '<div class="sec card tw"><table class="t"><thead><tr><th>Center</th><th class="n">Gesprekken</th><th class="n">Link</th><th class="n">Betaalpagina</th><th class="n">Geboekt</th><th class="n">Conversie</th><th class="n">Buiten uren</th><th class="n">Na follow-up</th><th class="n">Overdracht</th><th class="n">Waarde</th></tr></thead><tbody>' +
        (rows.map(function (c) {
          if (c.error) return '<tr><td class="nm"><b>' + esc(c.name) + '</b></td><td colspan="9" class="muted">Cijfers konden niet geladen worden.</td></tr>';
          return '<tr class="link' + (c.test && !state.withTest ? " muted" : "") + '" data-href="#/centra/' + esc(c.slug) + '"><td class="nm"><b>' + esc(c.name) + "</b><small>" + esc(c.type || c.slug) + '</small></td><td class="n">' + nf.format(c.conversations) +
            '</td><td class="n">' + nf.format(c.funnel.linkSent) + '</td><td class="n">' + nf.format(c.funnel.opened) + '</td><td class="n">' + nf.format(c.funnel.booked) + '</td><td class="n"><b>' + pct(c.funnel.booked, c.conversations) +
            '</b></td><td class="n">' + nf.format(c.outsideHours) + '</td><td class="n">' + nf.format(c.afterFollowUp) + '</td><td class="n">' + nf.format(c.handedOver) + '</td><td class="n">' + thb(c.value) + "</td></tr>";
        }).join("") || '<tr><td colspan="10" class="empty">Geen centra.</td></tr>') + "</tbody></table></div>";
      h += '<p class="muted" style="font-size:13.5px">Dezelfde cijfers als het dashboard in de zone van elk center (' + esc(d.label.toLowerCase()) + '). "Link" telt duikers die een talay.io/b/-link kregen, "Betaalpagina" telt geopende Stripe-betaalpagina\'s, "Geboekt" telt betaalde boekingen.</p>';
      setPage("Conversie", h);
      $("#cp").onchange = function () { convPer = this.value; pConversion(); };
      $$("tr[data-href]").forEach(function (r) { r.onclick = function () { location.hash = r.getAttribute("data-href"); }; });
    }).catch(fail);
  }

  // ---------- Claude-kosten ----------
  var costMonth = "";
  function usd(v) { return "$ " + (v || 0).toLocaleString("nl-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function tok(v) { return v >= 1e6 ? nf.format(Math.round(v / 1e5) / 10) + " M" : v >= 1e3 ? nf.format(Math.round(v / 100) / 10) + " k" : nf.format(v); }
  function pCosts(fresh) {
    setPage("Claude-kosten", '<div class="skel"></div>');
    load("cost:" + (costMonth || "now"), "costs" + (costMonth ? "?month=" + costMonth : ""), fresh).then(function (d) {
      if (route().k !== "kosten") return;
      costMonth = d.month;
      var rows = d.centers.filter(function (c) { return state.withTest || !c.test; });
      var t = rows.reduce(function (a, c) { ["calls", "tracked", "input", "read", "write", "output", "usd", "conversations", "bookings", "commission"].forEach(function (k) { a[k] += c[k] || 0; }); return a; },
        { calls: 0, tracked: 0, input: 0, read: 0, write: 0, output: 0, usd: 0, conversations: 0, bookings: 0, commission: 0 });
      var cacheHit = t.input + t.read + t.write ? Math.round(t.read / (t.input + t.read + t.write) * 100) : null;
      var h = '<div class="bar"><select class="in" id="km">' + d.months.map(function (m) { return '<option value="' + m.value + '"' + (m.value === d.month ? " selected" : "") + ">" + esc(monthName(m.value)) + "</option>"; }).join("") + "</select></div>";
      if (!t.tracked) h += '<div class="alert warn"><div class="x"><b>Nog geen verbruik gemeten</b>' + (t.calls ? nf.format(t.calls) + " berichten staan in Log, maar zonder tokens. " : "") +
        "Make schrijft het verbruik van Claude nog niet in de tabel Log. Zodra Center, Input tokens, Cache read tokens, Cache write tokens en Output tokens in Airtable 51 van inbound v2 staan, verschijnen hier de kosten per center.</div></div>";
      else if (t.tracked < t.calls) h += '<div class="alert warn"><div class="x"><b>Deels gemeten</b>' + nf.format(t.calls - t.tracked) + " van de " + nf.format(t.calls) + " berichten hebben nog geen tokens (van voor de meting). Die tellen niet mee in de kosten.</div></div>";
      var spent = d.budget ? t.usd / d.budget : 0;
      h += '<div class="kpis">' + kpi("Kosten", usd(t.usd), '<span class="d">≈ ' + thb(t.usd * d.thbPerUsd) + "</span>") +
        kpi("Berichten", nf.format(t.tracked || t.calls), '<span class="d">' + (t.tracked ? "met gemeten verbruik" : "in Log") + "</span>") +
        kpi("Per bericht", t.tracked ? usd(t.usd / t.tracked) : "–") +
        kpi("Per gesprek", t.conversations && t.tracked ? usd(t.usd / t.conversations) : "–") +
        kpi("Per boeking", t.bookings && t.tracked ? usd(t.usd / t.bookings) : "–", t.commission && t.tracked ? '<span class="d">' + nf.format(Math.round(t.usd * d.thbPerUsd / t.commission * 1000) / 10) + " % van de commissie</span>" : "") +
        kpi("Uit de cache", cacheHit == null ? "–" : cacheHit + " %", '<span class="d">van de invoertokens</span>') + "</div>";
      h += '<div class="grid2 sec"><div class="card"><h2>Kosten per dag</h2><div class="chart">' + chart("usd", d.daily.slice(0, Math.max(1, d.days)), usd, d.day0, d.current ? "vandaag" : "einde maand") + "</div></div>" +
        '<div class="card"><h2>Verbruik</h2><div class="pad"><dl class="dl">' +
        "<dt>Invoer (volle prijs)</dt><dd>" + tok(t.input) + " tokens · " + usd(t.input * d.price.input / 1e6) + "</dd>" +
        "<dt>Cache gelezen</dt><dd>" + tok(t.read) + " tokens · " + usd(t.read * d.price.read / 1e6) + "</dd>" +
        "<dt>Cache geschreven</dt><dd>" + tok(t.write) + " tokens · " + usd(t.write * d.price.write / 1e6) + "</dd>" +
        "<dt>Uitvoer</dt><dd>" + tok(t.output) + " tokens · " + usd(t.output * d.price.output / 1e6) + "</dd></dl>" +
        (d.budget ? '<div style="margin-top:14px"><b>Budget deze maand</b> <span class="muted">' + usd(t.usd) + " van " + usd(d.budget) + " (" + Math.round(spent * 100) + ' %)</span><div class="meter"><span class="' + (spent >= 1 ? "bad" : spent >= .8 ? "warn" : "") + '" style="width:' + Math.min(100, Math.round(spent * 100)) + '%"></span></div></div>' :
          '<p class="muted" style="font-size:13px;margin:14px 0 0">Zet CLAUDE_BUDGET_USD in Cloudflare om hier een budget te zien en een melding te krijgen boven 80%.</p>') + "</div></div></div>";
      h += '<div class="sec card tw"><table class="t"><thead><tr><th>Center</th><th class="n">Berichten</th><th class="n">Invoer</th><th class="n">Cache gelezen</th><th class="n">Cache geschreven</th><th class="n">Uitvoer</th><th class="n">Kosten</th><th class="n">Per gesprek</th><th class="n">Per boeking</th><th class="n">Commissie</th></tr></thead><tbody>' +
        (rows.map(function (c) {
          return '<tr><td class="nm"><b>' + esc(c.name) + "</b><small>" + esc(c.type || c.slug || "niet te koppelen aan een center") + '</small></td><td class="n">' + nf.format(c.tracked) + (c.calls > c.tracked ? ' <small class="muted">/ ' + nf.format(c.calls) + "</small>" : "") +
            '</td><td class="n">' + tok(c.input) + '</td><td class="n">' + tok(c.read) + '</td><td class="n">' + tok(c.write) + '</td><td class="n">' + tok(c.output) + '</td><td class="n"><b>' + usd(c.usd) +
            '</b></td><td class="n">' + (c.conversations && c.tracked ? usd(c.usd / c.conversations) : "–") + '</td><td class="n">' + (c.bookings && c.tracked ? usd(c.usd / c.bookings) : "–") + '</td><td class="n">' + thb(c.commission) + "</td></tr>";
        }).join("") || '<tr><td colspan="10" class="empty">Geen centra.</td></tr>') + "</tbody></table></div>";
      h += '<p class="muted" style="font-size:13.5px">Berekend met de prijzen van claude-sonnet-5-5 per miljoen tokens: invoer $' + d.price.input + ", cache schrijven $" + d.price.write + ", cache lezen $" + d.price.read + ", uitvoer $" + d.price.output +
        ". Alleen de antwoorden van de assistent (inbound v2); de regressietest staat niet in Log. Baht ≈ " + d.thbPerUsd + " per dollar. Het echte tegoed staat in de Anthropic Console.</p>";
      setPage("Claude-kosten", h);
      $("#km").onchange = function () { costMonth = this.value; pCosts(); };
    }).catch(fail);
  }

  // ---------- Aanmeldingen ----------
  function pIntake(fresh) {
    setPage("Aanmeldingen", '<div class="skel"></div>');
    load("intake", "intake", fresh).then(function (d) {
      if (route().k !== "aanmeldingen") return;
      if (d.missing) { setPage("Aanmeldingen", '<div class="alert warn"><div class="x"><b>Nog niet ingesteld</b>De aanmeldingen van talay.io/start komen in de Airtable-tabel Intake. Die tabel bestaat nog niet (zie het onboarding-stappenplan, PR #2).</div></div>'); return; }
      var STATUS = ["New", "In progress", "Live", "Declined"], NL = { New: "Nieuw", "In progress": "Bezig", Live: "Live", Declined: "Afgewezen" };
      var h = '<div class="card rows">' + (d.items.map(function (x) {
        var wa = String(x.whatsapp || "").replace(/[^\d]/g, "");
        return '<div class="row"><div class="x"><div class="l1"><b>' + esc(x.centre || "Onbekend center") + '</b><span class="muted">' + esc(x.name) + "</span></div>" +
          '<div class="pv">' + (x.email ? '<a href="mailto:' + esc(x.email) + '">' + esc(x.email) + "</a>" : "") + (wa ? ' · <a target="_blank" rel="noopener" href="https://wa.me/' + wa + '">WhatsApp</a>' : "") + " · " + esc(date(x.received, true)) + "</div>" +
          (x.summary ? '<button class="btn" style="margin-top:8px" data-sum>Samenvatting</button><div class="sum">' + esc(x.summary) + "</div>" : "") + "</div>" +
          '<select class="in" data-id="' + esc(x.id) + '">' + STATUS.map(function (s) { return '<option value="' + s + '"' + (s === x.status ? " selected" : "") + ">" + NL[s] + "</option>"; }).join("") + "</select></div>";
      }).join("") || '<div class="empty">Nog geen aanmeldingen.</div>') + "</div>";
      setPage("Aanmeldingen", h);
      $$("[data-sum]").forEach(function (b) { b.onclick = function () { b.nextElementSibling.classList.toggle("open"); }; });
      $$("select[data-id]").forEach(function (s) {
        s.onchange = function () { s.disabled = true; post("intake", { id: s.getAttribute("data-id"), status: s.value }).then(function () { s.disabled = false; delete state.cache.intake; }).catch(function (e) { s.disabled = false; alert(e.message); }); };
      });
    }).catch(fail);
  }

  // ---------- Systeem ----------
  function pSystem(fresh) {
    if (!state.ov) setPage("Systeem", '<div class="skel"></div>');
    overview(fresh).then(function (ov) {
      if (route().k !== "systeem") return;
      var s = ov.system;
      var item = function (ok, name, text) { return '<div class="row"><span class="pill ' + (ok === true ? "ok" : ok === false ? "bad" : "warn") + '">' + (ok === true ? "OK" : ok === false ? "Uit" : "Let op") + '</span><div class="x"><b>' + name + '</b><div class="pv">' + text + "</div></div></div>"; };
      var h = healthBox(ov, true);
      h += '<div class="grid2"><div class="card"><h2>Koppelingen</h2><div class="rows">' +
        item(true, "Airtable", "Bereikbaar. Base " + esc(s.base)) +
        item(ov.healthOk ? true : false, "Tabel Chat", ov.healthOk ? "Leesbaar, basis van de inbox en de systeemcheck." : "Niet leesbaar.") +
        item(s.stripe === "live" ? true : s.stripe === "test" ? "warn" : false, "Stripe", s.stripe === "live" ? "Live sleutel staat klaar: centers met het vinkje Stripe live betalen echt, de rest blijft test." : s.stripe === "test" ? "Testmodus: er wordt niets echt betaald." : "Geen sleutel ingesteld.") +
        item(s.respondio, "respond.io", s.respondio ? "Token ingesteld: antwoorden vanuit de zone werken." : "RESPONDIO_TOKEN ontbreekt.") +
        item(s.push ? true : "warn", "Pushmeldingen", s.push ? "Ingesteld." : "VAPID-sleutel ontbreekt: geen meldingen op telefoons.") +
        item(s.alerts ? true : "warn", "Meldingen per e-mail", s.alerts ? "Elke 15 minuten: overdracht zonder reactie, sorry-bericht, duiker zonder antwoord" + (s.budget ? ", Claude-kosten boven 80% van $" + s.budget : "") + "." + (s.alertsTest ? " Demo en test tellen mee." : "") : "ALERT_WEBHOOK ontbreekt: geen e-mails bij problemen.") +
        (s.alerts ? '<div class="row"><div class="x"><button class="btn" id="atest" type="button">Stuur een testmelding</button> <span class="muted" style="font-size:13px">met alles van de laatste 24 uur, demo en test inbegrepen</span></div></div>' : "") +
        item(s.accessAud ? true : "warn", "Cloudflare Access", s.accessAud ? "Beperkt tot de app van de zone (AUD)." : "ACCESS_AUD niet ingesteld: elke Access-app van Talay telt.") +
        '</div></div><div class="card"><h2>Snel naar</h2><div class="rows">' +
        [["Airtable", "https://airtable.com/" + s.base], ["Make", "https://www.make.com/en/login"], ["respond.io", "https://app.respond.io/"], ["Stripe", "https://dashboard.stripe.com/" + (s.stripe === "test" ? "test/" : "") + "payments"], ["Cloudflare", "https://dash.cloudflare.com/"], ["Anthropic Console (API-tegoed)", "https://console.anthropic.com/settings/billing"]].map(function (l) {
          return '<a class="row" target="_blank" rel="noopener" href="' + esc(l[1]) + '"><div class="x"><b>' + esc(l[0]) + '</b></div><span class="tm">' + icon("zone") + "</span></a>";
        }).join("") + "</div></div></div>";
      h += '<div class="sec"><h2>Gezondheid per center (24 u)</h2><div class="card tw"><table class="t"><thead><tr><th>Center</th><th>Assistent</th><th>Laatste klantbericht</th><th>Laatste antwoord</th><th class="n">Antwoorden</th><th class="n">Sorry</th><th class="n">Wacht</th><th class="n">Open overdrachten</th></tr></thead><tbody>' +
        ov.centers.map(function (c) {
          var hl = c.health || {};
          return '<tr class="link" data-href="#/centra/' + esc(c.slug) + '"><td class="nm"><b>' + esc(c.name) + "</b><small>" + esc(c.type || c.slug) + "</small></td><td>" + miaPill(c) + "</td><td>" + esc(ago(hl.lastCustomer)) + "</td><td>" + esc(ago(hl.lastMia)) + '</td><td class="n">' + nf.format(hl.replies || 0) +
            '</td><td class="n">' + (hl.errors ? '<span class="pill bad">' + hl.errors + "</span>" : "0") + '</td><td class="n">' + (hl.waiting ? '<span class="pill warn">' + hl.waiting + "</span>" : "0") + '</td><td class="n">' + c.openHandovers + "</td></tr>";
        }).join("") + "</tbody></table></div></div>";
      h += '<div class="sec"><h2>Wijzigingen in de zones</h2><div class="card rows">' + (ov.activity.map(actRow).join("") || '<div class="empty">Nog geen wijzigingen.</div>') + "</div></div>";
      setPage("Systeem", h);
      var at = $("#atest");
      if (at) at.onclick = function () {
        at.disabled = true;
        post("alert-test", {}).then(function (d) { at.textContent = "Verstuurd (" + d.count + (d.count === 1 ? " melding" : " meldingen") + " in 24 u)"; })
          .catch(function (e) { at.disabled = false; alert(e.message); });
      };
      $$("tr[data-href]").forEach(function (r) { r.onclick = function () { location.hash = r.getAttribute("data-href"); }; });
    }).catch(fail);
  }

  // ---------- Team ----------
  function pTeam(fresh) {
    if (cfg.role !== "owner") { setPage("Team", '<div class="empty">Alleen voor eigenaars.</div>'); return; }
    setPage("Team", '<div class="skel"></div>');
    load("team", "team", fresh).then(function (d) {
      if (route().k !== "team") return;
      var h = "";
      if (d.missing) h += '<div class="alert warn"><div class="x"><b>Tabel HQ team ontbreekt</b>Maak in Airtable een tabel <b>HQ team</b> met de velden Email, Name en Role (Owner of Staff). Tot dan heeft alleen de vaste eigenaar toegang.</div></div>';
      h += '<div class="card"><h2>Toegang tot Talay HQ</h2><div class="tw"><table class="t"><thead><tr><th>E-mail</th><th>Naam</th><th>Rol</th><th></th></tr></thead><tbody>' +
        d.owners.map(function (e) { return "<tr><td>" + esc(e) + '</td><td class="muted">vast (Cloudflare)</td><td><span class="pill sand">Eigenaar</span></td><td></td></tr>'; }).join("") +
        d.members.map(function (m) {
          return "<tr><td>" + esc(m.email) + "</td><td>" + esc(m.name) + '</td><td><select class="in" data-role="' + esc(m.id) + '"><option value="Staff"' + (m.role === "Staff" ? " selected" : "") + '>Medewerker</option><option value="Owner"' + (m.role === "Owner" ? " selected" : "") + '>Eigenaar</option></select></td><td class="n"><button class="btn danger" data-rm="' + esc(m.id) + '" data-email="' + esc(m.email) + '">Verwijderen</button></td></tr>';
        }).join("") + "</tbody></table></div></div>";
      if (!d.missing) h += '<div class="sec card"><h2>Iemand toevoegen</h2><div class="pad"><form class="form" id="tf"><input class="in" id="te" type="email" placeholder="naam@talay.io" required><input class="in" id="tn" placeholder="Naam"><select class="in" id="tr"><option value="Staff">Medewerker</option><option value="Owner">Eigenaar</option></select><button class="btn primary">Toevoegen</button></form>' +
        '<p class="muted" style="font-size:13.5px;margin:10px 0 0">Medewerkers zien alles in HQ en in elke zone en kunnen de assistent pauzeren. Eigenaars beheren ook dit team. Zet het adres ook in de Access-regel van de zone in Cloudflare, anders kan die persoon niet inloggen.</p></div></div>';
      setPage("Team", h);
      var done = function () { delete state.cache.team; pTeam(true); };
      var f = $("#tf"); if (f) f.onsubmit = function (e) {
        e.preventDefault(); var b = f.querySelector("button"); b.disabled = true;
        post("team", { action: "add", email: $("#te").value, name: $("#tn").value, role: $("#tr").value }).then(done).catch(function (x) { b.disabled = false; alert(x.message); });
      };
      $$("[data-role]").forEach(function (s) { s.onchange = function () { post("team", { action: "role", id: s.getAttribute("data-role"), role: s.value }).then(done).catch(function (x) { alert(x.message); }); }; });
      $$("[data-rm]").forEach(function (b) { b.onclick = function () { if (!confirm(b.getAttribute("data-email") + " verwijderen uit Talay HQ?")) return; b.disabled = true; post("team", { action: "remove", id: b.getAttribute("data-rm") }).then(done).catch(function (x) { b.disabled = false; alert(x.message); }); }; });
    }).catch(fail);
  }

  // ---------- router ----------
  function route() {
    var h = (location.hash || "#/overzicht").slice(2).split("?")[0].split("/");
    return { k: h[0] || "overzicht", id: h[1] ? decodeURIComponent(h[1]) : "" };
  }
  var PAGES = { overzicht: pOverview, inbox: pInbox, zoeken: pSearch, pijplijn: pPipeline, mail: pOutreach, centra: pCenters, conversie: pConversion, boekingen: pBookings, commissie: pCommission, kosten: pCosts, aanmeldingen: pIntake, systeem: pSystem, team: pTeam };
  function render(fresh) {
    var r = route();
    $$("#nav a").forEach(function (a) { a.classList.toggle("on", a.getAttribute("data-k") === r.k); });
    $("#tip").style.display = "none";
    if (r.k === "centra" && r.id) return pCenter(r.id, fresh);
    (PAGES[r.k] || pOverview)(fresh);
    if (fresh || !state.cache.inbox) load("inbox", "inbox", fresh).then(function (d) { inboxBadge(d.items); }).catch(function () {});
    if (r.k !== "pijplijn" && (fresh || !state.cache.pipe)) load("pipe", "pipeline", fresh).then(pipeBadge).catch(function () {});
    banner();
    stamp();
  }
  // Demo and test centers: say so whenever they are counted, and explain the zeros when no
  // real center exists yet (pilot phase).
  var NUM_PAGES = { overzicht: 1, inbox: 1, centra: 1, conversie: 1, boekingen: 1, commissie: 1, kosten: 1 };
  function banner() {
    var tb = $("#tb"), ov = state.ov, k = route().k;
    if (!tb) return;
    if (!ov || !NUM_PAGES[k]) { tb.innerHTML = ""; return; }
    var tests = ov.centers.filter(function (c) { return c.test; }), real = ov.centers.length - tests.length;
    if (state.withTest && tests.length) {
      tb.innerHTML = '<div class="alert warn"><div class="x"><b>Demo- en testcijfers tellen mee</b>' + tests.map(function (c) { return esc(c.name) + " (" + esc(c.type) + ")"; }).join(", ") +
        " staan in de cijfers. Dat zijn geen echte duikers.</div><button class=\"btn\" id=\"tbo\" type=\"button\">Alleen echte centra</button></div>";
      $("#tbo").onclick = function () { setTest(false); };
    } else if (!state.withTest && !real && tests.length) {
      tb.innerHTML = '<div class="alert ok"><div class="x"><b>Nog geen pilot- of live-center</b>De cijfers blijven 0 tot het eerste echte center live gaat. Demo en test (' + tests.map(function (c) { return esc(c.name); }).join(", ") +
        ") tellen niet mee.</div><button class=\"btn\" id=\"tbo\" type=\"button\">Toon demo/test</button></div>";
      $("#tbo").onclick = function () { setTest(true); };
    } else tb.innerHTML = "";
  }
  function stamp() { $("#upd").textContent = state.ov ? "Bijgewerkt " + new Date(state.ov.updated).toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" }) : ""; }
  function setTest(v) { state.withTest = v; store.set("test", v ? "1" : ""); $("#withTest").checked = v; $("#withTest2").checked = v; render(); }

  window.addEventListener("hashchange", function () { window.scrollTo(0, 0); render(); });
  $("#withTest").checked = state.withTest;
  $("#withTest").onchange = function () { setTest(this.checked); };
  $("#withTest2").checked = state.withTest;
  $("#withTest2").onchange = function () { setTest(this.checked); };
  $("#refresh").onclick = function () { var b = this; b.disabled = true; state.cache = {}; render(true); setTimeout(function () { b.disabled = false; stamp(); }, 1500); };
  $("#gs").onsubmit = function (e) { e.preventDefault(); var v = $("#gq").value.trim(); if (v) location.hash = "#/zoeken?q=" + encodeURIComponent(v); };
  render();
  // Light polling (Airtable limits): overview and inbox every 2 minutes while visible.
  setInterval(function () {
    if (document.hidden) return;
    var k = route().k;
    if (k === "overzicht" || k === "inbox" || k === "systeem") { delete state.cache[k === "inbox" ? "inbox" : "ov"]; render(); }
  }, 120000);
}

function text(t, status = 200) {
  return new Response(t, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
function html(body, status = 200) {
  return new Response(body, { status, headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin",
  } });
}

const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700;800&display=swap" rel="stylesheet">`;

function noAccess(email) {
  return `<!doctype html><html lang="en"><head>${HEAD}<title>Talay</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#F4F0E6;color:#0A2029;font-family:"Schibsted Grotesk",system-ui,sans-serif;padding:24px}
main{max-width:440px;text-align:center}a{color:#0A2029;font-weight:700}</style></head>
<body><main><h1>No access yet</h1><p>${esc(email)} is not linked to a dive center.</p>
<p>Ask Jonas to add you: <a href="mailto:jonas@talay.io">jonas@talay.io</a></p>
<p><a href="/cdn-cgi/access/logout">Sign out</a></p></main></body></html>`;
}

function app(center, centers, email, superadmin = false, lang = "en") {
  const T = zoneT(lang), A = esc(center.assistant);
  const langOpts = ZONE_LANGS.map(([code, name]) => `<button type="button" class="chip zl${code === lang ? " on" : ""}" data-l="${code}">${name}</button>`).join("");
  const switcher = centers.length > 1
    ? `<button class="csw" id="center" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Dive center"><span>${esc(center.name)}</span><svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="lmenu" id="cmenu" role="menu" hidden>${centers.map((c) =>
      `<button type="button" role="menuitemradio" aria-checked="${c.slug === center.slug}" data-c="${esc(c.slug)}"${c.slug === center.slug ? ' class="on"' : ""}>${esc(c.name)}<svg class="ck" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7"/></svg></button>`).join("")}</div>` : "";
  const logo = center.logo
    ? `<img src="${esc(center.logo)}" alt="" class="logo">`
    : `<svg width="32" height="32" viewBox="0 0 100 100" aria-hidden="true" class="logo-svg"><path d="M 12 50 A 38 38 0 0 0 88 50 Z" fill="#DCA44A"/><circle cx="50" cy="50" r="38" fill="none" stroke="#F7F3EA" stroke-width="10"/><line x1="6" y1="50" x2="94" y2="50" stroke="#F7F3EA" stroke-width="10" stroke-linecap="round"/></svg>`;
  const cfg = {
    qs: centers.length > 1 ? `?center=${encodeURIComponent(center.slug)}` : "",
    assistant: center.assistant, center: center.name, email,
    lang, locale: ZONE_LOCALE[lang] || "", tr: ZONE_TEXT[lang] || {},
  };

  return `<!doctype html><html lang="${lang}"><head>${HEAD}
<title>${esc(center.name)} · Talay</title>
<link rel="manifest" href="/zone/manifest.webmanifest?n=${encodeURIComponent(center.name)}" crossorigin="use-credentials">
<link rel="apple-touch-icon" href="/zone/apple-touch-icon.png">
<link rel="icon" type="image/png" href="/zone/icon-192.png">
<meta name="theme-color" content="#0A2029">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="${esc(center.name.split(" ")[0])}">
<style>
:root{--deep:#0A2029;--paper:#F4F0E6;--paper-2:#FBF8F1;--card:#fff;--muted:#55646A;--line:#E2DACB;--in:#fff;--mia:#E6F0F2;--team:#D9FDD3;--ok:#1F7A55;--warn:#B4561B;--sand:#E8B04B;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--deep:#F4F0E6;--paper:#0B1A20;--paper-2:#10252D;--card:#122A33;--muted:#9FB2B8;--line:#1F3D48;--in:#173540;--mia:#1B3B45;--team:#1E4A35;--ok:#3FB37F;--warn:#E69A5B;color-scheme:dark}}
*{box-sizing:border-box}
html{height:100%;background:var(--paper)}
html,body{overflow:hidden}
body{position:fixed;inset:0;margin:0;display:flex;flex-direction:column;background:var(--paper);color:var(--deep);font-family:"Schibsted Grotesk",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:16px;line-height:1.45;-webkit-font-smoothing:antialiased}
header{display:flex;align-items:center;gap:12px;padding:calc(10px + env(safe-area-inset-top,0px)) 18px 10px;background:#0A2029;color:#F4F0E6;flex:none}
header .logo{width:30px;height:30px;border-radius:50%;object-fit:cover;background:#F4F0E6}
header b{font-size:17px}
header .sp{flex:1}
header select{font:inherit;font-size:14px;border-radius:8px;padding:5px 8px;border:0}
header a,header button.lnk{color:#C9D4D7;font:inherit;font-size:14px;text-decoration:none;background:none;border:0;cursor:pointer;padding:0}
nav{display:flex;gap:4px;padding:8px 18px 0;border-bottom:1px solid var(--line);flex:none;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}
nav::-webkit-scrollbar{display:none}
nav i{display:none;font-style:normal}
nav .short{display:none}
nav button{flex:none;white-space:nowrap;display:inline-flex;align-items:center;font:inherit;font-weight:700;font-size:15px;background:none;border:0;color:var(--muted);padding:10px 14px;border-bottom:3px solid transparent;cursor:pointer}
nav button.on{color:var(--deep);border-bottom-color:var(--sand)}
nav .count[hidden],.chip .count[hidden],#tcount[hidden]{display:none}
.chip .count{display:inline-block;min-width:18px;padding:0 5px;margin-left:6px;border-radius:999px;background:var(--sand);color:#0A2029;font-size:11px;line-height:18px;text-align:center}
nav .count{display:inline-block;min-width:20px;padding:0 6px;margin-left:6px;border-radius:999px;background:var(--sand);color:#0A2029;font-size:12px;line-height:20px;text-align:center}
.view{display:none;flex:1;min-height:0}
.view.on{display:flex}
.list{width:360px;flex:none;border-right:1px solid var(--line);display:flex;flex-direction:column;background:var(--paper-2);min-height:0}
.tools{padding:12px 14px 8px;border-bottom:1px solid var(--line);display:grid;gap:8px}
.tools input{font:inherit;font-size:15px;width:100%;border:1px solid var(--line);border-radius:10px;padding:8px 12px;background:var(--card);color:var(--deep)}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{font:inherit;font-size:13px;font-weight:700;border:1px solid var(--line);background:var(--card);color:var(--deep);border-radius:999px;padding:4px 11px;cursor:pointer}
.chip.on{background:#0A2029;color:#F4F0E6;border-color:#0A2029}
@media (prefers-color-scheme:dark){.chip.on{background:var(--sand);color:#0A2029;border-color:var(--sand)}}
.items{overflow-y:auto;flex:1;padding-bottom:env(safe-area-inset-bottom,0px)}
.items .empty{padding:24px 18px;color:var(--muted)}
.item{display:block;width:100%;text-align:left;font:inherit;color:inherit;background:none;border:0;border-bottom:1px solid var(--line);padding:13px 16px;cursor:pointer}
.item{border-left:3px solid transparent}
.item:hover{background:var(--card)}
.item.on{background:var(--card);border-left-color:var(--sand)}
.item .top{display:flex;align-items:center;gap:6px}
.item .nm{font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .tm{font-size:12px;color:var(--muted)}
.item .pv{font-size:14px;color:var(--muted);margin-top:3px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.tag{font-size:11px;font-weight:800;border-radius:999px;padding:2px 8px;white-space:nowrap}
.tag.need{background:var(--sand);color:#0A2029}
.tag.wait{background:#B3261E;color:#fff}
.tag.asg{background:#E4EEF6;color:#2E5F86}
.teamrow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 22px 12px;background:var(--card);border-bottom:1px solid var(--line);font-size:13px}
.teamrow .asg{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:0;border-radius:999px;background:#E4EEF6;color:#2E5F86;font:inherit;font-weight:700;cursor:pointer;max-width:220px}
.teamrow .asg:hover{background:#D6E5F1}
.teamrow .asg #asgName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.teamrow .asg .chev{opacity:.7;transition:transform .15s}
.teamrow .asg[aria-expanded="true"] .chev{transform:rotate(180deg)}
.amenu{position:fixed;z-index:60;min-width:230px;max-width:300px;max-height:60vh;overflow:auto;padding:6px;border-radius:14px;background:var(--card);border:1px solid var(--line);box-shadow:0 18px 40px -12px rgba(10,32,41,.35),0 2px 6px rgba(10,32,41,.08);font-size:14px}
.amenu[hidden]{display:none}
.amenu button{display:flex;align-items:center;gap:10px;width:100%;padding:7px 10px;border:0;border-radius:9px;background:none;color:var(--deep);font:inherit;text-align:left;cursor:pointer}
.amenu button:hover,.amenu button:focus-visible{background:var(--paper);outline:none}
.amenu .av{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#E4EEF6;color:#2E5F86;font-weight:700;font-size:13px}
.amenu .av.none{background:var(--paper);color:var(--muted)}
.amenu .who{display:grid;min-width:0}
.amenu .who b{font-weight:600}
.amenu .who small{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.amenu .ck{margin-left:auto;flex:none;color:#2E5F86;visibility:hidden}
.amenu button.on{background:#F1F6FA}
.amenu button.on .ck{visibility:visible}
.teamrow .nbtn{display:inline-flex;align-items:center;gap:6px;max-width:100%;border:1px dashed var(--line);background:none;border-radius:999px;padding:5px 12px;font:inherit;color:var(--muted);cursor:pointer;text-align:left}
.teamrow .nbtn.has{border-style:solid;background:#FFF6DD;border-color:#F0DDA6;color:#5A4410;font-weight:600}
.teamrow .nbtn[hidden]{display:none}
.teamrow .nbox{flex-basis:100%;display:grid;gap:6px}
.teamrow .nbox[hidden]{display:none}
.teamrow .nbox textarea{font:inherit;font-size:14px;border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:#FFFBEF;resize:vertical}
.teamrow .nact{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.teamrow .nmsg{margin-right:auto;color:#B3261E;font-size:12.5px}
.teamrow .btn{font:inherit;font-weight:700;border:0;border-radius:10px;padding:7px 14px;background:var(--sand);color:#0A2029;cursor:pointer}
@media (max-width:760px){.teamrow{padding:8px 12px 10px}}
.tag.team{background:#FBEADF;color:#8A3F12;display:inline-flex;align-items:center;gap:4px}
.tag.lang{background:var(--line);color:var(--deep);text-transform:uppercase}
.tag.st{border:1px solid var(--line);color:var(--muted)}
.left{font-size:12px;color:var(--muted);margin-top:4px}
.left.soon{color:var(--warn);font-weight:700}
.pane{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.pane .head{padding:12px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pane .head b{font-size:18px}
.pane .head .sub{font-size:13px;color:var(--muted)}
.facts{display:flex;flex-wrap:wrap;gap:6px 14px;padding:10px 20px;border-bottom:1px solid var(--line);font-size:13px;color:var(--muted);background:var(--paper-2)}
.facts span b{color:var(--deep);font-weight:700}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
.ghost{font:inherit;font-size:13px;font-weight:700;border:1px solid var(--line);background:var(--card);color:var(--deep);border-radius:999px;padding:6px 12px;cursor:pointer}
.ghost:hover{border-color:var(--deep)}
.back{display:none;font:inherit;background:none;border:0;font-size:22px;color:var(--deep);cursor:pointer;padding:0 6px 0 0}
.msgs{flex:1;overflow-y:auto;padding:20px max(20px,calc((100% - 880px)/2));display:flex;flex-direction:column;gap:10px}
.m{max-width:72%;min-width:120px;padding:9px 13px 6px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.45;box-shadow:0 1px 1px rgba(10,32,41,.06)}
.m.Customer{background:var(--in);align-self:flex-start;border-top-left-radius:3px;border:1px solid var(--line)}
.m.Mia{background:var(--mia);align-self:flex-end;border-top-right-radius:3px}
.m.Team{background:var(--team);align-self:flex-end;border-top-right-radius:3px}
.m small{display:block;text-align:right;margin-top:3px;font-size:11px;color:var(--muted);white-space:nowrap}
.day{align-self:center;font-size:12px;font-weight:700;color:var(--muted);background:var(--paper-2);border:1px solid var(--line);border-radius:999px;padding:2px 10px;margin:6px 0}
.m .who{display:block;font-size:11px;font-weight:800;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em;white-space:normal}
.compose{border-top:1px solid var(--line);padding:10px 16px calc(12px + env(safe-area-inset-bottom,0px));display:flex;gap:10px;align-items:flex-end;background:var(--paper-2)}
.compose textarea{flex:1;font:inherit;font-size:15px;min-height:46px;max-height:200px;resize:vertical;border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--card);color:var(--deep)}
.btn{font:inherit;font-weight:700;border:0;border-radius:999px;padding:11px 20px;cursor:pointer;background:var(--sand);color:#0A2029}
.btn[disabled],.ghost[disabled]{opacity:.5;cursor:default}
.bar2{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:13px;color:var(--muted);padding:8px 16px 0;background:var(--paper-2);border-top:1px solid var(--line)}
.bar2 input{font:inherit;font-size:13px;border:1px solid var(--line);border-radius:8px;padding:4px 8px;width:130px;background:var(--card);color:var(--deep)}
.bar2 select{font:inherit;font-size:13px;border:1px solid var(--line);border-radius:8px;padding:4px 8px;background:var(--card);color:var(--deep);max-width:240px}
.bar2 .sp{flex:1}
.note{padding:8px 16px 10px;font-size:13px;color:var(--muted);background:var(--paper-2)}
.note.err{color:var(--warn);font-weight:700}
.closed{padding:12px 16px;font-size:14px;color:var(--muted);border-top:1px solid var(--line);background:var(--paper-2)}
.paused{display:flex;align-items:center;gap:12px;padding:12px 18px;background:#FBEADF;border-top:1px solid #F0CDB4;color:#5A2A0C}
.paused .pi{flex:none;width:32px;height:32px;border-radius:50%;background:#F3C9A9;display:grid;place-items:center;font-size:14px}
.paused .pt{flex:1;display:grid;gap:2px;font-size:13px;line-height:1.4}
.paused .pt b{font-size:14px;color:#3E1C07}
.paused .btn{flex:none;font:inherit;font-size:14px;font-weight:700;border:0;border-radius:999px;padding:10px 16px;background:var(--sand);color:#0A2029;cursor:pointer;white-space:nowrap}
.paused .btn:hover{filter:brightness(1.05)}
.paused .btn[disabled]{opacity:.6;cursor:progress}
.ghost.hb{background:var(--sand);border-color:var(--sand);color:#0A2029}
@media (max-width:760px){.paused{flex-wrap:wrap;padding:10px 12px}.paused .btn{width:100%}}
.placeholder{margin:auto;color:var(--muted);text-align:center;padding:24px;max-width:380px}
#dash{flex-direction:column}
#dash iframe{flex:1;border:0;width:100%;background:#fff}
#dash .bar{padding:10px 18px;font-size:14px;color:var(--muted)}
#dash .bar a{color:var(--deep);font-weight:700}

#books{flex-direction:column;overflow-y:auto}
.bwrap{width:100%;max-width:1000px;margin:0 auto;padding:16px 20px calc(40px + env(safe-area-inset-bottom,0px))}
.btools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px}
.btools .sp{flex:1}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.cardn{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px}
.cardn small{display:block;color:var(--muted);font-size:13px}
.cardn b{font-size:24px}
.dayh{font-size:15px;font-weight:800;margin:18px 0 8px;display:flex;gap:10px;align-items:baseline}
.dayh span{font-weight:500;color:var(--muted);font-size:13px}
.prodh{font-size:13px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:12px 0 6px}
.btable{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:14px}
.btable th{text-align:left;font-size:12px;color:var(--muted);font-weight:700;padding:8px 10px;border-bottom:1px solid var(--line);background:var(--paper-2)}
.btable td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.btable tr:last-child td{border-bottom:0}
.btable .num{text-align:right;white-space:nowrap}
.btable tr.cx td{color:var(--muted);text-decoration:line-through}
.btable tr.cx td.keep{text-decoration:none}
.btable a{color:var(--deep);font-weight:700}
.bscroll{overflow-x:auto}
.st{font-size:11px;font-weight:800;border-radius:999px;padding:2px 8px;white-space:nowrap;border:1px solid var(--line)}
.st.ok{background:var(--team)}
.st.mv{background:#FCEBC8;color:#0A2029}
.st.cx{background:var(--line)}
.bempty{color:var(--muted);padding:20px 0}
@media print{
  header,nav,.btools .chip,.btools button,#convos,#dash,.noprint{display:none !important}
  body{background:#fff;color:#000}
  #books{display:flex !important;overflow:visible}
  .btable{border-color:#999}
}

#sett{flex-direction:column;overflow-y:auto}
.swrap{grid-template-columns:minmax(0,1fr);width:100%;max-width:760px;margin:0 auto;padding:18px 20px calc(48px + env(safe-area-inset-bottom,0px));display:grid;gap:14px}
.scard{min-width:0;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
.scard h3{margin:0 0 4px;font-size:17px}
.scard p.d{margin:0 0 14px;color:var(--muted);font-size:14px}
.srow{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.srow input[type=email],.srow input[type=time]{font:inherit;font-size:15px;border:1px solid var(--line);border-radius:10px;padding:8px 12px;background:var(--paper-2);color:var(--deep)}
.srow input[type=email]{flex:1;min-width:220px}
.people{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:6px}
.people li{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:10px;padding:8px 12px;background:var(--paper-2)}
.people li span{flex:1;overflow-wrap:anywhere}
.people li small{color:var(--muted)}
.people li > button{font:inherit;font-size:13px;background:none;border:0;color:var(--warn);font-weight:700;cursor:pointer}
.smsg{font-size:13px;margin-top:10px;color:var(--ok);font-weight:700;min-height:1em}
.smsg.err{color:var(--warn)}
.switch{display:flex;align-items:center;gap:14px}
.switch b{font-size:16px}
.pill{font-size:12px;font-weight:800;border-radius:999px;padding:3px 10px}
.pill.on{background:var(--team)}
.pill.off{background:#FCEBC8;color:#0A2029}
.info{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:14px}
.info dt{color:var(--muted)}
.info dd{margin:0}

.ptable{width:100%;border-collapse:collapse;font-size:14px}
.ptable th{text-align:left;font-size:12px;color:var(--muted);font-weight:700;padding:6px 8px;border-bottom:1px solid var(--line)}
.ptable td{padding:8px;border-bottom:1px solid var(--line);vertical-align:middle}
.ptable input[type=number]{font:inherit;font-size:14px;width:100px;border:1px solid var(--line);border-radius:8px;padding:5px 8px;background:var(--paper-2);color:var(--deep)}
.ptable select{font:inherit;font-size:14px;border:1px solid var(--line);border-radius:8px;padding:5px 6px;background:var(--paper-2);color:var(--deep)}
.ptable .muted{color:var(--muted);font-size:13px}
.ptable tr.off td.nm{color:var(--muted)}
.lock{font-size:13px;color:var(--muted);background:var(--paper-2);border:1px dashed var(--line);border-radius:10px;padding:8px 12px;margin-top:4px}
.ro input,.ro select,.ro button.btn,.ro .people button,.ro .switch button{pointer-events:none;opacity:.55}

#dash{flex-direction:column;overflow-y:auto}
.psel{font:inherit;font-weight:700;font-size:15px;border:1px solid var(--line);border-radius:999px;padding:6px 12px;background:var(--card);color:var(--deep)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:14px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px}
.kpi small{display:block;color:var(--muted);font-size:13px}
.kpi b{font-size:24px;display:block}
.kpi span{font-size:12px;color:var(--muted)}
.kpi.hi{background:#0A2029;color:#F4F0E6;border-color:#0A2029}
.kpi.hi small,.kpi.hi span{color:#C9D4D7}
.grid2{display:grid;grid-template-columns:2fr 1fr;gap:12px;margin-bottom:14px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.panel h4{margin:0 0 10px;font-size:14px}
.legend{display:flex;gap:14px;font-size:12px;color:var(--muted);margin-bottom:6px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.barrow{display:flex;align-items:center;gap:8px;font-size:13px;margin:5px 0}
.barrow .lb{width:70px;color:var(--muted);flex:none}
.barrow .bar{height:10px;border-radius:5px;background:var(--sand);min-width:2px}
.st-head{display:none}
@media (max-width:760px){.grid2{grid-template-columns:1fr}}
@media print{
  body.print-statement #dash{display:flex !important}
  body.print-statement #books,body.print-statement #convos,body.print-statement #sett{display:none !important}
  body.print-statement .kpis,body.print-statement .grid2,body.print-statement .btools{display:none !important}
  body.print-statement .st-head{display:block}
}

#supp{flex-direction:column;overflow-y:auto}
.tlist{display:grid;gap:8px}
.titem{display:flex;gap:12px;align-items:center;width:100%;text-align:left;font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;cursor:pointer}
.titem:hover{border-color:var(--deep)}
.titem .tt{flex:1;min-width:0}
.titem .tt b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.titem .tt small{color:var(--muted)}
.ts{font-size:11px;font-weight:800;border-radius:999px;padding:3px 9px;white-space:nowrap;border:1px solid var(--line)}
.ts.New{background:var(--paper-2)}
.ts.In-progress{background:var(--mia)}
.ts.Waiting-for-you{background:var(--sand);color:#0A2029;border-color:var(--sand)}
.ts.Done{background:var(--team)}
.tform{display:grid;gap:10px}
.tform label{display:grid;gap:4px;font-size:13px;font-weight:700;color:var(--muted)}
.tform input,.tform select,.tform textarea{font:inherit;font-size:15px;font-weight:400;border:1px solid var(--line);border-radius:10px;padding:8px 12px;background:var(--paper-2);color:var(--deep)}
.tform textarea{min-height:110px;resize:vertical}
.tform .two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ctx{white-space:pre-wrap;font-size:13px;background:var(--paper-2);border:1px dashed var(--line);border-radius:10px;padding:10px 12px;color:var(--muted)}
.tmsg{border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--card);white-space:pre-wrap}
.tmsg.talay{background:var(--mia)}
.tmsg small{display:block;color:var(--muted);font-size:12px;margin-bottom:4px;white-space:normal}
.quote{border:2px solid var(--sand);border-radius:12px;padding:12px 14px;background:var(--card)}
.rep{font:inherit;font-size:11px;font-weight:700;background:none;border:0;color:var(--muted);cursor:pointer;padding:0;margin-left:8px;text-decoration:underline}
.m:hover .rep{color:var(--deep)}
@media (max-width:760px){.tform .two{grid-template-columns:1fr}}

#install{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:50;display:flex;align-items:center;gap:10px;background:#0A2029;color:#F4F0E6;border-radius:14px;padding:10px 12px;box-shadow:0 10px 30px rgba(0,0,0,.25);font-size:14px;max-width:560px;margin:0 auto}
#install span{flex:1}
#install .btn{padding:8px 14px}
#install .lnk2{background:none;border:0;color:#C9D4D7;font-size:16px;cursor:pointer}
:focus-visible{outline:3px solid var(--sand);outline-offset:2px}
@media (max-width:760px){
  header{padding-left:14px;padding-right:14px;gap:10px}
  header b{font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
  header .sl{display:none}
  nav{order:9;padding:4px 4px calc(4px + env(safe-area-inset-bottom,0px));gap:0;border-bottom:0;border-top:1px solid var(--line);background:var(--paper-2);overflow:visible}
  nav button{flex:1 1 0;min-width:0;flex-direction:column;gap:1px;font-size:11px;padding:6px 2px 4px;border-bottom:0;position:relative;border-radius:10px}
  nav button.on{border-bottom:0;color:var(--deep);background:var(--card)}
  nav i{display:block;font-size:20px;line-height:1.2}
  nav .nl{overflow:hidden;text-overflow:ellipsis;max-width:100%}
  nav .long{display:none}
  nav .short{display:inline}
  nav .count{position:absolute;top:2px;left:calc(50% + 6px);margin:0;min-width:18px;line-height:18px;font-size:11px;padding:0 5px}
  body.inchat nav{display:none}
  .chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
  .chips::-webkit-scrollbar{display:none}
  .chip{flex:none}
  .items,.bwrap,.swrap{padding-bottom:16px}
  input,select,textarea{font-size:16px !important}
  body.inchat header{display:none}
  .pane .head{padding:calc(8px + env(safe-area-inset-top,0px)) 12px 8px;gap:6px 8px;flex-wrap:nowrap}
  .pane .head b{font-size:16px}
  .pane .head .actions{margin-left:auto;width:auto;flex-wrap:nowrap}
  .pane .head .ghost{font-size:12px;padding:5px 9px;white-space:nowrap}
  .pane .head > div:not(.actions){min-width:0;overflow:hidden}
  .pane .head > div:not(.actions) b{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pane .head > .tag.need{display:none}
  .bar2 .sp{display:none}
  .facts{flex-wrap:nowrap;overflow-x:auto;white-space:nowrap;padding:6px 12px;scrollbar-width:none}
  .facts::-webkit-scrollbar{display:none}
  .msgs{padding:12px}
  .bar2{padding:6px 12px 0;gap:8px}
  .bar2 > span:first-child,.bar2 .bt{display:none}
  .bar2 input{flex:1;min-width:0;width:auto}
  .bar2 select{flex:1;min-width:0}
  .compose{padding-left:12px;padding-right:12px;gap:8px}
  .compose textarea{min-height:44px}
  #note{display:none}
  #note.err{display:block}
  .btools{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;padding-bottom:2px}
  .btools::-webkit-scrollbar{display:none}
  .btools .sp{display:none}
  #print,#stPrint{display:none}
  .cards{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .cardn,.kpi{padding:10px 12px}
  .cardn b,.kpi b{font-size:19px}
  #books .btable thead,#sett .ptable thead{display:none}
  #books .btable,#books .btable tbody,#books .btable tr,#books .btable td{display:block;width:100%}
  #books .btable{border:0;background:none}
  #books .btable tr{display:flex !important;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:8px}
  #books .btable td{border:0;padding:2px 0;display:flex;justify-content:space-between;gap:12px;text-align:right}
  #books .btable td[data-l]::before{content:attr(data-l);color:var(--muted);font-size:13px;text-align:left}
  #books .btable td.tname{font-weight:800;font-size:16px;order:-1}
  #books .btable td.tname::before{content:none}
  #books .btable td.tlinks{justify-content:flex-start;padding-top:6px}
  #books .bscroll{overflow:visible}
  #sett .ptable,#sett .ptable tbody,#sett .ptable tr{display:block}
  #sett .ptable tr{border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin-bottom:8px;display:grid;grid-template-columns:1fr 1fr;gap:6px 12px}
  #sett .ptable td{border:0;padding:0;display:block}
  #sett .ptable td.nm{grid-column:1 / -1;font-weight:700}
  #sett .ptable td[data-l]::before{content:attr(data-l);display:block;font-size:12px;color:var(--muted);margin-bottom:2px}
  #sett .ptable td.tlinks{display:flex;align-items:end;justify-content:flex-end}
  #sett .ptable input[type=number]{width:100%}
  .compose{padding-bottom:calc(10px + env(safe-area-inset-bottom,0px))}
  .tools{padding:10px 12px 8px}
  .bwrap,.swrap{padding-left:12px;padding-right:12px}
  .list{width:100%;border-right:0}
  #convos.open .list{display:none}
  #convos:not(.open) .pane{display:none}
  .back{display:inline}
  .m{max-width:88%}
  .actions{margin-left:0;width:100%}
}

/* ===== Talay theme v2 (house style) ===== */
:root{--deep:#09262F;--paper:#F7F3EA;--paper-2:#FBF8F2;--card:#FFFFFF;--muted:#5B6B70;--line:#E7E0D3;--in:#FFFFFF;--mia:#F1E6CF;--team:#DCEFE4;--ok:#23855A;--warn:#B4561B;--sand:#DCA44A;--side:#09262F;--side-2:#103540;--shadow:0 1px 2px rgba(9,38,47,.05),0 4px 16px -8px rgba(9,38,47,.12)}
@media (prefers-color-scheme:dark){:root{--deep:#F2EEE4;--paper:#0A1E25;--paper-2:#0E252D;--card:#12303A;--muted:#9DB0B5;--line:#1F3E48;--in:#14343F;--mia:#3A3320;--team:#1D4636;--ok:#46B884;--warn:#E8A06A;--side:#061519;--side-2:#0D2C35;--shadow:0 1px 2px rgba(0,0,0,.25)}}
body{font-size:15px;letter-spacing:-.003em}
::selection{background:rgba(220,164,74,.35)}
/* header / brand */
header{background:var(--side);color:#F7F3EA;gap:12px}
header .brand{display:flex;align-items:center;gap:11px;min-width:0}
header .brand .logo,header .brand .logo-svg{flex:none;width:32px;height:32px;border-radius:50%}
header .bn{display:flex;flex-direction:column;min-width:0;line-height:1.2}
header .bn b{font-size:15px;font-weight:700;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (min-width:761px){header .bn b{white-space:normal;overflow:visible}}
header .bn small{font-size:12px;color:#93A9AE;font-weight:500}
header .htools{display:flex;align-items:center;gap:4px}
header .htools .lnk,header .htools a{display:inline-flex;align-items:center;gap:8px;color:#B7C7CB;font-size:13.5px;font-weight:500;padding:8px 10px;border-radius:9px;text-decoration:none}
header .htools .lnk:hover,header .htools a:hover{background:rgba(247,243,234,.07);color:#F7F3EA}
header .hlang .chev{margin-left:auto;opacity:.6;transition:transform .15s}
header .hlang[aria-expanded="true"] .chev{transform:rotate(180deg)}
.lmenu{position:fixed;z-index:60;min-width:200px;padding:6px;border-radius:14px;background:#103540;border:1px solid rgba(247,243,234,.12);box-shadow:0 18px 40px -12px rgba(0,0,0,.45),0 2px 6px rgba(0,0,0,.2);font-size:14px}
.lmenu[hidden]{display:none}
.lmenu button{display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border:0;border-radius:9px;background:none;color:#DCE5E7;font:inherit;text-align:left;cursor:pointer}
.lmenu button:hover,.lmenu button:focus-visible{background:rgba(247,243,234,.08);color:#F7F3EA;outline:none}
.lmenu button .code{width:24px;font-size:11px;font-weight:700;letter-spacing:.04em;color:#8FA6AB;text-transform:uppercase}
.lmenu button .ck{margin-left:auto;color:var(--sand);visibility:hidden}
.lmenu button.on{color:#F7F3EA;font-weight:600}
.lmenu button.on .code{color:var(--sand)}
.lmenu button.on .ck{visibility:visible}
header select{background:var(--side-2);color:#F7F3EA;border:1px solid rgba(247,243,234,.12);border-radius:10px;padding:8px 10px}
/* nav */
nav button{gap:10px;font-weight:600;letter-spacing:-.005em}
nav i{display:inline-flex;align-items:center}
nav i svg{display:block}
nav .count{background:var(--sand);color:#09262F;font-weight:700}
/* desktop: sidebar layout */
@media (min-width:761px){
 body{display:grid;grid-template-columns:248px minmax(0,1fr);grid-template-rows:auto auto minmax(0,1fr) auto;grid-template-areas:"brand main" "switch main" "nav main" "tools main";background:linear-gradient(90deg,var(--side) 248px,var(--paper) 248px)}
 header{display:contents}
 header .brand{grid-area:brand;padding:22px 20px 20px}
 header .sp{display:none}
 header select,header .csw{grid-area:switch;margin:0 14px 14px;width:auto;max-width:none}
 header .htools{grid-area:tools;flex-direction:column;align-items:stretch;padding:12px 12px 16px;border-top:1px solid rgba(247,243,234,.08)}
 header .htools .lnk,header .htools a{width:100%;justify-content:flex-start;text-align:left}
 nav{grid-area:nav;flex-direction:column;align-items:stretch;gap:2px;padding:4px 12px;border:0;background:none;overflow:visible}
 nav button{width:100%;justify-content:flex-start;padding:10px 12px;border:0;border-radius:10px;color:#A9BDC1;font-size:14.5px}
 nav button:hover{background:rgba(247,243,234,.06);color:#F7F3EA}
 nav button.on{background:rgba(220,164,74,.14);color:#F7F3EA;border:0}
 nav button.on i{color:var(--sand)}
 nav .count{margin-left:auto}
 .view{grid-area:main;min-height:0}
 .list{width:340px;background:var(--card);border-right:1px solid var(--line)}
 .tools .chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}
 .tools .chips::-webkit-scrollbar{display:none}
 .chip{flex:none}
}
/* conversation list */
.tools{padding:16px 16px 12px;border-bottom:1px solid var(--line);gap:10px}
.tools input{border-radius:11px;padding:10px 12px 10px 36px;background:var(--paper-2) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%235B6B70' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='11' cy='11' r='7'/%3E%3Cpath d='m20 20-3.5-3.5'/%3E%3C/svg%3E") no-repeat 12px 50%;border-color:var(--line)}
.tools input:focus,.compose textarea:focus,.srow input:focus,.tform input:focus,.tform textarea:focus,.tform select:focus,.ptable input:focus{outline:none;border-color:var(--sand);box-shadow:0 0 0 3px rgba(220,164,74,.2)}
.chip{font-weight:600;font-size:12.5px;padding:5px 12px;background:transparent;transition:background .15s,border-color .15s}
.chip:hover{border-color:var(--muted)}
.chip.on{background:var(--side);border-color:var(--side);color:#F7F3EA}
@media (prefers-color-scheme:dark){.chip.on{background:var(--sand);border-color:var(--sand);color:#09262F}}
.items{padding:6px 8px 12px}
.item{border:0;border-radius:12px;margin:2px 0;padding:12px 12px 12px 14px;border-left:0;position:relative;transition:background .12s}
.item:hover{background:var(--paper-2)}
.item.on{background:var(--paper)}
.item.on::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:3px;background:var(--sand)}
.item .nm{font-weight:650;font-size:14.5px}
.item .pv{font-size:13.5px}
.tag{font-weight:700;font-size:10.5px;letter-spacing:.01em;padding:2px 8px}
.tag.lang{background:var(--paper);color:var(--muted);border:1px solid var(--line)}
/* conversation pane */
.pane{background:var(--paper)}
.pane .head{background:var(--card);padding:14px 22px;border-bottom:1px solid var(--line)}
.pane .head b{font-size:17px;letter-spacing:-.01em}
.facts{background:var(--card);padding:0 22px 12px;gap:6px;border-bottom:1px solid var(--line)}
.facts span{background:var(--paper);border:1px solid var(--line);border-radius:999px;padding:3px 10px;font-size:12.5px}
.ghost{font-weight:600;border-radius:10px;padding:7px 13px;background:var(--card);transition:border-color .15s,background .15s}
.ghost:hover{border-color:var(--deep);background:var(--paper-2)}
.msgs{gap:8px;padding-top:24px;padding-bottom:24px}
.m{border-radius:16px;font-size:14.5px;padding:10px 14px 7px;box-shadow:none}
.m.Customer{border:1px solid var(--line);border-top-left-radius:5px;background:var(--in)}
.m.Mia{background:var(--mia);border-top-right-radius:5px}
.m.Team{background:#163741;color:#F7F3EA;border-top-right-radius:5px}
.m.Team small,.m.Team .who,.m.Team a{color:#B7C7CB}
.m .who{font-weight:700;letter-spacing:.06em;font-size:10.5px}
.day{background:var(--card);font-weight:600}
.compose{background:var(--card);padding-top:12px;gap:10px}
.compose textarea{border-radius:14px;background:var(--paper-2);min-height:48px}
.bar2,.note,.closed{background:var(--card)}
.bar2 input,.bar2 select{border-radius:9px;background:var(--paper-2)}
.btn{font-weight:700;border-radius:12px;padding:11px 20px;background:var(--sand);color:#09262F;transition:filter .15s}
.btn:hover{filter:brightness(1.05)}
.placeholder{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px;box-shadow:var(--shadow);line-height:1.6;font-size:14px}
/* bookings, dashboard, settings, support */
.bwrap,.swrap{padding-top:28px}
.bwrap{max-width:1080px}
.btools{gap:8px;margin-bottom:18px}
.cards,.kpis{grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.cardn,.kpi,.scard{border-radius:16px;border-color:var(--line);box-shadow:var(--shadow);background:var(--card)}
.cardn,.kpi{padding:16px 18px}
.cardn small,.kpi small{font-size:12.5px;font-weight:500}
.cardn b,.kpi b{font-size:26px;letter-spacing:-.025em;font-weight:700;margin-top:4px}
.kpi.hi{background:var(--side);border-color:var(--side);color:#F7F3EA}
.kpi.hi b{color:var(--sand)}
.dayh{font-size:16px;font-weight:700;margin:26px 0 10px;letter-spacing:-.01em}
.prodh{font-weight:700;font-size:11.5px;letter-spacing:.07em}
.btable{border-radius:14px;box-shadow:var(--shadow);font-size:14px}
.btable th{background:var(--paper-2);font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;font-weight:600;padding:10px 12px}
.btable td{padding:11px 12px}
.btable tbody tr:hover td{background:var(--paper-2)}
.scard{padding:22px 24px}
.scard h3{font-size:17px;letter-spacing:-.01em}
.ptable th{font-size:11.5px;letter-spacing:.04em;text-transform:uppercase;font-weight:600}
.ptable input[type=number],.ptable select,.srow input[type=email],.srow input[type=time]{border-radius:10px}
.st{font-weight:700;font-size:10.5px}
#dash iframe{background:var(--card)}
:focus-visible{outline:2px solid var(--sand);outline-offset:2px}
@media (min-width:1100px){.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}}
/* phone */
@media (max-width:760px){
 header{padding:calc(10px + env(safe-area-inset-top,0px)) 12px 10px 14px}
 header .bn small{display:none}
 header .htools .sl{display:none}
 header .htools .lnk,header .htools a{padding:8px}
 nav{background:color-mix(in srgb,var(--card) 92%,transparent);backdrop-filter:saturate(1.4) blur(12px);-webkit-backdrop-filter:saturate(1.4) blur(12px);border-top:1px solid var(--line);padding:6px 6px calc(6px + env(safe-area-inset-bottom,0px))}
 nav button{font-size:10.5px;font-weight:600;padding:6px 2px 5px;border-radius:12px;color:var(--muted);gap:3px}
 nav button.on{background:var(--paper);color:var(--deep)}
 nav button.on i{color:var(--sand)}
 nav i{font-size:inherit}
 nav i svg{width:22px;height:22px}
 .list{background:var(--card)}
 .items{padding:4px 6px 12px}
 .pane .head{padding:calc(10px + env(safe-area-inset-top,0px)) 12px 10px}
 .facts{padding:0 12px 10px}
 .cardn b,.kpi b{font-size:21px}
 .bwrap,.swrap{padding-top:16px}
 .cards,.kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
}

/* While you were diving */
.night{margin:12px 12px 4px;padding:14px 16px;border-radius:16px;background:var(--side);color:#F7F3EA;box-shadow:var(--shadow)}
.night .nh{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.night .nh svg{color:var(--sand);flex:none}
.night .nh b{font-size:14px;font-weight:700;letter-spacing:-.01em}
.night .nh small{margin-left:auto;font-size:11.5px;color:#93A9AE}
.night .nstats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px}
.night .nstats b{display:block;font-size:22px;font-weight:700;letter-spacing:-.02em;line-height:1.1}
.night .nstats div:last-child b{color:var(--sand)}
.night .nstats span{font-size:11.5px;color:#A9BDC1}
.night .nline{margin:10px 0 0;font-size:12.5px;line-height:1.5;color:#C9D6D9}
.night.big{margin:0 0 14px;padding:22px 24px;border-radius:18px}
.night.big .nh b{font-size:17px}
.night.big .nh small{font-size:13px}
.night.big .nstats{margin-top:16px;gap:16px}
.night.big .nstats b{font-size:34px}
.night.big .nstats span{font-size:13px}
.night.big .nline{font-size:14px;margin-top:14px}
@media (max-width:760px){.night{margin:10px 10px 2px}.night.big{margin:0 0 12px;padding:18px}.night.big .nstats b{font-size:26px}}

/* Heatmap and countries */
.heat{display:grid;grid-template-columns:34px repeat(24,minmax(0,1fr));gap:3px;align-items:center;margin-top:6px}
.heat i{display:block;aspect-ratio:1;border-radius:4px;min-height:10px}
.heat .hd{font-size:11px;color:var(--muted);font-weight:600}
.heat .hh{font-size:10.5px;color:var(--muted)}
.hnote{margin:12px 0 0;font-size:12.5px;color:var(--muted)}
.flag{font-size:16px;line-height:1}
.barrow .lb.lbw{width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--deep)}
.panel{border-radius:16px;box-shadow:var(--shadow);padding:18px 20px}
.panel h4{font-size:15px;letter-spacing:-.01em}
@media (max-width:760px){.heat{grid-template-columns:28px repeat(24,minmax(0,1fr));gap:2px}.heat i{border-radius:2px;min-height:8px}.heat .hh{font-size:9px}}

/* Funnel */
.funnel{margin-bottom:14px}
.fsteps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;margin-top:28px}
.fstep{position:relative;display:flex;flex-direction:column;gap:2px}
.fbar{height:10px;border-radius:5px;background:var(--paper);overflow:hidden;margin-bottom:10px}
.fbar span{display:block;height:100%;border-radius:5px;background:var(--sand)}
.fstep:first-child .fbar span{background:var(--side)}
@media (prefers-color-scheme:dark){.fstep:first-child .fbar span{background:#9DB0B5}}
.fstep b{font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1.1}
.fstep small{font-size:13px;font-weight:600}
.fstep em{font-style:normal;font-size:12px;color:var(--muted)}
.fpct{position:absolute;right:0;top:-24px;font-size:12px;font-weight:700;color:var(--muted)}
@media (max-width:760px){.fsteps{grid-template-columns:repeat(2,minmax(0,1fr));gap:22px 14px}.fstep b{font-size:22px}}

/* Milestones */
.ms{display:flex;align-items:center;gap:16px;margin:0 0 14px;padding:16px 20px;border-radius:16px;background:var(--card);border:1px solid var(--line);box-shadow:var(--shadow)}
.ms .msicon{flex:none;width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(220,164,74,.18);color:#B07F1E}
.ms .msbody{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
.ms .msbody b{font-size:15px;font-weight:700;letter-spacing:-.01em}
.ms .msbody small{font-size:12.5px;color:var(--muted)}
.msprog{height:8px;border-radius:4px;background:var(--paper);overflow:hidden;margin-top:8px;max-width:420px}
.msprog span{display:block;height:100%;background:var(--sand);border-radius:4px}
.ms.small{margin:8px 12px 2px;padding:10px 14px;gap:12px}
.ms.small .msicon{width:34px;height:34px}
.ms.small .msbody b{font-size:13.5px}
@media (prefers-color-scheme:dark){.ms .msicon{color:var(--sand)}}
@media (max-width:760px){.ms.small{margin:8px 10px 2px}}

/* Polish: list tags on their own line, skeletons, empty states, getting started */
.item .top{gap:10px}
.item .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item .tags{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.item .pv{margin-top:5px}
.skel{display:grid;gap:10px;padding:4px 0}
.skel.list{padding:10px 12px}
.skel.pad{padding:24px;max-width:880px;width:100%;margin:0 auto}
.skel i{display:block;height:56px;border-radius:14px;background:linear-gradient(90deg,var(--paper-2) 0%,var(--line) 50%,var(--paper-2) 100%);background-size:200% 100%;animation:skel 1.3s ease-in-out infinite}
.skel.list i{height:62px}
.skel i:nth-child(2){opacity:.75}.skel i:nth-child(3){opacity:.5}.skel i:nth-child(4){opacity:.3}
@keyframes skel{from{background-position:200% 0}to{background-position:-200% 0}}
@media (prefers-reduced-motion:reduce){.skel i{animation:none}}
.empty-card{display:flex;flex-direction:column;align-items:flex-start;gap:8px;max-width:560px;margin:8px 0;padding:24px;border-radius:16px;background:var(--card);border:1px solid var(--line);box-shadow:var(--shadow)}
.empty-card .eic{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:rgba(220,164,74,.18);color:#B07F1E}
.empty-card b{font-size:16px}
.empty-card p{margin:0;font-size:14px;color:var(--muted);line-height:1.55}
.start{margin:0 0 14px;padding:18px 20px;border-radius:16px;background:var(--card);border:1px solid var(--line);box-shadow:var(--shadow)}
.start .sh{display:flex;align-items:baseline;gap:10px}
.start .sh b{font-size:15px}
.start .sh small{color:var(--muted);font-size:12.5px}
.start .lnk3{margin-left:auto;background:none;border:0;font:inherit;font-size:12.5px;color:var(--muted);cursor:pointer}
.start .lnk3:hover{color:var(--deep);text-decoration:underline}
.sprog{height:6px;border-radius:3px;background:var(--paper);overflow:hidden;margin:10px 0 12px}
.sprog span{display:block;height:100%;background:var(--sand)}
.slist{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 20px}
.slist li{display:flex;align-items:center;gap:10px;font-size:14px}
.slist li.ok{color:var(--muted);text-decoration:line-through}
.slist .ck{flex:none;width:20px;height:20px;border-radius:50%;border:1.5px solid var(--line);display:flex;align-items:center;justify-content:center;color:#09262F}
.slist li.ok .ck{background:var(--sand);border-color:var(--sand)}
.slist a{color:var(--deep);font-weight:600}
@media (max-width:760px){.slist{grid-template-columns:1fr}}

/* Avatars */
.av{position:relative;flex:none;width:40px;height:40px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#F7F3EA;font-size:14px;font-weight:700;letter-spacing:.02em}
.av .avf{position:absolute;right:-3px;bottom:-3px;font-size:13px;line-height:1;background:var(--card);border-radius:50%;padding:1px}
.item{display:flex;gap:12px;align-items:flex-start}
.item .ib{flex:1;min-width:0}
.pane .head .av{width:38px;height:38px}
/* Booking chips */
.pchips{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:10px 16px 0;background:var(--card)}
.pchips .pcl{font-size:12px;color:var(--muted);font-weight:600;margin-right:2px}
.pchip{font:inherit;font-size:12.5px;font-weight:600;border:1px solid var(--line);background:var(--paper-2);color:var(--deep);border-radius:999px;padding:5px 11px;cursor:pointer}
.pchip:hover{border-color:var(--sand);background:rgba(220,164,74,.12)}
@media (max-width:760px){.pchips .pcl{display:none}.pchips{padding:8px 12px 0;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none}.pchips::-webkit-scrollbar{display:none}.pchip{flex:none}}
/* Trends */
.kpi em.trend{display:inline-block;font-style:normal;font-size:11.5px;font-weight:700;border-radius:999px;padding:2px 8px;margin:6px 0 2px}
.kpi em.trend.up{background:rgba(35,133,90,.12);color:#1E7A52}
.kpi em.trend.down{background:rgba(180,86,27,.12);color:#A34E19}
.kpi em.trend.flat{background:var(--paper);color:var(--muted)}
.kpi.hi em.trend.up{background:rgba(95,192,138,.18);color:#7FD3A5}
.kpi.hi em.trend.down{background:rgba(232,160,106,.18);color:#F0B48A}
.kpi span{display:block}
@media (prefers-color-scheme:dark){.kpi em.trend.up{color:#6FCF9B}.kpi em.trend.down{color:#F0A877}}
/* Today */
#today{flex-direction:column;overflow-y:auto}
.twrap{width:100%;max-width:1120px;margin:0 auto;padding:28px 20px calc(40px + env(safe-area-inset-bottom,0px))}
.thead h1{margin:0;font-size:28px;letter-spacing:-.025em}
.thead p{margin:4px 0 18px;color:var(--muted);font-size:14px}
.tgrid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);gap:14px;align-items:start}
.tcol{display:grid;gap:14px;min-width:0;grid-template-columns:minmax(0,1fr)}
.tcard{min-width:0}
.tcol .night.big{margin:0}
.tcard{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:18px 20px}
.th{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.th b{font-size:15px;letter-spacing:-.01em}
.th small{color:var(--muted);font-size:12.5px}
.th .tlink{margin-left:auto;font-size:13px;font-weight:600;color:var(--deep)}
.trow{display:flex;align-items:center;gap:12px;width:100%;text-align:left;font:inherit;color:inherit;background:none;border:0;border-radius:12px;padding:10px 8px;cursor:pointer}
.trow:hover{background:var(--paper-2)}
.trow.static{cursor:default}.trow.static:hover{background:none}
.trow .tr-b{flex:1;min-width:0;display:flex;flex-direction:column}
.trow .tr-b b{font-size:14px}
.trow .tr-b small{font-size:13px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.trow .tr-t{font-size:12px;color:var(--muted)}
.tok{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:14px;color:var(--muted)}
.okdot{width:8px;height:8px;border-radius:50%;background:var(--live,#5FC08A);flex:none}
.tday+.tday{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
.tdh{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.tdh b{font-size:14px}.tdh small{color:var(--muted);font-size:12.5px}
.tboat{display:flex;justify-content:space-between;gap:10px;padding:8px 12px;margin-top:6px;border-radius:10px;background:var(--paper-2);font-size:14px}
.tboat b{font-weight:700}
.tbars{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;align-items:end;height:110px}
.tb{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:4px;height:100%}
.tbb{width:100%;max-width:34px;border-radius:6px 6px 3px 3px;background:var(--sand)}
.tb:first-child .tbb{background:var(--side)}
@media (prefers-color-scheme:dark){.tb:first-child .tbb{background:#9DB0B5}}
.tbv{font-size:12px;font-weight:700}
.tb small{font-size:11.5px;color:var(--muted)}
@media (max-width:900px){.tgrid{grid-template-columns:1fr}}
@media (max-width:760px){.twrap{padding:18px 12px 20px}.thead h1{font-size:23px}}
/* Calendar */
.cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}
.cday{min-height:120px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px;display:flex;flex-direction:column;gap:6px}
.cday.wk{background:var(--paper-2)}
.cday.today{border-color:var(--sand);box-shadow:0 0 0 2px rgba(220,164,74,.25)}
.cdh{display:flex;align-items:baseline;gap:6px}
.cdh small{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.cdh b{font-size:18px}
.ctot{margin-left:auto;font-size:11px;font-weight:700;background:var(--side);color:#F7F3EA;border-radius:999px;padding:1px 7px}
@media (prefers-color-scheme:dark){.ctot{background:var(--sand);color:#09262F}}
.cblk{background:rgba(220,164,74,.16);border-left:3px solid var(--sand);border-radius:8px;padding:6px 8px;display:flex;flex-direction:column}
.cblk b{font-size:12.5px;line-height:1.3}
.cblk small{font-size:11.5px;color:var(--muted)}
.cnone{color:var(--line);font-size:13px}
@media (max-width:760px){.cal{grid-template-columns:repeat(2,minmax(0,1fr))}.cday{min-height:0}}
@media print{#today{display:none !important}}

/* Chat v3: cleaner header facts, quieter bubbles, modern composer */
.av.anon{background:var(--paper)!important;color:var(--muted);border:1px solid var(--line)}
.pane .head .sub{font-size:12.5px}
.facts span{font-size:12px;padding:3px 10px}
.m .who{text-transform:none;letter-spacing:0;font-size:11.5px;font-weight:700;color:#9A6B1F;margin-bottom:2px}
.m.Team .who{color:#DCA44A}
@media (prefers-color-scheme:dark){.m .who{color:var(--sand)}}
.m{line-height:1.5}
.m small{display:flex;justify-content:flex-end;align-items:center;gap:8px}
.rep{margin-left:0;text-decoration:none;font-weight:600;border-radius:6px;padding:1px 6px}
.rep:hover{background:rgba(9,38,47,.06);color:var(--deep)}
@media (hover:hover){.rep{opacity:0;transition:opacity .15s}.m:hover .rep{opacity:1}}
.composer{border-top:1px solid var(--line);background:var(--card);padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px))}
.composer .pchips{padding:0 0 10px;background:none;flex-wrap:nowrap;gap:10px}
.composer .pcl{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:12px;font-weight:600;color:var(--muted);margin:0}
.pscroll{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;-webkit-mask-image:linear-gradient(90deg,#000 92%,transparent);mask-image:linear-gradient(90deg,#000 92%,transparent);padding-right:24px}
.pscroll::-webkit-scrollbar{display:none}
.composer .pchip{flex:none;font-size:12px;padding:4px 10px;background:var(--card)}
.cbox{display:flex;align-items:flex-end;gap:8px;background:var(--paper-2);border:1px solid var(--line);border-radius:18px;padding:6px 6px 6px 14px;transition:border-color .15s,box-shadow .15s}
.cbox:focus-within{border-color:var(--sand);box-shadow:0 0 0 3px rgba(220,164,74,.18)}
.cbox textarea{flex:1;border:0;background:none;resize:none;font:inherit;font-size:15px;line-height:1.45;color:var(--deep);padding:7px 0;min-height:22px;max-height:180px;outline:none;box-shadow:none}
.cbox textarea:focus{outline:none;box-shadow:none}
.send{flex:none;width:40px;height:40px;border:0;border-radius:50%;background:var(--sand);color:#09262F;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:filter .15s,transform .1s}
.send:hover{filter:brightness(1.05)}.send:active{transform:scale(.95)}
.send[disabled]{opacity:.6;cursor:progress}
.send.busy svg{animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.cmeta{display:flex;align-items:center;gap:10px;margin-top:8px;font-size:12px;color:var(--muted)}
.cmeta .sig{display:inline-flex;align-items:center;gap:6px}
.cmeta .sig input{font:inherit;font-size:12px;font-weight:600;color:var(--deep);border:0;border-bottom:1px dashed var(--line);background:none;padding:2px 0;width:110px;outline:none}
.cmeta .sig input:focus{border-bottom-color:var(--sand)}
.cmeta .sig input[type=checkbox]{width:15px;height:15px;margin:0;accent-color:var(--sand);border:0;cursor:pointer}
.cmeta .sig:has(#sigon:not(:checked)) #sig{opacity:.45}
.emo{flex:none;width:38px;height:38px;border:0;border-radius:50%;background:none;color:var(--muted);display:grid;place-items:center;cursor:pointer}
.emo:hover,.emo[aria-expanded="true"]{background:rgba(10,32,41,.06);color:var(--deep)}
.epick{display:grid;grid-template-columns:repeat(12,1fr);gap:2px;margin-top:8px;padding:6px;border-radius:14px;background:var(--card);border:1px solid var(--line);box-shadow:0 10px 30px -14px rgba(10,32,41,.3)}
.epick[hidden]{display:none}
.fchip{display:flex;align-items:center;gap:10px;margin-top:8px;padding:6px 8px;border-radius:12px;background:var(--paper-2);border:1px solid var(--line);font-size:13px}
.fchip[hidden]{display:none}
.fchip img{width:44px;height:44px;object-fit:cover;border-radius:8px}
.fchip .fic{width:44px;height:44px;border-radius:8px;background:#B3261E;color:#fff;font-weight:700;font-size:11px;display:grid;place-items:center}
.fchip .fn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--deep)}
.fchip button{border:0;background:none;font-size:20px;line-height:1;color:var(--muted);cursor:pointer;padding:4px 8px}
.m .mimg{display:block;margin:2px 0 6px}
.m .mimg img{display:block;max-width:240px;max-height:240px;border-radius:10px;object-fit:cover}
.m .mfile{display:table;margin:2px 0 6px;padding:8px 12px;border-radius:10px;background:rgba(10,32,41,.06);color:inherit;font-weight:600;text-decoration:none}
.m.Team .mfile{background:rgba(255,255,255,.14)}
.epick button{border:0;background:none;border-radius:8px;font-size:20px;line-height:1;padding:6px 0;cursor:pointer}
.epick button:hover{background:var(--paper)}
@media (max-width:760px){.epick{grid-template-columns:repeat(8,1fr)}}
.cmeta .sp{flex:1}
.cmeta .bt.soon{color:var(--warn);font-weight:700}
.composer .note{background:none;padding:6px 0 0;font-size:11.5px}
@media (max-width:760px){.composer{padding:8px 10px calc(8px + env(safe-area-inset-bottom,0px))}.composer .pcl span,.composer .pcl{font-size:0;gap:0}.composer .pcl svg{width:16px;height:16px}.composer .note{display:none}.composer .note.err{display:block}.cbox textarea{font-size:16px}}

/* Booking in the conversation */
.bkwrap{background:var(--card);border-bottom:1px solid var(--line);padding:0 22px 12px;display:grid;gap:8px}
.bkc{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:12px;background:rgba(95,192,138,.12);border:1px solid rgba(95,192,138,.35)}
.bki{flex:none;width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:var(--card);color:#1E7A52}
.bkb{flex:1;min-width:0;display:flex;flex-direction:column}
.bkb b{font-size:13.5px}
.bkb small{font-size:12px;color:var(--muted)}
.bkw{flex:none;font-size:11.5px;font-weight:700;color:#1E7A52;background:var(--card);border-radius:999px;padding:3px 9px}
.bkm{flex:none;text-decoration:none;font-size:12px}
.bkp{font-size:12px;color:var(--muted)}
.tag.ret{background:rgba(220,164,74,.18);color:#8A5E14}
@media (prefers-color-scheme:dark){.bki,.bkw{color:#6FCF9B}.tag.ret{color:var(--sand)}}
@media (max-width:760px){.pane .head > .tag.ret{display:none}.bkwrap{padding:0 12px 10px}.bkc{flex-wrap:wrap}.bkb{flex-basis:calc(100% - 46px)}.bkw{margin-left:46px}.bkm{margin-left:auto}}

/* Dashboard layout v2 */
.dsec{display:flex;align-items:baseline;gap:12px;margin:26px 0 12px}
.dsec:first-child{margin-top:4px}
.dsec h3{margin:0;font-size:18px;letter-spacing:-.015em}
.dsec p{margin:0;font-size:13px;color:var(--muted)}
.kpis.main{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:12px}
.minis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px}
.mini{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 16px}
.mini small{flex-basis:100%;font-size:12.5px;color:var(--muted)}
.mini b{font-size:19px;letter-spacing:-.02em}
.mini span{font-size:12px;color:var(--muted)}
.mini em.trend{display:inline-block;font-style:normal;font-size:11px;font-weight:700;border-radius:999px;padding:1px 7px}
.mini em.trend.up{background:rgba(35,133,90,.12);color:#1E7A52}.mini em.trend.down{background:rgba(180,86,27,.12);color:#A34E19}.mini em.trend.flat{background:var(--paper);color:var(--muted)}
.dgrid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:14px;align-items:start}
.dmain,.dside{display:grid;gap:14px;min-width:0}
.dmain .funnel{margin:0}
.dside .ms{margin:0}
.dside .ms .msprog{max-width:none}
.dgrid3{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:start}
.dgrid3 .barrow .lb.lbw{width:120px}
.prow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
.prow:first-of-type{border-top:0}
.prow div{display:flex;flex-direction:column;min-width:0}
.prow b{font-size:14px}
.prow small{font-size:12px;color:var(--muted)}
.prow span{font-weight:700;font-size:14px;white-space:nowrap}
details.stmt{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}
details.stmt summary{cursor:pointer;list-style:none;padding:14px 20px;font-weight:600;font-size:14px;display:flex;align-items:center;gap:10px}
details.stmt summary::-webkit-details-marker{display:none}
details.stmt summary::before{content:"";width:8px;height:8px;border-right:2px solid var(--muted);border-bottom:2px solid var(--muted);transform:rotate(-45deg);transition:transform .15s}
details.stmt[open] summary::before{transform:rotate(45deg)}
details.stmt > .panel{border:0;border-top:1px solid var(--line);border-radius:0;box-shadow:none}
@media (max-width:1100px){.kpis.main{grid-template-columns:repeat(2,minmax(0,1fr))}.dgrid,.dgrid3{grid-template-columns:1fr}}
@media (max-width:760px){.minis{grid-template-columns:1fr}.dsec{flex-direction:column;gap:2px}.kpis.main{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media print{details.stmt{border:0;box-shadow:none}details.stmt summary{display:none}body.print-statement .minis,body.print-statement .dgrid,body.print-statement .dgrid3,body.print-statement .dsec,body.print-statement #start,body.print-statement #ms{display:none !important}}

/* Today layout v2: balanced rows */
.trow1{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:14px;margin-bottom:14px;align-items:stretch}
.trow1 .night.big{margin:0;display:flex;flex-direction:column;justify-content:space-between}
.trow1 .night.big[hidden]{display:none}
.trow2{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-bottom:14px;align-items:stretch}
.trow2 .tcard,.trow1 .tcard{display:flex;flex-direction:column;min-width:0}
.tbig{display:flex;align-items:baseline;gap:8px;margin:2px 0 10px}
.tbig b{font-size:32px;line-height:1;letter-spacing:-.03em}
.tbig span{font-size:13px;color:var(--muted)}
.tboat{padding:7px 12px;margin-top:6px}
#tWeek .tbars{margin-top:auto}
.tarr{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;width:100%;min-width:0}
.tarr .trow{min-width:0;width:auto}
.tarr .trow{background:var(--paper-2);border-radius:12px;padding:10px}
.tarr .trow .tr-b small{white-space:normal;overflow:visible}
@media (max-width:1100px){.trow2{grid-template-columns:1fr 1fr}.trow2 #tWeek{grid-column:1 / -1}.tarr{grid-template-columns:1fr 1fr}}
@media (max-width:760px){.trow1,.trow2{grid-template-columns:1fr}.trow2 #tWeek{grid-column:auto}.tarr{grid-template-columns:1fr}}
.item .meta{display:flex;flex-wrap:wrap;gap:2px 0;margin-top:4px;font-size:12.5px;color:var(--muted)}
.item .meta span+span::before{content:"·";margin:0 6px}
.item .meta .left{margin:0;font-size:inherit}
.item .meta .bk{color:var(--ok);font-weight:600}
.csw{display:flex;align-items:center;gap:8px;width:auto;min-width:0;max-width:52vw;font:inherit;font-size:14px;text-align:left;cursor:pointer;background:var(--side-2);color:#F7F3EA;border:1px solid rgba(247,243,234,.12);border-radius:10px;padding:8px 12px}
.csw span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.csw:hover{border-color:rgba(247,243,234,.25)}
.csw .chev{flex:none;opacity:.6;transition:transform .15s}
.csw[aria-expanded="true"] .chev{transform:rotate(180deg)}
.btable.bday tr.grp td{background:var(--paper-2);font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);padding:8px 12px}
.btable.bday tr.grp span{margin-left:10px;font-weight:500;text-transform:none;letter-spacing:0}
.btable.bday tbody tr.grp:hover td{background:var(--paper-2)}
.btable.bday .tname small.ref{display:block;font-size:12px;color:var(--muted);font-weight:500}
.btable.bday a.tel{font-weight:500;text-decoration:none}
.btable.bday a.tel:hover{text-decoration:underline}
.btable td.tlinks{text-align:right;white-space:nowrap}
.btable td.tlinks a{display:inline-block;vertical-align:top;margin:-3px 0 -3px 6px;padding:0 12px;line-height:22px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--deep);font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap}
.btable td.tlinks a:hover{background:var(--paper);border-color:#D9CFBD}
.btable td.tlinks .st{font-size:12.5px;color:var(--muted)}
/* The numbers at the top of each page: centred */
.cards .cardn,.kpis .kpi{text-align:center}
.minis.strip .mini{justify-content:center;align-items:center;align-content:flex-start;text-align:center}
.minis.strip .mini span{flex-basis:100%}
@media (max-width:760px){.btable td.tlinks a{margin:0 6px 0 0}}
.chip{display:inline-flex;align-items:center;justify-content:center;line-height:20px}
.chip .count{line-height:18px}
.th{align-items:baseline}
.th .tag{align-self:center}
/* Settings (25 Oct): calmer */
.smsg:empty{min-height:0;margin:0}
.srow+.smsg:empty+.d{margin-top:18px}
.scard .d a{color:var(--deep);font-weight:600}
.ptable td.nm{min-width:170px}
.ptable td.dep{white-space:nowrap}
.ptable th{vertical-align:bottom}
.ptable input[type=checkbox]{width:18px;height:18px;accent-color:#0A2029;cursor:pointer}
.ptable td.tlinks{min-width:84px}
.ptable .ps{padding:6px 14px;font-size:13px}
.ptable .ps[hidden]{display:none}
.people{gap:0;margin-bottom:14px;border-top:1px solid var(--line)}
.people li{border:0;border-bottom:1px solid var(--line);border-radius:0;background:none;padding:10px 2px}
.people li > button{color:var(--muted);font-weight:600}
.people li > button:hover{color:var(--warn)}
.people li{gap:12px}
.people .av{flex:none;width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--paper);color:var(--deep);font-weight:700;font-size:14px}
.people .pmi{flex:1;min-width:0}
.people .pmn{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.people .pmn b{font-weight:600}
.people .prole{flex:none;font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:0 8px}
.people .pms{font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.people li > button.ped{color:var(--deep)}
.people .pedit{padding:14px 2px 18px 48px;border-bottom:1px solid var(--line)}
.pedit .pgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.pedit label{display:grid;gap:4px;font-size:13px;color:var(--muted)}
.pedit input[type=text],.pedit input[type=tel]{font:inherit;font-size:14px;color:var(--deep);border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--paper-2)}
.pedit .plab{font-size:13px;color:var(--muted);margin:14px 0 6px}
.pedit label.pev{display:flex;align-items:center;gap:8px;margin-top:14px;color:var(--deep);font-size:14px}
.pedit input[type=checkbox]{width:18px;height:18px;accent-color:#0A2029}
.pedit .pact{display:flex;gap:8px;margin-top:16px}
.pedit .pchips{padding:0;margin:0;gap:6px;flex-wrap:wrap;overflow:visible}
@media (max-width:760px){.people .pedit{padding-left:2px}.pedit .pgrid{grid-template-columns:1fr}}
/* Support (25 Oct): empty state across the page, centred */
#supp .empty-card{max-width:none;align-items:center;text-align:center;padding:40px 24px}
#supp .empty-card p{max-width:520px}
.empty-card p b{font-size:inherit;color:var(--deep);font-weight:600}
/* Conversations (25 Oct): one clean edge between list and chat */
#convos .list .tools{border-bottom:0;padding-bottom:6px}
.item.on{background:var(--paper);box-shadow:inset 0 0 0 1px var(--line)}
.item.on::before{content:none}
.pane .head > .tag{align-self:flex-start;margin-top:3px}
/* Center logo (25 Oct): bigger, with a light ring so a dark logo stands out */
header .brand .logo{width:42px;height:42px;padding:2px;background:#F4F0E6;box-shadow:0 0 0 1px rgba(247,243,234,.25),0 2px 6px rgba(0,0,0,.25)}
/* Colours swapped (25 Oct): chat light and airy like WhatsApp, the list warm */
@media (prefers-color-scheme:light){
 .pane{background:#FCFBF8}
 .m.Customer{background:#fff;border-color:#ECE6DA}
 .m.Mia{background:#EAF4F1}
 .m.Mia .who{color:#2E6F80}
 .m.Team{background:#E4EEF8;color:var(--deep)}
 .m.Team small,.m.Team a{color:var(--muted)}
 .m.Team .who{color:#2F5F8F}
 .m.Team .mfile{background:rgba(10,32,41,.06)}
 #convos .list{background:var(--paper)}
 #convos .list .item.on{background:var(--card);box-shadow:var(--shadow)}
 #convos .list .item:hover:not(.on){background:rgba(255,255,255,.55)}
 #convos .list .tools input{background-color:var(--card)}
}
@media (max-width:760px){#books .btable.bday tr.grp{background:none;border:0;padding:12px 2px 4px;margin:0}#books .btable.bday tr.grp td{background:none;padding:0;justify-content:flex-start;text-align:left}#books .btable.bday .tname{flex-direction:column;align-items:flex-start;gap:0}}
.minis.strip{gap:0;background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}
.minis.strip .mini{background:none;border:0;border-radius:0;box-shadow:none;padding:14px 20px}
.minis.strip .mini+.mini{border-left:1px solid var(--line)}
@media (max-width:760px){.minis.strip{grid-template-columns:1fr}.minis.strip .mini+.mini{border-left:0;border-top:1px solid var(--line)}}
#msSlot{display:contents}
.pbtn{display:inline-flex;align-items:center;gap:10px;cursor:pointer;text-align:left}
.pbtn .chev{opacity:.6;transition:transform .15s}
.pbtn[aria-expanded="true"] .chev{transform:rotate(180deg)}
/* Calm chat (25 Oct): one quiet info block above the messages, everything on the same left edge */
.pane .head{border-bottom:0;padding:16px 22px 6px}
.cinfo{background:var(--card);border-bottom:1px solid var(--line);padding:0 22px 14px 70px;display:grid;gap:10px}
.cinfo .facts{display:flex;flex-wrap:wrap;gap:4px 18px;padding:0;border:0;background:none;font-size:13px;color:var(--muted)}
.cinfo .facts span{background:none;border:0;border-radius:0;padding:0;font-size:13px}
.cinfo .facts span b{font-weight:600;color:var(--deep)}
.cinfo .teamrow{padding:0;border:0;background:none;gap:4px 18px}
.cinfo .teamrow .asg,.cinfo .teamrow .nbtn{background:none;border:0;border-radius:6px;padding:2px 0;color:var(--muted);font-weight:500;font-size:13px}
.cinfo .teamrow .asg:hover,.cinfo .teamrow .nbtn:hover{background:none;color:var(--deep)}
.cinfo .teamrow .nbtn.has{background:none;color:#7A5B12;font-weight:500}
.cinfo .bkwrap{padding:0;border:0;background:none;gap:6px}
.cinfo .bkc{padding:8px 12px;border-radius:10px;background:var(--paper-2);border:1px solid var(--line);gap:10px}
.cinfo .bki{width:auto;height:auto;background:none}
.cinfo .bkb b{font-weight:600}
.cinfo .bkw{background:none;padding:0}
.cinfo .bkm{border:0;background:none;padding:0;box-shadow:none;color:var(--bar);font-weight:600;font-size:13px}
.cinfo .bkm:hover{text-decoration:underline;background:none}
.composer .note:empty{display:none}
@media (max-width:760px){.pane .head{padding:12px 16px 4px}.cinfo{padding:0 16px 12px}.cinfo .facts{flex-wrap:wrap;overflow:visible;white-space:normal}}
</style></head>
<body>
<header><div class="brand">${logo}<span class="bn"><b>${esc(center.name)}</b><small>${T("Customer zone")}</small></span></div><span class="sp"></span>${switcher}<div class="htools">${superadmin ? `<a href="/zone/admin" title="Talay HQ">Talay HQ</a>` : ""}<button class="lnk hlang" id="hlang" type="button" title="${T("Language")}" aria-haspopup="menu" aria-expanded="false"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"/></svg><span class="sl">${(ZONE_LANGS.find(l => l[0] === lang) || ZONE_LANGS[0])[1]}</span><svg class="chev sl" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><button class="lnk" id="sound" type="button"></button><a href="/cdn-cgi/access/logout" title="${esc(email)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/></svg><span class="sl">${T("Sign out")}</span></a></div></header><div class="lmenu" id="lmenu" role="menu" hidden>${ZONE_LANGS.map(([code, name]) => `<button type="button" role="menuitemradio" aria-checked="${code === lang}" data-l="${code}"${code === lang ? ' class="on"' : ""}><span class="code">${code}</span>${name}<svg class="ck" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7"/></svg></button>`).join("")}</div>
<nav><button class="on" data-v="today"><i><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></i><span class="nl">${T("Today")}</span></button><button data-v="convos"><i><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg></i><span class="nl"><span class="long">${T("Conversations")}</span><span class="short">${T("Chats")}</span></span><span class="count" id="count" hidden></span></button><button data-v="books"><i><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/></svg></i><span class="nl">${T("Bookings")}</span></button><button data-v="dash"><i><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg></i><span class="nl">${T("Dashboard")}</span></button><button data-v="sett"><i><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg></i><span class="nl">${T("Settings")}</span></button><button data-v="supp"><i><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17.2v.1"/></svg></i><span class="nl">${T("Support")}</span><span class="count" id="tcount" hidden></span></button></nav>

<section id="today" class="view on">
  <div class="twrap">
    <div class="thead"><div><h1 id="tGreet">${T("Today")}</h1><p id="tDate"></p></div></div>
    <div class="trow1">
      <div class="tcard" id="tNeed"><div class="skel"><i></i></div></div>
      <div class="night big" id="nightToday"><div class="skel"><i></i></div></div>
    </div>
    <div class="trow2">
      <div class="tcard" id="tToday"><div class="skel"><i></i></div></div>
      <div class="tcard" id="tTomorrow"><div class="skel"><i></i></div></div>
      <div class="tcard" id="tWeek"><div class="skel"><i></i></div></div>
    </div>
    <div class="tcard" id="tArr"><div class="skel"><i></i></div></div>
  </div>
</section>

<section id="convos" class="view">
  <div class="list">
    <div class="tools">
      <input id="search" type="search" placeholder="${T("Search name or message")}" aria-label="${T("Search")}">
      <div class="chips" role="tablist">
        <button class="chip on" data-f="open">${T("Open")}</button>
        <button class="chip" data-f="need">${T("Needs you")}</button>
        <button class="chip" data-f="booked">${T("Booked")}</button>
        <button class="chip" data-f="all" title="${T("All (30 days)")}">${T("All")}</button>
      </div>
    </div>
    <div class="items" id="list"><div class="skel list"><i></i><i></i><i></i><i></i></div></div>
  </div>
  <div class="pane" id="pane"><div class="placeholder">${T("Pick a conversation.")}<br><br>${T("<b>Open</b> shows every diver who wrote in the last 24 hours: WhatsApp, Instagram and Messenger only let you reply freely within that window. <b>Needs you</b> means {a} handed it over to your team.", { a: A })}</div></div>
</section>

<section id="books" class="view">
  <div class="bwrap">
    <div class="btools">
      <button class="chip on" data-r="today">${T("Today")}</button>
      <button class="chip" data-r="tomorrow">${T("Tomorrow")}</button>
      <button class="chip" data-r="next">${T("Next 30 days")}</button>
      <button class="chip" data-r="past">${T("Past 30 days")}</button>
      <button class="chip" data-r="calendar">${T("Calendar")}</button>
      <button class="chip" data-r="unfinished">${T("Not paid yet")}<span class="count" id="ucount" hidden></span></button>
      <button class="chip" data-r="arriving">${T("Arriving soon")}<span class="count" id="acount" hidden></span></button>
      <span class="sp"></span>
      <button class="ghost" id="print" type="button">${T("Print list")}</button>
    </div>
    <div id="bcards" class="cards"></div>
    <div id="blist"><div class="skel"><i></i><i></i><i></i></div></div>
  </div>
</section>

<section id="sett" class="view">
  <div class="swrap">
    <div class="scard">
      <h3>${esc(center.assistant)}</h3>
      <p class="d">${T("Pause {a} for the whole dive center, for example during a storm or a holiday. While paused she doesn't answer anyone: your team answers every diver under <b>Conversations → Open</b>.", { a: A })}</p>
      <div class="switch"><span class="pill" id="miaState">…</span><button class="ghost" id="miaToggle" type="button">…</button></div>
      <div class="smsg" id="miaMsg"></div>
    </div>
    <div class="scard">
      <h3>${T("Notifications on this device")}</h3>
      <p class="d">${T("Get a notification as soon as {a} hands a conversation to your team, even when the zone is closed. Turn it on separately on every phone or computer. On an iPhone, first add the zone to your home screen (Share → Add to Home Screen) and open it from there.", { a: A })}</p>
      <div class="switch"><span class="pill" id="pushState">…</span><button class="btn" id="pushOn" type="button">${T("Turn on notifications")}</button><button class="ghost" id="pushTest" type="button" hidden>${T("Send a test")}</button><button class="ghost" id="pushOff" type="button" hidden>${T("Turn off")}</button></div>
      <div class="smsg" id="pushMsg"></div>
    </div>
    <div class="lock" id="adminNote" hidden>${T("Only an admin of your dive center can change prices, office hours, the alert email and the team. You can still pause {a}.", { a: A })}</div>
    <div class="scard adm">
      <h3>${T("Products and prices")}</h3>
      <p class="d">${T("What divers pay and until when they can book online. The online deposit is your commission to Talay and follows the price automatically. Changes reach {a} and the booking page within about two minutes.", { a: A })}</p>
      <div class="bscroll"><table class="ptable"><thead><tr><th>${T("Product")}</th><th>${T("Price (THB)")}</th><th>${T("Deposit")}</th><th>${T("Book until (day before)")}</th><th>${T("Bookable online")}</th><th></th></tr></thead><tbody id="prods"></tbody></table></div>
      <div class="smsg" id="pMsg"></div>
    </div>
    <div class="scard adm">
      <h3>${T("Office hours")}</h3>
      <p class="d">${T("When your team answers personally (Thai time, every day).")}</p>
      <div class="srow"><label>${T("From")} <input type="time" id="hFrom" step="900"></label><label>${T("to")} <input type="time" id="hTo" step="900"></label><button class="btn" id="hSave" type="button">${T("Save")}</button></div>
      <div class="smsg" id="hMsg"></div>
      <p class="d">${T("Prefer to answer divers yourselves during the day? Then {a} only answers outside these hours. During office hours she stays silent and every message waits for your team under <b>Conversations → Open</b>. Reminders follow the same rule.", { a: A })}</p>
      <div class="switch"><span class="pill" id="modeState">…</span><button class="ghost" id="modeToggle" type="button">…</button></div>
      <div class="smsg" id="modeMsg"></div>
    </div>
    <div class="scard adm">
      <h3>${T("Alert email")}</h3>
      <p class="d">${T("Where handovers, large groups and reminders are sent. A shared inbox works best.")}</p>
      <div class="srow"><input type="email" id="aEmail" placeholder="team@yourdivecenter.com"><button class="btn" id="aSave" type="button">${T("Save")}</button></div>
      <div class="smsg" id="aMsg"></div>
    </div>
    <div class="scard adm">
      <h3>${T("Team")}</h3>
      <p class="d">${T("Everyone here can sign in at talay.io/zone with a code sent to their email.")} ${T("Add a name and WhatsApp number so {a}'s notifications reach the right person.", { a: A })}</p>
      <ul class="people" id="team"></ul>
      <div class="srow"><input type="email" id="tEmail" placeholder="${T("colleague@email.com")}"><button class="btn" id="tAdd" type="button">${T("Add")}</button></div>
      <div class="smsg" id="tMsg"></div>
    </div>
    <div class="scard">
      <h3>${T("What {a} knows about you", { a: A })}</h3>
      <p class="d">${T("To change any of this, message Jonas at {mail}.", { mail: '<a href="mailto:jonas@talay.io">jonas@talay.io</a>' })}</p>
      <dl class="info" id="info"></dl>
    </div>
    <div class="scard">
      <h3>${T("Language")}</h3>
      <p class="d">${T("The language of the zone on this device. Every colleague can choose their own. The messages to divers don't change: {a} always answers in the diver's language.", { a: A })}</p>
      <div class="chips zlangs" role="group" aria-label="${T("Language")}">${langOpts}</div>
    </div>
  </div>
</section>

<section id="supp" class="view">
  <div class="bwrap">
    <div class="btools">
      <button class="chip on" data-t="open">${T("Open")}</button>
      <button class="chip" data-t="done">${T("Done")}</button>
      <span class="sp"></span>
      <button class="ghost" id="tNew" type="button">+ ${T("New ticket")}</button>
    </div>
    <div id="tbody"><div class="skel"><i></i><i></i><i></i></div></div>
  </div>
</section>

<section id="dash" class="view">
  <div class="bwrap">
    <div class="btools">
      <select id="period" aria-label="${T("Period")}" class="psel" hidden></select><button type="button" class="psel pbtn" id="pbtn" aria-haspopup="menu" aria-expanded="false" title="${T("Period")}"><span id="pname">${T("Last 30 days")}</span><svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button><div class="amenu" id="pmenu" role="menu" hidden></div>
      <span class="sp"></span>
      <button class="ghost" id="stPrint" type="button">${T("Print statement")}</button>
      <button class="ghost" id="stCsv" type="button">${T("Download CSV")}</button>
    </div>
    <div class="start" id="start" hidden></div>
    <div class="ms" id="ms" hidden></div>
    <div id="dbody"><div class="skel"><i></i><i></i><i></i></div></div>
  </div>
</section>

<script>var __name = function (f) { return f; }; // Wrangler adds __name(...) calls when bundling
(${zoneClient.toString()})(${JSON.stringify(cfg).replace(/</g, "\\u003c")});</script>
</body></html>`;
}

// Runs in the browser (inserted with toString), so it may not use anything from this module.
function zoneClient(cfg) {
  var current = null, lastList = "", lastChat = "", filter = "open", items = [], needSeen = null, chatSeenAt = null, freshNext = false, freshList = false;
  var soundOn = true, audio = null;
  try { soundOn = localStorage.getItem("talay-sound") !== "off"; } catch (e) {}
  var $ = function (s) { return document.querySelector(s); };
  // Zone language (Settings → Language): cfg.tr holds the translations, keyed by the English text.
  var LOC = cfg.locale || [], NUM = cfg.locale || "en-US";
  function t(s, v) { var x = (cfg.tr && cfg.tr[s]) || s; return v ? x.replace(/\{(\w+)\}/g, function (m, k) { return k in v ? v[k] : m; }) : x; }
  function tn(n, one, many, v) { var o = v || {}; o.n = n; return t(n === 1 ? one : many, o); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function api(path, opt) {
    var sep = path.indexOf("?") > -1 ? "&" : "?";
    var extra = cfg.qs ? sep + cfg.qs.slice(1) : "";
    return fetch("/zone/api/" + path + extra, opt).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error("auth"); }
      return r.json().then(function (j) { if (!r.ok || j.error) throw new Error(t(j.error || "Error")); return j; });
    });
  }
  function post(path, body) { return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  function waitFor(m) { return m < 60 ? t("{n} min", { n: m }) : t("{n} h", { n: Math.floor(m / 60) }); }
  function ago(iso) { var s = (Date.now() - Date.parse(iso)) / 1000; if (s < 60) return t("now"); if (s < 3600) return t("{n} min", { n: Math.floor(s / 60) }); if (s < 86400) return t("{n} h", { n: Math.floor(s / 3600) }); return new Date(iso).toLocaleDateString(LOC, { day: "numeric", month: "short" }); }
  function left(iso) {
    if (!iso) return { t: "", soon: false };
    var h = (Date.parse(iso) - Date.now()) / 3600000;
    if (h <= 0) return { t: t("Reply window closed"), soon: false };
    if (h < 1) return { t: t("{n} min left to reply", { n: Math.max(1, Math.round(h * 60)) }), soon: true };
    return { t: t("{n} h left to reply", { n: Math.floor(h) }), soon: h < 3 };
  }
  function clock(iso) { return new Date(iso).toLocaleString(LOC, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }

  // ---- sound + title badge
  function setSoundLabel() { $("#sound").innerHTML = soundOn ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16ZM10 21h4"/></svg><span class="sl">' + t("Sound on") + '</span>' : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 9.7-4.7M18 11v5l1.5 2H8M10 21h4M3 3l18 18"/></svg><span class="sl">' + t("Sound off") + '</span>'; $("#sound").title = soundOn ? t("Sound on") : t("Sound off"); }
  setSoundLabel();
  $("#sound").onclick = function () { soundOn = !soundOn; try { localStorage.setItem("talay-sound", soundOn ? "on" : "off"); } catch (e) {} setSoundLabel(); if (soundOn) beep(); };
  document.addEventListener("click", function () { if (!audio && window.AudioContext) { try { audio = new AudioContext(); } catch (e) {} } }, { once: true });
  function beep() {
    if (!soundOn || !audio) return;
    try {
      [0, 0.18].forEach(function (t) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
        g.gain.setValueAtTime(0.0001, audio.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.2, audio.currentTime + t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t + 0.15);
        o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.16);
      });
    } catch (e) {}
  }
  function badge(list) {
    var need = list.filter(function (c) { return c.needsYou || c.waitingMin > 0; });
    var n = need.length, el = $("#count");
    el.hidden = !n; el.textContent = n;
    document.title = (n ? "(" + n + ") " : "") + cfg.center + " · Talay";
    var ids = need.map(function (c) { return c.id; });
    if (needSeen && ids.some(function (id) { return needSeen.indexOf(id) < 0; })) beep();
    needSeen = ids;
  }

  // ---- tabs
  function setLang(l) { document.cookie = "talay-zone-lang=" + l + "; path=/zone; max-age=31536000; samesite=lax; secure"; location.reload(); }
  document.querySelectorAll(".chip.zl").forEach(function (zl) { zl.onclick = function () { if (zl.dataset.l !== cfg.lang) setLang(zl.dataset.l); }; });
  // A small dropdown in Talay style: opens under (or above) its button, arrow keys, Escape, click outside.
  function dropMenu(btn, menu, pick) {
    if (!btn || !menu) return;
    var close = function () { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
    btn.onclick = function (e) {
      e.stopPropagation();
      if (!menu.hidden) return close();
      menu.hidden = false; btn.setAttribute("aria-expanded", "true");
      var r = btn.getBoundingClientRect(), w = menu.offsetWidth, h = menu.offsetHeight;
      menu.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
      menu.style.top = (r.bottom + 6 + h < innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + "px";
      menu.style.minWidth = Math.max(200, r.width) + "px";
      (menu.querySelector("button.on") || menu.querySelector("button")).focus();
    };
    menu.querySelectorAll("button").forEach(function (b) { b.onclick = function () { close(); pick(b); }; });
    menu.onkeydown = function (e) {
      var bs = Array.prototype.slice.call(menu.querySelectorAll("button")), i = bs.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); bs[(i + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length].focus(); }
      if (e.key === "Escape" || e.key === "Tab") { close(); btn.focus(); }
    };
    document.addEventListener("click", function (e) { if (!menu.hidden && !menu.contains(e.target)) close(); });
    addEventListener("resize", close);
  }
  dropMenu($("#hlang"), $("#lmenu"), function (b) { if (b.dataset.l !== cfg.lang) setLang(b.dataset.l); });
  dropMenu($("#center"), $("#cmenu"), function (b) { if (!b.classList.contains("on")) location.href = "/zone?center=" + encodeURIComponent(b.dataset.c); });
  document.querySelectorAll("nav button").forEach(function (b) {
    b.onclick = function () {
      document.querySelectorAll("nav button").forEach(function (x) { x.classList.toggle("on", x === b); });
      document.querySelectorAll(".view").forEach(function (v) { v.classList.toggle("on", v.id === b.dataset.v); });
      if (b.dataset.v !== "convos") document.body.classList.remove("inchat");
      if (b.dataset.v === "dash") { loadDash(); loadStart(); }
      if (b.dataset.v === "today") loadToday();
      if (b.dataset.v === "books") loadBookings();
      if (b.dataset.v === "sett") { loadSettings(); try { localStorage.setItem("talay-seen-prices", "1"); } catch (e) {} }
      if (b.dataset.v === "supp") { tview = null; loadTickets(); }
    };
  });

  // ---- list
  document.querySelectorAll(".chip[data-f]").forEach(function (c) {
    c.onclick = function () {
      filter = c.dataset.f;
      document.querySelectorAll(".chip[data-f]").forEach(function (x) { x.classList.toggle("on", x === c); });
      lastList = ""; loadList();
    };
  });
  $("#search").oninput = function () { render(); };

  function loadList() {
    var view = filter === "open" || filter === "need" ? "open" : "all";
    var fr = freshList ? "&fresh=1" : ""; freshList = false;
    api("conversations?view=" + view + fr).then(function (d) {
      if (view === "open") badge(d.conversations);
      var key = view + JSON.stringify(d.conversations);
      var cur = current && d.conversations.filter(function (c) { return c.id === current; })[0];
      if (cur && chatSeenAt && cur.lastAt !== chatSeenAt) { freshNext = true; loadChat(false); }
      if (key === lastList) { tick(); return; }
      lastList = key; items = d.conversations; render();
    }).catch(function (e) { if (e.message !== "auth") $("#list").innerHTML = '<div class="empty">' + esc(e.message) + "</div>"; });
  }
  function render() {
    var term = ($("#search").value || "").trim().toLowerCase();
    var list = items.filter(function (c) {
      if (filter === "need" && !c.needsYou && !c.waitingMin) return false;
      if (filter === "booked" && !/booked/i.test(c.status)) return false;
      return !term || c.hay.indexOf(term) > -1;
    });
    var el = $("#list");
    if (!list.length) {
      var msg = term ? t("Nothing found for “{q}”.", { q: esc(term) })
        : filter === "need" ? t("Nothing waiting for your team. 🎉")
        : filter === "open" ? t("No open conversations right now. When a diver writes, it shows up here within a few seconds.")
        : t("No conversations in this view yet.");
      el.innerHTML = '<div class="empty">' + msg + "</div>"; return;
    }
    el.innerHTML = list.map(function (c) {
      var l = left(c.closesAt);
      var who = c.previewDir === "Customer" ? "" : (c.previewDir === "Team" ? t("You") + ": " : cfg.assistant + ": ");
      return '<button class="item' + (c.id === current ? " on" : "") + '" data-id="' + esc(c.id) + '" data-close="' + esc(c.closesAt || "") + '">' +
        avatar(c.name, c.cc) + '<div class="ib">' +
        '<div class="top"><span class="nm">' + esc(dname(c.name)) + "</span>" +
        '<span class="tm">' + ago(c.lastAt) + "</span></div>" +
        (c.waitingMin ? '<div class="tags"><span class="tag wait">' + t("Waiting {t}", { t: waitFor(c.waitingMin) }) + "</span></div>"
          : c.needsYou ? '<div class="tags"><span class="tag need">' + t("Needs you") + "</span></div>"
          : c.teamActive ? '<div class="tags"><span class="tag team"><svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg> ' + t("{a} paused", { a: esc(cfg.assistant) }) + "</span></div>" : "") +
        '<div class="pv">' + esc(who + c.preview) + "</div>" +
        (function () {
          var meta = [];
          if (/booked/i.test(c.status)) meta.push('<span class="bk">' + t("Booked") + "</span>");
          if (c.assigned) meta.push("→ " + esc(c.assigned === String(cfg.email || "").toLowerCase() ? t("You") : person(c.assigned)));
          return l.t || meta.length ? '<div class="meta">' + (l.t ? '<span class="left' + (l.soon ? " soon" : "") + '">' + l.t + "</span>" : "") + meta.map(function (m) { return "<span>" + m + "</span>"; }).join("") + "</div>" : "";
        })() + "</div></button>";
    }).join("");
    el.querySelectorAll(".item").forEach(function (b) { b.onclick = function () { openChat(b.dataset.id); }; });
  }
  function tick() {
    document.querySelectorAll(".item").forEach(function (b) {
      var l = left(b.dataset.close), el = b.querySelector(".left");
      if (el) { el.textContent = l.t; el.classList.toggle("soon", l.soon); }
    });
  }

  // ---- chat
  function openChat(id) {
    current = id; lastChat = ""; chatSeenAt = null;
    document.querySelectorAll(".item").forEach(function (b) { b.classList.toggle("on", b.dataset.id === id); });
    $("#convos").classList.add("open"); document.body.classList.add("inchat");
    $("#pane").innerHTML = '<div class="skel pad"><i></i><i></i><i></i></div>';
    loadChat(true);
  }
  function fact(label, v) { return v ? "<span>" + label + " <b>" + esc(v) + "</b></span>" : ""; }

  function loadChat(scroll) {
    if (!current) return;
    var id = current;
    var fr = freshNext ? "&fresh=1" : ""; freshNext = false;
    api("chat?c=" + encodeURIComponent(id) + fr).then(function (d) {
      if (id !== current) return;
      if (d.messages && d.messages.length) chatSeenAt = d.messages[d.messages.length - 1].at;
      var key = JSON.stringify([d.messages.length, d.canReply, d.needsYou, d.lead, d.bookings]);
      if (key === lastChat) return;
      var draft = $("#txt") ? $("#txt").value : "";
      var oldBox = $("#msgs"), keepTop = null;
      if (!scroll && oldBox && oldBox.scrollHeight - oldBox.scrollTop - oldBox.clientHeight > 120) keepTop = oldBox.scrollTop;
      lastChat = key;
      var L = d.lead, l = left(d.closesAt);
      var actions = "";
      if (d.hasLead && L.human) actions += '<button class="ghost hb" id="handback">▶ ' + t("Let {a} take over", { a: esc(cfg.assistant) }) + "</button>";
      if (d.hasLead && d.needsYou && !L.human) actions += '<button class="ghost" id="handled">' + t("Mark as handled") + "</button>";
      var facts = fact(t("Channel"), L.channel && L.channel !== "WhatsApp" ? L.channel : "") + fact(t("Language"), L.language && langName(L.language)) + fact(t("Level"), human(L.cert)) + fact(t("On the island"), prettyDates(L.dates)) +
        fact(t("Group"), L.group) + fact(t("Interested in"), /^rec[A-Za-z0-9]{14}$/.test(L.interested) ? "" : L.interested) + fact("WhatsApp", L.contact && L.name && L.contact !== L.name ? prettyPhone(L.contact) : "") +
        "";
      // While the team has the chat, Mia stays silent for this diver. "Talay - release handovers" (hourly)
      // gives it back 2 hours after the last team message; this banner keeps the early hand back in view.
      var paused = "";
      if (d.hasLead && L.human) {
        var lastTeamAt = 0;
        d.messages.forEach(function (m) { if (m.dir === "Team") lastTeamAt = Math.max(lastTeamAt, Date.parse(m.at) || 0); });
        var back = new Date(Math.ceil((Math.max(lastTeamAt, Date.parse(L.humanAt || 0) || 0, Date.now() - MIA_BACK_H * 3600e3) + MIA_BACK_H * 3600e3) / 3600e3) * 3600e3);
        paused = '<div class="paused"><span class="pi"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg></span><div class="pt"><b>' + t("{a} is paused for this diver", { a: esc(cfg.assistant) }) + "</b><span>" +
          t("Done helping? Give the chat back, so {a} answers the next question. Otherwise {a} only takes over again around {t}.", { a: esc(cfg.assistant), t: esc(back.toLocaleTimeString(LOC, { hour: "2-digit", minute: "2-digit" })) }) +
          '</span></div><button class="btn primary" id="handback2" type="button">▶ ' + t("Let {a} take over", { a: esc(cfg.assistant) }) + "</button></div>";
      }

      $("#pane").innerHTML =
        '<div class="head"><button class="back" aria-label="Back">‹</button>' + avatar(L.name || L.contact, d.cc) + '<div><b>' + esc(dname(L.name, L.contact)) + "</b>" +
        (l.t ? '<div class="sub">' + esc(l.t) + "</div>" : "") + "</div>" +
        (d.needsYou ? '<span class="tag need">' + t("Needs you") + "</span>" : "") +
        ((d.bookings || []).filter(function (b) { return !/cancel|refund/i.test(b.status); }).length > 1 ? '<span class="tag ret">' + t("Returning diver") + "</span>" : "") +
        '<div class="actions">' + actions + "</div></div>" +
        '<div class="cinfo">' + (facts ? '<div class="facts">' + facts + "</div>" : "") +
        (d.hasLead ? '<div class="teamrow"><button type="button" class="asg" id="assign" aria-haspopup="menu" aria-expanded="false" title="' + t("Assigned to") + '"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg><span id="asgName">' + esc(L.assigned ? (L.assigned === String(cfg.email || "").toLowerCase() ? t("You") : person(L.assigned)) : t("Not assigned")) + '</span><svg class="chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>' +
          '<button type="button" class="nbtn' + (L.note ? " has" : "") + '" id="nOpen"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>' + (L.note ? esc(L.note.length > 70 ? L.note.slice(0, 70) + "…" : L.note) : t("Add a team note")) + "</button>" +
          '<div class="nbox" id="nBox" hidden><textarea id="nTxt" rows="3" maxlength="2000" placeholder="' + t("Only your team sees this, never the diver. E.g. wants to be in the same group as her friend.") + '">' + esc(L.note) + '</textarea><div class="nact"><span class="nmsg" id="nMsg"></span><button type="button" class="ghost" id="nCancel">' + t("Cancel") + '</button><button type="button" class="btn primary" id="nSave">' + t("Save") + "</button></div></div></div>" : "") +
        bookingCard(d.bookings) + "</div>" +
        '<div class="msgs" id="msgs">' + (function () {
          var prevDay = "";
          return d.messages.map(function (m, idx) {
            var who = m.dir === "Customer" ? "" : (m.dir === "Team" ? t("Team") : cfg.assistant);
            var dt = new Date(m.at), day = dt.toLocaleDateString(LOC, { weekday: "long", day: "numeric", month: "long" });
            var sep = day !== prevDay ? '<div class="day">' + esc(day) + "</div>" : ""; prevDay = day;
            var rep = m.dir === "Mia" ? '<button class="rep" type="button" data-rep="' + idx + '" title="' + t("Report this answer to Talay") + '">' + t("Report") + "</button>" : "";
            var files = (m.files || []).map(function (f) {
              return /^image\//.test(f.type)
                ? '<a class="mimg" href="' + esc(f.url) + '" target="_blank" rel="noopener"><img src="' + esc(f.thumb || f.url) + '" alt="' + esc(f.name) + '" loading="lazy"></a>'
                : '<a class="mfile" href="' + esc(f.url) + '" target="_blank" rel="noopener">📎 ' + esc(f.name || t("File")) + "</a>";
            }).join("");
            var body = files && /^📎 /.test(m.text) ? "" : esc(m.text);
            return sep + '<div class="m ' + esc(m.dir) + '">' + (who ? '<span class="who">' + esc(who) + "</span>" : "") + files + body +
              "<small>" + esc(dt.toLocaleTimeString(LOC, { hour: "2-digit", minute: "2-digit" })) + rep + "</small></div>";
          }).join("");
        })() + "</div>" +
        paused + (d.canReply
          ? '<div class="composer">' +
            '<div class="pchips" id="pchips" hidden></div>' +
            '<div class="cbox"><textarea id="txt" placeholder="' + t("Reply on {ch}…", { ch: esc((L && L.channel) || "WhatsApp") }) + '" title="' + t("Enter sends · Shift + Enter for a new line · replying pauses {a} for this diver for 2 hours.", { a: esc(cfg.assistant) }) + '" rows="1"></textarea>' +
            '<button class="emo" id="att" type="button" title="' + t("Photo or file") + '" aria-label="' + t("Photo or file") + '"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9"/></svg></button><input type="file" id="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden>' +
            '<button class="emo" id="emo" type="button" title="' + t("Emoji") + '" aria-label="' + t("Emoji") + '" aria-expanded="false"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01"/></svg></button>' +
            '<button class="send" id="send" aria-label="Send"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div>' +
            '<div class="fchip" id="fchip" hidden></div>' +
            '<div class="epick" id="epick" hidden>' + EMOJI.map(function (x) { return '<button type="button">' + x + "</button>"; }).join("") + "</div>" +
            '<div class="cmeta"><label class="sig"><input type="checkbox" id="sigon"> ' + t("Signed as") + ' <input id="sig" maxlength="30" placeholder="' + t("your name") + '"></label>' +
            '<select id="prod" aria-label="' + t("Booking link") + '" hidden><option value="">' + t("+ Booking link…") + "</option></select>" +
            '<span class="sp"></span><span class="bt' + (l.soon ? " soon" : "") + '">' + esc(l.t) + "</span></div>" +
            '<div class="note" id="note"></div></div>'
          : '<div class="closed">' + t("More than 24 hours since the diver's last message, so WhatsApp, Instagram and Messenger no longer allow a free reply. Read only.") + "</div>");

      document.querySelectorAll("[data-rep]").forEach(function (b) {
        b.onclick = function () {
          var i = Number(b.dataset.rep), mia = d.messages[i], before = [];
          for (var j = i - 1; j >= 0 && before.length < 3; j--) if (d.messages[j].dir === "Customer") before.unshift(d.messages[j].text);
          var q = before.length ? before[before.length - 1] : "";
          newTicket({
            type: "Wrong answer", contact: d.id,
            title: t("Wrong answer") + (q ? ": " + q.slice(0, 60) : ""),
            context: (before.length ? t("Diver") + ":\n" + before.join("\n") + "\n\n" : "") + cfg.assistant + ":\n" + mia.text + "\n\n(" + clock(mia.at) + ", " + (L.name || L.contact || t("Diver")) + ")",
          });
        };
      });
      $(".back").onclick = function () { current = null; document.body.classList.remove("inchat"); $("#convos").classList.remove("open"); document.querySelectorAll(".item").forEach(function (b) { b.classList.remove("on"); }); };
      var box = $("#msgs");
      var place = function () { box.scrollTop = keepTop === null ? box.scrollHeight : keepTop; };
      place(); requestAnimationFrame(place); setTimeout(place, 250);
      if ($("#handback")) $("#handback").onclick = function () { act("handback", this); };
      if ($("#handback2")) $("#handback2").onclick = function () { act("handback", this); };
      if (d.hasLead) teamRow(d);
      if ($("#handled")) $("#handled").onclick = function () { act("handled", this); };
      if (d.canReply) {
        var tx = $("#txt"), s = $("#sig");
        tx.value = draft;
        if (pendingDraft) { tx.value = pendingDraft; pendingDraft = null; tx.focus(); }
        try { s.value = localStorage.getItem("talay-sig") || ""; } catch (e) {}
        if (!s.value && cfg.email) { var nm = String(cfg.email).split("@")[0].split(/[._-]/)[0]; if (nm && !/^(info|team|hello|contact|admin|dive|office)$/i.test(nm)) s.value = nm.charAt(0).toUpperCase() + nm.slice(1); }
        s.oninput = function () { try { localStorage.setItem("talay-sig", s.value); } catch (e) {} };
        // Sign only the team's first message in a chat by default; the box can be ticked for any message.
        var so = $("#sigon"); so.checked = !d.messages.some(function (m) { return m.dir === "Team"; });
        // Enter sends, Shift + Enter is a new line. On a phone the keyboard's return key stays a new line.
        var touch = matchMedia("(pointer:coarse)").matches;
        tx.onkeydown = function (e) { if (e.key === "Enter" && !e.isComposing && (e.metaKey || e.ctrlKey || (!touch && !e.shiftKey))) { e.preventDefault(); send(); } };
        var fi = $("#file"), fc = $("#fchip");
        $("#att").onclick = function () { fi.click(); };
        fi.onchange = function () { pickFile(fi.files && fi.files[0]); fi.value = ""; };
        tx.addEventListener("paste", function (e) {
          var it = e.clipboardData && Array.prototype.find.call(e.clipboardData.items || [], function (x) { return x.kind === "file"; });
          if (it) { e.preventDefault(); pickFile(it.getAsFile()); }
        });
        showFile();
        var eb = $("#emo"), ep = $("#epick");
        eb.onclick = function (e) { e.stopPropagation(); ep.hidden = !ep.hidden; eb.setAttribute("aria-expanded", String(!ep.hidden)); };
        ep.querySelectorAll("button").forEach(function (b) {
          b.onclick = function (e) {
            e.stopPropagation();
            var a = tx.selectionStart == null ? tx.value.length : tx.selectionStart, z = tx.selectionEnd == null ? a : tx.selectionEnd;
            tx.value = tx.value.slice(0, a) + b.textContent + tx.value.slice(z);
            tx.focus(); tx.selectionStart = tx.selectionEnd = a + b.textContent.length; grow();
          };
        });
        var grow = function () { tx.style.height = "auto"; tx.style.height = Math.min(tx.scrollHeight, 180) + "px"; };
        tx.addEventListener("input", grow); setTimeout(grow, 0);
        $("#send").onclick = send;
        loadProducts(id);
      }
    }).catch(function (e) { if (e.message !== "auth" && id === current) $("#pane").innerHTML = '<div class="placeholder">' + esc(e.message) + "</div>"; });
  }

  document.addEventListener("click", function (e) { var ep = $("#epick"), eb = $("#emo"); if (ep && !ep.hidden && !ep.contains(e.target) && !eb.contains(e.target)) { ep.hidden = true; eb.setAttribute("aria-expanded", "false"); } });
  var MIA_BACK_H = 2; // hours after the last team message; same as the formula in Make "Talay - release handovers"
  var EMOJI = ["😊", "🙂", "😄", "😉", "🙏", "👍", "👋", "🙌", "👌", "🎉", "❤️", "💙", "🤿", "🐠", "🐢", "🦈", "🐋", "🌊", "☀️", "🏝️", "⛵", "📅", "✅", "📍"];

  function loadProducts(id) {
    api("products?c=" + encodeURIComponent(id)).then(function (d) {
      var p = $("#prod"); if (!p || id !== current) return;
      d.products.forEach(function (x, i) {
        var o = document.createElement("option"); o.value = String(i);
        o.textContent = x.name + (x.price ? " · " + x.price.toLocaleString(NUM) + " THB" : ""); p.appendChild(o);
      });
      p.onchange = function () {
        var x = d.products[Number(p.value)]; p.value = ""; if (!x) return;
        var t = $("#txt"); t.value = (t.value.trim() ? t.value.trim() + "\n\n" : "") + x.text; t.focus();
      };
      var pc = $("#pchips");
      if (pc && d.products.length) {
        pc.innerHTML = '<span class="pcl"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>' + t("Send a booking link") + '</span><div class="pscroll">' + d.products.map(function (x, i) { return '<button type="button" class="pchip" data-pi="' + i + '">' + esc(x.name) + "</button>"; }).join("") + "</div>";
        pc.hidden = false;
        pc.querySelectorAll("[data-pi]").forEach(function (b) {
          b.onclick = function () { var x = d.products[Number(b.dataset.pi)]; var t = $("#txt"); t.value = (t.value.trim() ? t.value.trim() + "\n\n" : "") + x.text; t.focus(); };
        });
      }
    }).catch(function () { var p = $("#prod"); if (p) p.remove(); });
  }

  // Assign and team note (Leads → Assigned to, Team note), only for the team.
  var teamList = null;
  function person(e) { var n = String(e || "").split("@")[0].split(/[._+-]/)[0]; n = n.replace(/\d+$/, "") || n; return n ? n.charAt(0).toUpperCase() + n.slice(1) : e; }
  var amenu = document.createElement("div");
  amenu.className = "amenu"; amenu.id = "amenu"; amenu.setAttribute("role", "menu"); amenu.hidden = true;
  document.body.appendChild(amenu);
  function closeAssign() { amenu.hidden = true; var b = $("#assign"); if (b) b.setAttribute("aria-expanded", "false"); }
  document.addEventListener("click", function (e) { if (!amenu.hidden && !amenu.contains(e.target)) closeAssign(); });
  addEventListener("resize", closeAssign);
  amenu.onkeydown = function (e) {
    var bs = Array.prototype.slice.call(amenu.querySelectorAll("button")), i = bs.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); bs[(i + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length].focus(); }
    if (e.key === "Escape" || e.key === "Tab") { closeAssign(); var b = $("#assign"); if (b) b.focus(); }
  };
  function teamRow(d) {
    var L = d.lead, btn = $("#assign"), id = d.id, me = String(cfg.email || "").toLowerCase();
    var ck = '<svg class="ck" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7"/></svg>';
    var item = function (e, label, sub) {
      var on = e === (L.assigned || "");
      return '<button type="button" role="menuitemradio" aria-checked="' + on + '" data-e="' + esc(e) + '"' + (on ? ' class="on"' : "") + ">" +
        '<span class="av' + (e ? "" : " none") + '">' + (e ? esc(person(e).charAt(0)) : "–") + "</span>" +
        '<span class="who"><b>' + esc(label) + "</b>" + (sub ? "<small>" + esc(sub) + "</small>" : "") + "</span>" + ck + "</button>";
    };
    var fill = function () {
      var all = (teamList || []).slice();
      if (L.assigned && all.indexOf(L.assigned) < 0) all.push(L.assigned);
      all.sort(function (x, y) { return (y === me) - (x === me); });
      amenu.innerHTML = item("", t("Not assigned"), "") + all.map(function (e) { return item(e, e === me ? t("Me ({n})", { n: person(e) }) : person(e), e); }).join("");
      amenu.querySelectorAll("button").forEach(function (b) {
        b.onclick = function () {
          closeAssign();
          if (b.dataset.e === (L.assigned || "")) return;
          btn.disabled = true; $("#asgName").textContent = b.dataset.e ? (b.dataset.e === me ? t("You") : person(b.dataset.e)) : t("Not assigned");
          post("lead-team", { c: id, assign: b.dataset.e }).then(function () { lastChat = ""; lastList = ""; freshList = true; loadChat(false); loadList(); })
            .catch(function (e) { alert(e.message); lastChat = ""; loadChat(false); }).finally(function () { btn.disabled = false; });
        };
      });
    };
    var open = function () {
      fill();
      amenu.hidden = false; btn.setAttribute("aria-expanded", "true");
      var r = btn.getBoundingClientRect(), w = amenu.offsetWidth, h = amenu.offsetHeight;
      amenu.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + "px";
      amenu.style.top = (r.bottom + 6 + h < innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + "px";
      (amenu.querySelector("button.on") || amenu.querySelector("button")).focus();
    };
    closeAssign();
    btn.onclick = function (e) {
      e.stopPropagation();
      if (!amenu.hidden) return closeAssign();
      if (teamList) return open();
      api("settings").then(function (s) {
        var seen = {}; teamList = (s.admins || []).concat(s.staff || []).map(function (e) { return String(e).toLowerCase(); }).filter(function (e) { return e && !seen[e] && (seen[e] = 1); });
        if (id === current && $("#assign") === btn) open();
      }).catch(function () {});
    };
    var box = $("#nBox"), nt = $("#nTxt");
    $("#nOpen").onclick = function () { box.hidden = false; $("#nOpen").hidden = true; nt.focus(); };
    $("#nCancel").onclick = function () { box.hidden = true; $("#nOpen").hidden = false; nt.value = L.note; };
    $("#nSave").onclick = function () {
      var b = this; b.disabled = true; $("#nMsg").textContent = "";
      post("lead-team", { c: id, note: nt.value }).then(function () { lastChat = ""; loadChat(false); })
        .catch(function (e) { $("#nMsg").textContent = e.message; }).finally(function () { b.disabled = false; });
    };
  }

  function act(kind, btn) {
    btn.disabled = true;
    post(kind, { c: current }).then(function () { lastChat = ""; lastList = ""; freshNext = true; freshList = true; loadChat(false); loadList(); })
      .catch(function (e) { btn.disabled = false; alert(e.message); });
  }

  // A photo or PDF waiting to be sent with the next message ({ name, type, data (base64), url for the preview }).
  var pending = null;
  function showFile() {
    var fc = $("#fchip"); if (!fc) return;
    fc.hidden = !pending;
    if (!pending) { fc.innerHTML = ""; return; }
    fc.innerHTML = (/^image\//.test(pending.type) ? '<img src="' + pending.url + '" alt="">' : '<span class="fic">PDF</span>') +
      '<span class="fn">' + esc(pending.name) + '</span><button type="button" id="fx" aria-label="' + t("Remove") + '">×</button>';
    $("#fx").onclick = function () { pending = null; showFile(); };
  }
  function pickFile(f) {
    var n = $("#note");
    if (!f) return;
    if (!/^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/.test(f.type)) { n.textContent = t("Send a photo (JPG, PNG, WEBP) or a PDF."); n.className = "note err"; return; }
    var done = function (type, dataUrl, name) {
      var data = dataUrl.slice(dataUrl.indexOf(",") + 1);
      if (data.length > 5 * 1024 * 1024 * 4 / 3) { n.textContent = t("That file is too big (max 5 MB)."); n.className = "note err"; return; }
      pending = { name: name, type: type, data: data, url: dataUrl }; showFile(); $("#txt").focus();
    };
    if (f.type === "application/pdf") { var r = new FileReader(); r.onload = function () { done(f.type, r.result, f.name); }; r.readAsDataURL(f); return; }
    // Photos: at most 1600 px and JPEG, so a phone photo stays well under 5 MB and loads fast on WhatsApp.
    var img = new Image(), src = URL.createObjectURL(f);
    img.onload = function () {
      var k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(src);
      done("image/jpeg", c.toDataURL("image/jpeg", 0.85), String(f.name || "photo").replace(/\.\w+$/, "") + ".jpg");
    };
    img.onerror = function () { n.textContent = t("Send a photo (JPG, PNG, WEBP) or a PDF."); n.className = "note err"; };
    img.src = src;
  }
  function send() {
    var t = $("#txt"), b = $("#send"), n = $("#note"), v = t.value.trim();
    if ((!v && !pending) || b.disabled) return;
    var sig = ($("#sig").value || "").trim(); if (v && sig && $("#sigon").checked) v += "\n– " + sig;
    b.disabled = true; b.classList.add("busy");
    var body = { c: current, text: v };
    if (pending) body.file = { name: pending.name, type: pending.type, data: pending.data };
    post("reply", body).then(function () {
      t.value = ""; pending = null; lastChat = ""; lastList = ""; freshNext = true; freshList = true; loadChat(true); loadList();
    }).catch(function (e) { n.textContent = e.message; n.className = "note err"; })
      .finally(function () { b.disabled = false; b.classList.remove("busy"); });
  }


  // ---- bookings
  var bdata = null, brange = "today";
  function thb(n) { return Math.round(n).toLocaleString(NUM) + " THB"; }
  function dayLabel(iso) { return new Date(iso + "T12:00:00Z").toLocaleDateString(LOC, { weekday: "long", day: "numeric", month: "long" }); }
  function addDays(iso, n) { var d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  document.querySelectorAll(".chip[data-r]").forEach(function (c) {
    c.onclick = function () {
      brange = c.dataset.r;
      document.querySelectorAll(".chip[data-r]").forEach(function (x) { x.classList.toggle("on", x === c); });
      renderBookings();
      if (brange === "unfinished") loadUnfinished();
      if (brange === "arriving") loadArriving();
    };
  });
  $("#print").onclick = function () { window.print(); };
  function loadBookings() {
    api("bookings").then(function (d) { bdata = d; renderBookings(); })
      .catch(function (e) { if (e.message !== "auth") $("#blist").innerHTML = '<div class="bempty">' + esc(e.message) + "</div>"; });
  }
  function isCx(b) { return /cancel|refund/i.test(b.status); }
  function stTag(b) {
    var s = b.status || "Confirmed", cls = isCx(b) ? "cx" : (/move/i.test(s) ? "mv" : "ok");
    return '<span class="st ' + cls + '">' + esc(t(s)) + (b.late ? " · " + t("late") : "") + "</span>";
  }
  var tr = t; // renderBookings uses t for today's date
  function renderBookings() {
    if (brange === "unfinished") { renderUnfinished(); return; }
    if (brange === "arriving") { renderArriving(); return; }
    if (brange === "calendar") { renderCalendar(); return; }
    if (!bdata) return;
    var td = bdata.today, list = bdata.bookings.filter(function (b) {
      if (brange === "today") return b.date === td;
      if (brange === "tomorrow") return b.date === bdata.tomorrow;
      if (brange === "next") return b.date >= td && b.date <= addDays(td, 30);
      return b.date < td && b.date >= addDays(td, -30);
    });
    if (brange === "past") list.reverse();
    var live = list.filter(function (b) { return !isCx(b); });
    var sum = function (k) { return live.reduce(function (a, b) { return a + b[k]; }, 0); };
    $("#bcards").innerHTML =
      '<div class="cardn"><small>' + t("Divers") + "</small><b>" + sum("divers") + "</b></div>" +
      '<div class="cardn"><small>' + t("Bookings") + "</small><b>" + live.length + "</b></div>" +
      '<div class="cardn"><small>' + (brange === "past" ? t("Collected at the shop") : t("To collect at the shop")) + "</small><b>" + thb(sum("balance")) + "</b></div>" +
      '<div class="cardn"><small>' + t("Paid online") + "</small><b>" + thb(sum("deposit")) + "</b></div>";
    if (!list.length) {
      $("#blist").innerHTML = '<div class="bempty">' + (brange === "today" ? t("No bookings via {a} for today.", { a: esc(cfg.assistant) }) :
        brange === "tomorrow" ? t("No bookings via {a} for tomorrow yet.", { a: esc(cfg.assistant) }) : t("No bookings in this period.")) + "</div>";
      return;
    }
    var html = "", days = {};
    list.forEach(function (b) { (days[b.date] = days[b.date] || []).push(b); });
    Object.keys(days).forEach(function (day) {
      var rows = days[day], dl = rows.filter(function (b) { return !isCx(b); });
      var divers = dl.reduce(function (a, b) { return a + b.divers; }, 0);
      html += '<div class="dayh">' + esc(dayLabel(day)) + "<span>" + tn(divers, "1 diver", "{n} divers") + " · " +
        tn(dl.length, "1 booking", "{n} bookings") + "</span></div>";
      var prods = {};
      rows.forEach(function (b) { var pk = b.product || t("Other"); (prods[pk] = prods[pk] || []).push(b); });
      // One table per day with the products as group rows, so the columns line up.
      html += '<div class="bscroll"><table class="btable bday"><thead><tr>' +
        "<th>" + t("Name") + "</th><th>" + t("Phone") + '</th><th class="num">' + t("Divers") + '</th><th class="num">' + t("Paid online") + '</th><th class="num">' + t("At the shop") + "</th><th>" + t("Status") + '</th><th class="noprint"></th></tr></thead><tbody>';
      Object.keys(prods).forEach(function (p) {
        var pd = prods[p].filter(function (b) { return !isCx(b); }).reduce(function (a, b) { return a + b.divers; }, 0);
        html += '<tr class="grp"><td colspan="7">' + esc(p) + "<span>" + tn(pd, "1 diver", "{n} divers") + "</span></td></tr>" +
          prods[p].map(function (b) {
            var links = [];
            if (b.chat) links.push('<a href="#" data-chat="' + esc(b.chat) + '">' + tr("Chat") + "</a>");
            if (b.manage && !isCx(b) && b.date >= td) links.push('<a href="' + esc(b.manage) + '" target="_blank" rel="noopener">' + tr("Move / cancel") + "</a>");
            var wa = b.phone ? '<a class="tel" href="https://wa.me/' + esc(b.phone.replace(/[^0-9]/g, "")) + '" target="_blank" rel="noopener">' + esc(b.phone) + "</a>" : "";
            return '<tr class="' + (isCx(b) ? "cx" : "") + '"><td data-l="' + tr("Name") + '" class="tname">' + esc(b.name) + '<small class="ref">' + esc(b.ref) + '</small></td><td data-l="' + tr("Phone") + '">' + wa + '</td><td class="num" data-l="' + tr("Divers") + '">' + b.divers +
              '</td><td class="num" data-l="' + tr("Paid online") + '">' + thb(b.deposit) + '</td><td class="num" data-l="' + tr("At the shop") + '">' + (isCx(b) ? "–" : thb(b.balance)) + '</td><td class="keep" data-l="' + tr("Status") + '">' + stTag(b) +
              (b.refunded ? "<br><small>" + tr("Refunded {x}", { x: thb(b.refunded) }) + "</small>" : "") + '</td><td class="keep noprint tlinks">' + links.join(" ") + "</td></tr>";
          }).join("");
      });
      html += "</tbody></table></div>";
    });
    $("#blist").innerHTML = html;
    $("#blist").querySelectorAll("[data-chat]").forEach(function (a) {
      a.onclick = function (e) {
        e.preventDefault();
        document.querySelector('nav button[data-v="convos"]').click();
        var all = document.querySelector('.chip[data-f="all"]'); if (all && filter === "open") all.click();
        openChat(a.dataset.chat);
      };
    });
  }
  setInterval(function () { if (!document.hidden && $("#books").classList.contains("on")) loadBookings(); }, 60000);

  // ---- settings
  var sdata = null, ME = cfg.email;
  function say(id, text, err) { var el = $(id); el.textContent = text; el.className = "smsg" + (err ? " err" : ""); if (!err && text) setTimeout(function () { if (el.textContent === text) el.textContent = ""; }, 4000); }
  function save(body, msgId, okText, btn) {
    if (btn) btn.disabled = true;
    return post("settings", body).then(function () { say(msgId, okText); return loadSettings(); })
      .catch(function (e) { say(msgId, e.message, true); })
      .finally(function () { if (btn) btn.disabled = false; });
  }
  var ROLE_T = { Owner: t("Owner"), Office: t("Office"), Instructor: t("Instructor") };
  var TOPIC_T = [["Needs you", t("A conversation needs the team")], ["Bookings", t("New bookings")], ["Morning summary", t("Morning summary")], ["Escalation", t("Still waiting after 30 minutes")]];
  var CHAN_T = [["WhatsApp", "WhatsApp"], ["Push", t("Push on the phone")], ["Email", t("Email")]];
  var NLANG = ["EN", "FR", "ES", "DE", "NL", "TH"];
  function removeMember(e) {
    if (!confirm(t("Remove {e}? They can no longer sign in.", { e: e }))) return;
    save({ action: "team", emails: sdata.staff.filter(function (x) { return x !== e; }) }, "#tMsg", t("Removed."));
  }
  function renderTeam(d) {
    var list = d.team || d.staff.map(function (e) { return { email: e, simple: true }; });
    $("#team").innerHTML = list.map(function (p, i) {
      var nm = p.name || p.email, gets = p.active && p.channels.length && p.topics.length ? t("Notifications via {x}", { x: p.channels.map(function (c) { return c === "Push" ? "Push" : c === "Email" ? t("Email") : c; }).join(", ") }) : (p.simple ? "" : t("No notifications"));
      return '<li data-i="' + i + '"><span class="av">' + esc(nm.charAt(0).toUpperCase()) + '</span><div class="pmi"><div class="pmn"><b>' + esc(nm) + "</b>" +
        (p.role ? '<span class="prole">' + esc(ROLE_T[p.role] || p.role) + "</span>" : "") + (p.email === ME ? " <small>(" + t("you") + ")</small>" : "") + "</div>" +
        '<div class="pms">' + [p.name ? esc(p.email) : "", p.whatsapp ? esc(p.whatsapp) : "", gets].filter(Boolean).join(" · ") + "</div></div>" +
        (p.simple ? "" : '<button type="button" class="ped">' + t("Edit") + "</button>") +
        (p.email === ME ? "" : '<button type="button" class="prm">' + t("Remove") + "</button>") + "</li>";
    }).join("");
    $("#team").querySelectorAll("li").forEach(function (li) {
      var p = list[Number(li.dataset.i)];
      var rm = li.querySelector(".prm"); if (rm) rm.onclick = function () { removeMember(p.email); };
      var ed = li.querySelector(".ped"); if (ed) ed.onclick = function () { editMember(li, p); };
    });
  }
  function chipRow(name, opts, on, multi) {
    return '<div class="chips pchips" data-n="' + name + '"' + (multi ? ' data-multi="1"' : "") + ">" + opts.map(function (o) {
      return '<button type="button" class="chip' + ((multi ? on.indexOf(o[0]) > -1 : on === o[0]) ? " on" : "") + '" data-v="' + esc(o[0]) + '">' + esc(o[1]) + "</button>";
    }).join("") + "</div>";
  }
  function editMember(li, p) {
    var open = document.querySelector("#team .pedit"); if (open) open.remove();
    var f = document.createElement("div"); f.className = "pedit";
    var on = p.id ? p : { topics: ["Needs you", "Bookings", "Morning summary"], channels: ["WhatsApp", "Push"], evenings: false, role: "", language: "" };
    f.innerHTML = '<div class="pgrid"><label>' + t("Name") + '<input type="text" class="pn" maxlength="80" value="' + esc(p.name || "") + '"></label>' +
      '<label>' + t("WhatsApp number") + '<input type="tel" class="pw" placeholder="+66 81 234 5678" value="' + esc(p.whatsapp || "") + '"></label></div>' +
      '<div class="plab">' + t("Role") + "</div>" + chipRow("role", [["Owner", t("Owner")], ["Office", t("Office")], ["Instructor", t("Instructor")]], on.role, false) +
      '<div class="plab">' + t("Language of the notifications") + "</div>" + chipRow("language", NLANG.map(function (l) { return [l, l]; }), on.language || "EN", false) +
      '<div class="plab">' + t("Notifications") + "</div>" + chipRow("topics", TOPIC_T, on.topics, true) +
      '<div class="plab">' + t("Via") + "</div>" + chipRow("channels", CHAN_T, on.channels, true) +
      '<label class="pev"><input type="checkbox" class="pe"' + (on.evenings ? " checked" : "") + "> " + t("Also in the evening and at night") + "</label>" +
      '<div class="pact"><button type="button" class="btn psv">' + t("Save") + '</button><button type="button" class="ghost pcx">' + t("Cancel") + "</button></div>";
    li.after(f);
    f.querySelectorAll(".pchips").forEach(function (row) {
      row.querySelectorAll(".chip").forEach(function (c) {
        c.onclick = function () {
          if (row.dataset.multi) c.classList.toggle("on");
          else row.querySelectorAll(".chip").forEach(function (x) { x.classList.toggle("on", x === c && !(x.classList.contains("on") && row.dataset.n === "role")); });
        };
      });
    });
    var val = function (n) { var r = f.querySelector('[data-n="' + n + '"]'); return [].map.call(r.querySelectorAll(".chip.on"), function (c) { return c.dataset.v; }); };
    f.querySelector(".pcx").onclick = function () { f.remove(); };
    f.querySelector(".psv").onclick = function () {
      save({ action: "member", email: p.email, name: f.querySelector(".pn").value, whatsapp: f.querySelector(".pw").value,
        role: val("role")[0] || "", language: val("language")[0] || "EN", topics: val("topics"), channels: val("channels"),
        evenings: f.querySelector(".pe").checked, active: true }, "#tMsg", t("Saved."), this);
    };
    f.querySelector(".pn").focus();
  }
  function loadSettings() {
    return api("settings").then(function (d) {
      sdata = d;
      $("#adminNote").hidden = d.admin;
      document.querySelectorAll(".scard.adm").forEach(function (c) { c.classList.toggle("ro", !d.admin); });
      $("#prods").innerHTML = d.products.map(function (p) {
        var hours = ""; for (var h = 8; h <= 22; h++) hours += '<option value="' + h + '"' + (h === p.cutoff ? " selected" : "") + ">" + h + ":00</option>";
        return '<tr class="' + (p.active ? "" : "off") + '" data-id="' + esc(p.id) + '" data-pct="' + p.pct + '"><td class="nm">' + esc(p.name) + '<br><span class="muted">' + esc(p.code) + "</span></td>" +
          '<td data-l="' + t("Price (THB)") + '"><input type="number" min="100" step="50" value="' + p.price + '" class="pp" inputmode="numeric"></td>' +
          '<td class="muted dep" data-l="' + t("Deposit") + '">' + Math.round(p.deposit).toLocaleString(NUM) + " THB · " + p.pct + "%</td>" +
          '<td data-l="' + t("Book until (day before)") + '"><select class="pc">' + hours + "</select></td>" +
          '<td data-l="' + t("Bookable online") + '"><input type="checkbox" class="pa"' + (p.active ? " checked" : "") + "></td>" +
          '<td class="tlinks"><button class="btn ps" type="button" hidden>' + t("Save") + '</button></td></tr>';
      }).join("");
      $("#prods").querySelectorAll("tr").forEach(function (tr) {
        var pp = tr.querySelector(".pp"), changed = function () { tr.querySelector(".ps").hidden = false; };
        tr.querySelector(".pc").onchange = changed; tr.querySelector(".pa").onchange = changed;
        pp.oninput = function () { tr.querySelector(".dep").innerHTML = Math.round((Number(pp.value) || 0) * Number(tr.dataset.pct) / 100).toLocaleString(NUM) + " THB · " + tr.dataset.pct + "%"; changed(); };
        tr.querySelector(".ps").onclick = function () {
          var btn = this, name = tr.querySelector(".nm").firstChild.textContent;
          save({ action: "product", id: tr.dataset.id, price: Number(pp.value), cutoff: Number(tr.querySelector(".pc").value), active: tr.querySelector(".pa").checked },
            "#pMsg", t("{x} saved.", { x: name }), btn);
        };
      });
      $("#miaState").textContent = d.paused ? t("Paused") : t("Answering divers");
      $("#miaState").className = "pill " + (d.paused ? "off" : "on");
      $("#miaToggle").textContent = d.paused ? t("Turn {a} back on", { a: cfg.assistant }) : t("Pause {a}", { a: cfg.assistant });
      $("#hFrom").value = d.from; $("#hTo").value = d.to;
      $("#modeState").textContent = d.outsideOnly ? t("Only outside office hours") : t("Day and night");
      $("#modeState").className = "pill " + (d.outsideOnly ? "off" : "on");
      $("#modeToggle").textContent = d.outsideOnly ? t("Answer day and night") : t("Answer only outside office hours");
      if (document.activeElement !== $("#aEmail")) $("#aEmail").value = d.alert;
      renderTeam(d);
      var I = d.info, rows = [[t("Assistant"), I.assistant], [t("Languages"), I.languages], [t("Meeting point"), I.meeting], [t("Dive sites"), I.sites], [t("Boat times"), I.boats], [t("Emergency phone"), I.emergency]];
      $("#info").innerHTML = rows.filter(function (r) { return r[1]; }).map(function (r) { return "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>"; }).join("");
    }).catch(function (e) { if (e.message !== "auth") say("#miaMsg", e.message, true); });
  }
  $("#miaToggle").onclick = function () {
    if (!sdata) return;
    var pause = !sdata.paused;
    if (pause && !confirm(t("Pause {a} for every diver? Your team then answers all messages.", { a: cfg.assistant }))) return;
    save({ action: "mia", paused: pause }, "#miaMsg", pause ? t("{a} is paused.", { a: cfg.assistant }) : t("{a} is answering again.", { a: cfg.assistant }), this);
  };
  $("#modeToggle").onclick = function () {
    if (!sdata) return;
    var only = !sdata.outsideOnly;
    save({ action: "mode", outsideOnly: only }, "#modeMsg", only ? t("{a} now only answers outside office hours.", { a: cfg.assistant }) : t("{a} answers day and night again.", { a: cfg.assistant }), this);
  };
  $("#hSave").onclick = function () { save({ action: "hours", from: $("#hFrom").value, to: $("#hTo").value }, "#hMsg", t("Saved in all five languages."), this); };
  $("#aSave").onclick = function () { save({ action: "alert", email: $("#aEmail").value }, "#aMsg", t("Saved."), this); };
  $("#tAdd").onclick = function () {
    var e = ($("#tEmail").value || "").trim().toLowerCase(); if (!e || !sdata) return;
    if (sdata.staff.indexOf(e) > -1) { say("#tMsg", t("Already in the team."), true); return; }
    var btn = this;
    save({ action: "team", emails: sdata.staff.concat([e]) }, "#tMsg", t("{e} can now sign in.", { e: e }), btn).then(function () {
      $("#tEmail").value = "";
      var li = [].find.call(document.querySelectorAll("#team li"), function (x) { return x.querySelector(".pms, .pmn") && x.textContent.indexOf(e) > -1; });
      var ed = li && li.querySelector(".ped"); if (ed) ed.click();
    });
  };

  // ---- unfinished bookings
  var udata = null, pendingDraft = null;
  function loadUnfinished() {
    return api("unfinished").then(function (d) {
      udata = d; var n = d.items.filter(function (i) { return !i.booked; }).length, el = $("#ucount");
      el.hidden = !n; el.textContent = n;
      if (brange === "unfinished") renderUnfinished();
    }).catch(function (e) { if (brange === "unfinished" && e.message !== "auth") $("#blist").innerHTML = '<div class="bempty">' + esc(e.message) + "</div>"; });
  }
  function renderUnfinished() {
    if (!udata) { $("#bcards").innerHTML = ""; $("#blist").innerHTML = '<div class="skel"><i></i><i></i><i></i></div>'; return; }
    var list = udata.items;
    var value = list.reduce(function (a, i) { return a + i.total; }, 0);
    $("#bcards").innerHTML =
      '<div class="cardn"><small>' + t("Started, not paid (7 days)") + "</small><b>" + list.length + "</b></div>" +
      '<div class="cardn"><small>' + t("Divers") + "</small><b>" + list.reduce(function (a, i) { return a + i.divers; }, 0) + "</b></div>" +
      '<div class="cardn"><small>' + t("Value still open") + "</small><b>" + thb(value) + "</b></div>";
    if (!list.length) { $("#blist").innerHTML = '<div class="bempty">' + t("Nobody left the payment page in the last 7 days. 🎉") + "</div>"; return; }
    $("#blist").innerHTML = '<p class="d" style="color:var(--muted);font-size:14px;margin:0 0 10px">' + t("These divers chose a date and went to the payment page, but didn't pay. A friendly reminder often brings them back.") + "</p>" +
      '<div class="bscroll"><table class="btable"><thead><tr><th>' + t("Diver") + "</th><th>" + t("Product") + "</th><th>" + t("For") + '</th><th class="num">' + t("Divers") + '</th><th class="num">' + t("Value") + "</th><th>" + t("Left") + '</th><th class="noprint"></th></tr></thead><tbody>' +
      list.map(function (i, k) {
        var who = esc(i.name || i.phone || t("Unknown diver")) + (i.phone && i.name !== i.phone ? '<br><small style="color:var(--muted)">' + esc(i.phone) + "</small>" : "");
        var act = [];
        if (i.booked) act.push('<span class="st ok">' + t("Booked since") + "</span>");
        else if (i.chat && i.canMessage) act.push('<a href="#" data-remind="' + k + '">' + t("Send reminder") + "</a>");
        else act.push('<span class="st">' + t("No chat linked") + "</span>");
        if (i.chat) act.push('<a href="#" data-uchat="' + k + '">' + t("Chat") + "</a>");
        return '<tr><td class="tname" data-l="' + t("Diver") + '">' + who + '</td><td data-l="' + t("Product") + '">' + esc(i.product) + '</td><td data-l="' + t("For") + '">' + esc(dayLabel(i.date)) + '</td><td class="num" data-l="' + t("Divers") + '">' + i.divers +
          '</td><td class="num" data-l="' + t("Value") + '">' + thb(i.total) + '</td><td data-l="' + t("Left") + '">' + (ago(i.at) === t("now") ? t("just now") : t("{t} ago", { t: ago(i.at) })) + '</td><td class="keep noprint tlinks">' + act.join(" ") + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      '<p style="color:var(--muted);font-size:13px">' + t("WhatsApp, Instagram and Messenger only allow a free message within 24 hours of the diver's last message, so older ones can't get a reminder from here.") + "</p>";
    function go(k, draft) {
      var i = udata.items[k]; pendingDraft = draft ? i.reminder : null;
      document.querySelector('nav button[data-v="convos"]').click();
      var all = document.querySelector('.chip[data-f="all"]'); if (all && filter === "open") all.click();
      openChat(i.chat);
    }
    $("#blist").querySelectorAll("[data-remind]").forEach(function (a) { a.onclick = function (e) { e.preventDefault(); go(Number(a.dataset.remind), true); }; });
    $("#blist").querySelectorAll("[data-uchat]").forEach(function (a) { a.onclick = function (e) { e.preventDefault(); go(Number(a.dataset.uchat), false); }; });
  }
  loadUnfinished();
  setInterval(function () { if (!document.hidden && $("#books").classList.contains("on")) loadUnfinished(); }, 300000);

  // ---- arriving soon, not booked yet
  var adata = null;
  function loadArriving() {
    return api("arriving").then(function (d) {
      adata = d; var el = $("#acount"); el.hidden = !d.items.length; el.textContent = d.items.length;
      if (brange === "arriving") renderArriving();
    }).catch(function (e) { if (brange === "arriving" && e.message !== "auth") $("#blist").innerHTML = '<div class="bempty">' + esc(e.message) + "</div>"; });
  }
  function shortDay(iso) { return new Date(iso + "T12:00:00Z").toLocaleDateString(LOC, { weekday: "short", day: "numeric", month: "short" }); }
  function whenText(i) {
    if (i.here) return t("On the island now");
    var days = Math.round((Date.parse(i.from) - Date.parse(adata.today)) / 86400000);
    return days === 1 ? t("Arrives tomorrow") : t("Arrives in {n} days", { n: days });
  }
  function renderArriving() {
    if (!adata) { $("#bcards").innerHTML = ""; $("#blist").innerHTML = '<div class="skel"><i></i><i></i><i></i></div>'; return; }
    var list = adata.items;
    var divers = list.reduce(function (a, i) { return a + (Number(i.group) || 1); }, 0);
    $("#bcards").innerHTML =
      '<div class="cardn"><small>' + t("Not booked yet") + "</small><b>" + list.length + "</b></div>" +
      '<div class="cardn"><small>' + t("Divers") + "</small><b>" + divers + "</b></div>" +
      '<div class="cardn"><small>' + t("On the island now") + "</small><b>" + list.filter(function (i) { return i.here; }).length + "</b></div>";
    if (!list.length) { $("#blist").innerHTML = '<div class="bempty">' + t("Nobody without a booking arrives in the next 14 days.") + "</div>"; return; }
    $("#blist").innerHTML = '<p class="d" style="color:var(--muted);font-size:14px;margin:0 0 10px">' + t("These divers told {a} when they're on the island, but haven't booked yet. A personal message now often makes the difference.", { a: esc(cfg.assistant) }) + "</p>" +
      '<div class="bscroll"><table class="btable"><thead><tr><th>' + t("Diver") + "</th><th>" + t("When") + "</th><th>" + t("Interested in") + "</th><th>" + t("Level") + '</th><th class="num">' + t("Group") + '</th><th class="noprint"></th></tr></thead><tbody>' +
      list.map(function (i, k) {
        var who = esc(i.name || i.phone || t("Unknown diver"));
        var when = esc(whenText(i)) + '<br><small style="color:var(--muted)">' + esc(shortDay(i.from)) + " – " + esc(shortDay(i.to)) + "</small>";
        var act = [];
        if (i.chat && i.canMessage) act.push('<a href="#" data-amsg="' + k + '">' + t("Send a message") + "</a>");
        if (i.chat) act.push('<a href="#" data-achat="' + k + '">' + t("Chat") + "</a>");
        else if (i.phone) act.push(esc(i.phone));
        return '<tr><td class="tname" data-l="' + t("Diver") + '">' + who + '</td><td data-l="' + t("When") + '">' + when + '</td><td data-l="' + t("Interested in") + '">' + esc(i.interested || "–") +
          '</td><td data-l="' + t("Level") + '">' + esc(human(i.cert) || "–") + '</td><td class="num" data-l="' + t("Group") + '">' + esc(i.group || "1") + '</td><td class="keep noprint tlinks">' + act.join(" ") + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      '<p style="color:var(--muted);font-size:13px">' + t("WhatsApp, Instagram and Messenger only allow a free message within 24 hours of the diver's last message. For the others, message them from your own app.") + "</p>";
    function go(k, draft) {
      var i = adata.items[k];
      var first = String(i.name || "").split(" ")[0];
      pendingDraft = draft ? "Hi" + (first ? " " + first : "") + "! Looking forward to seeing you on Koh Tao" + (i.here ? "" : " from " + shortDay(i.from)) + ". Shall we reserve your " + (i.interested || "dives") + " now? Then your spot is guaranteed." : null;
      document.querySelector('nav button[data-v="convos"]').click();
      var all = document.querySelector('.chip[data-f="all"]'); if (all && filter === "open") all.click();
      openChat(i.chat);
    }
    $("#blist").querySelectorAll("[data-amsg]").forEach(function (a) { a.onclick = function (e) { e.preventDefault(); go(Number(a.dataset.amsg), true); }; });
    $("#blist").querySelectorAll("[data-achat]").forEach(function (a) { a.onclick = function (e) { e.preventDefault(); go(Number(a.dataset.achat), false); }; });
  }
  loadArriving();
  setInterval(function () { if (!document.hidden && $("#books").classList.contains("on")) loadArriving(); }, 600000);

  // ---- dashboard
  var ddata = null;
  function fmtSec(s) { if (s == null) return "–"; if (s < 60) return t("{n} s", { n: s }); return t("{m} min {s} s", { m: Math.floor(s / 60), s: s % 60 }); }
  function pct(a, b) { return b ? Math.round(a / b * 100) + "%" : "–"; }
  $("#period").onchange = function () { loadDash(); };
  // ---- Push notifications on this device
  (function () {
    var state = $("#pushState"), on = $("#pushOn"), test = $("#pushTest"), off = $("#pushOff"), msg = $("#pushMsg");
    if (!state) return;
    var supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    function show(t, err) { msg.textContent = t || ""; msg.classList.toggle("err", !!err); }
    function urlKey(b) { var s = b.replace(/-/g, "+").replace(/_/g, "/"); s += "===".slice((s.length + 3) % 4); var r = atob(s), a = new Uint8Array(r.length); for (var i = 0; i < r.length; i++) a[i] = r.charCodeAt(i); return a; }
    function setUi(active) {
      state.textContent = active ? t("On for this device") : (supported ? t("Off") : t("Not available here"));
      state.classList.toggle("on", !!active);
      on.hidden = !!active || !supported; test.hidden = !active; off.hidden = !active;
    }
    if (!supported) {
      setUi(false);
      show(/iPhone|iPad/.test(navigator.userAgent) ? t("On iPhone: add the zone to your home screen first (Share → Add to Home Screen), then open it from there.") : t("This browser doesn't support notifications."), false);
      return;
    }
    setUi(false);
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (s) { setUi(!!s && Notification.permission === "granted"); }).catch(function () { setUi(false); });
    on.onclick = function () {
      show("");
      on.disabled = true;
      Notification.requestPermission().then(function (perm) {
        if (perm !== "granted") throw new Error(t("Notifications are blocked. Allow them for talay.io in your browser or phone settings."));
        return api("push-key");
      }).then(function (d) {
        if (!d.key) throw new Error(t("Notifications are not set up yet. Contact Talay."));
        return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(d.key) }); });
      }).then(function (sub) {
        return post("push-subscribe", { endpoint: sub.endpoint });
      }).then(function () { setUi(true); show(t("Done. Tap “Send a test” to check.")); })
        .catch(function (e) { show(e.message || t("Something went wrong. Try again."), true); })
        .then(function () { on.disabled = false; });
    };
    test.onclick = function () {
      show(t("Sending…"));
      post("push-test", {}).then(function () { show(t("Sent. It can take a few seconds.")); }).catch(function (e) { show(e.message, true); });
    };
    off.onclick = function () {
      navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (s) {
        if (!s) return;
        var ep = s.endpoint;
        return s.unsubscribe().then(function () { return post("push-unsubscribe", { endpoint: ep }); });
      }).then(function () { setUi(false); show(t("Turned off for this device.")); }).catch(function (e) { show(e.message, true); });
    };
  })();

  // ---- The diver's bookings, shown in the conversation
  function bookingCard(list) {
    list = list || [];
    if (!list.length) return "";
    var today = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
    var cx = function (b) { return /cancel|refund/i.test(b.status); };
    var up = list.filter(function (b) { return b.date >= today && !cx(b); }).sort(function (a, b) { return a.date.localeCompare(b.date); });
    var past = list.filter(function (b) { return up.indexOf(b) < 0; });
    var fmt = function (iso) { return new Date(iso + "T12:00:00Z").toLocaleDateString(LOC, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }); };
    var money = function (v) { return Math.round(v).toLocaleString(NUM) + " THB"; };
    var ico = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
    var card = function (b) {
      var days = Math.round((Date.parse(b.date) - Date.parse(today)) / 86400000);
      var when = days === 0 ? t("Today") : days === 1 ? t("Tomorrow") : t("In {n} days", { n: days });
      return '<div class="bkc"><span class="bki">' + ico + '</span><div class="bkb"><b>' + esc(b.product) + " · " + esc(fmt(b.date)) + " · " + tn(b.divers, "1 diver", "{n} divers") +
        "</b><small>" + t("{d} paid online · {b} at the shop", { d: money(b.deposit), b: money(b.balance) }) + " · " + esc(b.ref) + '</small></div><span class="bkw">' + when + "</span>" +
        (b.manage ? '<a class="ghost bkm" href="' + esc(b.manage) + '" target="_blank" rel="noopener">' + t("Move / cancel") + "</a>" : "") + "</div>";
    };
    var pastLine = past.length ? '<div class="bkp">' + (up.length ? t("Earlier") + ": " : t("Booked before") + ": ") + past.slice(0, 3).map(function (b) {
      return esc(b.product) + " (" + esc(fmt(b.date)) + (cx(b) ? ", " + t("cancelled") : "") + ")";
    }).join(" · ") + (past.length > 3 ? " · " + t("+{n} more", { n: past.length - 3 }) : "") + "</div>" : "";
    return '<div class="bkwrap">' + up.map(card).join("") + pastLine + "</div>";
  }

  // ---- Pretty names and facts
  var isPhone = function (s) { return /^\+?[\d\s()-]{6,}$/.test(String(s || "").trim()); };
  function prettyPhone(s) {
    var d = String(s || "").replace(/[^\d]/g, "");
    if (!d) return String(s || "");
    var cc = d.length > 10 ? d.slice(0, d.length - 9) : "", rest = cc ? d.slice(cc.length) : d;
    return (cc ? "+" + cc + " " : "") + rest.replace(/(\d{3})(?=\d)/g, "$1 ").trim();
  }
  function dname(name, contact) { var n = name || contact || t("Diver"); return isPhone(n) ? prettyPhone(n) : n; }
  var LANGN = { en: "English", nl: "Dutch", fr: "French", de: "German", es: "Spanish", it: "Italian", pt: "Portuguese", th: "Thai" };
  function langName(v) { var s = String(v || "").trim(); return (LANGN[s.toLowerCase()] && t(LANGN[s.toLowerCase()])) || (s.length <= 3 ? s.toUpperCase() : s.charAt(0).toUpperCase() + s.slice(1)); }
  function human(v) { var s = String(v || "").replace(/_/g, " ").trim(); return s ? t(s.charAt(0).toUpperCase() + s.slice(1)) : ""; }
  function prettyDates(v) {
    var s = String(v || "");
    return s.replace(/(\d{4})-(\d{2})-(\d{2})/g, function (m) { return new Date(m + "T12:00:00Z").toLocaleDateString(LOC, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }); });
  }

  // ---- Avatars
  var AVC = ["#163741", "#4E7480", "#9A6B1F", "#2F6B5A", "#7A4E3A", "#5A5A7A"];
  function avatar(name, cc) {
    var s = String(name || "?").trim(), parts = s.split(/\s+/).filter(Boolean);
    if (isPhone(s)) return '<span class="av anon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>' + (cc ? '<span class="avf">' + flag(cc) + "</span>" : "") + "</span>";
    var ini = parts.length > 1 && /[A-Za-zÀ-ÿ]/.test(parts[1][0]) ? parts[0][0] + parts[1][0] : s.replace(/^\+/, "").slice(0, 2);
    var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return '<span class="av" style="background:' + AVC[h % AVC.length] + '">' + esc(ini.toUpperCase()) + (cc ? '<span class="avf">' + flag(cc) + "</span>" : "") + "</span>";
  }

  // ---- Today
  function greet() {
    var h = new Date().getHours(), part = h < 12 ? t("Good morning") : h < 18 ? t("Good afternoon") : t("Good evening");
    var nm = ""; try { nm = localStorage.getItem("talay-sig") || ""; } catch (e) {}
    if (!nm && cfg.email) { var x = String(cfg.email).split("@")[0].split(/[._-]/)[0]; if (x && !/^(info|team|hello|contact|admin|dive|office)$/i.test(x)) nm = x.charAt(0).toUpperCase() + x.slice(1); }
    return part + (nm ? ", " + nm : "");
  }
  function goChat(id) {
    document.querySelector('nav button[data-v="convos"]').click();
    openChat(id);
  }
  function goBookings(r) {
    document.querySelector('nav button[data-v="books"]').click();
    var c = document.querySelector('.chip[data-r="' + r + '"]'); if (c) c.click();
  }
  function loadToday() {
    $("#tGreet").textContent = greet();
    $("#tDate").textContent = new Date().toLocaleDateString(LOC, { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Bangkok" }) + " · " + cfg.center;
    loadDay();
    api("conversations?view=open").then(function (d) {
      var need = d.conversations.filter(function (c) { return c.needsYou || c.waitingMin > 0; });
      var held = d.conversations.filter(function (c) { return c.teamActive && !c.needsYou && !c.waitingMin; });
      var open = d.conversations.length;
      $("#tNeed").innerHTML = '<div class="th"><b>' + t("Needs your team") + "</b>" + (need.length ? '<span class="tag need">' + need.length + "</span>" : "") + '<a href="#" class="tlink" id="tAllChats">' + t("All chats ({n})", { n: open }) + "</a></div>" +
        (need.length ? need.slice(0, 5).map(function (c) {
          return '<button class="trow" data-chat="' + esc(c.id) + '">' + avatar(c.name, c.cc) + '<span class="tr-b"><b>' + esc(dname(c.name)) + (c.waitingMin ? ' <span class="tag wait">' + t("Waiting {t}", { t: waitFor(c.waitingMin) }) + "</span>" : "") + "</b><small>" + esc(String(c.ask || c.preview || "").slice(0, 90)) + '</small></span><span class="tr-t">' + ago(c.lastAt) + "</span></button>";
        }).join("") : held.length ? "" : '<p class="tok"><span class="okdot"></span>' + t("Nothing waiting. {a} is handling every conversation.", { a: esc(cfg.assistant) }) + "</p>") +
        held.slice(0, 5).map(function (c) {
          return '<button class="trow" data-chat="' + esc(c.id) + '">' + avatar(c.name, c.cc) + '<span class="tr-b"><b>' + esc(dname(c.name)) + ' <span class="tag team"><svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg> ' + t("{a} paused", { a: esc(cfg.assistant) }) + "</span></b><small>" + t("Give it back to {a} when you're done.", { a: esc(cfg.assistant) }) + '</small></span><span class="tr-t">' + ago(c.lastAt) + "</span></button>";
        }).join("");
      $("#tNeed").querySelectorAll("[data-chat]").forEach(function (b) { b.onclick = function () { goChat(b.dataset.chat); }; });
      $("#tAllChats").onclick = function (e) { e.preventDefault(); document.querySelector('nav button[data-v="convos"]').click(); };
    }).catch(function () { $("#tNeed").innerHTML = '<div class="th"><b>' + t("Needs your team") + '</b></div><p class="tok">' + t("Couldn't load conversations.") + "</p>"; });
    api("bookings").then(function (d) {
      var live = d.bookings.filter(function (b) { return !isCx(b); });
      var day = function (iso) {
        var g = {};
        live.filter(function (b) { return b.date === iso; }).forEach(function (b) { g[b.product] = g[b.product] || { divers: 0, n: 0 }; g[b.product].divers += b.divers; g[b.product].n++; });
        return Object.keys(g).map(function (k) { return [k, g[k]]; }).sort(function (a, b) { return b[1].divers - a[1].divers; });
      };
      var block = function (label, iso, r) {
        var rows = day(iso), tot = rows.reduce(function (a, x) { return a + x[1].divers; }, 0);
        return '<div class="th"><b>' + label + '</b><a href="#" class="tlink" data-gb="' + r + '">' + t("Boat list") + "</a></div>" +
          '<div class="tbig"><b>' + tot + "</b><span>" + (tot === 1 ? t("diver") : t("divers")) + " · " + esc(new Date(iso + "T12:00:00Z").toLocaleDateString(LOC, { weekday: "short", day: "numeric", month: "short" })) + "</span></div>" +
          (rows.length ? rows.map(function (x) { return '<div class="tboat"><span>' + esc(x[0]) + "</span><b>" + x[1].divers + "</b></div>"; }).join("") : '<p class="tok">' + t("No bookings via {a} yet.", { a: esc(cfg.assistant) }) + "</p>");
      };
      $("#tToday").innerHTML = block(t("On the boat today"), d.today, "today");
      $("#tTomorrow").innerHTML = block(t("Tomorrow"), d.tomorrow, "tomorrow");
      document.querySelectorAll("#today [data-gb]").forEach(function (a) { a.onclick = function (e) { e.preventDefault(); goBookings(a.dataset.gb); }; });
      var next = [], max = 1;
      for (var i = 0; i < 7; i++) { var iso = addDays(d.today, i); var dv = live.filter(function (b) { return b.date === iso; }).reduce(function (a, b) { return a + b.divers; }, 0); next.push([iso, dv]); max = Math.max(max, dv); }
      var total = next.reduce(function (a, x) { return a + x[1]; }, 0);
      $("#tWeek").innerHTML = '<div class="th"><b>' + t("Next 7 days") + "</b><small>" + tn(total, "1 diver booked", "{n} divers booked") + '</small><a href="#" class="tlink" id="tCal">' + t("Calendar") + '</a></div><div class="tbars">' +
        next.map(function (x) { return '<div class="tb"><span class="tbv">' + (x[1] || "") + '</span><span class="tbb" style="height:' + Math.max(4, Math.round(x[1] / max * 70)) + 'px"></span><small>' + new Date(x[0] + "T12:00:00Z").toLocaleDateString(LOC, { weekday: "short" }) + "</small></div>"; }).join("") + "</div>";
      $("#tCal").onclick = function (e) { e.preventDefault(); goBookings("calendar"); };
    }).catch(function () { $("#tToday").innerHTML = '<div class="th"><b>' + t("On the boat today") + '</b></div><p class="tok">' + t("Couldn't load bookings.") + "</p>"; $("#tTomorrow").innerHTML = ""; $("#tWeek").innerHTML = ""; });
    api("arriving").then(function (d) {
      var n = d.items.length;
      $("#tArr").innerHTML = '<div class="th"><b>' + t("Arriving soon, not booked") + "</b>" + (n ? '<span class="tag lang">' + n + "</span>" : "") + '<a href="#" class="tlink" id="tArrAll">' + t("See all") + "</a></div>" +
        (n ? '<div class="tarr">' + d.items.slice(0, 4).map(function (i) {
          return '<div class="trow static">' + avatar(i.name || i.phone, "") + '<span class="tr-b"><b>' + esc(i.name || i.phone || t("Diver")) + "</b><small>" + esc(i.interested || t("Interested")) + " · " + (i.here ? t("on the island now") : t("arrives {d}", { d: esc(new Date(i.from + "T12:00:00Z").toLocaleDateString(LOC, { weekday: "short", day: "numeric", month: "short" })) })) + "</small></span></div>";
        }).join("") + "</div>" : '<p class="tok">' + t("Nobody without a booking arrives in the next 14 days.") + "</p>");
      $("#tArrAll").onclick = function (e) { e.preventDefault(); goBookings("arriving"); };
    }).catch(function () { $("#tArr").innerHTML = ""; });
  }
  loadToday();
  setInterval(function () { if (!document.hidden && $("#today").classList.contains("on")) loadToday(); }, 60000);

  // ---- Calendar (next 14 days)
  function renderCalendar() {
    if (!bdata) { $("#bcards").innerHTML = ""; $("#blist").innerHTML = '<div class="skel"><i></i><i></i></div>'; return; }
    var live = bdata.bookings.filter(function (b) { return !isCx(b); });
    var days = [];
    for (var i = 0; i < 14; i++) days.push(addDays(bdata.today, i));
    var total = live.filter(function (b) { return b.date >= days[0] && b.date <= days[13]; }).reduce(function (a, b) { return a + b.divers; }, 0);
    $("#bcards").innerHTML = '<div class="cardn"><small>' + t("Divers next 14 days") + "</small><b>" + total + "</b></div>" +
      '<div class="cardn"><small>' + t("Busiest day") + "</small><b>" + (function () { var best = null; days.forEach(function (dd) { var v = live.filter(function (b) { return b.date === dd; }).reduce(function (a, b) { return a + b.divers; }, 0); if (!best || v > best[1]) best = [dd, v]; }); return best && best[1] ? esc(new Date(best[0] + "T12:00:00Z").toLocaleDateString(LOC, { weekday: "short", day: "numeric", month: "short" })) : "–"; })() + "</b></div>";
    $("#blist").innerHTML = '<div class="cal">' + days.map(function (dd, idx) {
      var g = {};
      live.filter(function (b) { return b.date === dd; }).forEach(function (b) { g[b.product] = g[b.product] || { divers: 0, n: 0 }; g[b.product].divers += b.divers; g[b.product].n++; });
      var keys = Object.keys(g).sort(function (a, b) { return g[b].divers - g[a].divers; });
      var tot = keys.reduce(function (a, k2) { return a + g[k2].divers; }, 0);
      var dt = new Date(dd + "T12:00:00Z");
      return '<div class="cday' + (idx === 0 ? " today" : "") + (dt.getUTCDay() === 0 || dt.getUTCDay() === 6 ? " wk" : "") + '"><div class="cdh"><small>' + dt.toLocaleDateString(LOC, { weekday: "short" }) + "</small><b>" + dt.getUTCDate() + "</b>" + (tot ? '<span class="ctot">' + tot + "</span>" : "") + "</div>" +
        (keys.length ? keys.map(function (k2) { return '<div class="cblk"><b>' + esc(k2) + "</b><small>" + tn(g[k2].divers, "1 diver", "{n} divers") + "</small></div>"; }).join("") : '<div class="cnone">–</div>') + "</div>";
    }).join("") + "</div>";
  }

  // ---- Milestones
  var MS_LABEL = {
    divers: function (v) { return t("{n} divers booked through Talay", { n: v.toLocaleString(NUM) }); },
    revenue: function (v) { return t("{n} THB booked through Talay", { n: v.toLocaleString(NUM) }); },
    conversations: function (v) { return t("{n} conversations answered", { n: v.toLocaleString(NUM) }); },
  };
  function ordinalDay(iso) { return new Date(iso).toLocaleDateString(LOC, { day: "numeric", month: "long" }); }
  function loadMilestones() {
    return api("milestones").then(function (d) {
      if (!d || d.error) return;
      var latest = null;
      ["divers", "revenue", "conversations"].forEach(function (k) {
        var r = d[k] && d[k].reached;
        if (r && (!latest || r.at > latest.at)) latest = { k: k, value: r.value, at: r.at };
      });
      var trophy = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 4h8v5a4 4 0 0 1-8 0V4ZM8 6H5a3 3 0 0 0 3 3M16 6h3a3 3 0 0 1-3 3M12 13v4M8 21h8M9 17h6"/></svg>';
      var dv = d.divers || { total: 0, next: 10 };
      var goal = dv.next, have = dv.total;
      var prog = goal ? '<div class="msprog"><span style="width:' + Math.min(100, Math.round(have / goal * 100)) + '%"></span></div><small>' + t("{have} of {goal} divers · {left} to go", { have: have.toLocaleString(NUM), goal: goal.toLocaleString(NUM), left: (goal - have).toLocaleString(NUM) }) + "</small>" : "";
      var head = latest ? "<b>" + esc(MS_LABEL[latest.k](latest.value)) + "</b><small>" + t("Reached on {d}", { d: esc(ordinalDay(latest.at)) }) + "</small>" :
        "<b>" + t("Your first milestone: 10 divers through Talay") + "</b><small>" + t("Every booking through {a} counts.", { a: esc(cfg.assistant) }) + "</small>";
      var html = '<div class="msicon">' + trophy + '</div><div class="msbody">' + head + prog + "</div>";
      var dash = $("#ms"); dash.innerHTML = html; dash.hidden = false;
    }).catch(function () {});
  }
  loadMilestones(); setInterval(function () { if (!document.hidden) loadMilestones(); }, 1800000);

  // ---- Today so far (card on the Today page)
  function dayHtml(d) {
    var sun = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    var stat = function (v, l) { return "<div><b>" + v + "</b><span>" + l + "</span></div>"; };
    var thbs = function (v) { return Math.round(v).toLocaleString(NUM) + " THB"; };
    var parts = [];
    var A = esc(cfg.assistant);
    if (!d.conversations && !d.bookings) parts.push(t("A quiet day so far. {a} is ready for the next diver.", { a: A }));
    else {
      parts.push(tn(d.replies, "{a} sent 1 reply.", "{a} sent {n} replies.", { a: A }));
      if (d.outsideBookings) parts.push(tn(d.outsideBookings, "1 booking ({x}) came in outside office hours.", "{n} bookings ({x}) came in outside office hours.", { x: thbs(d.outsideRevenue) }));
      if (d.handedOver) parts.push(tn(d.handedOver, "1 conversation needs your team.", "{n} conversations need your team."));
    }
    var when = new Date(d.date).toLocaleDateString(LOC, { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Bangkok" }) + " · " + t("since 00:00");
    return '<div class="nh">' + sun + "<b>" + t("Today so far") + "</b><small>" + esc(when) + "</small></div>" +
      '<div class="nstats">' + stat(d.conversations, d.conversations === 1 ? t("conversation") : t("conversations")) +
      stat(d.bookings, (d.bookings === 1 ? t("booking") : t("bookings")) + (d.divers ? " · " + tn(d.divers, "1 diver", "{n} divers") : "")) +
      stat(Math.round(d.revenue).toLocaleString(NUM), t("THB booked today")) + "</div>" +
      '<p class="nline">' + parts.join(" ") + "</p>";
  }
  function loadDay() {
    return api("daystats").then(function (d) {
      if (!d || d.error) return;
      var el = $("#nightToday"); if (el) { el.innerHTML = dayHtml(d); el.hidden = false; }
    }).catch(function () { var el = $("#nightToday"); if (el) el.hidden = true; });
  }

  // ---- While you were diving
  function nightHtml(d) {
    var when = d.live ? "Tonight so far · since " + d.closeAt : "Last night · " + d.closeAt + "–" + d.openAt;
    var moon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/></svg>';
    var stat = function (v, l) { return '<div><b>' + v + '</b><span>' + l + '</span></div>'; };
    var line;
    if (!d.conversations && !d.bookings) line = "A quiet night: no new messages. " + esc(cfg.assistant) + " is ready for the next diver.";
    else {
      line = esc(cfg.assistant) + " sent " + d.replies + " " + (d.replies === 1 ? "reply" : "replies") +
        (d.avgResponse != null ? ", first answer in " + fmtSec(d.avgResponse) + " on average" : "") + ".";
      if (d.handedOver) line += " " + d.handedOver + " " + (d.handedOver === 1 ? "conversation needs" : "conversations need") + " your team.";
    }
    return '<div class="nh">' + moon + '<b>While you were diving</b><small>' + esc(when) + '</small></div>' +
      '<div class="nstats">' + stat(d.conversations, d.conversations === 1 ? "conversation" : "conversations") +
      stat(d.bookings, d.bookings === 1 ? "booking" : "bookings") +
      stat(Math.round(d.revenue).toLocaleString(NUM), "THB booked") + '</div>' +
      '<p class="nline">' + line + '</p>';
  }
  function loadNight(fresh) {
    return api("overnight" + (fresh ? "?fresh=1" : "")).then(function (d) {
      if (!d || d.error) return;
      var h = nightHtml(d);
      [].forEach(function (s) { var el = $(s); if (el) { el.innerHTML = h; el.hidden = false; } });
    }).catch(function () {});
  }

  // ---- Getting started (hidden once everything is done, or when someone hides it)
  function loadStart() {
    var el = $("#start");
    try { if (localStorage.getItem("talay-start-hide")) return; } catch (e) {}
    var pushCheck = ("serviceWorker" in navigator && "PushManager" in window) ?
      Promise.race([navigator.serviceWorker.ready.then(function (r) { return r.pushManager.getSubscription(); }).then(function (s) { return !!s; }), new Promise(function (r) { setTimeout(function () { r(false); }, 1500); })]).catch(function () { return false; }) : Promise.resolve(false);
    Promise.all([api("settings").catch(function () { return null; }), pushCheck]).then(function (res) {
      var s = res[0], push = res[1];
      if (!s) return;
      var seen = false; try { seen = !!localStorage.getItem("talay-seen-prices"); } catch (e) {}
      var items = [
        [t("Check your prices and products"), seen, "sett"],
        [t("Set your office hours"), !!s.hoursText, "sett"],
        [t("Add your team"), (s.staff || []).length > 1, "sett"],
        [t("Turn on notifications on this device"), push, "sett"],
      ];
      var done = items.filter(function (i) { return i[1]; }).length;
      if (done === items.length) { el.hidden = true; return; }
      el.innerHTML = '<div class="sh"><b>' + t("Get started with Talay") + "</b><small>" + t("{done} of {n} done", { done: done, n: items.length }) + '</small><button type="button" class="lnk3" id="startHide">' + t("Hide") + "</button></div>" +
        '<div class="sprog"><span style="width:' + Math.round(done / items.length * 100) + '%"></span></div>' +
        '<ul class="slist">' + items.filter(function (i) { return !i[1]; }).map(function (i) {
          return '<li class="' + (i[1] ? "ok" : "") + '"><span class="ck">' + (i[1] ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m3 8.5 3.2 3L13 4.5"/></svg>' : "") + "</span>" +
            (i[1] ? esc(i[0]) : '<a href="#" data-go="' + i[2] + '">' + esc(i[0]) + "</a>") + "</li>";
        }).join("") + "</ul>";
      el.hidden = false;
      el.querySelectorAll("[data-go]").forEach(function (a) { a.onclick = function (e) { e.preventDefault(); document.querySelector('nav button[data-v="' + a.dataset.go + '"]').click(); }; });
      $("#startHide").onclick = function () { try { localStorage.setItem("talay-start-hide", "1"); } catch (e) {} el.hidden = true; };
    });
  }

  function loadDash() {
    var p = $("#period").value || "";
    $("#dbody").style.opacity = ".5";
    api("dashboard" + (p ? "?period=" + encodeURIComponent(p) : "")).then(function (d) {
      ddata = d; $("#dbody").style.opacity = "";
      var sel = $("#period");
      if (!sel.options.length) {
        sel.innerHTML = '<option value="">' + t("Last 30 days") + "</option>" + d.months.map(function (m) { return '<option value="' + m.value + '">' + esc(monthLabel(m.value)) + "</option>"; }).join("");
        // The period picker in Talay style; the hidden select keeps the value.
        var ck = '<svg class="ck" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17 19 7"/></svg>';
        $("#pmenu").innerHTML = Array.prototype.map.call(sel.options, function (o) {
          return '<button type="button" role="menuitemradio" data-p="' + esc(o.value) + '"' + (o.value === sel.value ? ' class="on"' : "") + ">" + esc(o.text) + ck + "</button>";
        }).join("");
        dropMenu($("#pbtn"), $("#pmenu"), function (b) {
          if (b.dataset.p === sel.value) return;
          sel.value = b.dataset.p; $("#pname").textContent = b.textContent;
          $("#pmenu").querySelectorAll("button").forEach(function (x) { x.classList.toggle("on", x === b); });
          loadDash();
        });
      }
      renderDash();
    }).catch(function (e) { $("#dbody").style.opacity = ""; if (e.message !== "auth") $("#dbody").innerHTML = '<div class="bempty">' + esc(e.message) + "</div>"; });
  }
  function monthLabel(ym) { return new Date(ym + "-15T12:00:00Z").toLocaleDateString(cfg.locale || "en-GB", { month: "long", year: "numeric" }); }
  function periodLabel(d) { return /^\d{4}-\d{2}$/.test(d.period) ? monthLabel(d.period) : t("Last 30 days"); }
  function funnelHtml(f) {
    if (!f) return "";
    var steps = [
      [t("Conversations"), f.conversations, t("divers who wrote")],
      [t("Got a booking link"), f.linkSent, t("from {a} or your team", { a: esc(cfg.assistant) })],
      [t("Opened the payment page"), f.opened, t("chose a date and divers")],
      [t("Booked"), f.booked, t("paid the deposit")],
    ];
    var top = Math.max(1, f.conversations);
    var html = steps.map(function (s, i) {
      var w = Math.max(4, Math.round(s[1] / top * 100));
      var prev = i ? steps[i - 1][1] : 0;
      var conv = i ? '<span class="fpct" title="' + t("of the step before") + '">' + (prev ? Math.round(s[1] / prev * 100) + "%" : "–") + "</span>" : "";
      return '<div class="fstep">' + conv + '<div class="fbar"><span style="width:' + w + '%"></span></div>' +
        '<b>' + s[1] + '</b><small>' + s[0] + '</small><em>' + s[2] + "</em></div>";
    }).join("");
    var lost = Math.max(0, f.opened - f.booked);
    var tip = lost ? tn(lost, "1 diver opened the payment page but didn't pay. See <b>Bookings → Not paid yet</b> to send a reminder.", "{n} divers opened the payment page but didn't pay. See <b>Bookings → Not paid yet</b> to send a reminder.") : t("Nobody dropped off at the payment page in this period.");
    return '<div class="panel funnel"><h4>' + t("From question to booking") + "</h4>" + '<div class="fsteps">' + html + '</div><p class="hnote">' + tip + "</p></div>";
  }
  function country(cc, en) { if (!cfg.locale) return en; try { return new Intl.DisplayNames([cfg.locale], { type: "region" }).of(String(cc).toUpperCase()) || en; } catch (e) { return en; } }
  function flag(cc) { return String(cc || "").toUpperCase().replace(/./g, function (c) { return String.fromCodePoint(127397 + c.charCodeAt(0)); }); }
  function heatParts(d) {
    if (!d.heat) return { heat: "", ctry: "" };
    var days = [0, 1, 2, 3, 4, 5, 6].map(function (i) { return new Date(Date.UTC(2024, 0, 1 + i, 12)).toLocaleDateString(cfg.locale || "en-GB", { weekday: "short", timeZone: "UTC" }); }), max = 1, total = 0;
    d.heat.forEach(function (r) { r.forEach(function (v) { max = Math.max(max, v); total += v; }); });
    var best = null;
    d.heat.forEach(function (r, di) { for (var h = 0; h < 24; h += 3) { var s = r[h] + r[h + 1] + r[h + 2]; if (!best || s > best.s) best = { s: s, d: di, h: h }; } });
    var cells = d.heat.map(function (r, di) {
      return '<span class="hd">' + days[di] + "</span>" + r.map(function (v, h) {
        var a = v ? 0.18 + 0.82 * v / max : 0;
        return '<i title="' + days[di] + " " + String(h).padStart(2, "0") + ":00 · " + tn(v, "1 new diver", "{n} new divers") + '" style="background:' + (v ? "rgba(220,164,74," + a.toFixed(2) + ")" : "var(--paper)") + '"></i>';
      }).join("");
    }).join("");
    var hours = '<span></span>' + [0, 3, 6, 9, 12, 15, 18, 21].map(function (h) { return '<span class="hh" style="grid-column:span 3">' + String(h).padStart(2, "0") + "</span>"; }).join("");
    var note = total && best && best.s ? t("Busiest: {w} {f}–{u} (Koh Tao time).", { w: days[best.d], f: String(best.h).padStart(2, "0") + ":00", u: String(best.h + 3).padStart(2, "0") + ":00" }) : t("No new divers in this period yet.");
    var cmax = Math.max(1, d.countries.length ? d.countries[0][2] : 1);
    var ctry = d.countries.length ? d.countries.map(function (c) {
      return '<div class="barrow"><span class="lb lbw"><span class="flag">' + flag(c[0]) + "</span> " + esc(country(c[0], c[1])) + '</span><span class="bar" style="width:' + (c[2] / cmax * 60) + '%"></span><span>' + c[2] + "</span></div>";
    }).join("") : '<div class="bempty">' + t("No phone numbers yet.") + "</div>";
    return {
      heat: '<div class="panel"><h4>' + t("When new divers write") + '</h4><div class="heat">' + hours + cells + '</div><p class="hnote">' + note + "</p></div>",
      ctry: '<div class="panel"><h4>' + t("Where they come from") + "</h4>" + ctry + '<p class="hnote">' + t("From the country code of their phone number.") + "</p></div>",
    };
  }
  function renderDash() {
    var d = ddata, k = d.kpi;
    var P = d.kpiPrev;
    var tr = function (key, lowerBetter) {
      if (!P || P[key] == null || k[key] == null) return "";
      var a = Number(k[key]), b = Number(P[key]);
      if (!b && !a) return "";
      if (!b) return '<em class="trend up">' + t("New") + "</em>";
      var ch = Math.round((a - b) / b * 100);
      if (!ch) return '<em class="trend flat">' + t("= vs previous") + "</em>";
      var good = lowerBetter ? ch < 0 : ch > 0;
      return '<em class="trend ' + (good ? "up" : "down") + '">' + t("{n}% vs previous", { n: (ch > 0 ? "↑ " : "↓ ") + Math.abs(ch) }) + "</em>";
    };
    var kp = function (label, val, sub, hi, key, lowerBetter) { return '<div class="kpi' + (hi ? " hi" : "") + '"><small>' + label + "</small><b>" + val + "</b>" + (key ? tr(key, lowerBetter) : "") + (sub ? "<span>" + sub + "</span>" : "") + "</div>"; };
    var maxW = Math.max(1, Math.max.apply(null, d.weeks.map(function (w) { return Math.max(w.conversations, w.bookings); })));
    var W = Math.max(d.weeks.length, 1), bw = 100 / W;
    var bars = d.weeks.map(function (w, i) {
      var h1 = w.conversations / maxW * 100, h2 = w.bookings / maxW * 100, x = i * bw;
      return '<rect x="' + (x + bw * 0.12) + '" y="' + (100 - h1) + '" width="' + (bw * 0.36) + '" height="' + h1 + '" fill="#4E7480" rx="1"><title>' + tn(w.conversations, "1 conversation", "{n} conversations") + "</title></rect>" +
        '<rect x="' + (x + bw * 0.52) + '" y="' + (100 - h2) + '" width="' + (bw * 0.36) + '" height="' + h2 + '" fill="#DCA44A" rx="1"><title>' + tn(w.bookings, "1 booking", "{n} bookings") + "</title></rect>";
    }).join("");
    var labels = d.weeks.map(function (w) { return '<span style="flex:1;text-align:center">' + new Date(w.week + "T12:00:00Z").toLocaleDateString(LOC, { day: "numeric", month: "short" }) + "</span>"; }).join("");
    var langMax = Math.max(1, d.languages.length ? d.languages[0][1] : 1);
    var sec = function (title, sub) { return '<div class="dsec"><h3>' + title + "</h3>" + (sub ? "<p>" + sub + "</p>" : "") + "</div>"; };
    var mini = function (label, val, sub, key, lowerBetter) { return '<div class="mini"><small>' + label + "</small><b>" + val + "</b>" + (key ? tr(key, lowerBetter) : "") + (sub ? "<span>" + sub + "</span>" : "") + "</div>"; };
    var hp = heatParts(d);
    var weekPanel = '<div class="panel"><h4>' + t("Per week") + '</h4><div class="legend"><span><i style="background:#4E7480"></i>' + t("Conversations") + '</span><span><i style="background:#DCA44A"></i>' + t("Bookings") + "</span></div>" +
        '<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:160px;display:block">' + bars + "</svg>" +
        '<div style="display:flex;font-size:11px;color:var(--muted);margin-top:4px">' + labels + "</div></div>";
    var langPanel = '<div class="panel"><h4>' + t("Languages") + "</h4>" + (d.languages.length ? d.languages.map(function (l) {
          return '<div class="barrow"><span class="lb">' + esc(langName(l[0])) + '</span><span class="bar" style="width:' + (l[1] / langMax * 70) + '%"></span><span>' + l[1] + "</span></div>"; }).join("") : '<div class="bempty">' + t("No conversations yet.") + "</div>") + "</div>";
    var prodPanel =       (d.products.length ? '<div class="panel"><h4>Bookings per product</h4><div class="bscroll"><table class="btable"><thead><tr><th>Product</th><th class="num">Bookings</th><th class="num">Divers</th><th class="num">Value</th></tr></thead><tbody>' +
        d.products.map(function (p) { return "<tr><td>" + esc(p[0]) + '</td><td class="num">' + p[1].bookings + '</td><td class="num">' + p[1].divers + '</td><td class="num">' + thb(p[1].value) + "</td></tr>"; }).join("") + "</tbody></table></div></div>" : "");
    prodPanel = d.products.length ? '<div class="panel"><h4>' + t("Top products") + "</h4>" + d.products.slice(0, 6).map(function (p) {
      return '<div class="prow"><div><b>' + esc(p[0]) + "</b><small>" + tn(p[1].bookings, "1 booking", "{n} bookings") + " · " + tn(p[1].divers, "1 diver", "{n} divers") + "</small></div><span>" + thb(p[1].value) + "</span></div>";
    }).join("") + "</div>" : "";
    var label = periodLabel(d);
    var stmtPanel =       '<div class="panel"><div class="st-head"><h2 style="margin:0">' + t("Talay statement") + " · " + esc(d.center) + "</h2><p>" + esc(label) + "</p></div>" +
        "<h4>" + t("Statement") + " · " + esc(label) + "</h4>" +
        '<p style="font-size:13px;color:var(--muted);margin:0 0 10px">' + t("Talay's commission is the online deposit the diver pays when booking; your team collects the rest at the shop. Nothing to transfer: this is your overview.") + "</p>" +
        (d.statement.length ? '<div class="bscroll"><table class="btable"><thead><tr><th>' + t("Booked") + "</th><th>" + t("Ref") + "</th><th>" + t("Diver") + "</th><th>" + t("Product") + "</th><th>" + t("Dive date") + '</th><th class="num">' + t("Divers") + '</th><th class="num">' + t("Value") + '</th><th class="num">' + t("Commission") + "</th><th>" + t("Status") + "</th></tr></thead><tbody>" +
          d.statement.map(function (r) {
            return '<tr class="' + (r.cancelled ? "cx" : "") + '"><td>' + new Date(r.created).toLocaleDateString(LOC, { day: "numeric", month: "short" }) + "</td><td>" + esc(r.ref) + "</td><td>" + esc(r.name) + "</td><td>" + esc(r.product) + "</td><td>" + (r.date ? esc(dayLabel(r.date)) : "") +
              '</td><td class="num">' + r.divers + '</td><td class="num">' + thb(r.total) + '</td><td class="num">' + thb(r.commission) + '</td><td class="keep">' + esc(t(r.status)) + (r.refunded ? "<br><small>" + t("Refunded {x}", { x: thb(r.refunded) }) + "</small>" : "") + "</td></tr>";
          }).join("") +
          '<tr><td colspan="6"><b>' + t("Total") + '</b></td><td class="num"><b>' + thb(k.revenue) + '</b></td><td class="num"><b>' + thb(k.commission - k.refunded) + "</b></td><td>" + (k.refunded ? t("after {x} refunded", { x: thb(k.refunded) }) : "") + "</td></tr>" +
          "</tbody></table></div>" : '<div class="bempty">' + t("No bookings in this period.") + "</div>") + "</div>";
    var html =
      sec(t("Results"), t("{l} · compared with the period before", { l: esc(label) })) +
      '<div class="kpis main">' +
        kp(t("Revenue via {a}", { a: esc(cfg.assistant) }), thb(k.revenue), tn(k.divers, "1 diver", "{n} divers"), true, "revenue") +
        kp(t("Bookings"), k.bookings, t("{n} after a follow-up", { n: k.afterFollowUp }), false, "bookings") +
        kp(t("Conversations"), k.conversations, t("{n} outside office hours ({p})", { n: k.outsideHours, p: pct(k.outsideHours, k.conversations) }), false, "conversations") +
        kp(t("Booking conversion"), k.conversion + "%", t("of conversations booked"), false, "conversion") +
      "</div>" +
      '<div class="minis strip">' +
        mini(t("{a}'s first reply", { a: esc(cfg.assistant) }), fmtSec(k.avgResponse), t("on average"), "avgResponse", true) +
        mini(t("Handed to your team"), k.handedOver, t("{p} of conversations", { p: pct(k.handedOver, k.conversations) })) +
        mini(t("Collected at your shop"), thb(k.atShop), t("balance paid on arrival"), "atShop") +
      "</div>" +
      '<div class="dgrid"><div class="dmain">' + funnelHtml(d.funnel) + weekPanel + '</div><div class="dside"><div id="msSlot"></div>' + prodPanel + "</div></div>" +
      sec(t("Your divers"), t("When they write, where they come from and the languages they speak")) +
      '<div class="dgrid3">' + hp.heat + hp.ctry + langPanel + "</div>" +
      sec(t("Statement"), t("Every booking through Talay in this period, with the commission")) +
      '<details class="stmt"><summary>' + tn(d.statement.length, "Show 1 booking", "Show {n} bookings") + " · " + thb(k.revenue) + "</summary>" + stmtPanel + "</details>";
    $("#dbody").innerHTML = html;
    var ms = $("#ms"), slot = $("#msSlot"); if (ms && slot) slot.appendChild(ms);
  }
  $("#stPrint").onclick = function () {
    var st = document.querySelector("details.stmt"); if (st) st.open = true;
    document.body.classList.add("print-statement"); window.print();
    setTimeout(function () { document.body.classList.remove("print-statement"); }, 500);
  };
  $("#stCsv").onclick = function () {
    if (!ddata) return;
    var rows = [["Booked", "Ref", "Diver", "Product", "Dive date", "Divers", "Value THB", "Commission THB", "Refunded THB", "Status"]].concat(
      ddata.statement.map(function (r) { return [r.created.slice(0, 10), r.ref, r.name, r.product, r.date, r.divers, r.total, r.commission, r.refunded, r.status]; }));
    var csv = rows.map(function (r) { return r.map(function (v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(","); }).join("\n");
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv" }));
    a.download = "talay-statement-" + (ddata.period || "30d") + ".csv"; a.click();
  };

  // ---- support
  var tdata = null, tfilter = "open", tview = null;
  var TYPES = ["Bug", "Wrong answer", "Improvement", "Custom request", "Question"];
  function tsClass(st) { return "ts " + String(st).replace(/ /g, "-"); }
  document.querySelectorAll(".chip[data-t]").forEach(function (c) {
    c.onclick = function () { tfilter = c.dataset.t; tview = null; document.querySelectorAll(".chip[data-t]").forEach(function (x) { x.classList.toggle("on", x === c); }); renderTickets(); };
  });
  $("#tNew").onclick = function () { newTicket({}); };
  function loadTickets(fresh) {
    return api("tickets" + (fresh ? "?fresh=1" : "")).then(function (d) {
      tdata = d; var el = $("#tcount"); el.hidden = !d.waiting; el.textContent = d.waiting;
      if (!tview && $("#supp").classList.contains("on")) renderTickets();
    }).catch(function (e) { if (e.message !== "auth" && $("#supp").classList.contains("on")) $("#tbody").innerHTML = '<div class="bempty">' + esc(e.message) + "</div>"; });
  }
  var tt = t; // ticket loops below use t for the ticket
  function renderTickets() {
    if (!tdata) return;
    var list = tdata.tickets.filter(function (t) { return tfilter === "done" ? t.status === "Done" : t.status !== "Done"; });
    if (!list.length) {
      $("#tbody").innerHTML = tfilter === "done" ? '<div class="bempty">' + t("No closed tickets yet.") + "</div>" :
        '<div class="empty-card"><div class="eic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><path d="m9 11 2 2 4-4"/></svg></div>' +
        "<b>" + t("No open tickets. All good.") + "</b><p>" + t("Something not working, a wrong answer from {a}, or an idea for Talay? Click <b>New ticket</b>, or <b>Report</b> under any message from {a}. We reply here.", { a: esc(cfg.assistant) }) + "</p></div>";
      return;
    }
    $("#tbody").innerHTML = '<div class="tlist">' + list.map(function (t) {
      return '<button class="titem" data-tid="' + esc(t.id) + '"><div class="tt"><b>' + (t.number ? "#" + esc(t.number) + " · " : "") + esc(t.title) + "</b><small>" +
        esc(tt(t.type)) + (t.priority === "Urgent" ? " · " + tt("Urgent") : "") + " · " + esc(t.by) + " · " + (ago(t.updated) === tt("now") ? tt("updated just now") : tt("updated {t} ago", { t: ago(t.updated) })) +
        '</small></div><span class="' + tsClass(t.status) + '">' + esc(tt(t.status)) + "</span></button>";
    }).join("") + "</div>";
    $("#tbody").querySelectorAll("[data-tid]").forEach(function (b) { b.onclick = function () { openTicket(b.dataset.tid); }; });
  }
  function newTicket(pre) {
    document.querySelector('nav button[data-v="supp"]').click();
    tview = "new";
    $("#tbody").innerHTML = '<div class="scard"><h3>' + t("New ticket") + '</h3><p class="d">' + t("Tell Talay what's wrong or what you'd like. Jonas gets it right away and answers here.") + "</p>" +
      '<div class="tform"><div class="two"><label>' + t("Type") + '<select id="nType">' + TYPES.map(function (x) { return '<option value="' + x + '"' + (x === (pre.type || "Question") ? " selected" : "") + ">" + t(x) + "</option>"; }).join("") + "</select></label>" +
      "<label>" + t("Priority") + '<select id="nPrio"><option value="Low">' + t("Low") + '</option><option value="Normal" selected>' + t("Normal") + '</option><option value="Urgent">' + t("Urgent") + "</option></select></label></div>" +
      "<label>" + t("Title") + '<input id="nTitle" maxlength="140" value="' + esc(pre.title || "") + '"></label>' +
      "<label>" + t("What happened, or what would you like?") + '<textarea id="nDesc" placeholder="' + (pre.type === "Wrong answer" ? t("What should {a} have answered?", { a: esc(cfg.assistant) }) : t("Be as concrete as you can.")) + '"></textarea></label>' +
      (pre.context ? "<label>" + t("Conversation") + '<div class="ctx" id="nCtx">' + esc(pre.context) + "</div></label>" : "") +
      '<div class="srow"><button class="btn" id="nSend" type="button">' + t("Send ticket") + '</button><button class="ghost" id="nCancel" type="button">' + t("Cancel") + '</button></div><div class="smsg" id="nMsg"></div></div></div>';
    $("#nCancel").onclick = function () { tview = null; renderTickets(); };
    $("#nSend").onclick = function () {
      var btn = this; btn.disabled = true;
      post("ticket", { type: $("#nType").value, priority: $("#nPrio").value, title: $("#nTitle").value, description: $("#nDesc").value, contact: pre.contact || "", context: pre.context || "" })
        .then(function (r) { loadTickets(true).then(function () { if (r.id) openTicket(r.id); else { tview = null; renderTickets(); } }); })
        .catch(function (e) { btn.disabled = false; say("#nMsg", e.message, true); });
    };
    (pre.title ? $("#nDesc") : $("#nTitle")).focus();
  }
  function openTicket(id) {
    tview = id;
    $("#tbody").innerHTML = '<div class="skel"><i></i><i></i><i></i></div>';
    api("ticket?id=" + encodeURIComponent(id)).then(function (d) {
      if (tview !== id) return;
      var t = d.ticket;
      var html = '<div class="scard"><div class="srow" style="margin-bottom:8px"><button class="ghost" id="tBack" type="button">‹ ' + tt("All tickets") + '</button><span class="sp" style="flex:1"></span><span class="' + tsClass(t.status) + '">' + esc(tt(t.status)) + "</span></div>" +
        "<h3>" + (t.number ? "#" + esc(t.number) + " · " : "") + esc(t.title) + '</h3><p class="d">' + esc(tt(t.type)) + " · " + esc(tt(t.priority)) + " · " + tt("opened by {who}", { who: esc(t.by) }) + " · " + esc(clock(t.created)) + "</p>" +
        (t.description ? '<div class="tmsg" style="margin-bottom:10px">' + esc(t.description) + "</div>" : "") +
        (t.context ? '<div class="ctx" style="margin-bottom:10px">' + esc(t.context) + "</div>" : "") +
        (t.contact ? '<p style="margin:0 0 10px"><a href="#" id="tChat">' + tt("Open the conversation") + "</a></p>" : "") +
        (t.quote ? '<div class="quote" style="margin-bottom:10px"><b>' + tt("Quote from Talay") + '</b><div style="white-space:pre-wrap;margin-top:4px">' + esc(t.quote) + "</div>" +
          (t.approved ? '<p style="margin:8px 0 0"><span class="ts Done">' + tt("Approved") + "</span></p>" : '<p style="margin:8px 0 0"><button class="btn" id="tApprove" type="button">' + tt("Approve quote") + "</button></p>") + "</div>" : "") +
        '<div style="display:grid;gap:8px;margin-bottom:12px">' + d.messages.map(function (m) {
          return '<div class="tmsg' + (m.talay ? " talay" : "") + '"><small>' + (m.talay ? "Talay" : esc(m.author)) + " · " + esc(clock(m.at)) + "</small>" + esc(m.text) + "</div>";
        }).join("") + "</div>" +
        '<div class="tform"><textarea id="tReply" placeholder="' + tt("Write a message to Talay…") + '"></textarea><div class="srow"><button class="btn" id="tSend" type="button">' + tt("Send") + "</button>" +
        (t.status !== "Done" ? '<button class="ghost" id="tClose" type="button">' + tt("Mark as solved") + "</button>" : "") + '</div><div class="smsg" id="tMsg"></div></div></div>';
      $("#tbody").innerHTML = html;
      $("#tBack").onclick = function () { tview = null; renderTickets(); };
      if ($("#tChat")) $("#tChat").onclick = function (e) {
        e.preventDefault(); document.querySelector('nav button[data-v="convos"]').click();
        var all = document.querySelector('.chip[data-f="all"]'); if (all && filter === "open") all.click(); openChat(t.contact);
      };
      var act = function (path, body, ok) {
        return post(path, body).then(function () { loadTickets(true); openTicket(id); }).catch(function (e) { say("#tMsg", e.message, true); });
      };
      $("#tSend").onclick = function () { var v = $("#tReply").value.trim(); if (!v) return; this.disabled = true; act("ticket-message", { id: id, text: v }); };
      if ($("#tClose")) $("#tClose").onclick = function () { act("ticket-close", { id: id }); };
      if ($("#tApprove")) $("#tApprove").onclick = function () { if (confirm(tt("Approve this quote?"))) act("ticket-approve", { id: id }); };
    }).catch(function (e) { if (e.message !== "auth") $("#tbody").innerHTML = '<div class="bempty">' + esc(e.message) + "</div>"; });
  }
  loadTickets();
  setInterval(function () { if (!document.hidden) loadTickets(); }, 120000);

  // ---- app on the phone
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/zone/sw.js", { scope: "/zone" }).catch(function () {});
  var standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  var deferredInstall = null;
  window.addEventListener("beforeinstallprompt", function (e) { e.preventDefault(); deferredInstall = e; showInstall(); });
  function showInstall() {
    if (standalone) return;
    try { if (localStorage.getItem("talay-install-hide")) return; } catch (e) {}
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (!deferredInstall && !(ios && window.innerWidth < 900)) return;
    if ($("#install")) return;
    var bar = document.createElement("div");
    bar.id = "install";
    bar.innerHTML = '<span>📲 ' + (deferredInstall ? t("Install {c} as an app on this device.", { c: esc(cfg.center) }) : t("Add this to your home screen: tap <b>Share</b>, then <b>Add to Home Screen</b>.")) + "</span>" +
      (deferredInstall ? '<button class="btn" id="instGo" type="button">' + t("Install") + "</button>" : "") + '<button class="lnk2" id="instX" type="button" aria-label="' + t("Close") + '">✕</button>';
    document.body.appendChild(bar);
    if ($("#instGo")) $("#instGo").onclick = function () { deferredInstall.prompt(); deferredInstall.userChoice.then(function () { bar.remove(); }); };
    $("#instX").onclick = function () { try { localStorage.setItem("talay-install-hide", "1"); } catch (e) {} bar.remove(); };
  }
  setTimeout(showInstall, 1500);

  // ---- full screen height on iPhone home-screen apps
  // iOS sometimes reports a viewport that is shorter than the screen (by the height of the
  // status bar) for apps started from the home screen. Measure and use the real screen.
  (function fitScreen() {
    var standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (!standalone) return;
    var probe = document.createElement("div");
    probe.style.cssText = "position:fixed;top:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none";
    document.body.appendChild(probe);
    function apply() {
      var top = probe.getBoundingClientRect().height;
      var gap = screen.height - window.innerHeight;
      document.body.style.bottom = (top > 0 && gap > 4 && gap <= top + 4) ? (-gap) + "px" : "";
    }
    apply(); window.addEventListener("resize", apply); window.addEventListener("orientationchange", function () { setTimeout(apply, 300); });
  })();
  loadList();
  // Opened from Talay HQ with ?c=<contact id>: show that conversation straight away.
  (function () { var m = location.search.match(/[?&]c=([A-Za-z0-9:_-]{1,64})/); if (m) openChat(m[1]); })();
  // Polling is kept light on purpose (Airtable limits): the list every 30 s while the page
  // is visible; the open conversation only when the list shows something new in it.
  setInterval(function () { if (!document.hidden) loadList(); }, 30000);
  setInterval(function () { if (!document.hidden && filter !== "open" && filter !== "need") api("conversations?view=open").then(function (d) { badge(d.conversations); }).catch(function () {}); }, 60000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { lastList = ""; loadList(); } });
}
