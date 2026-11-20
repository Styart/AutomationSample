// Node "Build and send digest": the last 24 hours of enquiries, escalations and opt-outs.
const http = (o) => this.helpers.httpRequest(o);
const env = $env;
const cfg = configFromEnv(env);
const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const rows = await sb(http, env, 'GET',
  `events?created_at=gte.${encodeURIComponent(since)}&event_type=in.(ai_triage,web_form)` +
  '&select=event_type,payload,created_at,contacts(first_name,last_name,email,mobile,stream,pipeline_stage)&order=created_at.asc');

const day = new Date().toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'long', day: 'numeric', month: 'long' });
const digest = digestEmail(rows, cfg, day);
await sendMail(env, { to: cfg.digestEmail, subject: digest.subject, text: digest.text, fromName: 'Lead agent' });
return [{ json: digest.counts }];
