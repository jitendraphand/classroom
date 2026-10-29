/**
 * The AI teacher's whiteboard: the web app's own board model and session
 * (apps/web/src/lib/whiteboard), hosted headless. The AI is the board host,
 * exactly like a teacher's browser: it keeps the document, publishes ops on
 * the `wb` data topic, answers snapshot requests from late joiners and keeps
 * the server's stored snapshot fresh. Students' apps see an ordinary
 * teacher board, so nothing changes for them.
 *
 * Board coordinates are the shared 1920 x 1080 page.
 */
import {
  PAGE_H,
  PAGE_W,
  PALETTE,
  SHAPE_KINDS,
  BACKGROUNDS,
  currentPage,
  newId,
  type Background,
  type Doc,
  type Item,
  type Op,
  type ShapeKind,
} from '../../web/src/lib/whiteboard/model';
import { WhiteboardSession, opsPackets, packetsToB64 } from '../../web/src/lib/whiteboard/session';

export { PAGE_H, PAGE_W, PALETTE, SHAPE_KINDS, BACKGROUNDS };

export type BoardIo = {
  /** Publish packets on the `wb` topic (to everyone, or to the listed identities). */
  publish(packets: Uint8Array[], to?: string[]): Promise<void>;
  /** Store the latest snapshot on the server (late joiners whose request finds no host). */
  storeSnapshot(packetsB64: string[]): Promise<void>;
};

/** Approximate text width (the renderers use system-ui; 0.55 em per character). */
export function textWidth(text: string, size: number): number {
  return text.length * size * 0.55;
}

/** Word-wrap to a pixel width. */
export function wrap(text: string, size: number, width: number): string[] {
  const maxChars = Math.max(8, Math.floor(width / (size * 0.55)));
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
      while (line.length > maxChars) {
        out.push(line.slice(0, maxChars));
        line = line.slice(maxChars);
      }
    }
    out.push(line);
  }
  return out;
}

export const MARGIN = 80;

export class BoardHost {
  readonly session = new WhiteboardSession(undefined, true);
  /** Where the next `write` goes on the current page. */
  cursorY = MARGIN;
  private snapTimer: ReturnType<typeof setTimeout> | null = null;
  open = false;

  constructor(
    private readonly io: BoardIo,
    /** Our LiveKit identity, stamped on every item. */
    public by: string
  ) {}

  get doc(): Doc {
    return this.session.doc;
  }

  get page() {
    return currentPage(this.doc);
  }

  /** Apply locally, publish to the class, and store a snapshot soon after. */
  async apply(ops: Op[]): Promise<void> {
    if (!ops.length) return;
    this.session.apply(ops);
    await this.io.publish(opsPackets(ops));
    this.scheduleSnapshot();
  }

  private scheduleSnapshot(): void {
    if (this.snapTimer) return;
    this.snapTimer = setTimeout(() => {
      this.snapTimer = null;
      void this.storeSnapshot();
    }, 2000);
  }

  async storeSnapshot(): Promise<void> {
    const packets = await this.session.snapshotPackets();
    await this.io.storeSnapshot(packetsToB64(packets)).catch(() => undefined);
  }

  /** Someone asked for the board (a late joiner, a reconnect): send them the whole document. */
  async sendSnapshot(to?: string[]): Promise<void> {
    await this.io.publish(await this.session.snapshotPackets(), to);
  }

  private item(it: Omit<Item, 'id' | 'by'> & { k: Item['k'] }): Item {
    return { ...it, id: newId('ai'), by: this.by } as Item;
  }

  /**
   * Write text from the cursor down, wrapped to the page width; turns to a
   * new page when it would run off the bottom. Returns the ids written.
   */
  async write(text: string, opts: { size?: number; color?: string; x?: number; y?: number; width?: number } = {}): Promise<{ ids: string[]; page: number }> {
    const size = Math.min(160, Math.max(16, opts.size ?? 40));
    const x = opts.x ?? MARGIN;
    const width = Math.min(PAGE_W - x - MARGIN / 2, opts.width ?? PAGE_W - x - MARGIN);
    const lines = wrap(text, size, width);
    const lineH = size * 1.25;
    let y = opts.y ?? this.cursorY;
    if (opts.y === undefined && y + lines.length * lineH > PAGE_H - MARGIN / 2 && this.page.items.length > 0) {
      await this.newPage();
      y = this.cursorY;
    }
    const ops: Op[] = [];
    const ids: string[] = [];
    // One text item per block of lines that fits the page (an item is 2000 chars max).
    for (let i = 0; i < lines.length; ) {
      const chunk: string[] = [];
      let n = 0;
      while (i < lines.length && n + lines[i]!.length < 1900) {
        chunk.push(lines[i]!);
        n += lines[i]!.length + 1;
        i++;
      }
      const it = this.item({ k: 'text', c: opts.color ?? this.ink(), size, x, y, text: chunk.join('\n') } as Omit<Item, 'id' | 'by'> & { k: 'text' });
      ops.push({ k: 'add', p: this.page.id, item: it });
      ids.push(it.id);
      y += chunk.length * lineH;
    }
    await this.apply(ops);
    if (opts.y === undefined) this.cursorY = y + size * 0.5;
    return { ids, page: this.doc.cur };
  }

  async shape(kind: ShapeKind, x1: number, y1: number, x2: number, y2: number, opts: { color?: string; width?: number; fill?: boolean } = {}): Promise<string> {
    const it = this.item({ k: kind, c: opts.color ?? this.ink(), w: Math.min(40, Math.max(1, opts.width ?? 4)), x1, y1, x2, y2, ...(opts.fill && kind !== 'line' && kind !== 'arrow' ? { fl: 1 } : {}) } as Omit<Item, 'id' | 'by'> & { k: ShapeKind });
    await this.apply([{ k: 'add', p: this.page.id, item: it }]);
    return it.id;
  }

  /** A free-hand path through the given points (x, y pairs), e.g. a curve or a graph. */
  async path(points: number[], opts: { color?: string; width?: number; highlighter?: boolean } = {}): Promise<string> {
    const pts = points.slice(0, 8000).map((n) => Math.round(n));
    const it = this.item({ k: 'stroke', tool: opts.highlighter ? 'hl' : 'pen', c: opts.color ?? this.ink(), w: Math.min(40, Math.max(1, opts.width ?? 4)), pts } as Omit<Item, 'id' | 'by'> & { k: 'stroke' });
    await this.apply([{ k: 'add', p: this.page.id, item: it }]);
    return it.id;
  }

  async newPage(bg?: Background): Promise<number> {
    const at = this.doc.pages.length;
    await this.apply([{ k: 'newpage', at, id: newId('p'), bg: bg ?? this.page.bg }, { k: 'go', cur: at }]);
    this.cursorY = MARGIN;
    return this.doc.cur;
  }

  async goPage(index: number): Promise<number> {
    const cur = Math.max(0, Math.min(this.doc.pages.length - 1, Math.round(index)));
    await this.apply([{ k: 'go', cur }]);
    this.cursorY = this.page.items.length ? PAGE_H : MARGIN;
    return cur;
  }

  async background(bg: Background): Promise<void> {
    await this.apply([{ k: 'bg', p: this.page.id, bg }]);
  }

  async clearPage(): Promise<void> {
    await this.apply([{ k: 'clear', p: this.page.id }]);
    this.cursorY = MARGIN;
  }

  async erase(ids: string[]): Promise<number> {
    const have = new Set(this.page.items.map((i) => i.id));
    const del = ids.filter((id) => have.has(id));
    if (del.length) await this.apply([{ k: 'del', p: this.page.id, ids: del }]);
    return del.length;
  }

  /** Ink that shows on this page's background. */
  ink(): string {
    return this.page.bg === 'black' ? '#ffffff' : '#111111';
  }

  /** A compact description of the current page, for the reasoning layer. */
  describe(): { page: number; pages: number; background: Background; items: { id: string; kind: string; text?: string; box: [number, number, number, number]; by: string }[] } {
    const p = this.page;
    return {
      page: this.doc.cur,
      pages: this.doc.pages.length,
      background: p.bg,
      items: p.items.slice(-80).map((it) => {
        const box = bounds(it);
        return { id: it.id, kind: it.k, ...(it.k === 'text' ? { text: it.text.slice(0, 200) } : {}), box, by: it.by.startsWith('student_') ? 'student' : 'teacher' };
      }),
    };
  }
}

function bounds(it: Item): [number, number, number, number] {
  if (it.k === 'text') {
    const lines = it.text.split('\n');
    return [it.x, it.y, Math.round(Math.max(...lines.map((l) => l.length)) * it.size * 0.55), Math.round(lines.length * it.size * 1.25)];
  }
  if (it.k === 'img') return [it.x, it.y, it.w, it.h];
  if (it.k === 'stroke') {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < it.pts.length; i += 2) {
      x0 = Math.min(x0, it.pts[i]!); x1 = Math.max(x1, it.pts[i]!);
      y0 = Math.min(y0, it.pts[i + 1]!); y1 = Math.max(y1, it.pts[i + 1]!);
    }
    return [x0, y0, x1 - x0, y1 - y0];
  }
  return [Math.min(it.x1, it.x2), Math.min(it.y1, it.y2), Math.abs(it.x2 - it.x1), Math.abs(it.y2 - it.y1)];
}
