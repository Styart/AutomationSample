// The voice agent end to end, offline: Asterisk (the dialplan's CURL calls and
// the AudioSocket connection), OpenAI's Realtime WebSocket, Supabase, n8n and
// SMTP are all faked. A call goes through voice/agent.mjs, and the transcript it
// hands over runs through the Lead Voice Calls Code nodes exactly as built for n8n.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createVoiceAgent } from '../voice/agent.mjs';
import { KIND, FrameReader, frame, uuidString, slinToUlaw, ulawToSlin } from '../voice/audiosocket.mjs';
import { renderDialplan } from '../voice/dialplan.mjs';
import { loadShared, voicePrompt } from '../voice/load.mjs';
import { buildAll } from '../scripts/build.mjs';

const listings = JSON.parse(readFileSync(new URL('../evals/listings.json', import.meta.url), 'utf8'));
const lib = loadShared();
const SECRET = 'ab'.repeat(24);
const ENV = {
  AGENT_VOICE_ENABLED: 'false', AGENT_VOICE_TEST_NUMBERS: '082 123 4567', AGENT_OFFICE_NUMBER: '041 000 1111',
  OPENAI_API_KEY: 'sk-test', AGENT_ASTERISK_SECRET: SECRET, AGENT_VOICE_INTERNAL_KEY: 'internal-key',
  AGENT_VOICE_N8N_URL: 'http://n8n:5678/webhook/voice-call-ended',
  SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', AGENT_VOICE_MAX_MINUTES: '15',
};
const CALLER = '+27821234567';
const UUIDS = ['0f8fad5b-d9cb-469f-a165-70867728950e', '7c9e6679-7425-40de-944b-e07fc1f90ae7'];

// ---- fakes

function fakeTimers() {
  let t = 0;
  const q = [];
  return {
    q,
    now: () => t,
    setTimeout(fn, ms) { const h = { fn, at: t + ms }; q.push(h); return h; },
    clearTimeout(h) { const i = q.indexOf(h); if (i >= 0) q.splice(i, 1); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at);
        if (!q[0] || q[0].at > end) break;
        const h = q.shift();
        t = Math.max(t, h.at);
        h.fn();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
    },
  };
}

class FakeWS {
  static all = [];
  constructor(url, opts) { Object.assign(this, { url, opts, sent: [], readyState: 0, listeners: {} }); FakeWS.all.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, e) { for (const fn of this.listeners[type] || []) fn(e); }
  open() { this.readyState = 1; this.emit('open', {}); }
  server(event) { this.emit('message', { data: JSON.stringify(event) }); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close', {}); }
  types() { return this.sent.map((e) => e.type); }
}

// Asterisk's end of an AudioSocket connection.
class FakeSocket extends EventEmitter {
  constructor() { super(); this.reader = new FrameReader(); this.frames = []; this.ended = false; this.destroyed = false; }
  write(buf) { this.frames.push(...this.reader.push(buf)); }
  end(buf) { if (buf) this.write(buf); if (!this.ended) { this.ended = true; this.emit('close'); } }
  destroy() { this.destroyed = true; this.emit('close'); }
  asterisk(kind, payload) { this.emit('data', frame(kind, payload)); }
  audioOut() { return this.frames.filter(([k]) => k === KIND.AUDIO); }
  hungUp() { return this.frames.some(([k]) => k === KIND.HANGUP); }
}

const uuidBytes = (id) => Buffer.from(id.replace(/-/g, ''), 'hex');
const ulaw = (bytes, fill = 0x7f) => Buffer.alloc(bytes, fill).toString('base64');

function voiceHarness({ env = {}, contacts = [], suppressed = [], supabaseDown = false, n8nDown = false } = {}) {
  const calls = { n8n: [], sb: [] };
  const logs = [];
  const fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (url.startsWith('https://sb.test/rest/v1/')) {
      const path = url.split('/rest/v1/')[1];
      calls.sb.push(path);
      if (supabaseDown) throw new Error('getaddrinfo ENOTFOUND sb.test');
      const table = path.split('?')[0];
      const rows = table === 'listings' ? listings
        : table === 'contacts' ? contacts.filter((c) => path.includes(`mobile=eq.${encodeURIComponent(c.mobile)}`))
        : table === 'suppression' ? suppressed.filter((p) => path.includes(`contact=eq.${encodeURIComponent(p)}`)).map(() => ({ id: 's1' }))
        : [];
      return new Response(JSON.stringify(rows), { status: 200 });
    }
    if (url === ENV.AGENT_VOICE_N8N_URL) {
      calls.n8n.push({ headers: opts.headers, body });
      return new Response('', { status: n8nDown ? 502 : 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const timers = fakeTimers();
  const log = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const ids = [...UUIDS];
  FakeWS.all = [];
  const agent = createVoiceAgent({ env: { ...ENV, ...env }, lib, systemPrompt: voicePrompt(), fetch, WebSocket: FakeWS,
    timers, clock: timers.now, log, retryDelays: [], newId: () => ids.shift() });
  const post = (path, params) => agent.handle({ method: 'POST', path, body: new URLSearchParams(params).toString() });
  // The dialplan's two CURL calls.
  const register = (from = '0821234567', { secret = SECRET, channel = '1761720000.42' } = {}) =>
    post('/voice/asterisk/calls', { secret, from, channel });
  const after = (call, secret = SECRET) => post('/voice/asterisk/after', { secret, call });
  // A registered call whose audio has reached us, with OpenAI's WebSocket open.
  async function connect(from) {
    const res = await register(from);
    assert.equal(res.body.length, 36, `registered: ${res.body}`);
    const socket = new FakeSocket();
    agent.audiosocket(socket);
    socket.asterisk(KIND.UUID, uuidBytes(res.body));
    const ws = FakeWS.all.at(-1);
    ws.open();
    return { id: res.body, socket, ws };
  }
  return { agent, calls, logs, timers, post, register, after, connect };
}

// ---- the dialplan's questions: who takes the call

test('a call rings the office while the agent is off; test numbers reach the agent in any caller ID format', async () => {
  const h = voiceHarness();
  assert.deepEqual(await h.register('0831112222'), { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'office' });
  assert.ok(h.logs.some((l) => /\+27831112222 rings the office \(agent is off\)/.test(l)));
  assert.equal((await h.register('anonymous')).body, 'office');
  assert.equal((await h.register('0821234567')).body, UUIDS[0]);
  assert.equal((await h.register('+27821234567')).body, UUIDS[1]);
  assert.equal(h.agent.pending.get(UUIDS[0]).phone, CALLER);
  assert.equal(h.agent.pending.get(UUIDS[0]).channel, '1761720000.42');

  // Unused UUIDs expire.
  await h.timers.advance(30000);
  assert.equal(h.agent.pending.size, 0);
});

test('agent on reaches everyone, withheld numbers too; a wrong secret or no OpenAI key rings the office', async () => {
  const on = voiceHarness({ env: { AGENT_VOICE_ENABLED: 'true' } });
  assert.equal((await on.register('0027831112222')).body, UUIDS[0]);
  assert.equal((await on.register('anonymous')).body, UUIDS[1]);
  assert.equal(on.agent.pending.get(UUIDS[1]).phone, null);
  assert.match(on.agent.pending.get(UUIDS[1]).instructions, /Caller ID: withheld\./);

  const forged = await on.register(CALLER, { secret: 'nope' });
  assert.deepEqual([forged.status, forged.body], [403, 'office']);
  assert.ok(on.logs.some((l) => /wrong secret/.test(l)));
  assert.equal((await voiceHarness({ env: { AGENT_VOICE_ENABLED: 'true', AGENT_ASTERISK_SECRET: '' } }).register(CALLER, { secret: '' })).status, 403);

  const noKey = voiceHarness({ env: { AGENT_VOICE_ENABLED: 'true', OPENAI_API_KEY: '' } });
  assert.equal((await noKey.register(CALLER)).body, 'office');
  assert.ok(noKey.logs.some((l) => /OPENAI_API_KEY is not set/.test(l)));
});

test('opted-out callers and a Supabase outage ring the office', async () => {
  const opted = voiceHarness({ suppressed: [CALLER] });
  assert.equal((await opted.register()).body, 'office');
  assert.ok(opted.logs.some((l) => /opted out/.test(l)));
  const down = voiceHarness({ supabaseDown: true });
  assert.equal((await down.register()).body, 'office');
  assert.ok(down.logs.some((l) => /Supabase is unreachable/.test(l)));
});

test('AudioSocket: an unknown or missing call id is hung up', async () => {
  const h = voiceHarness();
  const s1 = new FakeSocket();
  h.agent.audiosocket(s1);
  s1.asterisk(KIND.UUID, uuidBytes(UUIDS[0]));
  assert.ok(s1.hungUp());
  assert.equal(FakeWS.all.length, 0);
  assert.ok(h.logs.some((l) => /without a known call id/.test(l)));

  const s2 = new FakeSocket();
  h.agent.audiosocket(s2);
  await h.timers.advance(5000);
  assert.ok(s2.destroyed, 'nothing within 5 s');

  // A UUID is good for one connection.
  await h.register();
  const s3 = new FakeSocket();
  h.agent.audiosocket(s3);
  s3.asterisk(KIND.UUID, uuidBytes(UUIDS[0]));
  const s4 = new FakeSocket();
  h.agent.audiosocket(s4);
  s4.asterisk(KIND.UUID, uuidBytes(UUIDS[0]));
  assert.ok(!s3.hungUp());
  assert.ok(s4.hungUp());
});

// ---- one call

test('a call from start to finish: session, audio both ways, transcript, take_message, end_call, hand-over to n8n', async () => {
  const h = voiceHarness({ contacts: [{ id: 'c1', mobile: CALLER, first_name: 'Thandi', stream: 'buyer' }] });
  const { id, socket, ws } = await h.connect();
  assert.equal(ws.url, 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1');
  assert.equal(ws.opts.headers.Authorization, 'Bearer sk-test');

  const [update, greet] = ws.sent;
  assert.equal(update.type, 'session.update');
  const s = update.session;
  assert.equal(s.model, 'gpt-realtime-2.1');
  assert.deepEqual(s.audio.input.format, { type: 'audio/pcmu' });
  assert.deepEqual(s.audio.output, { format: { type: 'audio/pcmu' }, voice: 'marin' });
  assert.equal(s.audio.input.turn_detection.type, 'server_vad');
  assert.match(s.audio.input.transcription.prompt, /South African English or Afrikaans/);
  assert.deepEqual(s.tools.map((t) => t.name), ['take_message', 'end_call']);
  assert.ok(s.instructions.startsWith(voicePrompt()), 'the voice prompt comes first');
  assert.match(s.instructions, /# This call\n\nYou are on a live phone call now/);
  assert.match(s.instructions, /Caller ID: \+27821234567\./);
  assert.match(s.instructions, /We have no WhatsApp number yet/);
  assert.match(s.instructions, /first_name: Thandi/);
  assert.match(s.instructions, /LIVE LISTINGS/);
  assert.ok(!h.calls.sb.some((p) => p.startsWith('deals') || p.startsWith('documents')), 'no purchase details on the phone');
  assert.deepEqual(greet, { type: 'response.create' }, 'the agent greets first');

  // Caller audio: 20 ms of 8 kHz PCM becomes 160 bytes of mu-law.
  socket.asterisk(KIND.AUDIO, Buffer.alloc(320));
  const append = ws.sent.at(-1);
  assert.equal(append.type, 'input_audio_buffer.append');
  assert.equal(Buffer.from(append.audio, 'base64').length, 160);

  // Agent audio is played in real time, 20 ms per frame.
  ws.server({ type: 'response.created' });
  ws.server({ type: 'response.output_item.added', item: { id: 'a1', type: 'message' } });
  ws.server({ type: 'response.output_audio.delta', item_id: 'a1', delta: ulaw(800) });
  assert.equal(socket.audioOut().length, 1, 'the first frame goes at once');
  assert.equal(socket.audioOut()[0][1].length, 320);
  await h.timers.advance(40);
  assert.equal(socket.audioOut().length, 3);
  await h.timers.advance(1000);
  assert.equal(socket.audioOut().length, 5, 'and stops when the audio runs out');

  // Transcripts arrive out of order; turns keep the order of the conversation.
  ws.server({ type: 'response.output_audio_transcript.done', item_id: 'a1', transcript: "Hi, you've reached Harbour Key Properties. How can I help?" });
  ws.server({ type: 'response.done', response: { output: [] } });
  ws.server({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  ws.server({ type: 'response.output_item.added', item: { id: 'a2', type: 'message' } });
  ws.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: "I'd like to view The Quay on Saturday morning." });
  ws.server({ type: 'response.output_audio_transcript.done', item_id: 'a2', transcript: "Lovely. I'll take a message so someone phones you to confirm." });
  const before = ws.sent.length;
  ws.server({ type: 'response.done', response: { output: [{ type: 'function_call', name: 'take_message', call_id: 'fc1',
    arguments: JSON.stringify({ reason: 'wants to view The Quay', message: 'Viewing on Saturday morning', caller_name: 'Thandi', best_time: 'Saturday 9am', email: 'thandi@example.com', junk: 'x' }) }] } });
  assert.deepEqual(ws.sent.slice(before).map((e) => e.type), ['conversation.item.create', 'response.create']);
  assert.equal(ws.sent[before].item.type, 'function_call_output');
  assert.equal(ws.sent[before].item.call_id, 'fc1');

  // The goodbye plays out before the line is hung up.
  ws.server({ type: 'response.created' });
  ws.server({ type: 'response.output_item.added', item: { id: 'a3', type: 'message' } });
  ws.server({ type: 'response.output_audio.delta', item_id: 'a3', delta: ulaw(1600) });
  ws.server({ type: 'response.output_audio_transcript.done', item_id: 'a3', transcript: 'Thanks for calling Harbour Key Properties, goodbye.' });
  ws.server({ type: 'response.done', response: { output: [{ type: 'function_call', name: 'end_call', call_id: 'fc2', arguments: '{}' }] } });
  await h.timers.advance(100);
  assert.ok(!socket.hungUp(), 'waits for the goodbye to play');
  await h.timers.advance(200);
  assert.ok(socket.hungUp());
  assert.equal(socket.audioOut().length, 5 + 10);
  assert.equal((await h.after(id)).body, 'done', 'the dialplan hangs up');

  // The transcript of the last words arrives after the hang-up, and still counts.
  assert.equal(ws.readyState, 1);
  ws.server({ type: 'input_audio_buffer.committed', item_id: 'u9' });
  ws.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u9', transcript: 'Bye!' });
  ws.server({ type: 'response.output_audio.delta', item_id: 'a9', delta: ulaw(160) });
  assert.equal(h.calls.n8n.length, 0);
  await h.timers.advance(2000);
  assert.equal(ws.readyState, 3);
  assert.equal(socket.audioOut().length, 5 + 10, 'no audio after the hang-up');

  await h.agent.settle();
  assert.equal(h.calls.n8n.length, 1);
  const handed = h.calls.n8n[0];
  assert.equal(handed.headers['x-agent-voice-key'], 'internal-key');
  assert.equal(handed.body.call_id, id);
  assert.equal(handed.body.call_sid, '1761720000.42');
  assert.equal(handed.body.phone, CALLER);
  assert.equal(handed.body.ended_by, 'agent');
  assert.deepEqual(handed.body.turns.map((t) => t.role), ['agent', 'caller', 'agent', 'agent', 'caller']);
  assert.match(handed.body.turns[1].text, /view The Quay/);
  assert.deepEqual(handed.body.messages, [{ reason: 'wants to view The Quay', message: 'Viewing on Saturday morning', caller_name: 'Thandi', best_time: 'Saturday 9am', email: 'thandi@example.com' }]);
  assert.equal(h.agent.calls.size, 0);
  assert.equal(h.timers.q.filter((t) => t.at > 120000).length, 0, 'time-limit timers are cleared');
});

test('the caller talks over the agent: playback stops and OpenAI hears how much was played', async () => {
  const h = voiceHarness();
  const { socket, ws } = await h.connect();
  ws.server({ type: 'response.created' });
  ws.server({ type: 'response.output_audio.delta', item_id: 'a1', delta: ulaw(1600) });
  await h.timers.advance(40);
  ws.server({ type: 'input_audio_buffer.speech_started' });
  assert.deepEqual(ws.sent.at(-1), { type: 'conversation.item.truncate', item_id: 'a1', content_index: 0, audio_end_ms: 60 });
  await h.timers.advance(1000);
  assert.equal(socket.audioOut().length, 3);

  // The next answer plays normally.
  ws.server({ type: 'response.output_audio.delta', item_id: 'a2', delta: ulaw(320) });
  await h.timers.advance(100);
  assert.equal(socket.audioOut().length, 5);
});

test('a silent end_call gets a spoken goodbye before the line is hung up', async () => {
  const h = voiceHarness();
  const { socket, ws } = await h.connect();
  ws.server({ type: 'response.created' });
  ws.server({ type: 'response.done', response: { output: [{ type: 'function_call', name: 'end_call', call_id: 'fc1', arguments: '{}' }] } });
  assert.ok(!socket.hungUp(), 'not cut off');
  const [output, ask] = ws.sent.slice(-2);
  assert.equal(output.item.type, 'function_call_output');
  assert.equal(output.item.call_id, 'fc1');
  assert.deepEqual(ask.response.tool_choice, 'none');
  assert.match(ask.response.instructions, /Thanks for calling Harbour Key Properties, goodbye/);

  ws.server({ type: 'response.created' });
  ws.server({ type: 'response.output_audio.delta', item_id: 'a2', delta: ulaw(320) });
  ws.server({ type: 'response.done', response: { output: [] } });
  assert.ok(!socket.hungUp(), 'the goodbye plays first');
  await h.timers.advance(40);
  assert.ok(socket.hungUp());
  assert.equal(socket.audioOut().length, 2);
  await h.timers.advance(2000);
  await h.agent.settle();
  assert.equal(h.calls.n8n[0].body.ended_by, 'agent');

  // Asked once: a second silent end_call hangs up.
  const again = voiceHarness();
  const c = await again.connect();
  for (let i = 0; i < 2; i++) {
    c.ws.server({ type: 'response.created' });
    c.ws.server({ type: 'response.done', response: { output: [{ type: 'function_call', name: 'end_call', call_id: `fc${i}`, arguments: '{}' }] } });
  }
  assert.ok(c.socket.hungUp());
});

test('send_whatsapp: noted for after the call, or refused for a number WhatsApp cannot reach', async () => {
  const env = { AGENT_VOICE_ENABLED: 'true', AGENT_WA_NUMBER: '+27870000000', AGENT_WA_CALL_TEMPLATE: 'call_follow_up' };
  const ask = (ws) => {
    ws.server({ type: 'response.created' });
    ws.server({ type: 'response.done', response: { output: [{ type: 'function_call', name: 'send_whatsapp', call_id: 'fw1', arguments: JSON.stringify({ about: 'details of Kingsmead Heights' }) }] } });
    return JSON.parse(ws.sent.find((e) => e.item && e.item.call_id === 'fw1').item.output);
  };
  const h = voiceHarness({ env });
  const { socket, ws } = await h.connect();
  assert.ok(ws.sent[0].session.tools.some((t) => t.name === 'send_whatsapp'));
  assert.equal(ask(ws).ok, true);
  socket.asterisk(KIND.HANGUP);
  await h.timers.advance(2000);
  await h.agent.settle();
  assert.deepEqual(h.calls.n8n[0].body.whatsapp_requests, ['details of Kingsmead Heights']);

  const land = voiceHarness({ env });
  const c = await land.connect('0417001234');
  const out = ask(c.ws);
  assert.equal(out.ok, false);
  assert.match(out.note, /send us a WhatsApp on our number/);
  c.socket.asterisk(KIND.HANGUP);
  await land.timers.advance(2000);
  await land.agent.settle();
  assert.deepEqual(land.calls.n8n[0].body.whatsapp_requests, []);
});

test('the caller hanging up ends the call', async () => {
  const h = voiceHarness();
  const { socket, ws } = await h.connect();
  ws.server({ type: 'response.output_audio.delta', item_id: 'a1', delta: ulaw(1600) });
  socket.asterisk(KIND.HANGUP);
  await h.timers.advance(2000);
  assert.equal(ws.readyState, 3);
  assert.equal(socket.audioOut().length, 1);
  await h.agent.settle();
  assert.equal(h.calls.n8n[0].body.ended_by, 'caller');
});

test('if OpenAI fails before the agent speaks, the dialplan sends the caller to the office', async () => {
  const h = voiceHarness();
  const { id, socket, ws } = await h.connect();
  ws.close();
  assert.ok(socket.hungUp());
  assert.equal((await h.after(id)).body, 'office');
  assert.equal((await h.after(id)).body, 'office', 'unknown calls go to the office too');
  assert.equal((await h.after(id, 'nope')).status, 403);
  await h.agent.settle();
  assert.equal(h.calls.n8n[0].body.ended_by, 'openai');
});

test('silence: the agent checks the caller is there, then says goodbye and hangs up', async () => {
  const h = voiceHarness();
  const { socket, ws } = await h.connect();
  ws.server({ type: 'response.created' });
  ws.server({ type: 'response.output_audio.delta', item_id: 'a1', delta: ulaw(160) });
  ws.server({ type: 'response.done', response: { output: [] } });
  await h.timers.advance(7999);
  assert.equal(ws.types().filter((t) => t === 'response.create').length, 1);
  await h.timers.advance(50);
  assert.match(ws.sent.at(-1).response.instructions, /check they are still there/);

  // The caller answering resets it.
  ws.server({ type: 'response.created' });
  ws.server({ type: 'input_audio_buffer.speech_started' });
  ws.server({ type: 'response.done', response: { output: [] } });
  await h.timers.advance(8000);
  assert.match(ws.sent.at(-1).response.instructions, /check they are still there/);
  ws.server({ type: 'response.created' });
  ws.server({ type: 'response.done', response: { output: [] } });
  await h.timers.advance(8000);
  assert.match(ws.sent.at(-1).response.instructions, /short goodbye/);
  ws.server({ type: 'response.created' });
  ws.server({ type: 'response.output_audio.delta', item_id: 'a9', delta: ulaw(320) });
  ws.server({ type: 'response.done', response: { output: [] } });
  await h.timers.advance(100);
  assert.ok(socket.hungUp());
  await h.timers.advance(2000);
  await h.agent.settle();
  assert.equal(h.calls.n8n[0].body.ended_by, 'silence');
});

test('the time limit wraps the call up, then hangs up; a restart hands over what we have', async () => {
  const h = voiceHarness();
  const { socket, ws } = await h.connect();
  ws.server({ type: 'response.created' });
  ws.server({ type: 'input_audio_buffer.committed', item_id: 'u1' });
  ws.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Tell me everything about every listing.' });
  await h.timers.advance(14 * 60000);
  assert.equal(ws.sent.at(-2).item.role, 'system');
  assert.match(ws.sent.at(-2).item.content[0].text, /Wrap up within a minute/);
  await h.timers.advance(60000);
  assert.ok(socket.hungUp());
  await h.timers.advance(2000);
  await h.agent.settle();
  assert.equal(h.calls.n8n[0].body.ended_by, 'time limit');

  const r = voiceHarness();
  await r.connect();
  await r.agent.shutdown();
  assert.equal(r.calls.n8n[0].body.ended_by, 'restart');
});

test('if n8n is down, the whole call is logged so it can be replayed', async () => {
  const h = voiceHarness({ n8nDown: true });
  const { id, socket } = await h.connect();
  socket.asterisk(KIND.HANGUP);
  await h.timers.advance(2000);
  await h.agent.settle();
  const line = h.logs.find((l) => l.includes('UNDELIVERED CALL'));
  assert.ok(line);
  assert.equal(JSON.parse(line.split('UNDELIVERED CALL ')[1]).call_id, id);
});

// ---- n8n: Lead Voice Calls, the Code nodes as built

const workflow = buildAll().find((w) => w.name === 'Lead Voice Calls');
const nodeCode = (name) => workflow.nodes.find((n) => n.name === name).parameters.jsCode;

function n8nHarness({ contacts = [], env: extra = {}, waFail = false } = {}) {
  const db = { contacts: contacts.slice(), events: [], suppression: [], patches: [] };
  const mail = [];
  const wa = [];
  // Meta's Graph API.
  const https = {
    request(url, opts, cb) {
      const req = new EventEmitter();
      const chunks = [];
      req.write = (c) => chunks.push(Buffer.from(c));
      req.setTimeout = () => {};
      req.end = () => {
        wa.push({ url, headers: opts.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
        const res = new EventEmitter();
        res.statusCode = waFail ? 400 : 200;
        res.headers = {};
        cb(res);
        res.emit('data', Buffer.from(JSON.stringify(waFail ? { error: { code: 131026, message: 'Message undeliverable' } }
          : { messaging_product: 'whatsapp', messages: [{ id: 'wamid.call1' }] })));
        res.emit('end');
      };
      return req;
    },
  };
  const http = async ({ method, url, body }) => {
    const path = url.split('/rest/v1/')[1];
    const table = path.split('?')[0];
    if (method === 'GET' && table === 'contacts') return db.contacts.filter((c) => path.includes(`mobile=eq.${encodeURIComponent(c.mobile)}`));
    if (method === 'GET' && table === 'listings') return listings;
    if (method === 'GET' && table === 'events') {
      const id = (path.match(/payload->>message_id=eq\.([^&]+)/) || [])[1];
      return id ? db.events.filter((e) => e.payload.message_id === decodeURIComponent(id)) : [];
    }
    if (method === 'GET') return [];
    if (method === 'POST' && table === 'contacts') { const row = { id: `c${db.contacts.length + 1}`, ...body }; db.contacts.push(row); return [row]; }
    if (method === 'POST' && table === 'events') { db.events.push(...body); return null; }
    if (method === 'POST' && table === 'suppression') { db.suppression.push(body); return null; }
    if (method === 'PATCH') { db.patches.push({ path, body }); return null; }
    return null;
  };
  const nodemailer = { createTransport: () => ({ sendMail: async (m) => { mail.push(m); return { messageId: `<out${mail.length}@x>` }; } }) };
  const env = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k', AGENT_FROM: 'Harbour Key <info@harbourkey.example>',
    AGENT_ESCALATION_EMAIL: 'principal@harbourkey.example', AGENT_OWN_ADDRESSES: 'info@harbourkey.example', AGENT_VOICE_INTERNAL_KEY: 'internal-key', ...extra };
  const req = (name) => ({ nodemailer, crypto, https, fs: {} })[name];
  const run = (name, $input, $ = () => ({ all: () => [] })) =>
    new Function('$input', '$env', '$', 'require', `return (async function () {\n${nodeCode(name)}\n})`)($input, env, $, req)
      .call({ helpers: { httpRequest: http } });
  // The workflow: webhook item -> Prepare -> Claude Haiku (faked) -> Decide and act.
  async function callEnded(call, claudeResult, headers = { 'x-agent-voice-key': 'internal-key' }) {
    const prepared = await run('Prepare', { all: () => [{ json: { headers, body: call } }] });
    if (!prepared.length) return { prepared, acted: [] };
    const response = claudeResult.error ? claudeResult
      : { content: [{ type: 'text', text: JSON.stringify(claudeResult) }], usage: { input_tokens: 1, output_tokens: 1 } };
    const responses = prepared.map(() => ({ json: response }));
    const acted = await run('Decide and act', { all: () => responses }, (n) => ({ all: () => (n === 'Prepare' ? prepared : []) }));
    return { prepared, acted };
  }
  return { db, mail, wa, callEnded };
}

const triage = (over = {}) => ({
  category: 'buyer', language: 'en', confidence: 'high', summary: 'Thandi wants to view The Quay on Saturday', missing_info: [], attach: [],
  escalate: { needed: true, reason: 'viewing to confirm' }, reply: { subject: '', body: 'Told her someone will phone to confirm a Saturday viewing.' },
  extracted: { first_name: 'Thandi', last_name: null, email: null, phone: null, listing_of_interest: 'The Quay' }, ...over,
});
const finished = (over = {}) => ({
  call_id: 'rtc_1', call_sid: 'CA1', phone: CALLER, started_at: '2026-10-16T08:00:00.000Z', ended_at: '2026-10-16T08:02:05.000Z',
  duration_seconds: 125, ended_by: 'agent', errors: [],
  turns: [
    { role: 'agent', text: "Hi, you've reached Harbour Key Properties. How can I help?" },
    { role: 'caller', text: "I'd like to view The Quay on Saturday morning." },
    { role: 'agent', text: 'The Quay in Riverbend is R990 000. I\'ll take a message so someone phones you to confirm.' },
  ],
  messages: [{ reason: 'wants to view The Quay', message: 'Viewing on Saturday morning.', caller_name: 'Thandi', best_time: 'Saturday 9am' }],
  ...over,
});

test('Lead Voice Calls: a call that needs a person is emailed to staff with the transcript', async () => {
  const h = n8nHarness();
  const { prepared, acted } = await h.callEnded(finished(), triage());
  const user = prepared[0].json.request.messages[0].content;
  assert.match(user, /Triage the phone call below\. Nothing you write is sent to the caller\./);
  assert.match(user, /<call>\nFrom: Thandi \(caller ID \+27821234567\)\nDuration: 2 min 5 s\n\nAgent: Hi, you've reached/);
  assert.match(user, /Caller: I'd like to view The Quay on Saturday morning\./);
  assert.match(user, /\[The agent took a message: wants to view The Quay\. Viewing on Saturday morning\. best time: Saturday 9am\]\n<\/call>/);

  assert.equal(acted[0].json.action, 'escalate');
  assert.equal(h.mail.length, 1);
  const m = h.mail[0];
  assert.equal(m.to, 'principal@harbourkey.example');
  assert.equal(m.subject, '[Lead agent] Needs you: took a message: wants to view The Quay; viewing to confirm (call +27821234567)');
  assert.match(m.text, /Call from: Thandi on \+27821234567, Friday 16 October 2026, 10:00, 2 min 5 s/);
  assert.match(m.text, /Phone them back on \+27821234567/);
  assert.match(m.text, /Message taken: wants to view The Quay\. Viewing on Saturday morning\. best time: Saturday 9am/);
  assert.match(m.text, /---------- Call transcript ----------\nAgent: Hi, you've reached Harbour Key Properties\. How can I help\?\nCaller: I'd like/);
  assert.match(m.text, /---------- AI note ----------\nTold her someone will phone/);

  assert.equal(h.db.contacts.length, 1);
  assert.equal(h.db.contacts[0].mobile, CALLER);
  assert.deepEqual(h.db.contacts[0].tags, ['source:voice']);
  assert.deepEqual(h.db.events.map((e) => [e.event_type, e.channel, e.contact_id]),
    [['call_inbound', 'voice', 'c1'], ['ai_triage', 'voice', 'c1'], ['escalation_sent', 'voice', 'c1']]);
  const call = h.db.events[0].payload;
  assert.equal(call.message_id, 'rtc_1');
  assert.equal(call.duration_seconds, 125);
  assert.match(call.text, /^Agent: Hi/);
  assert.equal(h.db.events[1].payload.channel, 'voice');
  assert.equal(h.db.events[1].payload.summary, 'Thandi wants to view The Quay on Saturday');
});

test('Lead Voice Calls: a fully answered call is only logged; the same call is never handled twice', async () => {
  const h = n8nHarness({ contacts: [{ id: 'c7', mobile: CALLER, first_name: 'Thandi', tags: ['source:whatsapp'] }] });
  const call = finished({ messages: [], turns: [{ role: 'caller', text: 'What is the levy at The Quay?' }, { role: 'agent', text: 'It has no levy listed.' }] });
  const { acted } = await h.callEnded(call, triage({ escalate: { needed: false, reason: '' } }));
  assert.equal(acted[0].json.action, 'logged');
  assert.equal(h.mail.length, 0);
  assert.deepEqual(h.db.events.map((e) => e.event_type), ['call_inbound', 'ai_triage']);
  assert.ok(h.db.patches.some((p) => p.path === 'contacts?id=eq.c7' && p.body.tags.includes('source:voice')));

  const again = await h.callEnded(call, triage());
  assert.equal(again.prepared.length, 0);
  assert.equal(h.db.events.length, 2);
});

test('Lead Voice Calls: silence is logged without triage; posts without the key are ignored', async () => {
  const h = n8nHarness();
  const silent = await h.callEnded(finished({ call_id: 'rtc_s', messages: [], turns: [{ role: 'agent', text: 'Hello?' }] }), triage());
  assert.equal(silent.prepared.length, 0);
  assert.deepEqual(h.db.events.map((e) => e.event_type), ['call_inbound']);

  const forged = await h.callEnded(finished({ call_id: 'rtc_f' }), triage(), { 'x-agent-voice-key': 'wrong' });
  assert.equal(forged.prepared.length, 0);
  assert.equal(h.db.events.length, 1);
});

test('Lead Voice Calls: opt-outs, things the agent should not have said, and failed triage', async () => {
  const opt = n8nHarness();
  await opt.callEnded(finished({ messages: [] }), triage({ category: 'opt_out', escalate: { needed: false, reason: '' } }));
  assert.deepEqual(opt.db.suppression, [{ contact: CALLER, contact_type: 'phone', reason: 'opt-out on a phone call', source: 'voice-agent', actor: 'ai' }]);
  assert.equal(opt.mail.length, 0);
  assert.ok(opt.db.events.some((e) => e.event_type === 'opt_out'));

  const slip = n8nHarness();
  const turns = [{ role: 'caller', text: 'What would my repayments be?' }, { role: 'agent', text: 'Prime is about 10.5 percent, so repayments of around R9 500.' }];
  const { acted } = await slip.callEnded(finished({ messages: [], turns }), triage({ category: 'bond', escalate: { needed: false, reason: '' } }));
  assert.equal(acted[0].json.action, 'escalate');
  assert.deepEqual(acted[0].json.issues, ['mentions repayments', 'mentions interest or bond rates', 'contains a percentage', 'unverified amount R9500']);
  assert.match(slip.mail[0].text, /check it with the caller: mentions repayments; mentions interest or bond rates/);

  const broken = n8nHarness();
  const out = await broken.callEnded(finished(), { error: { type: 'overloaded_error', message: 'Overloaded' } });
  assert.equal(out.acted[0].json.action, 'escalate');
  assert.equal(broken.mail.length, 1);
  assert.match(broken.mail[0].text, /---------- Call transcript ----------/);
});

const WA_ENV = { AGENT_WA_CALL_TEMPLATE: 'call_follow_up', AGENT_WA_AUTO_SEND: 'true', AGENT_WA_TOKEN: 'tok', AGENT_WA_PHONE_NUMBER_ID: '100000000000001' };
const DETAILS = 'Kingsmead Heights in Seaview is a freehold two-bedroom, one-bathroom plot-and-plan house for R820 000 (VAT inclusive, no transfer duty), with a R260/month HOA levy.';
const asked = (over = {}) => finished({ messages: [], whatsapp_requests: ['details of Kingsmead Heights'], ...over });
const answered = (over = {}) => triage({ escalate: { needed: false, reason: '' }, reply: { subject: '', body: 'Sent the details on WhatsApp.', whatsapp: DETAILS }, ...over });

test('Lead Voice Calls: the WhatsApp a caller asked for goes out as the approved template', async () => {
  const h = n8nHarness({ env: WA_ENV });
  const { prepared, acted } = await h.callEnded(asked(), answered());
  assert.match(prepared[0].json.request.messages[0].content, /\[The caller asked us to WhatsApp them: details of Kingsmead Heights\]\n<\/call>/);
  assert.equal(acted[0].json.action, 'logged');
  assert.equal(h.mail.length, 0);
  assert.equal(h.wa.length, 1);
  assert.equal(h.wa[0].url, 'https://graph.facebook.com/v25.0/100000000000001/messages');
  assert.equal(h.wa[0].headers.Authorization, 'Bearer tok');
  assert.deepEqual(h.wa[0].body, { messaging_product: 'whatsapp', recipient_type: 'individual', to: '27821234567', type: 'template',
    template: { name: 'call_follow_up', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Thandi' }, { type: 'text', text: DETAILS }] }] } });
  const out = h.db.events.find((e) => e.event_type === 'whatsapp_outbound');
  assert.equal(out.channel, 'whatsapp');
  assert.equal(out.payload.wa_id, CALLER);
  assert.equal(out.payload.text, `Hi Thandi, thanks for calling Harbour Key Properties. Here are the details you asked for: ${DETAILS} If you have any questions, just reply here.`);
  assert.equal(h.db.events.find((e) => e.event_type === 'ai_triage').payload.whatsapp.sent, true);
});

test('Lead Voice Calls: a WhatsApp that cannot go out is emailed to staff with the draft', async () => {
  const off = n8nHarness();
  const a = await off.callEnded(asked(), answered());
  assert.equal(a.acted[0].json.action, 'escalate');
  assert.equal(off.wa.length, 0);
  assert.match(off.mail[0].subject, /they asked for a WhatsApp, which was not sent/);
  assert.match(off.mail[0].text, /NOT sent: no WhatsApp template is set up \(AGENT_WA_CALL_TEMPLATE\)\. Please get it to them another way\.\nDraft: Kingsmead Heights/);

  const wrong = n8nHarness({ env: WA_ENV });
  await wrong.callEnded(asked(), answered({ reply: { subject: '', body: 'x', whatsapp: 'Kingsmead Heights is R790 000. See https://evil.example' } }));
  assert.equal(wrong.wa.length, 0);
  assert.match(wrong.mail[0].text, /NOT sent: it failed the checks: unverified amount R790000; contains a link or email address/);

  const landline = n8nHarness({ env: WA_ENV });
  await landline.callEnded(asked({ phone: '+27417001234' }), answered());
  assert.match(landline.mail[0].text, /NOT sent: their number is withheld or not a mobile/);

  const meta = n8nHarness({ env: WA_ENV, waFail: true });
  const m = await meta.callEnded(asked(), answered({ escalate: { needed: true, reason: 'brochure to send' } }));
  assert.equal(m.acted[0].json.action, 'escalate');
  assert.match(meta.mail[0].subject, /brochure to send; WhatsApp not sent/);
  assert.match(meta.mail[0].text, /NOT sent: WhatsApp send failed \(400\): 131026: Message undeliverable/);

  // Opt-outs and spam are never WhatsApped, and staff aren't told.
  const opt = n8nHarness({ env: WA_ENV });
  await opt.callEnded(asked(), answered({ category: 'opt_out' }));
  assert.equal(opt.wa.length, 0);
  assert.equal(opt.mail.length, 0);
});

// ---- shared helpers

test('trunk numbers, voiceRoute and history', () => {
  assert.equal(lib.trunkCaller('0821234567'), CALLER);
  assert.equal(lib.trunkCaller('27821234567'), CALLER);
  assert.equal(lib.trunkCaller('0027821234567'), CALLER);
  assert.equal(lib.trunkCaller('+27821234567'), CALLER);
  assert.equal(lib.trunkCaller('anonymous'), null);
  assert.equal(lib.trunkCaller(''), null);
  assert.equal(lib.trunkDialString('+27000000000'), '0000000000');
  assert.equal(lib.trunkDialString('+447700900123'), '00447700900123');
  const v = lib.voiceConfig({ OPENAI_API_KEY: 'sk' });
  assert.equal(v.officeNumber, '+27000000000');
  assert.equal(lib.voiceRoute(v, CALLER), 'office');
  assert.equal(lib.voiceRoute({ ...v, enabled: true }, null), 'agent');
  assert.equal(lib.voiceRoute({ ...v, enabled: true, hasKey: false }, CALLER), 'office');
  const hist = lib.historyBlock([{ event_type: 'call_inbound', direction: 'inbound', created_at: '2026-10-16T08:00:00Z', payload: { text: 'Caller: hi' } }]);
  assert.equal(hist, '[2026-10-16 08:00] Phone call with our AI assistant: Caller: hi');
});

test('send_whatsapp is offered only once the template is set; WhatsApp reaches SA mobiles and foreign numbers', () => {
  const tools = (env) => lib.voiceSession(lib.voiceConfig(env), 'x').tools.map((t) => t.name);
  assert.deepEqual(tools({ AGENT_WA_NUMBER: '+27870000000' }), ['take_message', 'end_call']);
  assert.deepEqual(tools({ AGENT_WA_NUMBER: '+27870000000', AGENT_WA_CALL_TEMPLATE: 'call_follow_up' }), ['take_message', 'end_call', 'send_whatsapp']);
  assert.deepEqual(tools({ AGENT_WA_CALL_TEMPLATE: 'call_follow_up' }), ['take_message', 'end_call']);
  for (const p of ['+27821234567', '+27612345678', '+27731234567', '+447700900123']) assert.ok(lib.waReachable(p), p);
  for (const p of ['+27417001234', '+27870000000', '+27861234567', null, '']) assert.ok(!lib.waReachable(p), String(p));
  assert.equal(lib.callWaTemplate('t', '', 'A\n\nB   C').text, 'Hi there, thanks for calling Harbour Key Properties. Here are the details you asked for: A B C If you have any questions, just reply here.');
});

test('the WhatsApp number is given to callers once it is set', () => {
  const ins = lib.voiceInstructions({ systemPrompt: 'P', contact: null, events: [], listings: [], phone: CALLER, whatsapp: '0821112222' });
  assert.match(ins, /Our WhatsApp number is 0821112222/);
});

test('AudioSocket frames survive TCP splitting them up, and mu-law round-trips', () => {
  const r = new FrameReader();
  const bytes = Buffer.concat([frame(KIND.UUID, uuidBytes(UUIDS[0])), frame(KIND.AUDIO, Buffer.alloc(320, 1)), frame(KIND.HANGUP)]);
  const got = [...r.push(bytes.subarray(0, 10)), ...r.push(bytes.subarray(10, 25)), ...r.push(bytes.subarray(25))];
  assert.deepEqual(got.map(([k, p]) => [k, p.length]), [[KIND.UUID, 16], [KIND.AUDIO, 320], [KIND.HANGUP, 0]]);
  assert.equal(uuidString(got[0][1]), UUIDS[0]);

  const pcm = Buffer.alloc(16);
  [0, 100, -100, 1000, -1000, 8000, -8000, 32767].forEach((s, i) => pcm.writeInt16LE(s, i * 2));
  const u = slinToUlaw(pcm);
  assert.equal(u[0], 0xff, 'silence is 0xFF');
  const back = ulawToSlin(u);
  for (let i = 0; i < 8; i++) {
    const a = pcm.readInt16LE(i * 2);
    const b = back.readInt16LE(i * 2);
    assert.ok(Math.abs(a - b) <= Math.max(8, Math.abs(a) * 0.07), `${a} -> ${b}`);
  }
});

test('the dialplan is filled in from .env, and refuses a bad secret', () => {
  const template = readFileSync(new URL('../server/asterisk/extensions.conf', import.meta.url), 'utf8');
  const out = renderDialplan(template, ENV, lib);
  assert.match(out, new RegExp(`^AGENT_VOICE_SECRET=${SECRET}\\r?$`, 'm'));
  assert.match(out, /^AGENT_OFFICE=0410001111\r?$/m);
  assert.ok(!out.includes('@@'));
  assert.match(out, /AudioSocket\(\$\{AGENT_CALL\},\$\{AGENT_VOICE_AUDIOSOCKET\}\)/);
  assert.match(out, /Dial\(PJSIP\/\$\{AGENT_OFFICE\}@trunk,40\)/);
  assert.throws(() => renderDialplan(template, { ...ENV, AGENT_ASTERISK_SECRET: 'a;b' }, lib), /hex/);
  assert.throws(() => renderDialplan(template, { ...ENV, AGENT_ASTERISK_SECRET: '' }, lib), /hex/);
});
