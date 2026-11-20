// Builds the n8n workflow JSON files in n8n/dist/ from the sources in
// prompts/, forms/ and n8n/code/. Run: node scripts/build.mjs
//
// The workflows are generated, never edited in the n8n editor: the logic lives
// in plain files that are reviewed, diffed and tested like any other code.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { forms, systemPrompt, schema, loadLib } from './lib-loader.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

export const IDS = {
  emailAgent: 'leadEmailAgent01',
  whatsappAgent: 'leadWhatsAppAgnt1',
  whatsappTranscripts: 'leadWaTranscript1',
  voiceCalls: 'leadVoiceCalls001',
  digest: 'leadDailyDigest1',
  errorAlert: 'leadErrorAlert01',
  webform: 'leadWebsiteForm1',
  imapCredential: 'leadImapMailbox1',
};

// Older unread mail is left for people. Override with AGENT_IMAP_SINCE=YYYY-MM-DD at build time.
const IMAP_SINCE_DEFAULT = '2026-01-01';

const LIB = read('n8n/code/lib.js');
const IO = read('n8n/code/io.js');

// A Code node's source: the shared library, the constants it needs, then the node's own snippet.
function code(snippet, { prompt = false } = {}) {
  const parts = [LIB, IO, `const FORMS = ${JSON.stringify(forms())};`];
  if (prompt) {
    parts.push(`const SYSTEM_PROMPT = ${JSON.stringify(systemPrompt())};`);
    parts.push(`const SCHEMA = ${JSON.stringify(schema())};`);
  }
  parts.push(read(`n8n/code/nodes/${snippet}`));
  return parts.join('\n\n');
}

let x = 0;
function node(name, type, typeVersion, parameters, extra = {}) {
  x += 260;
  return { id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, type, typeVersion, position: [x, 300], parameters, ...extra };
}
const codeNode = (name, snippet, opts) =>
  node(name, 'n8n-nodes-base.code', 2, { mode: 'runOnceForAllItems', jsCode: code(snippet, opts) });

function chain(...names) {
  const connections = {};
  for (let i = 0; i < names.length - 1; i++) {
    connections[names[i]] = { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] };
  }
  return connections;
}

const settings = (extra = {}) => ({
  executionOrder: 'v1',
  timezone: 'Africa/Johannesburg',
  errorWorkflow: IDS.errorAlert,
  saveDataErrorExecution: 'all',
  saveDataSuccessExecution: 'all',
  saveManualExecutions: true,
  ...extra,
});

// The Claude Messages API call. A failed call does not stop the workflow:
// "Decide and act" sees the error and escalates that message to a person.
const claudeNode = () => node('Claude', 'n8n-nodes-base.httpRequest', 4.4, {
  method: 'POST',
  url: 'https://api.anthropic.com/v1/messages',
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'x-api-key', value: '={{ $env.ANTHROPIC_API_KEY }}' },
    { name: 'anthropic-version', value: '2023-06-01' },
  ] },
  sendBody: true,
  specifyBody: 'json',
  jsonBody: '={{ JSON.stringify($json.request) }}',
  options: { timeout: 120000 },
}, { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput' });

function emailAgent() {
  x = 0;
  const nodes = [
    node('Mailbox', 'n8n-nodes-base.emailReadImap', 2.1, {
      mailbox: 'INBOX',
      postProcessAction: 'nothing',
      format: 'resolved',
      downloadAttachments: false,
      // SINCE stops a backlog of old unread mail being answered when the mailbox is first connected.
      options: {
        customEmailConfig: JSON.stringify(['UNSEEN', ['SINCE', process.env.AGENT_IMAP_SINCE || IMAP_SINCE_DEFAULT]]),
        trackLastMessageId: true,
      },
    }, { credentials: { imap: { id: IDS.imapCredential, name: 'Agent mailbox (IMAP)' } } }),
    codeNode('Prepare', 'email-prepare.js', { prompt: true }),
    claudeNode(),
    codeNode('Decide and act', 'act.js'),
  ];
  return {
    id: IDS.emailAgent,
    name: 'Lead Email Agent',
    nodes,
    connections: chain('Mailbox', 'Prepare', 'Claude', 'Decide and act'),
    settings: settings(),
    active: false,
  };
}

// WhatsApp, through Meta's Cloud API. Meta posts every message to the webhook;
// the reply goes back through the Graph API (see "WhatsApp" in lib.js and io.js).
function whatsappAgent() {
  x = 0;
  const nodes = [
    node('WhatsApp webhook', 'n8n-nodes-base.webhook', 2.1, {
      httpMethod: 'POST',
      path: 'whatsapp',
      // Meta only needs a quick 200. Receive checks the signature against the raw body.
      responseMode: 'onReceived',
      options: { rawBody: true },
    }, { webhookId: '7d2c4b9e-1f35-4a68-b0c7-3e9a5d1f8b21' }),
    codeNode('Receive', 'whatsapp-receive.js'),
    // Lets a burst of messages ("Hi" + three more lines) arrive, so they get one reply.
    node('Wait for more messages', 'n8n-nodes-base.wait', 1.1, {
      resume: 'timeInterval', amount: loadLib().WA_BATCH_SECONDS, unit: 'seconds',
    }, { webhookId: '7d2c4b9e-1f35-4a68-b0c7-3e9a5d1f8b22' }),
    codeNode('Prepare', 'whatsapp-prepare.js', { prompt: true }),
    claudeNode(),
    codeNode('Decide and act', 'act.js'),
  ];
  // Meta's check of the webhook URL, on a row of its own.
  x = 0;
  const verify = [
    node('Meta verification', 'n8n-nodes-base.webhook', 2.1, {
      httpMethod: 'GET',
      path: 'whatsapp',
      responseMode: 'responseNode',
    }, { webhookId: '7d2c4b9e-1f35-4a68-b0c7-3e9a5d1f8b23' }),
    codeNode('Check verify token', 'whatsapp-verify.js'),
    node('Reply to Meta', 'n8n-nodes-base.respondToWebhook', 1.1, {
      respondWith: 'text',
      responseBody: '={{ $json.reply }}',
      options: { responseCode: '={{ $json.status }}' },
    }),
  ];
  for (const n of verify) n.position[1] = 520;
  return {
    id: IDS.whatsappAgent,
    name: 'Lead WhatsApp Agent',
    nodes: nodes.concat(verify),
    connections: {
      ...chain('WhatsApp webhook', 'Receive', 'Wait for more messages', 'Prepare', 'Claude', 'Decide and act'),
      ...chain('Meta verification', 'Check verify token', 'Reply to Meta'),
    },
    settings: settings(),
    active: false,
  };
}

// Each WhatsApp conversation emailed to staff once it has gone quiet (see waTranscriptsDue in lib.js).
function whatsappTranscripts() {
  x = 0;
  const nodes = [
    node('Every 15 minutes', 'n8n-nodes-base.scheduleTrigger', 1.2, {
      rule: { interval: [{ field: 'cronExpression', expression: '*/15 * * * *' }] },
    }),
    codeNode('Email quiet chats', 'whatsapp-transcripts.js'),
  ];
  return { id: IDS.whatsappTranscripts, name: 'Lead WhatsApp Transcripts', nodes, connections: chain('Every 15 minutes', 'Email quiet chats'), settings: settings(), active: false };
}

// Phone calls: voice/ (see "Phone calls" in lib.js) posts each finished call to
// /webhook/voice-call-ended over the Docker network, with x-agent-voice-key. Caddy
// doesn't publish that path. Claude triages the transcript; nothing goes to the caller.
function voiceCalls() {
  x = 0;
  const nodes = [
    node('Call ended', 'n8n-nodes-base.webhook', 2.1, {
      httpMethod: 'POST',
      path: 'voice-call-ended',
      responseMode: 'onReceived',
    }, { webhookId: '7d2c4b9e-1f35-4a68-b0c7-3e9a5d1f8b24' }),
    codeNode('Prepare', 'voice-receive.js', { prompt: true }),
    claudeNode(),
    codeNode('Decide and act', 'voice-act.js'),
  ];
  return {
    id: IDS.voiceCalls,
    name: 'Lead Voice Calls',
    nodes,
    connections: chain('Call ended', 'Prepare', 'Claude', 'Decide and act'),
    settings: settings(),
    active: false,
  };
}

function digest() {
  x = 0;
  const nodes = [
    node('Every morning 07:30', 'n8n-nodes-base.scheduleTrigger', 1.2, {
      rule: { interval: [{ field: 'cronExpression', expression: '30 7 * * *' }] },
    }),
    codeNode('Build and send digest', 'digest.js'),
  ];
  return { id: IDS.digest, name: 'Lead Daily Digest', nodes, connections: chain('Every morning 07:30', 'Build and send digest'), settings: settings(), active: false };
}

function errorAlert() {
  x = 0;
  const nodes = [
    node('On workflow error', 'n8n-nodes-base.errorTrigger', 1, {}),
    codeNode('Send alert', 'error-alert.js'),
  ];
  const s = settings();
  delete s.errorWorkflow;
  return { id: IDS.errorAlert, name: 'Lead Error Alert', nodes, connections: chain('On workflow error', 'Send alert'), settings: s, active: false };
}

function webform() {
  x = 0;
  const nodes = [
    node('Website form', 'n8n-nodes-base.webhook', 2.1, {
      httpMethod: 'POST',
      path: 'website-enquiry',
      responseMode: 'onReceived',
      options: { allowedOrigins: '*' },
    }, { webhookId: 'c3f6a1d2-8b47-4e59-a0d3-6f2b9e7c1a54' }),
    codeNode('Forward enquiry', 'webform.js'),
  ];
  return { id: IDS.webform, name: 'Lead Website Form', nodes, connections: chain('Website form', 'Forward enquiry'), settings: settings(), active: false };
}

export function buildAll() {
  return [emailAgent(), whatsappAgent(), whatsappTranscripts(), voiceCalls(), digest(), errorAlert(), webform()];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outDir = join(root, 'n8n/dist');
  mkdirSync(outDir, { recursive: true });
  for (const wf of buildAll()) {
    // Syntax-check every Code node the way n8n runs it: as an async function body.
    for (const n of wf.nodes.filter((n) => n.type === 'n8n-nodes-base.code')) {
      try {
        new Function(`return (async function () {\n${n.parameters.jsCode}\n})`);
      } catch (e) {
        console.error(`Syntax error in ${wf.name} / ${n.name}: ${e.message}`);
        process.exit(1);
      }
    }
    writeFileSync(join(outDir, `${wf.id}.json`), JSON.stringify(wf, null, 2) + '\n');
    console.log(`built ${wf.name} -> n8n/dist/${wf.id}.json`);
  }
}
