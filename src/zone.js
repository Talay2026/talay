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
    if (p === "/zone/api/conversations") return json(await conversations(env, center));
    if (p === "/zone/api/chat") return json(await chat(env, center, url.searchParams.get("c")));
    if (p === "/zone/api/reply" && request.method === "POST") {
      return await reply(request, env, center);
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

async function leadsFor(env, ids) {
  if (!ids.length) return {};
  const recs = await at(env, "Leads", {
    formula: `OR(${ids.map((id) => `{External ID} & '' = '${q(id)}'`).join(",")})`,
  });
  const map = {};
  for (const r of recs) {
    const id = String(first(r.fields["External ID"]) || "");
    // Keep the most recently created lead per contact.
    if (!map[id] || Date.parse(r.createdTime) > Date.parse(map[id].createdTime)) map[id] = r;
  }
  return map;
}

function leadInfo(r) {
  const f = r?.fields || {};
  return {
    name: first(f["Name"]) || "",
    language: first(f["Language"]) || "",
    cert: first(f["Cert level"]) || "",
    status: first(f["Status"]) || "",
    handoverAt: first(f["Handover at"]) || "",
    humanAt: first(f["Human took over at"]) || "",
    human: !!f["Human took over"],
    optedOut: !!f["Opted out"],
  };
}

// ---------- API ----------

async function conversations(env, center) {
  const since = `DATEADD(NOW(), -${WINDOW_H}, 'hours')`;
  const rows = await at(env, "Chat", {
    formula: `AND({Center} = '${q(center.slug)}', IS_AFTER({Sent at}, ${since}))`,
    fields: ["Text", "Direction", "Contact ID", "Sent at"],
    sort: [{ field: "Sent at", direction: "desc" }],
  });

  const byContact = new Map();
  for (const r of rows) {
    const id = String(r.fields["Contact ID"] || "");
    if (!okId(id)) continue;
    const dir = r.fields["Direction"] || "";
    const at_ = r.fields["Sent at"] || r.createdTime;
    if (!byContact.has(id)) byContact.set(id, { id, last: null, lastCustomer: null, lastTeam: null });
    const c = byContact.get(id);
    if (!c.last) c.last = { text: r.fields["Text"] || "", dir, at: at_ };
    if (dir === "Customer" && !c.lastCustomer) c.lastCustomer = at_;
    if (dir === "Team" && !c.lastTeam) c.lastTeam = at_;
  }

  // Only conversations the team can still answer: a customer message in the last 24 h.
  const open = [...byContact.values()].filter((c) => c.lastCustomer);
  const leads = await leadsFor(env, open.map((c) => c.id));

  const list = open.map((c) => {
    const lead = leadInfo(leads[c.id]);
    const teamAt = Math.max(Date.parse(c.lastTeam || 0) || 0, Date.parse(lead.humanAt || 0) || 0);
    const handover = Date.parse(lead.handoverAt || 0) || 0;
    const needsYou = handover > 0 && handover > teamAt && !lead.optedOut;
    return {
      id: c.id,
      name: lead.name,
      language: lead.language,
      status: lead.status,
      needsYou,
      teamActive: lead.human,
      preview: String(c.last.text).slice(0, 140),
      previewDir: c.last.dir,
      lastAt: c.last.at,
      closesAt: new Date(Date.parse(c.lastCustomer) + WINDOW_H * 3600 * 1000).toISOString(),
    };
  });
  list.sort((a, b) => (b.needsYou - a.needsYou) || (Date.parse(b.lastAt) - Date.parse(a.lastAt)));
  return { center: center.name, conversations: list, now: new Date().toISOString() };
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
  const closesAt = lastCustomer
    ? new Date(Date.parse(lastCustomer.at) + WINDOW_H * 3600 * 1000).toISOString() : null;
  return {
    id, lead: leadInfo(leads[id]), messages, closesAt,
    canReply: !!closesAt && Date.parse(closesAt) > Date.now(),
  };
}

async function reply(request, env, center) {
  if (!env.RESPONDIO_TOKEN) return json({ error: "Replies are not set up yet." }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
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
  const leads = await leadsFor(env, [id]);
  if (leads[id]) {
    // Same effect as a staff message in respond.io: Mia goes quiet until Close or
    // "release handovers" gives the conversation back to her.
    writes.push(atWrite(env, "Leads", "PATCH", [{
      id: leads[id].id, fields: { "Human took over": true, "Human took over at": now },
    }]));
  }
  await Promise.all(writes);
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
  const qs = centers.length > 1 ? `?center=${encodeURIComponent(center.slug)}` : "";

  return `<!doctype html><html lang="en"><head>${HEAD}
<title>${esc(center.name)} · Talay</title>
<style>
:root{--deep:#0A2029;--deep-2:#173F4D;--sand:#E8B04B;--paper:#F4F0E6;--paper-2:#FBF8F1;--card:#fff;--muted:#55646A;--line:#E2DACB;--in:#fff;--mia:#E6F0F2;--team:#D9FDD3;--ok:#1F7A55;--warn:#B4561B;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--deep:#F4F0E6;--deep-2:#C9D4D7;--paper:#0B1A20;--paper-2:#10252D;--card:#122A33;--muted:#9FB2B8;--line:#1F3D48;--in:#173540;--mia:#1B3B45;--team:#1E4A35;--ok:#3FB37F;--warn:#E69A5B;color-scheme:dark}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--paper);color:var(--deep);font-family:"Schibsted Grotesk",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:16px;line-height:1.45;-webkit-font-smoothing:antialiased;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
header{display:flex;align-items:center;gap:12px;padding:12px 18px;background:#0A2029;color:#F4F0E6}
header .logo{width:30px;height:30px;border-radius:50%;object-fit:cover;background:#F4F0E6}
header b{font-size:17px}
header .sp{flex:1}
header select{font:inherit;font-size:14px;border-radius:8px;padding:5px 8px;border:0}
header a{color:#C9D4D7;font-size:14px;text-decoration:none}
nav{display:flex;gap:4px;padding:10px 18px 0;border-bottom:1px solid var(--line)}
nav button{font:inherit;font-weight:700;font-size:15px;background:none;border:0;color:var(--muted);padding:10px 14px;border-bottom:3px solid transparent;cursor:pointer}
nav button.on{color:var(--deep);border-bottom-color:var(--sand)}
.view{display:none;height:calc(100% - 112px)}
.view.on{display:flex}
#convos{gap:0}
.list{width:340px;flex:none;border-right:1px solid var(--line);overflow-y:auto;background:var(--paper-2)}
.list .empty{padding:28px 20px;color:var(--muted)}
.item{display:block;width:100%;text-align:left;font:inherit;color:inherit;background:none;border:0;border-bottom:1px solid var(--line);padding:14px 18px;cursor:pointer}
.item:hover,.item.on{background:var(--card)}
.item .top{display:flex;align-items:center;gap:8px}
.item .nm{font-weight:700;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .tm{font-size:12px;color:var(--muted)}
.item .pv{font-size:14px;color:var(--muted);margin-top:3px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.tag{font-size:11px;font-weight:800;border-radius:999px;padding:2px 8px;white-space:nowrap}
.tag.need{background:var(--sand);color:#0A2029}
.tag.team{background:var(--team);color:var(--deep)}
.tag.lang{background:var(--line);color:var(--deep);text-transform:uppercase}
.left{font-size:12px;color:var(--muted);margin-top:4px}
.left.soon{color:var(--warn);font-weight:700}
.pane{flex:1;display:flex;flex-direction:column;min-width:0}
.pane .head{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pane .head b{font-size:17px}
.pane .head .meta{color:var(--muted);font-size:14px}
.back{display:none;font:inherit;background:none;border:0;font-size:22px;color:var(--deep);cursor:pointer;padding:0 6px 0 0}
.msgs{flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:8px}
.m{max-width:78%;padding:8px 12px 20px;border-radius:12px;position:relative;white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px}
.m.Customer{background:var(--in);align-self:flex-start;border-top-left-radius:3px;border:1px solid var(--line)}
.m.Mia{background:var(--mia);align-self:flex-end;border-top-right-radius:3px}
.m.Team{background:var(--team);align-self:flex-end;border-top-right-radius:3px}
.m small{position:absolute;right:10px;bottom:3px;font-size:11px;color:var(--muted)}
.m .who{display:block;font-size:11px;font-weight:800;color:var(--muted);margin-bottom:2px;text-transform:uppercase;letter-spacing:.04em}
.compose{border-top:1px solid var(--line);padding:12px 16px;display:flex;gap:10px;align-items:flex-end;background:var(--paper-2)}
.compose textarea{flex:1;font:inherit;font-size:15px;min-height:44px;max-height:160px;resize:vertical;border:1px solid var(--line);border-radius:12px;padding:10px 12px;background:var(--card);color:var(--deep)}
.btn{font:inherit;font-weight:700;border:0;border-radius:999px;padding:11px 20px;cursor:pointer;background:var(--sand);color:#0A2029}
.btn[disabled]{opacity:.5;cursor:default}
.note{padding:10px 16px;font-size:14px;color:var(--muted);border-top:1px solid var(--line);background:var(--paper-2)}
.note.err{color:var(--warn);font-weight:700}
.placeholder{margin:auto;color:var(--muted);text-align:center;padding:24px;max-width:360px}
.sig{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);padding:8px 16px 0;background:var(--paper-2)}
.sig input{font:inherit;font-size:13px;border:1px solid var(--line);border-radius:8px;padding:4px 8px;width:140px;background:var(--card);color:var(--deep)}
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
}
</style></head>
<body>
<header>${logo}<b>${esc(center.name)}</b><span class="sp"></span>${switcher}<a href="/cdn-cgi/access/logout" title="${esc(email)}">Sign out</a></header>
<nav><button class="on" data-v="convos">Conversations</button><button data-v="dash">Dashboard</button></nav>

<section id="convos" class="view on">
  <div class="list" id="list"><div class="empty">Loading…</div></div>
  <div class="pane" id="pane"><div class="placeholder">Pick a conversation.<br><br>You see every diver who wrote in the last 24 hours: WhatsApp only lets you reply freely within that window. <b>Needs you</b> means ${esc(center.assistant)} handed it over to your team.</div></div>
</section>

<section id="dash" class="view">
  <div class="bar">Results via ${esc(center.assistant)}, live. <a href="https://airtable.com/appEXBMOJa73WiQHb/shrkzC7WhyMBUsEiO" target="_blank" rel="noopener">Open full screen</a></div>
  <iframe title="Dashboard" loading="lazy" data-src="https://airtable.com/embed/appEXBMOJa73WiQHb/shrkzC7WhyMBUsEiO"></iframe>
</section>

<script>
(function(){
var QS=${JSON.stringify(qs)}, ASSIST=${JSON.stringify(center.assistant)};
var current=null, lastList="", lastChat="";
var $=function(s){return document.querySelector(s)};
function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function api(path,opt){return fetch("/zone/api/"+path+(path.indexOf("?")>-1?QS.replace("?","&"):QS),opt).then(function(r){
  if(r.status===401){location.reload();throw new Error("auth")}
  return r.json().then(function(j){if(!r.ok)throw new Error(j.error||"Error");return j})})}
function ago(iso){var s=(Date.now()-Date.parse(iso))/1000;if(s<60)return "now";if(s<3600)return Math.floor(s/60)+" min";if(s<86400)return Math.floor(s/3600)+" h";return new Date(iso).toLocaleDateString()}
function left(iso){var h=(Date.parse(iso)-Date.now())/3600000;if(h<=0)return {t:"Reply window closed",soon:true};
  if(h<1)return {t:Math.max(1,Math.round(h*60))+" min left to reply",soon:true};return {t:Math.floor(h)+" h left to reply",soon:h<3}}
function clock(iso){return new Date(iso).toLocaleString([], {weekday:"short",hour:"2-digit",minute:"2-digit"})}
var sel=$("#center");if(sel)sel.onchange=function(){location.href="/zone?center="+encodeURIComponent(sel.value)};

document.querySelectorAll("nav button").forEach(function(b){b.onclick=function(){
  document.querySelectorAll("nav button").forEach(function(x){x.classList.toggle("on",x===b)});
  document.querySelectorAll(".view").forEach(function(v){v.classList.toggle("on",v.id===b.dataset.v)});
  if(b.dataset.v==="dash"){var f=$("#dash iframe");if(!f.src)f.src=f.dataset.src}
}});

function loadList(){api("conversations").then(function(d){
  var key=JSON.stringify(d.conversations);
  if(key===lastList){tickList();return}lastList=key;
  var el=$("#list");
  if(!d.conversations.length){el.innerHTML='<div class="empty">No open conversations right now. When a diver writes, it shows up here within a few seconds.</div>';return}
  el.innerHTML=d.conversations.map(function(c){var l=left(c.closesAt);
    var who=c.previewDir==="Customer"?"":(c.previewDir==="Team"?"You: ":ASSIST+": ");
    return '<button class="item'+(c.id===current?' on':'')+'" data-id="'+esc(c.id)+'" data-close="'+esc(c.closesAt)+'"><div class="top"><span class="nm">'+esc(c.name||"Diver")+'</span>'+
      (c.needsYou?'<span class="tag need">Needs you</span>':'')+(c.teamActive?'<span class="tag team">Team</span>':'')+
      (c.language?'<span class="tag lang">'+esc(c.language)+'</span>':'')+'<span class="tm">'+ago(c.lastAt)+'</span></div>'+
      '<div class="pv">'+esc(who+c.preview)+'</div><div class="left'+(l.soon?' soon':'')+'">'+l.t+'</div></button>'}).join("");
  el.querySelectorAll(".item").forEach(function(b){b.onclick=function(){open(b.dataset.id)}});
}).catch(function(e){if(e.message!=="auth")$("#list").innerHTML='<div class="empty">'+esc(e.message)+'</div>'})}
function tickList(){document.querySelectorAll(".item").forEach(function(b){var l=left(b.dataset.close),el=b.querySelector(".left");el.textContent=l.t;el.classList.toggle("soon",l.soon)})}

function open(id){current=id;lastChat="";
  document.querySelectorAll(".item").forEach(function(b){b.classList.toggle("on",b.dataset.id===id)});
  $("#convos").classList.add("open");
  $("#pane").innerHTML='<div class="placeholder">Loading…</div>';loadChat(true)}

function loadChat(scroll){if(!current)return;var id=current;api("chat?c="+encodeURIComponent(id)).then(function(d){
  if(id!==current)return;
  if(d.error){$("#pane").innerHTML='<div class="placeholder">'+esc(d.error)+'</div>';return}
  var key=JSON.stringify([d.messages.length,d.canReply,d.lead]);if(key===lastChat)return;
  var draft=$("#txt")?$("#txt").value:"";lastChat=key;
  var L=d.lead,meta=[L.language&&L.language.toUpperCase(),L.cert,L.status].filter(Boolean).join(" · ");
  var l=d.closesAt?left(d.closesAt):null;
  $("#pane").innerHTML='<div class="head"><button class="back" aria-label="Back">‹</button><b>'+esc(L.name||"Diver")+'</b><span class="meta">'+esc(meta)+'</span></div>'+
    '<div class="msgs" id="msgs">'+d.messages.map(function(m){var who=m.dir==="Customer"?"":(m.dir==="Team"?"Team":ASSIST);
      return '<div class="m '+esc(m.dir)+'">'+(who?'<span class="who">'+esc(who)+'</span>':'')+esc(m.text)+'<small>'+esc(clock(m.at))+'</small></div>'}).join("")+'</div>'+
    (d.canReply?
      '<div class="sig">Sign as <input id="sig" maxlength="30" placeholder="your name"> <span>'+(l?esc(l.t):"")+'</span></div>'+
      '<div class="compose"><textarea id="txt" placeholder="Reply on WhatsApp…" rows="2"></textarea><button class="btn" id="send">Send</button></div>'+
      '<div class="note" id="note">Sending a reply pauses '+esc(ASSIST)+' for this diver. She takes over again 4 hours after your last message.</div>'
      :'<div class="note">More than 24 hours since the diver\\'s last message, so WhatsApp no longer allows a free reply.</div>');
  $(".back").onclick=function(){current=null;$("#convos").classList.remove("open");document.querySelectorAll(".item").forEach(function(b){b.classList.remove("on")})};
  var box=$("#msgs");if(scroll||box.scrollHeight-box.scrollTop-box.clientHeight<200)box.scrollTop=box.scrollHeight;
  if(d.canReply){var t=$("#txt"),s=$("#sig");t.value=draft;
    try{s.value=localStorage.getItem("talay-sig")||""}catch(e){}
    s.oninput=function(){try{localStorage.setItem("talay-sig",s.value)}catch(e){}};
    t.onkeydown=function(e){if(e.key==="Enter"&&(e.metaKey||e.ctrlKey))send()};
    $("#send").onclick=send}
}).catch(function(e){if(e.message!=="auth"&&id===current)$("#pane").innerHTML='<div class="placeholder">'+esc(e.message)+'</div>'})}

function send(){var t=$("#txt"),b=$("#send"),n=$("#note"),v=t.value.trim();if(!v)return;
  var sig=($("#sig").value||"").trim();if(sig)v+="\\n– "+sig;
  b.disabled=true;b.textContent="Sending…";
  api("reply",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({c:current,text:v})}).then(function(){
    t.value="";lastChat="";lastList="";loadChat(true);loadList()}).catch(function(e){
    n.textContent=e.message;n.className="note err"}).finally(function(){b.disabled=false;b.textContent="Send"})}

loadList();
setInterval(function(){if(document.hidden)return;loadList();loadChat(false)},10000);
})();
</script>
</body></html>`;
}
