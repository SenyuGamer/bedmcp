// Video recording of the game: bedmcp grabs the client's frames in a loop through Be.D.D.'s screenshot
// op (captured inside the game, so it works with the window hidden and the monitor off, not with the session locked; ~28 fps
// measured at 1024 px), and ffmpeg encodes them into an MP4 or a GIF, keeping the real time
// between frames. Recording runs in the background, so other tools (move, ui_click,
// bot ...) can act while it records.
//
// Audio (audio:true, MP4 only): src/procaudio.cs records only the game process's sound with Windows'
// process loopback (no microphone, no other programs), compiled on first use with the .NET
// Framework's csc.exe. Be.D.D. keeps a game silent until its sound is turned on in its manager window.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { safeRm } from './safefs.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AUDIO_SRC = join(dirname(fileURLToPath(import.meta.url)), 'procaudio.cs');
const CSC = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const SILENT_NOTE = 'no game sound was captured: Be.D.D. keeps the game silent until its sound is turned on in the Be.D.D. manager window (ask the user to turn it on; the game then also plays on the speakers)';

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

export function createRecorder({ call, log, outDir, ffmpeg = 'ffmpeg', gamePid = async () => null, binDir = join(outDir, '.bin') }) {
  let rec = null; // the recording in progress

  // The audio helper, built from its source when missing or older.
  async function audioExe() {
    const exe = join(binDir, 'procaudio.exe');
    if (existsSync(exe) && statSync(exe).mtimeMs >= statSync(AUDIO_SRC).mtimeMs) return exe;
    if (!existsSync(CSC)) throw new Error(`audio needs the .NET Framework 4 compiler (${CSC}), which every Windows 10/11 has; it is missing here`);
    mkdirSync(binDir, { recursive: true });
    const r = await run(CSC, ['-nologo', '-optimize', '-platform:x64', '-target:exe', `-out:${exe}`, AUDIO_SRC], 120000);
    if (r.code !== 0 || !existsSync(exe)) throw new Error(`could not build the audio helper: ${r.out.trim().slice(-600)}`);
    return exe;
  }

  // Starts recording the game's sound; resolves once capture runs, with its start time (unix ms).
  async function startAudio(r) {
    const pid = await gamePid();
    if (!pid) throw new Error('audio: the game\'s process is not known (is it running?)');
    const exe = await audioExe();
    const file = join(r.dir, 'audio.wav');
    const proc = spawn(exe, [String(pid), file], { windowsHide: true });
    const a = { proc, file, startMs: null, done: null, out: '' };
    a.exited = new Promise((res) => proc.on('exit', (code) => res(code)));
    proc.stdout.on('data', (d) => { a.out += d; });
    proc.stderr.on('data', (d) => { a.out += d; });
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const m = a.out.match(/^start (\d+)/m);
      if (m) { a.startMs = Number(m[1]); return a; }
      if (/^error /m.test(a.out) || proc.exitCode !== null) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    try { proc.kill(); } catch {}
    throw new Error(`audio capture did not start: ${a.out.trim() || 'no answer in 10 s'}`);
  }
  async function stopAudio(a) {
    try { a.proc.stdin.write('stop\n'); a.proc.stdin.end(); } catch {}
    const code = await Promise.race([a.exited, new Promise((res) => setTimeout(() => res('timeout'), 15000))]);
    if (code === 'timeout') { try { a.proc.kill(); } catch {} }
    const m = a.out.match(/^done (\d+) (\d+)/m);
    a.done = m ? { frames: Number(m[1]), peak: Number(m[2]) } : null;
    return a.done;
  }

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
    // The sound, placed on the video's timeline: the video starts at the first frame's time.
    let audioIn = [], audioOut = [];
    if (r.format !== 'gif' && r.audio?.done?.frames) {
      const off = (r.audio.startMs - frames[0].t) / 1000;
      audioIn = [...(off >= 0 ? ['-itsoffset', off.toFixed(3)] : ['-ss', (-off).toFixed(3)]), '-i', r.audio.file];
      audioOut = ['-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest'];
    }
    const args = r.format === 'gif'
      ? ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', `fps=${Math.min(r.fps, 15)},scale=${Math.min(r.maxWidth, 640)}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`, out]
      : ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, ...audioIn, '-vf', `fps=30,${even}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', ...audioOut, '-movflags', '+faststart', out];
    const res = await run(ffmpeg, args, 300000);
    if (res.code !== 0 || !existsSync(out)) throw new Error(`ffmpeg failed (${res.code}): ${res.out.trim().split('\n').slice(-6).join(' | ')}`);
    return out;
  }

  async function finish(r) {
    r.stopping = true;
    await r.done;
    if (r.audio) await stopAudio(r.audio);
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
      if (r.audio) {
        out.audio = r.audio.done ? (r.format === 'gif' ? 'not in a GIF' : 'game sound only (48 kHz stereo AAC)') : `failed: ${r.audio.out.trim().slice(-300)}`;
        if (r.audio.done && r.audio.done.peak === 0) out.warning = [out.warning, SILENT_NOTE].filter(Boolean).join('; ');
      }
      return out;
    } finally {
      if (!r.keepFrames) safeRm(r.dir);
      if (rec === r) rec = null;
    }
  }

  async function start({ name, seconds = 60, fps = 30, maxWidth = 1280, quality = 75, format = 'mp4', keepFrames = false, audio = false } = {}) {
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
    if (audio && format !== 'gif') {
      try { r.audio = await startAudio(r); } catch (e) { safeRm(r.dir); throw e; }
      // The helper may have been built just now: count the length from here.
      const len = r.until - r.started;
      r.started = Date.now(); r.until = r.started + len;
    }
    r.done = loop(r);
    rec = r;
    return r;
  }

  return {
    // Starts a background recording; it ends by itself after `seconds` (max 600) or on stop().
    async start(opts) {
      const r = await start(opts);
      return { recording: r.name, maxSeconds: Math.round((r.until - r.started) / 1000), fps: r.fps, ...(r.audio ? { audio: 'recording the game\'s sound' } : {}), note:'recording in the background: act with the other tools, then record {action:"stop"} to get the file', ...(r.lockedAtStart ? { warning: LOCKED_NOTE } : {}) };
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
