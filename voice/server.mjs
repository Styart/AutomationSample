// The voice agent's servers (the "voice" service in server/docker-compose.yml):
// HTTP for the dialplan's CURL calls, and AudioSocket for the call audio. Docker
// publishes both on the host's 127.0.0.1 only, where Asterisk runs. See agent.mjs.
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createVoiceAgent } from './agent.mjs';
import { loadShared, voicePrompt } from './load.mjs';

const MAX_BODY = 64 * 1024;
const agent = createVoiceAgent({ env: process.env, lib: loadShared(), systemPrompt: voicePrompt() });

const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); return; }
      chunks.push(c);
    }
    const out = await agent.handle({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(out.status, out.headers).end(out.body);
  } catch (e) {
    console.error(`voice: ${e.stack || e.message}`);
    if (!res.headersSent) res.writeHead(500).end();
  }
});

const audio = createTcpServer((socket) => {
  socket.setNoDelay(true);
  agent.audiosocket(socket);
});

server.listen(Number(process.env.PORT || 8080), () => {
  const c = agent.config;
  console.log(`voice agent listening on ${server.address().port}: agent ${c.enabled ? 'ON' : 'OFF'}` +
    `${c.testNumbers.length ? `, test numbers ${c.testNumbers.join(' ')}` : ''}, office ${c.officeNumber}` +
    `${c.hasKey ? '' : ', OPENAI_API_KEY not set (all calls go to the office)'}` +
    `${process.env.AGENT_ASTERISK_SECRET ? '' : ', AGENT_ASTERISK_SECRET not set (all calls go to the office)'}`);
});
audio.listen(Number(process.env.AUDIOSOCKET_PORT || 9093), () => console.log(`AudioSocket listening on ${audio.address().port}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    server.close();
    audio.close();
    await agent.shutdown();
    process.exit(0);
  });
}
