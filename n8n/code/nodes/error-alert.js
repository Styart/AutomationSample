// Node "Send alert": an n8n workflow failed.
const env = $env;
const cfg = configFromEnv(env);
const d = $input.first().json;
const wf = (d.workflow && d.workflow.name) || 'unknown workflow';
const ex = d.execution || {};
const err = (ex.error && ex.error.message) || (d.trigger && d.trigger.error && d.trigger.error.message) || 'unknown error';
// A mailbox trigger lost its connection. n8n sends only this generic message and
// reconnects by itself within seconds, catching up from the last message id, so don't alert.
if (d.trigger && /^There was a problem with the trigger node/.test(err)) return [{ json: { alerted: false, reason: 'trigger reconnecting' } }];
const text = [
  `The n8n workflow "${wf}" failed.`,
  '',
  `Error: ${err}`,
  ex.lastNodeExecuted ? `Last node: ${ex.lastNodeExecuted}` : '',
  ex.url ? `Execution: ${ex.url}` : '',
  '',
  'Emails that failed are not retried automatically. Check the customer was answered.',
].filter(Boolean).join('\n');
await sendMail(env, { to: cfg.escalationEmail, subject: `[Lead agent] Workflow failed: ${wf}`, text, fromName: 'Lead agent' });
return [{ json: { alerted: true } }];
