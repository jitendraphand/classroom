/**
 * Annotate toolbar layout (pure): grouped tools, tooltips with shortcuts and
 * the window size for each dock orientation.
 */
import type { OverlayTool } from './annotateOverlay';

export type ToolbarOrient = 'horizontal' | 'vertical';

export type ToolDef = { id: OverlayTool; label: string; icon: string; key: string };

export const TOOL_GROUPS: { id: string; label: string; tools: ToolDef[] }[] = [
  {
    id: 'draw',
    label: 'Draw',
    tools: [
      { id: 'pen', label: 'Pen', icon: 'pen', key: 'P' },
      { id: 'highlight', label: 'Highlighter', icon: 'highlighter', key: 'H' },
      { id: 'eraser', label: 'Eraser (also removes student strokes)', icon: 'eraser', key: 'E' },
    ],
  },
  {
    id: 'shapes',
    label: 'Shapes',
    tools: [
      { id: 'line', label: 'Line', icon: 'line', key: 'L' },
      { id: 'arrow', label: 'Arrow', icon: 'arrow', key: 'A' },
      { id: 'rect', label: 'Rectangle', icon: 'rect', key: 'R' },
      { id: 'ellipse', label: 'Ellipse', icon: 'ellipse', key: 'O' },
    ],
  },
  {
    id: 'point',
    label: 'Text and laser',
    tools: [
      { id: 'text', label: 'Text', icon: 'text', key: 'T' },
      { id: 'laser', label: 'Laser pointer', icon: 'laser', key: 'K' },
    ],
  },
];

export const ALL_TOOLS: ToolDef[] = TOOL_GROUPS.flatMap((g) => g.tools);

export function toolForKey(key: string): ToolDef | undefined {
  const k = key.toUpperCase();
  return ALL_TOOLS.find((t) => t.key === k);
}

/** Tooltip text: "Pen (P)". */
export function tip(label: string, shortcut?: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

/** Hit targets: 36 px buttons (was 28-30). */
export const BUTTON_PX = 36;

export function toolbarSize(orient: ToolbarOrient): { width: number; height: number } {
  return orient === 'vertical' ? { width: 64, height: 720 } : { width: 1040, height: 60 };
}

export function parseOrient(v: unknown): ToolbarOrient {
  return v === 'vertical' ? 'vertical' : 'horizontal';
}
