/**
 * Whiteboard PDF import (teacher, web). Each PDF page becomes one JPEG image,
 * rendered in the browser with pdf.js (legacy build: older Safari and Chrome
 * on tablets too), and the pages are stacked down the long whiteboard page.
 * pdf.js is loaded only when a PDF is imported; its worker comes from
 * /pdfjs (copied there by scripts/copy-voice-assets.mjs).
 *
 * Nothing is rendered from the PDF but pictures: pdf.js 6 runs no PDF
 * JavaScript and no XFA forms by default, and fonts are never eval'd.
 */

/** At most this many pages per import (a whole textbook would flood the class). */
export const PDF_MAX_PAGES = 40;
/** Rendered page width in pixels (the board is 1920 wide; pages fill ~85 % of it). */
export const PDF_RENDER_W = 1600;
/** Biggest PDF file accepted. */
export const PDF_MAX_BYTES = 40 * 1024 * 1024;

export type PdfPageImage = { blob: Blob; w: number; h: number };

/** Render scale for a page `pageW` points wide (never above 3×, so a tiny page stays sane). */
export function pdfScale(pageW: number, target = PDF_RENDER_W): number {
  if (!(pageW > 0)) return 1;
  return Math.min(3, target / pageW);
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((res) => canvas.toBlob((b) => res(b), 'image/jpeg', quality));
}

/**
 * Pages of `file` as JPEGs (white background), one at a time through
 * `onPage` so the board can place each page as soon as it is ready.
 * Returns the number of pages in the PDF (it may exceed what was rendered).
 */
export async function renderPdfPages(
  file: Blob,
  onPage: (img: PdfPageImage, index: number, total: number) => Promise<void> | void,
  opts: { maxPages?: number; signal?: { cancelled: boolean } } = {}
): Promise<number> {
  if (file.size > PDF_MAX_BYTES) throw new Error('PDF is larger than 40 MB');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  const doc = await task.promise;
  try {
    const total = doc.numPages;
    const n = Math.min(total, opts.maxPages ?? PDF_MAX_PAGES);
    for (let i = 1; i <= n; i++) {
      if (opts.signal?.cancelled) break;
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: pdfScale(base.width) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) throw new Error('Canvas unavailable');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      page.cleanup();
      // Text pages compress well; keep each page under ~1.5 MB (the asset limit).
      let blob = await canvasBlob(canvas, 0.82);
      if (blob && blob.size > 1_400_000) blob = await canvasBlob(canvas, 0.6);
      canvas.width = canvas.height = 0;
      if (!blob) throw new Error('Could not encode a page');
      await onPage({ blob, w: Math.floor(viewport.width), h: Math.floor(viewport.height) }, i - 1, n);
    }
    return total;
  } finally {
    void task.destroy();
  }
}
