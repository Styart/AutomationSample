// Node "Email quiet chats": each WhatsApp conversation, once it has gone quiet,
// emailed to staff (see waTranscriptsDue in lib.js).
const http = (o) => this.helpers.httpRequest(o);
const env = $env;
const cfg = configFromEnv(env);
const to = env.AGENT_WA_TRANSCRIPT_EMAIL || cfg.escalationEmail;
if (!to) throw new Error('Neither AGENT_WA_TRANSCRIPT_EMAIL nor AGENT_ESCALATION_EMAIL is set, so WhatsApp chats cannot be emailed.');
const since = encodeURIComponent(new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString());

const events = await sb(http, env, 'GET',
  `events?event_type=in.(whatsapp_inbound,whatsapp_outbound,ai_triage,whatsapp_skipped,whatsapp_failed)&payload->>wa_id=not.is.null` +
  `&created_at=gte.${since}&select=event_type,payload,created_at,contact_id&order=created_at.desc&limit=1000`);
const sent = await sb(http, env, 'GET',
  `events?event_type=eq.whatsapp_transcript&created_at=gte.${since}&select=payload`);

const out = [];
for (const chat of waTranscriptsDue(events, sent)) {
  const contactId = chat.events.map((e) => e.contact_id).filter(Boolean).pop();
  const contact = contactId
    ? ((await sb(http, env, 'GET', `contacts?id=eq.${contactId}&select=*&limit=1`)) || [])[0]
    : await findContactByPhone(http, env, chat.phone);
  const mail = waTranscriptEmail(chat.phone, chat.events, contact || null);
  await sendMail(env, { to, subject: mail.subject, text: mail.text, fromName: 'Lead agent', replyTo: (contact && contact.email) || undefined });
  await logEvents(http, env, [{ event_type: 'whatsapp_transcript', channel: 'whatsapp', direction: 'system', contact_id: contact ? contact.id : null,
    payload: { wa_id: chat.phone, until: mail.until, events: chat.events.length, to } }]);
  out.push({ json: { phone: chat.phone, events: chat.events.length } });
}
return out;
