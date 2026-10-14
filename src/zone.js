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
    if (p === "/zone/api/conversations") {
      return json(await conversations(env, center, url.searchParams.get("view") === "all" ? "all" : "open"));
    }
    if (p === "/zone/api/chat") return json(publicChat(await chat(env, center, url.searchParams.get("c"))));
    if (p === "/zone/api/products") return json(await products(env, center, url.searchParams.get("c")));
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
      slug: String(first(r.fields["Slug"]) || "").toLowerCase(),
      name: first(r.fields["Name"]) || "Dive center",
      assistant: first(r.fields["Assistant name"]) || "Mia",
      logo: first(r.fields["Logo"])?.thumbnails?.large?.url || first(r.fields["Logo"])?.url || "",
    }))
    .filter((c) => /^[a-z0-9-]{1,60}$/.test(c.slug));
}

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
    if (!/^[A-Z0-9]{1,12}$/.test(code)) return null;
    const name = (lang !== "en" && first(p[`Name ${lang.toUpperCase()}`])) || first(p["Name"]) || code;
    const link = `https://talay.io/b/${center.slug}?p=${code}${ref ? `&c=${ref}` : ""}&l=${lang}`;
    return { code, name: first(p["Name"]) || code, price: Number(first(p["Price THB"])) || 0,
      text: LINK_TEXT[lang](name, link) };
  }).filter(Boolean);
  list.sort((a, b) => a.name.localeCompare(b.name));
  return { lang, products: list };
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
    assistant: center.assistant, center: center.name,
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
.item:hover,.item.on{background:var(--card)}
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
.pane .head b{font-size:17px}
.facts{display:flex;flex-wrap:wrap;gap:6px 14px;padding:10px 20px;border-bottom:1px solid var(--line);font-size:13px;color:var(--muted);background:var(--paper-2)}
.facts span b{color:var(--deep);font-weight:700}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
.ghost{font:inherit;font-size:13px;font-weight:700;border:1px solid var(--line);background:var(--card);color:var(--deep);border-radius:999px;padding:6px 12px;cursor:pointer}
.ghost:hover{border-color:var(--deep)}
.back{display:none;font:inherit;background:none;border:0;font-size:22px;color:var(--deep);cursor:pointer;padding:0 6px 0 0}
.msgs{flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:8px}
.m{max-width:78%;padding:8px 12px 20px;border-radius:12px;position:relative;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px}
.m.Customer{background:var(--in);align-self:flex-start;border-top-left-radius:3px;border:1px solid var(--line)}
.m.Mia{background:var(--mia);align-self:flex-end;border-top-right-radius:3px}
.m.Team{background:var(--team);align-self:flex-end;border-top-right-radius:3px}
.m small{position:absolute;right:10px;bottom:3px;font-size:11px;color:var(--muted)}
.m .who{display:block;font-size:11px;font-weight:800;color:var(--muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.04em}
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
<nav><button class="on" data-v="convos">Conversations<span class="count" id="count" hidden></span></button><button data-v="dash">Dashboard</button></nav>

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

<section id="dash" class="view">
  <div class="bar">Results via ${esc(center.assistant)}, live. <a href="https://airtable.com/appEXBMOJa73WiQHb/shrkzC7WhyMBUsEiO" target="_blank" rel="noopener">Open full screen</a></div>
  <iframe title="Dashboard" loading="lazy" data-src="https://airtable.com/embed/appEXBMOJa73WiQHb/shrkzC7WhyMBUsEiO"></iframe>
</section>

<script>   var __name = function (f) { return f; };(${zoneClient.toString()})(${JSON.stringify(cfg).replace(/</g, "\\u003c")});</script>
</body></html>`;
}

// Runs in the browser (inserted with toString), so it may not use anything from this module.
function zoneClient(cfg) {
  var current = null, lastList = "", lastChat = "", filter = "open", items = [], needSeen = null;
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
      if (b.dataset.v === "dash") { var f = $("#dash iframe"); if (!f.src) f.src = f.dataset.src; }
    };
  });

  // ---- list
  document.querySelectorAll(".chip").forEach(function (c) {
    c.onclick = function () {
      filter = c.dataset.f;
      document.querySelectorAll(".chip").forEach(function (x) { x.classList.toggle("on", x === c); });
      lastList = ""; loadList();
    };
  });
  $("#search").oninput = function () { render(); };

  function loadList() {
    var view = filter === "open" || filter === "need" ? "open" : "all";
    api("conversations?view=" + view).then(function (d) {
      if (view === "open") badge(d.conversations);
      var key = view + JSON.stringify(d.conversations);
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
    current = id; lastChat = "";
    document.querySelectorAll(".item").forEach(function (b) { b.classList.toggle("on", b.dataset.id === id); });
    $("#convos").classList.add("open");
    $("#pane").innerHTML = '<div class="placeholder">Loading…</div>';
    loadChat(true);
  }
  function fact(label, v) { return v ? "<span>" + label + " <b>" + esc(v) + "</b></span>" : ""; }

  function loadChat(scroll) {
    if (!current) return;
    var id = current;
    api("chat?c=" + encodeURIComponent(id)).then(function (d) {
      if (id !== current) return;
      var key = JSON.stringify([d.messages.length, d.canReply, d.needsYou, d.lead]);
      if (key === lastChat) return;
      var draft = $("#txt") ? $("#txt").value : "";
      lastChat = key;
      var L = d.lead, l = left(d.closesAt);
      var actions = "";
      if (d.hasLead && L.human) actions += '<button class="ghost" id="handback">Let ' + esc(cfg.assistant) + " take over</button>";
      if (d.hasLead && d.needsYou && !L.human) actions += '<button class="ghost" id="handled">Mark as handled</button>';
      var facts = fact("Language", L.language && L.language.toUpperCase()) + fact("Level", L.cert) + fact("Dates", L.dates) +
        fact("Group", L.group) + fact("Interested in", L.interested) + fact("Status", L.status) + fact("WhatsApp", L.contact) +
        (L.human ? "<span><b>Team is handling this.</b> " + esc(cfg.assistant) + " is paused for this diver.</span>" : "");

      $("#pane").innerHTML =
        '<div class="head"><button class="back" aria-label="Back">‹</button><b>' + esc(L.name || "Diver") + "</b>" +
        (d.needsYou ? '<span class="tag need">Needs you</span>' : "") + '<div class="actions">' + actions + "</div></div>" +
        (facts ? '<div class="facts">' + facts + "</div>" : "") +
        '<div class="msgs" id="msgs">' + d.messages.map(function (m) {
          var who = m.dir === "Customer" ? "" : (m.dir === "Team" ? "Team" : cfg.assistant);
          return '<div class="m ' + esc(m.dir) + '">' + (who ? '<span class="who">' + esc(who) + "</span>" : "") + esc(m.text) + "<small>" + esc(clock(m.at)) + "</small></div>";
        }).join("") + "</div>" +
        (d.canReply
          ? '<div class="bar2"><span>Sign as</span><input id="sig" maxlength="30" placeholder="your name">' +
            '<select id="prod" aria-label="Booking link"><option value="">+ Booking link…</option></select>' +
            '<span class="sp"></span><span class="' + (l.soon ? "left soon" : "") + '">' + esc(l.t) + "</span></div>" +
            '<div class="compose"><textarea id="txt" placeholder="Reply on WhatsApp…" rows="2"></textarea><button class="btn" id="send">Send</button></div>' +
            '<div class="note" id="note">Ctrl/⌘ + Enter sends. A reply pauses ' + esc(cfg.assistant) + " for this diver until you let her take over (or 4 hours after your last message).</div>"
          : '<div class="closed">More than 24 hours since the diver\'s last message, so WhatsApp no longer allows a free reply. Read only.</div>');

      $(".back").onclick = function () { current = null; $("#convos").classList.remove("open"); document.querySelectorAll(".item").forEach(function (b) { b.classList.remove("on"); }); };
      var box = $("#msgs");
      if (scroll || box.scrollHeight - box.scrollTop - box.clientHeight < 200) box.scrollTop = box.scrollHeight;
      if ($("#handback")) $("#handback").onclick = function () { act("handback", this); };
      if ($("#handled")) $("#handled").onclick = function () { act("handled", this); };
      if (d.canReply) {
        var t = $("#txt"), s = $("#sig");
        t.value = draft;
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
    post(kind, { c: current }).then(function () { lastChat = ""; lastList = ""; loadChat(false); loadList(); })
      .catch(function (e) { btn.disabled = false; alert(e.message); });
  }

  function send() {
    var t = $("#txt"), b = $("#send"), n = $("#note"), v = t.value.trim();
    if (!v || b.disabled) return;
    var sig = ($("#sig").value || "").trim(); if (sig) v += "\n– " + sig;
    b.disabled = true; b.textContent = "Sending…";
    post("reply", { c: current, text: v }).then(function () {
      t.value = ""; lastChat = ""; lastList = ""; loadChat(true); loadList();
    }).catch(function (e) { n.textContent = e.message; n.className = "note err"; })
      .finally(function () { b.disabled = false; b.textContent = "Send"; });
  }

  loadList();
  setInterval(function () { if (document.hidden) return; loadList(); loadChat(false); }, 10000);
  // Keep counting Needs you while the "All" or "Booked" view is open.
  setInterval(function () { if (!document.hidden && filter !== "open" && filter !== "need") api("conversations?view=open").then(function (d) { badge(d.conversations); }).catch(function () {}); }, 20000);
}
