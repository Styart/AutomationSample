// Harbour Key voice agent: answers calls to the VoIP number with OpenAI's
// Realtime model. See "Phone calls" in n8n/code/lib.js for the flow, and
// server/asterisk/extensions.conf for the dialplan.
//
//   POST /voice/asterisk/calls  dialplan, per call: a one-time UUID (agent) or "office"
//   POST /voice/asterisk/after  dialplan, once AudioSocket returns: "done", or "office"
//                               when the agent never got going
//   GET  /voice/health
//   AudioSocket (TCP)           the call's audio (8 kHz PCM), relayed to an OpenAI
//                               Realtime WebSocket as mu-law
//
// Both ports are published on 127.0.0.1 only: Asterisk runs on the same host.
// When a call ends, the transcript goes to the Lead Voice Calls workflow in n8n,
// which triages it with Haiku.
// Everything external (fetch, WebSocket, timers, clock) is passed in, so tests run offline.
import { KIND, FrameReader, frame, uuidString, slinToUlaw, ulawToSlin, ULAW_SILENCE } from './audiosocket.mjs';

const OPENAI_WS = 'wss://api.openai.com/v1/realtime';
const LISTINGS_TTL_MS = 5 * 60 * 1000;
// The dialplan connects AudioSocket right after it gets the UUID.
const PENDING_MS = 30 * 1000;
const OUTCOME_MS = 60 * 1000;
const FIRST_FRAME_MS = 5000;
// 20 ms of mu-law at 8 kHz. Asterisk plays audio the moment it arrives, so we pace it.
const FRAME_BYTES = 160;
const FRAME_MS = 20;
// If the goodbye never finishes playing, hang up anyway.
const HANGUP_FALLBACK_MS = 10000;
// After a hang-up, the transcripts of the last words are still on their way.
const TRANSCRIPT_GRACE_MS = 2000;
const TRANSCRIPT_EVENTS = new Set(['input_audio_buffer.committed', 'conversation.item.input_audio_transcription.completed',
  'response.output_item.added', 'response.output_audio_transcript.done', 'response.audio_transcript.done']);
const SILENCE_REPROMPT = 'The caller has gone quiet. Briefly check they are still there, in the language of the call.';
const SILENCE_GOODBYE = "The caller still isn't answering. Say a short goodbye and that they're welcome to call back.";
// These replace the session instructions for the one response, so they spell it out.
const GOODBYE = 'End the phone call politely. Say exactly, in English: "Thanks for calling Harbour Key Properties, goodbye."';

export function createVoiceAgent({
  env, lib, systemPrompt,
  fetch: fetchFn = globalThis.fetch,
  WebSocket: WS = globalThis.WebSocket,
  timers = globalThis,
  clock = () => performance.now(),
  now = () => new Date(),
  log = console,
  newId = () => crypto.randomUUID(),
  retryDelays = [2000, 10000, 30000],
}) {
  const vcfg = lib.voiceConfig(env);
  const n8nUrl = env.AGENT_VOICE_N8N_URL || 'http://n8n:5678/webhook/voice-call-ended';
  const pending = new Map(); // UUID -> the call, until AudioSocket connects
  const outcomes = new Map(); // UUID -> 'done' | 'office', for /voice/asterisk/after
  const calls = new Set();
  const background = new Set();
  let listingsCache = null;

  // io.js's Supabase helpers expect n8n's this.helpers.httpRequest.
  const http = async ({ method, url, headers, body }) => {
    const res = await fetchFn(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url.split('?')[0]} failed (${res.status}): ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };

  const reply = (status, body) => ({ status, headers: { 'Content-Type': 'text/plain' }, body });
  const form = (raw) => Object.fromEntries(new URLSearchParams(raw || ''));
  const fromAsterisk = (params) => !!env.AGENT_ASTERISK_SECRET && lib.safeEqual(params.secret, env.AGENT_ASTERISK_SECRET);

  function inBackground(promise) {
    const p = promise.catch((e) => log.error(`voice: ${e.stack || e.message}`)).finally(() => background.delete(p));
    background.add(p);
  }

  async function listings() {
    if (!listingsCache || now().getTime() - listingsCache.at > LISTINGS_TTL_MS) {
      listingsCache = { at: now().getTime(), rows: (await lib.liveListings(http, env)) || [] };
    }
    return listingsCache.rows;
  }

  // ---- the dialplan

  // Decides who takes the call. Anything that isn't a UUID rings the office.
  async function newCall(raw) {
    const params = form(raw);
    if (!fromAsterisk(params)) {
      log.warn('voice: /voice/asterisk/calls with a wrong secret (AGENT_ASTERISK_SECRET); the call rings the office');
      return reply(403, 'office');
    }
    const phone = lib.trunkCaller(params.from);
    const office = (why) => {
      log.info(`voice: call from ${phone || 'withheld'} rings the office (${why})`);
      return reply(200, 'office');
    };
    if (lib.voiceRoute(vcfg, phone) !== 'agent') return office(vcfg.hasKey ? 'agent is off' : 'OPENAI_API_KEY is not set');
    if (!env.AGENT_VOICE_INTERNAL_KEY) return office('AGENT_VOICE_INTERNAL_KEY is not set');

    let contact = null;
    let events = [];
    let stock = [];
    try {
      // People who opted out get a person, not the AI (as on WhatsApp).
      if (phone && (await lib.isSuppressed(http, env, phone, 'phone'))) return office('opted out');
      contact = phone ? await lib.findContactByPhone(http, env, phone) : null;
      events = contact ? (await lib.recentEvents(http, env, contact.id)) || [] : [];
      stock = await listings();
    } catch (e) {
      // Without the listings the agent would say we have no stock.
      log.error(`voice: Supabase lookup failed (${e.message})`);
      return office('Supabase is unreachable');
    }

    const whatsapp = vcfg.whatsappNumber ? lib.trunkDialString(vcfg.whatsappNumber) : null;
    const instructions = lib.voiceInstructions({ systemPrompt, contact, events, listings: stock, phone, whatsapp, now: now() });
    const id = newId();
    const timer = timers.setTimeout(() => pending.delete(id), PENDING_MS);
    pending.set(id, { phone, channel: String(params.channel || ''), instructions, timer });
    return reply(200, id);
  }

  function afterCall(raw) {
    const params = form(raw);
    if (!fromAsterisk(params)) return reply(403, 'office');
    const outcome = outcomes.get(params.call);
    outcomes.delete(params.call);
    // Unknown: AudioSocket never reached us, or we restarted mid-call.
    return reply(200, outcome || 'office');
  }

  function setOutcome(id, outcome) {
    outcomes.set(id, outcome);
    timers.setTimeout(() => outcomes.delete(id), OUTCOME_MS);
  }

  // ---- AudioSocket: one TCP connection per call. socket is a net.Socket.

  function audiosocket(socket) {
    const reader = new FrameReader();
    let call = null;
    let rejected = false;
    const first = timers.setTimeout(() => { if (!call) socket.destroy(); }, FIRST_FRAME_MS);
    socket.on('data', (chunk) => {
      if (rejected) return;
      for (const [kind, payload] of reader.push(chunk)) {
        if (call) { call.fromAsterisk(kind, payload); continue; }
        timers.clearTimeout(first);
        const id = kind === KIND.UUID && payload.length === 16 ? uuidString(payload) : null;
        const p = id && pending.get(id);
        if (!p) {
          log.warn('voice: AudioSocket connection without a known call id; hanging up');
          rejected = true;
          socket.end(frame(KIND.HANGUP));
          return;
        }
        pending.delete(id);
        timers.clearTimeout(p.timer);
        call = new CallSession({ id, socket, ...p });
        call.start();
      }
    });
    socket.on('error', (e) => { if (call) call.errors.push(`audiosocket: ${e.message}`); });
    socket.on('close', () => { timers.clearTimeout(first); if (call) call.callerGone(); });
  }

  // ---- one call

  class CallSession {
    constructor({ id, socket, phone, channel, instructions }) {
      Object.assign(this, { id, socket, phone, channel, instructions });
      this.startedAt = now();
      this.turns = [];
      this.messages = [];
      this.whatsappRequests = [];
      this.errors = [];
      this.endedBy = null;
      this.timers = [];
      this.closed = false;
      this.done = null;
      this.agentSpoke = false;
      this.responseSpoke = false;
      this.goodbyeAsked = false;
      // Playback: mu-law not yet played, and where each agent item starts in the stream.
      this.buf = Buffer.alloc(0);
      this.queued = 0;
      this.played = 0;
      this.itemStarts = new Map();
      this.playTimer = null;
      this.nextAt = 0;
      // Turn taking.
      this.awaiting = true;
      this.hangupRequested = false;
      this.hangupAfterResponse = false;
      this.strikes = 0;
      this.silenceTimer = null;
    }

    start() {
      calls.add(this);
      this.ws = new WS(`${OPENAI_WS}?model=${encodeURIComponent(vcfg.model)}`,
        { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } });
      this.ws.addEventListener('open', () => {
        this.send({ type: 'session.update', session: lib.voiceSession(vcfg, this.instructions) });
        // The instructions say how to greet; this makes the agent speak first.
        this.send({ type: 'response.create' });
      });
      this.ws.addEventListener('message', (m) => {
        try { this.onEvent(JSON.parse(m.data)); } catch (e) { this.errors.push(`event: ${e.message}`); }
      });
      this.ws.addEventListener('error', (e) => this.errors.push(`websocket: ${(e && e.message) || 'error'}`));
      // OpenAI went away: end the call (the dialplan sends it to the office if the agent never spoke).
      this.ws.addEventListener('close', () => (this.closed ? this.disconnect() : this.hangup('openai')));
      const minutes = vcfg.maxMinutes;
      this.timers.push(timers.setTimeout(() => this.wrapUp(), Math.max(1, minutes - 1) * 60000));
      this.timers.push(timers.setTimeout(() => this.hangup('time limit'), minutes * 60000));
    }

    send(event) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(event));
    }

    write(buf) {
      try { this.socket.write(buf); } catch (e) { this.errors.push(`audiosocket: ${e.message}`); }
    }

    // ---- the caller's side

    fromAsterisk(kind, payload) {
      if (kind === KIND.AUDIO) {
        this.send({ type: 'input_audio_buffer.append', audio: slinToUlaw(payload).toString('base64') });
      } else if (kind === KIND.HANGUP) {
        this.callerGone();
      } else if (kind === KIND.ERROR) {
        this.errors.push(`asterisk error ${payload.toString('hex')}`);
        this.callerGone();
      }
      // DTMF is ignored.
    }

    callerGone() {
      if (this.closed) return;
      this.endedBy = this.endedBy || 'caller';
      this.close();
    }

    // ---- playback, paced in real time

    play(item, audio) {
      if (!this.itemStarts.has(item)) this.itemStarts.set(item, this.queued);
      this.buf = this.buf.length ? Buffer.concat([this.buf, audio]) : audio;
      this.queued += audio.length;
      if (!this.playTimer && !this.closed) {
        this.nextAt = clock();
        this.tick();
      }
    }

    tick() {
      this.playTimer = null;
      if (this.closed) return;
      if (!this.buf.length) { this.drained(); return; }
      const chunk = this.buf.subarray(0, FRAME_BYTES);
      this.buf = this.buf.subarray(chunk.length);
      const full = chunk.length === FRAME_BYTES ? chunk : Buffer.concat([chunk, Buffer.alloc(FRAME_BYTES - chunk.length, ULAW_SILENCE)]);
      this.write(frame(KIND.AUDIO, ulawToSlin(full)));
      this.played += chunk.length;
      this.nextAt += FRAME_MS;
      this.playTimer = timers.setTimeout(() => this.tick(), Math.max(0, this.nextAt - clock()));
    }

    stopPlayback() {
      if (this.playTimer) timers.clearTimeout(this.playTimer);
      this.playTimer = null;
      this.buf = Buffer.alloc(0);
      this.played = this.queued;
    }

    drained() {
      if (this.hangupRequested) this.hangup(this.endedBy || 'agent');
      else this.armSilence();
    }

    // The caller spoke over the agent: stop playing, and tell OpenAI how much they heard.
    bargeIn() {
      if (this.hangupRequested) { this.hangup(this.endedBy || 'agent'); return; }
      if (!this.buf.length) return;
      let item = null;
      let start = -1;
      for (const [id, s] of this.itemStarts) if (s <= this.played && s > start) { item = id; start = s; }
      const heardMs = Math.floor((this.played - start) / 8);
      this.stopPlayback();
      if (item) this.send({ type: 'conversation.item.truncate', item_id: item, content_index: 0, audio_end_ms: heardMs });
    }

    // ---- silence

    armSilence() {
      this.disarmSilence();
      if (this.closed || this.awaiting || this.hangupRequested || this.hangupAfterResponse || this.buf.length) return;
      this.silenceTimer = timers.setTimeout(() => this.onSilence(), vcfg.silenceSeconds * 1000);
    }

    disarmSilence() {
      if (this.silenceTimer) timers.clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }

    onSilence() {
      this.silenceTimer = null;
      this.strikes += 1;
      this.awaiting = true;
      if (this.strikes > 1) {
        this.hangupAfterResponse = true;
        this.endedBy = this.endedBy || 'silence';
      }
      this.send({ type: 'response.create', response: { instructions: this.strikes > 1 ? SILENCE_GOODBYE : SILENCE_REPROMPT } });
    }

    // ---- OpenAI's side

    // Turns keep the order the items were created in; transcripts fill in later.
    turn(role, id) {
      let t = this.turns.find((x) => x.id === id);
      if (!t) { t = { role, id, text: '' }; this.turns.push(t); }
      return t;
    }

    onEvent(ev) {
      if (this.closed && !TRANSCRIPT_EVENTS.has(ev.type)) return;
      switch (ev.type) {
        case 'response.output_audio.delta':
        case 'response.audio.delta':
          this.agentSpoke = true;
          this.responseSpoke = true;
          this.play(ev.item_id, Buffer.from(String(ev.delta || ''), 'base64'));
          break;
        case 'response.created':
          this.responseSpoke = false;
          this.awaiting = true;
          this.disarmSilence();
          break;
        case 'input_audio_buffer.speech_started':
          this.strikes = 0;
          this.awaiting = true;
          this.disarmSilence();
          this.bargeIn();
          break;
        case 'input_audio_buffer.committed':
          this.turn('caller', ev.item_id);
          break;
        case 'conversation.item.input_audio_transcription.completed':
          this.turn('caller', ev.item_id).text = String(ev.transcript || '');
          if (/\w/.test(ev.transcript || '')) this.strikes = 0;
          break;
        case 'response.output_item.added':
          if (ev.item && ev.item.type === 'message') this.turn('agent', ev.item.id);
          break;
        case 'response.output_audio_transcript.done':
        case 'response.audio_transcript.done':
          this.turn('agent', ev.item_id).text = String(ev.transcript || '');
          break;
        case 'response.done': {
          this.awaiting = false;
          const tools = ((ev.response && ev.response.output) || []).filter((item) => item.type === 'function_call');
          if (tools.length) this.onTools(tools);
          else if (this.hangupAfterResponse) this.requestHangup();
          else this.armSilence();
          break;
        }
        case 'error':
          this.errors.push(String((ev.error && ev.error.message) || 'error'));
          log.warn(`voice: call ${this.id}: ${(ev.error && ev.error.message) || 'error'}`);
          break;
        default:
      }
    }

    onTools(items) {
      let end = false;
      for (const item of items) {
        let args = {};
        try { args = JSON.parse(item.arguments || '{}') || {}; } catch (e) { args = {}; }
        let output;
        if (item.name === 'take_message') {
          const keep = {};
          for (const k of ['reason', 'message', 'caller_name', 'callback_number', 'best_time', 'email']) {
            if (typeof args[k] === 'string' && args[k].trim()) keep[k] = args[k].trim().slice(0, 500);
          }
          this.messages.push(keep);
          output = { ok: true, note: "Message taken. If you haven't already said so, tell the caller someone at the office will phone them back; don't repeat what you just said. Then ask if there is anything else." };
        } else if (item.name === 'send_whatsapp') {
          // n8n sends it after the call (callWhatsApp in lib.js).
          if (lib.waReachable(this.phone)) {
            this.whatsappRequests.push(String(args.about || 'what they asked for').trim().slice(0, 300));
            output = { ok: true, note: "Noted: it goes to them on WhatsApp just after the call. Tell them so, then ask if there's anything else." };
          } else {
            output = { ok: false, note: "We can't WhatsApp the number they're calling from. Ask them to send us a WhatsApp on our number instead, and we'll reply there." };
          }
        } else if (item.name === 'end_call') {
          end = true;
          // A silent end_call would cut the caller off: ask for the goodbye first (once).
          if (this.responseSpoke || this.goodbyeAsked) continue;
          output = { ok: true, note: 'Say goodbye now; the call ends after it.' };
        } else {
          output = { ok: false, error: `unknown tool ${item.name}` };
        }
        this.send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(output) } });
      }
      if (end && !this.responseSpoke && !this.goodbyeAsked) {
        this.endedBy = this.endedBy || 'agent';
        this.goodbyeAsked = true;
        this.hangupAfterResponse = true;
        this.awaiting = true;
        this.send({ type: 'response.create', response: { instructions: GOODBYE, tool_choice: 'none' } });
      } else if (end) {
        this.endedBy = this.endedBy || 'agent';
        this.requestHangup();
      } else {
        this.awaiting = true;
        this.send({ type: 'response.create' });
      }
    }

    // Hang up once the goodbye has played.
    requestHangup() {
      this.hangupRequested = true;
      this.disarmSilence();
      if (!this.buf.length) { this.hangup(this.endedBy || 'agent'); return; }
      this.timers.push(timers.setTimeout(() => this.hangup(this.endedBy || 'agent'), HANGUP_FALLBACK_MS));
    }

    wrapUp() {
      this.send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text',
        text: 'This call has gone on for a long time. Wrap up within a minute: offer to take a message for a call back, say goodbye, then call end_call.' }] } });
      this.send({ type: 'response.create' });
    }

    // We end the call: Asterisk carries on with the dialplan, which asks /voice/asterisk/after.
    hangup(by) {
      if (this.closed) return;
      this.endedBy = this.endedBy || by;
      setOutcome(this.id, this.agentSpoke ? 'done' : 'office');
      if (!this.agentSpoke) log.warn(`voice: call ${this.id} ended (${this.endedBy}) before the agent spoke; the office takes it`);
      try { this.socket.end(frame(KIND.HANGUP)); } catch (e) { /* already closed */ }
      this.close();
    }

    // Stops the call's audio at once. The WebSocket stays open a moment for the last
    // transcripts (unless now, on a restart), then the call is handed over.
    close({ now: immediately = false } = {}) {
      if (this.closed) return;
      this.closed = true;
      this.stopPlayback();
      this.disarmSilence();
      for (const t of this.timers) timers.clearTimeout(t);
      this.timers = [];
      if (immediately || !this.ws || this.ws.readyState !== 1) this.disconnect();
      else this.timers.push(timers.setTimeout(() => this.disconnect(), TRANSCRIPT_GRACE_MS));
    }

    disconnect() {
      for (const t of this.timers) timers.clearTimeout(t);
      try { if (this.ws && this.ws.readyState <= 1) this.ws.close(); } catch (e) { /* already closed */ }
      inBackground(this.finish());
    }

    // Once per call: hand the transcript to n8n.
    finish() {
      if (!this.done) {
        calls.delete(this);
        const ended = now();
        const record = {
          call_id: this.id,
          call_sid: this.channel || null,
          phone: this.phone,
          started_at: this.startedAt.toISOString(),
          ended_at: ended.toISOString(),
          duration_seconds: Math.round((ended - this.startedAt) / 1000),
          ended_by: this.endedBy || 'caller',
          turns: this.turns.filter((t) => t.text.trim()).map(({ role, text }) => ({ role, text })),
          messages: this.messages,
          whatsapp_requests: this.whatsappRequests,
          errors: this.errors.slice(0, 10),
        };
        this.done = deliver(record);
      }
      return this.done;
    }
  }

  // Posts the finished call to Lead Voice Calls. If n8n stays down, the call is
  // logged in full so it can be replayed.
  async function deliver(record) {
    let last = '';
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        const res = await fetchFn(n8nUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-agent-voice-key': env.AGENT_VOICE_INTERNAL_KEY || '' },
          body: JSON.stringify(record),
        });
        if (res.ok) return true;
        last = `HTTP ${res.status}`;
      } catch (e) {
        last = e.message;
      }
      if (attempt < retryDelays.length) await new Promise((r) => timers.setTimeout(r, retryDelays[attempt]));
    }
    log.error(`voice: could not hand call ${record.call_id} to n8n (${last}). UNDELIVERED CALL ${JSON.stringify(record)}`);
    return false;
  }

  async function handle({ method, path, body = '' }) {
    const route = String(path || '').split('?')[0];
    if (method === 'GET' && route === '/voice/health') return reply(200, 'ok');
    if (method !== 'POST') return reply(404, 'Not found');
    if (route === '/voice/asterisk/calls') return newCall(body);
    if (route === '/voice/asterisk/after') return afterCall(body);
    return reply(404, 'Not found');
  }

  // On restart (a deploy), hand over what we have of each call in progress.
  // The dialplan then can't reach us, so the caller goes to the office.
  async function shutdown() {
    for (const c of [...calls]) {
      c.endedBy = c.endedBy || 'restart';
      c.close({ now: true });
    }
    await settle();
  }

  async function settle() {
    while (background.size) await Promise.all([...background]);
  }

  return { handle, audiosocket, shutdown, settle, calls, pending, config: vcfg };
}
