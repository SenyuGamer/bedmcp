// Keeps one MCP session alive for manual testing: POST http://127.0.0.1:7788/<tool> with JSON args.
// Images are saved to scripts/out-<n>.(jpg|png). POST /quit stops the server cleanly and exits.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.BEDMCP_DAEMON_PORT ?? 7788);
const client = new Client({ name: 'daemon', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/index.mjs', import.meta.url))], stderr: 'inherit' }));
let n = 0;
createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const name = req.url.slice(1);
  if (name === 'quit') { res.end('bye\n'); await client.close(); process.exit(0); }
  try {
    const t0 = Date.now();
    const r = await client.callTool({ name, arguments: body ? JSON.parse(body) : {} }, undefined, { timeout: 900000 });
    const out = [`=== ${name} (${Date.now() - t0} ms)${r.isError ? ' ERROR' : ''}`];
    for (const c of r.content) {
      if (c.type === 'text') out.push(c.text);
      else { const f = fileURLToPath(new URL(`./out-${PORT}-${++n}.${c.mimeType.endsWith('png') ? 'png' : 'jpg'}`, import.meta.url)); writeFileSync(f, Buffer.from(c.data, 'base64')); out.push(`[image ${f}]`); }
    }
    res.end(out.join('\n') + '\n');
  } catch (e) { res.end(`ERROR ${e.message}\n`); }
}).listen(PORT, '127.0.0.1', () => console.error(`daemon on ${PORT}`));
