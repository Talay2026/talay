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
      return json(await cached(env, `dash/${center.slug}/${per || "30d"}`, 300, () => dashboard(env, center, per), fresh));
    }
    if (p === "/zone/api/unfinished") return json(await cached(env, `unf/${center.slug}`, 180, () => unfinished(env, center), fresh));
    if (p === "/zone/api/tickets") return json(await cached(env, `tick/${center.slug}`, 30, () => tickets(env, center), fresh));
    if (p === "/zone/api/ticket" && request.method === "GET") return json(await ticketDetail(env, center, url.searchParams.get("id")));
    if (p === "/zone/api/ticket" && request.method === "POST") return await ticketAction(request, env, center, email, "create");
    if (p === "/zone/api/ticket-message" && request.method === "POST") return await ticketAction(request, env, center, email, "message");
    if (p === "/zone/api/ticket-approve" && request.method === "POST") return await ticketAction(request, env, center, email, "approve");
    if (p === "/zone/api/ticket-close" && request.method === "POST") return await ticketAction(request, env, center, email, "close");
    if (p === "/zone/api/settings" && request.method === "GET") return json(await settings(env, center));
    if (p === "/zone/api/settings" && request.method === "POST") return await saveSettings(request, env, center, email);
    if (request.method === "POST") {
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
      id: c.id, name: lead.name, language: lead.language, status: lead.status,
      needsYou: open && handover > teamAt && !lead.optedOut,
      teamActive: lead.human, open,
      preview: String(c.last.text).slice(0, 140), previewDir: c.last.dir, lastAt: c.last.at,
      closesAt: closes ? new Date(closes).toISOString() : null,
      hay: (lead.name.toLowerCase() + " " + c.hay).slice(0, 3000),
    };
  });
  list.sort((a, b) => (b.needsYou - a.needsYou) || (Date.parse(b.lastAt) - Date.parse(a.lastAt)));
  return { conversations: list, needsCount: list.filter((c) => c.needsYou).length };
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
  const teamAt = Math.max(Date.parse(lastTeam?.at || 0) || 0, Date.parse(lead.humanAt || 0) || 0);
  const handover = Date.parse(lead.handoverAt || 0) || 0;
  return {
    id, lead, hasLead: !!leads[id], messages, closesAt, canReply,
    needsYou: canReply && handover > teamAt && !lead.optedOut,
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

async function dashboard(env, center, period) {
  const { start, end, label, months } = periodRange(period);
  const iso = (ms) => new Date(ms).toISOString();
  const inPeriod = `IS_AFTER(CREATED_TIME(), '${iso(start - 1000)}'), IS_BEFORE(CREATED_TIME(), '${iso(end)}')`;
  const [leads, books] = await Promise.all([
    at(env, "Leads", { formula: `AND(FIND('${q(center.name)}', ARRAYJOIN({Center})), ${inPeriod})`, max: 5000 }),
    at(env, "Bookings", { formula: `AND(FIND('${q(center.name)}', ARRAYJOIN({Center})), ${inPeriod})`, max: 5000 }),
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
    languages: Object.entries(langs).sort((a, b) => b[1] - a[1]),
    products: Object.entries(prods).sort((a, b) => b[1].value - a[1].value),
    weeks: Object.values(weeks),
    statement,
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
    : `<svg width="28" height="28" viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="14" fill="#F4F0E6"/><path d="M1 15a14 14 0 0 0 28 0z" fill="#E8B04B"/></svg>`;
  const cfg = {
    qs: centers.length > 1 ? `?center=${encodeURIComponent(center.slug)}` : "",
    assistant: center.assistant, center: center.name, email,
  };

  return `<!doctype html><html lang="en"><head>${HEAD}
<title>${esc(center.name)} · Talay</title>
<style>
:root{--deep:#0A2029;--paper:#F4F0E6;--paper-2:#FBF8F1;--card:#fff;--muted:#55646A;--line:#E2DACB;--in:#fff;--mia:#E6F0F2;--team:#D9FDD3;--ok:#1F7A55;--warn:#B4561B;--sand:#E8B04B;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--deep:#F4F0E6;--paper:#0B1A20;--paper-2:#10252D;--card:#122A33;--muted:#9FB2B8;--line:#1F3D48;--in:#173540;--mia:#1B3B45;--team:#1E4A35;--ok:#3FB37F;--warn:#E69A5B;color-scheme:dark}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;background:var(--paper);color:var(--deep);font-family:"Schibsted Grotesk",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:16px;line-height:1.45;-webkit-font-smoothing:antialiased;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
header{display:flex;align-items:center;gap:12px;padding:12px 18px;background:#0A2029;color:#F4F0E6;flex:none}
header .logo{width:30px;height:30px;border-radius:50%;object-fit:cover;background:#F4F0E6}
header b{font-size:17px}
header .sp{flex:1}
header select{font:inherit;font-size:14px;border-radius:8px;padding:5px 8px;border:0}
header a,header button.lnk{color:#C9D4D7;font:inherit;font-size:14px;text-decoration:none;background:none;border:0;cursor:pointer;padding:0}
nav{display:flex;gap:4px;padding:8px 18px 0;border-bottom:1px solid var(--line);flex:none}
nav button{font:inherit;font-weight:700;font-size:15px;background:none;border:0;color:var(--muted);padding:10px 14px;border-bottom:3px solid transparent;cursor:pointer}
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
.items{overflow-y:auto;flex:1}
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
.compose{border-top:1px solid var(--line);padding:10px 16px 12px;display:flex;gap:10px;align-items:flex-end;background:var(--paper-2)}
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
.bwrap{width:100%;max-width:1000px;margin:0 auto;padding:16px 20px 40px}
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
.swrap{width:100%;max-width:760px;margin:0 auto;padding:18px 20px 48px;display:grid;gap:14px}
.scard{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 20px}
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
:focus-visible{outline:3px solid var(--sand);outline-offset:2px}
@media (max-width:760px){
  .list{width:100%;border-right:0}
  #convos.open .list{display:none}
  #convos:not(.open) .pane{display:none}
  .back{display:inline}
  .m{max-width:88%}
  .actions{margin-left:0;width:100%}
}
</style></head>
<body>
<header>${logo}<b>${esc(center.name)}</b><span class="sp"></span>${switcher}<button class="lnk" id="sound" type="button">🔔 Sound on</button><a href="/cdn-cgi/access/logout" title="${esc(email)}">Sign out</a></header>
<nav><button class="on" data-v="convos">Conversations<span class="count" id="count" hidden></span></button><button data-v="books">Bookings</button><button data-v="dash">Dashboard</button><button data-v="sett">Settings</button><button data-v="supp">Support<span class="count" id="tcount" hidden></span></button></nav>

<section id="convos" class="view on">
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
    <div class="items" id="list"><div class="empty">Loading…</div></div>
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
      <button class="chip" data-r="unfinished">Not paid yet<span class="count" id="ucount" hidden></span></button>
      <span class="sp"></span>
      <button class="ghost" id="print" type="button">Print list</button>
    </div>
    <div id="bcards" class="cards"></div>
    <div id="blist"><div class="bempty">Loading…</div></div>
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
    <div id="tbody"><div class="bempty">Loading…</div></div>
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
    <div id="dbody"><div class="bempty">Loading…</div></div>
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
  function setSoundLabel() { $("#sound").textContent = soundOn ? "🔔 Sound on" : "🔕 Sound off"; }
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
      if (b.dataset.v === "dash") loadDash();
      if (b.dataset.v === "books") loadBookings();
      if (b.dataset.v === "sett") loadSettings();
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
        '<div class="top"><span class="nm">' + esc(c.name || "Diver") + "</span>" +
        (c.needsYou ? '<span class="tag need">Needs you</span>' : "") +
        (c.teamActive ? '<span class="tag team">Team</span>' : "") +
        (/booked/i.test(c.status) ? '<span class="tag st">Booked</span>' : "") +
        (c.language ? '<span class="tag lang">' + esc(c.language) + "</span>" : "") +
        '<span class="tm">' + ago(c.lastAt) + "</span></div>" +
        '<div class="pv">' + esc(who + c.preview) + "</div>" +
        (l.t ? '<div class="left' + (l.soon ? " soon" : "") + '">' + l.t + "</div>" : "") + "</button>";
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
    $("#convos").classList.add("open");
    $("#pane").innerHTML = '<div class="placeholder">Loading…</div>';
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
      var facts = fact("Language", L.language && L.language.toUpperCase()) + fact("Level", L.cert) + fact("Dates", L.dates) +
        fact("Group", L.group) + fact("Interested in", L.interested) + fact("Status", L.status) + fact("WhatsApp", L.contact !== L.name ? L.contact : "") +
        (L.human ? "<span><b>Team is handling this.</b> " + esc(cfg.assistant) + " is paused for this diver.</span>" : "");

      $("#pane").innerHTML =
        '<div class="head"><button class="back" aria-label="Back">‹</button><div><b>' + esc(L.name || L.contact || "Diver") + "</b>" +
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
          ? '<div class="bar2"><span>Sign as</span><input id="sig" maxlength="30" placeholder="your name">' +
            '<select id="prod" aria-label="Booking link"><option value="">+ Booking link…</option></select>' +
            '<span class="sp"></span><span class="' + (l.soon ? "left soon" : "") + '">' + esc(l.t) + "</span></div>" +
            '<div class="compose"><textarea id="txt" placeholder="Reply on WhatsApp…" rows="2"></textarea><button class="btn" id="send">Send</button></div>' +
            '<div class="note" id="note">Ctrl/⌘ + Enter sends. A reply pauses ' + esc(cfg.assistant) + " for this diver until you let her take over (or 4 hours after your last message).</div>"
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
      $(".back").onclick = function () { current = null; $("#convos").classList.remove("open"); document.querySelectorAll(".item").forEach(function (b) { b.classList.remove("on"); }); };
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
        s.oninput = function () { try { localStorage.setItem("talay-sig", s.value); } catch (e) {} };
        t.onkeydown = function (e) { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); };
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
    b.disabled = true; b.textContent = "Sending…";
    post("reply", { c: current, text: v }).then(function () {
      t.value = ""; lastChat = ""; lastList = ""; freshNext = true; freshList = true; loadChat(true); loadList();
    }).catch(function (e) { n.textContent = e.message; n.className = "note err"; })
      .finally(function () { b.disabled = false; b.textContent = "Send"; });
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
            return '<tr class="' + (isCx(b) ? "cx" : "") + '"><td>' + esc(b.ref) + "</td><td>" + esc(b.name) + "</td><td>" + wa + '</td><td class="num">' + b.divers +
              '</td><td class="num">' + thb(b.deposit) + '</td><td class="num">' + (isCx(b) ? "–" : thb(b.balance)) + '</td><td class="keep">' + stTag(b) +
              (b.refunded ? '<br><small>Refunded ' + thb(b.refunded) + "</small>" : "") + '</td><td class="keep noprint">' + links.join(" · ") + "</td></tr>";
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
          '<td><input type="number" min="100" step="50" value="' + p.price + '" class="pp"></td>' +
          '<td class="muted dep">' + Math.round(p.deposit).toLocaleString("en-US") + " THB<br>" + p.pct + "%</td>" +
          '<td><select class="pc">' + hours + "</select></td>" +
          '<td><input type="checkbox" class="pa"' + (p.active ? " checked" : "") + "></td>" +
          '<td><button class="ghost ps" type="button">Save</button></td></tr>';
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
    if (!udata) { $("#bcards").innerHTML = ""; $("#blist").innerHTML = '<div class="bempty">Loading…</div>'; return; }
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
        return "<tr><td>" + who + "</td><td>" + esc(i.product) + "</td><td>" + esc(dayLabel(i.date)) + '</td><td class="num">' + i.divers +
          '</td><td class="num">' + thb(i.total) + "</td><td>" + (ago(i.at) === "now" ? "just now" : ago(i.at) + " ago") + '</td><td class="keep noprint">' + act.join(" · ") + "</td></tr>";
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

  // ---- dashboard
  var ddata = null;
  function fmtSec(s) { if (s == null) return "–"; if (s < 60) return s + " s"; return Math.floor(s / 60) + " min " + (s % 60) + " s"; }
  function pct(a, b) { return b ? Math.round(a / b * 100) + "%" : "–"; }
  $("#period").onchange = function () { loadDash(); };
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
  function renderDash() {
    var d = ddata, k = d.kpi;
    var kp = function (label, val, sub, hi) { return '<div class="kpi' + (hi ? " hi" : "") + '"><small>' + label + "</small><b>" + val + "</b>" + (sub ? "<span>" + sub + "</span>" : "") + "</div>"; };
    var maxW = Math.max(1, Math.max.apply(null, d.weeks.map(function (w) { return Math.max(w.conversations, w.bookings); })));
    var W = Math.max(d.weeks.length, 1), bw = 100 / W;
    var bars = d.weeks.map(function (w, i) {
      var h1 = w.conversations / maxW * 100, h2 = w.bookings / maxW * 100, x = i * bw;
      return '<rect x="' + (x + bw * 0.12) + '" y="' + (100 - h1) + '" width="' + (bw * 0.36) + '" height="' + h1 + '" fill="#9FB2B8" rx="1"><title>' + w.conversations + " conversations</title></rect>" +
        '<rect x="' + (x + bw * 0.52) + '" y="' + (100 - h2) + '" width="' + (bw * 0.36) + '" height="' + h2 + '" fill="#E8B04B" rx="1"><title>' + w.bookings + " bookings</title></rect>";
    }).join("");
    var labels = d.weeks.map(function (w) { return '<span style="flex:1;text-align:center">' + new Date(w.week + "T12:00:00Z").toLocaleDateString([], { day: "numeric", month: "short" }) + "</span>"; }).join("");
    var langMax = Math.max(1, d.languages.length ? d.languages[0][1] : 1);
    var html =
      '<div class="kpis">' +
        kp("Revenue via " + esc(cfg.assistant), thb(k.revenue), k.bookings + " bookings · " + k.divers + " divers", true) +
        kp("Conversations", k.conversations, k.outsideHours + " outside office hours (" + pct(k.outsideHours, k.conversations) + ")") +
        kp("Booking conversion", k.conversion + "%", k.afterFollowUp + " booked after a follow-up") +
        kp(esc(cfg.assistant) + "'s response time", fmtSec(k.avgResponse), "average first reply") +
        kp("Handed over to your team", k.handedOver, pct(k.handedOver, k.conversations) + " of conversations") +
        kp("Collected at your shop", thb(k.atShop), "balance paid on arrival") +
      "</div>" +
      '<div class="grid2"><div class="panel"><h4>Per week</h4><div class="legend"><span><i style="background:#9FB2B8"></i>Conversations</span><span><i style="background:#E8B04B"></i>Bookings</span></div>' +
        '<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:160px;display:block">' + bars + "</svg>" +
        '<div style="display:flex;font-size:11px;color:var(--muted);margin-top:4px">' + labels + "</div></div>" +
        '<div class="panel"><h4>Languages</h4>' + (d.languages.length ? d.languages.map(function (l) {
          return '<div class="barrow"><span class="lb">' + esc(l[0]) + '</span><span class="bar" style="width:' + (l[1] / langMax * 70) + '%"></span><span>' + l[1] + "</span></div>"; }).join("") : '<div class="bempty">No conversations yet.</div>') + "</div></div>" +
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
      $("#tbody").innerHTML = '<div class="bempty">' + (tfilter === "done" ? "No closed tickets yet." :
        "No open tickets. Something not working, a wrong answer from " + esc(cfg.assistant) + ", or an idea? Click <b>New ticket</b>, or <b>Report</b> under any message from " + esc(cfg.assistant) + ".") + "</div>";
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
    $("#tbody").innerHTML = '<div class="bempty">Loading…</div>';
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
  loadList();
  // Polling is kept light on purpose (Airtable limits): the list every 30 s while the page
  // is visible; the open conversation only when the list shows something new in it.
  setInterval(function () { if (!document.hidden) loadList(); }, 30000);
  setInterval(function () { if (!document.hidden && filter !== "open" && filter !== "need") api("conversations?view=open").then(function (d) { badge(d.conversations); }).catch(function () {}); }, 60000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { lastList = ""; loadList(); } });
}
