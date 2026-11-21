// Benchmark of real change cycles through bedmcp's dev_cycle (daemon on a port): each round
// recolours the probe pack (in the test world's pack stack), runs dev_cycle, then looks down at the
// probe plank floor and checks the colour on a PNG screenshot.
// node scripts/cycle-bench.mjs <daemonPort> <slot> <rounds> [build:true|false]
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const [port = '7790', slot = '3', rounds = '10', buildArg = 'build:false'] = process.argv.slice(2);
const build = buildArg === 'build:true';
process.env.BEDD_HOME ??= `${process.env.USERPROFILE}\\.bedd`;
const bedd = `${process.env.LOCALAPPDATA}\\Programs\\BeDD\\BeDD.exe`;
const inst = JSON.parse(execFileSync(bedd, ['instance', 'list', '--json'], { encoding: 'utf8' })).find((i) => i.name.endsWith(`-${slot}`));
const probe = join(inst.dir, 'Minecraft Bedrock', 'Users', 'Shared', 'games', 'com.mojang', 'development_resource_packs', 'bedmcp_probe');
const probePack = new URL('./probe-pack.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = async (name, args = {}) => (await fetch(`http://127.0.0.1:${port}/${name}`, { method: 'POST', body: JSON.stringify(args) })).text();

// Straight to the game for a PNG screenshot (the daemon saves JPEGs).
function gameCall(op, fields) {
  // Looked up every time: a cycle may restart the client (new port and token).
  const g = JSON.parse(execFileSync(bedd, ['ps', '--json'], { encoding: 'utf8' })).find((x) => x.kind === 'client' && x.instance.endsWith(`-${slot}`));
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${g.url}?token=${g.token}`);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, op, ...fields }));
    ws.onmessage = (e) => { if (typeof e.data !== 'string') return; const r = JSON.parse(e.data); if (r.id === 1) { ws.close(); res(r); } };
    ws.onerror = () => rej(new Error('ws error'));
  });
}
function pngPixel(buf, fx, fy) {
  let o = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o); const type = buf.toString('ascii', o + 4, o + 8); const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3; const stride = w * bpp; const raw = inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x]; const a = x >= bpp ? px[y * stride + x - bpp] : 0; const b = y ? px[(y - 1) * stride + x] : 0; const c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let p = v;
      if (f === 1) p = v + a; else if (f === 2) p = v + b; else if (f === 3) p = v + ((a + b) >> 1);
      else if (f === 4) { const pp = a + b - c; const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[y * stride + x] = p & 255;
    }
  }
  const x = Math.floor(w * fx), y = Math.floor(h * fy); const i = y * stride + x * bpp;
  return [px[i], px[i + 1], px[i + 2]];
}

const colours = [[255, 0, 0], [0, 0, 255], [0, 200, 0], [255, 255, 0], [255, 0, 255], [0, 255, 255]];
const times = []; let okCount = 0;
for (let i = 1; i <= Number(rounds); i++) {
  const want = colours[i % colours.length];
  execFileSync(process.execPath, [probePack, probe, `B${i}`, want.join(',')]);
  const t0 = Date.now();
  const out = await tool('dev_cycle', { build });
  const ms = Date.now() - t0;
  const failed = /FAILED|ERROR/.test(out.split('\n')[0]);
  // Look straight down at the plank floor (any popup closed first).
  await tool('key', { key: 'ESC' }); await sleep(600);
  const st = await tool('game_status');
  if (!/"topScreen": "hud_screen"/.test(st)) { await tool('key', { key: 'ESC' }); await sleep(600); }
  await tool('look', { yaw: 0, pitch: 90 }); await sleep(700);
  let shot = await gameCall('screenshot', { format: 'png', maxWidth: 320 });
  let got = pngPixel(Buffer.from(shot.data, 'base64'), 0.5, 0.75);
  let match = got.every((v, k) => Math.abs(v - want[k]) < 70);
  if (!match) {
    // Something may cover the view (a popup, the HUD's loading overlay): close it, look again.
    writeFileSync(join(process.cwd(), 'scripts', `bench-${i}-first.png`), Buffer.from(shot.data, 'base64'));
    await tool('key', { key: 'ESC' }); await sleep(1500);
    await tool('look', { yaw: 0, pitch: 90 }); await sleep(500);
    shot = await gameCall('screenshot', { format: 'png', maxWidth: 320 });
    got = pngPixel(Buffer.from(shot.data, 'base64'), 0.5, 0.75);
    match = got.every((v, k) => Math.abs(v - want[k]) < 70);
    writeFileSync(join(process.cwd(), 'scripts', `bench-${i}-second.png`), Buffer.from(shot.data, 'base64'));
  }
  if (match && !failed) okCount++;
  times.push(ms);
  console.log(`#${i} ${build ? 'build+RP' : 'RP'} ${(ms / 1000).toFixed(1)} s  expected rgb(${want}) saw rgb(${got}) ${match ? 'OK' : 'MISMATCH'}${failed ? ' (dev_cycle failed)' : ''}`);
}
const avg = times.reduce((a, b) => a + b, 0) / times.length;
const sorted = [...times].sort((a, b) => a - b);
console.log(`\n${times.length} rounds, ${okCount} applied: avg ${(avg / 1000).toFixed(1)} s, median ${(sorted[Math.floor(sorted.length / 2)] / 1000).toFixed(1)} s, min ${(sorted[0] / 1000).toFixed(1)} s, max ${(sorted.at(-1) / 1000).toFixed(1)} s`);
