// Manual test client: node scripts/try.mjs <tool> '<json args>' [<tool> '<json>' ...]
// Images are saved to scripts/out-<n>.png/jpg instead of printed.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';

const client = new Client({ name: 'try', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('../src/index.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')], stderr: 'inherit' }));
const argv = process.argv.slice(2);
if (!argv.length) {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(`${t.name}: ${t.description.slice(0, 90)}`);
}
let n = 0;
for (let i = 0; i < argv.length; i += 2) {
  const name = argv[i];
  const args = argv[i + 1] ? JSON.parse(argv[i + 1]) : {};
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  console.log(`=== ${name} ${JSON.stringify(args)} (${Date.now() - t0} ms)${r.isError ? ' ERROR' : ''}`);
  for (const c of r.content) {
    if (c.type === 'text') console.log(c.text);
    else if (c.type === 'image') { const f = new URL(`./out-${++n}.${c.mimeType.endsWith('png') ? 'png' : 'jpg'}`, import.meta.url); writeFileSync(f, Buffer.from(c.data, 'base64')); console.log(`[image saved ${f.pathname}]`); }
  }
}
await client.close();
