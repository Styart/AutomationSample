// Loads n8n/code/lib.js and io.js (written for n8n Code nodes, so no exports) as
// modules, plus the prompts, schema and forms catalogue shared by build, tests and evals.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
// A prompt with prompts/shared.md (the rules every channel follows) in place of its {{shared}} line.
const prompt = (name) => read(`prompts/${name}`).replace(/^\{\{shared\}\}$/m, () => read('prompts/shared.md').trim()).trim();
const topLevelNames = (src) => [...src.matchAll(/^(?:async )?function (\w+)|^const (\w+) =/gm)].map((m) => m[1] || m[2]);

// The pure logic, for unit tests and evals.
export function loadLib() {
  const src = read('n8n/code/lib.js');
  return new Function(`${src}\nreturn { ${topLevelNames(src).join(', ')} };`)();
}

// lib.js + io.js as a Code node sees them, with require() supplied by the caller (a fake, in tests).
export function loadAll(fakeRequire) {
  const src = `${read('n8n/code/lib.js')}\n${read('n8n/code/io.js')}`;
  return new Function('require', `${src}\nreturn { ${topLevelNames(src).join(', ')} };`)(fakeRequire);
}

export const forms = () => JSON.parse(read('forms/catalog.json'));
// Email, WhatsApp and the triage of finished calls share one prompt; the live call has its own.
export const systemPrompt = () => prompt('email-agent.system.md');
export const voicePrompt = () => prompt('voice-agent.system.md');

// The reply schema, with "attach" limited to the forms in the catalogue.
export function schema() {
  const s = JSON.parse(read('prompts/email-agent.schema.json'));
  s.properties.attach.items.enum = forms().map((f) => f.id);
  return s;
}
