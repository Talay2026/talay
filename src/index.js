// Talay booking page: talay.io/b/[center-slug]?p=[product-code]
// Reads the center and product from Airtable (read-only token) and renders a
// white-label page: the diver sees the dive center, not Talay.
// Everything outside /b/ is served from /public by the assets binding.
//
// Languages: English, French, German, Spanish. The page follows ?l=fr|de|es|en
// if present, otherwise the language of the diver's phone or browser.
// Optional Airtable fields per language (fallback to English when empty):
//   Products: "Name FR", "Duration FR", "Included FR", "Check-in FR" (also DE, ES)
//   Centers:  "Meeting point FR" (also DE, ES)

const CACHE_SECONDS = 120; // limits Airtable API calls; logo links stay valid
const MAX_DIVERS = 5; // 6+ goes to a person (rule from the conversation flow)
const LANGS = ["en", "fr", "de", "es"];
const LOCALES = { en: "en-GB", fr: "fr-FR", de: "de-DE", es: "es-ES" };

// ---------- Texts ----------

const T = {
  en: {
    title: "Book your dive",
    testmode: "Test mode: no real payment is taken.",
    includes: "Includes",
    startDate: "Start date",
    date: "Date",
    earliest: (d) => `Earliest date you can still book online: ${d}.`,
    diversLabel: "Number of divers",
    less: "One diver less",
    more: "One diver more",
    group: (a) => `Coming with 6 or more? Message ${a} on WhatsApp and the team will plan it with you.`,
    diver: "diver", divers: "divers",
    totalFor: "Total for",
    payNow: "Pay now to secure your spot",
    payShop: "Pay at the shop on the day",
    never: "You never pay more than the shop price.",
    btn: ["Pay ", " THB and book"],
    checkIn: "Check-in",
    meeting: "Meeting point",
    chooseDate: "Choose a date first.",
    tooSoon: (m) => `That date is too soon to book online. Choose ${m} or later.`,
    tooFar: (a) => `That date is too far ahead to book online. Message ${a} on WhatsApp.`,
    noPay: (a) => `Online payment opens soon. For now, reply to ${a} on WhatsApp with your date and number of divers, and the team will book you in.`,
    opening: "Opening secure payment…",
    wrong: "Something went wrong. Try again.",
    noConn: "No connection. Check your internet and try again.",
    notAvailable: "Online payment is not available yet.",
    invalid: "Invalid request.",
    chooseFrom: (m) => `Choose ${m} or later.`,
    chooseDivers: `Choose between 1 and ${MAX_DIVERS} divers.`,
    deposit: (n, c) => `Deposit: ${n} at ${c}`,
    stripeDesc: (d, lbl, b) => `${d}, ${lbl}. You pay the remaining ${b} THB at the shop.`,
    booked: "You're booked",
    paidNow: "Paid now",
    change: "If the team needs to change your booking, they'll message you within two hours.",
    questions: (a) => `Questions? Reply to ${a} on WhatsApp.`,
    notPaid: "We haven't received your payment. Open the booking link again to try once more.",
    notFoundTitle: "This booking link doesn't work",
    notFoundText: "Open the link again from your WhatsApp chat with the dive center, or send them a message and they'll send a new one.",
    problemTitle: "Booking page unavailable",
    missingKey: "The booking page is not set up yet (missing key).",
    loadFail: "We couldn't load this booking right now. Try again in a minute.",
  },
  fr: {
    title: "Réservez votre plongée",
    testmode: "Mode test : aucun paiement réel n'est effectué.",
    includes: "Inclus :",
    startDate: "Date de début",
    date: "Date",
    earliest: (d) => `Première date encore réservable en ligne : ${d}.`,
    diversLabel: "Nombre de plongeurs",
    less: "Un plongeur de moins",
    more: "Un plongeur de plus",
    group: (a) => `Vous êtes 6 ou plus ? Écrivez à ${a} sur WhatsApp et l'équipe organisera tout avec vous.`,
    diver: "plongeur", divers: "plongeurs",
    totalFor: "Total pour",
    payNow: "À payer maintenant pour réserver votre place",
    payShop: "À payer au centre le jour même",
    never: "Vous ne payez jamais plus que le prix du centre.",
    btn: ["Payer ", " THB et réserver"],
    checkIn: "Check-in",
    meeting: "Point de rendez-vous",
    chooseDate: "Choisissez d'abord une date.",
    tooSoon: (m) => `Cette date est trop proche pour réserver en ligne. Choisissez le ${m} ou plus tard.`,
    tooFar: (a) => `Cette date est trop lointaine pour réserver en ligne. Écrivez à ${a} sur WhatsApp.`,
    noPay: (a) => `Le paiement en ligne arrive bientôt. En attendant, envoyez à ${a} sur WhatsApp votre date et le nombre de plongeurs, et l'équipe s'occupe de votre réservation.`,
    opening: "Ouverture du paiement sécurisé…",
    wrong: "Une erreur s'est produite. Réessayez.",
    noConn: "Pas de connexion. Vérifiez votre connexion internet et réessayez.",
    notAvailable: "Le paiement en ligne n'est pas encore disponible.",
    invalid: "Demande non valide.",
    chooseFrom: (m) => `Choisissez le ${m} ou plus tard.`,
    chooseDivers: `Choisissez entre 1 et ${MAX_DIVERS} plongeurs.`,
    deposit: (n, c) => `Acompte : ${n} chez ${c}`,
    stripeDesc: (d, lbl, b) => `${d}, ${lbl}. Vous payez le solde de ${b} THB au centre.`,
    booked: "Votre réservation est confirmée",
    paidNow: "Payé maintenant",
    change: "Si l'équipe doit modifier votre réservation, elle vous écrira dans les deux heures.",
    questions: (a) => `Des questions ? Répondez à ${a} sur WhatsApp.`,
    notPaid: "Nous n'avons pas reçu votre paiement. Ouvrez à nouveau le lien de réservation pour réessayer.",
    notFoundTitle: "Ce lien de réservation ne fonctionne pas",
    notFoundText: "Ouvrez à nouveau le lien depuis votre conversation WhatsApp avec le centre de plongée, ou envoyez-leur un message et ils vous enverront un nouveau lien.",
    problemTitle: "Page de réservation indisponible",
    missingKey: "La page de réservation n'est pas encore configurée (clé manquante).",
    loadFail: "Impossible de charger cette réservation pour le moment. Réessayez dans une minute.",
  },
  de: {
    title: "Buche deinen Tauchgang",
    testmode: "Testmodus: Es wird keine echte Zahlung abgebucht.",
    includes: "Inklusive",
    startDate: "Startdatum",
    date: "Datum",
    earliest: (d) => `Frühestes Datum, das du noch online buchen kannst: ${d}.`,
    diversLabel: "Anzahl Taucher",
    less: "Ein Taucher weniger",
    more: "Ein Taucher mehr",
    group: (a) => `Ihr seid 6 oder mehr? Schreib ${a} auf WhatsApp, dann plant das Team alles mit euch.`,
    diver: "Taucher", divers: "Taucher",
    totalFor: "Gesamt für",
    payNow: "Jetzt zahlen und Platz sichern",
    payShop: "Am Tag selbst im Shop zahlen",
    never: "Du zahlst nie mehr als den Preis im Shop.",
    btn: ["", " THB zahlen und buchen"],
    checkIn: "Check-in",
    meeting: "Treffpunkt",
    chooseDate: "Wähle zuerst ein Datum.",
    tooSoon: (m) => `Dieses Datum ist zu früh für eine Online-Buchung. Wähle ${m} oder später.`,
    tooFar: (a) => `Dieses Datum liegt zu weit in der Zukunft für eine Online-Buchung. Schreib ${a} auf WhatsApp.`,
    noPay: (a) => `Online-Zahlung kommt bald. Schick ${a} bis dahin auf WhatsApp dein Datum und die Anzahl Taucher, dann bucht das Team für dich.`,
    opening: "Sichere Zahlung wird geöffnet…",
    wrong: "Etwas ist schiefgelaufen. Versuch es noch einmal.",
    noConn: "Keine Verbindung. Prüfe dein Internet und versuch es noch einmal.",
    notAvailable: "Online-Zahlung ist noch nicht verfügbar.",
    invalid: "Ungültige Anfrage.",
    chooseFrom: (m) => `Wähle ${m} oder später.`,
    chooseDivers: `Wähle zwischen 1 und ${MAX_DIVERS} Tauchern.`,
    deposit: (n, c) => `Anzahlung: ${n} bei ${c}`,
    stripeDesc: (d, lbl, b) => `${d}, ${lbl}. Den Rest von ${b} THB zahlst du im Shop.`,
    booked: "Du bist gebucht",
    paidNow: "Jetzt bezahlt",
    change: "Falls das Team deine Buchung ändern muss, meldet es sich innerhalb von zwei Stunden bei dir.",
    questions: (a) => `Fragen? Antworte ${a} auf WhatsApp.`,
    notPaid: "Wir haben deine Zahlung nicht erhalten. Öffne den Buchungslink noch einmal, um es erneut zu versuchen.",
    notFoundTitle: "Dieser Buchungslink funktioniert nicht",
    notFoundText: "Öffne den Link noch einmal aus deinem WhatsApp-Chat mit der Tauchbasis, oder schreib ihnen, dann bekommst du einen neuen Link.",
    problemTitle: "Buchungsseite nicht verfügbar",
    missingKey: "Die Buchungsseite ist noch nicht eingerichtet (Schlüssel fehlt).",
    loadFail: "Diese Buchung kann gerade nicht geladen werden. Versuch es in einer Minute noch einmal.",
  },
  es: {
    title: "Reserva tu inmersión",
    testmode: "Modo de prueba: no se realiza ningún pago real.",
    includes: "Incluye",
    startDate: "Fecha de inicio",
    date: "Fecha",
    earliest: (d) => `Primera fecha que aún puedes reservar online: ${d}.`,
    diversLabel: "Número de buceadores",
    less: "Un buceador menos",
    more: "Un buceador más",
    group: (a) => `¿Sois 6 o más? Escribe a ${a} por WhatsApp y el equipo lo organizará con vosotros.`,
    diver: "buceador", divers: "buceadores",
    totalFor: "Total para",
    payNow: "Paga ahora para asegurar tu plaza",
    payShop: "Paga en el centro el mismo día",
    never: "Nunca pagas más que el precio del centro.",
    btn: ["Pagar ", " THB y reservar"],
    checkIn: "Check-in",
    meeting: "Punto de encuentro",
    chooseDate: "Elige primero una fecha.",
    tooSoon: (m) => `Esa fecha es demasiado pronto para reservar online. Elige el ${m} o una fecha posterior.`,
    tooFar: (a) => `Esa fecha está demasiado lejos para reservar online. Escribe a ${a} por WhatsApp.`,
    noPay: (a) => `El pago online llegará pronto. Mientras tanto, envía a ${a} por WhatsApp tu fecha y el número de buceadores, y el equipo te hará la reserva.`,
    opening: "Abriendo el pago seguro…",
    wrong: "Algo salió mal. Inténtalo de nuevo.",
    noConn: "Sin conexión. Revisa tu internet e inténtalo de nuevo.",
    notAvailable: "El pago online aún no está disponible.",
    invalid: "Solicitud no válida.",
    chooseFrom: (m) => `Elige el ${m} o una fecha posterior.`,
    chooseDivers: `Elige entre 1 y ${MAX_DIVERS} buceadores.`,
    deposit: (n, c) => `Depósito: ${n} en ${c}`,
    stripeDesc: (d, lbl, b) => `${d}, ${lbl}. El resto, ${b} THB, lo pagas en el centro.`,
    booked: "Tu reserva está confirmada",
    paidNow: "Pagado ahora",
    change: "Si el equipo necesita cambiar tu reserva, te escribirá en un plazo de dos horas.",
    questions: (a) => `¿Preguntas? Responde a ${a} por WhatsApp.`,
    notPaid: "No hemos recibido tu pago. Abre de nuevo el enlace de reserva para volver a intentarlo.",
    notFoundTitle: "Este enlace de reserva no funciona",
    notFoundText: "Abre de nuevo el enlace desde tu chat de WhatsApp con el centro de buceo, o escríbeles y te enviarán uno nuevo.",
    problemTitle: "Página de reserva no disponible",
    missingKey: "La página de reserva aún no está configurada (falta la clave).",
    loadFail: "No hemos podido cargar esta reserva ahora mismo. Inténtalo de nuevo en un minuto.",
  },
};

const okLang = (l) => (LANGS.includes(String(l || "").toLowerCase()) ? String(l).toLowerCase() : "");

function pickLang(request, url) {
  const q = okLang(url.searchParams.get("l"));
  if (q) return q;
  const header = request.headers.get("Accept-Language") || "";
  const prefs = header.split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qp = params.find((p) => p.trim().startsWith("q="));
      return { lang: tag.trim().slice(0, 2).toLowerCase(), q: qp ? Number(qp.trim().slice(2)) || 0 : 1 };
    })
    .filter((x) => x.lang)
    .sort((a, b) => b.q - a.q);
  for (const p of prefs) if (LANGS.includes(p.lang)) return p.lang;
  return "en";
}

const diversLabel = (n, lang) => `${n} ${n === 1 ? T[lang].diver : T[lang].divers}`;

// Airtable field in the diver's language, falling back to the English field.
function tr(rec, field, lang) {
  if (lang !== "en") {
    const v = first(rec[`${field} ${lang.toUpperCase()}`]);
    if (v) return { v, translated: true };
  }
  return { v: first(rec[field]) || "", translated: lang === "en" };
}

// ---------- Router ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/b/")) return env.ASSETS.fetch(request);
    const lang = pickLang(request, url);
    if (!env.AIRTABLE_TOKEN) {
      return page(problem(T[lang].missingKey, lang), 500, lang);
    }

    try {
      if (url.pathname === "/b/checkout" && request.method === "POST") {
        return await checkout(request, env, ctx, url);
      }
      if (url.pathname === "/b/thanks") {
        return await thanks(request, env, ctx, url);
      }
      if (url.pathname === "/b/manage") {
        return await managePage(env, ctx, url);
      }
      if (url.pathname === "/b/manage/action" && request.method === "POST") {
        return await manageAction(request, env, ctx);
      }

      const slug = url.pathname.slice(3).replace(/\/+$/, "").toLowerCase();
      const code = (url.searchParams.get("p") || "").toUpperCase();
      const found = await loadBooking(env, ctx, slug, code);
      if (!found) return page(notFound(lang), 404, lang);
      const ref = (url.searchParams.get("c") || "").slice(0, 64);
      return page(bookingPage(found.center, found.product, code, slug, env, lang,
        /^[A-Za-z0-9_-]{1,64}$/.test(ref) ? ref : ""), 200, lang);
    } catch (err) {
      console.error(err);
      return page(problem(T[lang].loadFail, lang), 502, lang);
    }
  },
};

async function loadBooking(env, ctx, slug, code) {
  if (!/^[a-z0-9-]{1,60}$/.test(slug) || !/^[A-Z0-9]{1,12}$/.test(code)) return null;
  const [center, product] = await Promise.all([
    airtableOne(env, ctx, "Centers", `{Slug} = '${slug}'`),
    airtableOne(env, ctx, "Products",
      `AND({Code} = '${code}', FIND('${slug}', ARRAYJOIN({C slug})))`),
  ]);
  return center && product ? { center, product } : null;
}

// ---------- Stripe ----------

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
});

async function stripe(env, method, path, params, extraHeaders = {}) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...extraHeaders,
    },
    body: params ? new URLSearchParams(params) : undefined,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Stripe ${path}: ${res.status} ${JSON.stringify(body.error || body)}`);
  return body;
}

async function checkout(request, env, ctx, url) {
  let input;
  try { input = await request.json(); } catch { return json({ error: T.en.invalid }, 400); }
  const lang = okLang(input.lang) || "en";
  const t = T[lang];
  if (!env.STRIPE_SECRET_KEY) return json({ error: t.notAvailable }, 503);

  const slug = String(input.slug || "").toLowerCase();
  const code = String(input.code || "").toUpperCase();
  const date = String(input.date || "");
  const divers = Number(input.divers);
  const ref = /^[A-Za-z0-9_-]{1,64}$/.test(String(input.ref || "")) ? String(input.ref) : "";

  // Never trust the browser: reload prices and re-check every rule here.
  const found = await loadBooking(env, ctx, slug, code);
  if (!found) return json({ error: t.notFoundTitle }, 404);
  const { center, product } = found;
  const minDate = earliestDate(num(product["Cutoff hour"]) || 15);
  const maxDate = plusDays(minDate, 180);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < minDate || date > maxDate) {
    return json({ error: t.chooseFrom(fmtDate(minDate, lang)) }, 400);
  }
  if (!Number.isInteger(divers) || divers < 1 || divers > MAX_DIVERS) {
    return json({ error: t.chooseDivers }, 400);
  }

  const centerName = first(center["Name"]) || "Dive center";
  const name = first(product["Name"]) || code; // English name: used in Airtable, Make and mails
  const shownName = tr(product, "Name", lang).v || name;
  const price = num(product["Price THB"]);
  const deposit = num(product["Deposit THB"]);
  const total = price * divers, paid = deposit * divers, balance = total - paid;
  const back = `${url.origin}/b/${slug}?p=${code}${ref ? `&c=${ref}` : ""}&l=${lang}`;

  const meta = {
    center_slug: slug, center_name: centerName, product_code: code, product_name: name,
    activity_date: date, divers: String(divers),
    total_thb: String(total), deposit_thb: String(paid), balance_thb: String(balance),
    lead_ref: ref, lang,
  };
  const params = {
    mode: "payment",
    locale: lang,
    "line_items[0][quantity]": String(divers),
    "line_items[0][price_data][currency]": "thb",
    "line_items[0][price_data][unit_amount]": String(deposit * 100), // THB in satang
    "line_items[0][price_data][product_data][name]": t.deposit(shownName, centerName),
    "line_items[0][price_data][product_data][description]":
      t.stripeDesc(fmtDate(date, lang), diversLabel(divers, lang), thb(balance)),
    "phone_number_collection[enabled]": "true",
    success_url: `${url.origin}/b/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: back,
    "payment_intent_data[description]": `${name} at ${centerName}, ${date}, ${divers}x`,
  };
  for (const [k, v] of Object.entries(meta)) {
    params[`metadata[${k}]`] = v;
    params[`payment_intent_data[metadata][${k}]`] = v;
  }
  const session = await stripe(env, "POST", "checkout/sessions", params);
  return json({ url: session.url });
}

async function thanks(request, env, ctx, url) {
  const id = url.searchParams.get("session_id") || "";
  let lang = pickLang(request, url);
  if (!env.STRIPE_SECRET_KEY || !/^cs_[A-Za-z0-9_]{10,200}$/.test(id)) return page(notFound(lang), 404, lang);
  const s = await stripe(env, "GET", `checkout/sessions/${id}`);
  const m = s.metadata || {};
  lang = okLang(m.lang) || lang;
  const t = T[lang];
  if (s.payment_status !== "paid") {
    return page(problem(t.notPaid, lang), 402, lang);
  }
  const found = await loadBooking(env, ctx, m.center_slug, m.product_code);
  const c = found?.center || {}, p = found?.product || {};
  const logo = first(c["Logo"])?.thumbnails?.large?.url || first(c["Logo"])?.url || "";
  const assistant = first(c["Assistant name"]) || m.center_name || "";
  const meeting = cap(tr(c, "Meeting point", lang).v);
  const checkIn = cap(tr(p, "Check-in", lang).v);
  const productName = tr(p, "Name", lang).v || m.product_name;
  const n = Number(m.divers) || 1;

  return page(`
<header class="center">
  ${logo ? `<img class="logo" src="${esc(logo)}" alt="${esc(m.center_name)} logo">` : ""}
  <div><p class="center-name">${esc(m.center_name)}</p>${c["Island"] ? `<p class="island">${esc(first(c["Island"]))}</p>` : ""}</div>
</header>
<main>
  <h1>${esc(t.booked)}</h1>
  <p class="intro"><strong>${esc(productName)}</strong>, ${esc(fmtDate(m.activity_date, lang))}, ${esc(diversLabel(n, lang))}.</p>
  <section class="slate" aria-label="${esc(t.paidNow)}">
    <div class="above">
      <div class="row now"><span>${esc(t.paidNow)}</span><span><b>${thb(Number(m.deposit_thb))}</b> THB</span></div>
    </div>
    <svg class="waterline" viewBox="0 0 400 24" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 12 C 50 2, 100 22, 150 12 S 250 2, 300 12 S 380 20, 400 12 V24 H0Z"/>
    </svg>
    <div class="below">
      <div class="row"><span>${esc(t.payShop)}</span><span><b>${thb(Number(m.balance_thb))}</b> THB</span></div>
    </div>
  </section>
  <p class="msg">${esc(t.change)}</p>
  ${(checkIn || meeting) ? `<dl class="practical">
    ${checkIn ? `<div><dt>${esc(t.checkIn)}</dt><dd>${esc(checkIn)}</dd></div>` : ""}
    ${meeting ? `<div><dt>${esc(t.meeting)}</dt><dd>${esc(meeting)}</dd></div>` : ""}
  </dl>` : ""}
  <p class="hint" style="margin-top:2rem">${esc(t.questions(assistant))}</p>
</main>`, 200, lang);
}

// ---------- Manage booking (for the dive center) ----------
// Link in the center's email: talay.io/b/manage?t=[Manage token]. The token is a
// random uuid made by Make when the booking is created; only the center gets it.
// Rule (pilot): changes stay possible after the 2-hour window, but the page warns
// and Make mails Talay ("late").

const WINDOW_MS = 2 * 3600 * 1000;
const okToken = (t) => /^[0-9a-fA-F-]{20,64}$/.test(String(t || ""));

async function airtableFind(env, table, formula) {
  // No cache: the status of a booking must always be current.
  const api = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}`);
  api.searchParams.set("filterByFormula", formula);
  api.searchParams.set("maxRecords", "1");
  const res = await fetch(api, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  if (!res.ok) throw new Error(`Airtable ${table}: ${res.status} ${await res.text()}`);
  return (await res.json()).records?.[0] || null;
}

async function loadManaged(env, ctx, token) {
  if (!okToken(token)) return null;
  const rec = await airtableFind(env, "Bookings", `{Manage token} = '${token}'`);
  if (!rec) return null;
  const f = rec.fields;
  const sessionId = first(f["Stripe session ID"]) || "";
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sessionId)) return null;
  const session = await stripe(env, "GET", `checkout/sessions/${sessionId}`);
  const m = session.metadata || {};
  const found = await loadBooking(env, ctx, m.center_slug, m.product_code);
  const created = Date.parse(rec.createdTime);
  return {
    rec, f, session, m,
    center: found?.center || {}, product: found?.product || {},
    created, late: Date.now() > created + WINDOW_MS,
    cancelled: /cancel|refund/i.test(String(first(f["Status"]) || "")),
  };
}

const thaiTime = (ms) => new Date(ms).toLocaleString("en-GB", {
  timeZone: "Asia/Bangkok", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});

async function managePage(env, ctx, url) {
  const token = url.searchParams.get("t") || "";
  if (!env.STRIPE_SECRET_KEY || !env.MAKE_CHANGES_URL || !env.MAKE_CHANGES_KEY) {
    return page(problem("Booking changes are not set up yet.", "en"), 500, "en");
  }
  const b = await loadManaged(env, ctx, token);
  if (!b) {
    return page(`<main class="empty"><h1>This link doesn't work</h1>
  <p>Open the link again from the booking email, or reply to that email.</p></main>`, 404, "en");
  }
  const { f, m, center, product } = b;
  const centerName = first(center["Name"]) || m.center_name || "Dive center";
  const logo = first(center["Logo"])?.thumbnails?.large?.url || first(center["Logo"])?.url || "";
  const ref = first(f["Ref"]) || "";
  const name = first(f["P name"]) || m.product_name || "";
  const date = String(first(f["Activity date"]) || m.activity_date || "").slice(0, 10);
  const divers = Number(first(f["Group size"])) || Number(m.divers) || 1;
  const paid = Number(first(f["Deposit paid THB"])) || Number(m.deposit_thb) || 0;
  const diver = first(f["Payer name"]) || "";
  const minDate = earliestDate(num(product["Cutoff hour"]) || 15);
  const maxDate = plusDays(minDate, 180);
  const data = { token, minDate, maxDate, current: date, paid: thb(paid) };

  const windowLine = b.late
    ? `<p class="warn">The 2-hour window for changes has passed (booked ${esc(thaiTime(b.created))}, Koh Tao time). You can still move or cancel, but Talay will be notified.</p>`
    : `<p class="hint">You can move or cancel this booking until ${esc(thaiTime(b.created + WINDOW_MS))} (Koh Tao time).</p>`;

  return page(`
<header class="center">
  ${logo ? `<img class="logo" src="${esc(logo)}" alt="${esc(centerName)} logo">` : ""}
  <div><p class="center-name">${esc(centerName)}</p><p class="island">Manage booking</p></div>
</header>
<main>
  <h1>${esc(ref || "Booking")}</h1>
  <p class="intro"><strong>${esc(name)}</strong>, ${esc(date ? fmtDate(date, "en") : "")}, ${esc(diversLabel(divers, "en"))}${diver ? `, ${esc(diver)}` : ""}. Deposit paid online: ${thb(paid)} THB.</p>
  ${b.cancelled ? `<p class="msg">This booking is cancelled. The diver's deposit has been refunded.</p>` : `
  ${windowLine}
  <section class="field" style="margin-top:2rem">
    <label for="date">Move to another date</label>
    <input id="date" type="date" min="${minDate}" max="${maxDate}" aria-describedby="date-error">
    <p id="date-error" class="error" role="alert" hidden></p>
    <button type="button" id="move" class="book" style="margin-top:1rem">Move booking</button>
    <p class="hint">The diver gets a WhatsApp message with the new date.</p>
  </section>
  <section class="field" style="margin-top:2.5rem;padding-top:1.5rem;border-top:1px solid var(--line)">
    <label>Cancel</label>
    <button type="button" id="cancel" class="book danger">Cancel and refund ${thb(paid)} THB</button>
    <p class="hint">The full deposit goes back to the diver's card, and the diver gets a WhatsApp message.</p>
  </section>
  <p id="msg" class="msg" role="status" hidden></p>`}
</main>
<script id="data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script>
(() => {
  const d = JSON.parse(document.getElementById("data").textContent);
  const $ = (id) => document.getElementById(id);
  if (!$("move")) return;
  const msg = $("msg");
  function send(body, btn, doneText) {
    $("move").disabled = true; $("cancel").disabled = true;
    msg.hidden = false; msg.textContent = "Saving…";
    fetch("/b/manage/action", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ t: d.token }, body)) })
      .then((r) => r.json())
      .then((r) => {
        if (r.ok) { msg.textContent = r.message || doneText; return; }
        msg.textContent = r.error || "Something went wrong. Try again.";
        $("move").disabled = false; $("cancel").disabled = false;
      })
      .catch(() => { msg.textContent = "No connection. Try again."; $("move").disabled = false; $("cancel").disabled = false; });
  }
  $("move").onclick = () => {
    const v = $("date").value, box = $("date-error");
    let problem = "";
    if (!v) problem = "Choose the new date first.";
    else if (v === d.current) problem = "That is already the booked date.";
    else if (v < d.minDate) problem = "That date is too soon. Choose " + d.minDate + " or later.";
    else if (v > d.maxDate) problem = "That date is too far ahead.";
    box.hidden = !problem; box.textContent = problem; $("date").classList.toggle("invalid", !!problem);
    if (problem) return;
    send({ action: "move", date: v }, $("move"), "Booking moved. The diver has been informed.");
  };
  $("cancel").onclick = () => {
    if (!confirm("Cancel this booking and refund " + d.paid + " THB to the diver?")) return;
    send({ action: "cancel" }, $("cancel"), "Booking cancelled and refunded. The diver has been informed.");
  };
})();
</script>`, 200, "en", "Manage booking");
}

async function manageAction(request, env, ctx) {
  let input;
  try { input = await request.json(); } catch { return json({ error: "Invalid request." }, 400); }
  if (!env.STRIPE_SECRET_KEY || !env.MAKE_CHANGES_URL || !env.MAKE_CHANGES_KEY) {
    return json({ error: "Booking changes are not set up yet." }, 503);
  }
  const token = String(input.t || "");
  const b = await loadManaged(env, ctx, token);
  if (!b) return json({ error: "This link doesn't work." }, 404);
  if (b.cancelled) return json({ error: "This booking is already cancelled." }, 409);

  const tellMake = async (action, newDate = "") => {
    const u = new URL(env.MAKE_CHANGES_URL);
    u.searchParams.set("key", env.MAKE_CHANGES_KEY);
    u.searchParams.set("token", token);
    u.searchParams.set("action", action);
    u.searchParams.set("new_date", newDate);
    u.searchParams.set("late", b.late ? "true" : "false");
    const res = await fetch(u);
    if (!res.ok) throw new Error(`Make: ${res.status} ${await res.text()}`);
  };

  if (input.action === "move") {
    const date = String(input.date || "");
    const minDate = earliestDate(num(b.product["Cutoff hour"]) || 15);
    const maxDate = plusDays(minDate, 180);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < minDate || date > maxDate) {
      return json({ error: `Choose a date between ${fmtDate(minDate, "en")} and ${fmtDate(maxDate, "en")}.` }, 400);
    }
    await tellMake("move", date);
    return json({ ok: true, message: `Booking moved to ${fmtDate(date, "en")}. The diver gets a WhatsApp message.` });
  }

  if (input.action === "cancel") {
    const pi = typeof b.session.payment_intent === "string" ? b.session.payment_intent : b.session.payment_intent?.id;
    if (!pi) return json({ error: "No payment found for this booking. Contact Talay." }, 409);
    try {
      await stripe(env, "POST", "refunds",
        { payment_intent: pi, "metadata[cancelled_by]": "center", "metadata[booking]": String(first(b.f["Ref"]) || "") },
        { "Idempotency-Key": `cancel-${token}` });
    } catch (err) {
      if (!/already.?refunded/i.test(String(err.message))) throw err;
    }
    await tellMake("cancel");
    return json({ ok: true, message: "Booking cancelled. The full deposit is refunded to the diver's card, and the diver gets a WhatsApp message." });
  }
  return json({ error: "Unknown action." }, 400);
}

// ---------- Airtable ----------

async function airtableOne(env, ctx, table, formula) {
  const api = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE}/${encodeURIComponent(table)}`);
  api.searchParams.set("filterByFormula", formula);
  api.searchParams.set("maxRecords", "1");

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.talay.internal/${table}?${api.searchParams}`);
  const hit = await cache.match(cacheKey);
  if (hit) return (await hit.json()).records?.[0]?.fields || null;

  const res = await fetch(api, { headers: { Authorization: `Bearer ${env.AIRTABLE_TOKEN}` } });
  if (!res.ok) throw new Error(`Airtable ${table}: ${res.status} ${await res.text()}`);
  const body = await res.text();
  ctx.waitUntil(cache.put(cacheKey, new Response(body, {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_SECONDS}` },
  })));
  return JSON.parse(body).records?.[0]?.fields || null;
}

// ---------- Helpers ----------

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const first = (v) => (Array.isArray(v) ? v[0] : v);
const num = (v) => Number(first(v)) || 0;
const cap = (t) => String(t).charAt(0).toUpperCase() + String(t).slice(1);
const thb = (n) => Math.round(n).toLocaleString("en-US");

function earliestDate(cutoffHour) {
  // Booking for day D closes at the cutoff hour (Thai time) on D-1.
  const now = new Date(Date.now() + 7 * 3600 * 1000); // Asia/Bangkok, no DST
  const daysAhead = now.getUTCHours() < cutoffHour ? 1 : 2;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead));
  return d.toISOString().slice(0, 10);
}
function plusDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- Pages ----------

function bookingPage(c, p, code, slug, env, lang, ref = "") {
  const t = T[lang];
  const centerName = first(c["Name"]) || "Dive center";
  const island = first(c["Island"]) || "";
  const assistant = first(c["Assistant name"]) || centerName;
  const logo = first(c["Logo"])?.thumbnails?.large?.url || first(c["Logo"])?.url || "";
  const meeting = cap(tr(c, "Meeting point", lang).v);

  const englishName = first(p["Name"]) || code;
  const name = tr(p, "Name", lang).v || englishName;
  const price = num(p["Price THB"]);
  const deposit = num(p["Deposit THB"]);
  const duration = tr(p, "Duration", lang).v;
  const inc = tr(p, "Included", lang);
  const includesWord = inc.translated ? t.includes : T.en.includes;
  const checkIn = cap(tr(p, "Check-in", lang).v);
  const cutoff = num(p["Cutoff hour"]) || 15;

  const minDate = earliestDate(cutoff);
  const maxDate = plusDays(minDate, 180);
  const payments = !!env.STRIPE_SECRET_KEY;
  const testMode = String(env.STRIPE_SECRET_KEY || "").startsWith("sk_test_");
  const isCourse = code === "OW" || /course|diver/i.test(englishName);
  const minLabel = fmtDate(minDate, lang);
  const data = {
    price, deposit, max: MAX_DIVERS, payments, slug, code, ref, lang, minDate, maxDate,
    s: {
      diver: t.diver, divers: t.divers, chooseDate: t.chooseDate,
      tooSoon: t.tooSoon(minLabel), tooFar: t.tooFar(assistant), noPay: t.noPay(assistant),
      opening: t.opening, wrong: t.wrong, noConn: t.noConn,
    },
  };

  return `
${testMode ? `<p class="testmode">${esc(t.testmode)}</p>` : ""}
<header class="center">
  ${logo ? `<img class="logo" src="${esc(logo)}" alt="${esc(centerName)} logo">` : ""}
  <div>
    <p class="center-name">${esc(centerName)}</p>
    ${island ? `<p class="island">${esc(island)}</p>` : ""}
  </div>
</header>

<main>
  <h1>${esc(name)}</h1>
  <p class="intro">
    ${duration ? `<strong>${esc(duration)}.</strong> ` : ""}
    ${inc.v ? `${esc(includesWord)} ${esc(inc.v)}.` : ""}
  </p>

  <div class="field">
    <label for="date">${esc(isCourse ? t.startDate : t.date)}</label>
    <input id="date" type="date" min="${minDate}" max="${maxDate}" required aria-describedby="date-error">
    <p id="date-error" class="error" role="alert" hidden></p>
    <p class="hint">${esc(t.earliest(minLabel))}</p>
  </div>

  <div class="field">
    <label id="divers-label">${esc(t.diversLabel)}</label>
    <div class="stepper" role="group" aria-labelledby="divers-label">
      <button type="button" id="minus" aria-label="${esc(t.less)}">−</button>
      <output id="divers" aria-live="polite">1</output>
      <button type="button" id="plus" aria-label="${esc(t.more)}">+</button>
    </div>
    <p class="hint">${esc(t.group(assistant))}</p>
  </div>

  <section class="slate" aria-label="${esc(t.payNow)}">
    <div class="above">
      <div class="row total"><span>${esc(t.totalFor)} <span id="lbl-divers">${esc(diversLabel(1, lang))}</span></span><span><b id="total">${thb(price)}</b> THB</span></div>
      <div class="row now"><span>${esc(t.payNow)}</span><span><b id="deposit">${thb(deposit)}</b> THB</span></div>
    </div>
    <svg class="waterline" viewBox="0 0 400 24" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 12 C 50 2, 100 22, 150 12 S 250 2, 300 12 S 380 20, 400 12 V24 H0Z"/>
    </svg>
    <div class="below">
      <div class="row"><span>${esc(t.payShop)}</span><span><b id="balance">${thb(price - deposit)}</b> THB</span></div>
      <p class="fine">${esc(t.never)}</p>
    </div>
  </section>

  <button type="button" id="book" class="book">${esc(t.btn[0])}<span id="btn-amount">${thb(deposit)}</span>${esc(t.btn[1])}</button>
  <p id="msg" class="msg" role="status" hidden></p>

  ${(checkIn || meeting) ? `<dl class="practical">
    ${checkIn ? `<div><dt>${esc(t.checkIn)}</dt><dd>${esc(checkIn)}</dd></div>` : ""}
    ${meeting ? `<div><dt>${esc(t.meeting)}</dt><dd>${esc(meeting)}</dd></div>` : ""}
  </dl>` : ""}
</main>

<script id="data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script>
(() => {
  const d = JSON.parse(document.getElementById("data").textContent);
  const s = d.s;
  const $ = (id) => document.getElementById(id);
  const f = (n) => Math.round(n).toLocaleString("en-US");
  let n = 1;
  function render() {
    $("divers").textContent = n;
    $("lbl-divers").textContent = n + " " + (n === 1 ? s.diver : s.divers);
    $("total").textContent = f(d.price * n);
    $("deposit").textContent = f(d.deposit * n);
    $("btn-amount").textContent = f(d.deposit * n);
    $("balance").textContent = f((d.price - d.deposit) * n);
    $("minus").disabled = n <= 1;
    $("plus").disabled = n >= d.max;
  }
  $("minus").onclick = () => { if (n > 1) { n--; render(); } };
  $("plus").onclick = () => { if (n < d.max) { n++; render(); } };
  // iPhones ignore min/max on date fields, so check the date ourselves.
  function dateProblem() {
    const v = $("date").value;
    if (!v) return s.chooseDate;
    if (v < d.minDate) return s.tooSoon;
    if (v > d.maxDate) return s.tooFar;
    return "";
  }
  function showDateError(problem) {
    const box = $("date-error");
    $("date").classList.toggle("invalid", !!problem);
    box.hidden = !problem;
    box.textContent = problem || "";
  }
  $("date").addEventListener("change", () => {
    showDateError($("date").value ? dateProblem() : "");
    $("msg").hidden = true;
  });
  $("book").onclick = () => {
    const msg = $("msg");
    const problem = dateProblem();
    if (problem) {
      msg.hidden = true;
      showDateError(problem);
      $("date").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    msg.hidden = false;
    if (!d.payments) { msg.textContent = s.noPay; return; }
    const btn = $("book");
    btn.disabled = true;
    msg.textContent = s.opening;
    fetch("/b/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: d.slug, code: d.code, ref: d.ref, lang: d.lang, date: $("date").value, divers: n }),
    })
      .then((r) => r.json())
      .then((r) => {
        if (r.url) { window.location.href = r.url; return; }
        msg.textContent = r.error || s.wrong;
        btn.disabled = false;
      })
      .catch(() => { msg.textContent = s.noConn; btn.disabled = false; });
  };
  render();
})();
</script>`;
}

function fmtDate(iso, lang = "en") {
  return new Date(iso + "T00:00:00Z").toLocaleDateString(LOCALES[lang] || "en-GB",
    { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

function notFound(lang) {
  const t = T[lang];
  return `<main class="empty"><h1>${esc(t.notFoundTitle)}</h1>
  <p>${esc(t.notFoundText)}</p></main>`;
}
function problem(text, lang) {
  return `<main class="empty"><h1>${esc(T[lang].problemTitle)}</h1><p>${esc(text)}</p></main>`;
}

function page(body, status = 200, lang = "en", title = "") {
  const html = `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title || T[lang].title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Vary": "Accept-Language" },
  });
}

const CSS = `
:root{--ink:#0F2E35;--sea:#1C6E7D;--shallow:#E4F0F1;--deep:#123A43;--page:#FBFCFC;--line:#CFDFE1;--muted:#4F6B70}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
html,body{overflow-x:hidden}
body{margin:0;background:var(--page);color:var(--ink);font:400 17px/1.5 "Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:30rem;margin:0 auto;padding:1.5rem 1.25rem 3rem}
.center{display:flex;align-items:center;gap:.85rem;margin-bottom:2rem}
.logo{width:52px;height:52px;object-fit:contain;border-radius:12px;background:#fff;border:1px solid var(--line)}
.center-name{margin:0;font-weight:600}
.island{margin:0;color:var(--muted);font-size:.9rem}
h1{font-size:2.1rem;line-height:1.1;letter-spacing:-.02em;margin:0 0 .6rem;font-weight:700}
.intro{margin:0 0 2rem;color:var(--muted)}
.intro strong{color:var(--ink);font-weight:600}
.field{margin-bottom:1.5rem}
label,#divers-label{display:block;font-weight:600;margin-bottom:.4rem}
input[type=date]{-webkit-appearance:none;appearance:none;display:block;min-width:0;max-width:100%;text-align:left;width:100%;font:inherit;color:inherit;padding:.75rem .9rem;border:1.5px solid var(--line);border-radius:10px;background:#fff;min-height:3rem}
input[type=date]:focus-visible,.stepper button:focus-visible,.book:focus-visible{outline:3px solid var(--sea);outline-offset:2px}
input[type=date].invalid{border-color:#B4492F;background:#FDF4F1}
input[type=date]::-webkit-date-and-time-value{text-align:left}
.error{margin:.5rem 0 0;color:#9E3B24;font-weight:600;font-size:.95rem}
.hint{margin:.4rem 0 0;font-size:.85rem;color:var(--muted)}
.stepper{display:inline-flex;align-items:center;border:1.5px solid var(--line);border-radius:10px;background:#fff;overflow:hidden}
.stepper button{width:3rem;height:3rem;border:0;background:none;font:inherit;font-size:1.4rem;color:var(--sea);cursor:pointer}
.stepper button:disabled{color:var(--line);cursor:default}
.stepper output{min-width:2.5rem;text-align:center;font-weight:600;font-size:1.1rem}
.slate{margin:2rem 0 1.25rem;border-radius:16px;overflow:hidden;border:1.5px solid var(--line)}
.slate .above{background:var(--shallow);padding:1.1rem 1.2rem .4rem}
.slate .below{background:var(--deep);color:#E8F2F3;padding:.2rem 1.2rem 1.1rem;margin-top:-1px}
.waterline{display:block;width:100%;height:18px;background:var(--shallow)}
.waterline path{fill:var(--deep)}
.row{display:flex;justify-content:space-between;gap:1rem;align-items:baseline;padding:.3rem 0}
.row>span:last-child{white-space:nowrap;text-align:right}
.row b{font-weight:700;font-variant-numeric:tabular-nums}
.total{color:var(--muted);font-size:.95rem}
.now{font-size:1.1rem}
.now b{font-size:1.5rem}
.fine{margin:.35rem 0 0;font-size:.82rem;color:#A9C6CA}
.book{width:100%;min-height:3.4rem;border:0;border-radius:12px;background:var(--sea);color:#fff;font:inherit;font-weight:600;font-size:1.05rem;cursor:pointer}
.book:hover{background:#175E6B}
.book:disabled{opacity:.6;cursor:default}
.book.danger{background:#fff;color:#9E3B24;border:1.5px solid #D9A99A}
.book.danger:hover{background:#FDF4F1}
.warn{margin:0;padding:.8rem 1rem;border-radius:10px;background:#FFF3D6;color:#6B4A00;font-size:.95rem}
.testmode{margin:0 0 1rem;padding:.5rem .8rem;border-radius:8px;background:#FFF3D6;color:#6B4A00;font-size:.85rem;font-weight:600}
.msg{margin:.9rem 0 0;padding:.8rem 1rem;border-radius:10px;background:var(--shallow);font-size:.95rem}
.practical{margin:2.25rem 0 0;padding-top:1.25rem;border-top:1px solid var(--line);display:grid;gap:.8rem}
.practical div{display:grid;grid-template-columns:7.5rem 1fr;gap:.75rem}
.practical dt{color:var(--muted)}
.practical dd{margin:0}
.empty{padding-top:3rem}
.empty h1{font-size:1.6rem}
.empty p{color:var(--muted)}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;
