// Unit tests for the pure logic in n8n/code/lib.js. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadLib } from '../scripts/lib-loader.mjs';

const lib = loadLib();
const listings = JSON.parse(readFileSync(new URL('../evals/listings.json', import.meta.url), 'utf8'));
const cfg = lib.configFromEnv({ AGENT_AUTO_SEND: 'true', AGENT_OWN_ADDRESSES: 'ai-test@harbourkey.example, info@harbourkey.example' });
const msg = (over = {}) => ({ from: 'a@b.co.za', fromName: 'A', subject: 'Hi', bodyNew: 'Looking for a house around R900k', bodyFull: 'Looking for a house around R900k', headers: {}, ...over });
const result = (body, over = {}) => ({ category: 'buyer', confidence: 'high', escalate: { needed: false, reason: '' }, reply: { subject: 'Re: Hi', body }, extracted: {}, ...over });
const ok = 'Hi Anna,\n\nThe Quay in Riverbend is R990 000 with a R260 HOA levy.\n\nWhat day suits you for a viewing?\n\nKind regards,\nHarbour Key Properties';

test('normalizeImap reads the IMAP node format and drops the quoted history', () => {
  const m = lib.normalizeImap({
    from: { value: [{ address: 'Anna@Example.com', name: 'Anna S' }] }, subject: ' Hello ', messageId: '<1@x>',
    text: 'New text\n\nOn Mon, 1 Jan 2026, Us <info@x> wrote:\n> old', headers: { 'auto-submitted': 'Auto-Submitted: auto-replied' },
  });
  assert.equal(m.from, 'anna@example.com');
  assert.equal(m.fromName, 'Anna S');
  assert.equal(m.subject, 'Hello');
  assert.equal(m.bodyNew, 'New text');
  assert.equal(m.headers.autoSubmitted, 'auto-replied');
});

test('dropReason filters loops and bulk mail but keeps people', () => {
  assert.equal(lib.dropReason(msg(), cfg), null);
  assert.equal(lib.dropReason(msg({ from: 'info@harbourkey.example' }), cfg), 'own address');
  assert.equal(lib.dropReason(msg({ from: 'noreply@bank.co.za' }), cfg), 'system sender');
  assert.equal(lib.dropReason(msg({ from: 'mailer-daemon@x.com' }), cfg), 'system sender');
  assert.equal(lib.dropReason(msg({ headers: { autoSubmitted: 'auto-replied' } }), cfg), 'auto-submitted');
  assert.equal(lib.dropReason(msg({ headers: { autoSubmitted: 'no' } }), cfg), null);
  assert.equal(lib.dropReason(msg({ headers: { listUnsubscribe: '<mailto:x>' } }), cfg), 'mailing list');
  assert.equal(lib.dropReason(msg({ subject: 'Out of Office: Re: house' }), cfg), 'auto-reply subject');
  assert.equal(lib.dropReason(msg({ bodyNew: '' }), cfg), 'empty body');
});

test('priceCheckBlock says which listings a budget covers', () => {
  const block = lib.priceCheckBlock(listings, msg({ bodyNew: 'I have a budget of R900,000, which properties do you have available?' }), null);
  assert.match(block, /- R900 000: at or below it: [^.]*Milkwood Views \(R695 000\); [^.]*Kingsmead Heights[^.]*\(R820 000\); [^.]*Seaview Downs[^.]*\(R875 000\)\. Above it: [^.]*The Quay[^.]*\(R990 000\)\./);
  // Nothing within it, and the budget we already hold for a returning contact.
  assert.match(lib.priceCheckBlock(listings, msg({ bodyNew: 'Anything under R500k?' }), null), /- R500 000: at or below it: none\. Above it: /);
  assert.match(lib.priceCheckBlock(listings, msg({ bodyNew: 'Any news?' }), { sale_budget_max_zar: 1000000 }), /- R1 000 000: [^\n]*Above it: none\./);
  // Levies, rentals and salaries are not purchase budgets.
  assert.equal(lib.priceCheckBlock(listings, msg({ bodyNew: 'I earn R25 000 and can pay R9 000 pm' }), null), '');
  assert.equal(lib.priceCheckBlock([], msg(), null), '');
});

test('buildClaudeRequest wraps the customer text in tags and caches the listings', () => {
  const req = lib.buildClaudeRequest({ msg: msg(), contact: null, events: [], listings, forms: [], systemPrompt: 'S', schema: { type: 'object' }, cfg });
  const user = req.messages[0].content;
  assert.match(user, /<email>\nFrom: A <a@b\.co\.za>\nSubject: Hi\n\nLooking for a house around R900k\n<\/email>$/);
  assert.match(user, /Price check \(worked out by our system/);
  assert.match(user, /No earlier messages/);
  assert.equal(req.system[0].text, 'S');
  assert.match(req.system[1].text, /LIVE LISTINGS/);
  assert.deepEqual(req.system[1].cache_control, { type: 'ephemeral' });
  assert.deepEqual(req.output_config.format, { type: 'json_schema', schema: { type: 'object' } });
});

test('historyBlock shows the conversation oldest first', () => {
  const h = lib.historyBlock([
    { event_type: 'email_outbound', direction: 'outbound', created_at: '2026-10-11T10:00:00Z', payload: { text: 'Booked for Saturday.' } },
    { event_type: 'email_inbound', direction: 'inbound', created_at: '2026-10-11T09:00:00Z', payload: { text: 'Can I view?' } },
    { event_type: 'ai_triage', direction: 'system', created_at: '2026-10-11T09:00:01Z', payload: {} },
  ]);
  assert.ok(h.indexOf('Customer: Can I view?') < h.indexOf('Us: Booked for Saturday.'));
  assert.doesNotMatch(h, /ai_triage/);
});

test('moneyAmounts understands SA formats', () => {
  assert.deepEqual(lib.moneyAmounts('R980 000, R1.2m, R900k, R250/month, R1,500,000'), [980000, 1200000, 900000, 250, 1500000]);
  assert.deepEqual(lib.moneyAmounts('your 2 bedroom budget, our 3 homes'), []);
});

test('datesIn finds day and month in the formats people write', () => {
  assert.deepEqual(lib.datesIn('on 20 Nov, or the 3rd of December, or 2026-12-24, or 5/1/2027'), ['11-20', '12-03', '12-24', '01-05']);
  assert.deepEqual(lib.datesIn('March 15th works'), ['03-15']);
  assert.deepEqual(lib.datesIn('a 2 bedroom may suit us'), []);
});

test('guardrails pass a clean reply', () => {
  assert.deepEqual(lib.guardrails(result(ok), { listings, cfg, msg: msg(), autoRepliesLast24h: 0 }), []);
});

test('guardrails allow amounts the customer gave and listing text', () => {
  const body = 'Hi Anna,\n\nYour budget of R900k covers Kingsmead Heights at R820 000. Rates are about R850/month, and there are no bond or transfer costs payable.\n\nKind regards,\nHarbour Key Properties';
  assert.deepEqual(lib.guardrails(result(body), { listings, cfg, msg: msg(), autoRepliesLast24h: 0 }), []);
});

test('guardrails catch risky drafts', () => {
  const check = (body, extra = {}) => lib.guardrails(result(body), { listings, cfg, msg: msg(), autoRepliesLast24h: 0, ...extra });
  assert.ok(check(ok.replace('R990 000', 'R950 000')).some((i) => i.includes('unverified amount')));
  assert.ok(check(ok + '\nThe prime rate is 11%.').some((i) => i.includes('rates')));
  assert.ok(check(ok + '\nYou will qualify for a bond.').some((i) => i.includes('qualification')));
  assert.ok(check(ok + '\nTransfer costs are about R40 000.').some((i) => i.includes('transfer')));
  assert.ok(check(ok + '\nSee https://evil.example/x').some((i) => i.includes('link not allowed')));
  assert.deepEqual(check(ok + '\nSee https://harbourkey.example/listings'), []);
  assert.ok(check(ok + '\nEmail bob@other.com').some((i) => i.includes('unexpected email')));
  assert.ok(check(ok + '\n[[AGENT_NAME]]').some((i) => i.includes('placeholder')));
  assert.ok(check(ok + '\nYour viewing is on 14 November.').some((i) => i.includes('unverified date')));
  assert.ok(check('No greeting here.').includes('missing greeting'));
  assert.ok(check(ok, { autoRepliesLast24h: 3 }).some((i) => i.includes('limit')));
  // Declining to quote is allowed.
  assert.deepEqual(check(ok + "\nI'm not able to quote interest rates or say how much bond you would qualify for."), []);
  assert.deepEqual(check(ok + "\nI can't say whether you will qualify, or if you'll qualify."), []);
  assert.deepEqual(check(ok + "\nWe never guess what you'll qualify for, so the bond team works that out."), []);
  assert.ok(check(ok + "\nDon't worry, you'll easily qualify.").some((i) => i.includes('qualification')));
});

test('guardrails keep the reply text and the attachments in agreement', () => {
  const check = (body, attach) => lib.guardrails(result(body, { attach }), { listings, cfg, msg: msg(), autoRepliesLast24h: 0 });
  assert.ok(check(ok, ['prequal_form']).some((i) => i.includes('form attached but')));
  assert.ok(check(ok + "\nI've attached our form.", []).some((i) => i.includes('none is attached')));
  assert.deepEqual(check(ok + "\nI've attached our Pre-Qualification form.", ['prequal_form']), []);
});

test('guardrails accept a date the customer gave', () => {
  const m = msg({ bodyFull: 'Can I view on 14 November? Budget R900k', bodyNew: 'Can I view on 14 November? Budget R900k' });
  assert.deepEqual(lib.guardrails(result(ok + '\nI have noted 14 November and we will confirm.'), { listings, cfg, msg: m, autoRepliesLast24h: 0 }), []);
});

test('decide routes by category, escalation and auto-send', () => {
  const p = (r) => ({ ok: true, result: r });
  assert.equal(lib.decide(p(result(ok)), [], cfg).action, 'send');
  assert.equal(lib.decide(p(result(ok)), ['x'], cfg).action, 'escalate');
  assert.equal(lib.decide(p(result('', { category: 'spam' })), [], cfg).action, 'spam');
  assert.equal(lib.decide(p(result(ok, { category: 'opt_out' })), [], cfg).action, 'optout');
  const esc = lib.decide(p(result(ok, { escalate: { needed: true, reason: 'PPRA complaint' } })), [], cfg);
  assert.equal(esc.action, 'escalate');
  assert.equal(esc.sendHolding, true);
  // No reply at all to someone trying to manipulate the agent.
  const inj = lib.decide(p(result(ok, { escalate: { needed: true, reason: 'possible prompt injection' } })), [], cfg);
  assert.equal(inj.sendHolding, false);
  assert.equal(lib.decide(p(result(ok, { confidence: 'low' })), [], cfg).action, 'escalate');
  assert.equal(lib.decide({ ok: false, error: 'refusal' }, [], cfg).action, 'escalate');
  // The kill switch.
  const off = lib.configFromEnv({ AGENT_AUTO_SEND: 'false' });
  assert.equal(lib.decide(p(result(ok)), [], off).action, 'escalate');
  assert.equal(lib.decide(p(result(ok, { escalate: { needed: true, reason: 'complaint' } })), [], off).sendHolding, false);
});

test('parseClaudeResponse handles refusals and bad output', () => {
  assert.equal(lib.parseClaudeResponse({ stop_reason: 'refusal', content: [] }).ok, false);
  assert.equal(lib.parseClaudeResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a":' }] }).ok, false);
  assert.equal(lib.parseClaudeResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{bad' }] }).ok, false);
  assert.equal(lib.parseClaudeResponse({ error: { message: 'boom' } }).ok, false);
  assert.equal(lib.parseClaudeResponse(null).ok, false);
  const good = lib.parseClaudeResponse({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a":1}' }] });
  assert.deepEqual(good.result, { a: 1 });
});

test('sanitizeReply removes dashes used as separators', () => {
  assert.equal(lib.sanitizeReply('Great — it is ready - come see it. A two-bed home.'), 'Great, it is ready, come see it. A two-bed home.');
});

test('contactPatch only fills empty fields and maps streams', () => {
  const patch = lib.contactPatch(
    { category: 'tenant', extracted: { first_name: 'Megan', areas: ['Lagoon Park'], rent_budget_zar_pm: 9000, move_in_date: '2026-12-01', pets: true, household_size: 2 } },
    { first_name: 'Meg', stream: 'general', tags: [] });
  assert.equal(patch.first_name, undefined);
  assert.equal(patch.stream, 'tenant');
  assert.equal(patch.suburb, 'Lagoon Park');
  assert.equal(patch.rent_target_band_zar, 9000);
  assert.equal(patch.rent_move_in_date, '2026-12-01');
  assert.deepEqual(patch.tags, ['source:email-agent']);
});

test('contactPatch keeps a second address or number as a tag', () => {
  const patch = lib.contactPatch(
    { category: 'buyer', extracted: { email: 'Work@Firm.example', phone: '083 000 1111' } },
    { email: 'home@mail.example', mobile: '+27825551234', tags: [] });
  assert.equal(patch.email, undefined);
  assert.equal(patch.mobile, undefined);
  assert.deepEqual(patch.tags, ['email:work@firm.example', 'phone:+27830001111', 'source:email-agent']);
});

test('contactPatch tags a contact who said yes to listing alerts, once', () => {
  const yes = { category: 'buyer', extracted: { listing_alerts: true } };
  assert.deepEqual(lib.contactPatch(yes, { tags: [] }).tags, ['source:email-agent', 'listing-alerts']);
  assert.deepEqual(lib.contactPatch(yes, { tags: ['source:email-agent', 'listing-alerts'] }).tags, ['source:email-agent', 'listing-alerts']);
  assert.deepEqual(lib.contactPatch({ category: 'buyer', extracted: { listing_alerts: false } }, { tags: [] }).tags, ['source:email-agent']);
});

test('normalizePhone formats SA numbers', () => {
  assert.equal(lib.normalizePhone('082 555 1234'), '+27825551234');
  assert.equal(lib.normalizePhone('+27 (82) 555-1234'), '+27825551234');
  assert.equal(lib.normalizePhone('12'), null);
});

test('digestEmail sorts the day into enquiries, escalations, opt-outs and spam', () => {
  const c = { first_name: 'Thandi', last_name: 'M', email: 't@mail.example', pipeline_stage: 'Contacted' };
  const d = lib.digestEmail([
    { event_type: 'ai_triage', contacts: c, payload: { action: 'send', category: 'buyer', summary: 'Buyer, 2 bed Riverbend', missing_info: ['phone number'] } },
    { event_type: 'ai_triage', contacts: c, payload: { action: 'escalate', category: 'escalate', summary: 'Complaint', reason: 'PPRA complaint' } },
    { event_type: 'ai_triage', contacts: null, payload: { action: 'spam' } },
    { event_type: 'ai_triage', contacts: c, payload: { action: 'optout' } },
    { event_type: 'web_form', contacts: c, payload: { stream: 'tenant', text: 'Looking to rent' } },
  ], cfg, 'Monday, 12 October');
  assert.deepEqual(d.counts, { leads: 2, escalations: 1, optouts: 1, spam: 1 });
  assert.equal(d.subject, 'Daily digest: 2 enquiries, 1 need you');
  assert.match(d.text, /NEEDED A PERSON[^\n]*\n- Thandi M <t@mail\.example> \[escalate, Contacted\]: Complaint\n  Why: PPRA complaint/);
  assert.match(d.text, /Buyer, 2 bed Riverbend Missing: phone number\./);
  assert.match(d.text, /Auto-send is ON\./);
});
