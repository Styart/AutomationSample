// Node "Forward enquiry": the website's contact form and chat widget post here.
// The enquiry is emailed to the office (Reply-To the customer) and the contact
// is created or enriched in the CRM, so the email agent knows them when they write.
const http = (o) => this.helpers.httpRequest(o);
const env = $env;
const STREAMS = ['buyer', 'tenant', 'seller_mandate', 'landlord_mandate', 'valuation', 'investor'];
const out = [];

for (const item of $input.all()) {
  const b = item.json.body || {};
  // Single line and length-capped: form fields end up in email headers and the CRM.
  const clean = (v, n) => String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').trim().slice(0, n);
  const email = clean(b.email, 200).toLowerCase();
  const message = String(b.message || '').trim().slice(0, 5000);
  const urlCount = (message.match(/https?:\/\//gi) || []).length;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || urlCount > 3) {
    out.push({ json: { ok: false, reason: 'rejected' } });
    continue;
  }
  const f = {
    first_name: clean(b.first_name, 80), last_name: clean(b.last_name, 80), mobile: clean(b.mobile, 40),
    stream: STREAMS.includes(b.stream) ? b.stream : 'general',
    consent: b.consent === true || b.consent === 'true',
    page: clean(b.page_url, 300), utm: [clean(b.utm_source, 60), clean(b.utm_campaign, 60)].filter(Boolean).join(' / '),
  };
  const streamLabel = f.stream.replace('_', ' ');

  const text = [
    `New enquiry from the website (${streamLabel})`,
    '',
    `Name: ${f.first_name} ${f.last_name}`.trim(),
    `Email: ${email}`,
    `Phone: ${f.mobile || 'not given'}`,
    `Consent to contact: ${f.consent ? 'yes' : 'no'}`,
    f.page ? `Page: ${f.page}` : '',
    f.utm ? `Campaign: ${f.utm}` : '',
    '',
    'Message:',
    message || '(no message)',
    '',
    'Reply to this email to answer them directly.',
  ].join('\n');
  await sendMail(env, {
    to: env.AGENT_FORM_NOTIFY_EMAIL, replyTo: email, fromName: 'Website',
    subject: `Website enquiry: ${f.first_name || email} (${streamLabel})`, text,
  });

  // CRM: create or enrich the contact, then log the enquiry.
  let contact = await findContactByEmail(http, env, email);
  const now = new Date().toISOString();
  const phone = normalizePhone(f.mobile);
  if (!contact) {
    contact = await createContact(http, env, {
      email, first_name: f.first_name || null, last_name: f.last_name || null, stream: f.stream,
      pipeline_stage: 'New Enquiry', tags: ['source:website'],
      consent_general_at: f.consent ? now : null,
    });
    if (phone) await patchContact(http, env, contact.id, { mobile: phone });
  } else {
    const patch = {};
    if (!contact.first_name && f.first_name) patch.first_name = f.first_name;
    if (!contact.last_name && f.last_name) patch.last_name = f.last_name;
    if ((!contact.stream || contact.stream === 'general') && f.stream !== 'general') patch.stream = f.stream;
    if (!contact.consent_general_at && f.consent) patch.consent_general_at = now;
    if (!contact.mobile && phone) patch.mobile = phone;
    await patchContact(http, env, contact.id, patch);
  }
  await logEvents(http, env, [{ contact_id: contact.id, event_type: 'web_form', channel: 'web_form', direction: 'inbound',
    payload: { stream: f.stream, text: message, page_url: f.page, utm: f.utm, consent: f.consent } }]);
  out.push({ json: { ok: true, contact_id: contact.id } });
}
return out;
