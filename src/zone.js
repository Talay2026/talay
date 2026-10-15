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

    const centers = await centersFor(env, email);
    if (!centers.length) {
      return html(noAccess(email), 403);
    }
    const wanted = (url.searchParams.get("center") || "").toLowerCase();
    const center = centers.find((c) => c.slug === wanted) || centers[0];

    const p = url.pathname.replace(/\/+$/, "") || "/zone";
    if (p === "/zone") return html(app(center, centers, email));
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
      const need = d.conversations.filter((c) => c.needsYou);
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
    const res = await fetch(api, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
    if (!res.ok) throw new Error(`Airtable ${table}: ${res.status} ${await res.text()}`);
    const body = await res.json();
    out.push(...(body.records || []));
    offset = body.offset || "";
  } while (offset && out.length < max);
  return out;
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
    .map((r) => ({
      id: r.id,
      slug: String(first(r.fields["Slug"]) || "").toLowerCase(),
      name: first(r.fields["Name"]) || "Dive center",
      assistant: first(r.fields["Assistant name"]) || "Mia",
      admin: splitEmails(r.fields["Admin emails"]).includes(email),
      logo: first(r.fields["Logo"])?.thumbnails?.large?.url || first(r.fields["Logo"])?.url || "",
    }))
    .filter((c) => /^[a-z0-9-]{1,60}$/.test(c.slug));
}


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
  `conv/${center.slug}/open`, `conv/${center.slug}/all`, `chat/${center.slug}/${id}`, `lead/${id}`,
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

async function leadsFor(env, ids) {
  const map = {};
  // Leads change rarely between messages: keep each one 5 minutes in the cache.
  const missing = [];
  await Promise.all(ids.map(async (id) => {
    const hit = await caches.default.match(new Request(CACHE_HOST + env.AIRTABLE_BASE + "/lead/" + id));
    if (hit) { const r = await hit.json(); if (r) map[id] = r; } else missing.push(id);
  }));
  const fetched = await leadsFetch(env, missing);
  await Promise.all(missing.map((id) => caches.default.put(
    new Request(CACHE_HOST + env.AIRTABLE_BASE + "/lead/" + id),
    new Response(JSON.stringify(fetched[id] || null), { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300" } }),
  )));
  return Object.assign(map, fetched);
}

async function leadsFetch(env, ids) {
  const map = {};
  for (let i = 0; i < ids.length; i += 40) {
    const part = ids.slice(i, i + 40);
    const recs = await at(env, "Leads", {
      formula: `OR(${part.map((id) => `{External ID} & '' = '${q(id)}'`).join(",")})`,
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
    human: !!f["Human took over"], optedOut: !!f["Opted out"],
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
    if (!byContact.has(id)) byContact.set(id, { id, last: null, lastCustomer: null, lastTeam: null, hay: "" });
    const c = byContact.get(id);
    if (!c.last) c.last = { text: r.fields["Text"] || "", dir, at: when };
    if (dir === "Customer" && !c.lastCustomer) c.lastCustomer = when;
    if (dir === "Team" && !c.lastTeam) c.lastTeam = when;
    if (c.hay.length < 3000) c.hay += " " + String(r.fields["Text"] || "").toLowerCase();
  }

  let list = [...byContact.values()];
  if (view !== "all") list = list.filter((c) => c.lastCustomer);
  const leads = await leadsFor(env, list.map((c) => c.id));
  const now = Date.now();

  list = list.map((c) => {
    const lead = leadInfo(leads[c.id]);
    const closes = c.lastCustomer ? Date.parse(c.lastCustomer) + DAY : 0;
    const open = closes > now;
    const teamAt = Math.max(Date.parse(c.lastTeam || 0) || 0, Date.parse(lead.humanAt || 0) || 0);
    const handover = Date.parse(lead.handoverAt || 0) || 0;
    return {
      id: c.id, name: lead.name || lead.contact, language: lead.language, status: lead.status,
      needsYou: open && handover > teamAt && !lead.optedOut,
      teamActive: lead.human, open,
      preview: String(c.last.text).slice(0, 140), previewDir: c.last.dir, lastAt: c.last.at,
      cc: (countryOf(lead.contact) || [""])[0],
      closesAt: closes ? new Date(closes).toISOString() : null,
      hay: (lead.name.toLowerCase() + " " + c.hay).slice(0, 3000),
    };
  });
  list.sort((a, b) => (b.needsYou - a.needsYou) || (Date.parse(b.lastAt) - Date.parse(a.lastAt)));
  return { conversations: list, needsCount: list.filter((c) => c.needsYou).length };
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
  const rows = await at(env, "Chat", {
    formula: `AND({Center} = '${q(center.slug)}', {Contact ID} = '${q(id)}')`,
    fields: ["Text", "Direction", "Sent at"],
    sort: [{ field: "Sent at", direction: "asc" }],
    max: 300,
  });
  if (!rows.length) return { error: "Unknown conversation" };
  const leads = await leadsFor(env, [id]);
  const messages = rows.map((r) => ({
    text: r.fields["Text"] || "", dir: r.fields["Direction"] || "", at: r.fields["Sent at"] || r.createdTime,
  }));
  const lastCustomer = [...messages].reverse().find((m) => m.dir === "Customer");
  const lastTeam = [...messages].reverse().find((m) => m.dir === "Team");
  const closesAt = lastCustomer ? new Date(Date.parse(lastCustomer.at) + DAY).toISOString() : null;
  const canReply = !!closesAt && Date.parse(closesAt) > Date.now();
  const lead = leadInfo(leads[id]);
  if (/^rec[A-Za-z0-9]{14}$/.test(lead.interested)) lead.interested = (await productNames(env, [lead.interested]))[lead.interested] || "";
  const teamAt = Math.max(Date.parse(lastTeam?.at || 0) || 0, Date.parse(lead.humanAt || 0) || 0);
  const handover = Date.parse(lead.handoverAt || 0) || 0;
  return {
    id, lead, hasLead: !!leads[id], messages, closesAt, canReply,
    needsYou: canReply && handover > teamAt && !lead.optedOut,
    cc: (countryOf(lead.contact) || [""])[0],
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
  if (!okId(id) || !msg) return json({ error: "Type a message first." }, 400);

  const c = await chat(env, center, id);
  if (c.error) return json({ error: c.error }, 404);
  if (!c.canReply) {
    return json({ error: "More than 24 hours since the diver's last message: WhatsApp no longer allows a free reply." }, 409);
  }

  const contact = id.includes(":") ? id : `id:${id}`;
  const res = await fetch(`https://api.respond.io/v2/contact/${encodeURIComponent(contact)}/message`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESPONDIO_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { type: "text", text: msg } }),
  });
  if (!res.ok) {
    console.error("respond.io", res.status, await res.text());
    return json({ error: "WhatsApp did not accept the message. Try again, or answer in respond.io." }, 502);
  }

  const now = new Date().toISOString();
  const writes = [atWrite(env, "Chat", "POST", [{
    fields: { Text: msg, Direction: "Team", "Contact ID": id, Center: center.slug },
  }])];
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
    at(env, "Products", { formula: `FIND('${q(center.slug)}', ARRAYJOIN({C slug}))` }),
    leadsFor(env, [id]),
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
    formula: `AND(FIND('${q(center.name)}', ARRAYJOIN({Center})), ` +
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
      formula: `OR(${part.map((p) => `{Contact} & '' = '${q(p)}'`).join(",")})`,
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

// Stripe Checkout sessions created between start and end (ms), newest first, at most 500.
async function checkoutSessions(env, start, end) {
  if (!env.STRIPE_SECRET_KEY) return [];
  const out = [];
  let after = "";
  for (let page = 0; page < 5; page++) {
    const u = new URL("https://api.stripe.com/v1/checkout/sessions");
    u.searchParams.set("limit", "100");
    u.searchParams.set("created[gte]", String(Math.floor(start / 1000)));
    u.searchParams.set("created[lt]", String(Math.floor(end / 1000)));
    if (after) u.searchParams.set("starting_after", after);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
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
  const inPeriod = `IS_AFTER(CREATED_TIME(), DATETIME_PARSE('${iso(start - 1000)}')), IS_BEFORE(CREATED_TIME(), DATETIME_PARSE('${iso(end)}'))`;
  const [leads, books, linkMsgs, sessions] = await Promise.all([
    at(env, "Leads", { formula: `AND(FIND('${q(center.name)}', ARRAYJOIN({Center})), ${inPeriod})`, max: 5000 }),
    at(env, "Bookings", { formula: `AND(FIND('${q(center.name)}', ARRAYJOIN({Center})), ${inPeriod})`, max: 5000 }),
    at(env, "Chat", {
      formula: `AND({Center} = '${q(center.slug)}', FIND('talay.io/b/', {Text}), {Direction} != 'Customer', IS_AFTER({Sent at}, DATETIME_PARSE('${iso(start - 1000)}')), IS_BEFORE({Sent at}, DATETIME_PARSE('${iso(end)}')))`,
      fields: ["Contact ID"], max: 5000,
    }).catch(() => []),
    checkoutSessions(env, start, end).catch(() => []),
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
  leads.forEach((l) => { const k = weekKey(Date.parse(l.createdTime)); if (weeks[k]) weeks[k].conversations++; });
  live.forEach((b) => { const k = weekKey(Date.parse(b.createdTime)); if (weeks[k]) weeks[k].bookings++; });

  const sum = (arr, k) => arr.reduce((a, b) => a + n(b.fields[k]), 0);
  const statement = books.map((b) => {
    const f = b.fields;
    return {
      ref: first(f["Ref"]) || "", created: b.createdTime, date: first(f["Activity date"]) || "",
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
        const inPrev = `IS_AFTER(CREATED_TIME(), DATETIME_PARSE('${iso(ps - 1000)}')), IS_BEFORE(CREATED_TIME(), DATETIME_PARSE('${iso(pe)}'))`;
        const [pl, pb] = await Promise.all([
          at(env, "Leads", { formula: `AND(FIND('${q(center.name)}', ARRAYJOIN({Center})), ${inPrev})`, fields: ["Status", "Response seconds", "Outside hours"], max: 5000 }),
          at(env, "Bookings", { formula: `AND(FIND('${q(center.name)}', ARRAYJOIN({Center})), ${inPrev})`, fields: ["Status", "Group size", "Total value THB", "Balance at shop"], max: 5000 }),
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
      return {
        conversations: leads.length,
        linkSent: new Set(linkMsgs.map((m) => String(m.fields["Contact ID"] || "")).filter(Boolean)).size,
        opened,
        booked: live.length,
      };
    })(),
    languages: Object.entries(langs).sort((a, b) => b[1] - a[1]),
    heat: (() => {
      const h = Array.from({ length: 7 }, () => Array(24).fill(0));
      leads.forEach((l) => { const d = new Date(Date.parse(l.createdTime) + 7 * 3600 * 1000); h[(d.getUTCDay() + 6) % 7][d.getUTCHours()]++; });
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
  const leads = await at(env, "Leads", {
    formula: `AND(FIND('${q(center.name)}', ARRAYJOIN({Center})), IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -60, 'days')))`,
    max: 3000,
  });
  const today = thaiDate(Date.now());
  const limit = thaiDate(Date.now() + 14 * DAY);
  const s = (f, k) => { const v = first(f[k]); return v == null ? "" : String(v); };
  const items = [];
  for (const r of leads) {
    const f = r.fields;
    if (/booked|lost|closed|spam/i.test(s(f, "Status")) || f["Opted out"]) continue;
    const text = s(f, "Dates on island");
    const range = parseStay(s(f, "Arrival date") || text, Date.parse(r.createdTime));
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
    at(env, "Bookings", { formula: `FIND('${q(center.name)}', ARRAYJOIN({Center}))`, fields: ["Group size", "Total value THB", "Status"], max: 10000 }),
    at(env, "Leads", { formula: `FIND('${q(center.name)}', ARRAYJOIN({Center}))`, fields: ["Status"], max: 20000 }),
  ]);
  const n = (v) => Number(first(v)) || 0;
  const live = books.filter((b) => !/cancel|refund/i.test(String(first(b.fields["Status"]) || "")))
    .sort((a, b) => a.createdTime.localeCompare(b.createdTime));
  const series = {
    divers: live.map((b) => [b.createdTime, n(b.fields["Group size"]) || 1]),
    revenue: live.map((b) => [b.createdTime, n(b.fields["Total value THB"])]),
    conversations: [...leads].sort((a, b) => a.createdTime.localeCompare(b.createdTime)).map((l) => [l.createdTime, 1]),
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
async function pushToCenter(env, slug, onlyEmail) {
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
  const inP = `IS_AFTER(CREATED_TIME(), DATETIME_PARSE('${iso(start - 1000)}')), IS_BEFORE(CREATED_TIME(), DATETIME_PARSE('${iso(end)}'))`;
  const [leads, books, arr] = await Promise.all([
    at(env, "Leads", { formula: `AND(FIND('${q(center.name)}', ARRAYJOIN({Center})), ${inP})`, max: 5000 }),
    at(env, "Bookings", { formula: `AND(FIND('${q(center.name)}', ARRAYJOIN({Center})), ${inP})`, max: 5000 }),
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
    at(env, "Leads", { formula: `AND(FIND('${q(center.name)}', ARRAYJOIN({Center})), ${win("CREATED_TIME()")})`, max: 2000 }),
    at(env, "Bookings", { formula: `AND(FIND('${q(center.name)}', ARRAYJOIN({Center})), ${win("CREATED_TIME()")})`, max: 1000 }),
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
  if (!env.STRIPE_SECRET_KEY) return { items: [] };
  const since = Math.floor((Date.now() - 7 * DAY) / 1000);
  const sessions = [];
  let after = "";
  for (let page = 0; page < 5; page++) {
    const u = new URL("https://api.stripe.com/v1/checkout/sessions");
    u.searchParams.set("limit", "100");
    u.searchParams.set("created[gte]", String(since));
    if (after) u.searchParams.set("starting_after", after);
    const res = await fetch(u, { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } });
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
  const direct = await leadsFor(env, refs.filter(okId));
  for (const [id, rec] of Object.entries(direct)) byRef[id] = rec.fields;
  const rest = refs.filter((r) => !byRef[r]);
  for (let i = 0; i < rest.length; i += 30) {
    const part = rest.slice(i, i + 30);
    const leads = await at(env, "Leads", {
      formula: `OR(${part.map((r) => `FIND('c=${q(r)}&', {Booking link} & '&')`).join(",")})`,
      fields: ["Name", "Contact", "External ID", "Language", "Last message at", "Booking link", "Status"],
    });
    for (const l of leads) {
      const r = String(first(l.fields["Booking link"]) || "").match(/[?&]c=([A-Za-z0-9_-]{1,64})/)?.[1];
      if (r) byRef[r] = l.fields;
    }
  }

  const check = {
    stripeMode: String(env.STRIPE_SECRET_KEY).startsWith("sk_test_") ? "test" : String(env.STRIPE_SECRET_KEY).slice(0, 3),
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
// Centers fields: Staff emails, Alert Email, Escalation hours (+ FR/DE/ES/NL), Mia paused
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
  return {
    admin: center.admin, admins: splitEmails(f["Admin emails"]), products,
    staff: splitEmails(f["Staff emails"]),
    alert: s("Alert Email"),
    hoursText: s("Escalation hours"),
    from: hours ? hours[1].padStart(5, "0") : "09:00",
    to: hours ? hours[2].padStart(5, "0") : "18:00",
    paused: !!f["Mia paused"],
    info: {
      assistant: s("Assistant name"), languages: s("Languages spoken"), meeting: s("Meeting point"),
      sites: s("Dive sites"), boats: s("Boat departure times"), emergency: s("Center emergency phone"),
    },
  };
}

async function saveSettings(request, env, center, email) {
  const body = await readBody(request);
  if (!body) return json({ error: "Bad request" }, 400);
  if (body.action !== "mia" && !center.admin) {
    return json({ error: "Only an admin of your dive center can change this." }, 403);
  }
  if (body.action === "product") return await saveProduct(env, center, email, body);
  const fields = {};
  if (body.action === "team") {
    const list = [...new Set(splitEmails((body.emails || []).join("\n")))];
    const bad = list.find((e) => !EMAIL.test(e));
    if (bad) return json({ error: `"${bad}" is not a valid email address.` }, 400);
    if (!list.includes(email)) return json({ error: "You can't remove yourself. Ask a colleague to do that." }, 400);
    if (list.length > 50) return json({ error: "Maximum 50 team members." }, 400);
    fields["Staff emails"] = list.join("\n");
  } else if (body.action === "alert") {
    const a = String(body.email || "").trim().toLowerCase();
    if (!EMAIL.test(a)) return json({ error: "Enter one valid email address." }, 400);
    fields["Alert Email"] = a;
  } else if (body.action === "hours") {
    const a = hhmm(body.from), b = hhmm(body.to);
    if (!a || !b) return json({ error: "Choose an opening and a closing time." }, 400);
    for (const [suffix, fn] of Object.entries(HOURS_TEXT)) fields[`Escalation hours${suffix ? " " + suffix : ""}`] = fn(a, b);
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

function app(center, centers, email) {
  const switcher = centers.length > 1
    ? `<select id="center" aria-label="Dive center">${centers.map((c) =>
      `<option value="${esc(c.slug)}"${c.slug === center.slug ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>` : "";
  const logo = center.logo
    ? `<img src="${esc(center.logo)}" alt="" class="logo">`
    : `<svg width="32" height="32" viewBox="0 0 100 100" aria-hidden="true" class="logo-svg"><path d="M 12 50 A 38 38 0 0 0 88 50 Z" fill="#DCA44A"/><circle cx="50" cy="50" r="38" fill="none" stroke="#F7F3EA" stroke-width="10"/><line x1="6" y1="50" x2="94" y2="50" stroke="#F7F3EA" stroke-width="10" stroke-linecap="round"/></svg>`;
  const cfg = {
    qs: centers.length > 1 ? `?center=${encodeURIComponent(center.slug)}` : "",
    assistant: center.assistant, center: center.name, email,
  };

  return `<!doctype html><html lang="en"><head>${HEAD}
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
.tag.team{background:var(--team);color:var(--deep)}
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
.people button{font:inherit;font-size:13px;background:none;border:0;color:var(--warn);font-weight:700;cursor:pointer}
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
.ro input,.ro select,.ro button.btn,.ro .people button{pointer-events:none;opacity:.55}

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
 header select{grid-area:switch;margin:0 14px 14px;width:auto}
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
.cmeta .sp{flex:1}
.cmeta .bt.soon{color:var(--warn);font-weight:700}
.composer .note{background:none;padding:6px 0 0;font-size:11.5px}
@media (max-width:760px){.composer{padding:8px 10px calc(8px + env(safe-area-inset-bottom,0px))}.composer .pcl span,.composer .pcl{font-size:0;gap:0}.composer .pcl svg{width:16px;height:16px}.composer .note{display:none}.composer .note.err{display:block}.cbox textarea{font-size:16px}}
</style></head>
<body>
<header><div class="brand">${logo}<span class="bn"><b>${esc(center.name)}</b><small>Customer zone</small></span></div><span class="sp"></span>${switcher}<div class="htools"><button class="lnk" id="sound" type="button"></button><a href="/cdn-cgi/access/logout" title="${esc(email)}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4"/></svg><span class="sl">Sign out</span></a></div></header>
<nav><button class="on" data-v="today"><i><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></i><span class="nl">Today</span></button><button data-v="convos"><i><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg></i><span class="nl"><span class="long">Conversations</span><span class="short">Chats</span></span><span class="count" id="count" hidden></span></button><button data-v="books"><i><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/></svg></i><span class="nl">Bookings</span></button><button data-v="dash"><i><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg></i><span class="nl">Dashboard</span></button><button data-v="sett"><i><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg></i><span class="nl">Settings</span></button><button data-v="supp"><i><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17.2v.1"/></svg></i><span class="nl">Support</span><span class="count" id="tcount" hidden></span></button></nav>

<section id="today" class="view on">
  <div class="twrap">
    <div class="thead"><div><h1 id="tGreet">Today</h1><p id="tDate"></p></div></div>
    <div class="tgrid">
      <div class="tcol">
        <div class="tcard" id="tNeed"><div class="skel"><i></i></div></div>
        <div class="tcard" id="tBoats"><div class="skel"><i></i><i></i></div></div>
      </div>
      <div class="tcol">
        <div class="night big" id="nightToday" hidden></div>
        <div class="tcard" id="tArr"><div class="skel"><i></i></div></div>
        <div class="tcard" id="tWeek"><div class="skel"><i></i></div></div>
      </div>
    </div>
  </div>
</section>

<section id="convos" class="view">
  <div class="list">
    <div class="tools">
      <input id="search" type="search" placeholder="Search name or message" aria-label="Search">
      <div class="chips" role="tablist">
        <button class="chip on" data-f="open">Open</button>
        <button class="chip" data-f="need">Needs you</button>
        <button class="chip" data-f="booked">Booked</button>
        <button class="chip" data-f="all">All (30 days)</button>
      </div>
    </div>
    <div class="ms small" id="msChat" hidden></div>
    <div class="items" id="list"><div class="skel list"><i></i><i></i><i></i><i></i></div></div>
  </div>
  <div class="pane" id="pane"><div class="placeholder">Pick a conversation.<br><br><b>Open</b> shows every diver who wrote in the last 24 hours: WhatsApp only lets you reply freely within that window. <b>Needs you</b> means ${esc(center.assistant)} handed it over to your team.</div></div>
</section>

<section id="books" class="view">
  <div class="bwrap">
    <div class="btools">
      <button class="chip on" data-r="today">Today</button>
      <button class="chip" data-r="tomorrow">Tomorrow</button>
      <button class="chip" data-r="next">Next 30 days</button>
      <button class="chip" data-r="past">Past 30 days</button>
      <button class="chip" data-r="calendar">Calendar</button>
      <button class="chip" data-r="unfinished">Not paid yet<span class="count" id="ucount" hidden></span></button>
      <button class="chip" data-r="arriving">Arriving soon<span class="count" id="acount" hidden></span></button>
      <span class="sp"></span>
      <button class="ghost" id="print" type="button">Print list</button>
    </div>
    <div id="bcards" class="cards"></div>
    <div id="blist"><div class="skel"><i></i><i></i><i></i></div></div>
  </div>
</section>

<section id="sett" class="view">
  <div class="swrap">
    <div class="scard">
      <h3>${esc(center.assistant)}</h3>
      <p class="d">Pause ${esc(center.assistant)} for the whole dive center, for example during a storm or a holiday. While paused she doesn't answer anyone: your team answers every diver under <b>Conversations → Open</b>.</p>
      <div class="switch"><span class="pill" id="miaState">…</span><button class="ghost" id="miaToggle" type="button">…</button></div>
      <div class="smsg" id="miaMsg"></div>
    </div>
    <div class="scard">
      <h3>Notifications on this device</h3>
      <p class="d">Get a notification as soon as ${esc(center.assistant)} hands a conversation to your team, even when the zone is closed. Turn it on separately on every phone or computer. On an iPhone, first add the zone to your home screen (Share → Add to Home Screen) and open it from there.</p>
      <div class="switch"><span class="pill" id="pushState">…</span><button class="btn" id="pushOn" type="button">Turn on notifications</button><button class="ghost" id="pushTest" type="button" hidden>Send a test</button><button class="ghost" id="pushOff" type="button" hidden>Turn off</button></div>
      <div class="smsg" id="pushMsg"></div>
    </div>
    <div class="lock" id="adminNote" hidden>Only an admin of your dive center can change prices, office hours, the alert email and the team. You can still pause ${esc(center.assistant)}.</div>
    <div class="scard adm">
      <h3>Products and prices</h3>
      <p class="d">What divers pay and until when they can book online. The online deposit is your commission to Talay and follows the price automatically. Changes reach ${esc(center.assistant)} and the booking page within about two minutes.</p>
      <div class="bscroll"><table class="ptable"><thead><tr><th>Product</th><th>Price (THB)</th><th>Deposit</th><th>Book until (day before)</th><th>Bookable online</th><th></th></tr></thead><tbody id="prods"></tbody></table></div>
      <div class="smsg" id="pMsg"></div>
    </div>
    <div class="scard adm">
      <h3>Office hours</h3>
      <p class="d">${esc(center.assistant)} tells divers when your team answers personally (Thai time, every day). The text is updated in all five languages.</p>
      <div class="srow"><label>From <input type="time" id="hFrom" step="900"></label><label>to <input type="time" id="hTo" step="900"></label><button class="btn" id="hSave" type="button">Save</button></div>
      <div class="smsg" id="hMsg"></div>
    </div>
    <div class="scard adm">
      <h3>Alert email</h3>
      <p class="d">Where handovers, large groups and reminders are sent. A shared inbox works best.</p>
      <div class="srow"><input type="email" id="aEmail" placeholder="team@yourdivecenter.com"><button class="btn" id="aSave" type="button">Save</button></div>
      <div class="smsg" id="aMsg"></div>
    </div>
    <div class="scard adm">
      <h3>Team</h3>
      <p class="d">Everyone here can sign in at talay.io/zone with a code sent to their email.</p>
      <ul class="people" id="team"></ul>
      <div class="srow"><input type="email" id="tEmail" placeholder="colleague@email.com"><button class="btn" id="tAdd" type="button">Add</button></div>
      <div class="smsg" id="tMsg"></div>
    </div>
    <div class="scard">
      <h3>What ${esc(center.assistant)} knows about you</h3>
      <p class="d">To change any of this, message Jonas at <a href="mailto:jonas@talay.io">jonas@talay.io</a>.</p>
      <dl class="info" id="info"></dl>
    </div>
  </div>
</section>

<section id="supp" class="view">
  <div class="bwrap">
    <div class="btools">
      <button class="chip on" data-t="open">Open</button>
      <button class="chip" data-t="done">Done</button>
      <span class="sp"></span>
      <button class="btn" id="tNew" type="button">New ticket</button>
    </div>
    <div id="tbody"><div class="skel"><i></i><i></i><i></i></div></div>
  </div>
</section>

<section id="dash" class="view">
  <div class="bwrap">
    <div class="btools">
      <select id="period" aria-label="Period" class="psel"></select>
      <span class="sp"></span>
      <button class="ghost" id="stPrint" type="button">Print statement</button>
      <button class="ghost" id="stCsv" type="button">Download CSV</button>
    </div>
    <div class="night big" id="nightDash" hidden></div>
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
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function api(path, opt) {
    var sep = path.indexOf("?") > -1 ? "&" : "?";
    var extra = cfg.qs ? sep + cfg.qs.slice(1) : "";
    return fetch("/zone/api/" + path + extra, opt).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error("auth"); }
      return r.json().then(function (j) { if (!r.ok || j.error) throw new Error(j.error || "Error"); return j; });
    });
  }
  function post(path, body) { return api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
  function ago(iso) { var s = (Date.now() - Date.parse(iso)) / 1000; if (s < 60) return "now"; if (s < 3600) return Math.floor(s / 60) + " min"; if (s < 86400) return Math.floor(s / 3600) + " h"; return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" }); }
  function left(iso) {
    if (!iso) return { t: "", soon: false };
    var h = (Date.parse(iso) - Date.now()) / 3600000;
    if (h <= 0) return { t: "Reply window closed", soon: false };
    if (h < 1) return { t: Math.max(1, Math.round(h * 60)) + " min left to reply", soon: true };
    return { t: Math.floor(h) + " h left to reply", soon: h < 3 };
  }
  function clock(iso) { return new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }

  // ---- sound + title badge
  function setSoundLabel() { $("#sound").innerHTML = soundOn ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16ZM10 21h4"/></svg><span class="sl">Sound on</span>' : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 9.7-4.7M18 11v5l1.5 2H8M10 21h4M3 3l18 18"/></svg><span class="sl">Sound off</span>'; $("#sound").title = soundOn ? "Sound on" : "Sound off"; }
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
    var need = list.filter(function (c) { return c.needsYou; });
    var n = need.length, el = $("#count");
    el.hidden = !n; el.textContent = n;
    document.title = (n ? "(" + n + ") " : "") + cfg.center + " · Talay";
    var ids = need.map(function (c) { return c.id; });
    if (needSeen && ids.some(function (id) { return needSeen.indexOf(id) < 0; })) beep();
    needSeen = ids;
  }

  // ---- tabs
  var sel = $("#center"); if (sel) sel.onchange = function () { location.href = "/zone?center=" + encodeURIComponent(sel.value); };
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
      if (filter === "need" && !c.needsYou) return false;
      if (filter === "booked" && !/booked/i.test(c.status)) return false;
      return !term || c.hay.indexOf(term) > -1;
    });
    var el = $("#list");
    if (!list.length) {
      var msg = term ? "Nothing found for “" + esc(term) + "”."
        : filter === "need" ? "Nothing waiting for your team. 🎉"
        : filter === "open" ? "No open conversations right now. When a diver writes, it shows up here within a few seconds."
        : "No conversations in this view yet.";
      el.innerHTML = '<div class="empty">' + msg + "</div>"; return;
    }
    el.innerHTML = list.map(function (c) {
      var l = left(c.closesAt);
      var who = c.previewDir === "Customer" ? "" : (c.previewDir === "Team" ? "You: " : cfg.assistant + ": ");
      return '<button class="item' + (c.id === current ? " on" : "") + '" data-id="' + esc(c.id) + '" data-close="' + esc(c.closesAt || "") + '">' +
        avatar(c.name, c.cc) + '<div class="ib">' +
        '<div class="top"><span class="nm">' + esc(dname(c.name)) + "</span>" +
        '<span class="tm">' + ago(c.lastAt) + "</span></div>" +
        ((c.needsYou || c.teamActive || /booked/i.test(c.status) || c.language) ? '<div class="tags">' +
        (c.needsYou ? '<span class="tag need">Needs you</span>' : "") +
        (c.teamActive ? '<span class="tag team">Team</span>' : "") +
        (/booked/i.test(c.status) ? '<span class="tag st">Booked</span>' : "") +
        (c.language ? '<span class="tag lang">' + esc(langName(c.language)) + "</span>" : "") + "</div>" : "") +
        '<div class="pv">' + esc(who + c.preview) + "</div>" +
        (l.t ? '<div class="left' + (l.soon ? " soon" : "") + '">' + l.t + "</div>" : "") + "</div></button>";
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
      var key = JSON.stringify([d.messages.length, d.canReply, d.needsYou, d.lead]);
      if (key === lastChat) return;
      var draft = $("#txt") ? $("#txt").value : "";
      var oldBox = $("#msgs"), keepTop = null;
      if (!scroll && oldBox && oldBox.scrollHeight - oldBox.scrollTop - oldBox.clientHeight > 120) keepTop = oldBox.scrollTop;
      lastChat = key;
      var L = d.lead, l = left(d.closesAt);
      var actions = "";
      if (d.hasLead && L.human) actions += '<button class="ghost" id="handback">Let ' + esc(cfg.assistant) + " take over</button>";
      if (d.hasLead && d.needsYou && !L.human) actions += '<button class="ghost" id="handled">Mark as handled</button>';
      var facts = fact("Language", L.language && langName(L.language)) + fact("Level", human(L.cert)) + fact("On the island", prettyDates(L.dates)) +
        fact("Group", L.group) + fact("Interested in", /^rec[A-Za-z0-9]{14}$/.test(L.interested) ? "" : L.interested) + fact("Status", human(L.status)) + fact("WhatsApp", L.contact && L.name && L.contact !== L.name ? prettyPhone(L.contact) : "") +
        (L.human ? "<span><b>Team is handling this.</b> " + esc(cfg.assistant) + " is paused for this diver.</span>" : "");

      $("#pane").innerHTML =
        '<div class="head"><button class="back" aria-label="Back">‹</button>' + avatar(L.name || L.contact, d.cc) + '<div><b>' + esc(dname(L.name, L.contact)) + "</b>" +
        (l.t ? '<div class="sub">' + esc(l.t) + "</div>" : "") + "</div>" +
        (d.needsYou ? '<span class="tag need">Needs you</span>' : "") + '<div class="actions">' + actions + "</div></div>" +
        (facts ? '<div class="facts">' + facts + "</div>" : "") +
        '<div class="msgs" id="msgs">' + (function () {
          var prevDay = "";
          return d.messages.map(function (m, idx) {
            var who = m.dir === "Customer" ? "" : (m.dir === "Team" ? "Team" : cfg.assistant);
            var dt = new Date(m.at), day = dt.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
            var sep = day !== prevDay ? '<div class="day">' + esc(day) + "</div>" : ""; prevDay = day;
            var rep = m.dir === "Mia" ? '<button class="rep" type="button" data-rep="' + idx + '" title="Report this answer to Talay">Report</button>' : "";
            return sep + '<div class="m ' + esc(m.dir) + '">' + (who ? '<span class="who">' + esc(who) + "</span>" : "") + esc(m.text) +
              "<small>" + esc(dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) + rep + "</small></div>";
          }).join("");
        })() + "</div>" +
        (d.canReply
          ? '<div class="composer">' +
            '<div class="pchips" id="pchips" hidden></div>' +
            '<div class="cbox"><textarea id="txt" placeholder="Reply on WhatsApp…" rows="1"></textarea>' +
            '<button class="send" id="send" aria-label="Send"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div>' +
            '<div class="cmeta"><label class="sig">Signed as <input id="sig" maxlength="30" placeholder="your name"></label>' +
            '<select id="prod" aria-label="Booking link" hidden><option value="">+ Booking link…</option></select>' +
            '<span class="sp"></span><span class="bt' + (l.soon ? " soon" : "") + '">' + esc(l.t) + "</span></div>" +
            '<div class="note" id="note">⌘/Ctrl + Enter sends · replying pauses ' + esc(cfg.assistant) + " for this diver for 4 hours.</div></div>"
          : '<div class="closed">More than 24 hours since the diver\'s last message, so WhatsApp no longer allows a free reply. Read only.</div>');

      document.querySelectorAll("[data-rep]").forEach(function (b) {
        b.onclick = function () {
          var i = Number(b.dataset.rep), mia = d.messages[i], before = [];
          for (var j = i - 1; j >= 0 && before.length < 3; j--) if (d.messages[j].dir === "Customer") before.unshift(d.messages[j].text);
          var q = before.length ? before[before.length - 1] : "";
          newTicket({
            type: "Wrong answer", contact: d.id,
            title: "Wrong answer" + (q ? ": " + q.slice(0, 60) : ""),
            context: (before.length ? "Diver:\n" + before.join("\n") + "\n\n" : "") + cfg.assistant + ":\n" + mia.text + "\n\n(" + clock(mia.at) + ", " + (L.name || L.contact || "diver") + ")",
          });
        };
      });
      $(".back").onclick = function () { current = null; document.body.classList.remove("inchat"); $("#convos").classList.remove("open"); document.querySelectorAll(".item").forEach(function (b) { b.classList.remove("on"); }); };
      var box = $("#msgs");
      var place = function () { box.scrollTop = keepTop === null ? box.scrollHeight : keepTop; };
      place(); requestAnimationFrame(place); setTimeout(place, 250);
      if ($("#handback")) $("#handback").onclick = function () { act("handback", this); };
      if ($("#handled")) $("#handled").onclick = function () { act("handled", this); };
      if (d.canReply) {
        var t = $("#txt"), s = $("#sig");
        t.value = draft;
        if (pendingDraft) { t.value = pendingDraft; pendingDraft = null; t.focus(); }
        try { s.value = localStorage.getItem("talay-sig") || ""; } catch (e) {}
        if (!s.value && cfg.email) { var nm = String(cfg.email).split("@")[0].split(/[._-]/)[0]; if (nm && !/^(info|team|hello|contact|admin|dive|office)$/i.test(nm)) s.value = nm.charAt(0).toUpperCase() + nm.slice(1); }
        s.oninput = function () { try { localStorage.setItem("talay-sig", s.value); } catch (e) {} };
        t.onkeydown = function (e) { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); };
        var grow = function () { t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 180) + "px"; };
        t.addEventListener("input", grow); setTimeout(grow, 0);
        $("#send").onclick = send;
        loadProducts(id);
      }
    }).catch(function (e) { if (e.message !== "auth" && id === current) $("#pane").innerHTML = '<div class="placeholder">' + esc(e.message) + "</div>"; });
  }

  function loadProducts(id) {
    api("products?c=" + encodeURIComponent(id)).then(function (d) {
      var p = $("#prod"); if (!p || id !== current) return;
      d.products.forEach(function (x, i) {
        var o = document.createElement("option"); o.value = String(i);
        o.textContent = x.name + (x.price ? " · " + x.price.toLocaleString("en-US") + " THB" : ""); p.appendChild(o);
      });
      p.onchange = function () {
        var x = d.products[Number(p.value)]; p.value = ""; if (!x) return;
        var t = $("#txt"); t.value = (t.value.trim() ? t.value.trim() + "\n\n" : "") + x.text; t.focus();
      };
      var pc = $("#pchips");
      if (pc && d.products.length) {
        pc.innerHTML = '<span class="pcl"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>Send a booking link</span><div class="pscroll">' + d.products.map(function (x, i) { return '<button type="button" class="pchip" data-pi="' + i + '">' + esc(x.name) + "</button>"; }).join("") + "</div>";
        pc.hidden = false;
        pc.querySelectorAll("[data-pi]").forEach(function (b) {
          b.onclick = function () { var x = d.products[Number(b.dataset.pi)]; var t = $("#txt"); t.value = (t.value.trim() ? t.value.trim() + "\n\n" : "") + x.text; t.focus(); };
        });
      }
    }).catch(function () { var p = $("#prod"); if (p) p.remove(); });
  }

  function act(kind, btn) {
    btn.disabled = true;
    post(kind, { c: current }).then(function () { lastChat = ""; lastList = ""; freshNext = true; freshList = true; loadChat(false); loadList(); })
      .catch(function (e) { btn.disabled = false; alert(e.message); });
  }

  function send() {
    var t = $("#txt"), b = $("#send"), n = $("#note"), v = t.value.trim();
    if (!v || b.disabled) return;
    var sig = ($("#sig").value || "").trim(); if (sig) v += "\n– " + sig;
    b.disabled = true; b.classList.add("busy");
    post("reply", { c: current, text: v }).then(function () {
      t.value = ""; lastChat = ""; lastList = ""; freshNext = true; freshList = true; loadChat(true); loadList();
    }).catch(function (e) { n.textContent = e.message; n.className = "note err"; })
      .finally(function () { b.disabled = false; b.classList.remove("busy"); });
  }


  // ---- bookings
  var bdata = null, brange = "today";
  function thb(n) { return Math.round(n).toLocaleString("en-US") + " THB"; }
  function dayLabel(iso) { return new Date(iso + "T12:00:00Z").toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }); }
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
    return '<span class="st ' + cls + '">' + esc(s) + (b.late ? " · late" : "") + "</span>";
  }
  function renderBookings() {
    if (brange === "unfinished") { renderUnfinished(); return; }
    if (brange === "arriving") { renderArriving(); return; }
    if (brange === "calendar") { renderCalendar(); return; }
    if (!bdata) return;
    var t = bdata.today, list = bdata.bookings.filter(function (b) {
      if (brange === "today") return b.date === t;
      if (brange === "tomorrow") return b.date === bdata.tomorrow;
      if (brange === "next") return b.date >= t && b.date <= addDays(t, 30);
      return b.date < t && b.date >= addDays(t, -30);
    });
    if (brange === "past") list.reverse();
    var live = list.filter(function (b) { return !isCx(b); });
    var sum = function (k) { return live.reduce(function (a, b) { return a + b[k]; }, 0); };
    $("#bcards").innerHTML =
      '<div class="cardn"><small>Divers</small><b>' + sum("divers") + "</b></div>" +
      '<div class="cardn"><small>Bookings</small><b>' + live.length + "</b></div>" +
      '<div class="cardn"><small>' + (brange === "past" ? "Collected at the shop" : "To collect at the shop") + "</small><b>" + thb(sum("balance")) + "</b></div>" +
      '<div class="cardn"><small>Paid online</small><b>' + thb(sum("deposit")) + "</b></div>";
    if (!list.length) {
      $("#blist").innerHTML = '<div class="bempty">' + (brange === "today" ? "No bookings via " + esc(cfg.assistant) + " for today." :
        brange === "tomorrow" ? "No bookings via " + esc(cfg.assistant) + " for tomorrow yet." : "No bookings in this period.") + "</div>";
      return;
    }
    var html = "", days = {};
    list.forEach(function (b) { (days[b.date] = days[b.date] || []).push(b); });
    Object.keys(days).forEach(function (day) {
      var rows = days[day], dl = rows.filter(function (b) { return !isCx(b); });
      var divers = dl.reduce(function (a, b) { return a + b.divers; }, 0);
      html += '<div class="dayh">' + esc(dayLabel(day)) + "<span>" + divers + " diver" + (divers === 1 ? "" : "s") + " · " +
        dl.length + " booking" + (dl.length === 1 ? "" : "s") + "</span></div>";
      var prods = {};
      rows.forEach(function (b) { (prods[b.product || "Other"] = prods[b.product || "Other"] || []).push(b); });
      Object.keys(prods).forEach(function (p) {
        html += '<div class="prodh">' + esc(p) + '</div><div class="bscroll"><table class="btable"><thead><tr>' +
          "<th>Ref</th><th>Name</th><th>Phone</th><th class=\"num\">Divers</th><th class=\"num\">Paid online</th><th class=\"num\">At the shop</th><th>Status</th><th class=\"noprint\"></th></tr></thead><tbody>" +
          prods[p].map(function (b) {
            var links = [];
            if (b.chat) links.push('<a href="#" data-chat="' + esc(b.chat) + '">Chat</a>');
            if (b.manage && !isCx(b) && b.date >= t) links.push('<a href="' + esc(b.manage) + '" target="_blank" rel="noopener">Move / cancel</a>');
            var wa = b.phone ? '<a href="https://wa.me/' + esc(b.phone.replace(/[^0-9]/g, "")) + '" target="_blank" rel="noopener">' + esc(b.phone) + "</a>" : "";
            return '<tr class="' + (isCx(b) ? "cx" : "") + '"><td data-l="Ref">' + esc(b.ref) + '</td><td data-l="Name" class="tname">' + esc(b.name) + '</td><td data-l="Phone">' + wa + '</td><td class="num" data-l="Divers">' + b.divers +
              '</td><td class="num" data-l="Paid online">' + thb(b.deposit) + '</td><td class="num" data-l="At the shop">' + (isCx(b) ? "–" : thb(b.balance)) + '</td><td class="keep" data-l="Status">' + stTag(b) +
              (b.refunded ? '<br><small>Refunded ' + thb(b.refunded) + "</small>" : "") + '</td><td class="keep noprint tlinks">' + links.join(" · ") + "</td></tr>";
          }).join("") + "</tbody></table></div>";
      });
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
  function loadSettings() {
    return api("settings").then(function (d) {
      sdata = d;
      $("#adminNote").hidden = d.admin;
      document.querySelectorAll(".scard.adm").forEach(function (c) { c.classList.toggle("ro", !d.admin); });
      $("#prods").innerHTML = d.products.map(function (p) {
        var hours = ""; for (var h = 8; h <= 22; h++) hours += '<option value="' + h + '"' + (h === p.cutoff ? " selected" : "") + ">" + h + ":00</option>";
        return '<tr class="' + (p.active ? "" : "off") + '" data-id="' + esc(p.id) + '" data-pct="' + p.pct + '"><td class="nm">' + esc(p.name) + '<br><span class="muted">' + esc(p.code) + "</span></td>" +
          '<td data-l="Price (THB)"><input type="number" min="100" step="50" value="' + p.price + '" class="pp" inputmode="numeric"></td>' +
          '<td class="muted dep" data-l="Deposit">' + Math.round(p.deposit).toLocaleString("en-US") + " THB<br>" + p.pct + "%</td>" +
          '<td data-l="Book until (day before)"><select class="pc">' + hours + "</select></td>" +
          '<td data-l="Bookable online"><input type="checkbox" class="pa"' + (p.active ? " checked" : "") + "></td>" +
          '<td class="tlinks"><button class="ghost ps" type="button">Save</button></td></tr>';
      }).join("");
      $("#prods").querySelectorAll("tr").forEach(function (tr) {
        var pp = tr.querySelector(".pp");
        pp.oninput = function () { tr.querySelector(".dep").innerHTML = Math.round((Number(pp.value) || 0) * Number(tr.dataset.pct) / 100).toLocaleString("en-US") + " THB<br>" + tr.dataset.pct + "%"; };
        tr.querySelector(".ps").onclick = function () {
          var btn = this, name = tr.querySelector(".nm").firstChild.textContent;
          save({ action: "product", id: tr.dataset.id, price: Number(pp.value), cutoff: Number(tr.querySelector(".pc").value), active: tr.querySelector(".pa").checked },
            "#pMsg", name + " saved.", btn);
        };
      });
      $("#miaState").textContent = d.paused ? "Paused" : "Answering divers";
      $("#miaState").className = "pill " + (d.paused ? "off" : "on");
      $("#miaToggle").textContent = d.paused ? "Turn " + cfg.assistant + " back on" : "Pause " + cfg.assistant;
      $("#hFrom").value = d.from; $("#hTo").value = d.to;
      if (document.activeElement !== $("#aEmail")) $("#aEmail").value = d.alert;
      $("#team").innerHTML = d.staff.map(function (e) {
        return "<li><span>" + esc(e) + (e === ME ? " <small>(you)</small>" : "") + "</span>" +
          (e === ME ? "" : '<button type="button" data-rm="' + esc(e) + '">Remove</button>') + "</li>";
      }).join("");
      $("#team").querySelectorAll("[data-rm]").forEach(function (b) {
        b.onclick = function () {
          if (!confirm("Remove " + b.dataset.rm + "? They can no longer sign in.")) return;
          save({ action: "team", emails: sdata.staff.filter(function (x) { return x !== b.dataset.rm; }) }, "#tMsg", "Removed.");
        };
      });
      var I = d.info, rows = [["Assistant", I.assistant], ["Languages", I.languages], ["Meeting point", I.meeting], ["Dive sites", I.sites], ["Boat times", I.boats], ["Emergency phone", I.emergency]];
      $("#info").innerHTML = rows.filter(function (r) { return r[1]; }).map(function (r) { return "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>"; }).join("");
    }).catch(function (e) { if (e.message !== "auth") say("#miaMsg", e.message, true); });
  }
  $("#miaToggle").onclick = function () {
    if (!sdata) return;
    var pause = !sdata.paused;
    if (pause && !confirm("Pause " + cfg.assistant + " for every diver? Your team then answers all messages.")) return;
    save({ action: "mia", paused: pause }, "#miaMsg", pause ? cfg.assistant + " is paused." : cfg.assistant + " is answering again.", this);
  };
  $("#hSave").onclick = function () { save({ action: "hours", from: $("#hFrom").value, to: $("#hTo").value }, "#hMsg", "Saved in all five languages.", this); };
  $("#aSave").onclick = function () { save({ action: "alert", email: $("#aEmail").value }, "#aMsg", "Saved.", this); };
  $("#tAdd").onclick = function () {
    var e = ($("#tEmail").value || "").trim().toLowerCase(); if (!e || !sdata) return;
    if (sdata.staff.indexOf(e) > -1) { say("#tMsg", "Already in the team.", true); return; }
    var btn = this;
    save({ action: "team", emails: sdata.staff.concat([e]) }, "#tMsg", e + " can now sign in.", btn).then(function () { $("#tEmail").value = ""; });
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
      '<div class="cardn"><small>Started, not paid (7 days)</small><b>' + list.length + "</b></div>" +
      '<div class="cardn"><small>Divers</small><b>' + list.reduce(function (a, i) { return a + i.divers; }, 0) + "</b></div>" +
      '<div class="cardn"><small>Value still open</small><b>' + thb(value) + "</b></div>";
    if (!list.length) { $("#blist").innerHTML = '<div class="bempty">Nobody left the payment page in the last 7 days. 🎉</div>'; return; }
    $("#blist").innerHTML = '<p class="d" style="color:var(--muted);font-size:14px;margin:0 0 10px">These divers chose a date and went to the payment page, but didn\'t pay. A friendly reminder often brings them back.</p>' +
      '<div class="bscroll"><table class="btable"><thead><tr><th>Diver</th><th>Product</th><th>For</th><th class="num">Divers</th><th class="num">Value</th><th>Left</th><th class="noprint"></th></tr></thead><tbody>' +
      list.map(function (i, k) {
        var who = esc(i.name || i.phone || "Unknown diver") + (i.phone && i.name !== i.phone ? '<br><small style="color:var(--muted)">' + esc(i.phone) + "</small>" : "");
        var act = [];
        if (i.booked) act.push('<span class="st ok">Booked since</span>');
        else if (i.chat && i.canMessage) act.push('<a href="#" data-remind="' + k + '">Send reminder</a>');
        else if (i.chat) act.push('<span class="st">Outside 24 h</span>');
        else act.push('<span class="st">No chat linked</span>');
        if (i.chat) act.push('<a href="#" data-uchat="' + k + '">Chat</a>');
        return '<tr><td class="tname" data-l="Diver">' + who + '</td><td data-l="Product">' + esc(i.product) + '</td><td data-l="For">' + esc(dayLabel(i.date)) + '</td><td class="num" data-l="Divers">' + i.divers +
          '</td><td class="num" data-l="Value">' + thb(i.total) + '</td><td data-l="Left">' + (ago(i.at) === "now" ? "just now" : ago(i.at) + " ago") + '</td><td class="keep noprint tlinks">' + act.join(" · ") + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      '<p style="color:var(--muted);font-size:13px">WhatsApp only allows a free message within 24 hours of the diver\'s last message, so older ones can\'t get a reminder from here.</p>';
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
  function shortDay(iso) { return new Date(iso + "T12:00:00Z").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }); }
  function whenText(i) {
    if (i.here) return "On the island now";
    var days = Math.round((Date.parse(i.from) - Date.parse(adata.today)) / 86400000);
    return days === 1 ? "Arrives tomorrow" : "Arrives in " + days + " days";
  }
  function renderArriving() {
    if (!adata) { $("#bcards").innerHTML = ""; $("#blist").innerHTML = '<div class="skel"><i></i><i></i><i></i></div>'; return; }
    var list = adata.items;
    var divers = list.reduce(function (a, i) { return a + (Number(i.group) || 1); }, 0);
    $("#bcards").innerHTML =
      '<div class="cardn"><small>Not booked yet</small><b>' + list.length + "</b></div>" +
      '<div class="cardn"><small>Divers</small><b>' + divers + "</b></div>" +
      '<div class="cardn"><small>On the island now</small><b>' + list.filter(function (i) { return i.here; }).length + "</b></div>";
    if (!list.length) { $("#blist").innerHTML = '<div class="bempty">Nobody without a booking arrives in the next 14 days.</div>'; return; }
    $("#blist").innerHTML = '<p class="d" style="color:var(--muted);font-size:14px;margin:0 0 10px">These divers told ' + esc(cfg.assistant) + " when they're on the island, but haven't booked yet. A personal message now often makes the difference.</p>" +
      '<div class="bscroll"><table class="btable"><thead><tr><th>Diver</th><th>When</th><th>Interested in</th><th>Level</th><th class="num">Group</th><th class="noprint"></th></tr></thead><tbody>' +
      list.map(function (i, k) {
        var who = esc(i.name || i.phone || "Unknown diver") + (i.language ? ' <span class="tag lang">' + esc(String(i.language).slice(0, 2)) + "</span>" : "");
        var when = '<b>' + esc(whenText(i)) + '</b><br><small style="color:var(--muted)">' + esc(shortDay(i.from)) + " – " + esc(shortDay(i.to)) + (i.dates ? " · “" + esc(i.dates) + "”" : "") + "</small>";
        var act = [];
        if (i.chat && i.canMessage) act.push('<a href="#" data-amsg="' + k + '">Send a message</a>');
        else if (i.chat) act.push('<span class="st">Outside 24 h</span>');
        if (i.chat) act.push('<a href="#" data-achat="' + k + '">Chat</a>');
        else if (i.phone) act.push(esc(i.phone));
        return '<tr><td class="tname" data-l="Diver">' + who + '</td><td data-l="When">' + when + '</td><td data-l="Interested in">' + esc(i.interested || "–") +
          '</td><td data-l="Level">' + esc(i.cert || "–") + '</td><td class="num" data-l="Group">' + esc(i.group || "1") + '</td><td class="keep noprint tlinks">' + act.join(" · ") + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      '<p style="color:var(--muted);font-size:13px">WhatsApp only allows a free message within 24 hours of the diver\'s last message. For the others, message them from your WhatsApp app.</p>';
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
  function fmtSec(s) { if (s == null) return "–"; if (s < 60) return s + " s"; return Math.floor(s / 60) + " min " + (s % 60) + " s"; }
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
      state.textContent = active ? "On for this device" : (supported ? "Off" : "Not available here");
      state.classList.toggle("on", !!active);
      on.hidden = !!active || !supported; test.hidden = !active; off.hidden = !active;
    }
    if (!supported) {
      setUi(false);
      show(/iPhone|iPad/.test(navigator.userAgent) ? "On iPhone: add the zone to your home screen first (Share → Add to Home Screen), then open it from there." : "This browser doesn't support notifications.", false);
      return;
    }
    setUi(false);
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (s) { setUi(!!s && Notification.permission === "granted"); }).catch(function () { setUi(false); });
    on.onclick = function () {
      show("");
      on.disabled = true;
      Notification.requestPermission().then(function (perm) {
        if (perm !== "granted") throw new Error("Notifications are blocked. Allow them for talay.io in your browser or phone settings.");
        return api("push-key");
      }).then(function (d) {
        if (!d.key) throw new Error("Notifications are not set up yet. Contact Talay.");
        return navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlKey(d.key) }); });
      }).then(function (sub) {
        return post("push-subscribe", { endpoint: sub.endpoint });
      }).then(function () { setUi(true); show("Done. Tap “Send a test” to check."); })
        .catch(function (e) { show(e.message || "Something went wrong. Try again.", true); })
        .then(function () { on.disabled = false; });
    };
    test.onclick = function () {
      show("Sending…");
      post("push-test", {}).then(function () { show("Sent. It can take a few seconds."); }).catch(function (e) { show(e.message, true); });
    };
    off.onclick = function () {
      navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (s) {
        if (!s) return;
        var ep = s.endpoint;
        return s.unsubscribe().then(function () { return post("push-unsubscribe", { endpoint: ep }); });
      }).then(function () { setUi(false); show("Turned off for this device."); }).catch(function (e) { show(e.message, true); });
    };
  })();

  // ---- Pretty names and facts
  var isPhone = function (s) { return /^\+?[\d\s()-]{6,}$/.test(String(s || "").trim()); };
  function prettyPhone(s) {
    var d = String(s || "").replace(/[^\d]/g, "");
    if (!d) return String(s || "");
    var cc = d.length > 10 ? d.slice(0, d.length - 9) : "", rest = cc ? d.slice(cc.length) : d;
    return (cc ? "+" + cc + " " : "") + rest.replace(/(\d{3})(?=\d)/g, "$1 ").trim();
  }
  function dname(name, contact) { var n = name || contact || "Diver"; return isPhone(n) ? prettyPhone(n) : n; }
  var LANGN = { en: "English", nl: "Dutch", fr: "French", de: "German", es: "Spanish", it: "Italian", pt: "Portuguese", th: "Thai" };
  function langName(v) { var s = String(v || "").trim(); return LANGN[s.toLowerCase()] || (s.length <= 3 ? s.toUpperCase() : s.charAt(0).toUpperCase() + s.slice(1)); }
  function human(v) { var s = String(v || "").replace(/_/g, " ").trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }
  function prettyDates(v) {
    var s = String(v || "");
    return s.replace(/(\d{4})-(\d{2})-(\d{2})/g, function (m) { return new Date(m + "T12:00:00Z").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }); });
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
    var h = new Date().getHours(), part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
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
    $("#tDate").textContent = new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Bangkok" }) + " · " + cfg.center;
    loadNight();
    api("conversations?view=open").then(function (d) {
      var need = d.conversations.filter(function (c) { return c.needsYou; });
      var open = d.conversations.length;
      $("#tNeed").innerHTML = '<div class="th"><b>Needs your team</b>' + (need.length ? '<span class="tag need">' + need.length + "</span>" : "") + '<a href="#" class="tlink" id="tAllChats">All chats (' + open + ")</a></div>" +
        (need.length ? need.slice(0, 5).map(function (c) {
          return '<button class="trow" data-chat="' + esc(c.id) + '">' + avatar(c.name, c.cc) + '<span class="tr-b"><b>' + esc(dname(c.name)) + "</b><small>" + esc(String(c.preview || "").slice(0, 90)) + '</small></span><span class="tr-t">' + ago(c.lastAt) + "</span></button>";
        }).join("") : '<p class="tok"><span class="okdot"></span>Nothing waiting. ' + esc(cfg.assistant) + " is handling every conversation.</p>");
      $("#tNeed").querySelectorAll("[data-chat]").forEach(function (b) { b.onclick = function () { goChat(b.dataset.chat); }; });
      $("#tAllChats").onclick = function (e) { e.preventDefault(); document.querySelector('nav button[data-v="convos"]').click(); };
    }).catch(function () { $("#tNeed").innerHTML = '<div class="th"><b>Needs your team</b></div><p class="tok">Couldn\'t load conversations.</p>'; });
    api("bookings").then(function (d) {
      var live = d.bookings.filter(function (b) { return !isCx(b); });
      var day = function (iso) {
        var g = {};
        live.filter(function (b) { return b.date === iso; }).forEach(function (b) { g[b.product] = g[b.product] || { divers: 0, n: 0 }; g[b.product].divers += b.divers; g[b.product].n++; });
        return Object.keys(g).map(function (k) { return [k, g[k]]; }).sort(function (a, b) { return b[1].divers - a[1].divers; });
      };
      var block = function (label, iso) {
        var rows = day(iso), tot = rows.reduce(function (a, r) { return a + r[1].divers; }, 0);
        return '<div class="tday"><div class="tdh"><b>' + label + '</b><small>' + esc(dayLabel(iso)) + (tot ? " · " + tot + (tot === 1 ? " diver" : " divers") : "") + "</small></div>" +
          (rows.length ? rows.map(function (r) { return '<div class="tboat"><span>' + esc(r[0]) + "</span><b>" + r[1].divers + (r[1].divers === 1 ? " diver" : " divers") + "</b></div>"; }).join("") : '<p class="tok">No bookings via ' + esc(cfg.assistant) + " yet.</p>") + "</div>";
      };
      $("#tBoats").innerHTML = '<div class="th"><b>On the boat</b><a href="#" class="tlink" id="tPrint">Boat list</a></div>' + block("Today", d.today) + block("Tomorrow", d.tomorrow);
      $("#tPrint").onclick = function (e) { e.preventDefault(); goBookings("today"); };
      var next = [], max = 1;
      for (var i = 0; i < 7; i++) { var iso = addDays(d.today, i); var dv = live.filter(function (b) { return b.date === iso; }).reduce(function (a, b) { return a + b.divers; }, 0); next.push([iso, dv]); max = Math.max(max, dv); }
      var total = next.reduce(function (a, x) { return a + x[1]; }, 0);
      $("#tWeek").innerHTML = '<div class="th"><b>Next 7 days</b><small>' + total + (total === 1 ? " diver" : " divers") + ' booked</small><a href="#" class="tlink" id="tCal">Calendar</a></div><div class="tbars">' +
        next.map(function (x) { return '<div class="tb"><span class="tbv">' + (x[1] || "") + '</span><span class="tbb" style="height:' + Math.max(4, Math.round(x[1] / max * 70)) + 'px"></span><small>' + new Date(x[0] + "T12:00:00Z").toLocaleDateString([], { weekday: "short" }) + "</small></div>"; }).join("") + "</div>";
      $("#tCal").onclick = function (e) { e.preventDefault(); goBookings("calendar"); };
    }).catch(function () { $("#tBoats").innerHTML = '<div class="th"><b>On the boat</b></div><p class="tok">Couldn\'t load bookings.</p>'; $("#tWeek").innerHTML = ""; });
    api("arriving").then(function (d) {
      var n = d.items.length;
      $("#tArr").innerHTML = '<div class="th"><b>Arriving soon, not booked</b>' + (n ? '<span class="tag lang">' + n + "</span>" : "") + '<a href="#" class="tlink" id="tArrAll">See all</a></div>' +
        (n ? d.items.slice(0, 3).map(function (i) {
          return '<div class="trow static">' + avatar(i.name || i.phone, "") + '<span class="tr-b"><b>' + esc(i.name || i.phone || "Diver") + "</b><small>" + esc(i.interested || "Interested") + " · " + (i.here ? "on the island now" : "arrives " + esc(new Date(i.from + "T12:00:00Z").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }))) + "</small></span></div>";
        }).join("") : '<p class="tok">Nobody without a booking arrives in the next 14 days.</p>');
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
    $("#bcards").innerHTML = '<div class="cardn"><small>Divers next 14 days</small><b>' + total + "</b></div>" +
      '<div class="cardn"><small>Busiest day</small><b>' + (function () { var best = null; days.forEach(function (dd) { var v = live.filter(function (b) { return b.date === dd; }).reduce(function (a, b) { return a + b.divers; }, 0); if (!best || v > best[1]) best = [dd, v]; }); return best && best[1] ? esc(new Date(best[0] + "T12:00:00Z").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })) : "–"; })() + "</b></div>";
    $("#blist").innerHTML = '<div class="cal">' + days.map(function (dd, idx) {
      var g = {};
      live.filter(function (b) { return b.date === dd; }).forEach(function (b) { g[b.product] = g[b.product] || { divers: 0, n: 0 }; g[b.product].divers += b.divers; g[b.product].n++; });
      var keys = Object.keys(g).sort(function (a, b) { return g[b].divers - g[a].divers; });
      var tot = keys.reduce(function (a, k2) { return a + g[k2].divers; }, 0);
      var dt = new Date(dd + "T12:00:00Z");
      return '<div class="cday' + (idx === 0 ? " today" : "") + (dt.getUTCDay() === 0 || dt.getUTCDay() === 6 ? " wk" : "") + '"><div class="cdh"><small>' + dt.toLocaleDateString([], { weekday: "short" }) + "</small><b>" + dt.getUTCDate() + "</b>" + (tot ? '<span class="ctot">' + tot + "</span>" : "") + "</div>" +
        (keys.length ? keys.map(function (k2) { return '<div class="cblk"><b>' + esc(k2) + "</b><small>" + g[k2].divers + (g[k2].divers === 1 ? " diver" : " divers") + "</small></div>"; }).join("") : '<div class="cnone">–</div>') + "</div>";
    }).join("") + "</div>";
  }

  // ---- Milestones
  var MS_LABEL = {
    divers: function (v) { return v.toLocaleString("en-US") + " divers booked through Talay"; },
    revenue: function (v) { return v.toLocaleString("en-US") + " THB booked through Talay"; },
    conversations: function (v) { return v.toLocaleString("en-US") + " conversations answered"; },
  };
  function ordinalDay(iso) { return new Date(iso).toLocaleDateString([], { day: "numeric", month: "long" }); }
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
      var prog = goal ? '<div class="msprog"><span style="width:' + Math.min(100, Math.round(have / goal * 100)) + '%"></span></div><small>' + have.toLocaleString("en-US") + " of " + goal.toLocaleString("en-US") + " divers · " + (goal - have).toLocaleString("en-US") + " to go</small>" : "";
      var head = latest ? "<b>" + esc(MS_LABEL[latest.k](latest.value)) + "</b><small>Reached on " + esc(ordinalDay(latest.at)) + "</small>" :
        "<b>Your first milestone: 10 divers through Talay</b><small>Every booking through " + esc(cfg.assistant) + " counts.</small>";
      var html = '<div class="msicon">' + trophy + '</div><div class="msbody">' + head + prog + "</div>";
      var dash = $("#ms"); dash.innerHTML = html; dash.hidden = false;
      var recent = latest && (Date.now() - Date.parse(latest.at)) < 7 * 86400000;
      var chat = $("#msChat");
      if (recent) { chat.innerHTML = '<div class="msicon">' + trophy + '</div><div class="msbody"><b>' + esc(MS_LABEL[latest.k](latest.value)) + "</b><small>Reached on " + esc(ordinalDay(latest.at)) + "</small></div>"; chat.hidden = false; }
      else chat.hidden = true;
    }).catch(function () {});
  }
  loadMilestones(); setInterval(function () { if (!document.hidden) loadMilestones(); }, 1800000);

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
      stat(Math.round(d.revenue).toLocaleString("en-US"), "THB booked") + '</div>' +
      '<p class="nline">' + line + '</p>';
  }
  function loadNight(fresh) {
    return api("overnight" + (fresh ? "?fresh=1" : "")).then(function (d) {
      if (!d || d.error) return;
      var h = nightHtml(d);
      ["#nightDash", "#nightToday"].forEach(function (s) { var el = $(s); if (el) { el.innerHTML = h; el.hidden = false; } });
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
        ["Check your prices and products", seen, "sett"],
        ["Set your office hours", !!s.hoursText, "sett"],
        ["Add your team", (s.staff || []).length > 1, "sett"],
        ["Turn on notifications on this device", push, "sett"],
      ];
      var done = items.filter(function (i) { return i[1]; }).length;
      if (done === items.length) { el.hidden = true; return; }
      el.innerHTML = '<div class="sh"><b>Get started with Talay</b><small>' + done + " of " + items.length + ' done</small><button type="button" class="lnk3" id="startHide">Hide</button></div>' +
        '<div class="sprog"><span style="width:' + Math.round(done / items.length * 100) + '%"></span></div>' +
        '<ul class="slist">' + items.map(function (i) {
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
        sel.innerHTML = '<option value="">Last 30 days</option>' + d.months.map(function (m) { return '<option value="' + m.value + '">' + esc(m.label) + "</option>"; }).join("");
      }
      renderDash();
    }).catch(function (e) { $("#dbody").style.opacity = ""; if (e.message !== "auth") $("#dbody").innerHTML = '<div class="bempty">' + esc(e.message) + "</div>"; });
  }
  function funnelHtml(f) {
    if (!f) return "";
    var steps = [
      ["Conversations", f.conversations, "divers who wrote"],
      ["Got a booking link", f.linkSent, "from " + esc(cfg.assistant) + " or your team"],
      ["Opened the payment page", f.opened, "chose a date and divers"],
      ["Booked", f.booked, "paid the deposit"],
    ];
    var top = Math.max(1, f.conversations);
    var html = steps.map(function (s, i) {
      var w = Math.max(4, Math.round(s[1] / top * 100));
      var prev = i ? steps[i - 1][1] : 0;
      var conv = i ? '<span class="fpct" title="of the step before">' + (prev ? Math.round(s[1] / prev * 100) + "% of previous" : "–") + "</span>" : "";
      return '<div class="fstep">' + conv + '<div class="fbar"><span style="width:' + w + '%"></span></div>' +
        '<b>' + s[1] + '</b><small>' + s[0] + '</small><em>' + s[2] + "</em></div>";
    }).join("");
    var lost = Math.max(0, f.opened - f.booked);
    var tip = lost ? lost + " " + (lost === 1 ? "diver" : "divers") + " opened the payment page but didn't pay. See <b>Bookings → Not paid yet</b> to send a reminder." : "Nobody dropped off at the payment page in this period.";
    return '<div class="panel funnel"><h4>From question to booking</h4><div class="fsteps">' + html + '</div><p class="hnote">' + tip + "</p></div>";
  }
  function flag(cc) { return String(cc || "").toUpperCase().replace(/./g, function (c) { return String.fromCodePoint(127397 + c.charCodeAt(0)); }); }
  function heatAndCountries(d) {
    if (!d.heat) return "";
    var days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], max = 1, total = 0;
    d.heat.forEach(function (r) { r.forEach(function (v) { max = Math.max(max, v); total += v; }); });
    var best = null;
    d.heat.forEach(function (r, di) { for (var h = 0; h < 24; h += 3) { var s = r[h] + r[h + 1] + r[h + 2]; if (!best || s > best.s) best = { s: s, d: di, h: h }; } });
    var cells = d.heat.map(function (r, di) {
      return '<span class="hd">' + days[di] + "</span>" + r.map(function (v, h) {
        var a = v ? 0.18 + 0.82 * v / max : 0;
        return '<i title="' + days[di] + " " + String(h).padStart(2, "0") + ":00 · " + v + " new " + (v === 1 ? "diver" : "divers") + '" style="background:' + (v ? "rgba(220,164,74," + a.toFixed(2) + ")" : "var(--paper)") + '"></i>';
      }).join("");
    }).join("");
    var hours = '<span></span>' + [0, 3, 6, 9, 12, 15, 18, 21].map(function (h) { return '<span class="hh" style="grid-column:span 3">' + String(h).padStart(2, "0") + "</span>"; }).join("");
    var note = total && best && best.s ? "Busiest: " + days[best.d] + " " + String(best.h).padStart(2, "0") + ":00–" + String(best.h + 3).padStart(2, "0") + ":00 (Koh Tao time)." : "No new divers in this period yet.";
    var cmax = Math.max(1, d.countries.length ? d.countries[0][2] : 1);
    var ctry = d.countries.length ? d.countries.map(function (c) {
      return '<div class="barrow"><span class="lb lbw"><span class="flag">' + flag(c[0]) + "</span> " + esc(c[1]) + '</span><span class="bar" style="width:' + (c[2] / cmax * 60) + '%"></span><span>' + c[2] + "</span></div>";
    }).join("") : '<div class="bempty">No phone numbers yet.</div>';
    return '<div class="grid2"><div class="panel"><h4>When new divers write</h4><div class="heat">' + hours + cells + '</div><p class="hnote">' + note + "</p></div>" +
      '<div class="panel"><h4>Where your divers come from</h4>' + ctry + '<p class="hnote">Based on the country code of their phone number.</p></div></div>';
  }
  function renderDash() {
    var d = ddata, k = d.kpi;
    var P = d.kpiPrev;
    var tr = function (key, lowerBetter) {
      if (!P || P[key] == null || k[key] == null) return "";
      var a = Number(k[key]), b = Number(P[key]);
      if (!b && !a) return "";
      if (!b) return '<em class="trend up">New</em>';
      var ch = Math.round((a - b) / b * 100);
      if (!ch) return '<em class="trend flat">= vs previous</em>';
      var good = lowerBetter ? ch < 0 : ch > 0;
      return '<em class="trend ' + (good ? "up" : "down") + '">' + (ch > 0 ? "↑ " : "↓ ") + Math.abs(ch) + "% vs previous</em>";
    };
    var kp = function (label, val, sub, hi, key, lowerBetter) { return '<div class="kpi' + (hi ? " hi" : "") + '"><small>' + label + "</small><b>" + val + "</b>" + (key ? tr(key, lowerBetter) : "") + (sub ? "<span>" + sub + "</span>" : "") + "</div>"; };
    var maxW = Math.max(1, Math.max.apply(null, d.weeks.map(function (w) { return Math.max(w.conversations, w.bookings); })));
    var W = Math.max(d.weeks.length, 1), bw = 100 / W;
    var bars = d.weeks.map(function (w, i) {
      var h1 = w.conversations / maxW * 100, h2 = w.bookings / maxW * 100, x = i * bw;
      return '<rect x="' + (x + bw * 0.12) + '" y="' + (100 - h1) + '" width="' + (bw * 0.36) + '" height="' + h1 + '" fill="#4E7480" rx="1"><title>' + w.conversations + " conversations</title></rect>" +
        '<rect x="' + (x + bw * 0.52) + '" y="' + (100 - h2) + '" width="' + (bw * 0.36) + '" height="' + h2 + '" fill="#DCA44A" rx="1"><title>' + w.bookings + " bookings</title></rect>";
    }).join("");
    var labels = d.weeks.map(function (w) { return '<span style="flex:1;text-align:center">' + new Date(w.week + "T12:00:00Z").toLocaleDateString([], { day: "numeric", month: "short" }) + "</span>"; }).join("");
    var langMax = Math.max(1, d.languages.length ? d.languages[0][1] : 1);
    var html =
      '<div class="kpis">' +
        kp("Revenue via " + esc(cfg.assistant), thb(k.revenue), k.bookings + " bookings · " + k.divers + " divers", true, "revenue") +
        kp("Conversations", k.conversations, k.outsideHours + " outside office hours (" + pct(k.outsideHours, k.conversations) + ")", false, "conversations") +
        kp("Booking conversion", k.conversion + "%", k.afterFollowUp + " booked after a follow-up", false, "conversion") +
        kp(esc(cfg.assistant) + "'s response time", fmtSec(k.avgResponse), "average first reply", false, "avgResponse", true) +
        kp("Handed over to your team", k.handedOver, pct(k.handedOver, k.conversations) + " of conversations") +
        kp("Collected at your shop", thb(k.atShop), "balance paid on arrival", false, "atShop") +
      "</div>" + funnelHtml(d.funnel) +
      '<div class="grid2"><div class="panel"><h4>Per week</h4><div class="legend"><span><i style="background:#4E7480"></i>Conversations</span><span><i style="background:#DCA44A"></i>Bookings</span></div>' +
        '<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:160px;display:block">' + bars + "</svg>" +
        '<div style="display:flex;font-size:11px;color:var(--muted);margin-top:4px">' + labels + "</div></div>" +
        '<div class="panel"><h4>Languages</h4>' + (d.languages.length ? d.languages.map(function (l) {
          return '<div class="barrow"><span class="lb">' + esc(l[0]) + '</span><span class="bar" style="width:' + (l[1] / langMax * 70) + '%"></span><span>' + l[1] + "</span></div>"; }).join("") : '<div class="bempty">No conversations yet.</div>') + "</div></div>" +
      heatAndCountries(d) +
      (d.products.length ? '<div class="panel" style="margin-bottom:14px"><h4>Bookings per product</h4><div class="bscroll"><table class="btable"><thead><tr><th>Product</th><th class="num">Bookings</th><th class="num">Divers</th><th class="num">Value</th></tr></thead><tbody>' +
        d.products.map(function (p) { return "<tr><td>" + esc(p[0]) + '</td><td class="num">' + p[1].bookings + '</td><td class="num">' + p[1].divers + '</td><td class="num">' + thb(p[1].value) + "</td></tr>"; }).join("") + "</tbody></table></div></div>" : "") +
      '<div class="panel"><div class="st-head"><h2 style="margin:0">Talay statement · ' + esc(d.center) + "</h2><p>" + esc(d.label) + "</p></div>" +
        "<h4>Statement · " + esc(d.label) + "</h4>" +
        '<p style="font-size:13px;color:var(--muted);margin:0 0 10px">Talay\'s commission is the online deposit the diver pays when booking; your team collects the rest at the shop. Nothing to transfer: this is your overview.</p>' +
        (d.statement.length ? '<div class="bscroll"><table class="btable"><thead><tr><th>Booked</th><th>Ref</th><th>Diver</th><th>Product</th><th>Dive date</th><th class="num">Divers</th><th class="num">Value</th><th class="num">Commission</th><th>Status</th></tr></thead><tbody>' +
          d.statement.map(function (r) {
            return '<tr class="' + (r.cancelled ? "cx" : "") + '"><td>' + new Date(r.created).toLocaleDateString([], { day: "numeric", month: "short" }) + "</td><td>" + esc(r.ref) + "</td><td>" + esc(r.name) + "</td><td>" + esc(r.product) + "</td><td>" + (r.date ? esc(dayLabel(r.date)) : "") +
              '</td><td class="num">' + r.divers + '</td><td class="num">' + thb(r.total) + '</td><td class="num">' + thb(r.commission) + '</td><td class="keep">' + esc(r.status) + (r.refunded ? "<br><small>Refunded " + thb(r.refunded) + "</small>" : "") + "</td></tr>";
          }).join("") +
          '<tr><td colspan="6"><b>Total</b></td><td class="num"><b>' + thb(k.revenue) + '</b></td><td class="num"><b>' + thb(k.commission - k.refunded) + "</b></td><td>" + (k.refunded ? "after " + thb(k.refunded) + " refunded" : "") + "</td></tr>" +
          "</tbody></table></div>" : '<div class="bempty">No bookings in this period.</div>') + "</div>";
    $("#dbody").innerHTML = html;
  }
  $("#stPrint").onclick = function () {
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
  function renderTickets() {
    if (!tdata) return;
    var list = tdata.tickets.filter(function (t) { return tfilter === "done" ? t.status === "Done" : t.status !== "Done"; });
    if (!list.length) {
      $("#tbody").innerHTML = tfilter === "done" ? '<div class="bempty">No closed tickets yet.</div>' :
        '<div class="empty-card"><div class="eic"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><path d="m9 11 2 2 4-4"/></svg></div>' +
        "<b>No open tickets. All good.</b><p>Something not working, a wrong answer from " + esc(cfg.assistant) + ", or an idea for Talay? Click <b>New ticket</b>, or <b>Report</b> under any message from " + esc(cfg.assistant) + ". We reply here.</p></div>";
      return;
    }
    $("#tbody").innerHTML = '<div class="tlist">' + list.map(function (t) {
      return '<button class="titem" data-tid="' + esc(t.id) + '"><div class="tt"><b>' + (t.number ? "#" + esc(t.number) + " · " : "") + esc(t.title) + "</b><small>" +
        esc(t.type) + (t.priority === "Urgent" ? " · Urgent" : "") + " · " + esc(t.by) + " · updated " + ago(t.updated) + (ago(t.updated) === "now" ? "" : " ago") +
        '</small></div><span class="' + tsClass(t.status) + '">' + esc(t.status) + "</span></button>";
    }).join("") + "</div>";
    $("#tbody").querySelectorAll("[data-tid]").forEach(function (b) { b.onclick = function () { openTicket(b.dataset.tid); }; });
  }
  function newTicket(pre) {
    document.querySelector('nav button[data-v="supp"]').click();
    tview = "new";
    $("#tbody").innerHTML = '<div class="scard"><h3>New ticket</h3><p class="d">Tell Talay what\'s wrong or what you\'d like. Jonas gets it right away and answers here.</p>' +
      '<div class="tform"><div class="two"><label>Type<select id="nType">' + TYPES.map(function (t) { return "<option" + (t === (pre.type || "Question") ? " selected" : "") + ">" + t + "</option>"; }).join("") + "</select></label>" +
      '<label>Priority<select id="nPrio"><option>Low</option><option selected>Normal</option><option>Urgent</option></select></label></div>' +
      '<label>Title<input id="nTitle" maxlength="140" value="' + esc(pre.title || "") + '"></label>' +
      '<label>What happened, or what would you like?<textarea id="nDesc" placeholder="' + (pre.type === "Wrong answer" ? "What should " + esc(cfg.assistant) + " have answered?" : "Be as concrete as you can.") + '"></textarea></label>' +
      (pre.context ? '<label>Conversation<div class="ctx" id="nCtx">' + esc(pre.context) + "</div></label>" : "") +
      '<div class="srow"><button class="btn" id="nSend" type="button">Send ticket</button><button class="ghost" id="nCancel" type="button">Cancel</button></div><div class="smsg" id="nMsg"></div></div></div>';
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
      var html = '<div class="scard"><div class="srow" style="margin-bottom:8px"><button class="ghost" id="tBack" type="button">‹ All tickets</button><span class="sp" style="flex:1"></span><span class="' + tsClass(t.status) + '">' + esc(t.status) + "</span></div>" +
        "<h3>" + (t.number ? "#" + esc(t.number) + " · " : "") + esc(t.title) + '</h3><p class="d">' + esc(t.type) + " · " + esc(t.priority) + " · opened by " + esc(t.by) + " · " + esc(clock(t.created)) + "</p>" +
        (t.description ? '<div class="tmsg" style="margin-bottom:10px">' + esc(t.description) + "</div>" : "") +
        (t.context ? '<div class="ctx" style="margin-bottom:10px">' + esc(t.context) + "</div>" : "") +
        (t.contact ? '<p style="margin:0 0 10px"><a href="#" id="tChat">Open the conversation</a></p>' : "") +
        (t.quote ? '<div class="quote" style="margin-bottom:10px"><b>Quote from Talay</b><div style="white-space:pre-wrap;margin-top:4px">' + esc(t.quote) + "</div>" +
          (t.approved ? '<p style="margin:8px 0 0"><span class="ts Done">Approved</span></p>' : '<p style="margin:8px 0 0"><button class="btn" id="tApprove" type="button">Approve quote</button></p>') + "</div>" : "") +
        '<div style="display:grid;gap:8px;margin-bottom:12px">' + d.messages.map(function (m) {
          return '<div class="tmsg' + (m.talay ? " talay" : "") + '"><small>' + (m.talay ? "Talay" : esc(m.author)) + " · " + esc(clock(m.at)) + "</small>" + esc(m.text) + "</div>";
        }).join("") + "</div>" +
        '<div class="tform"><textarea id="tReply" placeholder="Write a message to Talay…"></textarea><div class="srow"><button class="btn" id="tSend" type="button">Send</button>' +
        (t.status !== "Done" ? '<button class="ghost" id="tClose" type="button">Mark as solved</button>' : "") + '</div><div class="smsg" id="tMsg"></div></div></div>';
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
      if ($("#tApprove")) $("#tApprove").onclick = function () { if (confirm("Approve this quote?")) act("ticket-approve", { id: id }); };
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
    bar.innerHTML = '<span>📲 ' + (deferredInstall ? "Install " + esc(cfg.center) + " as an app on this device." : "Add this to your home screen: tap <b>Share</b>, then <b>Add to Home Screen</b>.") + "</span>" +
      (deferredInstall ? '<button class="btn" id="instGo" type="button">Install</button>' : "") + '<button class="lnk2" id="instX" type="button" aria-label="Close">✕</button>';
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
  // Polling is kept light on purpose (Airtable limits): the list every 30 s while the page
  // is visible; the open conversation only when the list shows something new in it.
  setInterval(function () { if (!document.hidden) loadList(); }, 30000);
  loadNight(); setInterval(function () { if (!document.hidden) loadNight(); }, 600000);
  setInterval(function () { if (!document.hidden && filter !== "open" && filter !== "need") api("conversations?view=open").then(function (d) { badge(d.conversations); }).catch(function () {}); }, 60000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { lastList = ""; loadList(); } });
}
