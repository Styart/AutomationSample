// Asterisk's AudioSocket protocol and G.711 mu-law, for agent.mjs.
// Each message is: 1-byte kind, 2-byte big-endian payload length, payload.
// Audio is 16-bit signed linear PCM, 8 kHz mono, little-endian; OpenAI gets mu-law.

export const KIND = { HANGUP: 0x00, UUID: 0x01, DTMF: 0x03, AUDIO: 0x10, ERROR: 0xff };

export function frame(kind, payload = Buffer.alloc(0)) {
  const head = Buffer.from([kind, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

// TCP delivers bytes, not messages: push() each chunk, get back the whole frames in it.
export class FrameReader {
  constructor() { this.buf = Buffer.alloc(0); }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 3) {
      const len = this.buf.readUInt16BE(1);
      if (this.buf.length < 3 + len) break;
      out.push([this.buf[0], this.buf.subarray(3, 3 + len)]);
      this.buf = this.buf.subarray(3 + len);
    }
    return out;
  }
}

// The 16-byte UUID AudioSocket sends first, as the dialplan's text form.
export function uuidString(bytes) {
  const h = Buffer.from(bytes).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---- G.711 mu-law, via lookup tables

export const ULAW_SILENCE = 0xff;
const BIAS = 0x84;
const CLIP = 32635;

function decode(u) {
  u = ~u & 0xff;
  const t = (((u & 0x0f) << 3) + BIAS) << ((u & 0x70) >> 4);
  return u & 0x80 ? BIAS - t : t - BIAS;
}

function encode(sample) {
  const sign = sample < 0 ? 0x80 : 0;
  const s = Math.min(Math.abs(sample), CLIP) + BIAS;
  const exponent = 31 - Math.clz32(s >> 7);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

const DECODE = Int16Array.from({ length: 256 }, (_, u) => decode(u));
// Indexed by the sample read as unsigned 16-bit.
const ENCODE = Uint8Array.from({ length: 65536 }, (_, s) => encode(s >= 32768 ? s - 65536 : s));

export function ulawToSlin(ulaw) {
  const out = Buffer.alloc(ulaw.length * 2);
  for (let i = 0; i < ulaw.length; i++) out.writeInt16LE(DECODE[ulaw[i]], i * 2);
  return out;
}

export function slinToUlaw(slin) {
  const n = slin.length >> 1;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = ENCODE[slin.readUInt16LE(i * 2)];
  return out;
}
