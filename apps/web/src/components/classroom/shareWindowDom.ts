'use client';

/** DOM helpers shared by the share toolbar window and its side windows. */

export function controlUrl(): string {
  // Static file, not the Next /hud route: that route boots the app layout,
  // including idle logout, which would sign the teacher out from the popup.
  return `${window.location.origin}/share-controls.html`;
}

export function copyParentStyles(win: Window) {
  const head = win.document.head;
  let base = head.querySelector('base');
  if (!base) {
    base = win.document.createElement('base');
    head.prepend(base);
  }
  base.setAttribute('href', `${window.location.origin}/`);
  head.querySelectorAll('[data-share-style="1"]').forEach((node) => node.remove());
  document.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
    const copy = node.cloneNode(true) as HTMLElement;
    copy.setAttribute('data-share-style', '1');
    head.appendChild(copy);
  });
}

export function mountIn(win: Window): HTMLElement {
  const doc = win.document;
  let mount = doc.getElementById('share-controls-root');
  if (!mount) {
    mount = doc.createElement('div');
    mount.id = 'share-controls-root';
  }
  doc.body.replaceChildren(mount);
  return mount;
}

/**
 * Resolve once the pop-up shows the real page. A fresh window.open() first
 * holds the initial about:blank document (already "complete"); drawing into
 * it would be wiped when the page loads, so wait for the real URL.
 */
export function waitForWindow(win: Window): Promise<Window | null> {
  return new Promise((resolve) => {
    let done = false;
    const loaded = () => {
      try {
        return win.document.readyState === 'complete' && win.location.href !== 'about:blank';
      } catch {
        return false;
      }
    };
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.clearInterval(poll);
      window.clearTimeout(timer);
      resolve(ok && !win.closed ? win : null);
    };
    const poll = window.setInterval(() => {
      if (win.closed) finish(false);
      else if (loaded()) finish(true);
    }, 50);
    const timer = window.setTimeout(() => finish(loaded()), 5000);
    try {
      win.addEventListener('load', () => loaded() && finish(true));
    } catch {
      /* cross-origin or closed */
    }
    if (loaded()) finish(true);
  });
}
