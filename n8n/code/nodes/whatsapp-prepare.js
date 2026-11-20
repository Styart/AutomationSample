// Node "Prepare" (WhatsApp): after the wait, gather everything this person sent
// that we haven't answered, and build the Claude request. Only the run for their
// newest message answers.
// Build injects SYSTEM_PROMPT, SCHEMA and FORMS above this snippet.
const http = (o) => this.helpers.httpRequest(o);
const env = $env;
const cfg = channelConfig(configFromEnv(env), 'whatsapp');
const prompts = { systemPrompt: SYSTEM_PROMPT, schema: SCHEMA, forms: FORMS };
const shared = {};
const out = [];
const done = new Set();

for (const item of $input.all()) {
  const { phone, last } = item.json;
  if (done.has(phone)) continue;
  done.add(phone);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const pending = waPending(await waInbound(http, env, phone, since), await waHandledIds(http, env, phone, since));
  // A later message arrived during the wait: its run answers everything.
  if (!waIsNewest(pending, last)) continue;
  const msg = normalizeWhatsApp(phone, pending);

  if (await isSuppressed(http, env, phone, 'phone')) {
    await logEvents(http, env, [{ event_type: 'whatsapp_skipped', channel: 'whatsapp', direction: 'system', contact_id: null,
      payload: { wa_id: phone, message_ids: msg.messageIds, reason: 'opted out' } }]);
    continue;
  }

  out.push({ json: await prepareInbound(http, env, cfg, msg, prompts, shared) });
}
return out;
