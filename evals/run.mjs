// Runs the agent's prompt against evals/cases.json using the real Claude API,
// then applies the same guardrails and decision logic the n8n workflow uses.
//
//   ANTHROPIC_API_KEY=... node evals/run.mjs            all cases
//   ANTHROPIC_API_KEY=... node evals/run.mjs bond       cases whose name contains "bond"
//
// Each case is an email (or a burst of WhatsApp messages) and what must be true of the outcome: the category,
// the action (send / escalate / optout / spam), text the reply must or must
// not contain, and details that must be extracted. A draft that would reach
// a customer must also pass every guardrail.
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadLib, systemPrompt, schema, forms } from '../scripts/lib-loader.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const lib = loadLib();
const cases = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));
const listings = JSON.parse(readFileSync(join(here, 'listings.json'), 'utf8'));
const filter = process.argv[2] || '';
const cfg = lib.configFromEnv({ AGENT_AUTO_SEND: 'true', AGENT_OWN_ADDRESSES: 'info@harbourkey.example' });
const client = new Anthropic();
const SYSTEM = systemPrompt();
const SCHEMA = schema();
const FORMS = forms();
const TODAY = new Date('2026-10-12T08:00:00Z');

function toImap(email) {
  return {
    from: { value: [{ address: email.from, name: email.fromName }] },
    to: { value: [{ address: 'info@harbourkey.example', name: '' }] },
    subject: email.subject,
    messageId: `<eval-${Math.random().toString(36).slice(2)}@test>`,
    text: email.body,
    headers: email.headers || {},
    date: '2026-10-12T08:00:00Z',
  };
}

// A WhatsApp case: { name, messages: [text, ...], needs_person } as Receive and Prepare would batch them.
function toWhatsApp(w) {
  const pending = w.messages.map((text, i) => ({ id: `ev${i}`, created_at: `2026-10-12T08:00:0${i}Z`,
    payload: { message_id: `wamid.eval${i}`, wa_id: w.phone || '+27821234567', name: w.name, at: `2026-10-12T08:00:0${i}Z`, text,
      needs_person: i === w.messages.length - 1 ? w.needs_person || null : null } }));
  return lib.normalizeWhatsApp(w.phone || '+27821234567', pending);
}

async function runCase(c) {
  const msg = c.whatsapp ? toWhatsApp(c.whatsapp) : lib.normalizeImap(toImap(c.email));
  // WhatsApp has its own kill switch and reply limit.
  const ccfg = lib.channelConfig({ ...cfg, waAutoSend: true }, msg.channel);
  const drop = c.whatsapp ? null : lib.dropReason(msg, cfg);
  const fails = [];
  if (c.filterOnly) {
    if (c.expect.filtered && !drop) fails.push('expected to be filtered');
    return { name: c.name, fails, detail: `filtered: ${drop}` };
  }
  if (drop) return { name: c.name, fails: [`unexpectedly filtered: ${drop}`] };

  const request = lib.buildClaudeRequest({ msg, contact: c.contact || null, events: (c.history || []).slice().reverse(), listings,
    forms: FORMS, systemPrompt: SYSTEM, schema: SCHEMA, cfg, now: TODAY });
  const started = Date.now();
  let resp;
  try {
    resp = await client.messages.create(request);
  } catch (e) {
    resp = { error: { message: e.message } };
  }
  const parsed = lib.parseClaudeResponse(resp);
  const r = parsed.ok ? parsed.result : null;
  const issues = r ? lib.guardrails(r, { listings, cfg: ccfg, msg, autoRepliesLast24h: 0 }) : [];
  const decision = lib.decide(parsed, issues, ccfg, msg.needsPerson ? `needs a person: ${msg.needsPerson}` : null);
  const body = r ? lib.sanitizeReply(r.reply.body) : '';
  const e = c.expect;

  if (!parsed.ok) fails.push(parsed.error);
  if (e.category && r && !e.category.includes(r.category)) fails.push(`category ${r.category}, expected ${e.category.join('|')}`);
  if (e.action && !e.action.includes(decision.action)) fails.push(`action ${decision.action} (${decision.reason}), expected ${e.action.join('|')}`);
  if (e.attach && r && JSON.stringify(r.attach) !== JSON.stringify(e.attach)) fails.push(`attach ${JSON.stringify(r.attach)}, expected ${JSON.stringify(e.attach)}`);
  if (e.escalate === true && r && !(r.escalate.needed || r.category === 'escalate')) fails.push('expected escalate.needed');
  for (const p of e.match || []) if (!new RegExp(p, 'i').test(body)) fails.push(`reply should match /${p}/`);
  for (const p of e.notMatch || []) if (new RegExp(p, 'i').test(body)) fails.push(`reply must not match /${p}/`);
  for (const [k, v] of Object.entries(e.extracted || {})) {
    if (!r || !String(r.extracted[k] || '').includes(v)) fails.push(`extracted.${k} should contain "${v}"`);
  }
  // Every draft that would go to a customer must pass the guardrails.
  if ((decision.action === 'send' || decision.sendHolding) && issues.length) fails.push(`guardrails: ${issues.join('; ')}`);

  return {
    name: c.name, fails,
    detail: { action: decision.action, reason: decision.reason, category: r && r.category, confidence: r && r.confidence,
      issues, attach: r && r.attach, summary: r && r.summary, extracted: r && r.extracted, reply: body,
      ms: Date.now() - started, usage: parsed.usage || resp.usage },
  };
}

const selected = cases.filter((c) => c.name.includes(filter));
const results = [];
// Small batches keep us well inside rate limits.
for (let i = 0; i < selected.length; i += 5) {
  results.push(...(await Promise.all(selected.slice(i, i + 5).map(runCase))));
}

let inTok = 0, outTok = 0, cacheRead = 0;
for (const r of results) {
  const u = (r.detail && r.detail.usage) || {};
  inTok += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  cacheRead += u.cache_read_input_tokens || 0;
  outTok += u.output_tokens || 0;
  console.log(`${r.fails.length ? 'FAIL' : 'pass'}  ${r.name}${r.fails.length ? '\n      - ' + r.fails.join('\n      - ') : ''}`);
}
const passed = results.filter((r) => !r.fails.length).length;
console.log(`\n${passed}/${results.length} passed. Tokens: ${inTok} in, ${cacheRead} cached, ${outTok} out.`);

mkdirSync(join(here, 'results'), { recursive: true });
const file = join(here, 'results', `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`Full replies: ${file}`);
process.exit(passed === results.length ? 0 : 1);
