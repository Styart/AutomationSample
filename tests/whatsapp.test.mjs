import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { buildAll } from '../scripts/build.mjs';
import { loadLib, systemPrompt, schema, forms } from '../scripts/lib-loader.mjs';

const lib = loadLib();
const listings = JSON.parse(readFileSync(new URL('../evals/listings.json', import.meta.url), 'utf8'));
const cfg = lib.configFromEnv({ AGENT_AUTO_SEND: 'true', AGENT_WA_AUTO_SEND: 'true', AGENT_OWN_ADDRESSES: 'info@harbourkey.example' });

// A webhook post as Meta sends it, for our number (PNID) unless the value says otherwise.
const PNID = '100000000000001';
const post = (value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '27870000000', phone_number_id: PNID }, ...value } }] }] });
const message = (over = {}) => ({ from: '27821234567', id: 'wamid.HBgL1', timestamp: '1792999200', type: 'text', text: { body: '' }, ...over });
const inbound = (id, at, payload, created_at = at) => ({ id: `ev-${id}`, created_at, payload: { message_id: id, wa_id: '+27821234567', at, ...payload } });
const one = (over) => lib.parseWhatsAppWebhook(post({ contacts: [{ profile: { name: 'Thandi M' }, wa_id: '27821234567' }], messages: [message(over)] }), PNID).messages[0];

test('parseWhatsAppWebhook reads text, photos, documents and voice notes', () => {
  const text = one({ text: { body: 'Hi, 2 bed in Riverbend?' } });
  assert.equal(text.id, 'wamid.HBgL1');
  assert.equal(text.phone, '+27821234567');
  assert.equal(text.name, 'Thandi M');
  assert.equal(text.text, 'Hi, 2 bed in Riverbend?');
  assert.equal(text.type, 'text');
  assert.equal(text.at, '2026-10-26T07:20:00.000Z', 'when they sent it, from Meta\'s timestamp');

  const photo = one({ id: 'wamid.HBgL12345678abcdef', type: 'image', image: { id: '1001', mime_type: 'image/jpeg', caption: 'my ID' } });
  // Photos and documents go to a person (this extract has no document checks).
  assert.equal(photo.text, '[They sent a photo, which a person on the team will look at] my ID');
  assert.equal(photo.needs_person, 'they sent a photo');

  const doc = one({ type: 'document', document: { id: '1002', mime_type: 'application/pdf', filename: 'payslip.pdf' } });
  assert.equal(doc.type, 'document');
  assert.equal(doc.text, '[They sent a document, which a person on the team will look at]');
  assert.equal(doc.needs_person, 'they sent a document');

  const voice = one({ type: 'audio', audio: { id: '1003', mime_type: 'audio/ogg; codecs=opus', voice: true } });
  assert.equal(voice.needs_person, 'they sent a voice note');
  assert.match(voice.text, /^\[They sent a voice note/);
  assert.equal(voice.media, undefined);
  assert.equal(one({ type: 'video', video: { id: '1004', caption: 'the leak' } }).text, '[They sent a video, which we cannot view here] the leak');

  assert.equal(one({ type: 'location', location: { latitude: -32.92, longitude: 28.01, name: 'Riverbend Mall' } }).text, '[Shared a location: Riverbend Mall (-32.92, 28.01)]');
  assert.equal(one({ type: 'contacts', contacts: [{ name: { formatted_name: 'Bob' } }] }).text, '[Shared a contact card]');
  assert.equal(one({ type: 'button', button: { text: 'Yes please', payload: 'yes' } }).text, 'Yes please');
  assert.equal(one({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Book a viewing' } } }).text, 'Book a viewing');
});

test('parseWhatsAppWebhook ignores reactions, stickers, empty messages and other numbers', () => {
  assert.equal(one({ type: 'reaction', reaction: { message_id: 'wamid.x', emoji: '👍' } }), undefined);
  assert.equal(one({ type: 'sticker', sticker: { id: '1', mime_type: 'image/webp' } }), undefined);
  assert.equal(one({ type: 'unsupported', errors: [{ code: 131051 }] }), undefined);
  assert.equal(one({ text: { body: '  ' } }), undefined);
  assert.deepEqual(lib.parseWhatsAppWebhook(null, PNID), { messages: [], failed: [] });
  assert.deepEqual(lib.parseWhatsAppWebhook({}, PNID), { messages: [], failed: [] });
  // Meta's test number on the same app.
  const other = post({ messages: [message({ text: { body: 'Hi' } })] });
  other.entry[0].changes[0].value.metadata.phone_number_id = '999';
  assert.deepEqual(lib.parseWhatsAppWebhook(other, PNID).messages, []);
  // A missing timestamp falls back to now.
  assert.ok(Date.now() - new Date(one({ timestamp: undefined, text: { body: 'Hi' } }).at).getTime() < 5000);
});

test('parseWhatsAppWebhook reports failed sends from statuses', () => {
  const status = (s, over = {}) => lib.parseWhatsAppWebhook(post({ statuses: [{ id: 'wamid.out', status: s, timestamp: '1792999200', recipient_id: '27821234567', ...over }] }), PNID);
  assert.deepEqual(status('sent'), { messages: [], failed: [] });
  assert.deepEqual(status('delivered'), { messages: [], failed: [] });
  assert.deepEqual(status('read'), { messages: [], failed: [] });
  assert.deepEqual(status('failed', { errors: [{ code: 131047, title: 'Re-engagement message' }] }).failed,
    [{ id: 'wamid.out', phone: '+27821234567', error: '131047: Re-engagement message' }]);
  assert.deepEqual(status('failed').failed, [{ id: 'wamid.out', phone: '+27821234567', error: 'failed' }]);
});

test('waVerify answers Meta\'s check only for our verify token', () => {
  const q = (token, mode = 'subscribe') => ({ 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': '1158201444' });
  assert.equal(lib.waVerify(q('tok123'), 'tok123'), '1158201444');
  assert.equal(lib.waVerify(q('wrong'), 'tok123'), null);
  assert.equal(lib.waVerify(q('tok123', 'unsubscribe'), 'tok123'), null);
  assert.equal(lib.waVerify(q(''), ''), null, 'an unset token never matches');
  assert.equal(lib.waVerify(undefined, 'tok123'), null);
});

test('waInboundEvent keeps what the agent and the history need', () => {
  const e = lib.waInboundEvent(one({ type: 'image', image: { id: '1001', mime_type: 'image/jpeg' } }));
  assert.equal(e.event_type, 'whatsapp_inbound');
  assert.equal(e.channel, 'whatsapp');
  assert.equal(e.payload.message_id, 'wamid.HBgL1');
  assert.equal(e.payload.wa_id, '+27821234567');
  assert.equal(e.payload.at, '2026-10-26T07:20:00.000Z');
  assert.equal(e.payload.text, '[They sent a photo, which a person on the team will look at]');
  assert.equal(e.payload.needs_person, 'they sent a photo');
});

test('a burst of messages is answered once, by the newest message\'s run', () => {
  const evs = [
    inbound('w1', '2026-10-15T08:00:00Z', { text: 'Hi' }),
    inbound('w2', '2026-10-15T08:00:05Z', { text: 'I earn a salary' }),
    inbound('w3', '2026-10-15T08:00:09Z', { text: 'And my payslip' }),
  ];
  const pending = lib.waPending(evs, ['w0']);
  assert.equal(lib.waIsNewest(pending, 'w1'), false);
  assert.equal(lib.waIsNewest(pending, 'w2'), false);
  assert.equal(lib.waIsNewest(pending, 'w3'), true);
  // Already answered: nothing pending, so nobody answers again.
  assert.equal(lib.waIsNewest(lib.waPending(evs, ['w1', 'w2', 'w3']), 'w3'), false);
  // Two messages logged by one webhook share a created_at: either run may answer.
  const same = [inbound('a', '2026-10-15T08:00:00Z', {}, '2026-10-15T08:00:10Z'), inbound('b', '2026-10-15T08:00:01Z', {}, '2026-10-15T08:00:10Z')];
  assert.equal(lib.waIsNewest(lib.waPending(same, []), 'b'), true);

  const msg = lib.normalizeWhatsApp('+27821234567', pending);
  assert.equal(msg.channel, 'whatsapp');
  assert.equal(msg.bodyNew, 'Hi\n\nI earn a salary\n\nAnd my payslip');
  assert.deepEqual(msg.messageIds, ['w1', 'w2', 'w3']);
  assert.deepEqual(msg.eventIds, ['ev-w1', 'ev-w2', 'ev-w3']);
  assert.equal(msg.needsPerson, null);
  // One message in the burst that needs a person is enough.
  const photo = inbound('w4', '2026-10-15T08:00:12Z', { text: '[They sent a photo, which a person on the team will look at]', needs_person: 'they sent a photo' });
  assert.equal(lib.normalizeWhatsApp('+27821234567', lib.waPending(evs.concat(photo), [])).needsPerson, 'they sent a photo');
});

test('waPending orders by when they were sent, not when they arrived', () => {
  const p = lib.waPending([
    inbound('late', '2026-10-15T08:00:09Z', {}, '2026-10-15T08:00:10Z'),
    inbound('early', '2026-10-15T08:00:01Z', {}, '2026-10-15T08:00:12Z'),
  ], []);
  assert.deepEqual(p.map((e) => e.payload.message_id), ['early', 'late']);
  // 'early' arrived last, so its run answers both.
  assert.equal(lib.waIsNewest(p, 'early'), true);
  assert.equal(lib.waIsNewest(p, 'late'), false);
});

test('channelConfig gives WhatsApp its own kill switch and reply limit', () => {
  const off = lib.configFromEnv({ AGENT_AUTO_SEND: 'true' });
  assert.equal(lib.channelConfig(off, 'email').autoSend, true);
  assert.equal(lib.channelConfig(off, 'whatsapp').autoSend, false, 'WhatsApp auto-send is off by default');
  assert.equal(lib.channelConfig(off, 'whatsapp').maxAutoReplies24h, 10);
  assert.equal(lib.channelConfig(off, 'email').maxAutoReplies24h, 3);
});

const waMsg = (over = {}) => ({ channel: 'whatsapp', from: '+27821234567', phone: '+27821234567', fromName: 'Thandi', subject: '', bodyNew: 'Hi, 2 bed in Riverbend around R1m?', bodyFull: 'Hi, 2 bed in Riverbend around R1m? my email is thandi@gmail.com', headers: {}, messageIds: ['w1'], attachments: [], ...over });
const result = (body, over = {}) => ({ category: 'buyer', confidence: 'high', escalate: { needed: false, reason: '' }, reply: { subject: '', body }, extracted: {}, attach: [], ...over });

test('guardrails: WhatsApp replies need no greeting and may repeat the email they typed', () => {
  const wcfg = lib.channelConfig(cfg, 'whatsapp');
  const body = 'The Quay in Riverbend is R990 000. I\'ll send details to thandi@gmail.com.\n\nWhat day suits you for a viewing?';
  assert.deepEqual(lib.guardrails(result(body), { listings, cfg: wcfg, msg: waMsg(), autoRepliesLast24h: 0 }), []);
  assert.ok(lib.guardrails(result(body.replace('thandi@gmail', 'other@gmail')), { listings, cfg: wcfg, msg: waMsg(), autoRepliesLast24h: 0 })
    .includes('unexpected email address: other@gmail.com'));
  // Email still needs its greeting.
  const emailMsg = { from: 'thandi@gmail.com', fromName: 'Thandi', subject: 'Hi', bodyNew: 'x', bodyFull: 'x', headers: {} };
  assert.ok(lib.guardrails(result('The Quay is R990 000.'), { listings, cfg, msg: emailMsg, autoRepliesLast24h: 0 }).includes('missing greeting'));
  // WhatsApp's higher limit.
  assert.deepEqual(lib.guardrails(result('Sure.'), { listings, cfg: wcfg, msg: waMsg(), autoRepliesLast24h: 5 }), []);
  assert.ok(lib.guardrails(result('Sure.'), { listings, cfg: wcfg, msg: waMsg(), autoRepliesLast24h: 10 })[0].startsWith('auto-reply limit'));
});

test('buildClaudeRequest puts WhatsApp messages in <whatsapp> tags', () => {
  const req = lib.buildClaudeRequest({ msg: waMsg({ fromName: 'Thandi M' }), contact: null, events: [], listings, forms: forms(),
    systemPrompt: systemPrompt(), schema: schema(), cfg, now: new Date('2026-10-15T08:00:00Z') });
  const text = req.messages[0].content;
  assert.match(text, /Reply to the WhatsApp message below/);
  assert.match(text, /<whatsapp>\nFrom: Thandi M \(WhatsApp \+27821234567\)\n\nHi, 2 bed in Riverbend around R1m\?\n<\/whatsapp>/);
  assert.doesNotMatch(text, /<email>/);
  assert.match(req.system[0].text, /# WhatsApp/);
  assert.ok(schema().properties.extracted.required.includes('email'));
});

test('historyBlock labels WhatsApp messages', () => {
  const h = lib.historyBlock([
    { event_type: 'whatsapp_outbound', direction: 'outbound', created_at: '2026-10-15T08:01:00Z', payload: { text: 'Viewing Saturday?', sent_by: 'staff' } },
    { event_type: 'whatsapp_inbound', direction: 'inbound', created_at: '2026-10-15T08:00:00Z', payload: { text: 'Here is my ID', attachments: [{ name: 'id.jpg' }] } },
    { event_type: 'ai_triage', direction: 'system', created_at: '2026-10-15T08:00:30Z', payload: {} },
  ]);
  assert.match(h, /Customer on WhatsApp: Here is my ID\n\[they attached: id\.jpg\]/);
  assert.match(h, /Us on WhatsApp: Viewing Saturday\?/);
});

test('escalationEmail tells staff to phone a WhatsApp customer', () => {
  const parsed = { ok: true, result: result('Thanks, the principal will be in touch.', { summary: 'Voice note about Milkwood Views' }) };
  const e = lib.escalationEmail(waMsg({ bodyNew: '[They sent a voice note, which we cannot play here]' }), parsed,
    { reason: 'needs a person: they sent a voice note' }, [], true);
  assert.match(e.subject, /\(WhatsApp \+27821234567\)$/);
  assert.match(e.text, /From: Thandi on WhatsApp \+27821234567/);
  assert.match(e.text, /WAS sent to them on WhatsApp/);
  assert.match(e.text, /phone them on \+27821234567/);
  assert.match(e.text, /Their WhatsApp messages/);
  assert.doesNotMatch(e.text, /Reply to this email/);
});

test('contactPatch picks up an email address and the WhatsApp source', () => {
  const patch = lib.contactPatch({ category: 'bond', extracted: { email: ' Thandi@Gmail.com ' } }, { mobile: '+27821234567', tags: ['source:whatsapp'] }, 'source:whatsapp');
  assert.equal(patch.email, 'thandi@gmail.com');
  assert.deepEqual(patch.tags, ['source:whatsapp']);
  assert.equal(lib.contactPatch({ category: 'bond', extracted: { email: 'not an email' } }, {}).email, undefined);
  assert.equal(lib.contactPatch({ category: 'bond', extracted: { email: 'new@x.co.za' } }, { email: 'old@x.co.za' }).email, undefined);
});

test('contact details given mid-conversation are kept and shown to the agent next time', () => {
  const contact = { mobile: '+27821234567', email: 'old@x.co.za', tags: ['source:voice'] };
  const patch = lib.contactPatch({ category: 'buyer', extracted: { phone: '083 000 1111', email: 'New@x.co.za' } }, contact, 'source:voice');
  assert.equal(patch.mobile, undefined);
  assert.equal(patch.email, undefined);
  assert.deepEqual(patch.tags, ['source:voice', 'email:new@x.co.za', 'phone:+27830001111']);
  // The same details again add nothing.
  assert.deepEqual(lib.contactPatch({ category: 'buyer', extracted: { phone: '0821234567', email: 'OLD@x.co.za' } }, contact, 'source:voice').tags, ['source:voice']);
  // A new contact gets them as its columns.
  assert.deepEqual(lib.contactPatch({ category: 'buyer', extracted: { phone: '0830001111' } }, {}).mobile, '+27830001111');
  const block = lib.contactBlock({ ...contact, tags: patch.tags });
  assert.match(block, /^email: old@x\.co\.za$/m);
  assert.match(block, /^other email: new@x\.co\.za$/m);
  assert.match(block, /^other phone: \+27830001111$/m);
});

test('newContact uses the number on WhatsApp and the address on email', () => {
  assert.deepEqual(lib.newContact(waMsg(), { first_name: 'Thandi', stream: 'buyer' }),
    { mobile: '+27821234567', tags: ['source:whatsapp'], first_name: 'Thandi', last_name: null, stream: 'buyer', pipeline_stage: 'New Enquiry' });
  assert.equal(lib.newContact({ from: 'a@b.co.za' }).email, 'a@b.co.za');
});

test('safeEqual', () => {
  assert.equal(lib.safeEqual('secret', 'secret'), true);
  assert.equal(lib.safeEqual('secret', 'secreT'), false);
  assert.equal(lib.safeEqual('', ''), false, 'an unset secret never matches');
  assert.equal(lib.safeEqual(undefined, 'x'), false);
});

test('waChunks splits long replies at paragraph breaks', () => {
  assert.deepEqual(lib.waChunks('Short reply.'), ['Short reply.']);
  const para = 'x'.repeat(2500);
  assert.deepEqual(lib.waChunks(`${para}\n\n${para}`), [para, para]);
  const words = Array(2000).fill('word').join(' ');
  const parts = lib.waChunks(words);
  assert.ok(parts.every((p) => p.length <= lib.WA_MAX_CHARS));
  assert.equal(parts.join(' '), words);
  assert.deepEqual(lib.waChunks(''), []);
});

test('waTranscriptsDue emails a chat once it has been quiet for 2 hours, and only what is new', () => {
  const ev = (event_type, created_at, payload = {}) => ({ event_type, created_at, contact_id: null, payload: { wa_id: '+27821234567', ...payload } });
  const now = new Date('2026-10-31T12:00:00Z').getTime();
  const chat = [
    ev('whatsapp_inbound', '2026-10-31T08:00:03.12+00:00', { at: '2026-10-31T08:00:00.000Z', text: 'Hi' }),
    ev('whatsapp_outbound', '2026-10-31T08:00:30+00:00', { text: 'Hello!' }),
    ev('ai_triage', '2026-10-31T08:00:30+00:00', { action: 'send' }),
  ];
  const due = lib.waTranscriptsDue(chat, [], now);
  assert.equal(due.length, 1);
  assert.equal(due[0].phone, '+27821234567');
  assert.deepEqual(due[0].events.map((e) => e.event_type), ['whatsapp_inbound', 'ai_triage', 'whatsapp_outbound'], 'our note on a message comes before our reply');

  // Still talking: wait.
  assert.deepEqual(lib.waTranscriptsDue([...chat, ev('whatsapp_inbound', '2026-10-31T11:00:00+00:00', { text: 'Thanks' })], [], now), []);
  // Already emailed up to the reply: nothing new.
  const sent = [{ payload: { wa_id: '+27821234567', until: '2026-10-31T08:00:30+00:00' } }];
  assert.deepEqual(lib.waTranscriptsDue(chat, sent, now), []);
  // They wrote again later: only the new part.
  const later = [...chat, ev('whatsapp_inbound', '2026-10-31T09:00:00+00:00', { text: 'Is it still available?' })];
  assert.deepEqual(lib.waTranscriptsDue(later, sent, now)[0].events.map((e) => e.payload.text), ['Is it still available?']);
  // Notes with no messages (a failed send on its own) are not a conversation.
  assert.deepEqual(lib.waTranscriptsDue([ev('whatsapp_failed', '2026-10-31T08:00:00+00:00', { error: 'x' })], [], now), []);
  // Email triage events have no wa_id and are ignored.
  assert.deepEqual(lib.waTranscriptsDue([{ event_type: 'ai_triage', created_at: '2026-10-31T08:00:00+00:00', payload: { action: 'send' } }], [], now), []);
});

test('waTranscriptEmail reads like the chat, with who, when and what happened', () => {
  const ev = (event_type, created_at, payload = {}) => ({ event_type, created_at, payload: { wa_id: '+27821234567', ...payload } });
  const events = [
    ev('whatsapp_inbound', '2026-10-31T08:00:03+00:00', { at: '2026-10-31T08:00:00.000Z', name: 'Thandi M', type: 'text', text: 'Hi, 2 bed in Riverbend?' }),
    ev('whatsapp_inbound', '2026-10-31T08:00:09+00:00', { at: '2026-10-31T08:00:08.000Z', name: 'Thandi M', type: 'image', text: '[They sent a photo, which a person on the team will look at] my ID' }),
    ev('ai_triage', '2026-10-31T08:00:40+00:00', { action: 'escalate', reason: 'asked about a valuation' }),
    ev('whatsapp_outbound', '2026-10-31T08:00:40+00:00', { text: 'Thanks Thandi.\nSomeone will call you.', attachments: ['Pre-Qualification Form'] }),
    ev('whatsapp_failed', '2026-10-31T08:01:00+00:00', { error: '131047: Re-engagement message' }),
  ];
  const noContact = lib.waTranscriptEmail('+27821234567', events, null);
  assert.equal(noContact.subject, '[Lead agent] WhatsApp chat with Thandi M (+27821234567), 31 Oct');
  assert.equal(noContact.until, '2026-10-31T08:01:00+00:00');
  assert.match(noContact.text, /^WhatsApp conversation with Thandi M \(\+27821234567\)\n31 Oct 10:00 to 31 Oct 10:01: 2 messages from them, 1 from us\./);
  assert.match(noContact.text, /\[31 Oct 10:00\] Thandi M:\nHi, 2 bed in Riverbend\?/);
  assert.match(noContact.text, /\[31 Oct 10:00\] Thandi M:\n\[They sent a photo, which a person on the team will look at\] my ID/);
  assert.match(noContact.text, /\[31 Oct 10:00\] Passed to staff: asked about a valuation\n\n\[31 Oct 10:00\] Lead agent:\nThanks Thandi\.\nSomeone will call you\.\n\[Sent: Pre-Qualification Form\]/);
  assert.match(noContact.text, /\[31 Oct 10:01\] Our message was not delivered: 131047/);
  assert.match(noContact.text, /phone them to follow up\.$/);

  const known = lib.waTranscriptEmail('+27821234567', events, { first_name: 'Thandi', last_name: 'Mbeki', email: 'thandi@example.com', stream: 'buyer', pipeline_stage: 'Contacted' });
  assert.match(known.subject, /with Thandi Mbeki \(\+27821234567\)/);
  assert.match(known.text, /\nEmail: thandi@example\.com   Stream: buyer   Stage: Contacted\n/);
  assert.match(known.text, /\[31 Oct 10:00\] Thandi:\n/);
  assert.match(known.text, /Replying to this email writes to thandi@example\.com\.$/);

  // No name anywhere: just the number.
  const bare = lib.waTranscriptEmail('+27821234567', [ev('whatsapp_inbound', '2026-10-31T08:00:03+00:00', { at: '2026-10-31T08:00:00Z', text: 'Hi' })], null);
  assert.equal(bare.subject, '[Lead agent] WhatsApp chat with +27821234567, 31 Oct');
  assert.match(bare.text, /\] Customer:\nHi/);
});

// ---------------------------------------------------------------- the workflow, end to end
// The Lead WhatsApp Agent Code nodes exactly as built for n8n, with Meta's
// Graph API, Supabase (REST and Storage) and SMTP faked. No network.

const workflow = buildAll().find((w) => w.name === 'Lead WhatsApp Agent');
const nodeCode = (name) => workflow.nodes.find((n) => n.name === name).parameters.jsCode;
const SECRET = 'app-secret';
const ME = '+27821234567';

function waHarness({ contacts = [], env: extra = {} } = {}) {
  const db = { contacts: contacts.slice(), events: [], suppression: [] };
  const mail = [];
  const sent = [];
  const storage = [];
  let raw = Buffer.alloc(0);
  // Raw HTTPS: Meta's Graph API and Supabase Storage.
  const https = {
    request(url, opts, cb) {
      const req = new EventEmitter();
      const chunks = [];
      req.write = (c) => chunks.push(Buffer.from(c));
      req.setTimeout = () => {};
      req.end = () => {
        const body = Buffer.concat(chunks);
        let reply;
        if (url.includes('/storage/v1/object/sign/')) {
          reply = { signedURL: url.split('/storage/v1')[1] + '?token=t' };
        } else if (url.includes('/storage/v1/object/')) {
          storage.push({ url, bytes: body.length, type: opts.headers['Content-Type'] });
          reply = { Key: 'stored' };
        } else {
          sent.push({ url, headers: opts.headers, body: JSON.parse(body.toString()) });
          reply = { messaging_product: 'whatsapp', messages: [{ id: `wamid.out${sent.length}` }] };
        }
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        cb(res);
        res.emit('data', Buffer.from(JSON.stringify(reply)));
        res.emit('end');
      };
      return req;
    },
  };
  // Supabase REST: just enough PostgREST for the workflow.
  const http = async ({ method, url, body }) => {
    const path = url.split('/rest/v1/')[1];
    const table = path.split('?')[0];
    const q = (re) => { const m = path.match(re); return m ? decodeURIComponent(m[1]) : null; };
    if (method === 'GET' && table === 'contacts') return db.contacts.filter((c) => c.mobile === q(/mobile=eq\.([^&]+)/) || c.id === q(/[?&]id=eq\.([^&]+)/));
    if (method === 'GET' && table === 'listings') return listings;
    if (method === 'GET' && table === 'suppression') return db.suppression.filter((s) => s.contact === q(/contact=eq\.([^&]+)/));
    if (method === 'GET' && table === 'events') {
      const types = (q(/event_type=(?:eq\.|in\.\()([^&)]+)/) || '').split(',');
      const messageId = q(/payload->>message_id=eq\.([^&]+)/);
      const waId = q(/payload->>wa_id=eq\.([^&]+)/);
      const contactId = q(/contact_id=eq\.([^&]+)/);
      return db.events.filter((e) => types.includes(e.event_type)
        && (!messageId || e.payload.message_id === messageId)
        && (!waId || e.payload.wa_id === waId)
        && (!contactId || e.contact_id === contactId)).reverse();
    }
    if (method === 'POST' && table === 'contacts') { const row = { id: `c${db.contacts.length + 1}`, ...body }; db.contacts.push(row); return [row]; }
    if (method === 'POST' && table === 'events') {
      // Each webhook's events are a second apart, as in production.
      for (const e of body) db.events.push({ id: `ev${db.events.length + 1}`, created_at: new Date(Date.UTC(2026, 9, 26, 7, 20, db.events.length)).toISOString(), ...e });
      return null;
    }
    if (method === 'POST' && table === 'suppression') { db.suppression.push(body); return null; }
    if (method === 'PATCH' && table === 'events') {
      const ids = q(/id=in\.\(([^)]+)\)/).split(',');
      for (const e of db.events) if (ids.includes(e.id)) Object.assign(e, body);
      return null;
    }
    if (method === 'PATCH' && table === 'contacts') { Object.assign(db.contacts.find((c) => c.id === q(/id=eq\.([^&]+)/)), body); return null; }
    return null;
  };
  const nodemailer = { createTransport: () => ({ sendMail: async (m) => { mail.push(m); return { messageId: `<out${mail.length}@x>` }; } }) };
  const env = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', AGENT_FROM: 'Harbour Key <info@harbourkey.example>',
    AGENT_ESCALATION_EMAIL: 'principal@harbourkey.example', AGENT_OWN_ADDRESSES: 'info@harbourkey.example', AGENT_FORMS_DIR: '/forms',
    AGENT_WA_TOKEN: 'wa-token', AGENT_WA_APP_SECRET: SECRET, AGENT_WA_PHONE_NUMBER_ID: PNID, AGENT_WA_VERIFY_TOKEN: 'tok123',
    AGENT_WA_AUTO_SEND: 'true', ...extra };
  const fs = { readFileSync: () => Buffer.from('%PDF-1.7 blank form') };
  const req = (name) => ({ nodemailer, crypto, https, fs })[name];
  const run = (name, $input, $ = () => ({ all: () => [] })) =>
    new Function('$input', '$env', '$', 'require', `return (async function () {\n${nodeCode(name)}\n})`)($input, env, $, req)
      .call({ helpers: { httpRequest: http, getBinaryDataBuffer: async () => raw } });
  // Meta's webhook post -> Receive. Returns the items the Wait node would hold for 20 seconds.
  const receive = (body, signature) => {
    raw = Buffer.from(JSON.stringify(body));
    const sig = signature !== undefined ? signature : 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    return run('Receive', { all: () => [{ json: { headers: { 'x-hub-signature-256': sig } } }] });
  };
  const says = (text, id, over = {}) => receive(post({ contacts: [{ profile: { name: 'Thandi M' }, wa_id: '27821234567' }], messages: [message({ id, text: { body: text }, ...over })] }));
  // After the wait: Prepare -> Claude (faked) -> Decide and act.
  const answer = async (items, claudeResult) => {
    const prepared = await run('Prepare', { all: () => items });
    if (!prepared.length) return { prepared, acted: [] };
    const response = { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(claudeResult) }], usage: { input_tokens: 1, output_tokens: 1 } };
    const acted = await run('Decide and act', { all: () => prepared.map(() => ({ json: response })) }, (n) => ({ all: () => (n === 'Prepare' ? prepared : []) }));
    return { prepared, acted };
  };
  const types = () => db.events.map((e) => e.event_type);
  return { db, mail, sent, storage, run, receive, says, answer, types };
}

const draft = (body, over = {}) => ({
  category: 'buyer', language: 'en', confidence: 'high', summary: 'Buyer, 2 bed Riverbend', missing_info: [], attach: [],
  escalate: { needed: false, reason: '' }, reply: { subject: '', body },
  extracted: { first_name: 'Thandi', last_name: null, email: null, phone: null, areas: ['Riverbend'], budget_max_zar: 1000000, listing_of_interest: null }, ...over,
});

test('Lead WhatsApp Agent: a burst of messages gets one reply, sent through the Graph API and logged', async () => {
  const h = waHarness();
  const first = await h.says('Hi', 'wamid.1');
  const second = await h.says('2 bed in Riverbend, around R1m?', 'wamid.2');
  assert.deepEqual(first, [{ json: { phone: ME, last: 'wamid.1' } }]);

  // The first message's run steps aside: a newer message arrived during the wait.
  assert.deepEqual((await h.answer(first, draft('x'))).prepared, []);
  assert.equal(h.sent.length, 0);

  const { prepared, acted } = await h.answer(second, draft('The Quay in Riverbend is R990 000.\n\nWhat day suits you for a viewing?'));
  assert.match(prepared[0].json.request.messages[0].content, /<whatsapp>\nFrom: Thandi M \(WhatsApp \+27821234567\)\n\nHi\n\n2 bed in Riverbend, around R1m\?\n<\/whatsapp>/);
  assert.equal(acted[0].json.action, 'send');
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].url, `https://graph.facebook.com/v25.0/${PNID}/messages`);
  assert.equal(h.sent[0].headers.Authorization, 'Bearer wa-token');
  assert.deepEqual(h.sent[0].body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '27821234567', type: 'text',
    text: { body: 'The Quay in Riverbend is R990 000.\n\nWhat day suits you for a viewing?' } });
  assert.equal(h.mail.length, 0);

  // CRM: a contact for the number, and every event tied to it.
  assert.equal(h.db.contacts[0].mobile, ME);
  assert.ok(h.db.contacts[0].tags.includes('source:whatsapp'));
  assert.equal(h.db.contacts[0].pipeline_stage, 'Contacted');
  assert.deepEqual(h.types(), ['whatsapp_inbound', 'whatsapp_inbound', 'ai_triage', 'whatsapp_outbound']);
  assert.ok(h.db.events.every((e) => e.contact_id === 'c1'));
  assert.deepEqual(h.db.events[2].payload.message_ids, ['wamid.1', 'wamid.2']);

  // Meta retries webhooks: the same message is never logged or answered twice.
  assert.deepEqual(await h.says('2 bed in Riverbend, around R1m?', 'wamid.2'), []);
  // And both messages are answered, so a late run has nothing to do.
  assert.deepEqual((await h.answer(second, draft('x'))).prepared, []);
});

test('Lead WhatsApp Agent: a post without Meta\'s signature is ignored', async () => {
  const h = waHarness();
  const body = post({ messages: [message({ text: { body: 'Hi' } })] });
  assert.deepEqual(await h.receive(body, 'sha256=' + '0'.repeat(64)), []);
  assert.deepEqual(await h.receive(body, ''), []);
  assert.equal(h.db.events.length, 0);
});

test('Lead WhatsApp Agent: with its kill switch off nothing is sent and staff get the draft', async () => {
  // The email switch being on makes no difference.
  const h = waHarness({ env: { AGENT_WA_AUTO_SEND: 'false', AGENT_AUTO_SEND: 'true' } });
  const { acted } = await h.answer(await h.says('2 bed in Riverbend?', 'wamid.1'), draft('The Quay in Riverbend is R990 000.'));
  assert.equal(acted[0].json.action, 'escalate');
  assert.equal(h.sent.length, 0);
  assert.equal(h.mail[0].to, 'principal@harbourkey.example');
  assert.match(h.mail[0].subject, /Needs you: auto-send is off, draft for review \(WhatsApp \+27821234567\)/);
  assert.match(h.mail[0].text, /phone them on \+27821234567/);
  assert.match(h.mail[0].text, /---------- AI draft ----------\nThe Quay in Riverbend is R990 000\./);
});

test('Lead WhatsApp Agent: a draft that fails the guardrails is never sent', async () => {
  const h = waHarness();
  const { acted } = await h.answer(await h.says('What would the bond cost me?', 'wamid.1'), draft('At a bond rate of 11.5 you would pay about R9 000 a month.'));
  assert.equal(acted[0].json.action, 'escalate');
  assert.ok(acted[0].json.issues.includes('mentions interest or bond rates'));
  assert.ok(acted[0].json.issues.includes('unverified amount R9000'));
  assert.equal(h.sent.length, 0);
  assert.equal(h.mail.length, 1);
});

test('Lead WhatsApp Agent: a photo goes to a person, with a holding reply to the customer', async () => {
  const h = waHarness();
  const items = await h.says('', 'wamid.1', { type: 'image', image: { id: '1001', mime_type: 'image/jpeg', caption: 'my ID' } });
  const { prepared, acted } = await h.answer(items, draft('Thanks Thandi, a person on the team will check it and get back to you.', { category: 'bond' }));
  assert.match(prepared[0].json.request.messages[0].content, /\[They sent a photo, which a person on the team will look at\] my ID/);
  assert.equal(acted[0].json.action, 'escalate');
  assert.equal(acted[0].json.reason, 'needs a person: they sent a photo');
  assert.equal(h.sent.length, 1);
  assert.match(h.mail[0].text, /A short holding reply WAS sent to them on WhatsApp/);
  assert.equal(h.db.events.find((e) => e.event_type === 'whatsapp_outbound').payload.kind, 'holding');
});

test('Lead WhatsApp Agent: the pre-qualification form arrives in the chat as a PDF', async () => {
  const h = waHarness();
  const { acted } = await h.answer(await h.says('How do I get pre-qualified?', 'wamid.1'),
    draft('I\'ve attached our Pre-Qualification form. Send it back here with your ID and your latest three payslips.', { category: 'bond', attach: ['prequal_form'] }));
  assert.deepEqual(acted[0].json.forms, ['prequal_form']);
  // Meta fetches the file from a link: the form goes to private Storage, and Meta gets a signed link.
  assert.equal(h.storage.length, 1);
  assert.match(h.storage[0].url, /^https:\/\/sb\.test\/storage\/v1\/object\/agent-files\/whatsapp-forms\//);
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].body.type, 'document');
  assert.equal(h.sent[1].body.document.filename, forms()[0].filename);
  assert.match(h.sent[1].body.document.link, /^https:\/\/sb\.test\/storage\/v1\/object\/sign\/agent-files\/whatsapp-forms\/.+\?token=t$/);
});

test('Lead WhatsApp Agent: STOP is confirmed and recorded, and they are not answered again', async () => {
  const h = waHarness();
  const { acted } = await h.answer(await h.says('STOP', 'wamid.1'),
    draft('Hi Thandi,\n\nConfirmed, you\'ve been removed from our lists. If we have a transaction in progress with you, the principal will be in touch personally.', { category: 'opt_out' }));
  assert.equal(acted[0].json.action, 'optout');
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.db.suppression, [{ contact: ME, contact_type: 'phone', reason: 'WhatsApp opt-out', source: 'whatsapp-agent', actor: 'ai' }]);

  const again = await h.answer(await h.says('Hello?', 'wamid.2'), draft('x'));
  assert.deepEqual(again.prepared, []);
  assert.equal(h.sent.length, 1);
  assert.equal(h.db.events.at(-1).event_type, 'whatsapp_skipped');
  assert.equal(h.db.events.at(-1).payload.reason, 'opted out');
});

test('Lead WhatsApp Agent: a reply Meta could not deliver is emailed to staff, once', async () => {
  const h = waHarness();
  const failed = post({ statuses: [{ id: 'wamid.out1', status: 'failed', recipient_id: '27821234567', errors: [{ code: 131047, title: 'Re-engagement message' }] }] });
  await h.receive(failed);
  await h.receive(failed);
  assert.equal(h.mail.length, 1);
  assert.equal(h.mail[0].subject, '[Lead agent] WhatsApp message not delivered (+27821234567)');
  assert.deepEqual(h.types(), ['whatsapp_failed']);
});

test('Lead WhatsApp Agent: Meta\'s check of the webhook URL is answered only for our verify token', async () => {
  const h = waHarness();
  const check = (token) => h.run('Check verify token', { first: () => ({ json: { query: { 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '1158201444' } } }) });
  assert.deepEqual(await check('tok123'), [{ json: { status: 200, reply: '1158201444' } }]);
  assert.deepEqual(await check('guess'), [{ json: { status: 403, reply: 'Forbidden' } }]);
});
