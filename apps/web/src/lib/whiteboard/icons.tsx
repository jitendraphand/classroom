/**
 * Whiteboard tool icons: 24×24 stroke drawings, one source for every app.
 * The web app and the Windows app render them here; the Android app's
 * vector drawables are generated from WB_ICONS (scripts/wb-icons-android.mjs
 * on the android branch), so the same tool looks the same everywhere.
 * Paths only (no circle/rect elements): Android vectors take path data.
 */
import type { CSSProperties } from 'react';

export type WbIconDef = { d: string[]; /** Filled instead of stroked. */ fill?: boolean };

const ring = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

export const WB_ICONS = {
  select: { d: ['M5 3l13 7.5-5.5 1.5-2.5 5.5z', 'M12.5 12l5 5'] },
  pen: { d: ['M4 20l1-4.5L16.5 4a2.1 2.1 0 0 1 3 3L8 18.5z', 'M14.5 6l3 3'] },
  highlighter: { d: ['M7 14l7.5-7.5 3.5 3.5L10.5 17.5z', 'M7 14l-2 3.5 1.5 1.5 3.5-2', 'M13 20h7'] },
  text: { d: ['M5 7V5h14v2', 'M12 5v14', 'M9 19h6'] },
  laser: { d: [ring(12, 12, 2.5), 'M12 3v3', 'M12 18v3', 'M3 12h3', 'M18 12h3', 'M5.6 5.6l2.1 2.1', 'M16.3 16.3l2.1 2.1', 'M5.6 18.4l2.1-2.1', 'M16.3 7.7l2.1-2.1'] },
  shapes: { d: ['M3.5 13.5h7v7h-7z', ring(17, 7, 3.5), 'M13.5 20.5l3.5-6 3.5 6z'] },
  line: { d: ['M5 19L19 5'] },
  arrow: { d: ['M5 19L19 5', 'M10 5h9v9'] },
  rect: { d: ['M4 6h16v12H4z'] },
  ellipse: { d: ['M3 12a9 6.5 0 1 0 18 0a9 6.5 0 1 0-18 0'] },
  tri: { d: ['M12 4.5l8.5 15h-17z'] },
  fill: { d: ['M4 6h16v12H4z'], fill: true },
  eraser: { d: ['M8.5 19.5L3.8 14.8a1.6 1.6 0 0 1 0-2.3L13 3.3a1.6 1.6 0 0 1 2.3 0l4.4 4.4a1.6 1.6 0 0 1 0 2.3L10 19.5z', 'M8 9l6.5 6.5', 'M10 19.5h10'] },
  areaEraser: { d: ['M4 8V4h4', 'M12 4h0', 'M16 4h4v4', 'M20 12v0', 'M20 16v4h-4', 'M12 20h0', 'M8 20H4v-4', 'M4 12v0', 'M9 9l6 6', 'M15 9l-6 6'] },
  undo: { d: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'] },
  redo: { d: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'] },
  clear: { d: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'] },
  duplicate: { d: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'] },
  prev: { d: ['M15 18l-6-6 6-6'] },
  next: { d: ['M9 18l6-6-6-6'] },
  addPage: { d: ['M6 3h8l5 5v13H6z', 'M14 3v5h5', 'M12.5 11.5v6', 'M9.5 14.5h6'] },
  background: { d: ['M4 4h16v16H4z', 'M4 9.3h16', 'M4 14.6h16', 'M9.3 4v16', 'M14.6 4v16'] },
  hand: { d: ['M8 13V5.5a1.5 1.5 0 0 1 3 0V11', 'M11 11V4.5a1.5 1.5 0 0 1 3 0V11', 'M14 11V6.5a1.5 1.5 0 0 1 3 0V14a6 6 0 0 1-6 6h-.5a6 6 0 0 1-4.9-2.6L3.8 14a1.5 1.5 0 0 1 2.4-1.8L8 14'] },
  zoomIn: { d: [ring(11, 11, 7), 'M21 21l-5-5', 'M8 11h6', 'M11 8v6'] },
  zoomOut: { d: [ring(11, 11, 7), 'M21 21l-5-5', 'M8 11h6'] },
  view: { d: [ring(11, 11, 7), 'M21 21l-5-5'] },
  image: { d: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15 8.5h.01'] },
  download: { d: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'] },
  stop: { d: ['M7 7h10v10H7z'], fill: true },
} satisfies Record<string, WbIconDef>;

export type WbIconName = keyof typeof WB_ICONS;

export function WbIcon({ name, size = 20, style }: { name: WbIconName; size?: number; style?: CSSProperties }) {
  const def: WbIconDef = WB_ICONS[name];
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={def.fill ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={def.fill ? 1.5 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block', flex: 'none', ...style }}
    >
      {def.d.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
