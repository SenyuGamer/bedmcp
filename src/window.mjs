// Sets the size of a Be.D.D. game's window, so the game renders (and screenshots and recordings
// come out) at that size, e.g. 1920x1080 for a 16:9 video. Be.D.D. keeps the window off screen
// and keeps whatever size it has. The window loses its title bar and border first: Windows caps a
// framed window at the screen's height, so a framed 1080 p client does not fit on a 1080 p screen.
// (Verified 2026-11-26 on 1.26.60: MoveWindow to 1920x1080, screenshot op returned 1920x1080.)
import { execFile } from 'node:child_process';

const PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BedmcpWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || GetWindow(h, 4) != IntPtr.Zero) return true;
      var sb = new System.Text.StringBuilder(64); GetClassName(h, sb, 64);
      if (sb.ToString() == "Bedrock") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$h = [BedmcpWin]::Find([uint32]$env:BEDMCP_PID)
if ($h -eq [IntPtr]::Zero) { throw "no game window for pid $env:BEDMCP_PID" }
$w = [int]$env:BEDMCP_W; $hh = [int]$env:BEDMCP_H
$st = [BedmcpWin]::GetWindowLong($h, -16)
[void][BedmcpWin]::SetWindowLong($h, -16, ($st -band (-bnot 0x00C40000))) # no WS_CAPTION, no WS_THICKFRAME
[void][BedmcpWin]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, 0, 0, 0x37) # SWP_FRAMECHANGED, keep place, size, Z order; no activation
$r = New-Object BedmcpWin+RECT; $c = New-Object BedmcpWin+RECT
for ($i = 0; $i -lt 3; $i++) {
  [void][BedmcpWin]::GetWindowRect($h, [ref]$r)
  [void][BedmcpWin]::MoveWindow($h, -($w + 64), $r.T, $w, $hh, $true)
  Start-Sleep -Milliseconds 300
  [void][BedmcpWin]::GetClientRect($h, [ref]$c)
  if ($c.R -eq $w -and $c.B -eq $hh) { break }
}
"{0}x{1}" -f $c.R, $c.B
`;

export function resizeGameWindow(pid, width, height) {
  return new Promise((res, rej) => {
    const env = { ...process.env, BEDMCP_PID: String(pid), BEDMCP_W: String(Math.round(width)), BEDMCP_H: String(Math.round(height)) };
    const encoded = Buffer.from(PS, 'utf16le').toString('base64');
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env, windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      const out = String(stdout).trim().split(/\r?\n/).pop() ?? '';
      const m = out.match(/^(\d+)x(\d+)$/);
      if (err || !m) return rej(new Error(`window resize failed: ${(String(stderr).trim() || err?.message || out).slice(0, 400)}`));
      res({ width: Number(m[1]), height: Number(m[2]) });
    });
  });
}
