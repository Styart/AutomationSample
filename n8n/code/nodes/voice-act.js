// Node "Decide and act" (phone calls): log the call and its triage, and email
// staff when someone must phone the caller back. See actOnCall in io.js.
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
    out.push({ json: await actOnCall(http, env, cfg, prep, responses[i].json) });
  } catch (err) {
    failures.push(`call ${prep.msg.messageId} from ${prep.msg.from}: ${err.message}`);
    out.push({ json: { from: prep.msg.from, call_id: prep.msg.messageId, action: 'failed', error: err.message } });
  }
}

// Fail the execution after handling every call, so the error workflow alerts us.
if (failures.length) throw new Error('Voice triage failed for: ' + failures.join(' | '));
return out;
