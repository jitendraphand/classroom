import { spawn, type ChildProcess } from 'node:child_process';

const WGC_MAGIC = 0x31434757;

export type WgcReady = {
  ok: true;
  width: number;
  height: number;
  cursor: boolean;
  borderOff: boolean;
  source: string;
  api: string;
  /** Physical monitor rectangle from GetMonitorInfo, when the helper sent one. */
  monitor: { x: number; y: number; w: number; h: number } | null;
};

export type WgcFail = { ok: false; error: string };

type Proc = ChildProcess & { silentExit?: boolean };

export type WgcPump = {
  start: (args: string[]) => Promise<WgcReady | WgcFail>;
  stop: () => void;
};

/**
 * Runs affinity-helper capture-* . stderr is JSON (ready / error). stdout is
 * WGC1 frames. Frames are delivered as they arrive; the caller may drop all
 * but the latest before the IPC hop.
 */
export function createWgcPump(opts: {
  helper: () => string;
  /** `same`: header-only heartbeat, the picture has not changed since the last frame (rgba is empty). */
  onFrame: (frame: { width: number; height: number; rgba: Buffer; same?: boolean }) => void;
  /** The helper stopped by itself. `reason` is its last `stale`/`error` step, or `exit <code>`. */
  onEnded: (info: { code: number | null; reason: string }) => void;
  onLog: (line: string) => void;
}): WgcPump {
  let child: Proc | null = null;
  let generation = 0;

  function stop(): void {
    const proc = child;
    if (!proc) return;
    proc.silentExit = true;
    child = null;
    proc.kill();
  }

  function start(args: string[]): Promise<WgcReady | WgcFail> {
    stop();
    const exe = opts.helper();
    const gen = ++generation;
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout;
      const finish = (result: WgcReady | WgcFail) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      let proc: Proc;
      try {
        proc = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) as Proc;
      } catch {
        finish({ ok: false, error: 'helper-spawn-failed' });
        return;
      }
      child = proc;
      timer = setTimeout(() => {
        opts.onLog('[capture] helper timed out waiting for Windows.Graphics.Capture');
        if (child === proc) {
          proc.silentExit = true;
          child = null;
          proc.kill();
        }
        finish({ ok: false, error: 'capture timed out' });
      }, 8000);

      let stderr = '';
      let lastReason = '';
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
        let nl = stderr.indexOf('\n');
        while (nl >= 0) {
          const line = stderr.slice(0, nl).trim();
          stderr = stderr.slice(nl + 1);
          nl = stderr.indexOf('\n');
          if (!line) continue;
          opts.onLog(`[capture] helper ${line}`);
          try {
            const msg = JSON.parse(line) as {
              event?: string;
              step?: string;
              hr?: string;
              width?: number;
              height?: number;
              cursor?: boolean;
              borderOff?: boolean;
              source?: string;
              api?: string;
              monL?: number;
              monT?: number;
              monR?: number;
              monB?: number;
            };
            if (msg.event === 'ready') {
              const monL = Number(msg.monL);
              const monT = Number(msg.monT);
              const monR = Number(msg.monR);
              const monB = Number(msg.monB);
              const monitor =
                Number.isFinite(monL) && Number.isFinite(monT) && Number.isFinite(monR) && Number.isFinite(monB) && monR > monL && monB > monT
                  ? { x: monL, y: monT, w: monR - monL, h: monB - monT }
                  : null;
              finish({
                ok: true,
                width: Number(msg.width) || 0,
                height: Number(msg.height) || 0,
                cursor: msg.cursor === true,
                borderOff: msg.borderOff === true,
                source: typeof msg.source === 'string' ? msg.source : '',
                api: typeof msg.api === 'string' ? msg.api : 'Windows.Graphics.Capture',
                monitor,
              });
            } else if (msg.event === 'error') {
              const reason = `${msg.step || 'wgc'}${msg.hr ? ` ${msg.hr}` : ''}`;
              if (child === proc) {
                proc.silentExit = true;
                child = null;
                proc.kill();
              }
              lastReason = reason;
              finish({ ok: false, error: reason });
            } else if (msg.event === 'stale') {
              lastReason = `stale ${(msg as { why?: string }).why || 'capture'}`;
            }
          } catch {
            /* already logged */
          }
        }
      });

      const chunks: Buffer[] = [];
      let buffered = 0;
      const take = (n: number): Buffer | null => {
        if (buffered < n) return null;
        const out = Buffer.allocUnsafe(n);
        let filled = 0;
        while (filled < n && chunks.length) {
          const c = chunks[0]!;
          const need = n - filled;
          if (c.length <= need) {
            c.copy(out, filled);
            filled += c.length;
            chunks.shift();
          } else {
            c.copy(out, filled, 0, need);
            chunks[0] = c.subarray(need);
            filled += need;
          }
        }
        buffered -= n;
        return out;
      };
      proc.stdout?.on('data', (chunk: Buffer) => {
        if (gen !== generation) return;
        chunks.push(chunk);
        buffered += chunk.length;
        while (buffered >= 20) {
          const head = take(20);
          if (!head) return;
          const magic = head.readUInt32LE(0);
          const width = head.readUInt32LE(4);
          const height = head.readUInt32LE(8);
          const stride = head.readUInt32LE(12);
          const size = head.readUInt32LE(16);
          if (magic === WGC_MAGIC && size === 0 && stride === 0 && width >= 2 && width <= 1920 && height >= 2 && height <= 1080) {
            opts.onFrame({ width, height, rgba: Buffer.alloc(0), same: true });
            continue;
          }
          const sane =
            magic === WGC_MAGIC &&
            width >= 2 &&
            width <= 1920 &&
            height >= 2 &&
            height <= 1080 &&
            stride === width * 4 &&
            size === width * height * 4;
          if (!sane) {
            chunks.unshift(head.subarray(1));
            buffered += head.length - 1;
            continue;
          }
          if (buffered < size) {
            chunks.unshift(head);
            buffered += 20;
            return;
          }
          const pixels = take(size);
          if (!pixels) return;
          opts.onFrame({ width, height, rgba: pixels });
        }
      });

      proc.on('error', () => {
        if (child === proc) child = null;
        finish({ ok: false, error: 'helper-spawn-failed' });
      });
      proc.on('exit', (code) => {
        if (child === proc) child = null;
        const silent = proc.silentExit === true;
        if (!settled) finish({ ok: false, error: lastReason || 'helper-exited' });
        if (!silent && gen === generation) opts.onEnded({ code, reason: lastReason || `exit ${code}` });
      });
    });
  }

  return { start, stop };
}
