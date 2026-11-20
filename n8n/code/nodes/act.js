// Node "Decide and act": check the draft, then send, escalate, record the
// opt-out or drop the spam, and log everything to Supabase. See actOnInbound in io.js.
// Build injects FORMS above this snippet.
const http = (o) => this.helpers.httpRequest(o);
const env = $env;
const cfg = configFromEnv(env);
const prepared = $('Prepare').all();
const responses = $input.all();
const out = [];
const failures = [];

for (let i = 0; i < responses.length; i++) {
  const prep = prepared[i].json;
  try {
    out.push({ json: await actOnInbound(http, env, cfg, prep, responses[i].json, FORMS) });
  } catch (err) {
    failures.push(`${prep.msg.from}: ${err.message}`);
    out.push({ json: { from: prep.msg.from, subject: prep.msg.subject, action: 'failed', error: err.message } });
  }
}

// Fail the execution after handling every message, so the error workflow alerts us.
if (failures.length) throw new Error('Agent failed for: ' + failures.join(' | '));
return out;
