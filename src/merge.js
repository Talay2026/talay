// One guest message with several questions: Make (inbound v2) stacks the approved texts one
// after the other. This endpoint lets Claude turn that stack into one natural reply, without
// changing a single fact. Called by Make right before Webhooks 29: talay.io/api/merge
//
// POST form or JSON { key, text, message, language, multi, repeat, sent, code }
// repeat = 1: the guest asks the same thing again and would get the same approved answer
// twice. Claude says it again, shorter and in other words, and asks what is still unclear.
// sent (added 1 Nov): what Mia already sent earlier in this chat, as the "Mia reply" codes of
// Inbox ("product FUN*2 | faq dates + bring"). code: what Mia sends now ("product FUN").
// With sent, offers and tips that were already given (or no longer fit) are left out, and a
// product that was already sent in full comes back short (again = 1, also without multi).
// -> { text, merged, why }   text is always safe to send: the merged reply, or the original.
//
// Safety: only the part between [[split]] (intro bubble) and [[buttons]] is rewritten. The
// rewrite is thrown away (original text goes out) when a link or price is left out, when a
// link or number is new (a changed price counts as new),
// when it is much longer or shorter, when it holds a [[marker]], or when Claude is slow or fails.

const MERGE_PROMPT = `You are the WhatsApp assistant of a dive centre. In <drafts> are ready-made answers, approved by the centre, to the questions in one guest message. They were simply stacked one after the other. Turn them into ONE natural WhatsApp reply to <guest>.

Rules:
- Write in the language of the drafts.
- Use only information that is in the drafts. Never add facts, advice, offers, prices or promises.
- Copy every number, price, currency, date, time, duration, percentage and link you use exactly as written. Digits stay digits. Every link stays on its own line, as in the drafts.
- Always keep every price, deposit and link.
- Answer what the guest asked, short and complete. Leave out details the guest did not ask about (for example times of other courses), repeated greetings, repeated sign-offs, repeated emojis and sentences that say the same thing twice.
- Answer in the order the guest asked.
- Short paragraphs with a blank line between them. Plain text, no markdown. Keep bullets only where the drafts use them.
- At most one question to the guest, at the very end: keep the closing question from the drafts that moves towards booking.
- If the guest says they just booked or paid, start with one short, warm line about that (use the thank-you line from the drafts when there is one). Never say a booking is confirmed unless the drafts say so.
- <already_sent> lists what the assistant already sent earlier in this chat ("product FUN" = the fun dive trip with its price, tips, offers and link; "faq refresher_short" = the refresher advice). Leave out offers and tips that were already given there (for example the 10 fun dives package tip, "ask me for the link", the refresher tip), and tips that no longer fit what the guest already did or said (for example "start with the Scuba Review" when the guest already booked or chose the Scuba Review).
- Return only the reply.`;

const REPEAT_NOTE = "The guest already got exactly this answer and is asking the same thing again: maybe it did not arrive, or it was too long. Reply warmly and much shorter: at most one short sentence per question, keep every price, deposit and link, drop the rest. You may start with a light, friendly opener such as \"Here it is in short 😊\". End with one warm, open question such as \"Is there anything I can explain better?\" or \"Shall I help you pick a date?\". Never sound impatient: no \"as I said\", no \"what is still unclear\", no apology. The rules above still apply.";

const AGAIN_NOTE = "The guest already got the full information about this product earlier in this chat (see <already_sent>). Now give only what they ask for, usually the link with the price for their group and the deposit: one or two short sentences and the link. Leave out the product description, tips and offers. Keep every price, deposit and link that is not part of an optional offer. No closing question unless the guest asked something open.";

const URL_RE = /https?:\/\/[^\s<>"]+/g;
const NUM_RE = /\d+(?:[.,:   ]\d+)*/g;

function links(s) {
  return (s.match(URL_RE) || []).map((u) => u.replace(/[.,!?)\]]+$/, ""));
}
function numbers(s) {
  return (s.replace(URL_RE, " ").match(NUM_RE) || []).map((n) => n.replace(/[   ]/g, " "));
}
// Numbers next to a currency: these may never be left out.
const MONEY_RE = /(?:THB|฿|€|\$|EUR|USD|baht)\s?\d+(?:[.,\u202f\u00a0 ]\d+)*|\d+(?:[.,\u202f\u00a0 ]\d+)*\s?(?:THB|฿|€|\$|EUR|USD|baht)/gi;
function money(s) {
  return (s.replace(URL_RE, " ").match(MONEY_RE) || []).flatMap((m) => numbers(m));
}
// Every item of `part` must be in `all`; returns the first one that isn't, or "".
function missing(part, all) {
  const set = new Set(all);
  return part.find((x) => !set.has(x)) || "";
}

// An optional offer or tip: a paragraph without a link that asks the guest something
// ("Diving more days? Ask me about the 10 fun dives package (9,000 THB)"). Its prices may be
// left out; every other price, deposit and total must stay.
function optional(p) {
  return /[?？]/.test(p) && !links(p).length;
}
function protectedMoney(o) {
  const paras = o.split(/\n\s*\n/);
  const keep = paras.filter((p) => !optional(p)).flatMap(money);
  return keep;
}

// Exported for tests: why a rewrite is not safe, or "" when it is.
// guest: the guest's own message; numbers from it (a date like "the 16th") may be used.
export function checkRewrite(original, rewrite, guest = "") {
  const o = original.trim(), r = String(rewrite || "").trim();
  if (!r) return "empty";
  if (/\[\[|\]\]/.test(r)) return "marker";
  let m;
  if ((m = missing(links(o), links(r)))) return "link left out: " + m;
  if ((m = missing(links(r), links(o)))) return "new link: " + m;
  // A number from the guest's message may be used (a date), never as a price.
  const oNums = new Set(numbers(o)), gNums = new Set(numbers(String(guest))), rMoney = new Set(money(r));
  m = numbers(r).find((n) => !oNums.has(n) && !(gNums.has(n) && !rMoney.has(n)));
  if (m) return "new number: " + m; // a changed price shows up here too
  if ((m = missing(protectedMoney(o), numbers(r)))) return "price left out: " + m;
  if (r.length > o.length * 1.1 + 40) return "longer";
  if (r.length < o.length * 0.2) return "shorter";
  return "";
}

// Exported for tests: [head, body, tail] where only body may be rewritten.
export function splitParts(text) {
  let head = "", body = text, tail = "";
  const s = body.indexOf("[[split]]");
  if (s >= 0) { head = body.slice(0, s + 9); body = body.slice(s + 9); }
  const b = body.indexOf("[[buttons]]");
  if (b >= 0) { tail = body.slice(b); body = body.slice(0, b); }
  const lead = body.match(/^\s*/)[0], trail = body.match(/\s*$/)[0];
  return [head + lead, body.trim(), trail + tail];
}

// Exported for tests: was this product already sent earlier in the chat? code "product FUN",
// sent "faq dive_sites | product FUN*2 | product REF" -> true. FUN10 is not FUN.
export function sentBefore(sent, code) {
  const c = code.trim().match(/^product\s+([A-Z0-9_]+)/i);
  if (!c) return false;
  return sent.split(/[|\n]/).some((x) => {
    const t = x.trim().match(/^product\s+([A-Z0-9_]+)/i);
    return !!t && t[1].toUpperCase() === c[1].toUpperCase();
  });
}

export async function handleMerge(request, env) {
  const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  // Make sends a form (x-www-form-urlencoded), so long texts with quotes and newlines arrive intact. JSON works too.
  let p = {};
  try {
    const raw = await request.text();
    p = raw.trim().startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
  } catch { return out({ error: "send a form or JSON" }, 400); }
  if (!env.PUSH_KEY || p.key !== env.PUSH_KEY) return out({ error: "forbidden" }, 403);
  const text = String(p.text ?? "");
  const keep = (why) => out({ text, merged: false, why });
  const flag = (v) => v === true || v === 1 || /^(1|true|yes)$/i.test(String(v ?? "").trim());
  const multi = flag(p.multi), repeat = flag(p.repeat);
  const sent = String(p.sent ?? "").slice(0, 600);
  const again = sentBefore(sent, String(p.code ?? ""));
  if (!multi && !repeat && !again) return keep("single");
  if (!env.ANTHROPIC_API_KEY) return keep("no key");
  const [head, body, tail] = splitParts(text);
  if (!body) return keep("empty");
  if (!repeat && !again && body.split(/\n\s*\n/).filter((x) => x.trim()).length < 2) return keep("one part");
  if (body.length > 6000) return keep("too long");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(env.MERGE_TIMEOUT_MS) || 6000);
  let rewrite = "";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2026-10-21" },
      body: JSON.stringify({
        model: env.MERGE_MODEL || "claude-haiku-5-5", max_tokens: 1500, system: MERGE_PROMPT,
        messages: [{ role: "user", content: `<guest>\n${String(p.message ?? "").slice(0, 2000)}\n</guest>\n<language>${String(p.language ?? "").slice(0, 10)}</language>\n<drafts>\n${body}\n</drafts>` + (sent.trim() ? `\n<already_sent>\n${sent}\n</already_sent>` : "") + (repeat ? `\n<repeat>${REPEAT_NOTE}</repeat>` : again ? `\n<again>${AGAIN_NOTE}</again>` : "") }],
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.stop_reason !== "end_turn") { console.error("merge", r.status, JSON.stringify(d).slice(0, 300)); return keep("claude"); }
    rewrite = (d.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  } catch (e) {
    console.error("merge", e.name, e.message);
    return keep(e.name === "AbortError" ? "slow" : "claude");
  } finally {
    clearTimeout(timer);
  }
  const why = checkRewrite(body, rewrite, p.message);
  if (why) { console.log("merge kept original:", why); return keep(why); }
  return out({ text: head + rewrite + tail, merged: true, why: "" });
}
