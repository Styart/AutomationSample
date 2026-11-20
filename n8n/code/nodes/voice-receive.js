// Node "Prepare" (phone calls): voice/ posts each finished call here (see
// "Phone calls" in lib.js). Checks it came from voice/, then builds the Claude request.
// Build injects SYSTEM_PROMPT, SCHEMA and FORMS above this snippet.
const http = (o) => this.helpers.httpRequest(o);
const env = $env;
const cfg = configFromEnv(env);
if (!env.AGENT_VOICE_INTERNAL_KEY) throw new Error('AGENT_VOICE_INTERNAL_KEY is not set, so calls from voice/ cannot be checked. Run npm run deploy, which creates it.');
const prompts = { systemPrompt: SYSTEM_PROMPT, schema: SCHEMA, forms: FORMS };
const shared = {};
const out = [];

for (const item of $input.all()) {
  const headers = item.json.headers || {};
  const call = item.json.body || {};
  if (!safeEqual(headers['x-agent-voice-key'], env.AGENT_VOICE_INTERNAL_KEY)) continue;
  if (!call.call_id || (await alreadySeen(http, env, call.call_id, 'call_inbound'))) continue;
  const prep = await prepareCall(http, env, cfg, call, prompts, shared);
  if (!prep.skip) out.push({ json: prep });
}
return out;
