import { WEB_ICONS } from '../shared/web/icons';

/**
 * The website's icons (generated from apps/web/src/components/ui/Icons.tsx by
 * scripts/sync-web.mjs), under the names this app uses. The meeting bar, the
 * floating control panel, the panels and the annotation tools share them.
 */
const TOOL_ICONS = {
  speaker:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  speakerOff:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m16 9 5 6M21 9l-5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  highlighter:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9 11-5 5v4h4l5-5M9 11l4-4 4 4-4 4M9 11l4 4M14 6l3-3 4 4-3 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  line: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 19 19 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  arrow:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 19 19 5M10 5h9v9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  rect: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="1.5" stroke="currentColor" stroke-width="1.8"/></svg>',
  ellipse: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><ellipse cx="12" cy="12" rx="8.5" ry="6.5" stroke="currentColor" stroke-width="1.8"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m15 14 5-5-5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5M10 11v5M14 11v5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pointer:
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 3 14 7.5-6.2 1.6L10 18.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  laser: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3.2" fill="currentColor"/><circle cx="12" cy="12" r="7.5" stroke="currentColor" stroke-width="1.4" opacity=".55"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
} as const;

export const ICONS = {
  mic: WEB_ICONS.Mic,
  micOff: WEB_ICONS.MicOff,
  cam: WEB_ICONS.Cam,
  camOff: WEB_ICONS.CamOff,
  share: WEB_ICONS.Screen,
  pen: WEB_ICONS.Pen,
  chat: WEB_ICONS.Chat,
  people: WEB_ICONS.Users,
  video: WEB_ICONS.Video,
  film: WEB_ICONS.Film,
  hand: WEB_ICONS.Hand,
  handDown: WEB_ICONS.HandDown,
  pin: WEB_ICONS.Pin,
  userPlus: WEB_ICONS.UserPlus,
  door: WEB_ICONS.Door,
  reply: WEB_ICONS.Reply,
  search: WEB_ICONS.Search,
  send: WEB_ICONS.Send,
  eraser: WEB_ICONS.Eraser,
  undo: WEB_ICONS.Undo,
  leave: WEB_ICONS.Leave,
  check: WEB_ICONS.Check,
  stop: WEB_ICONS.Screen,
  ...TOOL_ICONS,
} as const;

export type IconName = keyof typeof ICONS;
