// Node "Prepare": normalise, filter, load context and build the Claude request.
// Build injects SYSTEM_PROMPT, SCHEMA and FORMS above this snippet.
const http = (o) => this.helpers.httpRequest(o);
const env = $env;
const cfg = configFromEnv(env);
const prompts = { systemPrompt: SYSTEM_PROMPT, schema: SCHEMA, forms: FORMS };
const shared = {};
const out = [];

for (const item of $input.all()) {
  const msg = normalizeImap(item.json);
  // Bounces, auto-replies, newsletters and our own mail stop here, before any model call.
  if (dropReason(msg, cfg)) continue;
  if (await alreadySeen(http, env, msg.messageId)) continue;
  if (await isSuppressed(http, env, msg.from)) continue;
  out.push({ json: await prepareInbound(http, env, cfg, msg, prompts, shared) });
}
return out;
