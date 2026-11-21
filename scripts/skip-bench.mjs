// Rejoin cycles with BedmcpHot's "skipleave": arm it, recolour the probe, leave, wait for the title
// screen, rejoin, and screenshot the plank floor. node scripts/skip-bench.mjs <slot> <port> <n> [skip|noskip]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [slot = '3', port = '19144', n = '3', mode = 'skip'] = process.argv.slice(2);
process.env.BEDD_HOME ??= `${process.env.USERPROFILE}\\.bedd`;
const bedd = `${process.env.LOCALAPPDATA}\\Programs\\BeDD\\BeDD.exe`;
const g = JSON.parse(execFileSync(bedd, ['ps', '--json'], { encoding: 'utf8' })).find((x) => x.kind === 'client' && x.instance.endsWith(`-${slot}`));
const inst = JSON.parse(execFileSync(bedd, ['instance', 'list', '--json'], { encoding: 'utf8' })).find((i) => i.name === g.instance);
const modDir = join(inst.dir, 'mods', 'BedmcpHot');
const probe = join(inst.dir, 'Minecraft Bedrock', 'Users', 'Shared', 'games', 'com.mojang', 'development_resource_packs', 'bedmcp_probe');
const probePack = new URL('./probe-pack.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const ws = new WebSocket(`${g.url}?token=${g.token}`);
const waiting = new Map(); let nid = 0;
ws.onmessage = (e) => { if (typeof e.data !== 'string') return; const r = JSON.parse(e.data); waiting.get(r.id)?.(r); waiting.delete(r.id); };
await new Promise((r) => { ws.onopen = r; });
const call = (op, f = {}) => new Promise((res) => { const i = ++nid; waiting.set(i, res); ws.send(JSON.stringify({ id: i, op, ...f })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hot = async (action) => {
  const id = Date.now(); writeFileSync(join(modDir, 'trigger.json'), JSON.stringify({ id, action }));
  for (let i = 0; i < 200; i++) { try { const s = JSON.parse(readFileSync(join(modDir, 'status.json'), 'utf8')); if (s.id === id) return s; } catch {} await sleep(25); }
  return null;
};
const colours = ['255,0,0', '0,0,255', '255,255,0', '255,0,255', '0,255,255'];

for (let i = 1; i <= Number(n); i++) {
  const rgb = colours[i % colours.length];
  execFileSync(process.execPath, [probePack, probe, `S${i}`, rgb]);
  const t0 = Date.now();
  if (mode === 'skip') await hot('skipleave');
  await call('join', { host: null, wait: true, timeoutMs: 30000 });
  const tLeft = Date.now();
  for (;;) { const w = await call('world'); if (!w.inLevel && /start_screen|hbui/.test(w.topScreen ?? '')) break; await sleep(100); }
  const tReady = Date.now();
  const j = await call('join', { host: '127.0.0.1', port: Number(port), wait: true, timeoutMs: 40000 });
  const tJoined = Date.now();
  let tIn = tJoined;
  if (j.ok) for (;;) { const w = await call('world'); if (w.inLevel && w.player && !/progress|loading/.test(w.topScreen ?? '')) { tIn = Date.now(); break; } if (Date.now() - tJoined > 30000) break; await sleep(100); }
  const st = JSON.parse(readFileSync(join(modDir, 'status.json'), 'utf8'));
  await call('look', { yaw: 0, pitch: 60 });
  await sleep(1500);
  const shot = await call('screenshot', { format: 'jpeg', maxWidth: 400 });
  const f = join(process.cwd(), 'scripts', `skip-${i}.jpg`);
  writeFileSync(f, Buffer.from(shot.data, 'base64'));
  console.log(`${mode} #${i} rgb(${rgb}): leave ${tLeft - t0} ms, to title ${tReady - tLeft} ms, join ${tJoined - tReady} ms (${j.ok ? 'ok' : j.error}), in-world ${tIn - tJoined} ms, total ${tIn - t0} ms, skipped=${st.skipped} shot=${f}`);
  if (!j.ok) break;
  await sleep(1000);
}
ws.close();
