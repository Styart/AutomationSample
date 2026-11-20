// Loads n8n/code/lib.js and io.js (plain scripts written for n8n Code nodes, no
// exports) and the voice agent's prompt. The deploy copies the same layout to the VPS
// (/opt/lead-agent/voice-app), so these paths work in the container too.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

export function loadShared(req = createRequire(import.meta.url)) {
  const src = `${read('n8n/code/lib.js')}\n${read('n8n/code/io.js')}`;
  const names = [...src.matchAll(/^(?:async )?function (\w+)|^const (\w+) =/gm)].map((m) => m[1] || m[2]);
  return new Function('require', `${src}\nreturn { ${names.join(', ')} };`)(req);
}

// prompts/voice-agent.system.md, with prompts/shared.md (the rules every channel follows) in place of its {{shared}} line.
export const voicePrompt = () => read('prompts/voice-agent.system.md').replace(/^\{\{shared\}\}$/m, () => read('prompts/shared.md').trim());
