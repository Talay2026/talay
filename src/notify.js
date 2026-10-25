// Notifications for dive center staff: talay.io/api/notify (called by Make, one call per event).
// Who gets what is in the Airtable table "Notify", one row per person per center:
//   Name, Center (link to Centers), Role (Owner | Office | Instructor),
//   WhatsApp, Email, Language (EN | FR | ES | DE | NL | TH), Topics (Needs you | Bookings | Morning summary | Escalation),
//   Channels (WhatsApp | Push | Email), Evenings (checkbox), Active (checkbox).
// WhatsApp goes out as an approved template from Talay's own number (respond.io channel
// NOTIFY_CHANNEL); push goes to the zone on that person's phone. E-mail stays with Make for now
// (Gmail 33 and the booking mail), so the Email channel is not used here yet.
//
// GET or POST talay.io/api/notify?key=PUSH_KEY&type=…&center=<slug>&…
//   type=needs_you  c (respond.io Contact ID), name, text   → template talay_needs_you_v2
//   type=urgent     same as needs_you, but also outside office hours for everyone
//   type=booking    name, product, date, amount             → template talay_new_booking
// The 15-minute cron (src/zone.js → runHqAlerts) also uses this file for the escalation
// (talay_still_waiting, topic Escalation) and the morning summary (talay_morning).
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

// The few words Talay fills into the templates itself.
export const WORDS = {
  en: { diver: "A diver", seeChat: "(see the chat)", none: "none", nobody: "nobody", one: "diver", many: "divers", noBoat: "no bookings via Talay" },
  fr: { diver: "Un plongeur", seeChat: "(voir le chat)", none: "aucune", nobody: "personne", one: "plongeur", many: "plongeurs", noBoat: "aucune réservation via Talay" },
  es: { diver: "Un buceador", seeChat: "(ver el chat)", none: "ninguna", nobody: "nadie", one: "buceador", many: "buceadores", noBoat: "ninguna reserva vía Talay" },
  de: { diver: "Ein Taucher", seeChat: "(siehe Chat)", none: "keine", nobody: "niemand", one: "Taucher", many: "Taucher", noBoat: "keine Buchungen über Talay" },
  nl: { diver: "Een duiker", seeChat: "(zie het gesprek)", none: "geen", nobody: "niemand", one: "duiker", many: "duikers", noBoat: "geen boekingen via Talay" },
  th: { diver: "นักดำน้ำ", seeChat: "(ดูในแชท)", none: "ไม่มี", nobody: "ไม่มี", one: "คน", many: "คน", noBoat: "ไม่มีการจองผ่าน Talay" },
};
// Notify → Language (single select: EN, FR, ES, DE, NL, TH); empty or unknown = English.
const langOf = (f) => { const l = String(f["Language"] || "").slice(0, 2).toLowerCase(); return WORDS[l] ? l : "en"; };

// Template texts as approved by Meta, per language (Notify → Language); respond.io wants the body
// text next to the values. Only the buttons with a link to one chat have a variable part.
const TEMPLATES = {
  // v2: the first talay_needs_you on channel 570715 was filed as Marketing, and Meta keeps one category per name.
  talay_needs_you_v2: {
    url: "https://talay.io/zone{{1}}",
    en: { body: "Talay alert for {{1}}: a diver needs your team.\n\nName: {{2}}\nQuestion: {{3}}\n\nMia told the diver that the team will reply. Tap below to open the chat.", button: "Open chat" },
    fr: { body: "Alerte Talay pour {{1}} : un plongeur a besoin de votre équipe.\n\nNom : {{2}}\nQuestion : {{3}}\n\nMia a dit au plongeur que l'équipe va répondre. Touchez ci-dessous pour ouvrir la conversation.", button: "Ouvrir le chat" },
    es: { body: "Alerta de Talay para {{1}}: un buceador necesita a tu equipo.\n\nNombre: {{2}}\nPregunta: {{3}}\n\nMia le dijo al buceador que el equipo le responderá. Toca abajo para abrir el chat.", button: "Abrir chat" },
    de: { body: "Talay-Hinweis für {{1}}: Ein Taucher braucht euer Team.\n\nName: {{2}}\nFrage: {{3}}\n\nMia hat dem Taucher gesagt, dass das Team antwortet. Tippe unten, um den Chat zu öffnen.", button: "Chat öffnen" },
    nl: { body: "Talay-melding voor {{1}}: een duiker heeft je team nodig.\n\nNaam: {{2}}\nVraag: {{3}}\n\nMia heeft de duiker gezegd dat het team zal antwoorden. Tik hieronder om het gesprek te openen.", button: "Open gesprek" },
    th: { body: "การแจ้งเตือนจาก Talay สำหรับ {{1}}: มีนักดำน้ำต้องการความช่วยเหลือจากทีมของคุณ\n\nชื่อ: {{2}}\nคำถาม: {{3}}\n\nMia แจ้งนักดำน้ำแล้วว่าทีมจะตอบกลับ แตะด้านล่างเพื่อเปิดแชท", button: "เปิดแชท" },
  },
  talay_new_booking: {
    url: null,
    en: { body: "New booking for {{1}} via Talay.\n\n{{2}} booked {{3}} for {{4}}.\nPaid online: {{5}}\n\nAll details are in your zone and in the booking email.", button: "Open bookings" },
    fr: { body: "Nouvelle réservation pour {{1}} via Talay.\n\n{{2}} a réservé {{3}} pour le {{4}}.\nPayé en ligne : {{5}}\n\nTous les détails sont dans votre espace et dans l'e-mail de réservation.", button: "Voir les réservations" },
    es: { body: "Nueva reserva para {{1}} a través de Talay.\n\n{{2}} reservó {{3}} para el {{4}}.\nPagado en línea: {{5}}\n\nTodos los detalles están en tu zona y en el correo de la reserva.", button: "Ver reservas" },
    de: { body: "Neue Buchung für {{1}} über Talay.\n\n{{2}} hat {{3}} für {{4}} gebucht.\nOnline bezahlt: {{5}}\n\nAlle Details findest du in deiner Zone und in der Buchungs-E-Mail.", button: "Buchungen öffnen" },
    nl: { body: "Nieuwe boeking voor {{1}} via Talay.\n\n{{2}} boekte {{3}} voor {{4}}.\nOnline betaald: {{5}}\n\nAlle details staan in je zone en in de boekingsmail.", button: "Open boekingen" },
    th: { body: "มีการจองใหม่สำหรับ {{1}} ผ่าน Talay\n\n{{2}} จอง {{3}} สำหรับวันที่ {{4}}\nชำระเงินออนไลน์แล้ว: {{5}}\n\nดูรายละเอียดทั้งหมดได้ในโซนของคุณและในอีเมลการจอง", button: "ดูการจอง" },
  },
  talay_still_waiting: {
    url: "https://talay.io/zone{{1}}",
    en: { body: "Reminder for {{1}}: {{2}} has been waiting {{3}} minutes for a reply from your team.\n\nQuestion: {{4}}\n\nTap below to answer in your zone.", button: "Open chat" },
    fr: { body: "Rappel pour {{1}} : {{2}} attend depuis {{3}} minutes une réponse de votre équipe.\n\nQuestion : {{4}}\n\nTouchez ci-dessous pour répondre dans votre espace.", button: "Ouvrir le chat" },
    es: { body: "Recordatorio para {{1}}: {{2}} lleva {{3}} minutos esperando una respuesta de tu equipo.\n\nPregunta: {{4}}\n\nToca abajo para responder en tu zona.", button: "Abrir chat" },
    de: { body: "Erinnerung für {{1}}: {{2}} wartet seit {{3}} Minuten auf eine Antwort von eurem Team.\n\nFrage: {{4}}\n\nTippe unten, um in deiner Zone zu antworten.", button: "Chat öffnen" },
    nl: { body: "Herinnering voor {{1}}: {{2}} wacht al {{3}} minuten op een antwoord van je team.\n\nVraag: {{4}}\n\nTik hieronder om te antwoorden in je zone.", button: "Open gesprek" },
    th: { body: "แจ้งเตือนสำหรับ {{1}}: {{2}} รอคำตอบจากทีมของคุณมา {{3}} นาทีแล้ว\n\nคำถาม: {{4}}\n\nแตะด้านล่างเพื่อตอบในโซนของคุณ", button: "เปิดแชท" },
  },
  talay_morning: {
    url: null,
    en: { body: "Good morning, {{1}} team. Here is what happened since your team went offline:\n\nConversations handled by Mia: {{2}}\nNew bookings: {{3}}\nWaiting for your team: {{4}}\nOn the boat today: {{5}}\n\nHave a great day of diving.", button: "Open Talay" },
    fr: { body: "Bonjour, équipe {{1}}. Voici ce qui s'est passé depuis que votre équipe est hors ligne :\n\nConversations gérées par Mia : {{2}}\nNouvelles réservations : {{3}}\nEn attente de votre équipe : {{4}}\nSur le bateau aujourd'hui : {{5}}\n\nBelle journée de plongée !", button: "Ouvrir Talay" },
    es: { body: "Buenos días, equipo de {{1}}. Esto es lo que pasó desde que tu equipo se desconectó:\n\nConversaciones atendidas por Mia: {{2}}\nNuevas reservas: {{3}}\nEsperando a tu equipo: {{4}}\nEn el barco hoy: {{5}}\n\n¡Que tengáis un gran día de buceo!", button: "Abrir Talay" },
    de: { body: "Guten Morgen, Team {{1}}. Das ist passiert, seit euer Team offline ist:\n\nGespräche von Mia: {{2}}\nNeue Buchungen: {{3}}\nWartet auf euer Team: {{4}}\nHeute auf dem Boot: {{5}}\n\nEinen schönen Tauchtag!", button: "Talay öffnen" },
    nl: { body: "Goedemorgen, team {{1}}. Dit gebeurde er sinds je team offline ging:\n\nGesprekken door Mia: {{2}}\nNieuwe boekingen: {{3}}\nWacht op je team: {{4}}\nVandaag op de boot: {{5}}\n\nEen fijne duikdag!", button: "Open Talay" },
    th: { body: "สวัสดีตอนเช้า ทีม {{1}} นี่คือสิ่งที่เกิดขึ้นระหว่างที่ทีมของคุณออฟไลน์:\n\nบทสนทนาที่ Mia ดูแล: {{2}}\nการจองใหม่: {{3}}\nรอทีมของคุณ: {{4}}\nบนเรือวันนี้: {{5}}\n\nขอให้เป็นวันดำน้ำที่ดี", button: "เปิด Talay" },
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
  const name = String(first(cf["Name"]) || "");
  if (!name) return out({ error: "center has no name" }, 404);
  const night = isNight(Date.now(), Number(first(cf["Office from"])) || 800, Number(first(cf["Office to"])) || 1800);

  const people = (await teamFor(env, name, TOPIC[type]))
    .filter((f) => type !== "needs_you" || !night || f["Evenings"]);

  const sent = [];
  let build;
  if (type === "booking") {
    build = (l) => template("talay_new_booking", [name, p.name, p.product, p.date, p.amount], "", l);
  } else {
    const id = String(p.c || "").replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 64);
    const link = `?center=${encodeURIComponent(slug)}` + (id ? `&c=${encodeURIComponent(id)}` : "");
    build = (l) => template("talay_needs_you_v2", [name, p.name || WORDS[l].diver, p.text || WORDS[l].seeChat], link, l);
  }
  sent.push(...await whatsappTeam(env, people, build, dry));
  // Push only knows "needs you" (the phone asks /zone/api/push-latest what to show).
  if (type !== "booking") {
    for (const f of people) {
      const email = String(f["Email"] || "").trim().toLowerCase();
      if (!(f["Channels"] || []).includes("Push") || !email) continue;
      sent.push({ to: f["Name"] || email, channel: "Push", ...(dry ? { dry: true } : { ok: (await pushToCenter(env, slug, email).catch(() => 0)) > 0 }) });
    }
  }
  return out({ ok: true, night, people: people.length, sent });
}

// The people of one center who want this topic (Needs you, Bookings, Morning summary, Escalation).
// Exact match on the linked Center's name (a link field reads as the primary field, Name).
export async function teamFor(env, centerName, topic) {
  return (await airtable(env, TABLE, `AND({Active}, ARRAYJOIN({Center}) & '' = '${q(centerName)}')`, 50))
    .map((r) => r.fields)
    .filter((f) => (f["Topics"] || []).includes(topic));
}

// One template to everyone in the list who has WhatsApp as a channel, each in their own language:
// build(lang) returns the message.
export async function whatsappTeam(env, people, build, dry = false) {
  const sent = [];
  for (const f of people) {
    const to = phoneOf(f["WhatsApp"]);
    if (!(f["Channels"] || []).includes("WhatsApp") || !to) continue;
    let msg = build(langOf(f));
    if (dry) { sent.push({ to: f["Name"] || to, channel: "WhatsApp", lang: msg.template.languageCode, dry: true, message: msg }); continue; }
    let res = await whatsapp(env, to, f["Name"], msg);
    // A translation Meta has not approved yet: send the English one instead of nothing.
    if (!res.ok && msg.template.languageCode !== "en") res = await whatsapp(env, to, f["Name"], msg = build("en"));
    sent.push({ to: f["Name"] || to, channel: "WhatsApp", lang: msg.template.languageCode, ...res });
  }
  return sent;
}

function isNight(now, from, to) {
  const t = new Date(now + TZ_MS);
  const hhmm = t.getUTCHours() * 100 + t.getUTCMinutes();
  return hhmm < from || hhmm >= to;
}

export function template(name, values, buttonSuffix, lang = "en") {
  const t = TEMPLATES[name], l = t[lang] ? lang : "en";
  const components = [{ type: "body", text: t[l].body, parameters: values.map((v) => ({ type: "text", text: param(v) })) }];
  if (t.url && buttonSuffix) {
    components.push({ type: "buttons", buttons: [{ type: "url", text: t[l].button, url: t.url, parameters: [{ type: "text", text: buttonSuffix }] }] });
  }
  return { type: "whatsapp_template", template: { name, languageCode: l, components } };
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
