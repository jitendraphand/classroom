/**
 * Teacher fullscreen rules for the web classroom (pure, unit-tested).
 *
 * Teachers in a desktop/tablet/Android browser are kept in fullscreen like
 * students, with explicit exemptions:
 * - Windows Electron app
 * - Android app WebView
 * - Standalone PWA (already full screen)
 * - iPhone Safari / browsers without element Fullscreen API (suggest Add to Home Screen on iPhone)
 * - While screen-sharing (picking or presenting another tab/window/app exits fullscreen — show a compact reminder, never block)
 * - While a browser permission prompt is open (plus settle grace)
 *
 * Admin observer (/admin/live/[code]) does not use ClassroomRoom and is unaffected.
 */

export function isElectronApp(opts: { ua: string; hasElectronProcess?: boolean }): boolean {
  if (opts.hasElectronProcess) return true;
  return /\bElectron\b/i.test(opts.ua);
}

export function isAndroidWebView(opts: { ua: string; hasAndroidBridge?: boolean }): boolean {
  if (opts.hasAndroidBridge) return true;
  if (/;\s*wv\)/i.test(opts.ua)) return true;
  return /\bAndroid\b/i.test(opts.ua) && /\bVersion\/[\d.]+\b/i.test(opts.ua) && /\bChrome\/[\d.]+\b/i.test(opts.ua);
}

export function isStandalonePWA(opts: { navigatorStandalone?: boolean; displayModeStandalone?: boolean }): boolean {
  return !!opts.navigatorStandalone || !!opts.displayModeStandalone;
}

export function isTeacherFullscreenExempt(opts: {
  ua: string;
  hasElectronProcess?: boolean;
  hasAndroidBridge?: boolean;
  navigatorStandalone?: boolean;
  displayModeStandalone?: boolean;
}): boolean {
  return (
    isElectronApp({ ua: opts.ua, hasElectronProcess: opts.hasElectronProcess }) ||
    isAndroidWebView({ ua: opts.ua, hasAndroidBridge: opts.hasAndroidBridge }) ||
    isStandalonePWA({
      navigatorStandalone: opts.navigatorStandalone,
      displayModeStandalone: opts.displayModeStandalone,
    })
  );
}

export type TeacherFullscreenGate = 'off' | 'iphone-hint' | 'share-reminder' | 'prompt' | 'cover';

export function teacherFullscreenGate(opts: {
  exempt: boolean;
  fullscreenSupported: boolean;
  isFullscreen: boolean;
  everFullscreen: boolean;
  iphone: boolean;
  sharing: boolean;
  permissionGrace: boolean;
  coverDismissed?: boolean;
  shareReminderDismissed?: boolean;
  iphoneHintDismissed?: boolean;
}): TeacherFullscreenGate {
  if (opts.exempt) return 'off';
  if (!opts.fullscreenSupported) {
    if (opts.iphone && !opts.iphoneHintDismissed) return 'iphone-hint';
    return 'off';
  }
  if (opts.sharing) {
    if (opts.isFullscreen || opts.shareReminderDismissed) return 'off';
    return 'share-reminder';
  }
  if (opts.isFullscreen) return 'off';
  if (opts.permissionGrace) return 'off';
  if (opts.everFullscreen && !opts.coverDismissed) return 'cover';
  return 'prompt';
}

export function teacherFullscreenText(gate: Exclude<TeacherFullscreenGate, 'off'>): {
  title: string;
  buttonLabel: string;
  body: string;
} {
  switch (gate) {
    case 'cover':
      return {
        title: 'Return to full screen',
        buttonLabel: 'Return to full screen',
        body: 'Your class, audio, and camera are still live. Tap below to continue in full screen.',
      };
    case 'prompt':
      return {
        title: 'Full screen recommended',
        buttonLabel: 'Enter full screen',
        body: 'Teaching in full screen keeps your whiteboard and controls clear.',
      };
    case 'share-reminder':
      return {
        title: 'Full screen paused while sharing',
        buttonLabel: 'Return to full screen',
        body: 'You can switch tabs or apps freely while sharing.',
      };
    case 'iphone-hint':
      return {
        title: 'Full-screen tip for iPhone',
        buttonLabel: 'Got it',
        body: 'Safari on iPhone does not support web full screen. Tap Share → Add to Home Screen for a full-screen view.',
      };
  }
}
