// Script debugger of the test server (the protocol of Mojang's "Minecraft Bedrock Debugger" for VS
// Code). bedmcp listens on loopback and the server connects out ("script debugger connect"): the
// server's inbound "listen" mode accepts a socket on this BDS but never answers it (seen 2026-11-24).
// Wire format, both ways: 8 lowercase hex digits (length of the JSON + 1) and "\n", the JSON, "\n".
// Source maps (a ".map" next to the built .js) let breakpoints and stacks use the TypeScript files.
import net from 'node:net';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, sep } from 'node:path';

// ---------------------------------------------------------------- source maps
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64I = Object.fromEntries([...B64].map((c, i) => [c, i]));
function decodeMappings(str) {
  // -> per generated line: [[genCol, srcIdx, srcLine, srcCol], ...] (0-based)
  const lines = [];
  let src = 0, sl = 0, sc = 0;
  for (const lineStr of str.split(';')) {
    const segs = [];
    let gc = 0;
    if (lineStr) for (const seg of lineStr.split(',')) {
      const v = [];
      let value = 0, shift = 0;
      for (const ch of seg) {
        const d = B64I[ch];
        value += (d & 31) << shift;
        if (d & 32) { shift += 5; continue; }
        v.push(value & 1 ? -(value >>> 1) : value >>> 1);
        value = 0; shift = 0;
      }
      gc += v[0];
      if (v.length >= 4) { src += v[1]; sl += v[2]; sc += v[3]; segs.push([gc, src, sl, sc]); }
    }
    lines.push(segs);
  }
  return lines;
}
const mapCache = new Map(); // js file -> { mtime, map }
function loadMap(jsFile) {
  const mf = `${jsFile}.map`;
  if (!existsSync(mf)) return null;
  const mtime = statSync(mf).mtimeMs;
  const hit = mapCache.get(jsFile);
  if (hit?.mtime === mtime) return hit.map;
  const raw = JSON.parse(readFileSync(mf, 'utf8'));
  const root = resolve(dirname(mf), raw.sourceRoot ?? '');
  const sources = raw.sources.map((s) => resolve(root, s));
  const lines = decodeMappings(raw.mappings);
  // Reverse index: source -> line -> first generated line (1-based) that maps to it.
  const rev = new Map();
  lines.forEach((segs, gl) => { for (const [, si, sl] of segs) { let m = rev.get(si); if (!m) rev.set(si, (m = new Map())); if (!m.has(sl)) m.set(sl, gl + 1); } });
  const map = { sources, lines, rev };
  mapCache.set(jsFile, { mtime, map });
  return map;
}
const norm = (p) => resolve(p).toLowerCase();
// "src/game/mobs.ts:120" -> generated line in the js, or null.
function toGenerated(map, file, line) {
  const si = map.sources.findIndex((s) => norm(s) === norm(file));
  if (si < 0) return null;
  const m = map.rev.get(si);
  if (!m) return null;
  for (let l = line - 1; l < line + 5; l++) if (m.has(l)) return { genLine: m.get(l), source: map.sources[si], srcLine: l + 1 };
  return null;
}
function toSource(map, genLine, genCol = 0) {
  const segs = map?.lines[genLine - 1];
  if (!segs?.length) return null;
  let best = segs[0];
  for (const s of segs) if (s[0] <= genCol) best = s;
  return { file: map.sources[best[1]], line: best[2] + 1 };
}

// ---------------------------------------------------------------- session
export function createDebugger({ serverCommand, log, packs, projectDir }) {
  let st = null; // the live session

  const frame = (o) => { const j = Buffer.from(JSON.stringify(o)); return Buffer.concat([Buffer.from(`${('00000000' + (j.length + 1).toString(16)).slice(-8)}\n`), j, Buffer.from('\n')]); };
  const send = (o) => { if (!st?.sock) throw new Error('the debugger is not attached: debug {action:"attach"}'); st.sock.write(frame(o)); };

  function onMessage(msg) {
    if (msg.type === 'response') {
      const p = st.pending.get(msg.request_seq);
      if (p) { st.pending.delete(msg.request_seq); msg.error ? p.rej(new Error(msg.error)) : p.res(msg.body ?? {}); }
      return;
    }
    if (msg.type !== 'event') return;
    const e = msg.event;
    switch (e.type) {
      case 'ProtocolEvent': st.protocol?.(e); break;
      case 'StoppedEvent': st.stopped = { reason: e.reason, thread: e.thread, at: Date.now() }; st.stopWaiters.splice(0).forEach((f) => f()); break;
      case 'ThreadEvent': if (e.reason === 'exited') st.threads.delete(e.thread); else st.threads.add(e.thread); break;
      case 'PrintEvent': case 'NotificationEvent':
        st.prints.push({ t: Date.now(), level: e.logLevel, message: String(e.message ?? '').replace(/[\r\n]+$/, '') });
        if (st.prints.length > 400) st.prints.splice(0, st.prints.length - 300);
        break;
      case 'StatEvent2': st.statTick = e.tick; for (const s of e.stats ?? []) st.stats.set(s.name, s); break;
      case 'ProfilerCapture': st.capture = e; break;
      default: break;
    }
  }

  async function attach({ port = 0, target } = {}) {
    if (st?.sock) return { attached: true, already: true, target: st.target };
    const server = net.createServer();
    await new Promise((res, rej) => { server.once('error', rej); server.listen(port, '127.0.0.1', res); });
    const actual = server.address().port;
    st = { server, sock: null, seq: 1, pending: new Map(), stopWaiters: [], prints: [], stats: new Map(), threads: new Set(), stopped: null, breakpoints: new Map(), target: null };
    const protocol = new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('the server did not connect to the debugger within 15 s')), 15000);
      st.protocol = (e) => { clearTimeout(timer); res(e); };
    });
    server.on('connection', (sock) => {
      if (st.sock) { sock.destroy(); return; }
      st.sock = sock;
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 9) {
          const n = parseInt(buf.subarray(0, 8).toString(), 16);
          if (!(n >= 0) || buf.length < 9 + n) break;
          let msg = null;
          try { msg = JSON.parse(buf.subarray(9, 9 + n).toString()); } catch (e) { log('debugger: bad message', e.message); }
          buf = buf.subarray(9 + n);
          if (msg) try { onMessage(msg); } catch (e) { log('debugger:', e.message); }
        }
      });
      sock.on('close', () => { if (st?.sock === sock) { st.sock = null; st.closed = Date.now(); st.pending.forEach((p) => p.rej(new Error('debugger disconnected'))); st.pending.clear(); } });
      sock.on('error', () => {});
    });
    // The command holds the server thread until the handshake is done, so it is not awaited first:
    // the protocol event comes while it runs, and its own reply may time out.
    let cmdOut = '';
    const cmd = serverCommand(`script debugger connect 127.0.0.1 ${actual}`, { waitMs: 10000 }).then((o) => { cmdOut = o; }, (e) => { cmdOut = e.message; });
    let p;
    try { p = await protocol; } catch (e) {
      await cmd;
      try { server.close(); } catch {}
      st = null;
      throw new Error(`the server did not connect: ${cmdOut.trim() || e.message} (bedmcp's server.properties needs allow-outbound-script-debugging=true; server_restart applies it)`);
    }
    const plugins = p.plugins ?? [];
    const want = String(target ?? '').toLowerCase();
    // Without a target the session is diagnostics-only (no breakpoints), so always pick one.
    const pick = (want ? plugins.find((x) => x.module_uuid.toLowerCase() === want || x.name.toLowerCase().includes(want)) : undefined)
      // The project's pack built with a source map (its own code), then any project pack.
      ?? plugins.find((x) => packs.some((pk) => pk.scriptUuid?.toLowerCase() === x.module_uuid.toLowerCase() && pk.entry && existsSync(join(pk.dir, `${pk.entry}.map`))))
      ?? plugins.find((x) => packs.some((pk) => pk.scriptUuid?.toLowerCase() === x.module_uuid.toLowerCase()))
      ?? plugins.find((x) => !/bedmcp/i.test(x.name)) ?? plugins[0];
    send({ type: 'protocol', version: p.version, target_module_uuid: pick?.module_uuid });
    st.target = pick ? { name: pick.name, uuid: pick.module_uuid } : null;
    st.version = p.version;
    await new Promise((r) => setTimeout(r, 200));
    send({ type: 'stopOnException', stopOnException: false });
    send({ type: 'resume' });
    return { attached: true, port: actual, protocol: p.version, target: st.target, scripts: plugins.map((x) => x.name) };
  }

  function request(command, args = {}, timeoutMs = 8000) {
    const request_seq = st.seq++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { st.pending.delete(request_seq); rej(new Error(`${command}: no answer in ${timeoutMs} ms`)); }, timeoutMs);
      st.pending.set(request_seq, { res: (b) => { clearTimeout(timer); res(b); }, rej: (e) => { clearTimeout(timer); rej(e); } });
      send({ type: 'request', request: { request_seq, command, args } });
    });
  }

  // The pack whose built js holds a breakpoint target: its scripts folder, entry and source map.
  function scriptOf(file) {
    const f = resolve(projectDir, file);
    for (const pk of packs) {
      if (!pk.entry) continue;
      const js = join(pk.dir, pk.entry);
      if (norm(f) === norm(js)) return { pk, js, map: loadMap(js), generated: true };
      if (norm(f).startsWith(norm(pk.dir) + sep) && /\.js$/i.test(f)) return { pk, js: f, map: null, generated: true };
    }
    // A source file (TypeScript): the pack whose source map lists it. The path may be relative to the
    // project or to the pack.
    for (const pk of packs) {
      if (!pk.entry) continue;
      const js = join(pk.dir, pk.entry), map = loadMap(js);
      if (!map) continue;
      for (const cand of [f, resolve(pk.dir, file)]) if (map.sources.some((s) => norm(s) === norm(cand))) return { pk, js, map, generated: false, source: cand };
    }
    return null;
  }
  // The path the game knows a script by: relative to the pack's scripts folder, forward slashes.
  const remotePath = (pk, js) => relative(join(pk.dir, 'scripts'), js).split(sep).join('/');

  async function setBreakpoints({ file, lines, clear }) {
    if (!st?.sock) throw new Error('not attached');
    const sc = scriptOf(file);
    if (!sc) throw new Error(`${file}: not a script of the project's behavior packs (give a .ts file covered by a source map, or the built .js)`);
    // A session debugs one pack: attach again to the pack that owns this file.
    let reattached = null;
    if (sc.pk.scriptUuid && st.target?.uuid?.toLowerCase() !== sc.pk.scriptUuid.toLowerCase()) {
      await detach();
      await attach({ target: sc.pk.scriptUuid });
      reattached = st.target;
    }
    const mapped = [];
    for (const l of lines ?? []) {
      if (sc.generated) mapped.push({ asked: l, line: l });
      else {
        const g = toGenerated(sc.map, sc.source, l);
        if (!g) throw new Error(`${file}:${l} has no code in the built script (try a nearby line with a statement)`);
        mapped.push({ asked: l, line: g.genLine, srcLine: g.srcLine });
      }
    }
    const path = remotePath(sc.pk, sc.js);
    const all = clear ? new Map() : new Map(st.breakpoints.get(path) ?? []);
    for (const m of mapped) all.set(m.line, m);
    if (clear && !lines?.length) all.clear();
    const list = [...all.keys()].sort((a, b) => a - b);
    const body = st.version >= 6 ? await request('setBreakpoints', { path, breakpoints: list.length ? list : undefined }) : (send({ type: 'breakpoints', path, breakpoints: list.length ? list.map((line) => ({ line, column: 0 })) : undefined }), {});
    st.breakpoints.set(path, all);
    st.scripts = { ...(st.scripts ?? {}), [path]: sc };
    return { path, ...(reattached ? { reattachedTo: reattached } : {}), breakpoints: [...all.values()].map((m, i) => ({ ...m, verified: body.breakpoints?.[i]?.verified })) };
  }

  const frameSource = (f) => {
    const sc = Object.values(st.scripts ?? {}).find((s) => remotePath(s.pk, s.js) === f.filename) ?? (() => {
      for (const pk of packs) if (pk.entry && remotePath(pk, join(pk.dir, pk.entry)) === f.filename) return { pk, js: join(pk.dir, pk.entry), map: loadMap(join(pk.dir, pk.entry)) };
      return null;
    })();
    const src = sc?.map ? toSource(sc.map, f.line, f.column) : null;
    return src ? `${relative(projectDir, src.file).split(sep).join('/')}:${src.line}` : `${f.filename}:${f.line}`;
  };

  async function snapshot({ depth = 1, frames = 8 } = {}) {
    if (!st.stopped) return { running: true };
    const thread = st.stopped.thread;
    const stack = await request('stackTrace', { threadId: thread });
    const list = (Array.isArray(stack) ? stack : stack.stackFrames ?? []).slice(0, frames);
    const out = { stopped: st.stopped.reason, thread, stack: list.map((f) => ({ id: f.id, fn: f.name, at: frameSource(f) })) };
    if (list[0]) {
      const scopes = await request('scopes', { frameId: list[0].id });
      out.scopes = {};
      for (const s of (scopes.scopes ?? scopes ?? []).slice(0, 3)) {
        if (s.expensive) { out.scopes[s.name] = '(expensive: use debug variables)'; continue; }
        out.scopes[s.name] = await vars(s.variablesReference ?? s.reference, depth);
      }
    }
    return out;
  }
  async function vars(ref, depth = 0, max = 40) {
    const r = await request('variables', { variablesReference: ref });
    const out = {};
    for (const v of (r.variables ?? r ?? []).slice(0, max)) {
      out[v.name] = depth > 0 && v.variablesReference ? await vars(v.variablesReference, depth - 1, 15) : `${v.value}${v.variablesReference ? ` [ref ${v.variablesReference}]` : ''}`;
    }
    return out;
  }

  async function waitStop(timeoutMs) {
    if (st.stopped) return true;
    return new Promise((res) => {
      const timer = setTimeout(() => { st.stopWaiters = st.stopWaiters.filter((f) => f !== done); res(false); }, timeoutMs);
      const done = () => { clearTimeout(timer); res(true); };
      st.stopWaiters.push(done);
    });
  }
  async function resume(kind = 'continue') {
    if (!st.stopped) return { running: true };
    const thread = st.stopped.thread;
    st.stopped = null;
    await request(kind, { threadId: thread });
    return { resumed: kind };
  }

  // The latest values of the engine's stats (memory, handles, scripting engine table ...).
  function statsSummary() {
    const flat = {};
    const walk = (s, path) => {
      const name = path ? `${path}/${s.name}` : s.name;
      if (s.values?.length) flat[name] = s.values[s.values.length - 1];
      for (const c of s.children ?? []) walk(c, name);
    };
    for (const s of st.stats.values()) walk(s, '');
    return { tick: st.statTick, stats: flat };
  }

  async function detach() {
    if (!st) return { attached: false };
    try { if (st.stopped) await resume(); } catch {}
    try { await serverCommand('script debugger close', { waitMs: 2000 }); } catch {}
    try { st.sock?.destroy(); st.server.close(); } catch {}
    st = null;
    return { detached: true };
  }

  return {
    attach, detach, setBreakpoints, snapshot, waitStop, resume, vars, request, statsSummary,
    get session() { return st; },
    prints(since = 0, filter) { const re = filter ? new RegExp(filter, 'i') : null; return st.prints.filter((p) => p.t > since && (!re || re.test(p.message))); },
  };
}
