// Notifications for dive center staff: talay.io/api/notify (called by Make, one call per event).
// Who gets what is in the Airtable table "Notify", one row per person per center:
//   Name, Center (link to Centers), Slug (from Center) (lookup), Role (Owner | Office | Instructor),
//   WhatsApp, Email, Topics (Needs you | Bookings | Morning summary | Escalation),
//   Channels (WhatsApp | Push | Email), Evenings (checkbox), Active (checkbox).
// WhatsApp goes out as an approved template from Talay's own number (respond.io channel
// NOTIFY_CHANNEL); push goes to the zone on that person's phone. E-mail stays with Make for now
// (Gmail 33 and the booking mail), so the Email channel is not used here yet.
//
// GET or POST talay.io/api/notify?key=PUSH_KEY&type=…&center=<slug>&…
//   type=needs_you  c (respond.io Contact ID), name, text   → template talay_needs_you
//   type=urgent     same as needs_you, but also outside office hours for everyone
//   type=booking    name, product, date, amount             → template talay_new_booking
// Outside the center's office hours (Centers → Office from / Office to, HHMM) only people with
// Evenings get "needs you"; the morning summary picks up the rest. Add dry=1 to see what would
// be sent without sending anything.

import { pushToCenter } from "./zone.js";

const TABLE = "Notify";
const TZ_MS = 7 * 3600 * 1000; // Koh Tao time
const TOPIC = { needs_you: "Needs you", urgent: "Needs you", booking: "Bookings" };
const first = (v) => (Array.isArray(v) ? v[0] : v);
const q = (v) => String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
// WhatsApp refuses template variables with new lines, tabs or more than 4 spaces in a row.
const param = (v, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max) || "-";
const phoneOf = (v) => { const d = String(v || "").replace(/[^\d+]/g, ""); return /^\+\d{8,15}$/.test(d) ? d : ""; };

// Template texts as approved by Meta; respond.io wants the body text next to the values.
const TEMPLATES = {
  talay_needs_you: {
    body: "Talay alert for {{1}}: a diver needs your team.\n\nName: {{2}}\nQuestion: {{3}}\n\nMia told the diver that the team will reply. Tap below to open the chat.",
    button: { text: "Open chat", url: "https://talay.io/zone{{1}}" },
  },
  talay_new_booking: {
    body: "New booking for {{1}} via Talay.\n\n{{2}} booked {{3}} for {{4}}.\nPaid online: {{5}}\n\nAll details are in your zone and in the booking email.",
  },
};

export async function handleNotify(request, env, ctx) {
  const url = new URL(request.url);
  const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  let p = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    try { p = { ...p, ...(await request.json()) }; } catch { /* query string only */ }
  }
  if (!env.PUSH_KEY || p.key !== env.PUSH_KEY) return out({ error: "forbidden" }, 403);
  const type = String(p.type || "");
  const slug = String(p.center || "").toLowerCase();
  if (!TOPIC[type]) return out({ error: "type must be needs_you, urgent or booking" }, 400);
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return out({ error: "center missing" }, 400);
  const dry = p.dry === "1" || p.dry === true;

  const [center] = await airtable(env, "Centers", `{Slug} = '${q(slug)}'`, 1);
  if (!center) return out({ error: "center not found" }, 404);
  const cf = center.fields;
  const name = first(cf["Name"]) || "your dive center";
  const night = isNight(Date.now(), Number(first(cf["Office from"])) || 800, Number(first(cf["Office to"])) || 1800);

  const people = (await airtable(env, TABLE, `AND({Active}, ARRAYJOIN({Slug (from Center)}) & '' = '${q(slug)}')`, 50))
    .map((r) => r.fields)
    .filter((f) => (f["Topics"] || []).includes(TOPIC[type]))
    .filter((f) => type !== "needs_you" || !night || f["Evenings"]);

  const sent = [];
  let msg;
  if (type === "booking") {
    msg = template("talay_new_booking", [name, p.name, p.product, p.date, p.amount]);
  } else {
    const id = String(p.c || "").replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 64);
    const link = `?center=${encodeURIComponent(slug)}` + (id ? `&c=${encodeURIComponent(id)}` : "");
    msg = template("talay_needs_you", [name, p.name || "A diver", p.text || "(see the chat)"], link);
  }
  for (const f of people) {
    const to = phoneOf(f["WhatsApp"]);
    if (!(f["Channels"] || []).includes("WhatsApp") || !to) continue;
    sent.push({ to: f["Name"] || to, channel: "WhatsApp", ...(dry ? { dry: true } : await whatsapp(env, to, f["Name"], msg)) });
  }
  // Push only knows "needs you" (the phone asks /zone/api/push-latest what to show).
  if (type !== "booking") {
    for (const f of people) {
      const email = String(f["Email"] || "").trim().toLowerCase();
      if (!(f["Channels"] || []).includes("Push") || !email) continue;
      sent.push({ to: f["Name"] || email, channel: "Push", ...(dry ? { dry: true } : { ok: (await pushToCenter(env, slug, email).catch(() => 0)) > 0 }) });
    }
  }
  return out({ ok: true, night, people: people.length, sent, ...(dry ? { message: msg } : {}) });
}

function isNight(now, from, to) {
  const t = new Date(now + TZ_MS);
  const hhmm = t.getUTCHours() * 100 + t.getUTCMinutes();
  return hhmm < from || hhmm >= to;
}

function template(name, values, buttonSuffix) {
  const t = TEMPLATES[name];
  const components = [{ type: "body", text: t.body, parameters: values.map((v) => ({ type: "text", text: param(v) })) }];
  if (t.button && buttonSuffix) {
    components.push({ type: "buttons", buttons: [{ type: "url", text: t.button.text, url: t.button.url, parameters: [{ type: "text", text: buttonSuffix }] }] });
  }
  return { type: "whatsapp_template", template: { name, languageCode: "en", components } };
}

// respond.io: make sure the contact exists, then send the template from Talay's number.
async function whatsapp(env, phone, name, message) {
  if (!env.RESPONDIO_TOKEN || !env.NOTIFY_CHANNEL) return { ok: false, error: "RESPONDIO_TOKEN or NOTIFY_CHANNEL missing" };
  const id = encodeURIComponent(`phone:${phone}`);
  const headers = { Authorization: `Bearer ${env.RESPONDIO_TOKEN}`, "Content-Type": "application/json" };
  await fetch(`https://api.respond.io/v2/contact/create_or_update/${id}`, {
    method: "POST", headers, body: JSON.stringify({ firstName: param(name || "Team", 60), phone }),
  }).catch(() => {});
  const res = await fetch(`https://api.respond.io/v2/contact/${id}/message`, {
    method: "POST", headers, body: JSON.stringify({ channelId: Number(env.NOTIFY_CHANNEL), message }),
  });
  if (res.ok) return { ok: true };
  const error = `${res.status} ${(await res.text()).slice(0, 300)}`;
  console.error("notify whatsapp", error);
  return { ok: false, error };
}

async function airtable(env, table, formula, max) {
  const api = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}`);
  api.searchParams.set("filterByFormula", formula);
  api.searchParams.set("maxRecords", String(max));
  const res = await fetch(api, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  if (!res.ok) throw new Error(`Airtable ${table}: ${res.status} ${await res.text()}`);
  return (await res.json()).records || [];
}
