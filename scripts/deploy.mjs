// Deploys the stack and workflows to a VPS over SSH.
//
//   AGENT_SSH_HOST=root@your-server node scripts/deploy.mjs              build, upload, (re)start, import + publish
//   AGENT_SSH_HOST=root@your-server node scripts/deploy.mjs --no-email   same, but leave the email agent unpublished
//
// Needs SSH access to the server and /opt/lead-agent/.env already in place
// (template: server/.env.example). Secrets never leave the server.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = process.env.AGENT_SSH_HOST;
if (!HOST) {
  console.error('Set AGENT_SSH_HOST, e.g. AGENT_SSH_HOST=root@203.0.113.10');
  process.exit(1);
}
const DIR = '/opt/lead-agent';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skipEmail = process.argv.includes('--no-email');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
const ssh = (script) => run('ssh', ['-o', 'BatchMode=yes', HOST, script]);
const sshOut = (script) => execFileSync('ssh', ['-o', 'BatchMode=yes', HOST, script], { cwd: root }).toString();

// 1. Build workflow JSON.
run('node', ['scripts/build.mjs']);
const { buildAll, IDS } = await import('./build.mjs');
const workflows = buildAll();

// 2. Upload compose files, workflows and the forms the agent can attach.
if (!sshOut(`test -f ${DIR}/.env && echo yes || echo no`).includes('yes')) {
  console.error(`${DIR}/.env is missing on the server. Create it from server/.env.example first.`);
  process.exit(1);
}
ssh(`mkdir -p ${DIR}/workflows ${DIR}/forms && rm -f ${DIR}/workflows/*.json`);
run('scp', ['-q', 'server/docker-compose.yml', 'server/Caddyfile', `${HOST}:${DIR}/`]);
run('scp', ['-q', ...workflows.map((w) => `n8n/dist/${w.id}.json`), `${HOST}:${DIR}/workflows/`]);
const formFiles = JSON.parse(readFileSync(join(root, 'forms/catalog.json'), 'utf8')).map((f) => `forms/${f.file}`);
const missing = formFiles.filter((f) => !existsSync(join(root, f)));
if (missing.length) {
  console.error(`Missing form files: ${missing.join(', ')}. Add them or remove them from forms/catalog.json.`);
  process.exit(1);
}
if (formFiles.length) {
  run('scp', ['-q', ...formFiles, `${HOST}:${DIR}/forms/`]);
  ssh(`chmod 755 ${DIR}/forms && chmod 644 ${DIR}/forms/*`);
}

// Voice agent (voice/, the "voice" service): its code plus the shared lib and prompts, in the repo layout.
const VOICE = `${DIR}/voice-app`;
// Overwritten in place: the running container has this folder mounted.
ssh(`mkdir -p ${VOICE}/voice ${VOICE}/n8n/code ${VOICE}/prompts ${VOICE}/server/asterisk`);
run('scp', ['-q', 'voice/agent.mjs', 'voice/audiosocket.mjs', 'voice/dialplan.mjs', 'voice/load.mjs', 'voice/server.mjs', `${HOST}:${VOICE}/voice/`]);
run('scp', ['-q', 'server/asterisk/extensions.conf', `${HOST}:${VOICE}/server/asterisk/`]);
run('scp', ['-q', 'n8n/code/lib.js', 'n8n/code/io.js', `${HOST}:${VOICE}/n8n/code/`]);
run('scp', ['-q', 'prompts/voice-agent.system.md', 'prompts/shared.md', `${HOST}:${VOICE}/prompts/`]);
ssh(`chmod -R a+rX ${VOICE}`);
// The key the voice service and n8n share (Lead Voice Calls only accepts calls carrying it),
// the secret the dialplan and the voice service share, and the token Meta checks the WhatsApp webhook with.
for (const key of ['AGENT_VOICE_INTERNAL_KEY', 'AGENT_ASTERISK_SECRET', 'AGENT_WA_VERIFY_TOKEN']) {
  ssh(`cd ${DIR} && sed -i '/^${key}=$/d' .env && ` +
    `(grep -q "^${key}=" .env || echo "${key}=$(openssl rand -hex 24)" >> .env)`);
}

// 3. Start or update the containers (restarting voice so it runs the new code) and wait for n8n.
ssh(`cd ${DIR} && chmod 600 .env && docker compose up -d --remove-orphans && docker compose restart voice && ` +
  'for i in $(seq 1 60); do curl -fs http://127.0.0.1:5678/healthz >/dev/null && break; sleep 2; done && echo n8n is up');

// 4. IMAP credential for the email trigger, built inside the container from env
//    so the mailbox password is never written to this machine or the repo.
const hasImap = sshOut(`cd ${DIR} && docker compose exec -T n8n sh -c 'test -n "$AGENT_IMAP_HOST" && test -n "$AGENT_IMAP_PASS" && echo yes || echo no'`).includes('yes');
if (hasImap) {
  const makeCred = `node -e 'const e=process.env; process.stdout.write(JSON.stringify([{id:"${IDS.imapCredential}",name:"Agent mailbox (IMAP)",type:"imap",data:{user:e.AGENT_IMAP_USER,password:e.AGENT_IMAP_PASS,host:e.AGENT_IMAP_HOST,port:Number(e.AGENT_IMAP_PORT||993),secure:true,allowUnauthorizedCerts:false}}]))' > /tmp/cred.json`;
  ssh(`cd ${DIR} && docker compose exec -T n8n sh -c '${makeCred.replace(/'/g, `'\\''`)} && n8n import:credentials --input=/tmp/cred.json; rc=$?; rm -f /tmp/cred.json; exit $rc'`);
} else {
  console.warn('AGENT_IMAP_HOST / AGENT_IMAP_PASS are not set in .env, so the email agent stays unpublished.');
}

// WhatsApp: published once the Meta app's token, secret and number are in .env.
const hasWhatsApp = sshOut(`cd ${DIR} && docker compose exec -T n8n sh -c 'test -n "$AGENT_WA_TOKEN" && test -n "$AGENT_WA_APP_SECRET" && test -n "$AGENT_WA_PHONE_NUMBER_ID" && echo yes || echo no'`).includes('yes');
if (!hasWhatsApp) console.warn('AGENT_WA_TOKEN / AGENT_WA_APP_SECRET / AGENT_WA_PHONE_NUMBER_ID are not set in .env, so the WhatsApp agent stays unpublished.');

// Asterisk's dialplan (server/asterisk/extensions.conf), filled in from .env inside the voice
// container. Replaced (with a dated backup of the old one) only when it changed.
ssh(`cd ${DIR} && docker compose exec -T voice node voice/dialplan.mjs > /tmp/agent-extensions.conf && ` +
  'if ! cmp -s /tmp/agent-extensions.conf /etc/asterisk/extensions.conf; then ' +
  'cp -p /etc/asterisk/extensions.conf /etc/asterisk/extensions.conf.bak-$(date +%Y%m%d%H%M%S) && ' +
  'install -o asterisk -g asterisk -m 640 /tmp/agent-extensions.conf /etc/asterisk/extensions.conf && ' +
  'asterisk -rx "dialplan reload" && echo "Asterisk dialplan updated"; fi; rm -f /tmp/agent-extensions.conf');

// Voice: Lead Voice Calls is always published (it only takes calls from the voice service);
// the voice service itself sends every call to the office until OpenAI is set up and it's switched on.
const voiceState = sshOut(`cd ${DIR} && docker compose exec -T voice sh -c 'test -n "$OPENAI_API_KEY" && echo "ready $AGENT_VOICE_ENABLED" || echo missing'`).trim();
if (voiceState === 'missing') console.warn('OPENAI_API_KEY is not set in .env, so every call rings the office.');
else console.log(`Voice agent: ${voiceState === 'ready true' ? 'ON, answering calls' : 'OFF, calls ring the office (test numbers reach the agent)'}.`);

// 5. Import workflows (import unpublishes them), publish, then restart so triggers register.
const publish = workflows
  .filter((w) => !(w.id === IDS.emailAgent && (skipEmail || !hasImap)))
  .filter((w) => !((w.id === IDS.whatsappAgent || w.id === IDS.whatsappTranscripts) && !hasWhatsApp))
  .map((w) => `n8n publish:workflow --id=${w.id}`).join(' && ');
ssh(`cd ${DIR} && docker compose exec -T -u root n8n rm -rf /tmp/wf && docker compose cp workflows/. n8n:/tmp/wf/ && ` +
  `docker compose exec -T n8n sh -c 'n8n import:workflow --separate --input=/tmp/wf && ${publish}' && ` +
  'docker compose exec -T -u root n8n rm -rf /tmp/wf && ' +
  'docker compose restart n8n && for i in $(seq 1 60); do curl -fs http://127.0.0.1:5678/healthz >/dev/null && break; sleep 2; done && ' +
  'docker compose exec -T n8n n8n list:workflow');
console.log('Deployed.');
