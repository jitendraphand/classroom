'use client';

/**
 * Chat, roster and student-video windows that sit beside the always-on-top
 * share toolbar (Document Picture-in-Picture allows one PiP per page, so
 * these are ordinary same-origin pop-ups opened by the classroom tab).
 *
 * Safety: every open side window is registered here synchronously, before any
 * content is drawn into it, so the whole-screen blackout mask (which reads
 * `sideWindows()` on every captured frame) paints it black from its first
 * frame. Callers only open side windows when the share is a window/tab
 * capture (not captured) or the mask is running, and refuse windows whose
 * position cannot be trusted (Wayland reports 0,0); they then fall back to
 * the panel inside the masked toolbar.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isDesktopLinuxUA, untrustedOrigin } from '@/lib/screenMask';
import { SIDE_SIZE, sideWindowBox, type SideKind, type Size } from '@/lib/sideWindowGeometry';
import { controlUrl, copyParentStyles, mountIn, waitForWindow } from './shareWindowDom';

export type { SideKind } from '@/lib/sideWindowGeometry';

const wins = new Map<SideKind, Window>();
const listeners = new Set<() => void>();
let version = 0;
let pollTimer: number | null = null;

function emit() {
  version++;
  listeners.forEach((fn) => fn());
}

function prune() {
  let changed = false;
  wins.forEach((w, k) => {
    if (w.closed) {
      wins.delete(k);
      changed = true;
    }
  });
  if (changed) emit();
  if (wins.size === 0 && pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Every open side window (for the blackout mask). */
export function sideWindows(): Window[] {
  return Array.from(wins.values()).filter((w) => !w.closed);
}

export function sideWindow(kind: SideKind): Window | null {
  const w = wins.get(kind);
  return w && !w.closed ? w : null;
}

export function closeSideWindow(kind: SideKind) {
  const w = wins.get(kind);
  wins.delete(kind);
  try {
    w?.close();
  } catch {
    /* ignore */
  }
  emit();
}

export function closeAllSideWindows() {
  (Array.from(wins.keys()) as SideKind[]).forEach((k) => closeSideWindow(k));
}

/** Close a specific window object (mask reported its geometry unusable). */
export function closeSideWindowObject(win: Window): boolean {
  for (const [k, w] of Array.from(wins.entries())) {
    if (w === win) {
      closeSideWindow(k);
      return true;
    }
  }
  return false;
}

/** Re-render when side windows open or close. */
export function useSideWindows(): number {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
    () => 0
  );
}

function toolbarBox(anchor: Window | null) {
  if (!anchor || anchor.closed) return null;
  try {
    const box = { x: anchor.screenX, y: anchor.screenY, w: anchor.outerWidth, h: anchor.outerHeight };
    if (![box.x, box.y, box.w, box.h].every(Number.isFinite) || box.w <= 0 || untrustedOrigin(box)) return null;
    return box;
  } catch {
    return null;
  }
}

export type SideOpenResult = { ok: true; win: Window } | { ok: false; reason: 'blocked' | 'untrusted' };

/**
 * Open (or focus) a side window. Call synchronously inside the click handler
 * (user gesture). `requireTrustedPosition`: the whole-screen mask is running,
 * so a window whose position the browser hides must not stay open.
 */
export function openSideWindow(
  kind: SideKind,
  opts: { anchor: Window | null; requireTrustedPosition: boolean; size?: Size }
): SideOpenResult {
  const existing = sideWindow(kind);
  if (existing) {
    try {
      existing.focus();
    } catch {
      /* ignore */
    }
    return { ok: true, win: existing };
  }
  const scr = window.screen as Screen & { availLeft?: number; availTop?: number };
  const avail = {
    left: scr.availLeft ?? 0,
    top: scr.availTop ?? 0,
    width: scr.availWidth || scr.width,
    height: scr.availHeight || scr.height,
  };
  const sizes: Partial<Record<SideKind, Size>> = {};
  wins.forEach((w, k) => {
    if (!w.closed) sizes[k] = { w: w.outerWidth, h: w.outerHeight };
  });
  if (opts.size) sizes[kind] = opts.size;
  const box = sideWindowBox(kind, toolbarBox(opts.anchor), avail, sizes);
  const features = [
    'popup=yes',
    `width=${Math.round(box.w)}`,
    `height=${Math.round(box.h)}`,
    `left=${Math.round(box.left)}`,
    `top=${Math.round(box.top)}`,
    'menubar=no,toolbar=no,location=no,status=no,resizable=yes',
  ].join(',');
  let win: Window | null = null;
  try {
    win = window.open(controlUrl(), `classroom-side-${kind}`, features);
  } catch {
    win = null;
  }
  if (!win) return { ok: false, reason: 'blocked' };
  // Register before anything is drawn in it: the mask reads this every frame.
  wins.set(kind, win);
  // window.open sizes the content area; correct to the planned outer box so
  // the window never overlaps the toolbar (pop-ups opened by script may be
  // moved and resized by it).
  try {
    win.resizeTo(Math.round(box.w), Math.round(box.h));
    win.moveTo(Math.round(box.left), Math.round(box.top));
  } catch {
    /* ignore */
  }
  emit();
  if (pollTimer === null) pollTimer = window.setInterval(prune, 400);
  if (opts.requireTrustedPosition) {
    let pos = { x: 0, y: 0 };
    try {
      pos = { x: win.screenX, y: win.screenY };
    } catch {
      /* unreadable → untrusted */
    }
    const linuxBlind = isDesktopLinuxUA(navigator.userAgent || '') && untrustedOrigin({ x: window.screenX, y: window.screenY });
    if (untrustedOrigin(pos) || linuxBlind) {
      closeSideWindow(kind);
      return { ok: false, reason: 'untrusted' };
    }
  }
  return { ok: true, win };
}

/** Render `children` into a side window (styles copied from the classroom tab). */
export function SideWindowPortal({ win, title, children }: { win: Window; title: string; children: ReactNode }) {
  const [mount, setMount] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    setMount(null);
    void waitForWindow(win).then((ready) => {
      if (cancelled || !ready || ready.closed) return;
      try {
        copyParentStyles(ready);
        const doc = ready.document;
        doc.documentElement.className = document.documentElement.className;
        doc.body.className = document.body.className;
        for (const el of [doc.documentElement, doc.body]) {
          el.style.margin = '0';
          el.style.height = '100%';
          el.style.background = '#0d1219';
          el.style.overflow = 'hidden';
        }
        const m = mountIn(ready);
        m.style.height = '100%';
        setMount(m);
      } catch {
        /* window navigated away or closed */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [win]);
  useEffect(() => {
    if (!mount) return;
    try {
      win.document.title = title;
    } catch {
      /* ignore */
    }
  }, [mount, win, title]);
  if (!mount) return null;
  return createPortal(children, mount);
}

export { SIDE_SIZE };
