import { installErrorReporter } from './errorReporter';
installErrorReporter('region');
type Rect = { x: number; y: number; w: number; h: number };

/**
 * The window is opened on the display's DIP origin (query x,y). clientX/clientY
 * are CSS pixels, which are DIP. screenX is a different space under per-monitor DPI.
 */
const params = new URLSearchParams(location.search);
const dipOrigin = {
  x: Number(params.get('x')),
  y: Number(params.get('y')),
};
if (!Number.isFinite(dipOrigin.x)) dipOrigin.x = 0;
if (!Number.isFinite(dipOrigin.y)) dipOrigin.y = 0;

const box = document.getElementById('box') as HTMLDivElement;
let start: { x: number; y: number } | null = null;
let rect: Rect | null = null;

function point(e: PointerEvent): { x: number; y: number } {
  return { x: dipOrigin.x + e.clientX, y: dipOrigin.y + e.clientY };
}

function normalize(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function paint(r: Rect | null): void {
  if (!r) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'block';
  box.style.left = `${r.x - dipOrigin.x}px`;
  box.style.top = `${r.y - dipOrigin.y}px`;
  box.style.width = `${r.w}px`;
  box.style.height = `${r.h}px`;
}

window.addEventListener('pointerdown', (e) => {
  if ((e.target as HTMLElement | null)?.closest('#actions')) return;
  start = point(e);
  rect = { x: start.x, y: start.y, w: 0, h: 0 };
  paint(rect);
});

window.addEventListener('pointermove', (e) => {
  if (!start) return;
  rect = normalize(start, point(e));
  paint(rect);
});

window.addEventListener('pointerup', () => {
  start = null;
});

function finish(chosen: Rect | null): void {
  window.opener?.postMessage({ channel: chosen ? 'region-picked' : 'region-cancel', rect: chosen }, location.origin);
  window.close();
}

document.getElementById('cancel')?.addEventListener('click', () => finish(null));
document.getElementById('use')?.addEventListener('click', () => {
  if (!rect || rect.w < 16 || rect.h < 16) return;
  finish(rect);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') finish(null);
});
