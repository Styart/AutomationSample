// Prints the Asterisk dialplan for this environment: server/asterisk/extensions.conf
// with the secret and the office number filled in. npm run deploy runs it in the
// voice container (which has the .env values) and installs the output.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadShared } from './load.mjs';

export function renderDialplan(template, env, lib) {
  const secret = String(env.AGENT_ASTERISK_SECRET || '');
  if (!/^[0-9a-f]{32,}$/i.test(secret)) throw new Error('AGENT_ASTERISK_SECRET must be a hex string (npm run deploy creates it)');
  const office = lib.trunkDialString(lib.voiceConfig(env).officeNumber);
  if (!/^\d{9,15}$/.test(office)) throw new Error(`AGENT_OFFICE_NUMBER can't be dialled: ${env.AGENT_OFFICE_NUMBER}`);
  return template.replace('@@AGENT_ASTERISK_SECRET@@', secret).replace('@@AGENT_OFFICE@@', office);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const template = readFileSync(new URL('../server/asterisk/extensions.conf', import.meta.url), 'utf8');
  process.stdout.write(renderDialplan(template, process.env, loadShared()));
}
