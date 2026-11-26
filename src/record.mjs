// Video recording of the game: bedmcp grabs the client's frames in a loop through Be.D.D.'s screenshot
// op (captured inside the game, so it works with the window hidden and the monitor off, not with the session locked; ~28 fps
// measured at 1024 px), and ffmpeg encodes them into an MP4 or a GIF, keeping the real time
// between frames. Recording runs in the background, so other tools (move, ui_click,
// bot ...) can act while it records.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { safeRm } from './safefs.mjs';
import { join } from 'node:path';

const run = (cmd, args, timeout) => new Promise((res) => {
  execFile(cmd, args, { windowsHide: true, maxBuffer: 16 << 20, timeout }, (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}` }));
});

// Windows throttles the game's rendering to ~1-2 fps while the session is locked (lock screen,
// or a remote session that left the desktop locked); screenshots still work, so nothing else shows
// it. LogonUI.exe runs only while the lock or sign-in screen is up (LockApp.exe stays, suspended).
async function sessionLocked() {
  if (process.platform !== 'win32') return false;
  const r = await run('tasklist', ['/FI', 'IMAGENAME eq LogonUI.exe', '/NH'], 10000);
  return /logonui\.exe/i.test(r.out);
}
const LOCKED_NOTE = 'the Windows session is locked: Windows throttles the game to ~1-2 fps, so the video will be choppy. Unlock the PC (keep it unlocked while recording; the monitor may be off)';
const LOW_FPS = 10;

export function createRecorder({ call, log, outDir, ffmpeg = 'ffmpeg' }) {
  let rec = null; // the recording in progress

  async function ffmpegOk() {
    const r = await run(ffmpeg, ['-version'], 15000);
    return r.code === 0;
  }

  async function loop(r) {
    while (!r.stopping) {
      const t0 = Date.now();
      try {
        const shot = await call('screenshot', { format: 'jpeg', quality: r.quality, maxWidth: r.maxWidth }, 10000);
        const f = join(r.dir, `f${String(r.frames.length).padStart(6, '0')}.jpg`);
        writeFileSync(f, Buffer.from(shot.data, 'base64'));
        r.frames.push({ f, t: Date.now() });
      } catch (e) {
        r.errors++;
        if (r.errors === 1 || r.errors % 20 === 0) log('record:', e.message);
        if (r.errors > 50 && !r.frames.length) { r.failed = e.message; break; }
      }
      if (Date.now() >= r.until) break;
      const wait = r.interval - (Date.now() - t0);
      if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    }
    r.ended = Date.now();
  }

  // Encodes the frames with their real durations, then a constant frame rate for players.
  async function encode(r) {
    const frames = r.frames;
    if (!frames.length) throw new Error(`no frames were captured${r.failed ? `: ${r.failed}` : ''} (is the game running? game_status)`);
    const list = [];
    for (let i = 0; i < frames.length; i++) {
      const next = frames[i + 1]?.t ?? r.ended;
      list.push(`file '${frames[i].f.replace(/\\/g, '/')}'`, `duration ${Math.max(0.02, (next - frames[i].t) / 1000).toFixed(3)}`);
    }
    list.push(`file '${frames[frames.length - 1].f.replace(/\\/g, '/')}'`); // the concat demuxer needs the last file twice
    const listFile = join(r.dir, 'frames.txt');
    writeFileSync(listFile, list.join('\n'));
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, `${r.name}.${r.format}`);
    const even = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
    const args = r.format === 'gif'
      ? ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', `fps=${Math.min(r.fps, 15)},scale=${Math.min(r.maxWidth, 640)}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`, out]
      : ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', `fps=30,${even}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
    const res = await run(ffmpeg, args, 300000);
    if (res.code !== 0 || !existsSync(out)) throw new Error(`ffmpeg failed (${res.code}): ${res.out.trim().split('\n').slice(-6).join(' | ')}`);
    return out;
  }

  async function finish(r) {
    r.stopping = true;
    await r.done;
    try {
      const file = await encode(r);
      const seconds = (r.ended - r.started) / 1000;
      const capturedFps = Math.round((r.frames.length / Math.max(seconds, 0.1)) * 10) / 10;
      const out = { file, format: r.format, seconds: Math.round(seconds * 10) / 10, frames: r.frames.length, capturedFps, sizeMB: Math.round((statSync(file).size / 1048576) * 100) / 100, missedFrames: r.errors };
      if (capturedFps < Math.min(LOW_FPS, r.fps * 0.5)) {
        const locked = r.lockedAtStart || (await sessionLocked());
        out.warning = locked
          ? `capturedFps ${capturedFps}: ${LOCKED_NOTE}`
          : `capturedFps ${capturedFps} is low (the game rendered few frames): is the Windows session locked, the PC asleep, or the game minimized or throttled? Screenshots still work in those states.`;
      }
      return out;
    } finally {
      if (!r.keepFrames) safeRm(r.dir);
      if (rec === r) rec = null;
    }
  }

  async function start({ name, seconds = 60, fps = 30, maxWidth = 1280, quality = 75, format = 'mp4', keepFrames = false } = {}) {
    if (rec) throw new Error(`already recording "${rec.name}" (${Math.round((Date.now() - rec.started) / 1000)} s): record {action:"stop"} first`);
    if (!(await ffmpegOk())) throw new Error(`ffmpeg not found (${ffmpeg}). Install it (winget install Gyan.FFmpeg) or set "ffmpeg" in the bedmcp config to its path.`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safe = String(name ?? 'clip').replace(/[^\w.-]+/g, '_').slice(0, 60);
    const r = {
      name: `${safe}-${stamp}`, format, fps, maxWidth, quality, keepFrames,
      interval: 1000 / Math.max(1, Math.min(fps, 30)),
      started: Date.now(), until: Date.now() + Math.min(Math.max(seconds, 1), 600) * 1000,
      frames: [], errors: 0, stopping: false,
    };
    r.dir = join(outDir, '.frames', r.name);
    mkdirSync(r.dir, { recursive: true });
    r.lockedAtStart = await sessionLocked();
    r.done = loop(r);
    rec = r;
    return r;
  }

  return {
    // Starts a background recording; it ends by itself after `seconds` (max 600) or on stop().
    async start(opts) {
      const r = await start(opts);
      return { recording: r.name, maxSeconds: Math.round((r.until - r.started) / 1000), fps: r.fps, note: 'recording in the background: act with the other tools, then record {action:"stop"} to get the file', ...(r.lockedAtStart ? { warning: LOCKED_NOTE } : {}) };
    },
    // Records `seconds` and waits for the file.
    async clip(opts) {
      const r = await start(opts);
      await r.done;
      return finish(r);
    },
    async stop() {
      if (!rec) throw new Error('nothing is recording');
      return finish(rec);
    },
    status() {
      if (!rec) return { recording: false };
      return { recording: rec.name, seconds: Math.round((Date.now() - rec.started) / 1000), frames: rec.frames.length, endsIn: Math.max(0, Math.round((rec.until - Date.now()) / 1000)), finished: !!rec.ended };
    },
    get active() { return rec; },
  };
}
