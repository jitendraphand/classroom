/**
 * Transparent annotation overlay over the shared monitor. NOT capture-excluded
 * (REPORT.md "Window protection"): what is drawn here is in the share.
 *
 * Two layers of ink:
 * - the teacher's annotations (tools in the separate, capture-excluded
 *   annotation panel, tools.tsx);
 * - student desktop ink: strokes a student draws on their view of the share
 *   (server-relayed, normalised to the shared picture), mapped onto the real
 *   desktop so the teacher sees them where they belong and the capture
 *   carries them to everyone (the website skips its own overlay: desktopInk).
 * This page has no buttons. Committed shapes are cached in a second canvas,
 * so a pointer move only redraws the shape being drawn.
 */
import { inkPoint } from '../shared/studentInk';
import { studentStrokesHit, withoutStrokes } from '../shared/studentErase';
import { newStrokeId, type Pt } from '../shared/annotate';
import {
  ShapeLog,
  applyRemoteMessage,
  cssPointerToNormalized,
  defaultOpacity,
  isOverlayTool,
  shapesHit,
  type AnnotShape,
  type AnnotateCommand,
  type DipBox,
  type OverlayTool,
  type PhysicalMonitor,
  type ShapeType,
  toolWidth,
} from '../shared/annotateOverlay';
import { DRAW_COLORS, isDrawColor, nameTags, strokeWidthFor } from '../shared/web/drawLogic';
import { cropInk } from '../shared/inkLayer';
import { desktop, type StudentInk } from './bridge';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const textInput = document.getElementById('ink-text') as HTMLInputElement;
const cur = canvas.getContext('2d');

document.body.classList.add('overlay');
document.body.classList.remove('preview');

type Surface = { dip: DipBox; physical: PhysicalMonitor; scale: number };

let surface: Surface | null = null;
let tool: OverlayTool = 'pen';
let color = '#ef4444';
let thickness = 3;
let active = false;
let studentInk: StudentInk | null = null;
/** Committed teacher shapes + student ink, redrawn only when they change. */
const base = document.createElement('canvas');
const baseCtx = base.getContext('2d');
let baseDirty = true;
const log = new ShapeLog();
let draft: AnnotShape | null = null;
let laser: { at: number; p: Pt } | null = null;
let raf = 0;

function publishStatus(): void {
  desktop().annotationStatus({ ...log.status(), students: studentInk?.strokes.length ?? 0 });
}

/** Teacher eraser also removes student strokes (whole stroke, for everyone). */
function eraseStudents(p: Pt): boolean {
  const ink = studentInk;
  if (!ink || !ink.strokes.length) return false;
  const ids = studentStrokesHit(ink.strokes, ink.rect, p, aspect());
  if (!ids.length) return false;
  studentInk = { ...ink, strokes: withoutStrokes(ink.strokes, ids) };
  desktop().eraseStudentInk(ids);
  return true;
}

function pushInk(): void {
  desktop().annotationInk(log.shapes);
}

function norm(e: { clientX: number; clientY: number }): Pt | null {
  if (!surface) return null;
  return cssPointerToNormalized({ x: e.clientX, y: e.clientY }, surface.dip, surface.scale, surface.physical);
}

function resize(): void {
  if (!surface) return;
  const cssW = Math.max(1, surface.dip.w);
  const cssH = Math.max(1, surface.dip.h);
  canvas.width = Math.max(1, Math.round(surface.physical.widthPx));
  canvas.height = Math.max(1, Math.round(surface.physical.heightPx));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  base.width = canvas.width;
  base.height = canvas.height;
  baseDirty = true;
  draw();
}

function px(p: Pt): [number, number] {
  return [p[0] * canvas.width, p[1] * canvas.height];
}

function lineWidth(widthCss: number): number {
  const scale = surface?.scale || 1;
  return Math.max(1, widthCss * scale);
}

/** Target of the shape painters below: the visible canvas or the cached base layer. */
let ctx: CanvasRenderingContext2D | null = cur;

function strokePath(points: Pt[]): void {
  const g = ctx;
  if (!g || !points.length) return;
  g.beginPath();
  points.forEach((p, i) => {
    const [x, y] = px(p);
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  });
}

function drawArrow(a: Pt, b: Pt, width: number): void {
  if (!ctx) return;
  const [x0, y0] = px(a);
  const [x1, y1] = px(b);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  const ang = Math.atan2(y1 - y0, x1 - x0);
  const len = Math.max(10, lineWidth(width) * 4);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 + Math.cos(ang + Math.PI * 0.85) * len, y1 + Math.sin(ang + Math.PI * 0.85) * len);
  ctx.lineTo(x1 + Math.cos(ang - Math.PI * 0.85) * len, y1 + Math.sin(ang - Math.PI * 0.85) * len);
  ctx.closePath();
  ctx.fill();
}

function drawShape(shape: AnnotShape): void {
  if (!ctx || !shape.points.length) return;
  ctx.save();
  ctx.globalAlpha = shape.opacity;
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = lineWidth(shape.width);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const a = shape.points[0]!;
  const b = shape.points[shape.points.length - 1]!;
  if (shape.type === 'rect' && shape.points.length >= 2) {
    const [x0, y0] = px(a);
    const [x1, y1] = px(b);
    ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  } else if (shape.type === 'ellipse' && shape.points.length >= 2) {
    const [x0, y0] = px(a);
    const [x1, y1] = px(b);
    ctx.beginPath();
    ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.max(1, Math.abs(x1 - x0) / 2), Math.max(1, Math.abs(y1 - y0) / 2), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (shape.type === 'arrow' && shape.points.length >= 2) {
    drawArrow(a, b, shape.width);
  } else if (shape.type === 'text') {
    const [x, y] = px(a);
    ctx.font = `${Math.max(12, lineWidth(shape.width))}px "Segoe UI", sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(shape.text, x, y);
  } else {
    strokePath(shape.points);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLaser(): void {
  if (!ctx || !laser) return;
  const age = performance.now() - laser.at;
  const alpha = Math.max(0, 1 - age / 700);
  if (alpha <= 0) {
    laser = null;
    return;
  }
  const [x, y] = px(laser.p);
  const scale = surface?.scale || 1;
  ctx.save();
  ctx.fillStyle = '#fb7185';
  ctx.globalAlpha = alpha * 0.35;
  ctx.beginPath();
  ctx.arc(x, y, 22 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, 7 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function paintBase(): void {
  if (!baseCtx) return;
  baseDirty = false;
  ctx = baseCtx;
  baseCtx.clearRect(0, 0, base.width, base.height);
  for (const shape of log.shapes) drawShape(shape);
  drawStudentInk(baseCtx);
  ctx = cur;
}

function draw(): void {
  if (!cur) return;
  if (baseDirty) paintBase();
  ctx = cur;
  cur.clearRect(0, 0, canvas.width, canvas.height);
  if (base.width && base.height) cur.drawImage(base, 0, 0);
  if (draft) drawShape(draft);
  drawLaser();
  scheduleLayer();
}

/*
 * Ink layer for the published frames (shared/inkLayer.ts). This window is
 * capture-excluded; main composites this bitmap into each captured frame, so
 * students see every stroke even where WGC leaves a layered window out.
 */
const LAYER_MIN_GAP_MS = 66;
let layerSize = { w: 0, h: 0 };
const layerCanvas = document.createElement('canvas');
const layerCtx = layerCanvas.getContext('2d', { willReadFrequently: true });
let layerTimer = 0;
let layerSentAt = 0;
let layerWasEmpty = true;

function scheduleLayer(): void {
  if (layerTimer) return;
  const wait = Math.max(0, LAYER_MIN_GAP_MS - (performance.now() - layerSentAt));
  layerTimer = window.setTimeout(() => {
    layerTimer = 0;
    sendLayer();
  }, wait);
}

function sendLayer(): void {
  layerSentAt = performance.now();
  const { w, h } = layerSize;
  if (!layerCtx || w < 2 || h < 2 || !canvas.width || !canvas.height) return;
  if (layerCanvas.width !== w || layerCanvas.height !== h) {
    layerCanvas.width = w;
    layerCanvas.height = h;
  }
  layerCtx.clearRect(0, 0, w, h);
  layerCtx.imageSmoothingEnabled = true;
  layerCtx.imageSmoothingQuality = 'high';
  layerCtx.drawImage(canvas, 0, 0, w, h);
  const layer = cropInk(layerCtx.getImageData(0, 0, w, h).data, w, h);
  const empty = layer.w === 0;
  if (empty && layerWasEmpty) return;
  layerWasEmpty = empty;
  desktop().annotationLayer(layer);
}

/**
 * Student strokes: 0..1 of the shared picture → the picture's place on this
 * monitor (`rect`, region shares) → canvas pixels. Width: the web's
 * strokeWidthFor() at the size students receive (≤1280 px wide), scaled up to
 * this monitor, so a line looks as thick in the share as on a student's own
 * overlay. The drawer's name tag sits at their last point, like the website.
 */
function drawStudentInk(g: CanvasRenderingContext2D): void {
  const ink = studentInk;
  if (!ink || !ink.strokes.length) return;
  const r = ink.rect;
  const picW = r.w * canvas.width;
  const picH = r.h * canvas.height;
  if (!(picW > 0) || !(picH > 0)) return;
  const sentW = Math.min(1280, picW);
  const lw = strokeWidthFor(sentW) * (picW / sentW);
  const X = (x: number) => inkPoint(x, 0, r, canvas.width, canvas.height).x;
  const Y = (y: number) => inkPoint(0, y, r, canvas.width, canvas.height).y;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = lw;
  for (const s of ink.strokes) {
    const c = isDrawColor(s.color) ? DRAW_COLORS[s.color] : '#ef4444';
    g.strokeStyle = c;
    g.fillStyle = c;
    if (s.pts.length <= 2) {
      g.beginPath();
      g.arc(X(s.pts[0] ?? 0), Y(s.pts[1] ?? 0), lw / 2, 0, Math.PI * 2);
      g.fill();
      continue;
    }
    g.beginPath();
    g.moveTo(X(s.pts[0]!), Y(s.pts[1]!));
    for (let i = 2; i + 1 < s.pts.length; i += 2) g.lineTo(X(s.pts[i]!), Y(s.pts[i + 1]!));
    g.stroke();
  }
  const scale = surface?.scale || 1;
  g.font = `600 ${Math.round(12 * scale)}px "Segoe UI", sans-serif`;
  g.textBaseline = 'middle';
  const tags = nameTags(ink.strokes.map((s) => ({ ...s, color: isDrawColor(s.color) ? s.color : 'red' })));
  for (const t of tags) {
    const x = X(t.x) + 10 * scale;
    const y = Y(t.y) + 10 * scale;
    const w = g.measureText(t.name).width + 12 * scale;
    const h = 20 * scale;
    g.fillStyle = 'rgba(15,23,42,0.85)';
    g.strokeStyle = DRAW_COLORS[t.color];
    g.lineWidth = 1.5 * scale;
    g.beginPath();
    g.roundRect(x, y - h / 2, w, h, 6 * scale);
    g.fill();
    g.stroke();
    g.fillStyle = '#ffffff';
    g.fillText(t.name, x + 6 * scale, y);
  }
  g.restore();
}

function frame(): void {
  raf = 0;
  draw();
  if (laser) raf = requestAnimationFrame(frame);
}

function poke(): void {
  if (!raf) raf = requestAnimationFrame(frame);
}

function beginShape(type: ShapeType, p: Pt): AnnotShape {
  return {
    id: newStrokeId(),
    type,
    points: [p],
    color,
    width: toolWidth(type, thickness),
    opacity: defaultOpacity(type),
    text: '',
    timestamp: Date.now(),
  };
}

function commitDraft(): void {
  if (!draft) return;
  const shape = draft;
  draft = null;
  if (shape.type === 'text') return;
  if (shape.points.length < (shape.type === 'pen' || shape.type === 'highlight' ? 1 : 2)) return;
  log.add(shape);
  baseDirty = true;
  publishStatus();
  pushInk();
}

function onDown(e: PointerEvent): void {
  if (!active || e.button !== 0) return;
  const p = norm(e);
  if (!p) return;
  if (tool === 'text') {
    e.preventDefault();
    openText(e.clientX, e.clientY, p);
    return;
  }
  canvas.setPointerCapture(e.pointerId);
  if (tool === 'laser') {
    laser = { at: performance.now(), p };
    poke();
    return;
  }
  if (tool === 'eraser') {
    log.erase(shapesHit(log.shapes, p, aspect()));
    eraseStudents(p);
    baseDirty = true;
    publishStatus();
    pushInk();
    poke();
    return;
  }
  draft = beginShape(tool, p);
  poke();
}

function onMove(e: PointerEvent): void {
  if (!active) return;
  const p = norm(e);
  if (!p) return;
  if (tool === 'laser') {
    laser = { at: performance.now(), p };
    poke();
    return;
  }
  if (!draft && tool !== 'eraser') return;
  if (tool === 'eraser') {
    if (e.buttons !== 1) return;
    const hit = shapesHit(log.shapes, p, aspect());
    const studentsHit = eraseStudents(p);
    // Most eraser moves touch nothing: no repaint, no IPC to main then.
    if (!hit.length && !studentsHit) return;
    if (hit.length) log.erase(hit);
    baseDirty = true;
    publishStatus();
    pushInk();
    poke();
    return;
  }
  if (!draft) return;
  if (draft.type === 'pen' || draft.type === 'highlight') draft.points.push(p);
  else draft.points = [draft.points[0]!, p];
  poke();
}

function onUp(): void {
  commitDraft();
  poke();
}

function aspect(): number {
  if (!surface) return 1;
  return surface.physical.widthPx / surface.physical.heightPx;
}

function openText(clientX: number, clientY: number, p: Pt): void {
  textInput.style.left = `${clientX}px`;
  textInput.style.top = `${clientY}px`;
  textInput.style.color = color;
  textInput.style.fontSize = `${toolWidth('text', thickness)}px`;
  textInput.value = '';
  textInput.hidden = false;
  textInput.focus();
  const anchor = p;
  const commit = () => {
    textInput.removeEventListener('blur', commit);
    textInput.removeEventListener('keydown', onKey);
    const text = textInput.value.trim();
    textInput.hidden = true;
    textInput.value = '';
    if (!text) return;
    log.add({ ...beginShape('text', anchor), text, points: [anchor] });
    baseDirty = true;
    publishStatus();
    pushInk();
    poke();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      textInput.blur();
    }
    if (ev.key === 'Escape') {
      textInput.value = '';
      textInput.blur();
    }
  };
  textInput.addEventListener('blur', commit);
  textInput.addEventListener('keydown', onKey);
}

function applyCommand(cmd: AnnotateCommand): void {
  if (cmd.op === 'tool' && isOverlayTool(cmd.tool)) {
    commitDraft();
    tool = cmd.tool;
    return;
  }
  if (cmd.op === 'color' && typeof cmd.color === 'string' && /^#[0-9a-f]{6}$/i.test(cmd.color)) {
    color = cmd.color;
    return;
  }
  if (cmd.op === 'width' && Number.isFinite(cmd.width)) {
    thickness = cmd.width;
    return;
  }
  if (cmd.op === 'undo') log.undo();
  else if (cmd.op === 'redo') log.redo();
  else if (cmd.op === 'clear') log.clear();
  else if (cmd.op === 'remote') applyRemoteMessage(log, cmd.msg);
  baseDirty = true;
  publishStatus();
  pushInk();
  poke();
}

canvas.addEventListener('pointerdown', onDown);
canvas.addEventListener('pointermove', onMove);
canvas.addEventListener('pointerup', onUp);
canvas.addEventListener('pointercancel', onUp);

window.addEventListener('keydown', (ev) => {
  if (!active) return;
  const key = ev.key.toLowerCase();
  if ((ev.ctrlKey || ev.metaKey) && key === 'z') {
    ev.preventDefault();
    if (ev.shiftKey) log.redo();
    else log.undo();
    baseDirty = true;
    publishStatus();
    pushInk();
    poke();
  } else if ((ev.ctrlKey || ev.metaKey) && key === 'y') {
    ev.preventDefault();
    log.redo();
    baseDirty = true;
    publishStatus();
    pushInk();
    poke();
  }
});

desktop().onAnnotateSurface((next) => {
  surface = next;
  resize();
});
desktop().onAnnotateMode((on) => {
  active = on;
  document.body.classList.toggle('passthrough', !on);
  if (!on) {
    commitDraft();
    textInput.blur();
  }
  poke();
});
desktop().onAnnotateCommand((cmd) => applyCommand(cmd));
desktop().onAnnotateLayerSize((size) => {
  layerSize = size;
  layerWasEmpty = false; // resend even an empty layer for the new size
  scheduleLayer();
});
desktop().onStudentInk((ink) => {
  const before = studentInk?.strokes.length ?? 0;
  studentInk = ink && Array.isArray(ink.strokes) && ink.rect ? ink : null;
  baseDirty = true;
  if ((studentInk?.strokes.length ?? 0) !== before) publishStatus();
  poke();
});

publishStatus();
poke();
