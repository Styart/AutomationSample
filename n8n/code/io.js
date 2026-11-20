// Lead agent: I/O helpers (Supabase REST and Storage, SMTP, Meta's Graph API)
// and the steps of the workflows: prepareInbound and actOnInbound for email and
// WhatsApp, prepareCall and actOnCall for phone calls.
//
// Pasted after lib.js into Code nodes by scripts/build.mjs. Every function
// takes `http` (this.helpers.httpRequest) and `env` ($env) explicitly, so
// tests/flow.test.mjs can run the whole workflow with both faked.

async function sb(http, env, method, path, body, prefer) {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers.Prefer = prefer;
  return http({
    method,
    url: `${String(env.SUPABASE_URL).replace(/\/$/, '')}/rest/v1/${path}`,
    headers,
    body,
    json: true,
    timeout: 20000,
  });
}

async function findContactByEmail(http, env, email) {
  // ilike treats _ as a wildcard, so confirm the exact match in code.
  const rows = await sb(http, env, 'GET', `contacts?email=ilike.${encodeURIComponent(email)}&select=*&limit=5`);
  return (rows || []).find((r) => String(r.email || '').toLowerCase() === email) || null;
}

async function findContactByPhone(http, env, phone) {
  if (!phone) return null;
  const rows = await sb(http, env, 'GET', `contacts?mobile=eq.${encodeURIComponent(phone)}&select=*&limit=1`);
  return (rows || [])[0] || null;
}

async function createContact(http, env, fields) {
  const rows = await sb(http, env, 'POST', 'contacts', fields, 'return=representation');
  return rows[0];
}

async function patchContact(http, env, id, patch) {
  if (!patch || !Object.keys(patch).length) return;
  patch.updated_at = new Date().toISOString();
  try {
    await sb(http, env, 'PATCH', `contacts?id=eq.${id}`, patch, 'return=minimal');
  } catch (e) {
    // A phone number or email address already used by another contact violates
    // uq_contacts_mobile or uq_contacts_email. Keep everything else and drop those columns.
    if (patch.mobile || patch.email) {
      const { mobile, email, ...rest } = patch;
      rest.tags = (rest.tags || []).concat(mobile ? [`phone:${mobile}`] : [], email ? [`email:${email}`] : []);
      await sb(http, env, 'PATCH', `contacts?id=eq.${id}`, rest, 'return=minimal');
    } else {
      throw e;
    }
  }
}

async function logEvents(http, env, rows) {
  if (!rows.length) return;
  // PostgREST bulk inserts need every row to have the same keys.
  const full = rows.map((r) => ({
    contact_id: null, event_type: null, channel: null, direction: null, payload: {},
    ai_verdict: null, ai_latency_seconds: null, ...r,
  }));
  await sb(http, env, 'POST', 'events', full, 'return=minimal');
}

// Opt-outs: nobody on the suppression list is contacted again.
// type: 'email', or 'phone' for WhatsApp numbers and callers.
async function isSuppressed(http, env, value, type = 'email') {
  const rows = await sb(http, env, 'GET', `suppression?contact=eq.${encodeURIComponent(value)}&contact_type=eq.${type}&select=id&limit=1`);
  return (rows || []).length > 0;
}

// Idempotency: a message we already logged is never answered twice.
async function alreadySeen(http, env, messageId, eventType = 'email_inbound') {
  if (!messageId) return false;
  const rows = await sb(http, env, 'GET', `events?event_type=eq.${eventType}&payload->>message_id=eq.${encodeURIComponent(messageId)}&select=id&limit=1`);
  return (rows || []).length > 0;
}

async function recentEvents(http, env, contactId) {
  if (!contactId) return [];
  return sb(http, env, 'GET', `events?contact_id=eq.${contactId}&event_type=in.(${CONVERSATION_EVENTS.join(',')})` +
    '&select=event_type,direction,payload,created_at&order=created_at.desc&limit=12');
}

async function autoRepliesSince(http, env, contactId, sinceIso) {
  if (!contactId) return 0;
  const rows = await sb(http, env, 'GET',
    `events?contact_id=eq.${contactId}&event_type=in.(email_outbound,whatsapp_outbound)&created_at=gte.${encodeURIComponent(sinceIso)}&select=id`);
  return (rows || []).length;
}

async function liveListings(http, env) {
  return sb(http, env, 'GET',
    'listings?select=title,unit_type,address,price_zar,vat_inclusive,levies_zar_pm,occupation_date,sectional_title_scheme,body,status' +
    '&status=in.(active,reduced,reserved)&order=price_zar.asc');
}

// Raw HTTPS for file bytes and for Meta's Graph API. The Code node sandbox can
// only pass a Buffer to this.helpers.httpRequest as a top-level argument, not as a request body.
function httpsRequest({ method, url, headers, body, timeout = 120000 }) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`timeout after ${timeout} ms: ${method} ${url.split('?')[0]}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Private Supabase Storage bucket for the forms we send on WhatsApp (see waSendDocument).
const FILES_BUCKET = 'agent-files';

function storageUrl(env, path) {
  return `${String(env.SUPABASE_URL).replace(/\/$/, '')}/storage/v1/object/${FILES_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

async function storageUpload(env, path, buf, contentType) {
  const res = await httpsRequest({
    method: 'POST', url: storageUrl(env, path), body: buf,
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': contentType, 'x-upsert': 'true' },
  });
  if (res.status >= 300) throw new Error(`storage upload failed (${res.status}): ${res.body.toString().slice(0, 200)}`);
}

// A link to a stored file that works for expiresIn seconds without credentials.
async function storageSignedUrl(env, path, expiresIn) {
  const res = await httpsRequest({
    method: 'POST', url: storageUrl(env, path).replace('/storage/v1/object/', '/storage/v1/object/sign/'),
    body: Buffer.from(JSON.stringify({ expiresIn })),
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
  });
  if (res.status >= 300) throw new Error(`storage signed URL failed (${res.status}): ${res.body.toString().slice(0, 200)}`);
  const json = JSON.parse(res.body.toString());
  return `${String(env.SUPABASE_URL).replace(/\/$/, '')}/storage/v1${json.signedURL || json.signedUrl}`;
}

function smtpTransport(env) {
  const nodemailer = require('nodemailer');
  const port = Number(env.AGENT_SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: env.AGENT_SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user: env.AGENT_SMTP_USER, pass: env.AGENT_SMTP_PASS },
  });
}

// Sends one email. Automated mail carries RFC 3834 headers so other
// autoresponders do not answer it, which prevents mail loops.
// attachments: nodemailer attachments ({ filename, path }).
async function sendMail(env, { to, subject, text, inReplyTo, references, replyTo, bcc, fromName, attachments }) {
  const transport = smtpTransport(env);
  // AGENT_FROM is 'Name <address>'; a fromName swaps the display name only.
  const fromAddress = (String(env.AGENT_FROM).match(/<([^>]+)>/) || [null, env.AGENT_FROM])[1].trim();
  const from = fromName ? `"${fromName}" <${fromAddress}>` : env.AGENT_FROM;
  const info = await transport.sendMail({
    from,
    to,
    bcc: bcc || undefined,
    replyTo: replyTo || undefined,
    subject,
    text,
    inReplyTo: inReplyTo || undefined,
    references: references || undefined,
    attachments: attachments && attachments.length ? attachments : undefined,
    headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
  });
  return info.messageId;
}

// ---------------------------------------------------------------- one inbound message (email or WhatsApp)
// "Prepare" runs prepareInbound, the "Claude" HTTP node calls the API, and
// "Decide and act" runs actOnInbound.

// From a normalised message (normalizeImap or normalizeWhatsApp) to the Claude
// request: who they are, what we said before, and what we have for sale.
// shared caches the listings for the run.
async function prepareInbound(http, env, cfg, msg, prompts, shared = {}) {
  const wa = msg.channel === 'whatsapp';
  const contact = wa ? await findContactByPhone(http, env, msg.phone) : await findContactByEmail(http, env, msg.from);
  // The messages being answered now go in the <whatsapp> block, not the history.
  const current = new Set(msg.messageIds || []);
  const events = contact ? ((await recentEvents(http, env, contact.id)) || []).filter((e) => !current.has((e.payload || {}).message_id)) : [];
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const autoRepliesLast24h = contact ? await autoRepliesSince(http, env, contact.id, since) : 0;
  if (!shared.listings) shared.listings = (await liveListings(http, env)) || [];
  const request = buildClaudeRequest({
    msg, contact, events, listings: shared.listings, forms: prompts.forms,
    systemPrompt: prompts.systemPrompt, schema: prompts.schema, cfg,
  });
  return { msg, contact, autoRepliesLast24h, listings: shared.listings, request, startedAt: Date.now() };
}

// Checks Claude's draft, then sends it, escalates it, records the opt-out or
// drops the spam, updates the CRM and logs every step. Returns a summary.
async function actOnInbound(http, env, baseCfg, prep, claudeResponse, forms) {
  const msg = prep.msg;
  const wa = msg.channel === 'whatsapp';
  const cfg = channelConfig(baseCfg, msg.channel);
  const parsed = parseClaudeResponse(claudeResponse);
  const r = parsed.ok ? parsed.result : null;
  const issues = parsed.ok ? guardrails(r, { listings: prep.listings, cfg, msg, autoRepliesLast24h: prep.autoRepliesLast24h }) : [];
  // A photo, document, voice note or video on WhatsApp always goes to a person.
  const decision = decide(parsed, issues, cfg, msg.needsPerson ? `needs a person: ${msg.needsPerson}` : null);
  const attach = formAttachments(r && r.attach, forms, cfg.formsDir);

  // Contact: create one for every real person (not for spam).
  let contact = prep.contact;
  if (!contact && decision.action !== 'spam') {
    const nm = splitName(msg.fromName);
    contact = await createContact(http, env, newContact(msg, {
      first_name: (r && r.extracted.first_name) || nm.first_name,
      last_name: (r && r.extracted.last_name) || nm.last_name,
      stream: (r && CATEGORY_TO_STREAM[r.category]) || 'general',
    }));
  }
  const contactId = contact ? contact.id : null;
  const events = [];
  if (wa) {
    // The webhook logged the messages before we knew who sent them.
    if (contactId && msg.eventIds && msg.eventIds.length) {
      await sb(http, env, 'PATCH', `events?id=in.(${msg.eventIds.join(',')})`, { contact_id: contactId }, 'return=minimal');
    }
  } else {
    events.push({ event_type: 'email_inbound', direction: 'inbound',
      payload: { message_id: msg.messageId, subject: msg.subject, from: msg.from, in_reply_to: msg.inReplyTo, text: msg.bodyNew.slice(0, 4000) } });
  }
  // The audit trail: what the model said, what the checks found and what we did about it.
  events.push({ event_type: 'ai_triage', direction: 'system', ai_verdict: decision.action,
    ai_latency_seconds: Math.round((Date.now() - prep.startedAt) / 1000),
    payload: { model: cfg.model, action: decision.action, reason: decision.reason, issues,
      category: r && r.category, confidence: r && r.confidence, summary: r && r.summary,
      extracted: r && r.extracted, missing_info: r && r.missing_info, escalate: r && r.escalate, attach: r && r.attach,
      usage: parsed.usage || null, error: parsed.ok ? null : parsed.error,
      // Which WhatsApp messages this answered (see waHandledIds).
      ...(wa ? { channel: 'whatsapp', wa_id: msg.phone, message_ids: msg.messageIds } : {}) } });

  // Reply to the customer. The reply only ever goes back to where the message came from.
  // Forms go only with a full reply, never with a holding reply.
  let replied = false;
  let formsSent = [];
  if (decision.action === 'send' || decision.sendHolding) {
    const body = sanitizeReply(r.reply.body);
    formsSent = decision.action === 'send' ? attach : [];
    const kind = decision.action === 'send' ? 'reply' : decision.action === 'optout' ? 'optout_confirmation' : 'holding';
    if (wa) {
      const sentId = await waSendText(env, msg.phone, body);
      for (const f of formsSent) await waSendDocument(env, msg.phone, f);
      events.push({ event_type: 'whatsapp_outbound', direction: 'outbound',
        payload: { message_id: sentId, wa_id: msg.phone, text: body, kind, attachments: formsSent.map((f) => f.title) } });
    } else {
      const subject = replySubject(r, msg);
      const sentId = await sendMail(env, {
        to: msg.from, subject, text: body + '\n\n' + quoteOriginal(msg),
        inReplyTo: msg.messageId, references: [msg.references, msg.messageId].filter(Boolean).join(' '),
        bcc: cfg.bccEmail, attachments: formsSent.map((f) => ({ filename: f.filename, path: f.path })),
      });
      events.push({ event_type: 'email_outbound', direction: 'outbound',
        payload: { message_id: sentId, subject, text: body, kind, attachments: formsSent.map((f) => f.title) } });
    }
    replied = true;
  }

  if (decision.action === 'optout') {
    const who = wa ? { contact: msg.phone, contact_type: 'phone', reason: 'WhatsApp opt-out', source: 'whatsapp-agent' }
      : { contact: msg.from, contact_type: 'email', reason: 'email opt-out', source: 'email-agent' };
    await sb(http, env, 'POST', 'suppression', { ...who, actor: 'ai' }, 'resolution=ignore-duplicates,return=minimal');
    events.push({ event_type: 'opt_out', direction: 'system', payload: { contact: who.contact } });
  }

  if (decision.action === 'escalate') {
    const e = escalationEmail(msg, parsed, decision, issues, replied, attach.map((f) => f.title));
    await sendMail(env, { to: cfg.escalationEmail, subject: e.subject, text: e.text, fromName: 'Lead agent',
      replyTo: wa ? (contact && contact.email) || undefined : msg.from,
      attachments: attach.map((f) => ({ filename: f.filename, path: f.path })) });
    events.push({ event_type: 'escalation_sent', direction: 'system', payload: { reason: decision.reason, to: cfg.escalationEmail } });
  }

  if (contactId && r) {
    const patch = contactPatch(r, contact, wa ? 'source:whatsapp' : 'source:email-agent');
    if (replied && contact.pipeline_stage === 'New Enquiry') patch.pipeline_stage = 'Contacted';
    await patchContact(http, env, contactId, patch);
  }

  await logEvents(http, env, events.map((e) => ({ channel: wa ? 'whatsapp' : 'email', contact_id: contactId, ...e })));
  return { from: msg.from, subject: msg.subject, action: decision.action, reason: decision.reason, category: r && r.category,
    issues, replied, forms: formsSent.map((f) => f.id) };
}

// ---------------------------------------------------------------- WhatsApp (Meta Cloud API)
// Messages go through Meta's Graph API from the number AGENT_WA_PHONE_NUMBER_ID,
// with a System User token (AGENT_WA_TOKEN) that doesn't expire.

const GRAPH_URL = 'https://graph.facebook.com/v25.0';
const graphAuth = (env) => ({ Authorization: `Bearer ${env.AGENT_WA_TOKEN}` });

// The X-Hub-Signature-256 Meta sends with every webhook post: HMAC-SHA256 of the
// raw body, keyed with the App Secret.
function metaSignature(appSecret, rawBody) {
  return 'sha256=' + require('crypto').createHmac('sha256', String(appSecret)).update(rawBody).digest('hex');
}

// Sends one WhatsApp message ({ type: 'text', text } or { type: 'document', document });
// returns its id (wamid...). Failed deliveries come back to the webhook later as
// statuses (see whatsapp-receive.js).
async function waSend(env, phone, message) {
  const res = await httpsRequest({
    method: 'POST', url: `${GRAPH_URL}/${encodeURIComponent(env.AGENT_WA_PHONE_NUMBER_ID)}/messages`,
    body: Buffer.from(JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: String(phone).replace(/\D/g, ''), ...message })),
    headers: { ...graphAuth(env), 'Content-Type': 'application/json' },
  });
  let json;
  try { json = JSON.parse(res.body.toString() || '{}'); } catch (e) { json = { raw: res.body.toString().slice(0, 300) }; }
  if (res.status >= 300) {
    const e = json.error || {};
    const detail = [e.code, e.message, e.error_data && e.error_data.details].filter(Boolean).join(': ');
    throw new Error(`WhatsApp send failed (${res.status}): ${detail || JSON.stringify(json).slice(0, 300)}`);
  }
  return (json.messages && json.messages[0] && json.messages[0].id) || null;
}

// Sends a text message, in parts if it is longer than Meta allows; returns the first message id.
async function waSendText(env, phone, text) {
  let first = null;
  for (const part of waChunks(text)) {
    const id = await waSend(env, phone, { type: 'text', text: { body: part } });
    first = first || id;
  }
  return first;
}

// Sends a form from forms/ as a document; returns its message id. Meta fetches
// the file from a link, so the form goes to Storage and Meta gets a link that works for an hour.
async function waSendDocument(env, phone, { path, filename }) {
  const key = `whatsapp-forms/${filename}`;
  await storageUpload(env, key, require('fs').readFileSync(path), 'application/pdf');
  return waSend(env, phone, { type: 'document', document: { link: await storageSignedUrl(env, key, 3600), filename } });
}


// This person's WhatsApp messages since sinceIso.
async function waInbound(http, env, phone, sinceIso) {
  return (await sb(http, env, 'GET', `events?event_type=eq.whatsapp_inbound&payload->>wa_id=eq.${encodeURIComponent(phone)}` +
    `&created_at=gte.${encodeURIComponent(sinceIso)}&select=id,payload,created_at&order=created_at.asc&limit=100`)) || [];
}

// Message ids already answered (ai_triage) or left to staff (whatsapp_skipped).
async function waHandledIds(http, env, phone, sinceIso) {
  const rows = (await sb(http, env, 'GET', `events?event_type=in.(ai_triage,whatsapp_skipped)&payload->>wa_id=eq.${encodeURIComponent(phone)}` +
    `&created_at=gte.${encodeURIComponent(sinceIso)}&select=payload`)) || [];
  return rows.flatMap((r) => (r.payload && r.payload.message_ids) || []);
}

// ---------------------------------------------------------------- phone calls (see "Phone calls" in lib.js)

// From the call voice/ posted to the Claude request. A call where the caller
// said nothing is only logged ({ skip: true }).
async function prepareCall(http, env, cfg, call, prompts, shared = {}) {
  const msg = normalizeCall(call);
  const contact = msg.phone ? await findContactByPhone(http, env, msg.phone) : null;
  const callEvent = { event_type: 'call_inbound', channel: 'voice', direction: 'inbound', contact_id: contact ? contact.id : null,
    payload: callEventPayload(call, msg) };
  if (!msg.callerSpoke) {
    await logEvents(http, env, [callEvent]);
    return { skip: true, msg };
  }
  const events = contact ? ((await recentEvents(http, env, contact.id)) || []).filter((e) => (e.payload || {}).message_id !== msg.messageId) : [];
  if (!shared.listings) shared.listings = (await liveListings(http, env)) || [];
  const request = buildClaudeRequest({
    msg, contact, events, listings: shared.listings, forms: prompts.forms,
    systemPrompt: prompts.systemPrompt, schema: prompts.schema, cfg,
  });
  return { msg, contact, callEvent, listings: shared.listings, request, startedAt: Date.now() };
}

// Haiku's triage of a finished call: contact, events, opt-out and the escalation
// email with the transcript. Nothing goes to the caller.
async function actOnCall(http, env, cfg, prep, claudeResponse) {
  const msg = prep.msg;
  const parsed = parseClaudeResponse(claudeResponse);
  const r = parsed.ok ? parsed.result : null;
  const x = (r && r.extracted) || {};
  const issues = voiceIssues(msg, prep.listings);
  const decision = decideCall(parsed, issues, msg);

  let contact = prep.contact;
  if (!contact && msg.phone && decision.action !== 'spam') {
    const nm = splitName(msg.fromName);
    contact = await createContact(http, env, newContact(msg, {
      first_name: x.first_name || nm.first_name,
      last_name: x.last_name || nm.last_name,
      stream: (r && CATEGORY_TO_STREAM[r.category]) || 'general',
    }));
  }
  const contactId = contact ? contact.id : null;
  const triage = { event_type: 'ai_triage', direction: 'system', ai_verdict: decision.action,
    ai_latency_seconds: Math.round((Date.now() - prep.startedAt) / 1000),
    payload: { model: cfg.model, action: decision.action, reason: decision.reason, issues,
      category: r && r.category, confidence: r && r.confidence, summary: r && r.summary,
      extracted: r && r.extracted, missing_info: r && r.missing_info, escalate: r && r.escalate,
      usage: parsed.usage || null, error: parsed.ok ? null : parsed.error,
      channel: 'voice', phone: msg.phone, message_ids: msg.messageIds } };
  const events = [prep.callEvent, triage];

  if (decision.optOut && msg.phone) {
    await sb(http, env, 'POST', 'suppression', { contact: msg.phone, contact_type: 'phone', reason: 'opt-out on a phone call', source: 'voice-agent', actor: 'ai' },
      'resolution=ignore-duplicates,return=minimal');
    events.push({ event_type: 'opt_out', direction: 'system', payload: { contact: msg.phone } });
  }

  // The WhatsApp they asked for on the call. If it can't go, staff hear why.
  const plan = callWhatsApp(msg, parsed, decision, prep.listings, cfg);
  if (plan.send && (await isSuppressed(http, env, msg.phone, 'phone'))) Object.assign(plan, { send: false, why: null });
  if (plan.send) {
    const firstName = x.first_name || (contact && contact.first_name) || splitName(msg.fromName).first_name;
    const t = callWaTemplate(cfg.waCallTemplate, firstName, plan.details);
    try {
      const sentId = await waSend(env, msg.phone, t.message);
      decision.whatsapp = { sent: true, text: t.text };
      events.push({ event_type: 'whatsapp_outbound', direction: 'outbound', channel: 'whatsapp',
        payload: { message_id: sentId, wa_id: msg.phone, text: t.text, kind: 'call_follow_up', template: cfg.waCallTemplate } });
    } catch (err) {
      plan.why = err.message;
    }
  }
  if (plan.why) {
    decision.whatsapp = { sent: false, why: plan.why, details: plan.details };
    decision.reason = decision.action === 'escalate' ? `${decision.reason}; WhatsApp not sent` : 'they asked for a WhatsApp, which was not sent';
    decision.action = 'escalate';
  }
  Object.assign(triage, { ai_verdict: decision.action });
  Object.assign(triage.payload, { action: decision.action, reason: decision.reason, whatsapp: decision.whatsapp || null });

  if (decision.action === 'escalate') {
    const e = escalationEmail(msg, parsed, decision, issues, false);
    await sendMail(env, { to: cfg.escalationEmail, subject: e.subject, text: e.text, fromName: 'Lead agent',
      replyTo: (contact && contact.email) || undefined });
    events.push({ event_type: 'escalation_sent', direction: 'system', payload: { reason: decision.reason, to: cfg.escalationEmail } });
  }

  if (contactId && r) {
    const patch = contactPatch(r, contact, 'source:voice');
    await patchContact(http, env, contactId, patch);
  }

  await logEvents(http, env, events.map((e) => ({ ...e, channel: e.channel || 'voice', contact_id: contactId })));
  return { from: msg.phone, call_id: msg.messageId, action: decision.action, reason: decision.reason, category: r && r.category, issues };
}
