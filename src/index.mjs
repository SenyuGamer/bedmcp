#!/usr/bin/env node
// bedmcp: an MCP server that lets an agent test a Minecraft Bedrock project in the real game. Each
// Claude session gets its own pair: a background Minecraft client (a Be.D.D. slot) and its own test
// server (Be.D.D.'s LeviLamina BDS, with its own copy of the world). The agent can rebuild packs,
// restart its server, rejoin, look at the screen, run commands and inspect entities.
//
// Why one server per session: every client clone shares one Microsoft account, and a server that
// already had one clone of that account in this run refuses another clone ("Kelp"; verified
// 2026-11-17). The same clone reconnects fine after a client restart. Separate servers also keep
// the sessions from writing to the same world.
//
// stdout is the MCP channel: never print to it. Diagnostics go to stderr.

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, cpSync, mkdirSync, renameSync, statSync, symlinkSync, lstatSync, readlinkSync, unlinkSync } from 'node:fs';
import { safeRm, protectPaths } from './safefs.mjs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRecorder } from './record.mjs';
import { createDebugger } from './debugger.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const expandEnv = (s) => (typeof s === 'string' ? s.replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? `%${k}%`) : s);
const readJsonFile = (f) => { try { return JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const normPath = (p) => resolve(p).toLowerCase().replace(/[\\/]+$/, '');
const samePath = (a, b) => normPath(a) === normPath(b);
const inside = (dir, root) => { const d = normPath(dir), r = normPath(root); return d === r || d.startsWith(`${r}\\`) || d.startsWith(`${r}/`); };

// ---------------------------------------------------------------- configuration
// Two kinds of settings, from several files (later wins):
// - Machine settings (Be.D.D. path, homes, slots, server name and ports, hotMod, bots):
//   built-in defaults < config.json next to this code (a local install) < the user config
//   (%USERPROFILE%\.bedmcp\config.json, BEDMCP_HOME moves it) < BEDMCP_CONFIG.
// - Project settings (root, build steps, packs, world, variants): the most specific source only:
//   bedmcp.json / .bedmcp.json in the project folder or above it; else the user config's
//   projects["<folder>"] that contains the project folder; else BEDMCP_CONFIG / config.json when its
//   sourceDir contains the project folder (or nothing else matched); else the project folder itself,
//   with its packs and world found by looking.
// The project folder is CLAUDE_PROJECT_DIR when the host sets it, else the working directory.
let PROJECT_DIR = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
let PROJECT_SET = false;
const PROJECT_DIR_FROM = process.env.CLAUDE_PROJECT_DIR ? "CLAUDE_PROJECT_DIR" : "the working directory";
const USER_DIR = expandEnv(process.env.BEDMCP_HOME || '%USERPROFILE%\\.bedmcp');
const PROJECT_FILES = ['bedmcp.json', '.bedmcp.json'];
const MACHINE_KEYS = ['bedd', 'beddHome', 'stateDir', 'slot', 'maxClients', 'exclusiveSignaling', 'worldMode', 'hotMod', 'bots'];
const CONFIG_SOURCES = [];

function findProjectFile(dir) {
  for (let d = dir; ; d = dirname(d)) {
    for (const f of PROJECT_FILES) if (existsSync(join(d, f))) return join(d, f);
    if (dirname(d) === d) return null;
  }
}
// A project section in either shape: the flat one of bedmcp.json, or the older config.json one
// (server.sourceDir, server.variants, top-level build/resourcePacks).
function projectOf(layer, baseDir) {
  if (!layer) return null;
  const legacy = layer.server?.sourceDir !== undefined;
  const root = legacy ? expandEnv(layer.server.sourceDir) : resolve(baseDir, expandEnv(layer.root ?? '.'));
  return {
    root,
    build: layer.build,
    resourcePacks: layer.resourcePacks,
    behaviorPacks: layer.behaviorPacks,
    world: layer.world,
    variants: legacy ? layer.server.variants : layer.variants,
    serverProperties: layer.serverProperties,
  };
}
function loadConfig() {
  CONFIG_SOURCES.length = 0;
  const machine = { server: {} };
  const take = (layer, from) => {
    if (!layer) return;
    for (const k of MACHINE_KEYS) if (layer[k] !== undefined) machine[k] = layer[k];
    for (const [k, v] of Object.entries(layer.server ?? {})) if (!['sourceDir', 'variants'].includes(k)) machine.server[k] = v;
    CONFIG_SOURCES.push(from);
  };
  const envFile = process.env.BEDMCP_CONFIG ? resolve(process.env.BEDMCP_CONFIG) : null;
  const localFile = join(here, '..', 'config.json');
  const userFile = join(USER_DIR, 'config.json');
  const local = !envFile && existsSync(localFile) ? readJsonFile(localFile) : null;
  const user = !envFile && existsSync(userFile) ? readJsonFile(userFile) : null;
  const env = envFile ? readJsonFile(envFile) : null;
  if (envFile && !env) throw new Error(`BEDMCP_CONFIG ${envFile} is missing or not valid JSON`);
  take(local, localFile); take(user, userFile); take(env, envFile);

  let project = null;
  const projFile = envFile ? null : findProjectFile(PROJECT_DIR);
  if (projFile) { const j = readJsonFile(projFile); if (!j) throw new Error(`${projFile} is not valid JSON`); project = projectOf(j, dirname(projFile)); CONFIG_SOURCES.push(projFile); }
  if (!project && user?.projects) {
    const hit = Object.keys(user.projects).filter((k) => inside(PROJECT_DIR, expandEnv(k))).sort((a, b) => b.length - a.length)[0];
    if (hit) { project = projectOf(user.projects[hit], expandEnv(hit)); CONFIG_SOURCES.push(`${userFile} projects["${hit}"]`); }
  }
  if (!project) {
    const fallback = projectOf(env ?? local, PROJECT_DIR);
    // A config.json made for one project (its sourceDir) serves the sessions of that project, and
    // sessions opened in bedmcp's own folder (to work on bedmcp itself).
    if (fallback?.root && (env || inside(PROJECT_DIR, fallback.root) || samePath(PROJECT_DIR, join(here, '..')))) project = fallback;
  }
  project ??= { root: PROJECT_DIR };
  return { ...machine, server: { ...machine.server, sourceDir: project.root, variants: project.variants }, build: project.build, resourcePacks: project.resourcePacks, behaviorPacks: project.behaviorPacks, world: project.world, serverProperties: project.serverProperties };
}
let cfg, CONFIG_ERROR = null;
try { cfg = loadConfig(); } catch (e) { CONFIG_ERROR = e.message; cfg = { server: { sourceDir: PROJECT_DIR } }; }

const BEDD = expandEnv(cfg.bedd ?? '%LOCALAPPDATA%\\Programs\\BeDD\\BeDD.exe');
// Packaged hosts (the Claude desktop app) virtualize %LOCALAPPDATA%, so BeDD's default home there
// is seen at two paths and BeDD loses track of its games. Keep it in a real folder.
process.env.BEDD_HOME = expandEnv(cfg.beddHome ?? '%USERPROFILE%\\.bedd');
// The server of the first slot; the servers of the other slots are copies of it (without its world).
// Made with `BeDD.exe server init` when missing.
const BASE_NAME = cfg.server.name ?? (cfg.server.dir ? basename(expandEnv(cfg.server.dir)) : 'bedmcp');
const TEMPLATE_DIR = expandEnv(cfg.server.dir ?? join(process.env.BEDD_HOME, 'servers', BASE_NAME));
const BASE_SLOT = cfg.slot ?? 1;
const BASE_PORT = cfg.server.port ?? 19140;
const HOST = cfg.server.host ?? '127.0.0.1';
// Where the project lives (build steps, packs, the world to copy).
let SOURCE_DIR = resolve(expandEnv(cfg.server.sourceDir ?? PROJECT_DIR));
const log = (...a) => process.stderr.write(`[bedmcp] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers

function run(cmd, args, opts = {}) {
  return new Promise((res) => {
    execFile(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20, shell: opts.shell ?? false, cwd: opts.cwd, timeout: opts.timeout ?? 600000 },
      (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' }));
  });
}

async function bedd(args, timeout = 300000) {
  const r = await run(BEDD, args, { timeout });
  if (r.code !== 0) throw new Error(`BeDD.exe ${args.join(' ')} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}
const jsonOut = (out, open = '[', close = ']') => { const a = out.indexOf(open), b = out.lastIndexOf(close); return a < 0 ? null : JSON.parse(out.slice(a, b + 1)); };

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] });

// One request over a short-lived WebSocket (a server's endpoint).
async function wsOnce(url, token, op, fields = {}, limit = 15000) {
  const ws = new WebSocket(`${url}?token=${token}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`cannot connect to ${url}`)); });
  try {
    return await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${op}: no reply in ${limit} ms`)), limit);
      ws.onmessage = (ev) => { if (typeof ev.data !== 'string') return; const r = JSON.parse(ev.data); if (r.id === 1) { clearTimeout(timer); r.ok ? res(r) : rej(new Error(`${op}: ${r.error}`)); } };
      ws.send(JSON.stringify({ id: 1, op, ...fields }));
    });
  } finally { try { ws.close(); } catch {} }
}

// ---------------------------------------------------------------- sessions and slots

const STATE = expandEnv(cfg.stateDir ?? '%USERPROFILE%\\.bedd\\bedmcp');
for (const d of ['sessions', 'slots']) mkdirSync(join(STATE, d), { recursive: true });
const ME = process.pid;

const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
function writeJson(f, o) {
  const tmp = `${f}.${ME}.tmp`;
  writeFileSync(tmp, JSON.stringify(o, null, 1));
  for (let i = 0; i < 5; i++) { try { renameSync(tmp, f); return; } catch { /* a reader holds it */ } }
  writeFileSync(f, JSON.stringify(o, null, 1)); safeRm(tmp);
}
const ago = (t) => `${Math.round((Date.now() - t) / 60000)} min ago`;

const me = {
  pid: ME,
  name: `${basename(process.cwd())}#${ME}`,
  activity: '',
  cwd: process.cwd(),
  startedAt: Date.now(),
  lastSeen: Date.now(),
  lastTool: null,
  slot: null,
  project: SOURCE_DIR, // the project folder this session builds and tests (project param can switch it)
  variant: null, // the project variant this session tests (server.variants), null: the project's own
  server: null,  // this session's server name
  player: null,  // the player name of this session's client on its server
};
const sessionFile = (pid) => join(STATE, 'sessions', `${pid}.json`);
const saveMe = () => { try { writeJson(sessionFile(ME), me); } catch (e) { log('state:', e.message); } };

// Live sessions (this one included). Files of dead processes are removed.
function sessions() {
  const out = [];
  for (const f of readdirSync(join(STATE, 'sessions'))) {
    if (!f.endsWith('.json')) continue;
    const s = readJson(join(STATE, 'sessions', f));
    if (!s) continue;
    if (s.pid === ME) { out.push(me); continue; }
    if (!alive(s.pid)) { safeRm(join(STATE, 'sessions', f)); continue; }
    out.push(s);
  }
  return out;
}
const describe = (s) => `${s.name}${s.activity ? ` ("${s.activity}")` : ''} [project ${s.project ?? "?"}, slot ${s.slot ?? '-'}, server ${s.server ?? '-'}${s.variant ? `, variant ${s.variant}` : ''}, last tool ${s.lastTool ?? '-'} ${ago(s.lastSeen)}]`;

// A lock folder: mkdir is atomic. A lock of a dead process is taken over.
async function withLock(name, fn, waitMs = 600000) {
  const dir = join(STATE, `${name}.lock`);
  const end = Date.now() + waitMs;
  for (;;) {
    try { mkdirSync(dir); writeFileSync(join(dir, 'owner'), String(ME)); break; }
    catch {
      let owner = 0, age = 0;
      try { owner = Number(readFileSync(join(dir, 'owner'), 'utf8')) || 0; } catch {}
      try { age = Date.now() - statSync(dir).mtimeMs; } catch { continue; } // released meanwhile
      if (owner && !alive(owner)) { safeRm(dir); continue; }
      if (!owner && age > 10000) { safeRm(dir); continue; }
      if (Date.now() > end) throw new Error(`timed out waiting for the ${name} lock (held by pid ${owner})`);
      await sleep(500);
    }
  }
  try { return await fn(); } finally { safeRm(dir); }
}

const slotOf = (instance) => Number(String(instance ?? '').match(/-(\d+)$/)?.[1] ?? 0);
const LABEL = `bedmcp:${ME}`;
const serverNameOf = (slot) => (slot === BASE_SLOT ? BASE_NAME : `${BASE_NAME}-${slot}`);

// Each session claims a slot: its own client clone and its own server. A slot is free when no live
// session holds it and no game of another live session (or one bedmcp did not start) runs in it.
async function mySlot() {
  if (me.slot) return me.slot;
  const max = cfg.maxClients ?? 3;
  let games = [];
  try { games = jsonOut(await bedd(['ps', '--json'], 30000)) ?? []; } catch {}
  // Windows reuses pids: a holder only counts while its pid is still a node process.
  const nodePids = new Set((await run('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH'])).stdout.split(/\r?\n/).map((l) => Number(l.split('","')[1])).filter(Boolean));
  for (let n = BASE_SLOT; n < BASE_SLOT + max; n++) {
    const f = join(STATE, 'slots', `${n}.json`);
    const holder = readJson(f);
    if (holder && holder.pid !== ME && nodePids.has(holder.pid)) continue;
    const g = games.find((x) => x.kind === 'client' && slotOf(x.instance) === n);
    if (g) {
      const owner = Number(String(g.label ?? '').match(/^bedmcp:(\d+)$/)?.[1] ?? 0);
      if (!owner || (owner !== ME && nodePids.has(owner))) continue; // someone else's game (or an older bedmcp)
    }
    if (holder) safeRm(f);
    try { writeFileSync(f, JSON.stringify({ pid: ME, name: me.name, at: Date.now() }), { flag: 'wx' }); } catch { continue; }
    Object.assign(me, { slot: n, server: serverNameOf(n) }); saveMe();
    return n;
  }
  throw new Error(`no free slot: slots ${BASE_SLOT}..${BASE_SLOT + max - 1} are used by other sessions or games (server_sessions lists them). Raise maxClients in config.json (each slot is a ~800 MB client clone plus a ~600 MB server copy) or end another session.`);
}

// ---------------------------------------------------------------- this session's server

// Vanilla BDS prints "Server started.", LeviLamina's "Server started in (4.6s)!".
const SERVER_READY = /Server started( in|\.)/;

async function srv() {
  const slot = await mySlot();
  const name = serverNameOf(slot);
  const dir = slot === BASE_SLOT ? TEMPLATE_DIR : join(dirname(TEMPLATE_DIR), name);
  return { slot, name, dir, port: BASE_PORT + 2 * (slot - BASE_SLOT) };
}

// LeviLamina writes the whole console (script logs included) to logs\latest.log, started anew at
// every server start. Line numbers are the seq numbers of server_logs.
function readLog(dir) {
  let raw = '';
  try { raw = readFileSync(join(dir, cfg.server.log ?? 'logs\\latest.log'), 'utf8'); } catch { return []; }
  return raw.split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).filter((l) => l.trim()).map((line, i) => ({ seq: i + 1, line }));
}

async function serverInfo(name) {
  const list = jsonOut(await bedd(['server', 'list', '--json'], 30000)) ?? [];
  return list.find((s) => s.name === name) ?? null;
}
// The running server's endpoint, cached while its process lives (each BeDD.exe run costs ~0.5 s).
let serverCache = null;
async function runningServer() {
  const name = (await srv()).name;
  if (serverCache?.name === name && alive(serverCache.pid)) return serverCache;
  const s = await serverInfo(name);
  serverCache = s?.running && s.url ? s : null;
  return serverCache;
}
async function serverOp(op, fields = {}, limit) {
  const s = await runningServer();
  if (!s) throw new Error('this session\'s server is not running (server_start or dev_cycle)');
  return wsOnce(s.url, s.token, op, fields, limit);
}
async function onlinePlayers() {
  try { return ((await serverOp('server', {}, 8000)).players ?? []).map((p) => p.name); } catch { return []; }
}

function levelName(dir) {
  try { return readFileSync(join(dir, 'server.properties'), 'utf8').match(/^level-name=(.*)$/m)?.[1].trim() || 'Bedrock level'; } catch { return 'Bedrock level'; }
}

// Project variants (config server.variants, only in projects that have them): one repository with
// several games, each its own world, script variables and properties. Each session picks the one it
// works on; its test server is set up for it (the project folder itself is never changed). With
// none picked, the variant whose world the project's server.properties names.
let VARIANTS = cfg.server.variants && Object.keys(cfg.server.variants).length ? cfg.server.variants : null;
function variant() {
  if (!VARIANTS) return null;
  if (me.variant && VARIANTS[me.variant]) return { key: me.variant, ...VARIANTS[me.variant] };
  const lvl = levelName(SOURCE_DIR);
  const k = Object.keys(VARIANTS).find((x) => variantWorld(VARIANTS[x]) === lvl);
  return k ? { key: k, inferred: true, ...VARIANTS[k] } : null;
}
function setVariant(v) {
  if (v === undefined || v === null) return;
  if (!VARIANTS?.[v]) throw new Error(`unknown variant "${v}"${VARIANTS ? ` (known: ${Object.keys(VARIANTS).join(', ')})` : ': this project has none'}`);
  me.variant = v; saveMe();
}
const variantWorld = (v) => v?.world ?? v?.levelName ?? null;
// The project's world: the variant's, else config "world" (a folder, or a name in <root>\worlds),
// else the level-name of the project's server.properties, else the only world in <root>\worlds.
// { name, src }: name is the level-name the test server gets. Null when there is none.
const isWorld = (d) => existsSync(join(d, 'level.dat')) || existsSync(join(d, 'db'));
function worldIn(root) {
  const w = variantWorld(variant()) ?? cfg.world;
  if (w) {
    const p = resolve(root, expandEnv(w));
    if (isWorld(p)) return { name: basename(p), src: p };
    return { name: w, src: join(root, 'worlds', w) };
  }
  if (existsSync(join(root, 'server.properties'))) { const n = levelName(root); return { name: n, src: join(root, 'worlds', n) }; }
  let found = [];
  try { found = readdirSync(join(root, 'worlds')).filter((d) => isWorld(join(root, 'worlds', d))); } catch {}
  return found.length === 1 ? { name: found[0], src: join(root, 'worlds', found[0]) } : null;
}
// A git worktree usually has no worlds/ (gitignored): then the main worktree's world is copied
// (read only, like any project world) and the result says so.
function worldSource() {
  const own = worldIn(SOURCE_DIR);
  if (own && existsSync(own.src)) return own;
  const main = mainWorktree(SOURCE_DIR);
  const alt = main ? worldIn(main) : null;
  if (alt && existsSync(alt.src)) return { ...alt, fromMainWorktree: main };
  return own;
}
// The main working tree of the git worktree that holds dir, or null (not a linked worktree).
function mainWorktree(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const g = join(d, '.git');
    if (existsSync(g)) {
      try { if (statSync(g).isDirectory()) return null; } catch { return null; }
      const m = (readFileSync(g, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1] ?? '').trim().replace(/\//g, '\\');
      const at = m.toLowerCase().lastIndexOf('\\.git\\worktrees\\');
      return at > 0 ? m.slice(0, at) : null;
    }
    if (dirname(d) === d) return null;
  }
}
const noWorldMsg = () => `no world to test in: put one world folder in ${join(SOURCE_DIR, 'worlds')}, or set "world" in bedmcp.json (a world folder, relative to the project). bedmcp copies it for every test server and never changes the original.`;
// The server was set up for another variant than the one picked now (it needs a restart).
function variantChanged(s) {
  const v = variant();
  if (!v || SOURCE_DIR === s.dir) return false;
  const mark = readJson(join(s.dir, 'bedmcp-variant.json'));
  return !mark || mark.variant !== v.key || mark.level !== worldSource()?.name;
}
const variantNote = () => {
  const v = variant();
  if (!v) return null;
  return `${v.key} (${v.label ?? variantWorld(v)})${v.inferred ? `, from the project's server.properties; pass variant to pick another (${Object.keys(VARIANTS).join(', ')})` : ''}`;
};

// ---------------------------------------------------------------- the project's packs
// Two layouts:
// - BDS-style: the project is a server folder with development_behavior_packs / _resource_packs and
//   a world that already lists its packs. Each test server's folders are junctions to them whole.
// - Packs: any other repository. Its packs ("behaviorPacks" / "resourcePacks" in bedmcp.json, else
//   every folder with a manifest.json up to 3 levels down) are linked one by one into the test
//   server's development pack folders (junctions "bedmcp_<folder>") and turned on in its world copy.
let BDS_LAYOUT = ['development_behavior_packs', 'development_resource_packs'].some((d) => existsSync(join(SOURCE_DIR, d)));
const SKIP_SCAN = new Set(['node_modules', '.git', 'worlds', 'dist', 'build', 'out', '.regolith', 'development_behavior_packs', 'development_resource_packs']);
function packKind(dir) {
  const types = (readManifest(dir)?.modules ?? []).map((m) => m.type);
  if (types.includes('resources')) return 'resource';
  if (types.some((t) => t === 'data' || t === 'script')) return 'behavior';
  return null;
}
function scanPacks(dir, depth, out) {
  if (depth < 0) return out;
  if (existsSync(join(dir, 'manifest.json'))) { const k = packKind(dir); if (k) out.push({ kind: k, dir }); return out; }
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) if (e.isDirectory() && !SKIP_SCAN.has(e.name) && !e.name.startsWith('.')) scanPacks(join(dir, e.name), depth - 1, out);
  return out;
}
let scanned = null;
// Absolute folders of the project's packs of one kind ('behavior' | 'resource').
function packDirs(kind) {
  const listed = kind === 'behavior' ? cfg.behaviorPacks : cfg.resourcePacks;
  if (listed?.length) return listed.map((p) => resolve(SOURCE_DIR, expandEnv(p)));
  if (BDS_LAYOUT) {
    const root = join(SOURCE_DIR, `development_${kind}_packs`);
    try { return readdirSync(root).map((d) => join(root, d)).filter((d) => existsSync(join(d, 'manifest.json'))); } catch { return []; }
  }
  scanned ??= scanPacks(SOURCE_DIR, 3, []);
  return scanned.filter((p) => p.kind === kind).map((p) => p.dir);
}

const linkTarget = (p) => { try { return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null; } catch { return null; } };
// Every delete goes through safeRm (src/safefs.mjs): it unlinks links instead of entering them and
// refuses any path inside the project or its packs (or one that holds them).
// Additive: after a project switch the earlier project stays protected too.
function guardProject() {
  try {
    const devRoots = ['behavior', 'resource'].map((k) => join(SOURCE_DIR, `development_${k}_packs`));
    protectPaths({ strict: [...packDirs('behavior'), ...packDirs('resource'), ...(BDS_LAYOUT ? devRoots : [])], project: [SOURCE_DIR], own: [STATE] });
  } catch (e) { log('protectPaths:', e.message); }
}
guardProject();

// Points this session at another project folder (a git worktree, another add-on) without restarting
// the MCP: the MCP reads its project folder once at start, and a session that changes folder
// later would otherwise keep building and testing the old one. Machine settings never change.
function applyProject(dir) {
  const d = resolve(expandEnv(dir));
  if (!existsSync(d)) throw new Error(`project folder ${d} does not exist`);
  if (samePath(d, PROJECT_DIR)) return null;
  const prev = PROJECT_DIR;
  PROJECT_DIR = d;
  let next;
  try { next = loadConfig(); } catch (e) { PROJECT_DIR = prev; loadConfig(); throw new Error(`project ${d}: ${e.message}`); }
  cfg = { ...cfg, server: { ...cfg.server, sourceDir: next.server.sourceDir, variants: next.server.variants }, build: next.build, resourcePacks: next.resourcePacks, behaviorPacks: next.behaviorPacks, world: next.world, serverProperties: next.serverProperties };
  CONFIG_ERROR = null;
  SOURCE_DIR = resolve(expandEnv(cfg.server.sourceDir ?? PROJECT_DIR));
  VARIANTS = cfg.server.variants && Object.keys(cfg.server.variants).length ? cfg.server.variants : null;
  BDS_LAYOUT = ['development_behavior_packs', 'development_resource_packs'].some((x) => existsSync(join(SOURCE_DIR, x)));
  scanned = null;
  guardProject();
  if (me.variant && !VARIANTS?.[me.variant]) me.variant = null;
  me.project = SOURCE_DIR; PROJECT_SET = true; saveMe();
  return `project switched to ${SOURCE_DIR} (config: ${CONFIG_SOURCES.at(-1) ?? 'found by looking'})`;
}
const removeSafely = safeRm;
// Junctions the project's packs into a server, so every build is live there.
function linkDevPacks(dir) {
  for (const kind of ['behavior', 'resource']) {
    const sub = `development_${kind}_packs`, dst = join(dir, sub);
    const link = linkTarget(dst);
    if (BDS_LAYOUT) {
      const src = join(SOURCE_DIR, sub);
      if (!existsSync(src) || (link && samePath(link, src))) continue;
      removeSafely(dst);
      symlinkSync(src, dst, 'junction');
      continue;
    }
    if (link) unlinkSync(dst); // the whole-folder link of a BDS-style project
    mkdirSync(dst, { recursive: true });
    const want = new Map(packDirs(kind).map((p) => [`bedmcp_${basename(p)}`, p]));
    for (const e of readdirSync(dst)) {
      const t = linkTarget(join(dst, e));
      if (t && !(want.has(e) && samePath(t, want.get(e)))) unlinkSync(join(dst, e));
    }
    for (const [n, p] of want) {
      const at = join(dst, n);
      if (!existsSync(p)) { if (linkTarget(at)) unlinkSync(at); continue; } // a listed pack that is not there (yet)
      if (!linkTarget(at) && !existsSync(at)) symlinkSync(p, at, 'junction');
    }
  }
}
// A variant's own resource packs (server.variants.<v>.resourcePacks), layered on top of the
// project's for that variant only: linked into the client and put first in the world copy's stack.
const variantPackDirs = (v = variant()) => (v?.resourcePacks ?? []).map((p) => resolve(SOURCE_DIR, expandEnv(p)));
// Resource packs the client links: the variant's first, then the project's.
const clientPackDirs = () => [...new Set([...variantPackDirs(), ...packDirs('resource')])];
// The picked variant's packs go first in this server's world copy (never in the project's world).
function enableVariantPacks(s) {
  if (resolve(SOURCE_DIR).toLowerCase() === resolve(s.dir).toLowerCase()) return null;
  const dirs = variantPackDirs();
  if (!dirs.length) return null;
  const f = join(s.dir, 'worlds', levelName(s.dir), 'world_resource_packs.json');
  if (!existsSync(dirname(f))) return null;
  let list = readJson(f) ?? [];
  const on = [];
  for (const d of [...dirs].reverse()) {
    const h = readManifest(d)?.header;
    if (!h?.uuid) { log(`variant pack ${d}: no manifest`); continue; }
    list = [{ pack_id: h.uuid, version: h.version }, ...list.filter((p) => p.pack_id !== h.uuid)];
    on.unshift(`${h.name ?? basename(d)} ${h.version.join('.')}`);
  }
  writeFileSync(f, JSON.stringify(list, null, 4));
  return on.length ? `variant packs first in the world copy: ${on.join(', ')}` : null;
}

// Packs layout: the world copy lists the project's packs (uuid and current version), so they run.
function enablePacks(s) {
  if (BDS_LAYOUT || resolve(SOURCE_DIR).toLowerCase() === resolve(s.dir).toLowerCase()) return null;
  const world = join(s.dir, 'worlds', levelName(s.dir));
  if (!existsSync(world)) return null;
  const on = [];
  for (const kind of ['behavior', 'resource']) {
    const f = join(world, `world_${kind}_packs.json`);
    let list = readJson(f) ?? [];
    for (const d of packDirs(kind)) {
      const h = readManifest(d)?.header;
      if (!h?.uuid) continue;
      list = [{ pack_id: h.uuid, version: h.version }, ...list.filter((p) => p.pack_id !== h.uuid)];
      on.push(h.name ?? basename(d));
    }
    if (list.length) writeFileSync(f, JSON.stringify(list, null, 4));
  }
  return on.length ? `packs on in the world copy: ${on.join(', ')}` : null;
}

// A new slot's server: a copy of the first slot's server (BDS + LeviLamina + the Be.D.D. module and
// the installed packs), without its world, logs and dev pack links; then Be.D.D. gives it its port.
// The first slot's server itself is made by `BeDD.exe server init` (BDS + LeviLamina through lip).
async function ensureServer(s) {
  if (existsSync(join(s.dir, 'server.properties'))) { linkDevPacks(s.dir); return null; }
  if (samePath(s.dir, TEMPLATE_DIR)) {
    await bedd(['server', 'init', s.name, '--port', String(s.port)], 1800000);
    if (!existsSync(join(s.dir, 'server.properties'))) throw new Error(`BeDD.exe server init ${s.name} ran, but ${s.dir} has no server.properties. Set server.dir in the bedmcp config to the folder Be.D.D. made (BeDD.exe server path ${s.name}).`);
    linkDevPacks(s.dir);
    return `created server ${s.name} at ${s.dir} with BeDD.exe server init (port ${s.port})`;
  }
  if (!existsSync(join(TEMPLATE_DIR, 'server.properties'))) {
    await withLock(`server-${BASE_NAME}`, () => (existsSync(join(TEMPLATE_DIR, 'server.properties')) ? null : bedd(['server', 'init', BASE_NAME, '--port', String(BASE_PORT)], 1800000)));
    if (!existsSync(join(TEMPLATE_DIR, 'server.properties'))) throw new Error(`BeDD.exe server init ${BASE_NAME} ran, but ${TEMPLATE_DIR} has no server.properties. Set server.dir in the bedmcp config to the folder Be.D.D. made (BeDD.exe server path ${BASE_NAME}).`);
  }
  const skip = new Set(['worlds', 'logs', 'development_behavior_packs', 'development_resource_packs'].map((d) => join(TEMPLATE_DIR, d).toLowerCase()));
  cpSync(TEMPLATE_DIR, s.dir, { recursive: true, filter: (p) => !skip.has(p.toLowerCase()) });
  linkDevPacks(s.dir);
  await bedd(['server', 'init', s.name, '--port', String(s.port)], 900000);
  return `created server ${s.name} at ${s.dir} (port ${s.port})`;
}

// Game settings that follow the project's server.properties. Network keys stay the test server's:
// bedmcp's own server.properties (next to config.json) is applied after them, then the port keys.
const SYNCED_PROPS = /^(level-name|gamemode|force-gamemode|difficulty|allow-cheats|max-players|default-player-permission-level|op-permission-level|tick-distance|view-distance|texturepack-required|player-idle-timeout|chat-restriction|disable-player-interaction|client-side-chunk-generation-enabled|block-network-ids-are-hashes|server-authoritative-[a-z-]+|player-movement-action-direction-threshold|player-position-acceptance-threshold|server-build-radius-ratio|allow-list|compression-[a-z]+|disable-client-vibrant-visuals|disable-custom-skins|disable-persona|server-name)=(.*)$/;
const OVERLAY = resolve(here, '..', cfg.server.properties ?? 'server.properties');

function propsOf(file, filter) {
  const out = [];
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.trim().match(/^([a-z0-9-]+)=(.*)$/i);
    if (m && (!filter || filter.test(line.trim()))) out.push([m[1], m[2].trim()]);
  }
  return out;
}

// In a BDS-style project the user may run their own server from the project folder to test by hand. While it
// runs, its LevelDB world is being written: a copy taken then is inconsistent, and nothing of
// bedmcp may read or touch that world. Returns the pids of such servers.
// `fresh`: always look (before copying the world). Otherwise a look up to 30 s old is reused: the
// check runs PowerShell (~1 s) and dev_cycle asks on every cycle while the user's server runs.
let userCheck = { at: 0, pids: [] };
async function userServers({ fresh = false } = {}) {
  if (resolve(SOURCE_DIR).toLowerCase() === resolve(TEMPLATE_DIR).toLowerCase()) return [];
  if (!fresh && Date.now() - userCheck.at < 30000) return userCheck.pids;
  userCheck = { at: Date.now(), pids: await strayServers(SOURCE_DIR) };
  return userCheck.pids;
}
const USER_SERVER_MSG = (pids) => `the user's own server runs from ${SOURCE_DIR} (pid ${pids.join(', ')}), so its world is in use. bedmcp does not copy or touch that world while it runs (a copy taken now could be corrupt). Ask the user to stop their server first; never stop or kill it yourself.`;

function syncLevel(s, { replace = false, fresh = false, userUp = [] } = {}) {
  const notes = [];
  const propsFile = join(s.dir, 'server.properties');
  let props = readFileSync(propsFile, 'utf8');
  const changed = [];
  const set = (k, v) => {
    const re = new RegExp(`^${k}=.*$`, 'm');
    if (re.test(props)) { if (props.match(re)[0].trim() !== `${k}=${v}`) { props = props.replace(re, `${k}=${v}`); changed.push(k); } }
    else { props += `\n${k}=${v}`; changed.push(k); }
  };
  // 1. Game keys from the project, then the variant's. 2. bedmcp's server.properties. 3. Ports.
  const vr = SOURCE_DIR !== s.dir ? variant() : null;
  if (SOURCE_DIR !== s.dir) for (const [k, v] of propsOf(join(SOURCE_DIR, 'server.properties'), SYNCED_PROPS)) set(k, v);
  const ws = SOURCE_DIR !== s.dir ? worldSource() : null;
  if (ws) set('level-name', ws.name);
  for (const [k, v] of Object.entries(cfg.serverProperties ?? {})) set(k, String(v));
  if (vr) for (const [k, v] of Object.entries(vr.properties ?? {})) set(k, String(v));
  for (const [k, v] of propsOf(OVERLAY)) if (!/^server-(port|portv6|udp-ports)$/.test(k)) set(k, v);
  set('server-port', String(s.port));
  set('server-portv6', String(s.port + 1));
  set('server-udp-ports', `${HOST}:${s.port}:${s.port}`);
  if (changed.length) { writeFileSync(propsFile, props); notes.push(`server.properties: ${[...new Set(changed)].join(', ')}`); }
  if (SOURCE_DIR === s.dir) return notes.join('; ') || null;
  // config/ (script module permissions and variables): always the project's.
  const cfgSrc = join(SOURCE_DIR, 'config');
  if (existsSync(cfgSrc)) cpSync(cfgSrc, join(s.dir, 'config'), { recursive: true, force: true });
  // Then the variant's files over it (JSON merged into the project's), only in this server's copy.
  if (vr) {
    for (const [rel, val] of Object.entries(vr.config ?? {})) {
      const f = join(s.dir, 'config', rel);
      mkdirSync(dirname(f), { recursive: true });
      const out = typeof val === 'string' ? val : JSON.stringify({ ...(readJson(f) ?? {}), ...val }, null, 4);
      writeFileSync(f, out);
    }
    writeJson(join(s.dir, 'bedmcp-variant.json'), { variant: vr.key, level: ws?.name, at: Date.now() });
    notes.push(`variant ${vr.key} (${vr.label ?? ws?.name})`);
  }
  // The world: this server's own copy of the project's world. Taken fresh at every server start
  // (server.freshWorldOnStart, default true), so a test never runs on an old map; also when it has
  // none, and on world_import. The replaced copy is backed up first.
  if (!ws || !existsSync(ws.src)) {
    if (ws && existsSync(join(s.dir, 'worlds', ws.name))) { notes.push(`the project has no world ${ws.src}: kept this server's copy`); return notes.join('; '); }
    throw new Error(ws ? `the world ${ws.src} does not exist. ${noWorldMsg()}` : noWorldMsg());
  }
  const { name, src } = ws;
  const dst = join(s.dir, 'worlds', name);
  const want = replace || fresh || !existsSync(dst);
  if (existsSync(src) && want) {
    if (userUp.length) {
      if (existsSync(dst) && !replace) { notes.push(`the user's own server runs: kept this server's older copy of ${name}`); return notes.join('; '); }
      throw new Error(`${existsSync(dst) ? 'cannot import the world' : `this test server has no copy of the world ${name} yet, and cannot take one`}: ${USER_SERVER_MSG(userUp)}`);
    }
    if (existsSync(dst)) { backupWorld(s); safeRm(dst); }
    cpSync(src, dst, { recursive: true });
    writeJson(join(s.dir, 'bedmcp-world.json'), { name, src, sig: worldSig(src), at: Date.now() });
    notes.push(`world ${name} copied fresh from ${src}`);
  }
  return notes.join('; ') || null;
}

// A cheap fingerprint of a world folder (file count, total size, newest change), to tell when the
// project's world changed after a server took its copy.
function worldSig(dir) {
  let n = 0, size = 0, newest = 0;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else { const st = statSync(p); n++; size += st.size; newest = Math.max(newest, st.mtimeMs); } } };
  try { walk(dir); } catch { return null; }
  return `${n}:${size}:${Math.round(newest)}`;
}
// True when the project's world (or its level-name) changed since this server copied it.
function projectWorldChanged(s) {
  if (SOURCE_DIR === s.dir) return false;
  const ws = worldSource();
  if (!ws) return false;
  const mark = readJson(join(s.dir, 'bedmcp-world.json'));
  // Another project or world than the copy's (a slot's server serves every project in turn).
  if (!mark || mark.name !== ws.name || (mark.src && !samePath(mark.src, ws.src))) return true;
  return worldSig(ws.src) !== mark.sig;
}

// Copy the world before every start, keep the newest few per server. Losing a world is not small.
function backupWorld(s) {
  const name = levelName(s.dir);
  const src = join(s.dir, 'worlds', name);
  if (!existsSync(src)) return null;
  const root = expandEnv(cfg.server.backupDir ?? join(STATE, 'backups'));
  mkdirSync(root, { recursive: true });
  const prefix = `${s.name}-${name}-`;
  const dest = join(root, `${prefix}${new Date().toISOString().replace(/[:.]/g, '-')}`);
  cpSync(src, dest, { recursive: true });
  const keep = cfg.server.keepBackups ?? 10;
  const old = readdirSync(root).filter((d) => d.startsWith(prefix)).sort();
  for (const d of old.slice(0, Math.max(0, old.length - keep))) safeRm(join(root, d));
  return dest;
}

// A bedrock_server of this folder that Be.D.D. does not list (starting, stopping, or by hand).
async function strayServers(dir) {
  const r = await run('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name like 'bedrock_server%'\" | ForEach-Object { \"$($_.ProcessId)|$($_.ExecutablePath)\" }"]);
  const d = resolve(dir).toLowerCase();
  return r.stdout.split(/\r?\n/).map((l) => l.trim().split('|')).filter(([pid, path]) => pid && path && dirname(path).toLowerCase() === d).map(([pid]) => pid);
}

// Started by Be.D.D. ("server start"): a hidden BeDD.exe owns its console, so the server outlives
// the MCP; it is reached through its WebSocket (command op) and its log file.
async function serverStart({ timeoutMs = 180000 } = {}) {
  const s = await srv();
  return withLock(`server-${s.name}`, async () => {
    const up = await runningServer();
    if (up) return { alreadyRunning: true, server: s.name, pid: up.pid, world: levelName(s.dir) };
    const created = await ensureServer(s);
    const stray = await strayServers(s.dir);
    if (stray.length) throw new Error(`a bedrock_server of ${s.dir} runs (pid ${stray.join(', ')}) but Be.D.D. does not list it as running; it may still be starting or stopping. Wait and retry. This MCP never kills a server.`);
    // With the user's server up, the test server starts on the copy it already has (if any).
    const userUp = await userServers({ fresh: true });
    const synced = syncLevel(s, { userUp, fresh: cfg.server.freshWorldOnStart !== false });
    const corrupted = join(s.dir, 'worlds', levelName(s.dir), 'CORRUPTED.txt');
    if (existsSync(corrupted)) throw new Error(`the world is marked corrupted (${corrupted}): ${readFileSync(corrupted, 'utf8').trim()}. Restore it (bedmcp\\backups, or world_import from the project) before starting.`);
    const backup = /copied fresh/.test(synced ?? '') ? null : backupWorld(s);
    const packsOn = [enablePacks(s), enableVariantPacks(s)].filter(Boolean).join('; ') || null;
    try { installBotPack(s); } catch (e) { log('bot pack:', e.message); }
    const out = await bedd(['server', 'start', s.name, '--json', '--timeout', String(Math.round(timeoutMs / 1000))], timeoutMs + 30000);
    const info = jsonOut(out, '{', '}') ?? {};
    // Be.D.D. returns once its endpoint listens; the level may still be finishing.
    const end = Date.now() + 60000;
    let lines = readLog(s.dir);
    while (!lines.some((l) => SERVER_READY.test(l.line)) && Date.now() < end) { await sleep(500); lines = readLog(s.dir); }
    const errors = lines.map((l) => l.line).filter((l) => /ERROR|\[Scripting\].*(error|Error)|Exception/.test(l));
    return { server: s.name, pid: info.pid, port: s.port, ready: lines.some((l) => SERVER_READY.test(l.line)), dir: s.dir, world: levelName(s.dir), created, synced: [synced, packsOn].filter(Boolean).join('; ') || null, backup, errors: errors.slice(-40) };
  });
}

// bedmcp's bot pack (botpack/, simulated players): copied into this test server's behavior_packs and
// added to its world copy's pack list, with its own script permissions. Never into the project.
const BOT_PACK = join(here, '..', 'botpack');
const BOT_UUID = readJson(join(BOT_PACK, 'manifest.json'))?.header?.uuid;
function installBotPack(s) {
  if (cfg.bots === false || !BOT_UUID || resolve(SOURCE_DIR).toLowerCase() === resolve(s.dir).toLowerCase()) return null;
  const man = readJson(join(BOT_PACK, 'manifest.json'));
  const dst = join(s.dir, 'behavior_packs', 'bedmcp_bots');
  safeRm(dst);
  cpSync(BOT_PACK, dst, { recursive: true });
  mkdirSync(join(s.dir, 'config', BOT_UUID), { recursive: true });
  writeJson(join(s.dir, 'config', BOT_UUID, 'permissions.json'), { allowed_modules: ['@minecraft/server', '@minecraft/server-gametest'] });
  const listFile = join(s.dir, 'worlds', levelName(s.dir), 'world_behavior_packs.json');
  if (!existsSync(dirname(listFile))) return null;
  const list = (readJson(listFile) ?? []).filter((p) => p.pack_id !== BOT_UUID);
  list.push({ pack_id: BOT_UUID, version: man.header.version });
  writeFileSync(listFile, JSON.stringify(list, null, 4));
  return 'bot pack installed';
}

const pidAlive = async (pid) => (await run('tasklist', ['/FI', `PID eq ${pid}`, '/NH'])).stdout.includes(String(pid));

// Only ever the "stop" command: killing BDS mid-write corrupts the LevelDB world. (BeDD.exe
// server stop kills after 30 s: not used.)
async function serverStop({ timeoutMs = 120000 } = {}) {
  const s = await srv();
  return withLock(`server-${s.name}`, async () => {
    const up = await runningServer();
    if (!up) return { running: false };
    await wsOnce(up.url, up.token, 'command', { command: 'stop', timeoutMs: 5000 }, 8000).catch(() => {}); // no reply may come
    const end = Date.now() + timeoutMs;
    while ((await pidAlive(up.pid)) && Date.now() < end) await sleep(500);
    if (await pidAlive(up.pid)) throw new Error(`the server ${s.name} (pid ${up.pid}) did not stop within ${timeoutMs} ms after "stop"; it was NOT killed (that corrupts the world). Check server_logs.`);
    return { stopped: true, server: s.name, pid: up.pid };
  });
}

async function serverCommand(command, { waitMs = 2000, scriptLogs = false } = {}) {
  const s = await srv();
  const cmd = command.replace(/^\//, '').replace(/[\r\n]+/g, ' ');
  const from = readLog(s.dir).length;
  const r = await serverOp('command', { command: cmd, timeoutMs: Math.max(waitMs, 5000) }, Math.max(waitMs, 5000) + 5000);
  let out = `success=${r.success} count=${r.successCount ?? '-'}\n${(r.output ?? []).join('\n')}`;
  if (scriptLogs) {
    await sleep(Math.min(waitMs, 3000));
    const logs = readLog(s.dir).slice(from).filter((l) => /\[Scripting\]/.test(l.line)).map((l) => l.line);
    out += `\n--- [Scripting] lines meanwhile:\n${logs.join('\n') || '(none)'}`;
  }
  return out;
}

// The packs are the project's (every session's server links to them): one build at a time.
async function runBuild() {
  return withLock('build', async () => {
    const out = [];
    for (const step of cfg.build ?? []) {
      const cwd = resolve(SOURCE_DIR, step.cwd ?? '.');
      const r = await run(step.cmd, step.args ?? [], { cwd, shell: true, timeout: 600000 });
      out.push(`$ ${step.cmd} ${(step.args ?? []).join(' ')}  (in ${cwd}) -> exit ${r.code}\n${(r.stdout + r.stderr).trim().split('\n').slice(-30).join('\n')}`);
      if (r.code !== 0) throw new Error(`build failed:\n${out.join('\n\n')}`);
    }
    const shared = sharingSessions();
    return [`project ${SOURCE_DIR}`, shared.length ? `note: other live sessions use this project's packs and got this build too: ${shared.map((x) => x.name).join(', ')}` : null, out.join('\n\n') || '(no build steps configured)'].filter(Boolean).join('\n');
  });
}

// The player of this session's client, for commands run as the server.
async function target(player) {
  if (player) return player.startsWith('@') ? player : `"${player}"`;
  if (me.player) return `"${me.player}"`;
  const online = await onlinePlayers();
  if (online.length === 1) return `"${online[0]}"`;
  throw new Error(`cannot tell which player is this session's (${online.length ? `online: ${online.join(', ')}` : 'nobody online'}): join first (game_join / dev_cycle) or pass player`);
}

// ---------------------------------------------------------------- Be.D.D. client of this session

const game = { ws: null, pid: null, instance: null, waiting: new Map(), nextId: 1 };

async function findGame() {
  const slot = await mySlot();
  // Connected to a live game: no need to ask BeDD.exe again.
  if (game.ws?.readyState === WebSocket.OPEN && game.url && alive(game.pid)) return { kind: 'client', status: 'ready', instance: game.instance, pid: game.pid, url: game.url, token: game.token };
  const list = jsonOut(await bedd(['ps', '--json'], 30000)) ?? [];
  return list.find((g) => g.kind === 'client' && g.status === 'ready' && slotOf(g.instance) === slot);
}

async function connect() {
  if (game.ws && game.ws.readyState === WebSocket.OPEN) return game;
  const g = await findGame();
  if (!g) throw new Error(`this session's game (slot ${me.slot}) is not running: call game_launch or dev_cycle first`);
  const ws = new WebSocket(`${g.url}?token=${g.token}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`cannot connect to ${g.url}`)); });
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const reply = JSON.parse(ev.data);
    const w = game.waiting.get(reply.id);
    if (w) { game.waiting.delete(reply.id); w(reply); }
  };
  ws.onclose = () => { if (game.ws === ws) game.ws = null; for (const [, w] of game.waiting) w({ ok: false, error: 'connection closed', code: 'closed' }); game.waiting.clear(); };
  Object.assign(game, { ws, pid: g.pid, instance: g.instance, url: g.url, token: g.token });
  return game;
}

async function call(op, fields = {}, timeoutMs) {
  await connect();
  const id = game.nextId++;
  const limit = timeoutMs ?? Math.max(10000, (fields.timeoutMs ?? 0) + 5000);
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { game.waiting.delete(id); rej(new Error(`${op}: no reply in ${limit} ms`)); }, limit);
    game.waiting.set(id, (r) => { clearTimeout(timer); r.ok ? res(r) : rej(Object.assign(new Error(`${op}: ${r.error}${r.code ? ` (${r.code})` : ''}`), { reply: r })); });
    game.ws.send(JSON.stringify({ id, op, ...fields }));
  });
}

// A short-lived extra connection to the game, for work alongside a request that waits (join).
async function sideConnection() {
  const g = await findGame();
  if (!g) throw new Error('no game is running');
  const ws = new WebSocket(`${g.url}?token=${g.token}`);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`cannot connect to ${g.url}`)); });
  const waiting = new Map();
  let next = 1;
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    const r = JSON.parse(ev.data);
    const w = waiting.get(r.id);
    if (w) { waiting.delete(r.id); w(r); }
  };
  return {
    call: (op, fields = {}, limit = 10000) => new Promise((res, rej) => {
      const id = next++;
      const timer = setTimeout(() => { waiting.delete(id); rej(new Error(`${op}: no reply in ${limit} ms`)); }, limit);
      waiting.set(id, (r) => { clearTimeout(timer); r.ok ? res(r) : rej(new Error(`${op}: ${r.error}`)); });
      ws.send(JSON.stringify({ id, op, ...fields }));
    }),
    close: () => { try { ws.close(); } catch {} },
  };
}

// The BeDD mod of a clone must run in ClientServer mode to join a Be.D.D. server; a fresh clone
// has an empty config (verified: slot 2 then times out on join, "Kelp"). Set before the game starts.
const WORLD_MODE = cfg.worldMode ?? 'ClientServer';
async function slotInstance(slot) {
  const list = jsonOut(await bedd(['instance', 'list', '--json'])) ?? [];
  return list.find((i) => i.slot === slot || slotOf(i.name) === slot)?.name ?? null;
}
async function ensureWorldMode(name) {
  const conf = jsonOut(await bedd(['mod', 'config', name]), '{', '}') ?? {};
  if (conf.mode === WORLD_MODE) return false;
  await bedd(['mod', 'config', name, '--world-mode', WORLD_MODE]);
  return true;
}

async function instanceName() {
  if (game.instance) return game.instance;
  const slot = await mySlot();
  const g = await findGame();
  if (g) return (game.instance = g.instance);
  const name = await slotInstance(slot);
  if (!name) throw new Error(`no BeDD instance for slot ${slot} yet: call game_launch first`);
  return name;
}

const dataDirs = new Map(); // instance -> its data folder (fixed for a clone)
async function clientDataDir() {
  const name = await instanceName();
  if (!dataDirs.has(name)) dataDirs.set(name, (await bedd(['instance', 'path', name, 'data'])).split(/\r?\n/)[0].trim());
  return dataDirs.get(name);
}

async function screenshotContent(opts = {}) {
  const shot = await call('screenshot', { format: opts.format ?? 'jpeg', quality: opts.quality ?? 85, maxWidth: opts.maxWidth ?? 1280, ...(opts.region ? { region: opts.region } : {}) });
  return { type: 'image', data: shot.data, mimeType: shot.format === 'png' ? 'image/png' : 'image/jpeg' };
}

async function worldState() { return call('world'); }

// ---------------------------------------------------------------- resource pack sync

function readManifest(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

function findPacks(root, uuid, depth = 9, out = []) {
  if (depth < 0) return out;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.isFile() && e.name === 'manifest.json')) {
    const m = readManifest(root);
    if (m?.header?.uuid?.toLowerCase() === uuid) out.push(root);
    return out;
  }
  for (const e of entries) if (e.isDirectory()) findPacks(join(root, e.name), uuid, depth - 1, out);
  return out;
}

// The project's resource packs are loaded by the client itself, as global resource packs linked
// (junction) to the project folder: no 65 MB download per join, and the client re-reads them from
// disk every time it leaves a world ("Cargando recursos"). So an RP change only needs leave +
// rejoin, no client restart (verified 2026-11-17 with a lang change: ~15 s instead of ~60 s).
// Returns true when the global pack list changed (a running client reads it only at start).
async function linkLocalPacks() {
  const data = await clientDataDir();
  const shared = join(data, 'Users', 'Shared', 'games', 'com.mojang', 'development_resource_packs');
  const users = (() => { try { return readdirSync(join(data, 'Users')).filter((d) => d !== 'Shared'); } catch { return []; } })();
  let changed = false;
  const report = [];
  // Another variant's packs come off the global list (their links stay: unlisted, they do nothing).
  const mine = new Set(clientPackDirs().map((d) => d.toLowerCase()));
  const others = VARIANTS ? Object.values(VARIANTS).flatMap((v) => variantPackDirs(v)).filter((d) => !mine.has(d.toLowerCase())) : [];
  const otherIds = new Set(others.map((d) => readManifest(d)?.header?.uuid).filter(Boolean));
  if (otherIds.size) for (const u of users) {
    const f = join(data, 'Users', u, 'games', 'com.mojang', 'minecraftpe', 'global_resource_packs.json');
    let list = [];
    try { list = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    const kept = list.filter((p) => !otherIds.has(p.pack_id));
    if (kept.length !== list.length) { writeFileSync(f, JSON.stringify(kept, null, 2)); changed = true; report.push(`another variant's packs off for user ${u}`); }
  }
  for (const src of clientPackDirs()) {
    const m = readManifest(src);
    if (!m) { report.push(`skip ${src}: no manifest.json`); continue; }
    mkdirSync(shared, { recursive: true });
    const dst = join(shared, `bedmcp_${basename(src)}`);
    let link = null;
    try { if (lstatSync(dst).isSymbolicLink()) link = readlinkSync(dst); } catch {}
    if (!link || resolve(link).toLowerCase().replace(/[\\/]+$/, '') !== src.toLowerCase()) {
      if (link) unlinkSync(dst); else if (existsSync(dst)) throw new Error(`${dst} exists and is not a link; not touching it`);
      symlinkSync(src, dst, 'junction'); changed = true; report.push(`linked ${dst} -> ${src}`);
    }
    for (const u of users) {
      const f = join(data, 'Users', u, 'games', 'com.mojang', 'minecraftpe', 'global_resource_packs.json');
      let list = [];
      try { list = JSON.parse(readFileSync(f, 'utf8')); } catch {}
      const want = { pack_id: m.header.uuid, version: m.header.version };
      const cur = list.find((p) => p.pack_id === want.pack_id);
      if (cur && JSON.stringify(cur.version) === JSON.stringify(want.version)) continue;
      list = [want, ...list.filter((p) => p.pack_id !== want.pack_id)];
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(list, null, 2)); changed = true; report.push(`global pack ${m.header.name} ${want.version.join('.')} on for user ${u}`);
    }
  }
  return { changed, report: report.join('\n') || 'local packs already linked' };
}

// Deletes the server-pack downloads of the project's packs (minecraftpe\packcache\resource\...),
// so a stale downloaded copy never shadows the linked one. Never follows links.
async function syncPacks() {
  const cache = join(await clientDataDir(), 'minecraftpe', 'packcache');
  const report = [];
  for (const dir of clientPackDirs()) {
    const m = readManifest(dir);
    if (!m) continue;
    const found = findPacks(cache, m.header.uuid.toLowerCase());
    for (const p of found) { if (lstatSync(p).isSymbolicLink()) continue; safeRm(p); report.push(`deleted ${p}`); }
  }
  return report.join('\n') || 'no downloaded copy cached';
}

async function stopClient() {
  if (game.ws) try { game.ws.close(); } catch {}
  game.ws = null;
  await bedd(['stop', await instanceName()]).catch(() => {});
}

async function waitTitle(timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await call('ui', { timeoutMs: 2000 }, 6000); if (/screen start_screen/.test(r.view ?? '')) return; } catch {}
    await sleep(700);
  }
}

// ---------------------------------------------------------------- BedmcpHot (our client mod)

// bedmcp's own LeviLamina client mod (mod/ in this folder): reloads resources in place, inside the
// world. Installed into every clone's mods\ before the game starts (a running game loads mods only
// at start). Talks through two files in its folder: trigger.json (bedmcp) and status.json (mod).
const HOT_BUILD = resolve(here, '..', 'mod', 'bin', 'BedmcpHot');
async function hotModDir() {
  if (game.hotDir && game.hotDirFor === game.instance) return game.hotDir;
  const list = jsonOut(await bedd(['instance', 'list', '--json'])) ?? [];
  const inst = list.find((i) => i.name === (game.instance ?? '') || slotOf(i.name) === me.slot);
  if (!inst) return null;
  Object.assign(game, { hotDir: join(inst.dir, 'mods', 'BedmcpHot'), hotDirFor: game.instance });
  return game.hotDir;
}
// Copies the built mod into this slot's clone when missing or different. True when it changed.
async function installHotMod() {
  if (cfg.hotMod === false || !existsSync(join(HOT_BUILD, 'BedmcpHot.dll'))) return false;
  const dst = await hotModDir();
  if (!dst) return false;
  const same = (f) => { try { return readFileSync(join(HOT_BUILD, f)).equals(readFileSync(join(dst, f))); } catch { return false; } };
  if (same('BedmcpHot.dll') && same('manifest.json')) return false;
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(HOT_BUILD)) cpSync(join(HOT_BUILD, f), join(dst, f), { recursive: true, force: true });
  return true;
}
// Asks the running game's BedmcpHot to do `action` and waits for its answer. Null when the mod is
// not there (not installed, or the game started before it was).
let hotId = Date.now();
async function hotReload(action = 'ping', timeoutMs = 20000) {
  const dir = await hotModDir();
  if (!dir || !existsSync(join(dir, 'status.json'))) return null;
  const id = ++hotId;
  writeFileSync(join(dir, 'trigger.json'), JSON.stringify({ id, action }));
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const st = readJson(join(dir, 'status.json'));
    if (st?.id === id) return st;
    await sleep(50);
  }
  throw new Error(`BedmcpHot did not answer "${action}" within ${timeoutMs} ms (is the game running with the mod loaded?)`);
}

// ---------------------------------------------------------------- game flows

async function launch() {
  const slot = await mySlot();
  const start = async () => jsonOut(await bedd(['launch', '--slot', String(slot), '--json', '--label', LABEL, ...(cfg.exclusiveSignaling ? ['--exclusive-signaling', '--lock-timeout', '2m'] : [])]), '{', '}');
  let name = await slotInstance(slot);
  if (!name) { await bedd(['instance', 'clone', '--slot', String(slot)], 900000); name = await slotInstance(slot); }
  game.instance = name;
  if (name) { await linkLocalPacks().catch((e) => log('local packs:', e.message)); await syncPacks().catch(() => {}); await installHotMod().catch((e) => log('hot mod:', e.message)); }
  let configured = false;
  try { if (name) { await ensureWorldMode(name); configured = true; } } catch { /* the mod is installed by the first launch */ }
  let info = await start();
  if (!name) {
    // A brand-new clone: link the packs now and restart once so the game reads them.
    game.instance = info.instance;
    await linkLocalPacks().catch((e) => log('local packs:', e.message));
    await installHotMod().catch((e) => log('hot mod:', e.message));
    await ensureWorldMode(info.instance).catch(() => false);
    await bedd(['stop', info.instance]).catch(() => {});
    info = await start();
  } else if (!configured && (await ensureWorldMode(info.instance).catch(() => false))) {
    await bedd(['stop', info.instance]).catch(() => {});
    info = await start();
  }
  if (game.ws) try { game.ws.close(); } catch {}
  Object.assign(game, { ws: null, pid: info.pid, instance: info.instance });
  return info;
}

// Join, answering the "download the resource packs?" prompt that texturepack-required raises after
// the cached pack was deleted (Be.D.D.'s join answers the trust prompts but not this one).
const PACK_PROMPT = /button "([^"]*(Download( all| &)?|Descargar todo|Baixar tudo|Tout télécharger|Télécharger|Alle herunterladen|Herunterladen|Scarica tutto|Scarica|Скачать все|Скачать|すべてダウンロード|ダウンロード|全部下载|下载)[^"]*)" \[(e\d+)\]/i;
async function joinServer({ host, port, timeoutMs = 120000 } = {}) {
  const own = !host && !port;
  if (own) { host = HOST; port = (await srv()).port; }
  // Who this client is on the server: only needed until it is known (each lookup costs a BeDD.exe run).
  const before = own && !me.player ? new Set(await onlinePlayers()) : null;
  const joining = call('join', { host, port, wait: true, timeoutMs }, timeoutMs + 10000);
  let settled = false, result, error;
  joining.then((r) => { result = r; }, (e) => { error = e; }).finally(() => { settled = true; });
  // A connection is served in order: watch the screen over a second one while join waits.
  const side = await sideConnection();
  const end = Date.now() + timeoutMs + 10000;
  let accepted = 0;
  try {
    while (!settled && Date.now() < end) {
      await sleep(250);
      try {
        const { view } = await side.call('ui', { timeoutMs: 1500 }, 5000);
        const m = view?.match(PACK_PROMPT);
        if (m) { await side.call('ui', { action: 'click', ref: m[4] }); accepted++; }
      } catch {}
    }
  } finally { side.close(); }
  await joining.catch(() => {});
  if (error) {
    if (own && /join_failed/.test(error.message)) error.message += '. If another clone of the account was in this server since it started, or the client sat on a disconnect screen, dev_cycle retries with a client restart, then a server restart.';
    throw error;
  }
  if (own && before) {
    let fresh = [];
    for (let i = 0; i < 20 && !fresh.length; i++) { const now = await onlinePlayers(); fresh = now.filter((n) => !before.has(n)); if (!fresh.length) await sleep(500); }
    if (fresh.length === 1) { me.player = fresh[0]; saveMe(); }
  }
  return { ...result, server: own ? me.server : `${host}:${port}`, acceptedPackDownload: accepted > 0, player: me.player };
}

// Leaves the world and waits for the title screen. The leave's resource reload ("Cargando
// recursos") starts ~0.6 s after the reply: a join sent before it ends hangs on the loading screen
// (seen 2026-11-17), so callers that rejoin must wait for the title.
async function leave({ waitTitle = true, timeoutMs = 40000 } = {}) {
  let r;
  try { r = await call('join', { host: null, wait: true, timeoutMs: 30000 }, 40000); }
  catch (e) { return { left: false, error: e.message }; }
  if (waitTitle) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try { const w = await worldState(); if (!w.inLevel && /start_screen|hbui/.test(w.topScreen ?? '')) break; } catch {}
      await sleep(100);
    }
  }
  return r;
}

async function waitInLevel(timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  let w;
  while (Date.now() < end) {
    // In the level, and the loading screen ("Cargando…", world_loading_progress_screen) is gone.
    try { w = await worldState(); if (w.inLevel && w.player && !/loading|progress/i.test(w.topScreen ?? '')) { await sleep(300); return w; } } catch {}
    await sleep(150);
  }
  return w;
}

// ---------------------------------------------------------------- MCP

const mcp = new McpServer({ name: 'bedmcp', version: '0.3.0' }, {
  instructions: 'bedmcp opens a real Minecraft client and test server. Starting them (dev_cycle, game_launch, server_start) costs 1-2 minutes, so use these tools ONLY when the user asked for an in-game test or look, or when a question truly cannot be answered from the code, JSON, logs or files. After an ordinary code change, do not open the game on your own: say it was not tested in game and offer to test it. Tools on a session that is already running (screenshot, ui_read, server_command ...) are cheap. Multiplayer with one client: the bot tool adds simulated players (GameTest) to the test server of this session.'
    + (VARIANTS ? ` This project has variants, each a different game with its own world and settings: ${Object.entries(VARIANTS).map(([k, v]) => `"${k}" = ${v.hint ?? v.label ?? variantWorld(v)}`).join('; ')}. Pass variant (dev_cycle, server_start) for the one your work is about; it stays for the session. If the task does not say which, judge by the code you are changing, and ask the user when it is shared code.` : ''),
});
// The folders the Claude client says this session works in (MCP roots), when the client shares
// them; [] otherwise. Only used to warn: a switch of project is always explicit (project param).
let rootsCache = null;
async function clientRoots() {
  if (rootsCache) return rootsCache;
  try {
    if (!mcp.server.getClientCapabilities()?.roots) return [];
    const r = await mcp.server.listRoots(undefined, { timeout: 3000 });
    rootsCache = (r.roots ?? []).map((x) => x.uri).filter((u) => u.startsWith('file:')).map((u) => fileURLToPath(u));
    return rootsCache;
  } catch { return []; }
}
mcp.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => { rootsCache = null; });

// Tools that read the project take an optional `project` folder: it switches this session to it
// (kept for the session). The switch stops this session's server, which served the old project.
const PROJECT_TOOLS = new Set(['setup_check', 'server_sessions', 'build_packs', 'dev_cycle', 'server_start', 'server_restart', 'world_import', 'pack_sync']);
const projectArg = { project: z.string().optional().describe('the project folder to build and test, kept for the session. Pass it when this session works in another folder than the one bedmcp started in (a git worktree, another add-on): bedmcp reads its folder once at start. Switching stops this session\'s server.') };
async function useProject(p) {
  const note = applyProject(p);
  if (!note) return null;
  if (!(await runningServer().catch(() => null))) return note;
  try { await leave(); } catch {}
  await serverStop();
  return `${note}; this session's server was stopped (it served the previous project)`;
}
// Other live sessions on the same project folder: they share its packs, so a build here changes theirs.
const sharingSessions = () => sessions().filter((x) => x.pid !== ME && x.project && samePath(x.project, SOURCE_DIR));
const reg = (name, description, shape, fn) => mcp.tool(name, description, PROJECT_TOOLS.has(name) ? { ...shape, ...projectArg } : shape, async (args) => {
  Object.assign(me, { lastSeen: Date.now(), lastTool: name }); saveMe();
  let switched = null;
  if (args?.project) { try { switched = await useProject(args.project); } catch (e) { return fail(e); } }
  if (CONFIG_ERROR && name !== 'setup_check') return fail(`bedmcp config error: ${CONFIG_ERROR}. Fix it, then reconnect the MCP (setup_check shows what bedmcp sees).`);
  try {
    const r = await fn(args ?? {});
    if (switched && r?.content) r.content.unshift({ type: 'text', text: switched });
    return r;
  } catch (e) { return fail(e); }
});
const num = z.number();
// Only in a project with variants (config server.variants): which one this session tests.
const variantArg = VARIANTS ? {
  variant: z.enum(Object.keys(VARIANTS)).optional().describe(`the project variant to test, kept for the session; switching restarts this session's server on that variant's world. ${Object.entries(VARIANTS).map(([k, v]) => `${k}: ${v.hint ?? v.label ?? variantWorld(v)}`).join('; ')}`),
} : {};
// Picks the variant; with the server up on another one, leaves and stops it so it starts anew.
async function applyVariant(v) {
  setVariant(v);
  const s = await srv();
  if (!variantChanged(s) || !(await runningServer())) return null;
  try { await leave(); } catch {}
  await serverStop();
  return `server stopped: it ran another variant than ${variant().key}`;
}

// --- setup
// What bedmcp sees on this PC and in this project, with the fix for each missing piece. Runs nothing
// that changes the PC.
async function setupCheck() {
  const checks = [];
  const add = (ok, what, detail, fix) => checks.push({ ok, what, detail, ...(ok ? {} : { fix }) });
  add(!CONFIG_ERROR, 'config', CONFIG_ERROR ?? `from: ${CONFIG_SOURCES.join(', ') || '(defaults only)'}`, 'fix the JSON file named above');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add(nodeMajor >= 22, 'Node.js', process.versions.node, 'install Node.js 22 or newer (bedmcp uses its built-in WebSocket)');
  add(process.platform === 'win32', 'Windows', process.platform, 'Minecraft Bedrock (GDK) and Be.D.D. run on Windows only');
  let beddOk = existsSync(BEDD);
  let ver = null;
  if (beddOk) { try { ver = (await bedd(['version'], 30000)).split(/\r?\n/)[0]; } catch (e) { beddOk = false; ver = e.message; } }
  add(beddOk, 'Be.D.D.', beddOk ? `${BEDD} (${ver})` : `not found at ${BEDD}`, 'install Be.D.D. 0.4+ from https://github.com/LiteLDev/BeDD/releases (bedd-windows-x64-setup.exe), or set "bedd" in the bedmcp config');
  if (beddOk) {
    let bases = [];
    try { bases = jsonOut(await bedd(['instance', 'list', '--bases', '--json'], 60000)) ?? []; } catch {}
    const usable = bases.filter((b) => b.usable);
    add(usable.length > 0, 'game instance', usable.length ? usable.map((b) => `${b.name} (${b.gameVersion}, LeviLamina ${b.loaderVersion})${b.selected ? ' [used]' : ''}`).join('; ') : (bases.map((b) => `${b.name}: ${b.reason}`).join('; ') || 'none'), 'in LeviLauncher 1.1+ (https://github.com/LiteLDev/LeviLauncher) make an instance of Minecraft Bedrock 1.26.60 (GDK) with LeviLamina 26.60.x, start it once and sign in');
  }
  const tpl = existsSync(join(TEMPLATE_DIR, 'server.properties'));
  add(true, 'test server', tpl ? `${BASE_NAME} at ${TEMPLATE_DIR} (slot ${BASE_SLOT}, port ${BASE_PORT})` : `${BASE_NAME} not made yet: the first server_start or dev_cycle runs "BeDD.exe server init ${BASE_NAME}" (downloads BDS + LeviLamina, several minutes)`);
  const main = mainWorktree(SOURCE_DIR);
  add(true, 'project folder', `${SOURCE_DIR} (${PROJECT_SET ? 'set with the project param' : `from ${PROJECT_DIR_FROM}, read once when bedmcp started`})${main ? `; a git worktree of ${main}: its own packs and builds, separate from the main folder's` : ''}. Working in another folder now (a worktree, a moved session)? Pass project:"<folder>" to dev_cycle / build_packs / setup_check.`);
  const roots = await clientRoots();
  if (roots.length && !roots.some((r) => inside(r, SOURCE_DIR) || inside(SOURCE_DIR, r))) add(false, 'session folder', `the session works in ${roots.join(', ')}, but bedmcp tests ${SOURCE_DIR}`, `pass project:"${roots[0]}" (or the folder you mean) to switch`);
  const sharing = sharingSessions();
  if (sharing.length) add(true, 'shared packs', `other live sessions use this same project folder, so a build here changes their packs too: ${sharing.map(describe).join('; ')}. To test a branch without touching theirs, use a git worktree and pass project:"<worktree>"`);
  const ws = worldSource();
  const worldOk = !!ws && existsSync(ws.src);
  add(worldOk, 'project world', ws ? `${ws.src}${worldOk ? '' : ' (missing)'}${ws.fromMainWorktree ? ' (this worktree has no world: the main worktree\'s is copied)' : ''}` : 'none found', noWorldMsg());
  const bp = packDirs('behavior'), rp = packDirs('resource');
  add(bp.length + rp.length > 0, 'project packs', `${BDS_LAYOUT ? 'BDS-style folder' : 'packs layout'}; behavior: ${bp.map((d) => basename(d)).join(', ') || '-'}; resource: ${rp.map((d) => basename(d)).join(', ') || '-'}`, 'put packs (folders with manifest.json) in the project, or list them in bedmcp.json ("behaviorPacks", "resourcePacks")');
  add(true, 'build steps', (cfg.build ?? []).map((b) => [b.cmd, ...(b.args ?? [])].join(' ')).join(' && ') || 'none (build_packs and dev_cycle only reload)');
  if (VARIANTS) add(true, 'variants', Object.entries(VARIANTS).map(([k, v]) => `${k}: ${variantWorld(v)}`).join('; '));
  add(true, 'hot mod', cfg.hotMod === false ? 'off' : existsSync(join(HOT_BUILD, 'BedmcpHot.dll')) ? 'BedmcpHot ready (LeviLamina 26.60.x)' : 'not built: rejoins take ~4 s longer');
  add(true, 'bots', cfg.bots === false ? 'off' : 'on (needs the Beta APIs experiment in the world)');
  return { project: SOURCE_DIR, projectDir: PROJECT_DIR, ready: checks.every((c) => c.ok), checks };
}
reg('setup_check', 'Check that bedmcp can run here: Node, Be.D.D., the Minecraft instance, the test server, and what it found in this project (world, packs, build steps, variants), with the fix for anything missing. Cheap; changes nothing. Run it first in a new project or when a tool says something is missing.', {}, async () => text(await setupCheck()));

// --- sessions
reg('server_sessions', 'This session\'s slot and server, and the other Claude sessions that use bedmcp right now (each has its own client and server). Optionally name this session and say what it is testing.', {
  name: z.string().optional().describe('a short name for this session, e.g. "shop UI"'),
  activity: z.string().optional().describe('what this session is doing, e.g. "testing the shop form"'),
  ...(VARIANTS ? { variant: variantArg.variant.describe('pick the project variant for this session (takes effect at the next server start or dev_cycle)') } : {}),
}, async ({ name, activity, variant: v }) => {
  if (name) me.name = `${name}#${ME}`;
  if (activity !== undefined) me.activity = activity;
  setVariant(v);
  const s = await srv();
  saveMe();
  const up = await runningServer().catch(() => null);
  return text({
    me: describe(me),
    variant: variantNote(),
    ...(up && variantChanged(s) ? { note: 'the server runs another variant: the next dev_cycle (or server_restart) switches it' } : {}),
    myServer: { name: s.name, dir: s.dir, port: s.port, running: !!up, pid: up?.pid, players: up ? await onlinePlayers() : [] },
    others: sessions().filter((x) => x.pid !== ME).map(describe),
  });
});

// --- server
reg('server_start', 'Start this session\'s test server (created on first use as a copy of the base server, with its own copy of the project\'s world). Does nothing when it already runs (unless it runs another variant). Optionally build the packs first.', { build: z.boolean().optional(), ...variantArg }, async ({ build, variant: v }) => {
  const switched = await applyVariant(v);
  const b = build ? await runBuild() : null;
  return text({ build: b, variant: variantNote(), switched, ...(await serverStart()) });
});
reg('server_stop', 'Stop this session\'s server cleanly ("stop" command; waits up to 2 min; never kills).', {}, async () => text(await serverStop()));
reg('server_restart', 'Stop and start this session\'s server, optionally building the packs in between. Leaves the world first; does NOT rejoin (use dev_cycle for the full loop: the client must restart too).', { build: z.boolean().optional(), ...variantArg }, async ({ build, variant: v }) => {
  setVariant(v);
  try { await leave(); } catch {}
  await serverStop();
  const b = build ? await runBuild() : null;
  return text({ build: b, variant: variantNote(), ...(await serverStart()) });
});
reg('server_command', 'Run a command on this session\'s server (as the server, full permissions) and return its output. Use "execute as <player> at @s run ..." to act as the player. Examples: "tp Steve 0 80 0", "querytarget @e[type=zombie,r=20]" (JSON with positions), "scriptevent ns:id msg", "reload" (scripts and functions).', { command: z.string(), waitMs: num.optional().describe('max ms to wait (default 2000)'), scriptLogs: z.boolean().optional().describe('also return [Scripting] log lines printed meanwhile') }, async ({ command, waitMs, scriptLogs }) => text(await serverCommand(command, { waitMs, scriptLogs })));
reg('server_logs', 'Read this session\'s server log (logs/latest.log: the whole console, script logs included; it starts anew at every server start). Last N lines, optional regex filter, or only lines after a seq number (line number).', { lines: num.optional(), filter: z.string().optional(), sinceSeq: num.optional() }, async ({ lines = 80, filter, sinceSeq }) => {
  const s = await srv();
  let l = readLog(s.dir);
  const last = l.length;
  if (sinceSeq !== undefined) l = l.filter((x) => x.seq > sinceSeq);
  if (filter) { const re = new RegExp(filter, 'i'); l = l.filter((x) => re.test(x.line)); }
  l = l.slice(-lines);
  const up = await runningServer().catch(() => null);
  return text(`server=${s.name} running=${!!up} lastSeq=${last} players=${up ? (await onlinePlayers()).join(', ') || '-' : '-'}\n` + l.map((x) => `${x.seq}| ${x.line}`).join('\n'));
});
reg('build_packs', 'Run the project build steps ("build" in bedmcp.json) in the project folder. Every session\'s server links to the project\'s dev packs, so other sessions get the build too (scripts on their next reload/restart).', {}, async () => text(await runBuild()));
reg('world_import', 'Replace this session\'s server world with the project\'s current copy of it (level-name of the project). The server must be stopped; the replaced world is backed up first.', { ...variantArg }, async ({ variant: v }) => {
  if (await runningServer()) throw new Error('stop the server first (server_stop)');
  setVariant(v);
  const s = await srv();
  const userUp = await userServers({ fresh: true });
  if (userUp.length) throw new Error(USER_SERVER_MSG(userUp));
  await ensureServer(s);
  return text(syncLevel(s, { replace: true }) ?? 'nothing to import');
});

// --- client lifecycle
reg('game_launch', 'Start (or reuse) this session\'s background Minecraft client (Be.D.D., its own slot). The first time a slot is used it clones the base instance (~800 MB, a minute or two).', {}, async () => {
  const g = await findGame();
  if (g) return text({ alreadyRunning: true, ...g, token: undefined });
  const info = await launch();
  await waitTitle();
  return text({ ...info, token: undefined });
});
reg('game_stop', 'Close this session\'s game client.', {}, async () => {
  if (!(await findGame())) return text('not running');
  await stopClient();
  return text('stopped');
});
reg('game_status', 'Is this session\'s client up, in a world, connected where, which screen is in front, player position and rotation; and this session\'s server.', {}, async () => {
  const s = await srv();
  const up = await runningServer().catch(() => null);
  const server = { name: s.name, port: s.port, running: !!up, pid: up?.pid, players: up ? await onlinePlayers() : [] };
  const g = await findGame();
  if (!g) return text({ running: false, slot: s.slot, server });
  const [world, conn] = await Promise.all([worldState(), call('join')]);
  return text({ running: true, slot: s.slot, instance: g.instance, pid: g.pid, player: me.player, world, connection: conn, server });
});
reg('game_join', 'Join a server (default: this session\'s server). Waits until in the world. Leaving and rejoining with the same running client works (and reloads its resource packs).', { host: z.string().optional(), port: num.optional() }, async (a) => {
  const r = await joinServer(a);
  return text({ join: r, world: await waitInLevel(30000) });
});
reg('session_stop', 'End this session\'s testing: close its game client and stop its server cleanly.', {}, async () => {
  const out = {};
  if (await findGame()) { await stopClient(); out.client = 'stopped'; } else out.client = 'not running';
  out.server = await serverStop();
  return text(out);
});
reg('game_leave', 'Leave the current world/server and wait for the title screen (a join sent earlier hangs). game_join then comes back with the resource packs re-read from disk.', {}, async () => text(await leave()));
reg('pack_sync', 'Link the project\'s resource packs into this session\'s client as global packs (if not yet) and delete any downloaded server copy of them. dev_cycle and game_launch already do it.', {}, async () => text(`${(await linkLocalPacks()).report}\n${await syncPacks()}`));
reg('dev_cycle', 'The test loop in one call on this session\'s own client and server, then a screenshot. Default (fast, ~10 s when the game is already in the world): (build + "reload" for scripts), leave the world, rejoin. The client loads the project\'s resource pack locally and re-reads it from disk when it rejoins (the BedmcpHot mod skips the useless reload on the way out), so RP / JSON UI / HUD / lang / texture changes show after the rejoin without restarting anything. Starts server and client side by side when they are not running (~45 s). restartServer:true (~70-90 s) only for BP JSON changes (entities, items, blocks, recipes), which the server reads at start. restartClient:true restarts the game too (fallback if a change does not show). Script-only change while in the world: build_packs + server_command "reload" is enough (seconds).', {
  build: z.boolean().optional().describe('run the build steps (default true); with the server kept, also "reload"'),
  restartServer: z.boolean().optional().describe('restart the server (default false). Needed for BP JSON changes only'),
  restartClient: z.boolean().optional().describe('restart the game client instead of leave + rejoin (default false)'),
  ...variantArg,
}, async ({ build = true, restartServer = false, restartClient = false, variant: v }) => {
  setVariant(v);
  const steps = [];
  const t0 = Date.now();
  const stamp = (x) => steps.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${x}`);
  const startServer = async () => {
    const st = await serverStart(); stamp(`server ${st.alreadyRunning ? 'kept running' : 'started'}${st.created ? ` (${st.created})` : ''}${st.errors?.length ? ` with ${st.errors.length} error lines` : ''}`);
    if (st.errors?.length) steps.push(...st.errors.map((e) => `   ! ${e}`));
  };
  const freshClient = async () => {
    if (await findGame()) { await stopClient(); stamp('client stopped'); }
    await launch(); await waitTitle(); stamp('client launched');
  };
  try {
    const s = await srv();
    stamp(`project ${SOURCE_DIR}, slot ${s.slot}, server ${s.name} (port ${s.port})${variant() ? `, variant ${variantNote()}` : ''}`);
    if (build) { await runBuild(); stamp('built'); }
    const wasUp = !!(await runningServer());
    // Another variant than the server was set up for: its world, variables and properties change.
    if (wasUp && !restartServer && variantChanged(s)) { restartServer = true; stamp(`switching the server to variant ${variant().key}: restarting it`); }
    // The project's map changed since this server copied it: restart on the new copy (not while the
    // user's own server writes that world: then the copy would not be taken anyway).
    if (wasUp && !restartServer && cfg.server.freshWorldOnStart !== false && projectWorldChanged(s) && !(await userServers()).length) {
      restartServer = true; stamp('the project\'s world changed since this server copied it: restarting the server on a fresh copy');
    }
    // A running client that saw the server restart cannot use that connection: restart it too.
    if (restartServer) restartClient = true;
    let running = await findGame();
    if (running && restartClient) { await stopClient(); stamp('client stopped'); running = null; }
    if (wasUp && restartServer) { await serverStop(); stamp('server stopped'); }
    // Starting the server and launching the client are independent: side by side on a cold start.
    const needServer = !wasUp || restartServer;
    if (needServer && !running) await Promise.all([startServer(), freshClient()]);
    else if (needServer) await startServer();
    else stamp('server kept running');
    if (wasUp && !restartServer && build) { await serverCommand('reload', { waitMs: 3000 }).catch(() => {}); stamp('reload (scripts)'); }
    if (running) {
      // The global pack list is read at game start only: a new pack version needs a client restart.
      const lp = await linkLocalPacks();
      if (lp.changed) { stamp(`local packs changed (${lp.report.replace(/\n/g, '; ')}): restarting the client`); await freshClient(); running = null; }
      else {
        // BedmcpHot skips the leave's reload of the title screen's packs; the join reloads the
        // world's packs from disk anyway (~4 s saved). Armed only inside a world (outside one no
        // leave reload comes, and the join's reload would be the one skipped), and disarmed at the
        // title in case the leave reloaded nothing. No answer to the disarm: restart the client.
        const w = await worldState().catch(() => null);
        const armed = w?.inLevel ? await hotReload('skipleave', 3000).catch(() => null) : null;
        await leave();
        stamp(`left the world${armed ? ' (BedmcpHot: title-screen reload skipped)' : ' (the client reloaded its resource packs)'}`);
        if (armed && !(await hotReload('unskip', 3000).catch(() => null))) {
          stamp('BedmcpHot did not answer "unskip": restarting the client so the join reloads the packs');
          await freshClient();
        }
      }
    }
    if (!(await findGame())) await freshClient();
    const fromSeq = readLog(s.dir).length;
    let j;
    try { j = await joinServer(); }
    catch (e) {
      if (!/join_failed|timeout|did not get|could not connect/.test(e.message)) throw e;
      stamp('join failed: restarting the client and joining again');
      await freshClient();
      try { j = await joinServer(); }
      catch (e2) {
        if (!/join_failed|timeout|did not get|could not connect/.test(e2.message)) throw e2;
        stamp('join failed again: restarting server and client');
        await stopClient(); await serverStop(); await startServer(); await freshClient();
        j = await joinServer();
      }
    }
    stamp(`join: ${JSON.stringify(j)}`);
    const w = await waitInLevel(60000); stamp(`inLevel=${w?.inLevel} pos=${JSON.stringify(w?.player?.eye)}`);
    await sleep(500);
    const errs = readLog(s.dir).slice(fromSeq).filter((l) => /ERROR|error|Exception/.test(l.line)).map((l) => l.line);
    if (errs.length) steps.push('server errors since join:', ...errs.slice(-30));
    return { content: [{ type: 'text', text: steps.join('\n') }, await screenshotContent()] };
  } catch (e) {
    throw new Error(`${steps.join('\n')}\n${((Date.now() - t0) / 1000).toFixed(1)}s FAILED: ${e.message}`);
  }
});

// --- seeing
reg('screenshot', 'Screenshot of this session\'s game (works while the window is hidden). Returns an image.', { maxWidth: num.optional(), region: z.object({ x: num, y: num, w: num, h: num }).optional(), format: z.enum(['jpeg', 'png']).optional() }, async (a) => ({ content: [await screenshotContent(a)] }));
// --- video: screenshots in a loop, encoded by ffmpeg (src/record.mjs)
const recorder = createRecorder({ call, log, outDir: expandEnv(cfg.recordDir ?? join(STATE, 'recordings')), ffmpeg: expandEnv(cfg.ffmpeg ?? 'ffmpeg') });
reg('record', 'Record a video (MP4 or GIF) of this session\'s game, for the user to watch. ONLY when the user asks for a video or recording; screenshots are enough otherwise. "clip" records `seconds` and returns the file; "start" records in the background while you act with other tools (move, ui_click, bot, dev_cycle ...), then "stop" returns the file; "status" tells what is recording. Frames are captured from the game itself, so it works with the window hidden and the monitor off: ~25-30 fps captured (about 20+ distinct fps while moving, measured), no sound. Needs ffmpeg. Give the returned file to the user (e.g. send it as a file).', {
  action: z.enum(['clip', 'start', 'stop', 'status']),
  seconds: num.optional().describe('clip: length; start: the most it records before stopping by itself (default 60, max 600)'),
  fps: num.optional().describe('frames per second to capture (default 30, max 30)'),
  format: z.enum(['mp4', 'gif']).optional().describe('mp4 (default) or gif (small, max 15 fps, 640 px wide)'),
  maxWidth: num.optional().describe('frame width in pixels (default 1280)'),
  name: z.string().optional().describe('a short name for the file, e.g. "shop-form"'),
}, async (a) => {
  if (a.action === 'status') return text(recorder.status());
  if (a.action === 'stop') return text(await recorder.stop());
  if (!(await findGame())) throw new Error('this session\'s game is not running: game_launch or dev_cycle first');
  return text(a.action === 'clip' ? await recorder.clip(a) : await recorder.start(a));
});
reg('ui_read', 'Read the screen in front as text: controls with refs like [e1]. Covers menus, forms of the server (action/modal forms), chat, inventory screens. The HUD of in-game play is not read: use screenshot for that.', { find: z.string().optional(), ref: z.string().optional(), scope: z.string().optional(), maxNodes: num.optional() }, async (a) => {
  const r = await call('ui', a);
  return text(r.view ?? r);
});
reg('ui_click', 'Click a control by its ref from ui_read. Returns what changed.', { ref: z.string(), button: z.enum(['left', 'right']).optional() }, async (a) => {
  const r = await call('ui', { action: 'click', ...a });
  return text({ changed: r.changed, target: r.target, screen: r.screen, view: r.view });
});
reg('ui_type', 'Type into a text box by ref (clears it first), optionally press Enter.', { ref: z.string(), text: z.string(), submit: z.boolean().optional() }, async (a) => {
  const r = await call('ui', { action: 'setText', ...a });
  return text({ changed: r.changed, target: r.target, screen: r.screen, view: r.view });
});
reg('ui_scroll', 'Scroll a control by ref (positive = down).', { ref: z.string(), notches: num.optional() }, async (a) => text(await call('ui', { action: 'scroll', ...a })));
reg('wait_for_screen', 'Poll the UI until some text appears on the screen in front (or timeout).', { contains: z.string(), timeoutMs: num.optional() }, async ({ contains, timeoutMs = 15000 }) => {
  const end = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < end) {
    try { const r = await call('ui', {}); last = r.view ?? ''; if (last.toLowerCase().includes(contains.toLowerCase())) return text(last); } catch (e) { last = e.message; }
    await sleep(500);
  }
  return fail(`"${contains}" did not appear in ${timeoutMs} ms. Last view:\n${last}`);
});
reg('player_state', 'Position, rotation, held slot of this session\'s player, and the front screen.', {}, async () => text({ player: me.player, ...(await worldState()) }));

// --- acting
reg('teleport', 'Teleport this session\'s player (server tp). Optional facing via yaw/pitch.', { x: num, y: num, z: num, yaw: num.optional(), pitch: num.optional(), player: z.string().optional() }, async ({ x, y, z: zz, yaw, pitch, player }) => {
  const rot = yaw !== undefined ? ` ${yaw} ${pitch ?? 0}` : '';
  return text(await serverCommand(`tp ${await target(player)} ${x} ${y} ${zz}${rot}`));
});
reg('interact_block', 'Use a block like a player would (right click): teleport next to it on the chosen side, aim at its centre and press "use". Opens stations, chests, shops; then ui_read shows the screen it opened.', {
  x: num, y: num, z: num,
  side: z.enum(['north', 'south', 'east', 'west']).optional().describe('which side to stand on (default south = +z)'),
  distance: num.optional().describe('blocks from the block centre (default 2)'),
  button: z.enum(['use', 'attack']).optional(),
}, async ({ x, y, z: zz, side = 'south', distance = 2, button = 'use' }) => {
  const dir = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[side];
  const c = { x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5, z: Math.floor(zz) + 0.5 };
  const feet = { x: c.x + dir[0] * distance, y: Math.floor(y), z: c.z + dir[1] * distance };
  const eye = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  const d = { x: c.x - eye.x, y: c.y - eye.y, z: c.z - eye.z };
  const yaw = (Math.atan2(-d.x, d.z) * 180) / Math.PI;
  const pitch = (-Math.atan2(d.y, Math.hypot(d.x, d.z)) * 180) / Math.PI;
  const tp = await serverCommand(`tp ${await target()} ${feet.x} ${feet.y} ${feet.z} ${yaw.toFixed(1)} ${pitch.toFixed(1)}`, { waitMs: 1500 });
  await sleep(300);
  await call('look', { yaw, pitch });
  const b = await call('button', { button, action: 'click' }).catch((e) => ({ error: e.message }));
  await sleep(1200);
  let view = '';
  try { view = (await call('ui', { timeoutMs: 2000 })).view; } catch (e) { view = e.message; }
  return text(`${tp}\nlooked at ${c.x} ${c.y} ${c.z} (yaw ${yaw.toFixed(1)}, pitch ${pitch.toFixed(1)})\n${button}: ${JSON.stringify(b.block ?? b.error ?? b.held)}\n\n${view}`);
});
reg('look', 'Turn the client camera to yaw/pitch (degrees; yaw 0 = +Z, 90 = -X; pitch -90 = up).', { yaw: num, pitch: num }, async (a) => text(await call('look', a)));
reg('move', 'Walk with the client for a time: x = strafe (-1..1, +1 = left), z = forward (-1..1). jump/sneak/sprint optional.', { x: num.optional(), z: num.optional(), jump: z.boolean().optional(), sneak: z.boolean().optional(), sprint: z.boolean().optional(), ms: num.optional() }, async ({ x = 0, z: zz = 0, jump, sneak, sprint, ms = 1000 }) => {
  const r = await call('input', { move: { x, z: zz }, jump, sneak, sprint, ttlMs: ms });
  await sleep(ms + 100);
  return text({ input: r, world: await worldState() });
});
reg('hotbar', 'Select a hotbar slot 0..8.', { slot: num }, async (a) => text(await call('slot', a)));
reg('mouse_button', 'Attack/use/pick on what the crosshair targets (click, or down/up to hold).', { button: z.enum(['attack', 'use', 'pick']), action: z.enum(['click', 'down', 'up']).optional(), holdTicks: num.optional() }, async (a) => text(await call('button', a)));
reg('game_action', 'drop | dropAll | inventory | perspective | pause | swing.', { name: z.enum(['drop', 'dropAll', 'inventory', 'perspective', 'pause', 'swing']) }, async (a) => text(await call('action', a)));
reg('key', 'Press/hold/release a key in the game window (names like E, ESC, ENTER, SPACE, LSHIFT, F1, SLASH, T, UP).', { key: z.string(), action: z.enum(['press', 'down', 'up']).optional(), holdMs: num.optional() }, async (a) => text(await call('key', a)));
reg('type_text', 'Type characters into whatever has focus (a chat line, a text box).', { text: z.string() }, async (a) => text(await call('text', a)));
reg('mouse', 'Move/click the mouse in the game window at client pixels (x,y) or fractions (rx,ry), or on a UI ref.', { action: z.enum(['move', 'down', 'up', 'click', 'wheel']).optional(), x: num.optional(), y: num.optional(), rx: num.optional(), ry: num.optional(), ref: z.string().optional(), button: z.enum(['left', 'right', 'middle']).optional(), notches: num.optional() }, async (a) => text(await call('mouse', a)));
reg('client_chat', 'Send a chat line or a /command FROM THE CLIENT (as the player, with the player\'s permissions) by opening chat and typing. Use server_command when you want output.', { message: z.string() }, async ({ message }) => {
  await call('key', { key: 'T' });
  await sleep(400);
  await call('text', { text: message });
  await sleep(150);
  await call('key', { key: 'ENTER' });
  await sleep(500);
  // Bedrock keeps the chat open after sending: close it so the game takes input again.
  // ESC does nothing while its text box has focus; its exit button ("Salir"/"Atrás"/"Back") does.
  try {
    const view = (await call('ui', { timeoutMs: 1500 })).view ?? '';
    if (/screen chat_screen/.test(view)) {
      const m = view.match(/button "(Salir|Atrás|Back|Exit|Close|Cerrar)" \[(e\d+)\]/);
      if (m) await call('ui', { action: 'click', ref: m[2] });
      else await call('key', { key: 'ESC' });
      await sleep(300);
    }
  } catch {}
  return text('sent (chat closed again)');
});
reg('release_input', 'Release every held key/button and stop movement.', {}, async () => text(await call('release')));

// --- inspecting
// --- bots (simulated players of bedmcp's bot pack, on this session's server)
// A request is a /scriptevent; the pack answers with one log line "BEDMCPBOT#<id> <json>".
async function botCall(q, timeoutMs) {
  const s = await srv();
  if (cfg.bots === false) throw new Error('bots are off in bedmcp config ("bots": false)');
  const id = Math.random().toString(36).slice(2, 10);
  const from = readLog(s.dir).length;
  const body = JSON.stringify({ ...Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined)), id });
  await serverOp('command', { command: `scriptevent bedmcp:bot ${body}`, timeoutMs: 5000 }, 10000);
  const tag = `BEDMCPBOT#${id} `;
  const end = Date.now() + timeoutMs;
  const done = (r) => { if (r.error) throw new Error(`bot ${q.op}: ${r.error}`); delete r.ok; return r; };
  let viaCmd = true;
  while (Date.now() < end) {
    // The pack's custom command hands the reply over directly; the log line is the fallback.
    if (viaCmd) {
      const c = await serverOp('command', { command: `bedmcp:botreply ${id}`, timeoutMs: 3000 }, 6000).catch(() => null);
      const out = (c?.output ?? []).join(' ');
      if (c?.success && out.includes('{')) return done(JSON.parse(out.slice(out.indexOf('{'))));
      if (/unknown command|syntax error|not exist/i.test(out)) viaCmd = false; // an older pack: log only
    }
    const hit = readLog(s.dir).slice(from).find((l) => l.line.includes(tag));
    if (hit) {
      let r;
      try { r = JSON.parse(hit.line.slice(hit.line.indexOf(tag) + tag.length)); } catch { await sleep(100); continue; } // the line is still being written
      return done(r);
    }
    await sleep(150);
  }
  const loaded = readLog(s.dir).some((l) => l.line.includes('BEDMCPBOT#load'));
  const errs = readLog(s.dir).map((l) => l.line).filter((l) => /bedmcp_bots|d91f22b9|bedmcp bots/i.test(l) && /error|fail|missing|invalid/i.test(l));
  throw new Error(`no answer from the bot pack within ${timeoutMs} ms. ${loaded ? 'It loaded at server start, so the op may still be running (raise timeoutSec), or a script reload is in progress.' : 'It did not load: a server started by an older bedmcp has no bot pack (server_restart installs it), or the world lacks the Beta APIs experiment that @minecraft/server-gametest needs.'}${errs.length ? `
log: ${errs.slice(-5).join('; ')}` : ''}`);
}

const xyz = z.array(num).length(3);
reg('bot', 'Simulated players (GameTest) on the test server of this session, to test multiplayer with ONE client: your real client plus bots that are real Player objects to the game scripts (getAllPlayers, damage, death, items, tags, chat). They have no screen (no forms, HUD or client UI), no player properties (player.json properties), and taps on entities may not raise playerInteractWithEntity (seen on BDS 1.26.x). Ops: spawn (name, at or next to your player, gameMode), list, remove (name or "all"), move (at or target; mode navigate|straight|relative with dir [leftRight, forward]; wait:true waits until within 1.5 blocks), stop, look (at or target), attack (target, count), interact (target, or at = block + face), use (slot, optional at = block), give (item, count, slot), hotbar (slot), chat (message), jump, sneak/sprint (on), break (at), respawn, command (run as the bot, e.g. "tp @s ~ ~5 ~"). target: "@client" (nearest real player), a player or bot name, an entity id, or a type like "minecraft:zombie" (nearest). With one bot, name can be omitted. Bots leave when the server stops; bots and the real client share nothing else, so this needs no second account.', {
  op: z.enum(['spawn', 'list', 'remove', 'move', 'stop', 'look', 'attack', 'interact', 'use', 'give', 'hotbar', 'chat', 'jump', 'sneak', 'sprint', 'break', 'respawn', 'command', 'ping']),
  name: z.string().optional().describe('the bot (spawn: its name, default Bot1, Bot2...)'),
  at: z.union([xyz, z.string()]).optional().describe('[x, y, z] (blocks for interact/use/break) or a target whose position to use'),
  target: z.string().optional().describe('"@client", a player/bot name, an entity id or an entity type'),
  dimension: z.string().optional().describe('spawn with at: overworld (default), nether, the_end'),
  gameMode: z.enum(['survival', 'creative', 'adventure', 'spectator']).optional(),
  mode: z.enum(['navigate', 'straight', 'relative']).optional().describe('move: navigate (pathfinding, default), straight, relative (dir)'),
  dir: z.array(num).length(2).optional().describe('move relative: [leftRight, backwardForward], e.g. [0, 1] forward'),
  speed: num.optional(),
  wait: z.boolean().optional().describe('move: wait until it arrives (timeoutSec, default 20)'),
  timeoutSec: num.optional(),
  face: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional(),
  slot: num.optional().describe('hotbar slot 0-8 (give, use, hotbar)'),
  item: z.string().optional().describe('give: item id, e.g. minecraft:diamond_sword'),
  count: num.optional().describe('give: amount; attack: number of hits'),
  holdTicks: num.optional().describe('use/break: keep using for this many ticks'),
  message: z.string().optional().describe('chat'),
  on: z.boolean().optional().describe('sneak/sprint: on (default) or off'),
  command: z.string().optional().describe('command: run as the bot'),
}, async (a) => {
  const q = { ...a };
  const t = a.op === 'move' && a.wait ? (a.timeoutSec ?? 20) * 1000 + 5000 : a.op === 'attack' ? 5000 + (a.count ?? 1) * 600 : a.op === 'use' || a.op === 'break' ? 5000 + (a.holdTicks ?? 0) * 50 : 10000;
  return text(await botCall(q, t));
});

// ---------------------------------------------------------------- walking, aiming, sequences
// The real client walks like a player: it turns toward the target and holds "forward", correcting
// several times a second and jumping when it stops making progress. Straight line, no path search.
const EYE = 1.62;
const toVec = (p) => (Array.isArray(p) ? { x: +p[0], y: +p[1], z: +p[2] } : p);
async function myEye() {
  const w = await worldState();
  if (!w.inLevel || !w.player?.eye) throw new Error('the client is not in a world');
  return { eye: w.player.eye, rot: w.player.rot, world: w };
}
// A target is [x, y, z] or a bot-pack target ("@client" is not useful here: a player/bot name,
// an entity id, or a type like "minecraft:zombie", the nearest to this session's player).
async function locate(t) {
  if (Array.isArray(t) || (t && typeof t === 'object')) { const v = toVec(t); return { at: v, eye: { ...v, y: v.y + 0.5 } }; }
  const r = await botCall({ op: 'locate', target: t, from: me.player ?? undefined }, 6000);
  return { at: r.at, eye: r.eye, who: { type: r.type, id: r.id, name: r.name } };
}
const aim = (from, to) => {
  const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  return { yaw: (Math.atan2(-d.x, d.z) * 180) / Math.PI, pitch: (-Math.atan2(d.y, Math.hypot(d.x, d.z)) * 180) / Math.PI };
};
async function lookAt(t) {
  const [{ eye }, tgt] = await Promise.all([myEye(), locate(t)]);
  const a = aim(eye, tgt.eye);
  await call('look', a);
  return { ...a, target: tgt.who ?? tgt.at };
}
async function walkTo(t, { within = 1.3, sprint = false, timeoutSec = 30, closeScreens = false } = {}) {
  const started = Date.now(), end = started + timeoutSec * 1000;
  let tgt = await locate(t), lastLocate = Date.now();
  let best = Infinity, bestAt = Date.now(), jumps = 0, dist = Infinity, eye, blockedBy = null, closed = [];
  try {
    while (Date.now() < end) {
      if (typeof t === 'string' && Date.now() - lastLocate > 500) { tgt = await locate(t); lastLocate = Date.now(); } // a moving target
      let w;
      ({ eye, world: w } = await myEye());
      // A screen (a server form, a menu) takes the input: close it, or stop and say which.
      if (w.showingMenu || (w.topScreen && !/hud_screen/.test(w.topScreen))) {
        if (closeScreens && closed.length < 5) { closed.push(w.topScreen); await call('key', { key: 'ESC' }); await sleep(400); bestAt = Date.now(); continue; }
        blockedBy = w.topScreen ?? 'a menu'; break;
      }
      dist = Math.hypot(tgt.at.x - eye.x, tgt.at.z - eye.z);
      if (dist <= within) break;
      if (dist < best - 0.15) { best = dist; bestAt = Date.now(); }
      const stuck = Date.now() - bestAt > 700;
      if (stuck) { jumps++; bestAt = Date.now(); }
      if (jumps > 8 && Date.now() - started > 6000 && best > within * 3) break; // a wall: give up early
      const { yaw } = aim(eye, tgt.eye);
      await call('look', { yaw, pitch: 0 });
      // Slow down near the end: speed effects (a game's own perks) would overshoot the target.
      const near = dist < within + 2.5;
      await call('input', { move: { x: 0, z: near ? Math.max(0.25, Math.min(1, (dist - within) / 2.5)) : 1 }, sprint: sprint && !near, jump: stuck, ttlMs: near ? 150 : 350 });
      await sleep(near ? 60 : 120);
    }
  } finally {
    await call('input', { move: { x: 0, z: 0 }, ttlMs: 50 }).catch(() => {});
  }
  const feet = eye ? { x: +eye.x.toFixed(2), y: +(eye.y - EYE).toFixed(2), z: +eye.z.toFixed(2) } : null;
  return { arrived: dist <= within, distance: +dist.toFixed(2), seconds: +((Date.now() - started) / 1000).toFixed(1), jumps, at: feet, target: tgt.who ?? tgt.at, ...(blockedBy ? { blockedBy, note: 'a screen opened and takes the input: close it (key ESC, ui_read + ui_click) or pass closeScreens' } : {}), ...(closed.length ? { closedScreens: closed } : {}) };
}
async function clearScreen(close) {
  const w = await worldState();
  if (!(w.showingMenu || (w.topScreen && !/hud_screen/.test(w.topScreen)))) return null;
  if (!close) throw new Error(`a screen is open (${w.topScreen}): close it first (key ESC, or ui_read + ui_click), or pass closeScreens`);
  await call('key', { key: 'ESC' }); await sleep(400);
  return w.topScreen;
}
async function clientAttack(t, count = 1, gapMs = 450, close = false) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const closed = await clearScreen(close);
    if (closed) out.push({ closedScreen: closed });
    if (t) await lookAt(t);
    // A simulated left click at the crosshair: Be.D.D.'s button op holds 'attack' but does not hit
    // entities (verified: no entityHitEntity), the click does.
    const r = await call('mouse', { action: 'click', button: 'left', rx: 0.5, ry: 0.5 }).catch((e) => ({ error: e.message }));
    const { id: _i, ok: _o, ...rest } = r; out.push(r.error ? { error: r.error } : rest);
    if (i < count - 1) await sleep(gapMs);
  }
  if (out.every((r) => r.error || r.closedScreen)) throw new Error(`no attack went through: ${JSON.stringify(out)}`);
  return { clicks: count, results: out };
}

// The world journal of bedmcp's pack (events of the Script API, tracked positions, TPS).
async function eventsRead({ since = 0, filter, max = 300 } = {}) {
  const all = [];
  let cursor = since, more = true, dropped = 0, on = false;
  while (more && all.length < max) {
    const r = await botCall({ op: 'events_read', since: cursor, filter, max: Math.min(120, max - all.length) }, 8000);
    all.push(...r.events); cursor = r.cursor; more = r.more; dropped = r.dropped; on = r.on;
    if (!r.events.length && !more) break;
  }
  return { on, cursor, more, dropped, events: all };
}
const compactEvent = (e) => {
  const { n, ...rest } = e;
  return JSON.stringify(rest);
};
function summarize(events) {
  const counts = {};
  for (const e of events) counts[e.ev] = (counts[e.ev] ?? 0) + 1;
  return counts;
}
const NOISY = /^(perf|pos)$/;

reg('walk_to', 'Walk this session\'s real client to a point or an entity like a player would (turns, holds forward, jumps over small steps; straight line, no path search). target: [x, y, z], a player/bot name, an entity id, or a type like "minecraft:zombie" (the nearest). Returns arrived, distance, time. No teleport: zones, triggers and collisions on the way happen for real.', {
  target: z.union([xyz, z.string()]),
  within: num.optional().describe('stop this close, in blocks (default 1.3; use ~2.5 before attacking)'),
  closeScreens: z.boolean().optional().describe('press ESC on forms or menus that open on the way (default: stop and name the screen)'),
  sprint: z.boolean().optional(),
  timeoutSec: num.optional().describe('default 30'),
}, async (a) => text(await walkTo(a.target, a)));

reg('world_events', 'A journal of what happens on this session\'s server, from the Script API: spawn, remove, die, hurt (damage, cause, attacker, health), hit, pickup, drop, effect, trigger, join/leave, break/place/interact, item use, slot, chat, scriptevent, plus "pos" (tracked entities every few ticks) and "perf" (TPS and tick ms every second). start {track, every} clears and starts it; read {since, filter} returns events as JSON lines (filter: regex on the event name, e.g. "hurt|die"); stop ends it; tps gives TPS and tick times now. sequence uses it by itself.', {
  action: z.enum(['start', 'read', 'stop', 'tps']),
  track: z.array(z.string()).optional().describe('start: entities whose position to log: types ("minecraft:zombie"), player/bot names or ids'),
  every: num.optional().describe('start: ticks between tracked positions (default 10)'),
  perfEvery: num.optional().describe('start: ticks between perf events (default 20, 0 = off)'),
  since: num.optional().describe('read: the cursor from the previous read or start'),
  filter: z.string().optional(),
  max: num.optional().describe('read: most events (default 300)'),
  seconds: num.optional().describe('tps: window (default 5)'),
}, async (a) => {
  if (a.action === 'start') return text(await botCall({ op: 'events_start', track: a.track, every: a.every, perfEvery: a.perfEvery }, 6000));
  if (a.action === 'stop') return text(await botCall({ op: 'events_stop' }, 6000));
  if (a.action === 'tps') return text(await botCall({ op: 'tps', seconds: a.seconds }, 6000));
  const r = await eventsRead(a);
  return text(`cursor=${r.cursor} on=${r.on} more=${r.more} dropped=${r.dropped} counts=${JSON.stringify(summarize(r.events))}\n${r.events.map(compactEvent).join('\n') || '(no events)'}`);
});

// Script profiler of the test server (BDS "script profiler start|stop"): writes a .cpuprofile of the
// scripts' CPU time; bedmcp sums self time per function so the hot spots read as a list.
function cpuProfileTop(file, top = 25) {
  const p = JSON.parse(readFileSync(file, 'utf8'));
  const nodes = new Map(p.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const deltas = p.timeDeltas ?? [];
  (p.samples ?? []).forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (deltas[i] ?? 0)));
  const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
  const byFn = new Map();
  for (const [id, us] of self) {
    const cf = nodes.get(id)?.callFrame ?? {};
    const where = cf.url ? cf.url.split(/[\\/]/).filter(Boolean).slice(-3).join('/') : '';
    const key = `${(cf.functionName || '(anonymous)').split('\n')[0]} ${where ? `${where}:${(cf.lineNumber ?? 0) + 1}` : ''}`.trim();
    byFn.set(key, (byFn.get(key) ?? 0) + us);
  }
  // The runtime's scheduler loop (scheduling.js) and idle/program samples are time the scripts
  // did not use: 'busyPct' is a function's share of the scripts' own time.
  const IDLE = /scheduling\.js|^\((idle|program|root)\)/;
  const busy = [...byFn.entries()].filter(([k]) => !IDLE.test(k)).reduce((a, [, us]) => a + us, 0) || 1;
  const rows = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([fn, us]) => ({ fn, ms: +(us / 1000).toFixed(1), pct: +((us / total) * 100).toFixed(1), ...(IDLE.test(fn) ? { idle: true } : { busyPct: +((us / busy) * 100).toFixed(1) }) }));
  return { file, totalMs: +(total / 1000).toFixed(1), scriptsBusyMs: +(busy / 1000).toFixed(1), samples: (p.samples ?? []).length, top: rows };
}
function newestProfile(dir, after) {
  let best = null;
  const walk = (d, depth) => {
    if (depth < 0) return;
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!['worlds', 'behavior_packs', 'resource_packs', 'development_behavior_packs', 'development_resource_packs', 'plugins', 'definitions'].includes(e.name)) walk(p, depth - 1); }
      else if (e.name.endsWith('.cpuprofile')) { const m = statSync(p).mtimeMs; if (m >= after && (!best || m > best.m)) best = { p, m }; }
    }
  };
  walk(dir, 3);
  return best?.p ?? null;
}
let profilerStarted = 0;
async function profilerStart() { profilerStarted = Date.now() - 1000; return serverCommand('script profiler start', { waitMs: 3000 }); }
async function profilerStop() {
  const s = await srv();
  const out = await serverCommand('script profiler stop', { waitMs: 5000 });
  let file = (out.match(/[A-Za-z]:[^"\r\n]*?\.cpuprofile/) ?? [])[0] ?? null;
  for (let i = 0; i < 20 && !(file && existsSync(file)); i++) { await sleep(300); file = newestProfile(s.dir, profilerStarted); }
  if (!file) return { output: out, note: `no .cpuprofile found under ${s.dir}` };
  return { output: out.split('\n').slice(0, 3).join(' '), ...cpuProfileTop(file) };
}
reg('profiler', 'Script CPU profiler of this session\'s test server ("script profiler start/stop"): start, do the thing to measure (dev_cycle, sequence, bots ...), stop: returns the .cpuprofile file and the functions that took the most time (self time, ms and %). Open the file in Chrome DevTools or VS Code for the full view.', {
  action: z.enum(['start', 'stop']),
  top: num.optional().describe('stop: how many functions to list (default 25)'),
}, async (a) => text(a.action === 'start' ? await profilerStart() : await profilerStop()));

// A list of steps run in order by bedmcp, without a round trip per step. Each step is an object with
// one action key. The world journal runs meanwhile; each step's result lists what happened.
let seqCloseScreens = false;
const STEP_KEYS = ['walk_to', 'look_at', 'look', 'attack', 'use', 'wait', 'screenshot', 'ui_read', 'ui_click', 'key', 'command', 'chat', 'bot', 'hotbar', 'jump', 'move', 'tps', 'events'];
async function runStep(st) {
  const key = STEP_KEYS.find((k) => st[k] !== undefined);
  if (!key) throw new Error(`a step needs one of: ${STEP_KEYS.join(', ')}`);
  const v = st[key];
  switch (key) {
    case 'walk_to': return walkTo(v, { within: st.within, sprint: st.sprint, timeoutSec: st.timeoutSec, closeScreens: st.closeScreens ?? seqCloseScreens });
    case 'look_at': return lookAt(v);
    case 'look': return call('look', v);
    case 'attack': return typeof v === 'object' ? clientAttack(v.target, v.count ?? 1, v.gapMs, seqCloseScreens) : clientAttack(st.target, typeof v === 'number' ? v : 1, 450, seqCloseScreens);
    case 'use': { await clearScreen(seqCloseScreens); if (v?.target) await lookAt(v.target); return call('button', { button: 'use', action: 'click' }); }
    case 'wait': await sleep(Math.min(+v, 120) * 1000); return { waited: +v };
    case 'screenshot': return { screenshot: typeof v === 'string' ? v : true };
    case 'ui_read': return { view: (await call('ui', {})).view };
    case 'ui_click': return call('ui', { action: 'click', ref: v });
    case 'key': return call('key', typeof v === 'string' ? { key: v } : v);
    case 'command': return { output: await serverCommand(v, { waitMs: st.waitMs ?? 1500 }) };
    case 'chat': { await call('key', { key: 'T' }); await sleep(400); await call('text', { text: v }); await sleep(150); await call('key', { key: 'ENTER' }); return { said: v }; }
    case 'bot': return botCall(v, v.op === 'move' && v.wait ? (v.timeoutSec ?? 20) * 1000 + 5000 : 15000);
    case 'hotbar': return call('slot', { slot: v });
    case 'jump': return call('input', { jump: true, ttlMs: 200 });
    case 'move': { const r = await call('input', { move: { x: v.x ?? 0, z: v.z ?? 0 }, jump: v.jump, sprint: v.sprint, sneak: v.sneak, ttlMs: v.ms ?? 1000 }); await sleep((v.ms ?? 1000) + 100); return r; }
    case 'tps': return botCall({ op: 'tps', seconds: typeof v === 'number' ? v : 5 }, 6000);
    case 'events': return { events: (await eventsRead({ filter: typeof v === 'string' ? v : undefined })).events.length };
  }
}
reg('sequence', 'Run several steps in a row on this session\'s client, in one call: e.g. walk to A, look at a mob, attack 3 times, wait, screenshot, walk to B, read a form. Steps (one key each): walk_to (target, with optional within/sprint/timeoutSec), look_at (target), look {yaw,pitch}, attack (count, with target; or {target,count}), use (true or {target}), wait (seconds), screenshot ("label"), ui_read, ui_click (ref), key, command (server command), chat (client chat line), bot ({op, ...} as the bot tool), hotbar (slot), jump, move {x,z,ms}, tps. Targets: [x,y,z], a player/bot name, an entity id or a type ("minecraft:zombie"). While it runs, the world journal records what happens: each step returns its events (hurt, die, spawn, pickup ...), and the end lists TPS, server errors and, with record, a video file. Stops at the first failing step unless continueOnError.', {
  steps: z.array(z.record(z.any())).min(1).max(100),
  record: z.union([z.boolean(), z.enum(['mp4', 'gif'])]).optional().describe('record the whole sequence as a video (true = mp4)'),
  name: z.string().optional().describe('a short name (video file)'),
  track: z.array(z.string()).optional().describe('entities whose positions the journal logs (types, names or ids)'),
  eventsPerStep: num.optional().describe('most events listed per step (default 25; counts are always complete)'),
  continueOnError: z.boolean().optional(),
  closeScreens: z.boolean().optional().describe('walk_to steps press ESC on forms or menus that open on the way (default false: the step fails and names the screen)'),
}, async (a) => {
  seqCloseScreens = !!a.closeScreens;
  const s = await srv();
  if (!(await findGame())) throw new Error('this session\'s game is not running: dev_cycle first');
  const logFrom = readLog(s.dir).length;
  let journalOk = true, cursor = 0;
  try { cursor = (await botCall({ op: 'events_start', track: a.track, perfEvery: 20 }, 6000)).cursor; } catch (e) { journalOk = false; log('journal:', e.message); }
  if (a.record) await recorder.start({ name: a.name ?? 'sequence', seconds: 600, format: a.record === 'gif' ? 'gif' : 'mp4' });
  const results = [], shots = [];
  let failed = null;
  const t0 = Date.now();
  for (let i = 0; i < a.steps.length; i++) {
    const st = a.steps[i], ts = Date.now();
    let out, ok = true;
    try { out = await runStep(st); } catch (e) { ok = false; out = { error: e.message }; }
    if (out?.arrived === false) ok = false; // walk_to did not get there
    if (st.screenshot !== undefined && ok) { try { shots.push({ label: typeof st.screenshot === 'string' ? st.screenshot : `step ${i + 1}`, img: await screenshotContent({ maxWidth: 960 }) }); } catch (e) { out = { error: e.message }; } }
    const row = { step: i + 1, do: st, ok, ms: Date.now() - ts, result: out };
    if (journalOk) {
      try {
        await sleep(150);
        const r = await eventsRead({ since: cursor });
        cursor = r.cursor;
        const ev = r.events.filter((e) => !NOISY.test(e.ev));
        row.events = { counts: summarize(r.events), list: ev.slice(0, a.eventsPerStep ?? 25).map(compactEvent) };
        const perf = r.events.filter((e) => e.ev === 'perf' && e.tps);
        if (perf.length) row.tps = Math.min(...perf.map((e) => e.tps));
        const pos = r.events.filter((e) => e.ev === 'pos');
        if (pos.length) row.tracked = pos.slice(-5).map(compactEvent);
      } catch (e) { row.events = { error: e.message }; }
    }
    results.push(row);
    if (!ok && !a.continueOnError) { failed = i + 1; break; }
  }
  let video = null;
  if (a.record) { try { video = await recorder.stop(); } catch (e) { video = { error: e.message }; } }
  let perf = null;
  if (journalOk) { try { perf = await botCall({ op: 'tps', seconds: Math.min(60, Math.ceil((Date.now() - t0) / 1000)) }, 6000); } catch {} }
  await sleep(800); // LeviLamina buffers latest.log a little
  const errors = readLog(s.dir).slice(logFrom).map((l) => l.line).filter((l) => /ERROR|ERR\]|\[Scripting\].*(error|Error)|Exception/.test(l)).slice(-30);
  const summary = { steps: a.steps.length, ran: results.length, failedAt: failed, seconds: +((Date.now() - t0) / 1000).toFixed(1), perf, serverErrors: errors.length ? errors : 'none', video, journal: journalOk ? 'on' : 'off (bot pack not answering: server_restart installs it)' };
  const content = [{ type: 'text', text: JSON.stringify({ summary, results }, null, 1) }];
  for (const sh of shots) content.push({ type: 'text', text: `screenshot: ${sh.label}` }, sh.img);
  return { content };
});

// --- script debugger (src/debugger.mjs): breakpoints, stack, variables, eval, live stats
let dbg = null;
function debuggerOf() {
  if (dbg) return dbg;
  const packs = packDirs('behavior').map((dir) => {
    const m = readManifest(dir);
    const script = (m?.modules ?? []).find((x) => x.type === 'script');
    return { dir, name: m?.header?.name, entry: script?.entry, scriptUuid: script?.uuid };
  });
  dbg = createDebugger({ serverCommand: (c, o) => serverCommand(c, o), log, packs, projectDir: SOURCE_DIR });
  return dbg;
}
let autoResume = null;
const armAutoResume = (sec) => {
  clearTimeout(autoResume);
  if (sec > 0) autoResume = setTimeout(() => { if (dbg?.session?.stopped) dbg.resume().then(() => log(`debugger: auto-continued after ${sec} s`)).catch(() => {}); }, sec * 1000);
};
reg('debug', 'Script debugger on this session\'s test server (the protocol of the VS Code "Minecraft Bedrock Debugger"). attach (target: a pack name or script uuid; default the project\'s pack), then break {file, lines} with a TypeScript file (mapped through the built script\'s source map) or the built .js, then wait {timeoutSec} for a hit: returns the stack (in TS files) and the top frame\'s variables. Then vars {ref}, eval {expression, frameId}, continue / next / step_in / step_out / pause. logs (console output the debugger got), stats (memory, handles, scripting engine numbers, live), detach. A stopped script freezes the whole server tick: bedmcp continues by itself after holdSec (default 60). Combine with sequence or bot to make the code run.', {
  action: z.enum(['attach', 'break', 'wait', 'state', 'vars', 'eval', 'continue', 'next', 'step_in', 'step_out', 'pause', 'logs', 'stats', 'detach']),
  target: z.string().optional().describe('attach: which script pack (name part or module uuid)'),
  file: z.string().optional().describe('break: e.g. "development_behavior_packs/BP/src/foo.ts" (relative to the project or the pack) or the built .js'),
  lines: z.array(num).optional().describe('break: line numbers in that file'),
  clear: z.boolean().optional().describe('break: replace this file\'s breakpoints (with no lines: remove them)'),
  timeoutSec: num.optional().describe('wait: how long to wait for a hit (default 30)'),
  holdSec: num.optional().describe('wait/step: continue by itself after this many seconds stopped (default 60, 0 = never)'),
  ref: num.optional().describe('vars: a variablesReference from state'),
  depth: num.optional().describe('vars/state: nested levels to expand (default 1)'),
  expression: z.string().optional().describe('eval: a JS expression in the stopped frame'),
  frameId: num.optional(),
  filter: z.string().optional().describe('logs: regex'),
}, async (a) => {
  const d = debuggerOf();
  const need = () => { if (!d.session?.sock) throw new Error('the debugger is not attached: debug {action:"attach"} first'); };
  switch (a.action) {
    case 'attach': return text(await d.attach({ target: a.target }));
    case 'detach': clearTimeout(autoResume); return text(await d.detach());
    case 'break': need(); if (!a.file) throw new Error('file is required'); return text(await d.setBreakpoints({ file: a.file, lines: a.lines ?? [], clear: a.clear }));
    case 'wait': {
      need();
      const hit = await d.waitStop((a.timeoutSec ?? 30) * 1000);
      if (!hit) return text({ stopped: false, note: 'no breakpoint was hit: make the code run (sequence, bot, command) and wait again' });
      armAutoResume(a.holdSec ?? 60);
      return text(await d.snapshot({ depth: a.depth ?? 1 }));
    }
    case 'state': need(); return text(await d.snapshot({ depth: a.depth ?? 1 }));
    case 'vars': need(); return text(await d.vars(a.ref, a.depth ?? 1));
    case 'eval': need(); return text(await d.request('evaluate', { expression: a.expression, frameId: a.frameId, context: 'repl' }));
    case 'continue': need(); clearTimeout(autoResume); return text(await d.resume('continue'));
    case 'next': case 'step_in': case 'step_out': {
      need();
      await d.resume({ next: 'next', step_in: 'stepIn', step_out: 'stepOut' }[a.action]);
      const hit = await d.waitStop(5000);
      if (hit) armAutoResume(a.holdSec ?? 60);
      return text(hit ? await d.snapshot({ depth: a.depth ?? 1 }) : { running: true });
    }
    case 'pause': need(); await d.request('pause', { threadId: 1 }).catch(() => {}); return text({ paused: await d.waitStop(3000) });
    case 'logs': need(); return text(d.prints(0, a.filter).slice(-80).map((p) => p.message).join('\n') || '(no output)');
    case 'stats': need(); return text(d.statsSummary());
  }
});

reg('entities', 'List entities with position via the server ("querytarget"), around this session\'s player. selector example: @e[type=minecraft:zombie,r=30] or @e[family=mob]. Positions are relative to the player when r= is used.', { selector: z.string().optional(), player: z.string().optional() }, async ({ selector = '@e[r=32]', player }) => {
  return text(await serverCommand(`execute as ${await target(player)} at @s run querytarget ${selector}`, { waitMs: 2500 }));
});
reg('bedd_call', 'Escape hatch: send any Be.D.D. WebSocket op to this session\'s game with its fields (ping, world, ui, oreui, stack {view:true}, timescale, settings, tap, state ...).', { op: z.string(), fields: z.record(z.any()).optional() }, async ({ op, fields }) => {
  const r = await call(op, fields ?? {});
  if (r.data && r.format) { const { data, ...rest } = r; return { content: [{ type: 'text', text: JSON.stringify(rest) }, { type: 'image', data, mimeType: `image/${r.format === 'png' ? 'png' : 'jpeg'}` }] }; }
  return text(r);
});

// When the Claude session goes away: close this session's client, stop its server cleanly (never
// kill), and free its slot.
let exiting = false;
const shutdown = async () => {
  if (exiting) return; exiting = true;
  try {
    if (me.slot) {
      const g = (jsonOut(await bedd(['ps', '--json'], 20000)) ?? []).find((x) => x.kind === 'client' && slotOf(x.instance) === me.slot && x.label === LABEL);
      if (g) await bedd(['stop', g.instance], 30000).catch(() => {});
      await serverStop().catch((e) => log(e.message));
      safeRm(join(STATE, 'slots', `${me.slot}.json`));
    }
    safeRm(sessionFile(ME));
  } catch (e) { log('shutdown:', e.message); }
  process.exit(0);
};
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, shutdown);
process.stdin.on('close', shutdown);

saveMe();
await mcp.connect(new StdioServerTransport());
log('ready', CONFIG_SOURCES.join(' + ') || '(defaults)', `project ${SOURCE_DIR}`, `session ${me.name}, state ${STATE}`);
