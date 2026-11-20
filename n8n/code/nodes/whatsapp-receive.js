// Node "Receive": Meta's webhook for the WhatsApp number. Logs each customer
// message (answered after the wait, see "WhatsApp" in lib.js) and reports
// replies of ours that weren't delivered.
// Outputs one item per customer who wrote: { phone, last }.
const http = (o) => this.helpers.httpRequest(o);
const env = $env;
const cfg = configFromEnv(env);
if (!env.AGENT_WA_APP_SECRET || !env.AGENT_WA_PHONE_NUMBER_ID) throw new Error('AGENT_WA_APP_SECRET or AGENT_WA_PHONE_NUMBER_ID is not set, so WhatsApp webhooks cannot be checked. Set them in /opt/lead-agent/.env.');
const items = $input.all();
const out = [];

for (let i = 0; i < items.length; i++) {
  const headers = items[i].json.headers || {};
  // Meta signs the raw body (the webhook's "data" file) with the App Secret; anything else is not from them.
  let raw;
  try { raw = await this.helpers.getBinaryDataBuffer(i, 'data'); } catch (e) { continue; }
  if (!safeEqual(headers['x-hub-signature-256'], metaSignature(env.AGENT_WA_APP_SECRET, raw))) continue;
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch (e) { continue; }
  const wh = parseWhatsAppWebhook(body, env.AGENT_WA_PHONE_NUMBER_ID);

  const fresh = [];
  for (const m of wh.messages) if (!(await alreadySeen(http, env, m.id, 'whatsapp_inbound'))) fresh.push(m);
  if (fresh.length) await logEvents(http, env, fresh.map(waInboundEvent));
  for (const m of fresh) out.push({ json: { phone: m.phone, last: m.id } });

  // A reply of ours that didn't arrive: the customer is waiting.
  for (const f of wh.failed) {
    if (await alreadySeen(http, env, f.id, 'whatsapp_failed')) continue;
    const contact = await findContactByPhone(http, env, f.phone);
    await logEvents(http, env, [{ event_type: 'whatsapp_failed', channel: 'whatsapp', direction: 'system', contact_id: contact ? contact.id : null,
      payload: { message_id: f.id, wa_id: f.phone, error: f.error } }]);
    await sendMail(env, { to: cfg.escalationEmail, fromName: 'Lead agent',
      subject: `[Lead agent] WhatsApp message not delivered (${f.phone})`,
      text: `A WhatsApp message to ${f.phone} could not be delivered: ${f.error}\n\nPlease phone them, or email them if we have their address.` });
  }
}
return out;
