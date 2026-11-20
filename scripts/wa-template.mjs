// Submits the call follow-up template (CALL_WA_TEMPLATE in lib.js) to Meta, or
// with "status" shows whether Meta has approved it. Runs curl on the server, so
// the token never leaves /opt/lead-agent/.env.
//   node scripts/wa-template.mjs          submit it
//   node scripts/wa-template.mjs status   check it
// Once it is APPROVED, set AGENT_WA_CALL_TEMPLATE=call_follow_up in the server .env and deploy.
import { execFileSync } from 'node:child_process';
import { loadLib } from './lib-loader.mjs';

const HOST = process.env.AGENT_SSH_HOST;
if (!HOST) {
  console.error('Set AGENT_SSH_HOST, e.g. AGENT_SSH_HOST=root@203.0.113.10');
  process.exit(1);
}
const t = loadLib().CALL_WA_TEMPLATE;
const graph = 'https://graph.facebook.com/v25.0/$AGENT_WA_WABA_ID/message_templates';
const ssh = (script, input) => execFileSync('ssh', ['-o', 'BatchMode=yes', HOST, script], { input }).toString();
const env = 'set -a && . /opt/lead-agent/.env && set +a';

if (process.argv[2] === 'status') {
  const out = JSON.parse(ssh(`${env} && curl -s -G "${graph}" --data-urlencode "name=${t.name}" ` +
    `--data-urlencode "fields=name,language,status,category,rejected_reason" -H "Authorization: Bearer $AGENT_WA_TOKEN"`));
  console.log(JSON.stringify(out.data || out, null, 2));
} else {
  const body = JSON.stringify({
    name: t.name,
    language: t.language,
    category: t.category,
    components: [{ type: 'BODY', text: t.body, example: { body_text: [t.example] } }],
  });
  console.log(ssh(`${env} && curl -s -X POST "${graph}" -H "Authorization: Bearer $AGENT_WA_TOKEN" -H "Content-Type: application/json" --data-binary @-`, body));
}
