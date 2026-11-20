// Lead agent: shared logic for the three channels (email, WhatsApp, phone calls).
//
// This file is plain JavaScript with no imports or exports. scripts/build.mjs
// pastes it at the top of every n8n Code node, and tests/ and evals/ load it
// with loadLib() from scripts/lib-loader.mjs. Keep it free of n8n globals
// ($env, $input, this.helpers): anything that does I/O lives in io.js and
// receives its dependencies as arguments, so everything here runs offline.

const MODEL = 'claude-haiku-5-5';

const CATEGORY_TO_STREAM = {
  buyer: 'buyer',
  bond: 'buyer',
  tenant: 'tenant',
  seller: 'seller_mandate',
  landlord: 'landlord_mandate',
  valuation: 'valuation',
};

const SYSTEM_SENDER_DOMAINS = [
  'cal.com', 'resend.dev', 'amazonses.com', 'cloudflare.com', 'sendgrid.net',
  'mailchimp.com', 'mcsv.net', 'mailgun.org', 'hubspotemail.net', 'facebookmail.com',
  'linkedin.com', 'google.com', 'accounts.google.com', 'microsoft.com',
];

function configFromEnv(env) {
  const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    // Kill switch: false sends every draft to a person instead of the customer.
    autoSend: String(env.AGENT_AUTO_SEND || 'false').toLowerCase() === 'true',
    escalationEmail: env.AGENT_ESCALATION_EMAIL || '',
    digestEmail: env.AGENT_DIGEST_EMAIL || env.AGENT_ESCALATION_EMAIL || '',
    formsDir: env.AGENT_FORMS_DIR || '/home/node/forms',
    bccEmail: env.AGENT_BCC_EMAIL || '',
    fromAddress: env.AGENT_FROM || '',
    ownAddresses: list(env.AGENT_OWN_ADDRESSES),
    maxAutoReplies24h: Number(env.AGENT_MAX_AUTO_REPLIES_24H || 3),
    urlAllowlist: list(env.AGENT_URL_ALLOWLIST || 'harbourkey.example'),
    model: env.AGENT_MODEL || MODEL,
    // WhatsApp (see "WhatsApp" below) has its own kill switch and limits.
    waAutoSend: String(env.AGENT_WA_AUTO_SEND || 'false').toLowerCase() === 'true',
    waMaxAutoReplies24h: Number(env.AGENT_WA_MAX_AUTO_REPLIES_24H || 10),
    // The approved template for the WhatsApp a caller asks for (see callWhatsApp); empty: off.
    waCallTemplate: String(env.AGENT_WA_CALL_TEMPLATE || '').trim(),
  };
}

// The config for one channel: WhatsApp swaps in its own kill switch and reply limit.
function channelConfig(cfg, channel) {
  if (channel !== 'whatsapp') return cfg;
  return { ...cfg, autoSend: cfg.waAutoSend, maxAutoReplies24h: cfg.waMaxAutoReplies24h };
}

// South African time (UTC+2, no daylight saving).
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const saDate = (now) => new Date(now.getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
const saTime = (iso) => new Date(new Date(iso).getTime() + 2 * 3600 * 1000).toISOString().slice(11, 16);

// ---------------------------------------------------------------- intake

function headerValue(headers, key) {
  if (!headers) return '';
  const raw = headers[key.toLowerCase()];
  if (raw == null) return '';
  const line = Array.isArray(raw) ? raw.join(' ') : String(raw);
  const i = line.indexOf(':');
  // The IMAP node stores the full header line ("Auto-Submitted: auto-replied").
  return (i >= 0 && line.slice(0, i).toLowerCase() === key.toLowerCase() ? line.slice(i + 1) : line).trim();
}

function firstAddress(field) {
  if (!field) return { address: '', name: '' };
  if (typeof field === 'string') {
    const m = field.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>/);
    return m ? { address: m[2].trim().toLowerCase(), name: m[1].trim() } : { address: field.trim().toLowerCase(), name: '' };
  }
  const v = Array.isArray(field.value) ? field.value[0] : field;
  return { address: String((v && v.address) || '').trim().toLowerCase(), name: String((v && v.name) || '').trim() };
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

// Drop the quoted history below a reply so the model sees only the new text.
function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^On .+wrote:$/i.test(t) || /^Op .+geskryf:$/i.test(t)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(t)) break;
    // Outlook style quote block: "From: ... Sent: ..."
    if (/^From:\s.+/i.test(t) && out.some((l) => l.trim() !== '')) break;
    if (/^_{10,}$/.test(t)) break;
    if (t.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// One item from n8n's IMAP trigger ("resolved" format) to the shape the rest of the code uses.
function normalizeImap(j) {
  const from = firstAddress(j.from);
  const to = firstAddress(j.to);
  const refs = Array.isArray(j.references) ? j.references.join(' ') : String(j.references || '');
  const text = j.text || htmlToText(j.html || j.textHtml || '') || j.textPlain || '';
  return {
    from: from.address,
    fromName: from.name,
    to: to.address,
    subject: String(j.subject || '').trim(),
    messageId: String(j.messageId || headerValue(j.headers, 'message-id') || '').trim(),
    inReplyTo: String(j.inReplyTo || '').trim(),
    references: refs.trim(),
    date: j.date || new Date().toISOString(),
    bodyFull: String(text).slice(0, 20000),
    bodyNew: stripQuoted(text).slice(0, 8000),
    headers: {
      autoSubmitted: headerValue(j.headers, 'auto-submitted').toLowerCase(),
      precedence: headerValue(j.headers, 'precedence').toLowerCase(),
      listId: headerValue(j.headers, 'list-id'),
      listUnsubscribe: headerValue(j.headers, 'list-unsubscribe'),
      xAutoreply: headerValue(j.headers, 'x-autoreply') || headerValue(j.headers, 'x-autorespond'),
      returnPath: headerValue(j.headers, 'return-path'),
    },
  };
}

// Returns a reason string when the message must be ignored, else null.
// This runs before any model call: bounces, auto-replies and newsletters cost
// nothing, and an auto-reply can never start a mail loop with another robot.
function dropReason(msg, cfg) {
  const from = msg.from;
  if (!from || !from.includes('@')) return 'no sender';
  const domain = from.split('@')[1];
  if (cfg.ownAddresses.includes(from)) return 'own address';
  if (/^(mailer-daemon|postmaster|bounce[s]?|no-?reply|do-?not-?reply|donotreply|notifications?|alerts?)([+.@_-]|$)/i.test(from)) return 'system sender';
  if (SYSTEM_SENDER_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) return 'system domain';
  const h = msg.headers || {};
  if (h.autoSubmitted && h.autoSubmitted !== 'no') return 'auto-submitted';
  if (['bulk', 'list', 'junk', 'auto_reply'].includes(h.precedence)) return 'bulk precedence';
  if (h.listId || h.listUnsubscribe) return 'mailing list';
  if (h.xAutoreply) return 'auto-reply header';
  if (h.returnPath === '<>') return 'null return path';
  if (/^(auto(matic)?[ -]?reply|out of (the )?office|afwesig|undeliverable|delivery status notification|mail delivery failed)/i.test(msg.subject)) return 'auto-reply subject';
  if (!msg.bodyNew || msg.bodyNew.replace(/\s/g, '').length < 2) return 'empty body';
  return null;
}

// ---------------------------------------------------------------- prompt

function fmtRand(n) {
  if (n == null || n === '') return '';
  return 'R' + Math.round(Number(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function listingsBlock(listings) {
  if (!listings || !listings.length) return 'LIVE LISTINGS: none on our books right now.';
  const rows = listings.map((l) => {
    const levy = l.levies_zar_pm ? `${fmtRand(l.levies_zar_pm)}/month ${l.sectional_title_scheme ? 'levy' : 'HOA levy'}` : 'no levy listed';
    return [
      `- ${l.title}`,
      `  Type: ${l.unit_type || 'n/a'}. Price: ${fmtRand(l.price_zar)}${l.vat_inclusive ? ' (VAT inclusive, no transfer duty)' : ''}. ${levy}.`,
      `  Status: ${l.status}. Occupation: ${l.occupation_date || 'on completion'}. Location: ${l.address || ''}`,
      l.body ? `  Details: ${String(l.body).replace(/\s+/g, ' ').slice(0, 700)}` : '',
    ].filter(Boolean).join('\n');
  });
  return 'LIVE LISTINGS (our only current stock; never mention anything else as available):\n' + rows.join('\n');
}

// Which listings each budget-sized amount covers, worked out here instead of by the model:
// it has told a buyer nothing was within their budget while quoting a home well under it.
function priceCheckBlock(listings, msg, contact) {
  const SALE_MIN = 100000; // below this an amount is a levy, a rental or a salary, not a purchase budget
  const priced = (listings || []).map((l) => ({ title: l.title, price: Math.round(Number(l.price_zar)) }))
    .filter((l) => l.price >= SALE_MIN).sort((a, b) => a.price - b.price);
  const amounts = new Set(moneyAmounts(msg && msg.bodyNew).filter((n) => n >= SALE_MIN));
  const saved = Math.round(Number(contact && contact.sale_budget_max_zar));
  if (saved >= SALE_MIN) amounts.add(saved);
  if (!priced.length || !amounts.size) return '';
  const names = (rows) => rows.map((l) => `${l.title} (${fmtRand(l.price)})`).join('; ') || 'none';
  const lines = [...amounts].sort((a, b) => a - b).slice(0, 3).map((n) =>
    `- ${fmtRand(n)}: at or below it: ${names(priced.filter((l) => l.price <= n))}. Above it: ${names(priced.filter((l) => l.price > n))}.`);
  return 'Price check (worked out by our system, always correct). If an amount here is their budget, these are the listings within it:\n' + lines.join('\n');
}

function contactBlock(contact) {
  if (!contact) return 'Known about this contact: nothing, this is a new contact.';
  const keys = ['first_name', 'last_name', 'mobile', 'email', 'stream', 'pipeline_stage', 'suburb', 'sale_unit_type', 'sale_development',
    'sale_buyer_profile', 'sale_budget_max_zar', 'sale_bond_status', 'rent_target_band_zar', 'rent_move_in_date', 'rent_household_size',
    'rent_pets', 'mandate_property_address', 'landlord_property_address', 'val_property_address'];
  const known = keys.filter((k) => contact[k] != null && contact[k] !== '').map((k) => `${k}: ${contact[k]}`);
  // Other numbers and addresses they gave us (see contactPatch).
  for (const t of contact.tags || []) {
    const m = /^(phone|email):(.+)$/.exec(t);
    if (m) known.push(`other ${m[1]}: ${m[2]}`);
  }
  return 'Known about this contact:\n' + (known.length ? known.join('\n') : 'nothing yet');
}

const CONVERSATION_EVENTS = ['email_inbound', 'email_outbound', 'web_form', 'whatsapp_inbound', 'whatsapp_outbound', 'call_inbound'];

// events: newest first, as recentEvents() returns them.
function historyBlock(events) {
  const msgs = (events || [])
    .filter((e) => CONVERSATION_EVENTS.includes(e.event_type))
    .slice(0, 8)
    .reverse()
    .map((e) => {
      const who = e.event_type === 'call_inbound' ? 'Phone call with our AI assistant'
        : (e.direction === 'outbound' ? 'Us' : 'Customer') + (e.event_type.startsWith('whatsapp') ? ' on WhatsApp' : '');
      const p = e.payload || {};
      const text = String(p.text || p.message || '').slice(0, 1500);
      const files = (p.attachments || []).map((a) => (typeof a === 'string' ? a : a.title || a.name)).filter(Boolean);
      const note = files.length ? `\n[${e.direction === 'outbound' ? 'we attached' : 'they attached'}: ${files.join(', ')}]` : '';
      return `[${String(e.created_at).slice(0, 16).replace('T', ' ')}] ${who}: ${text}${note}`;
    });
  return msgs.length ? msgs.join('\n\n') : '';
}

// The Messages API request for one email, one burst of WhatsApp messages or one
// finished phone call. The customer's words only ever appear inside <email>,
// <whatsapp>, <call> and <history> tags, which the system prompt tells the model
// to treat as data. The system prompt and the listings are cached between requests.
function buildClaudeRequest({ msg, contact, events, listings, forms, systemPrompt, schema, cfg, now }) {
  const history = historyBlock(events);
  const today = (now || new Date()).toISOString().slice(0, 10);
  const wa = msg.channel === 'whatsapp';
  const voice = msg.channel === 'voice';
  const userText = [
    voice ? `Today is ${today}. Triage the phone call below. Nothing you write is sent to the caller.`
      : `Today is ${today}. Reply to the ${wa ? 'WhatsApp message' : 'email'} below.`,
    contactBlock(contact),
    voice ? '' : priceCheckBlock(listings, msg, contact),
    history ? `<history>\n${history}\n</history>` : `No earlier messages: this is their first ${voice ? 'contact with us' : wa ? 'message to us' : 'email to us'}.`,
    voice ? callBlock(msg) : wa
      ? `<whatsapp>\nFrom: ${msg.fromName ? msg.fromName + ' ' : ''}(WhatsApp ${msg.phone})\n\n${msg.bodyNew || '(no text, only attachments)'}\n</whatsapp>`
      : `<email>\nFrom: ${msg.fromName ? msg.fromName + ' ' : ''}<${msg.from}>\nSubject: ${msg.subject}\n\n${msg.bodyNew}\n</email>`,
  ].filter(Boolean).join('\n\n');
  return {
    model: cfg.model || MODEL,
    // Thinking counts towards max_tokens, so leave room for it above the reply.
    max_tokens: 16000,
    system: [
      { type: 'text', text: systemPrompt },
      { type: 'text', text: formsBlock(forms) + '\n\n' + listingsBlock(listings), cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userText }],
    // Not 'low': at low effort the model barely thinks, and it has compared a budget with our prices wrongly.
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
  };
}

// ---------------------------------------------------------------- response

// Every way a call can go wrong ends up as { ok: false, error }, which decide() escalates.
function parseClaudeResponse(resp) {
  if (!resp || typeof resp !== 'object') return { ok: false, error: 'no response from Claude' };
  if (resp.error) return { ok: false, error: `Claude API error: ${resp.error.message || JSON.stringify(resp.error).slice(0, 300)}` };
  if (resp.stop_reason === 'refusal') return { ok: false, error: 'Claude declined to answer (refusal)' };
  if (resp.stop_reason === 'max_tokens') return { ok: false, error: 'Claude response was cut off (max_tokens)' };
  const block = (resp.content || []).find((b) => b.type === 'text');
  if (!block) return { ok: false, error: 'Claude returned no text block' };
  try {
    return { ok: true, result: JSON.parse(block.text), usage: resp.usage || {} };
  } catch (e) {
    return { ok: false, error: 'Claude returned invalid JSON' };
  }
}

function sanitizeReply(body) {
  return String(body || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/ +- +/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Things an estate agency's automated reply must never say. Each pattern was
// tightened against real drafts: declining to quote a rate is fine, quoting one is not.
const BANNED = [
  [/\b(interest|prime|repo|bond) rates?\b[^.\n]{0,60}\d/i, 'mentions interest or bond rates'],
  [/\brepayments? (of|would be|will be|around|about) /i, 'mentions repayments'],
  [/(?<!\b(whether|if|what) )\byou(('|’)?ll| will) (easily |definitely )?qualify\b|\bqualify for (a bond of |up to )?R ?\d|\bpre-?approved for R/i, 'affordability or qualification claim'],
  // "no bond or transfer costs payable" comes from the listings and is allowed.
  [/(?<!\bno (bond or )?)\btransfer (duty|costs?|fees?)\b|\bconveyancing (fees?|costs?)\b|\bregistration (fees?|costs?)\b/i, 'mentions transfer or conveyancing costs'],
  [/\byields?\b|\bcapital growth\b|\breturn on investment\b|\bROI\b/i, 'mentions yields or growth'],
  // Agency commission is off limits; a client who earns commission is not.
  [/(?<!\b(earn(s|ing)?|paid|mostly|mainly) (mostly |mainly )?(on )?)\bcommission\b(?! ?(income|earners?|earnings|-?based))/i, 'mentions commission'],
  [/\bguarantee/i, 'uses guarantee'],
  [/\b(luxur|premier\b|world-class|seamless|unlock)/i, 'banned marketing word'],
  [/%/, 'contains a percentage'],
  [/\[\[|\]\]|\{\{|\}\}/, 'unfilled placeholder'],
  [/\b(automated|AI-generated|as an AI|language model)\b/i, 'mentions automation'],
];

// Rand amounts in a text: "R980 000", "R1.2m", "R900k", "R1,500,000".
function moneyAmounts(text) {
  const out = [];
  // Capital R not preceded by a letter, so "your 2 bedroom" is not R2.
  const re = /(?<![A-Za-z])R ?(\d{1,3}(?:[ ,. ]\d{3})+|\d+(?:[.,]\d+)?) ?([kK]|[mM]il(?:lion)?|[mM])?\b/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    let n = Number(m[1].replace(/[ , ]/g, '').replace(/\.(?=\d{3}\b)/g, ''));
    const unit = (m[2] || '').toLowerCase();
    if (unit === 'k') n *= 1000;
    if (unit.startsWith('m')) n *= 1000000;
    if (!Number.isNaN(n)) out.push(Math.round(n));
  }
  return out;
}

// Day-month pairs ("MM-DD") in a text, for checking dates the model writes.
const MONTH_KEYS = { jan: 1, feb: 2, maart: 3, mar: 3, apr: 4, may: 5, mei: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, okt: 10, nov: 11, dec: 12, des: 12 };
function datesIn(text) {
  const s = String(text || '');
  const out = [];
  const md = (m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null);
  const mon = '(jan|feb|maart|mar|apr|may|mei|jun|jul|aug|sep|oct|okt|nov|dec|des)[a-z]*';
  let m;
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${mon}\\b`, 'gi');
  while ((m = dayFirst.exec(s))) out.push(md(MONTH_KEYS[m[2].toLowerCase()], Number(m[1])));
  const monthFirst = new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?![\\d,]*\\d{3})`, 'gi');
  while ((m = monthFirst.exec(s))) out.push(md(MONTH_KEYS[m[1].toLowerCase()], Number(m[2])));
  const iso = /\b\d{4}-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(s))) out.push(md(Number(m[1]), Number(m[2])));
  const slash = /\b(\d{1,2})\/(\d{1,2})\/\d{4}\b/g;
  while ((m = slash.exec(s))) out.push(md(Number(m[2]), Number(m[1])));
  return [...new Set(out.filter(Boolean))];
}

// Checks a draft before it can be sent. Returns a list of problems; an empty
// list means the draft may go out. Any problem sends the draft to a person.
// The model is asked to follow these rules too, but the prompt is not the control: this is.
function guardrails(result, { listings, cfg, msg, autoRepliesLast24h }) {
  const issues = [];
  const body = sanitizeReply(result.reply && result.reply.body);
  if (result.category === 'spam') return issues;
  if (!body) issues.push('empty reply');
  if (body.length > 1800) issues.push('reply too long');
  for (const [re, label] of BANNED) if (re.test(body)) issues.push(label);
  // Links: only our own site.
  const urls = body.match(/\b(?:https?:\/\/|www\.)[^\s)]+/gi) || [];
  for (const u of urls) {
    const host = u.replace(/^https?:\/\//i, '').split(/[/?#]/)[0].toLowerCase().replace(/^www\./, '');
    if (!cfg.urlAllowlist.some((d) => host === d || host.endsWith('.' + d))) issues.push(`link not allowed: ${host}`);
  }
  // Any email address other than the customer's own or ours. On WhatsApp, theirs is one they typed.
  const wa = msg.channel === 'whatsapp';
  const emailRe = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
  const found = (text) => (String(text || '').match(emailRe) || []).map((e) => e.toLowerCase().replace(/\.+$/, ''));
  const theirs = wa ? found(msg.bodyFull) : [msg.from];
  for (const e of found(body)) if (!theirs.includes(e) && !cfg.ownAddresses.includes(e)) issues.push(`unexpected email address: ${e}`);
  // Rand amounts must come from a listing or from the customer.
  const known = new Set();
  for (const l of listings || []) {
    if (l.price_zar != null) known.add(Math.round(Number(l.price_zar)));
    if (l.levies_zar_pm != null) known.add(Math.round(Number(l.levies_zar_pm)));
    for (const n of moneyAmounts(l.body)) known.add(n);
  }
  for (const n of moneyAmounts(msg.bodyFull)) known.add(n);
  for (const n of moneyAmounts(body)) if (!known.has(n)) issues.push(`unverified amount R${n}`);
  // Dates must come from the customer: the agent never confirms a viewing or promises a date itself.
  const knownDates = new Set(datesIn(msg.bodyFull));
  for (const d of datesIn(body)) if (!knownDates.has(d)) issues.push(`unverified date ${d}`);
  // The text and the attachments must agree.
  const attaching = (result.attach || []).length > 0;
  if (attaching && !/attach/i.test(body)) issues.push('form attached but the reply does not mention it');
  if (!attaching && /\b(I've|I have|we've|we have) attached\b|\b(please find|you'll find|you will find)\b[^.\n]{0,40}\battached\b|\bfind attached\b|\battached to this email\b/i.test(body)) {
    issues.push('reply mentions an attachment but none is attached');
  }
  // An ongoing WhatsApp chat doesn't open with a greeting each time.
  if (body && !wa && !/^(Hi|Hello|Hallo|Dear|Goeie ?(dag|môre|middag|naand))\b[^\n]{0,40},?$/im.test(body)) issues.push('missing greeting');
  if (autoRepliesLast24h >= cfg.maxAutoReplies24h) issues.push(`auto-reply limit reached (${autoRepliesLast24h} in 24h)`);
  return issues;
}

// Decide what the workflow does with this message.
// action: 'spam' | 'optout' | 'send' | 'escalate'
// sendHolding: on escalate, whether the drafted holding reply also goes to the customer.
// forceReason: the workflow itself needs a person (e.g. a voice note it cannot open).
function decide(parsed, issues, cfg, forceReason) {
  if (!parsed.ok) return { action: 'escalate', reason: parsed.error, sendHolding: false };
  const r = parsed.result;
  if (r.category === 'spam' && !forceReason) return { action: 'spam', reason: 'spam', sendHolding: false };
  if (r.category === 'opt_out') return { action: 'optout', reason: 'opt-out request', sendHolding: cfg.autoSend && issues.length === 0 };
  const needsHuman = forceReason || r.category === 'escalate' || (r.escalate && r.escalate.needed) || r.confidence === 'low';
  // Someone trying to manipulate the agent gets no reply at all.
  const injection = /inject/i.test((r.escalate && r.escalate.reason) || '');
  if (needsHuman) {
    return {
      action: 'escalate',
      reason: forceReason || (r.escalate && r.escalate.reason) || (r.confidence === 'low' ? 'low confidence' : 'needs a human'),
      sendHolding: cfg.autoSend && issues.length === 0 && !injection,
    };
  }
  if (issues.length) return { action: 'escalate', reason: 'draft failed safety checks: ' + issues.join('; '), sendHolding: false };
  if (!cfg.autoSend) return { action: 'escalate', reason: 'auto-send is off, draft for review', sendHolding: false };
  return { action: 'send', reason: 'auto-sent', sendHolding: false };
}

// ---------------------------------------------------------------- forms we send

// forms: forms/catalog.json, injected by scripts/build.mjs. The reply schema's
// "attach" field is an enum of these ids, so the model cannot attach anything else.
function formsBlock(forms) {
  if (!forms || !forms.length) return 'FORMS YOU CAN ATTACH: none.';
  return 'FORMS YOU CAN ATTACH (put the id in "attach"):\n' +
    forms.map((f) => `- ${f.id}: ${f.title}. Send when: ${f.send_when}`).join('\n');
}

function formAttachments(ids, forms, formsDir) {
  return (ids || []).map((id) => (forms || []).find((f) => f.id === id)).filter(Boolean)
    .map((f) => ({ id: f.id, title: f.title, filename: f.filename, path: `${String(formsDir).replace(/\/$/, '')}/${f.file}` }));
}

// ---------------------------------------------------------------- CRM

// What the model extracted, as a patch for the contacts table. It only ever
// fills empty columns: nothing a person typed into the CRM is overwritten.
function contactPatch(result, contact, source = 'source:email-agent') {
  const x = result.extracted || {};
  const c = contact || {};
  const patch = {};
  const setIfEmpty = (col, val) => {
    if (val == null || val === '' || (Array.isArray(val) && !val.length)) return;
    if (c[col] == null || c[col] === '') patch[col] = val;
  };
  setIfEmpty('first_name', x.first_name);
  setIfEmpty('last_name', x.last_name);
  const tags = Array.isArray(c.tags) ? c.tags.slice() : [];
  const addTag = (t) => { if (!tags.includes(t)) tags.push(t); };
  // A second address or number they mention is kept as a tag, not swapped in.
  const email = String(x.email || '').trim().toLowerCase();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    if (!c.email) patch.email = email;
    else if (email !== String(c.email).toLowerCase()) addTag(`email:${email}`);
  }
  const phone = normalizePhone(x.phone);
  if (phone) {
    if (!c.mobile) patch.mobile = phone;
    else if (phone !== c.mobile) addTag(`phone:${phone}`);
  }
  const stream = CATEGORY_TO_STREAM[result.category];
  if (stream && (!c.stream || c.stream === 'general')) patch.stream = stream;
  if (x.areas && x.areas.length) setIfEmpty('suburb', x.areas.join(', '));
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (['buyer', 'bond'].includes(result.category)) {
    const unit = [x.bedrooms ? `${x.bedrooms}-bed` : '', (x.property_types || []).join('/')].filter(Boolean).join(' ');
    setIfEmpty('sale_unit_type', unit);
    setIfEmpty('sale_budget_max_zar', x.budget_max_zar);
    setIfEmpty('sale_bond_status', x.finance);
    setIfEmpty('sale_buyer_profile', x.buyer_profile);
    setIfEmpty('sale_development', x.listing_of_interest);
  }
  if (result.category === 'tenant') {
    setIfEmpty('rent_target_band_zar', x.rent_budget_zar_pm);
    if (isDate(x.move_in_date)) setIfEmpty('rent_move_in_date', x.move_in_date);
    setIfEmpty('rent_household_size', x.household_size);
    setIfEmpty('rent_pets', x.pets);
  }
  if (result.category === 'seller') setIfEmpty('mandate_property_address', x.property_address);
  if (result.category === 'landlord') setIfEmpty('landlord_property_address', x.property_address);
  if (result.category === 'valuation') setIfEmpty('val_property_address', x.property_address);
  addTag(source);
  // They said yes to hearing about matching listings (only ever with their consent).
  if (x.listing_alerts === true) addTag('listing-alerts');
  patch.tags = tags;
  return patch;
}

// South African numbers to E.164.
function normalizePhone(p) {
  if (!p) return null;
  let d = String(p).replace(/[^\d+]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (d.startsWith('0') && d.length === 10) d = '+27' + d.slice(1);
  if (d.startsWith('27') && d.length === 11) d = '+' + d;
  return /^\+\d{10,15}$/.test(d) ? d : null;
}

function splitName(display) {
  const parts = String(display || '').replace(/["']/g, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts[0].includes('@')) return { first_name: null, last_name: null };
  return { first_name: parts[0], last_name: parts.length > 1 ? parts.slice(1).join(' ') : null };
}

// New CRM contact for whoever sent msg (email address, WhatsApp number or caller ID).
function newContact(msg, { first_name = null, last_name = null, stream = 'general' } = {}) {
  const who = msg.channel === 'whatsapp' ? { mobile: msg.phone, tags: ['source:whatsapp'] }
    : msg.channel === 'voice' ? { mobile: msg.phone, tags: ['source:voice'] }
    : { email: msg.from, tags: ['source:email-agent'] };
  return { ...who, first_name, last_name, stream, pipeline_stage: 'New Enquiry' };
}

// ---------------------------------------------------------------- email out

function quoteOriginal(msg) {
  const when = new Date(msg.date || Date.now()).toUTCString();
  const quoted = String(msg.bodyNew || '').split('\n').map((l) => '> ' + l).join('\n');
  return `On ${when}, ${msg.fromName || msg.from} wrote:\n${quoted}`;
}

function replySubject(result, msg) {
  const s = (result.reply && result.reply.subject) || '';
  if (s.trim()) return s.trim();
  return /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject || 'Your enquiry'}`;
}

// The email a person gets when the agent hands over: why, what we know, the
// customer's email and the draft. Reply-To is the customer, so answering it answers them.
function escalationEmail(msg, parsed, decision, issues, holdingSent, attachTitles = []) {
  const r = parsed.ok ? parsed.result : null;
  const wa = msg.channel === 'whatsapp';
  if (msg.channel === 'voice') return callEscalationEmail(msg, parsed, decision, issues);
  const lines = wa
    ? [
      `Reason: ${decision.reason}`,
      `From: ${msg.fromName || ''} on WhatsApp ${msg.phone}`.replace(/\s+/g, ' '),
      holdingSent ? 'A short holding reply WAS sent to them on WhatsApp (see draft below).' : 'Nothing was sent to the customer.',
      `Staff don't chat on the WhatsApp number, so contact them yourself: phone them on ${msg.phone}, or email them if they gave an address.`,
      '',
    ]
    : [
      `Reason: ${decision.reason}`,
      `From: ${msg.fromName || ''} <${msg.from}>`,
      `Subject: ${msg.subject}`,
      holdingSent ? 'A short holding reply WAS sent to the customer (see draft below).' : 'Nothing was sent to the customer. Reply to this email to answer them directly.',
      '',
    ];
  if (r) {
    lines.push(`Category: ${r.category}   Confidence: ${r.confidence}`, `Summary: ${r.summary}`);
    const x = Object.entries(r.extracted || {}).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
    if (x.length) lines.push('', 'What we know:', ...x.map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`));
    if (r.missing_info && r.missing_info.length) lines.push('', 'Still missing: ' + r.missing_info.join(', '));
  }
  if (issues && issues.length) lines.push('', 'Safety check issues: ' + issues.join('; '));
  lines.push('', wa ? '---------- Their WhatsApp messages ----------' : '---------- Customer email ----------', msg.bodyNew || '(no text, only attachments)');
  if (r && r.reply && r.reply.body) lines.push('', '---------- AI draft ----------', sanitizeReply(r.reply.body));
  if (attachTitles.length) lines.push('', `The draft would attach: ${attachTitles.join(', ')} (attached here so you can forward it).`);
  return {
    subject: `[Lead agent] Needs you: ${String(decision.reason).slice(0, 80)} (${wa ? 'WhatsApp ' + msg.phone : msg.from})`,
    text: lines.join('\n'),
  };
}

// ---------------------------------------------------------------- daily digest

// rows: the last 24 hours of ai_triage and web_form events, oldest first, each with its contact.
function digestEmail(rows, cfg, day) {
  const name = (c) => (c ? `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.email || c.mobile : 'unknown');
  const leads = [];
  const escalations = [];
  const optouts = [];
  let spam = 0;
  for (const e of rows || []) {
    const p = e.payload || {};
    const c = e.contacts;
    const who = c ? `${name(c)}${c.email ? ` <${c.email}>` : ''}${c.mobile ? ', ' + c.mobile : ''}` : 'unknown';
    if (e.event_type === 'web_form') {
      leads.push(`- ${who} (website form, ${p.stream}): ${String(p.text || '').slice(0, 160)}`);
      continue;
    }
    if (p.action === 'spam') { spam++; continue; }
    if (p.action === 'optout') { optouts.push(`- ${who}`); continue; }
    const missing = p.missing_info && p.missing_info.length ? ` Missing: ${p.missing_info.join(', ')}.` : '';
    const line = `- ${who} [${p.category || 'unknown'}, ${c ? c.pipeline_stage : ''}]: ${p.summary || p.error || ''}${missing}`;
    if (p.action === 'escalate') escalations.push(`${line}\n  Why: ${p.reason}`);
    else leads.push(line);
  }
  const text = [
    `Enquiries, last 24 hours (${day})`,
    '',
    `Handled by the AI: ${leads.length}. Needed a person: ${escalations.length}. Opt-outs: ${optouts.length}. Spam ignored: ${spam}.`,
    '',
    escalations.length ? 'NEEDED A PERSON (check these were answered)\n' + escalations.join('\n') : 'Nothing needed a person.',
    '',
    leads.length ? 'ENQUIRIES\n' + leads.join('\n') : 'No new enquiries.',
    optouts.length ? '\nOPT-OUTS\n' + optouts.join('\n') : '',
    '',
    `Auto-send is ${cfg.autoSend ? 'ON' : 'OFF'}.`,
  ].join('\n');
  return {
    subject: `Daily digest: ${leads.length} enquiries, ${escalations.length} need you`,
    text,
    counts: { leads: leads.length, escalations: escalations.length, optouts: optouts.length, spam },
  };
}

// ---------------------------------------------------------------- WhatsApp
// The WhatsApp number is Harbour Key's VoIP number on Meta's
// WhatsApp Cloud API; its phone calls still go through Asterisk (see "Phone
// calls"). Nobody at the office chats on it: the AI answers, and anything it
// can't handle goes to staff by email, who follow up by phone or email.
// Meta posts JSON to the webhook, signed with the App Secret:
//   { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
//       metadata: { phone_number_id }, contacts: [{ wa_id, profile: { name } }],
//       messages: [{ from: '27...', id: 'wamid...', timestamp, type, text: { body }, image: { id, mime_type, caption }, ... }],
//       statuses: [{ id, status: 'sent' | 'delivered' | 'read' | 'failed', recipient_id, errors: [{ code, title }] }] } }] }] }
// statuses are about messages we sent.
// A burst of messages ("Hi" + 4 photos) is answered once: Receive logs each
// message, waits WA_BATCH_SECONDS, and only the newest message's run replies,
// to everything not yet answered.

const WA_BATCH_SECONDS = 20;

// Meta's limit for one text message.
const WA_MAX_CHARS = 4096;

// '27821234567' -> '+27821234567'
function waPhone(waId) {
  const digits = String(waId || '').replace(/\D/g, '');
  return digits ? normalizePhone('+' + digits) : null;
}

// Meta's timestamp (seconds) as ISO; now if it's missing.
function waTime(ts) {
  const t = Number(ts);
  return new Date(t > 0 ? t * 1000 : Date.now()).toISOString();
}

// What one WhatsApp message says, in the shape stored in the whatsapp_inbound event:
// { type, text, needs_person } or { ignore: true }.
function waContent(m) {
  const type = String((m && m.type) || '');
  const o = (m && m[type]) || {};
  if (type === 'text') {
    const text = String(o.body || '');
    return text.trim() ? { type, text } : { ignore: true };
  }
  // The production system downloads these and checks them (ID, payslips, signed
  // forms). This extract has no document checks, so a person looks at them.
  if (type === 'image' || type === 'document') {
    const what = type === 'image' ? 'photo' : 'document';
    return { type, text: `[They sent a ${what}, which a person on the team will look at]${o.caption ? ' ' + o.caption : ''}`, needs_person: `they sent a ${what}` };
  }
  if (type === 'audio') return { type, text: '[They sent a voice note, which we cannot play here]', needs_person: 'they sent a voice note' };
  if (type === 'video') return { type, text: `[They sent a video, which we cannot view here]${o.caption ? ' ' + o.caption : ''}`, needs_person: 'they sent a video' };
  if (type === 'location') {
    return { type, text: `[Shared a location: ${[o.name, o.address].filter(Boolean).join(', ') || 'no name'} (${o.latitude}, ${o.longitude})]` };
  }
  if (type === 'contacts') return { type, text: '[Shared a contact card]' };
  // A tapped button: on a template (button) or an interactive message.
  if (type === 'button' && (o.text || o.payload)) return { type, text: String(o.text || o.payload) };
  const tapped = type === 'interactive' && (o.button_reply || o.list_reply);
  if (tapped && tapped.title) return { type: 'button', text: String(tapped.title) };
  // Reactions, stickers, and anything Meta marks unsupported.
  return { ignore: true };
}

// Parses one webhook post: customer messages, and replies of ours that failed.
// Only changes for our number (phoneNumberId) count: the app also has Meta's test number.
function parseWhatsAppWebhook(body, phoneNumberId) {
  const out = { messages: [], failed: [] };
  if (!body || body.object !== 'whatsapp_business_account') return out;
  for (const entry of body.entry || []) {
    for (const change of (entry && entry.changes) || []) {
      const v = change && change.field === 'messages' && change.value;
      if (!v || String((v.metadata || {}).phone_number_id) !== String(phoneNumberId)) continue;
      const names = new Map((v.contacts || []).map((c) => [String(c.wa_id), String((c.profile && c.profile.name) || '')]));
      for (const m of v.messages || []) {
        const phone = waPhone(m.from);
        const content = waContent(m);
        if (phone && m.id && !content.ignore) out.messages.push({ id: String(m.id), phone, name: names.get(String(m.from)) || '', at: waTime(m.timestamp), ...content });
      }
      for (const s of v.statuses || []) {
        if (s.status !== 'failed' || !s.id) continue;
        const e = (s.errors || [])[0] || {};
        out.failed.push({ id: String(s.id), phone: waPhone(s.recipient_id), error: [e.code, e.title || e.message].filter(Boolean).join(': ') || 'failed' });
      }
    }
  }
  return out;
}

// Meta checks the webhook URL with a GET when it's saved in the app: echoing
// hub.challenge back, only for our verify token, proves the URL is ours.
// Returns the challenge, or null.
function waVerify(query, verifyToken) {
  const q = query || {};
  if (q['hub.mode'] !== 'subscribe' || !safeEqual(q['hub.verify_token'], verifyToken)) return null;
  return String(q['hub.challenge'] || '') || null;
}

// The whatsapp_inbound event for one parsed message.
function waInboundEvent(m) {
  return {
    event_type: 'whatsapp_inbound', channel: 'whatsapp', direction: 'inbound', contact_id: null,
    payload: { message_id: m.id, wa_id: m.phone, name: m.name || null, at: m.at, type: m.type, text: String(m.text || '').slice(0, 4000),
      needs_person: m.needs_person || null },
  };
}

// Messages not yet answered (or passed to staff), oldest first.
// inbound: whatsapp_inbound events; handled: message ids already dealt with.
function waPending(inbound, handled) {
  const done = new Set(handled || []);
  return (inbound || []).filter((e) => e.payload && !done.has(e.payload.message_id))
    .sort((a, b) => String(a.payload.at).localeCompare(String(b.payload.at)) || String(a.created_at).localeCompare(String(b.created_at)));
}

// Only the run for the newest logged message answers; earlier runs step aside.
function waIsNewest(pending, messageId) {
  const mine = pending.find((e) => e.payload.message_id === messageId);
  if (!mine) return false;
  const t = new Date(mine.created_at).getTime();
  return !pending.some((e) => new Date(e.created_at).getTime() > t);
}

// Pending messages from one person, as one message in the shape normalizeImap returns.
function normalizeWhatsApp(phone, pending) {
  const p = pending.map((e) => e.payload);
  const last = p[p.length - 1];
  const text = p.map((x) => x.text).filter(Boolean).join('\n\n').slice(0, 8000);
  const needs = [...new Set(p.map((x) => x.needs_person).filter(Boolean))];
  return {
    channel: 'whatsapp',
    from: phone,
    phone,
    fromName: p.map((x) => x.name).filter(Boolean).pop() || '',
    to: '',
    subject: '',
    messageId: last.message_id,
    messageIds: p.map((x) => x.message_id),
    eventIds: pending.map((e) => e.id).filter(Boolean),
    inReplyTo: '',
    references: '',
    date: last.at,
    bodyFull: text,
    bodyNew: text,
    needsPerson: needs.length ? needs.join('; ') : null,
    headers: {},
  };
}

// Nobody at the office sees the WhatsApp chats, so each conversation is emailed
// to AGENT_WA_TRANSCRIPT_EMAIL (default AGENT_ESCALATION_EMAIL) once it has been quiet
// for WA_TRANSCRIPT_QUIET_MINUTES. A whatsapp_transcript event records how far
// each number has been emailed (payload.until, a created_at): when they write
// again, the next email has only the new part.
const WA_TRANSCRIPT_QUIET_MINUTES = 120;

// Within one second, the customer's message comes before our note on it and our reply.
const WA_TRANSCRIPT_ORDER = { whatsapp_inbound: 0, ai_triage: 1, whatsapp_skipped: 1, whatsapp_outbound: 2, whatsapp_failed: 3 };
const waEventTime = (e) => (e.event_type === 'whatsapp_inbound' && e.payload.at) || e.created_at;

// Conversations ready to email: [{ phone, events }], events in the order they happened.
// events: WhatsApp events since some time (each with payload.wa_id); sent: whatsapp_transcript events since then.
function waTranscriptsDue(events, sent, now = Date.now()) {
  // Supabase writes created_at in one format, so the strings sort in time order.
  const until = new Map();
  for (const s of sent || []) {
    const p = s.payload || {};
    if (p.wa_id && String(p.until || '') > (until.get(p.wa_id) || '')) until.set(p.wa_id, String(p.until));
  }
  const chats = new Map();
  for (const e of events || []) {
    const phone = e.payload && e.payload.wa_id;
    if (!phone || String(e.created_at) <= (until.get(phone) || '')) continue;
    if (!chats.has(phone)) chats.set(phone, []);
    chats.get(phone).push(e);
  }
  const quietFrom = now - WA_TRANSCRIPT_QUIET_MINUTES * 60 * 1000;
  const out = [];
  for (const [phone, list] of chats) {
    if (!list.some((e) => e.event_type === 'whatsapp_inbound' || e.event_type === 'whatsapp_outbound')) continue;
    if (list.some((e) => new Date(e.created_at).getTime() > quietFrom)) continue;
    list.sort((a, b) => String(waEventTime(a)).localeCompare(String(waEventTime(b))) ||
      (WA_TRANSCRIPT_ORDER[a.event_type] || 0) - (WA_TRANSCRIPT_ORDER[b.event_type] || 0));
    out.push({ phone, events: list });
  }
  return out;
}

// '2026-10-31T12:02:00Z' -> '31 Oct 14:02' (South African time).
function waClock(iso) {
  const d = new Date(new Date(iso).getTime() + 2 * 3600 * 1000);
  return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()].slice(0, 3)} ${saTime(iso)}`;
}

// The email for one conversation: { subject, text, until }. contact: their CRM row, or null.
function waTranscriptEmail(phone, events, contact) {
  const c = contact || {};
  const profile = events.map((e) => e.event_type === 'whatsapp_inbound' && e.payload.name).filter(Boolean).pop() || '';
  const name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || profile;
  const them = c.first_name || profile || 'Customer';
  const said = { them: 0, us: 0 };
  const body = [];
  for (const e of events) {
    const p = e.payload || {};
    const at = `[${waClock(waEventTime(e))}]`;
    if (e.event_type === 'whatsapp_inbound') {
      said.them++;
      body.push(`${at} ${them}:\n${p.text || ''}`);
    } else if (e.event_type === 'whatsapp_outbound') {
      said.us++;
      const files = p.attachments && p.attachments.length ? `\n[Sent: ${p.attachments.join(', ')}]` : '';
      body.push(`${at} Lead agent:\n${p.text || ''}${files}`);
    } else if (e.event_type === 'ai_triage') {
      if (p.action === 'escalate') body.push(`${at} Passed to staff: ${p.reason || 'no reason given'}`);
      else if (p.action === 'optout') body.push(`${at} They opted out of messages.`);
      else if (p.action === 'spam') body.push(`${at} Treated as spam, not answered.`);
    } else if (e.event_type === 'whatsapp_skipped') {
      body.push(`${at} Not answered: ${p.reason || 'skipped'}.`);
    } else if (e.event_type === 'whatsapp_failed') {
      body.push(`${at} Our message was not delivered: ${p.error || 'failed'}`);
    }
  }
  const first = waEventTime(events[0]);
  const last = waEventTime(events[events.length - 1]);
  const details = [c.email && `Email: ${c.email}`, c.stream && `Stream: ${c.stream}`, c.pipeline_stage && `Stage: ${c.pipeline_stage}`].filter(Boolean);
  const text = [
    `WhatsApp conversation with ${name ? `${name} (${phone})` : phone}`,
    ...(details.length ? [details.join('   ')] : []),
    `${waClock(first)} to ${waClock(last)}: ${said.them} message${said.them === 1 ? '' : 's'} from them, ${said.us} from us.`,
    '',
    ...body.flatMap((b) => [b, '']),
    c.email ? `Replying to this email writes to ${c.email}.` : 'We have no email address for them: phone them to follow up.',
  ].join('\n');
  return {
    subject: `[Lead agent] WhatsApp chat with ${name ? `${name} (${phone})` : phone}, ${waClock(first).replace(/ \d\d:\d\d$/, '')}`,
    text,
    // Every event's created_at, not just the last in time order (inbound sorts by when they sent it).
    until: events.map((e) => String(e.created_at)).sort().pop(),
  };
}

// A reply split into WhatsApp messages of at most max characters, at paragraph,
// line or word breaks.
function waChunks(text, max = WA_MAX_CHARS) {
  const out = [];
  let rest = String(text || '').trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// Compares secrets without leaking where they differ.
function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0 && x.length > 0;
}

// ---------------------------------------------------------------- Phone calls (voice agent)
// Harbour Key's phone line is a VoIP number on a SIP trunk, registered by
// Asterisk on the VPS (server/asterisk/). OpenAI's Realtime model answers the
// calls, and voice/ (a small service next to n8n) runs each one:
//   Asterisk dialplan -> CURL POST /voice/asterisk/calls -> voiceRoute:
//     agent off (or something fails) -> "office": Asterisk dials AGENT_OFFICE_NUMBER
//     agent on, or a test number     -> a one-time UUID: Asterisk streams the
//       call's audio to voice/ over AudioSocket (TCP), and voice/ relays it to an
//       OpenAI Realtime WebSocket with voiceSession and voiceInstructions.
//   When the call ends, voice/ posts the transcript to Lead Voice Calls, which
//   triages it with Haiku (prepareCall and actOnCall in io.js): call_inbound and
//   ai_triage events, escalation email.
// Staff never take over a call. Anything a person must handle comes by email
// with the transcript, and staff phone the caller back.

const VOICE_MODEL = 'gpt-realtime-2.1';

function voiceConfig(env) {
  const phones = (v) => String(v || '').split(',').map((s) => normalizePhone(s.trim())).filter(Boolean);
  return {
    // Kill switch: off means every call rings the office.
    enabled: String(env.AGENT_VOICE_ENABLED || 'false').toLowerCase() === 'true',
    // Numbers that reach the agent even while it is off, for testing.
    testNumbers: phones(env.AGENT_VOICE_TEST_NUMBERS),
    officeNumber: normalizePhone(env.AGENT_OFFICE_NUMBER) || '+27000000000',
    hasKey: !!String(env.OPENAI_API_KEY || '').trim(),
    // Told to callers who want to send documents; empty until WhatsApp is set up.
    whatsappNumber: normalizePhone(env.AGENT_WA_NUMBER),
    // The agent can promise a WhatsApp after the call (send_whatsapp).
    whatsappFollowUp: !!(normalizePhone(env.AGENT_WA_NUMBER) && String(env.AGENT_WA_CALL_TEMPLATE || '').trim()),
    model: env.AGENT_VOICE_MODEL || VOICE_MODEL,
    voice: env.AGENT_VOICE_VOICE || 'marin',
    transcribeModel: env.AGENT_VOICE_TRANSCRIBE_MODEL || 'gpt-transcribe',
    maxMinutes: Number(env.AGENT_VOICE_MAX_MINUTES || 15),
    // Seconds of silence before the agent checks the caller is still there.
    silenceSeconds: Number(env.AGENT_VOICE_SILENCE_SECONDS || 8),
  };
}

// 'agent' or 'office' for a call from phone.
function voiceRoute(vcfg, phone) {
  if (!vcfg.hasKey) return 'office';
  if (vcfg.enabled) return 'agent';
  return phone && vcfg.testNumbers.includes(phone) ? 'agent' : 'office';
}

// The caller ID as Asterisk gives it: national (0821234567), +27..., 0027... or 27...
// Anything without enough digits (anonymous, withheld) is null.
function trunkCaller(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/\D/g, '');
  if (digits.length < 9) return null;
  if (s.startsWith('+')) return normalizePhone('+' + digits);
  if (digits.startsWith('00')) return normalizePhone('+' + digits.slice(2));
  if (digits.startsWith('0')) return normalizePhone('+27' + digits.slice(1));
  return normalizePhone('+' + digits);
}

// The office number as the trunk dials it (national: 0000000000).
function trunkDialString(e164) {
  const p = normalizePhone(e164) || '';
  return p.startsWith('+27') ? '0' + p.slice(3) : p.replace(/^\+/, '00');
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// 'Friday 16 October 2026, 14:05' in South African time.
function saClock(now) {
  const d = new Date(now.getTime() + 2 * 3600 * 1000);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hm}`;
}

// The Realtime model's instructions for one call: its own prompt
// (prompts/voice-agent.system.md, with the shared rules) plus what we know. No
// purchase details: caller ID can be faked, so the agent never discusses a purchase on the phone.
function voiceInstructions({ systemPrompt, contact, events, listings, phone, whatsapp = null, now = new Date() }) {
  const history = historyBlock(events);
  return [
    systemPrompt,
    '# This call',
    `You are on a live phone call now: follow "# On a live call". It is ${saClock(now)} in Port Haven.`,
    `Caller ID: ${phone || 'withheld'}. Caller ID can be faked, so it doesn't prove who is calling.`,
    whatsapp ? `Our WhatsApp number is ${whatsapp} (say it as a phone number, digit by digit).` : 'We have no WhatsApp number yet: for documents and the form, give our email address only.',
    `${contactBlock(contact)}\n(This is only so you don't ask for what we already know. Never read it back to the caller.)`,
    history ? `<history>\n${history}\n</history>` : 'No earlier messages or calls from this number.',
    listingsBlock(listings),
  ].join('\n\n');
}

const VOICE_TOOLS = [
  {
    type: 'function',
    name: 'take_message',
    description: 'Record a message so someone at the office phones the caller back. Use it whenever a person must handle something (see "Always escalate"), the caller asks for someone, or they want a viewing or valuation arranged. Then tell the caller someone will phone them back.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why a person must call back, in a few words, e.g. "wants to view The Quay on Saturday morning".' },
        message: { type: 'string', description: 'What they want, in one or two sentences.' },
        caller_name: { type: 'string', description: 'Their name, if they gave it.' },
        callback_number: { type: 'string', description: 'Only if they want a call back on a different number from the one they are calling from.' },
        best_time: { type: 'string', description: 'When suits them for the call back, if they said.' },
        email: { type: 'string', description: 'Their email address, if they gave it.' },
      },
      required: ['reason', 'message'],
    },
  },
  {
    type: 'function',
    name: 'end_call',
    description: 'Hang up. Only when the caller has nothing else, and only after saying goodbye out loud in the same response: calling it without speaking cuts the caller off.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

const SEND_WHATSAPP_TOOL = {
  type: 'function',
  name: 'send_whatsapp',
  description: 'WhatsApp the caller what they asked for (listing details, what the bond team needs, how to reach us) on the number they are calling from, straight after the call. Use it when they ask for something to be sent, or say yes when you offer. Then tell them it will arrive on WhatsApp just after the call.',
  parameters: {
    type: 'object',
    properties: { about: { type: 'string', description: 'What to send, e.g. "details of Kingsmead Heights".' } },
    required: ['about'],
  },
};

// Only the written transcript uses it (the model hears the audio itself): without
// it a "yes" came out as Hebrew and a caller's first name as a country.
const TRANSCRIBE_HINT = 'A phone call to Harbour Key Properties, an estate agency in Port Haven, South Africa. ' +
  'Callers speak South African English or Afrikaans and mention names, suburbs, prices in rand and phone numbers.';

// The session.update for the Realtime WebSocket. Phone audio is G.711 mu-law
// both ways (voice/ converts Asterisk's 8 kHz PCM).
function voiceSession(vcfg, instructions) {
  return {
    type: 'realtime',
    model: vcfg.model,
    output_modalities: ['audio'],
    instructions,
    audio: {
      input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad' }, transcription: { model: vcfg.transcribeModel, prompt: TRANSCRIBE_HINT } },
      output: { format: { type: 'audio/pcmu' }, voice: vcfg.voice },
    },
    tools: vcfg.whatsappFollowUp ? [...VOICE_TOOLS, SEND_WHATSAPP_TOOL] : VOICE_TOOLS,
    tool_choice: 'auto',
  };
}

// ---- after the call: the transcript voice/ posts to Lead Voice Calls
// call: { call_id, call_sid, phone, started_at, ended_at, duration_seconds, ended_by,
//         turns: [{ role: 'caller' | 'agent', text }], messages: [take_message arguments], errors }

const CALL_MAX_TRANSCRIPT = 12000;

function fmtDuration(seconds) {
  const n = Math.max(0, Math.round(Number(seconds) || 0));
  return n >= 60 ? `${Math.floor(n / 60)} min ${n % 60} s` : `${n} s`;
}

function callTranscript(turns) {
  return (turns || []).filter((t) => t && t.text && String(t.text).trim())
    .map((t) => `${t.role === 'agent' ? 'Agent' : 'Caller'}: ${String(t.text).trim().replace(/\s+/g, ' ')}`).join('\n');
}

// A finished call, in the shape normalizeImap returns.
function normalizeCall(call) {
  const turns = (call.turns || []).filter((t) => t && t.text && String(t.text).trim());
  const messages = (call.messages || []).filter((m) => m && typeof m === 'object');
  const callerText = turns.filter((t) => t.role !== 'agent').map((t) => String(t.text).trim()).join('\n');
  const phone = normalizePhone(call.phone);
  return {
    channel: 'voice',
    from: phone || 'withheld number',
    phone,
    fromName: messages.map((m) => m.caller_name).filter(Boolean).pop() || '',
    to: '',
    subject: '',
    messageId: call.call_id,
    messageIds: [call.call_id],
    inReplyTo: '',
    references: '',
    date: call.started_at || new Date().toISOString(),
    bodyFull: callerText,
    bodyNew: callTranscript(turns).slice(0, CALL_MAX_TRANSCRIPT),
    callerSpoke: /\w/.test(callerText),
    durationSeconds: Number(call.duration_seconds) || 0,
    endedBy: call.ended_by || null,
    messages,
    // What the caller asked us to WhatsApp them (send_whatsapp).
    whatsappRequests: (call.whatsapp_requests || []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 300)).slice(0, 3),
    attachments: [],
    needsPerson: null,
    headers: {},
  };
}

function callMessageLine(m) {
  return [m.reason, m.message, m.callback_number ? `call back on ${m.callback_number}` : '', m.email ? `email ${m.email}` : '',
    m.best_time ? `best time: ${m.best_time}` : '']
    .map((s) => String(s).trim().replace(/[.\s]+$/, '')).filter(Boolean).join('. ');
}

// The <call> block Haiku triages.
function callBlock(msg) {
  const notes = (msg.messages || []).map((m) => `[The agent took a message: ${callMessageLine(m)}]`);
  if ((msg.whatsappRequests || []).length) notes.push(`[The caller asked us to WhatsApp them: ${msg.whatsappRequests.join('; ')}]`);
  return `<call>\nFrom: ${msg.fromName ? msg.fromName + ' ' : ''}(caller ID ${msg.phone || 'withheld'})\nDuration: ${fmtDuration(msg.durationSeconds)}\n\n` +
    `${msg.bodyNew || '(nothing was said)'}${notes.length ? '\n\n' + notes.join('\n') : ''}\n</call>`;
}

// The call_inbound event's payload. text is the transcript, so later emails and
// WhatsApp messages from this person see the call in their history.
function callEventPayload(call, msg) {
  return {
    message_id: call.call_id, call_sid: call.call_sid || null, phone: msg.phone, name: msg.fromName || null,
    started_at: call.started_at || null, ended_at: call.ended_at || null, duration_seconds: msg.durationSeconds,
    ended_by: msg.endedBy, text: msg.bodyNew.slice(0, 4000), messages: msg.messages, errors: (call.errors || []).slice(0, 5),
  };
}

// What the agent said on the call that a written reply couldn't have said
// (the guardrails' rules, applied to its side of the transcript).
function voiceIssues(msg, listings) {
  const said = String(msg.bodyNew || '').split('\n').filter((l) => l.startsWith('Agent: ')).map((l) => l.slice(7)).join('\n');
  return saidIssues(said, msg, listings);
}

// The same checks for anything we say about a call: on it, or in the WhatsApp after it.
function saidIssues(said, msg, listings) {
  const issues = [];
  // It may say it's an AI assistant: the greeting does.
  for (const [re, label] of BANNED) if (label !== 'mentions automation' && re.test(said)) issues.push(label);
  // Spoken, not written: "prime is about ten and a half percent".
  if (/\b(prime|repo)\b[^.\n]{0,40}\d/i.test(said)) issues.push('mentions interest or bond rates');
  if (/\bper ?cent\b/i.test(said)) issues.push('contains a percentage');
  const known = new Set();
  for (const l of listings || []) {
    if (l.price_zar != null) known.add(Math.round(Number(l.price_zar)));
    if (l.levies_zar_pm != null) known.add(Math.round(Number(l.levies_zar_pm)));
    for (const n of moneyAmounts(l.body)) known.add(n);
  }
  for (const n of moneyAmounts(msg.bodyFull)) known.add(n);
  for (const n of moneyAmounts(said)) if (!known.has(n)) issues.push(`unverified amount R${n}`);
  return [...new Set(issues)];
}

// What happens after a call. Nothing goes to the caller.
// action: 'escalate' (email staff) | 'logged' (digest only) | 'spam' | 'optout'
// optOut: add their number to suppression (also when escalating).
function decideCall(parsed, issues, msg) {
  const took = (msg.messages || []).map((m) => m.reason).filter(Boolean);
  const reasons = [];
  if (took.length) reasons.push(`took a message: ${took.join('; ')}`);
  if (!parsed.ok) return { action: 'escalate', reason: [parsed.error, ...reasons].join('; '), optOut: false };
  const r = parsed.result;
  if (r.category === 'escalate' || (r.escalate && r.escalate.needed)) reasons.push((r.escalate && r.escalate.reason) || 'needs a person');
  if (r.confidence === 'low') reasons.push('low confidence');
  if (issues.length) reasons.push('the agent said something it should not have: ' + issues.join('; '));
  const optOut = r.category === 'opt_out';
  if (reasons.length) return { action: 'escalate', reason: [...new Set(reasons)].join('; '), optOut };
  if (optOut) return { action: 'optout', reason: 'opt-out request', optOut };
  if (r.category === 'spam') return { action: 'spam', reason: 'spam', optOut };
  return { action: 'logged', reason: 'handled on the call', optOut };
}

// ---- the WhatsApp a caller asked for
// We can only message someone first with a template Meta has approved, so the
// details Haiku writes (reply.whatsapp) fill {{2}}. scripts/wa-template.mjs
// submits it; AGENT_WA_CALL_TEMPLATE names it once approved.
const CALL_WA_TEMPLATE = {
  name: 'call_follow_up',
  language: 'en',
  category: 'UTILITY',
  body: 'Hi {{1}}, thanks for calling Harbour Key Properties. Here are the details you asked for: {{2}} If you have any questions, just reply here.',
  example: ['Thandi', 'Kingsmead Heights in Seaview is a freehold two-bedroom, one-bathroom plot-and-plan house for R820 000 (VAT inclusive, no transfer duty), with a R260/month HOA levy.'],
};
const CALL_WA_MAX_CHARS = 700;

// Numbers WhatsApp can reach: SA mobiles, and foreign numbers (we can't tell).
function waReachable(phone) {
  const p = normalizePhone(phone);
  if (!p) return false;
  return p.startsWith('+27') ? /^\+27(6\d|7\d|8[1-4])\d{7}$/.test(p) : true;
}

// Template text can't hold line breaks, tabs or long runs of spaces.
function waTemplateParam(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function callWaTemplate(name, firstName, details) {
  const params = [waTemplateParam(firstName) || 'there', waTemplateParam(details)];
  return {
    message: { type: 'template', template: { name, language: { code: CALL_WA_TEMPLATE.language },
      components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] } },
    text: CALL_WA_TEMPLATE.body.replace(/\{\{(\d)\}\}/g, (_, i) => params[i - 1]),
  };
}

// Whether to send it, and if not, why (the reason goes to staff).
// { send: true, details } | { send: false, why, details }
function callWhatsApp(msg, parsed, decision, listings, cfg) {
  const r = parsed.ok ? parsed.result : null;
  const details = sanitizeReply(waTemplateParam(r && r.reply && r.reply.whatsapp));
  const no = (why) => ({ send: false, why, details });
  if (!(msg.whatsappRequests || []).length) return { send: false, why: null, details };
  if (decision.action === 'spam' || decision.optOut) return no(null);
  if (!cfg.waCallTemplate) return no('no WhatsApp template is set up (AGENT_WA_CALL_TEMPLATE)');
  if (!cfg.waAutoSend) return no('WhatsApp auto-send is off');
  if (!waReachable(msg.phone)) return no('their number is withheld or not a mobile');
  if (!r) return no('the triage failed');
  if (!details) return no('the AI did not write it');
  if (details.length > CALL_WA_MAX_CHARS) return no('it was too long');
  const issues = saidIssues(details, msg, listings);
  if (/https?:|www\.|@(?!harbourkey\.example)/i.test(details)) issues.push('contains a link or email address');
  if (issues.length) return no(`it failed the checks: ${issues.join('; ')}`);
  return { send: true, details };
}

function callEscalationEmail(msg, parsed, decision, issues) {
  const r = parsed.ok ? parsed.result : null;
  const who = msg.phone || 'a withheld number';
  const lines = [
    `Reason: ${decision.reason}`,
    `Call from: ${msg.fromName || 'unknown name'} on ${who}, ${saClock(new Date(msg.date))}, ${fmtDuration(msg.durationSeconds)}`,
    msg.phone
      ? `Our AI assistant answered. Phone them back on ${msg.phone}, or email them if they gave an address.`
      : 'Our AI assistant answered. Their number was withheld, so check the transcript for a number or email address.',
  ];
  for (const m of msg.messages || []) lines.push(`Message taken: ${callMessageLine(m)}`);
  const wa = decision.whatsapp;
  if (wa && wa.sent) lines.push(`WhatsApp sent to them after the call: ${wa.text}`);
  else if (wa && wa.why) {
    lines.push(`They asked us to WhatsApp them (${msg.whatsappRequests.join('; ')}), but it was NOT sent: ${wa.why}. Please get it to them another way.`);
    if (wa.details) lines.push(`Draft: ${wa.details}`);
  }
  lines.push('');
  if (r) {
    lines.push(`Category: ${r.category}   Confidence: ${r.confidence}`, `Summary: ${r.summary}`);
    const x = Object.entries(r.extracted || {}).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
    if (x.length) lines.push('', 'What we know:', ...x.map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`));
    if (r.missing_info && r.missing_info.length) lines.push('', 'Still missing: ' + r.missing_info.join(', '));
  }
  if (issues && issues.length) lines.push('', 'The agent said something a written reply could not have, so check it with the caller: ' + issues.join('; '));
  lines.push('', '---------- Call transcript ----------', msg.bodyNew || '(nothing was said)');
  if (r && r.reply && r.reply.body) lines.push('', '---------- AI note ----------', sanitizeReply(r.reply.body));
  return {
    subject: `[Lead agent] Needs you: ${String(decision.reason).slice(0, 80)} (call ${who})`,
    text: lines.join('\n'),
  };
}
