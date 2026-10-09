/**
 * Opens classic Notepad on a fixture file and places that window.
 * Used only by the local capture test. Coordinates are physical pixels.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type NotepadRect = {
  pid: number;
  hwnd: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  cw: number;
  ch: number;
};

const SCRIPT = String.raw`
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Needle = 'capture-test-notepad',
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 640,
  [int]$H = 480,
  [int]$ProcId = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CapWin {
  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder lp, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public struct POINT { public int X; public int Y; }
  public static int[] ClientBox(IntPtr h) {
    RECT r;
    GetClientRect(h, out r);
    POINT p = new POINT();
    ClientToScreen(h, ref p);
    return new int[] { p.X, p.Y, r.Right - r.Left, r.Bottom - r.Top };
  }
  public static uint PidOf(IntPtr h) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    return pid;
  }
  public static IntPtr Find(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      if (GetWindowText(h, sb, sb.Capacity) <= 0) return true;
      if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
"@

if ($Action -eq 'cursor') {
  [CapWin]::SetCursorPos($X, $Y) | Out-Null
  Write-Output '{"ok":true}'
  exit 0
}

if ($Action -eq 'close') {
  if ($ProcId -gt 0) { Stop-Process -Id $ProcId -Force -ErrorAction SilentlyContinue }
  $h = [CapWin]::Find($Needle)
  if ($h -ne [IntPtr]::Zero) {
    $procId = [CapWin]::PidOf($h)
    if ($procId -gt 0) { Stop-Process -Id ([int]$procId) -Force -ErrorAction SilentlyContinue }
  }
  Write-Output '{"ok":true}'
  exit 0
}

$h = [IntPtr]::Zero
for ($i = 0; $i -lt 40; $i++) {
  $h = [CapWin]::Find($Needle)
  if ($h -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 250
}
if ($h -eq [IntPtr]::Zero) { Write-Output '{"ok":false,"error":"notepad-window"}'; exit 0 }
[CapWin]::ShowWindow($h, 9) | Out-Null
[CapWin]::SetWindowPos($h, [IntPtr]::Zero, $X, $Y, $W, $H, 0x0040) | Out-Null
$rect = New-Object CapWin+RECT
[CapWin]::GetWindowRect($h, [ref]$rect) | Out-Null
$procId = [CapWin]::PidOf($h)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$hwnd = [int64]$h
$client = [CapWin]::ClientBox($h)
$payload = [ordered]@{ ok = $true; hwnd = $hwnd; pid = [int64]$procId; x = $rect.Left; y = $rect.Top; w = $width; h = $height; cx = $client[0]; cy = $client[1]; cw = $client[2]; ch = $client[3] }
Write-Output ($payload | ConvertTo-Json -Compress)
`;

function writeScript(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'place-notepad.ps1');
  fs.writeFileSync(file, SCRIPT, 'utf8');
  return file;
}

function runScript(dir: string, args: string[]): { ok: boolean; raw: string } {
  const file = writeScript(dir);
  const run = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
    { encoding: 'utf8', timeout: 20000, windowsHide: true }
  );
  const raw = `${run.stdout || ''}\n${run.stderr || ''}`;
  const line = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('{'))
    .pop();
  if (!line) return { ok: false, raw };
  try {
    const json = JSON.parse(line) as { ok?: boolean };
    return { ok: json.ok === true, raw: line };
  } catch {
    return { ok: false, raw };
  }
}

export function writeNotepadFixture(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'capture-test-notepad.txt');
  const lines: string[] = [];
  for (let i = 0; i < 80; i++) {
    const band = i % 2 === 0 ? 'CAPTURE-TEST' : 'notepad-line';
    lines.push(`${String(i).padStart(2, '0')} ${band} ${'#'.repeat(12 + (i % 9))} ${'X'.repeat(18)}`);
  }
  fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
  return file;
}

export function launchNotepad(file: string): number | null {
  const child = spawn('notepad.exe', [file], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return child.pid ?? null;
}

export function placeNotepad(dir: string, x: number, y: number, w: number, h: number): NotepadRect | null {
  const run = runScript(dir, ['-Action', 'place', '-X', String(Math.round(x)), '-Y', String(Math.round(y)), '-W', String(Math.round(w)), '-H', String(Math.round(h))]);
  if (!run.ok) return null;
  try {
    const json = JSON.parse(run.raw) as {
      hwnd?: number;
      pid?: number;
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      cx?: number;
      cy?: number;
      cw?: number;
      ch?: number;
    };
    if (!json.w || !json.h || json.x === undefined || json.y === undefined) return null;
    return {
      pid: Number(json.pid) || 0,
      hwnd: String(json.hwnd ?? ''),
      x: Number(json.x),
      y: Number(json.y),
      w: Number(json.w),
      h: Number(json.h),
      cx: Number(json.cx) || 0,
      cy: Number(json.cy) || 0,
      cw: Number(json.cw) || 0,
      ch: Number(json.ch) || 0,
    };
  } catch {
    return null;
  }
}

export function parkCursorAt(dir: string, x: number, y: number): void {
  runScript(dir, ['-Action', 'cursor', '-X', String(Math.round(x)), '-Y', String(Math.round(y))]);
}

export function closeNotepad(dir: string, pid: number): void {
  runScript(dir, ['-Action', 'close', '-ProcId', String(pid || 0)]);
  if (pid > 0) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 4000 });
  }
}
