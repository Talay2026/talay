// Talay booking page: talay.io/b/[center-slug]?p=[product-code]
// Reads the center and product from Airtable (read-only token) and renders a
// white-label page: the diver sees the dive center, not Talay.
// Everything outside /b/ is served from /public by the assets binding.

const CACHE_SECONDS = 120; // limits Airtable API calls; logo links stay valid
const MAX_DIVERS = 5; // 6+ goes to a person (rule from the conversation flow)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/b/")) return env.ASSETS.fetch(request);

    const slug = url.pathname.slice(3).replace(/\/+$/, "").toLowerCase();
    const code = (url.searchParams.get("p") || "").toUpperCase();

    if (!/^[a-z0-9-]{1,60}$/.test(slug) || !/^[A-Z0-9]{1,12}$/.test(code)) {
      return page(notFound(), 404);
    }
    if (!env.AIRTABLE_TOKEN) {
      return page(problem("The booking page is not set up yet (missing key)."), 500);
    }

    try {
      const [center, product] = await Promise.all([
        airtableOne(env, ctx, "Centers", `{Slug} = '${slug}'`),
        airtableOne(env, ctx, "Products",
          `AND({Code} = '${code}', FIND('${slug}', ARRAYJOIN({C slug})))`),
      ]);
      if (!center || !product) return page(notFound(), 404);
      return page(bookingPage(center, product, code));
    } catch (err) {
      console.error(err);
      return page(problem("We couldn't load this booking right now. Try again in a minute."), 502);
    }
  },
};

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

function bookingPage(c, p, code) {
  const centerName = first(c["Name"]) || "Dive center";
  const island = first(c["Island"]) || "";
  const assistant = first(c["Assistant name"]) || "us";
  const logo = first(c["Logo"])?.thumbnails?.large?.url || first(c["Logo"])?.url || "";
  const meeting = cap(first(c["Meeting point"]) || "");

  const name = first(p["Name"]) || code;
  const price = num(p["Price THB"]);
  const deposit = num(p["Deposit THB"]);
  const duration = first(p["Duration"]) || "";
  const included = first(p["Included"]) || "";
  const checkIn = cap(first(p["Check-in"]) || "");
  const cutoff = num(p["Cutoff hour"]) || 15;

  const minDate = earliestDate(cutoff);
  const maxDate = plusDays(minDate, 180);
  const data = { price, deposit, max: MAX_DIVERS, assistant, payments: false,
    minDate, maxDate, minLabel: fmtDate(minDate) };

  return `
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
    ${included ? `Includes ${esc(included)}.` : ""}
  </p>

  <div class="field">
    <label for="date">${code === "OW" || /course|diver/i.test(name) ? "Start date" : "Date"}</label>
    <input id="date" type="date" min="${minDate}" max="${maxDate}" required aria-describedby="date-error">
    <p id="date-error" class="error" role="alert" hidden></p>
    <p class="hint">Earliest date you can still book online: ${esc(fmtDate(minDate))}.</p>
  </div>

  <div class="field">
    <label id="divers-label">Number of divers</label>
    <div class="stepper" role="group" aria-labelledby="divers-label">
      <button type="button" id="minus" aria-label="One diver less">−</button>
      <output id="divers" aria-live="polite">1</output>
      <button type="button" id="plus" aria-label="One diver more">+</button>
    </div>
    <p class="hint">Coming with 6 or more? Message ${esc(assistant)} on WhatsApp and the team will plan it with you.</p>
  </div>

  <section class="slate" aria-label="Price">
    <div class="above">
      <div class="row total"><span>Total for <span id="lbl-divers">1 diver</span></span><span><b id="total">${thb(price)}</b> THB</span></div>
      <div class="row now"><span>Pay now to secure your spot</span><span><b id="deposit">${thb(deposit)}</b> THB</span></div>
    </div>
    <svg class="waterline" viewBox="0 0 400 24" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 12 C 50 2, 100 22, 150 12 S 250 2, 300 12 S 380 20, 400 12 V24 H0Z"/>
    </svg>
    <div class="below">
      <div class="row"><span>Pay at the shop on the day</span><span><b id="balance">${thb(price - deposit)}</b> THB</span></div>
      <p class="fine">You never pay more than the shop price.</p>
    </div>
  </section>

  <button type="button" id="book" class="book">Pay <span id="btn-amount">${thb(deposit)}</span> THB and book</button>
  <p id="msg" class="msg" role="status" hidden></p>

  ${(checkIn || meeting) ? `<dl class="practical">
    ${checkIn ? `<div><dt>Check-in</dt><dd>${esc(checkIn)}</dd></div>` : ""}
    ${meeting ? `<div><dt>Meeting point</dt><dd>${esc(meeting)}</dd></div>` : ""}
  </dl>` : ""}
</main>

<script id="data" type="application/json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script>
(() => {
  const d = JSON.parse(document.getElementById("data").textContent);
  const $ = (id) => document.getElementById(id);
  const f = (n) => Math.round(n).toLocaleString("en-US");
  let n = 1;
  function render() {
    $("divers").textContent = n;
    $("lbl-divers").textContent = n + (n === 1 ? " diver" : " divers");
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
    if (!v) return "Choose a date first.";
    if (v < d.minDate) return "That date is too soon to book online. Choose " + d.minLabel + " or later.";
    if (v > d.maxDate) return "That date is too far ahead to book online. Message " + d.assistant + " on WhatsApp.";
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
    if (!d.payments) {
      msg.textContent = "Online payment opens soon. For now, reply to " + d.assistant +
        " on WhatsApp with your date and number of divers, and the team will book you in.";
    }
  };
  render();
})();
</script>`;
}

function fmtDate(iso) {
  return new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB",
    { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

function notFound() {
  return `<main class="empty"><h1>This booking link doesn't work</h1>
  <p>Open the link again from your WhatsApp chat with the dive center, or send them a message and they'll send a new one.</p></main>`;
}
function problem(text) {
  return `<main class="empty"><h1>Booking page unavailable</h1><p>${esc(text)}</p></main>`;
}

function page(body, status = 200) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Book your dive</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
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
