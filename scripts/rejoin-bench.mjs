// Leave + rejoin N times with the raw Be.D.D. ops and time each phase.
// node scripts/rejoin-bench.mjs <slot> <port> <n> <wait|now>
//   wait: join only once the leave's loading/saving screens are gone; now: join right away.
import { execFileSync } from 'node:child_process';

const [slot = '3', port = '19144', n = '5', mode = 'wait'] = process.argv.slice(2);
process.env.BEDD_HOME ??= `${process.env.USERPROFILE}\\.bedd`;
const bedd = `${process.env.LOCALAPPDATA}\\Programs\\BeDD\\BeDD.exe`;
const g = JSON.parse(execFileSync(bedd, ['ps', '--json'], { encoding: 'utf8' })).find((x) => x.kind === 'client' && x.instance.endsWith(`-${slot}`));
const ws = new WebSocket(`${g.url}?token=${g.token}`);
const waiting = new Map(); let nid = 0;
ws.onmessage = (e) => { if (typeof e.data !== 'string') return; const r = JSON.parse(e.data); waiting.get(r.id)?.(r); waiting.delete(r.id); };
await new Promise((r) => { ws.onopen = r; });
const call = (op, f = {}) => new Promise((res) => { const i = ++nid; waiting.set(i, res); ws.send(JSON.stringify({ id: i, op, ...f })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 1; i <= Number(n); i++) {
  const t0 = Date.now();
  await call('join', { host: null, wait: true, timeoutMs: 30000 });
  const tLeft = Date.now();
  if (mode === 'wait') {
    // The reload screen shows ~0.6 s after the leave (toast_screen first): wait for the title screen.
    for (;;) { const w = await call('world'); if (!w.inLevel && /start_screen|hbui/.test(w.topScreen ?? '')) break; await sleep(100); }
  }
  const tReady = Date.now();
  const j = await call('join', { host: '127.0.0.1', port: Number(port), wait: true, timeoutMs: 40000 });
  const tJoined = Date.now();
  let tIn = tJoined;
  if (j.ok) for (;;) { const w = await call('world'); if (w.inLevel && w.player && !/progress|loading/.test(w.topScreen ?? '')) { tIn = Date.now(); break; } if (Date.now() - tJoined > 30000) break; await sleep(100); }
  console.log(`${mode} #${i}: leave ${tLeft - t0} ms, reload ${tReady - tLeft} ms, join ${tJoined - tReady} ms (${j.ok ? 'ok' : j.error}), in-world ${tIn - tJoined} ms, total ${tIn - t0} ms`);
  if (!j.ok) break;
  await sleep(1500);
}
ws.close();
