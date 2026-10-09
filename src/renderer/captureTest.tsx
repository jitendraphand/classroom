import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CaptureScenarioReport } from '../shared/captureScenario';
import { desktop, type AffinityRow } from './bridge';

function paint(canvas: HTMLCanvasElement, frame: { width: number; height: number; rgba: Uint8Array }): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || !frame.width || !frame.height) return;
  const bytes = frame.width * frame.height * 4;
  if (frame.rgba.byteLength < bytes) return;
  if (canvas.width !== frame.width || canvas.height !== frame.height) {
    canvas.width = frame.width;
    canvas.height = frame.height;
  }
  const copy = new Uint8ClampedArray(bytes);
  copy.set(frame.rgba.subarray(0, bytes));
  try {
    ctx.putImageData(new ImageData(copy, frame.width, frame.height), 0, 0);
  } catch {
    /* torn frame */
  }
}

function diagnostics(report: CaptureScenarioReport | null): string {
  if (!report) return '';
  return [
    '[capture-test]',
    `controlProtected=${report.controlProtected}`,
    `captureStartedAt=${report.captureStartedAt || '—'}`,
    `firstFrameAt=${report.firstFrameAt || '—'}`,
    `frameWidth=${report.frameWidth}`,
    `frameHeight=${report.frameHeight}`,
  ].join('\n');
}

function Test() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [rows, setRows] = useState<AffinityRow[]>([]);
  const [logPath, setLogPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CaptureScenarioReport | null>(null);
  const [status, setStatus] = useState('This test is local. It does not start a class or send video to students.');

  useEffect(() => {
    const unsub = desktop().onWgcFrame((frame) => {
      if (canvas.current && frame) paint(canvas.current, frame);
    });
    const timer = window.setInterval(() => {
      void desktop().captureDiagnostics().then((diag) => {
        setRows(diag.windows);
        setLogPath(diag.logPath);
      });
    }, 1000);
    return () => {
      unsub();
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="capture-test">
      <header>
        <h2>Capture test</h2>
        <button className="btn" type="button" onClick={() => void desktop().captureTestStop()}>Close</button>
      </header>
      <p className="hint">{status}</p>
      <p className="hint">
        Opens Notepad, puts the control panel over it, waits for a desktop composition, then saves captured frames.
        Classroom windows are excluded. A red arrow is drawn on a separate overlay, which stays in the capture.
      </p>
      <button
        className="btn primary"
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setReport(null);
          setStatus('Opening Notepad and capturing the desktop. This can take about half a minute.');
          void desktop().captureScenario().then((result) => {
            setReport(result);
            setStatus(result.savedDir ? `Frames saved in ${result.savedDir}` : 'The test finished without a saved frame.');
            setBusy(false);
          });
        }}
      >
        Run Notepad capture test
      </button>
      {report ? <pre className={`verdict ${report.verdict}`}>{report.text}</pre> : null}
      {report ? <pre className="capture-diag">{diagnostics(report)}{report.detail ? `\n${report.detail}` : ''}</pre> : null}
      <canvas ref={canvas} className="preview-canvas" />
      <ul className="affinity-list">
        {rows.map((row) => (
          <li key={`${row.name}-${row.hwnd}`}>
            {row.name || 'window'} HWND {row.hwnd || '—'} protected={row.protected ? 'yes' : 'no'}{' '}
            {row.captured ? (row.ok ? 'in the capture' : 'unexpectedly protected') : row.ok ? 'excluded' : 'not excluded'}
          </li>
        ))}
      </ul>
      <p className="hint">Log: {logPath || 'see TESTING.md'}</p>
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Test />);
