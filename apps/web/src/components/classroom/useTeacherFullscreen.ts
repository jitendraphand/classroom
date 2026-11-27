'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isAppleTouchDevice, isIPhoneUA } from '@/lib/focusStatus';
import { installTypingGuard, isEditableTarget, typingHold } from '@/lib/fullscreenTyping';
import { permissionGrace } from '@/lib/permissions';
import {
  isTeacherFullscreenExempt,
  teacherFullscreenGate,
  teacherFullscreenText,
  type TeacherFullscreenGate,
} from '@/lib/teacherFullscreen';
import { enterFullscreen, exitFullscreenIfActive, fullscreenSupported, isFullscreenNow } from './useStudentFocus';

function readTeacherExempt(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return true;
  const w = window as unknown as {
    process?: { versions?: { electron?: string } };
    electronAPI?: unknown;
    AndroidClassroom?: unknown;
    ClassroomAndroid?: unknown;
    ReactNativeWebView?: unknown;
  };
  const nav = navigator as Navigator & { standalone?: boolean };
  const displayModeStandalone =
    typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
  return isTeacherFullscreenExempt({
    ua: navigator.userAgent || '',
    hasElectronProcess: !!(w.process?.versions?.electron || w.electronAPI),
    hasAndroidBridge: !!(w.AndroidClassroom || w.ClassroomAndroid || w.ReactNativeWebView),
    navigatorStandalone: nav.standalone,
    displayModeStandalone,
  });
}

/**
 * Call synchronously inside the teacher's Start / Re-enter click on the dashboard
 * so SPA navigation to /classroom/[code] lands directly in full screen.
 */
export function enterTeacherFullscreenOnGesture(): Promise<boolean> {
  if (readTeacherExempt() || !fullscreenSupported() || isFullscreenNow()) {
    return Promise.resolve(isFullscreenNow());
  }
  return enterFullscreen();
}

export function useTeacherFullscreen(opts: { enabled: boolean; sharing: boolean }) {
  const { enabled, sharing } = opts;
  const [exempt] = useState(readTeacherExempt);
  const [supported] = useState(fullscreenSupported);
  const [iphone] = useState(() => typeof navigator !== 'undefined' && isIPhoneUA(navigator.userAgent || ''));
  const [isFullscreen, setIsFullscreen] = useState(isFullscreenNow);
  const [everFullscreen, setEverFullscreen] = useState(isFullscreenNow);
  const [permGrace, setPermGrace] = useState(() => permissionGrace.isActive());
  /** iPad: a text field is in use, so fullscreen is off on purpose (lib/fullscreenTyping). */
  const [typing, setTyping] = useState(() => typingHold.active());
  const [coverDismissed, setCoverDismissed] = useState(false);
  const [shareReminderDismissed, setShareReminderDismissed] = useState(false);
  const [iphoneHintDismissed, setIphoneHintDismissed] = useState(false);
  const graceTimer = useRef<number | null>(null);
  const prevSharing = useRef(sharing);

  useEffect(() => {
    if (prevSharing.current && !sharing) {
      setShareReminderDismissed(false);
    }
    prevSharing.current = sharing;
  }, [sharing]);

  useEffect(() => {
    if (!enabled || exempt || !supported) return;

    const syncGrace = () => {
      const active = permissionGrace.isActive();
      setPermGrace(active);
      if (graceTimer.current) {
        window.clearTimeout(graceTimer.current);
        graceTimer.current = null;
      }
      if (active) {
        graceTimer.current = window.setTimeout(() => {
          graceTimer.current = null;
          setPermGrace(permissionGrace.isActive());
          setIsFullscreen(isFullscreenNow());
        }, permissionGrace.remainingMs() + 50);
      }
    };

    const sync = () => {
      const fs = isFullscreenNow();
      setIsFullscreen(fs);
      if (fs) {
        setEverFullscreen(true);
        setCoverDismissed(false);
      }
      syncGrace();
    };

    sync();
    if (!isFullscreenNow() && !sharing && !permissionGrace.isActive()) {
      void enterFullscreen().then((ok) => {
        if (ok) {
          setEverFullscreen(true);
          setCoverDismissed(false);
        }
        setIsFullscreen(isFullscreenNow());
      });
    }

    // iPad / iPhone: leave fullscreen before the keyboard opens (Safari
    // refuses typing in it); the first tap after typing brings it back.
    const appleTouch = isAppleTouchDevice(navigator.userAgent || '', navigator.maxTouchPoints || 0);
    let typedOut = false;
    const offTypingGuard = appleTouch
      ? installTypingGuard(document, () => {
          if (isFullscreenNow()) typedOut = true;
          // After typing: the small "return to full screen" bar, never the blocking cover.
          setCoverDismissed(true);
          void exitFullscreenIfActive();
        })
      : () => undefined;
    const offTyping = typingHold.subscribe(() => setTyping(typingHold.active()));

    const onGesture = (ev: Event) => {
      if (sharing || permissionGrace.isActive() || typingHold.active()) return;
      const target = ev.target as Element | null;
      // Never consume the click gesture that getDisplayMedia / permissions / End / Leave need.
      if (target?.closest?.('[data-no-auto-fullscreen]')) return;
      // A tap into a text field on an iPad must not re-enter fullscreen.
      if (appleTouch && isEditableTarget(target)) return;
      if (!isFullscreenNow() && (!everFullscreen || typedOut)) {
        typedOut = false;
        void enterFullscreen().then((ok) => {
          if (ok) {
            setEverFullscreen(true);
            setCoverDismissed(false);
          }
          setIsFullscreen(isFullscreenNow());
        });
      }
    };

    const offGrace = permissionGrace.subscribe(syncGrace);
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pageshow', sync);
    document.addEventListener('pointerdown', onGesture);
    document.addEventListener('keydown', onGesture);

    return () => {
      offGrace();
      offTypingGuard();
      offTyping();
      if (graceTimer.current) window.clearTimeout(graceTimer.current);
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('pageshow', sync);
      document.removeEventListener('pointerdown', onGesture);
      document.removeEventListener('keydown', onGesture);
    };
  }, [enabled, exempt, supported, sharing, everFullscreen]);

  const gate: TeacherFullscreenGate = enabled
    ? teacherFullscreenGate({
        exempt,
        fullscreenSupported: supported,
        isFullscreen,
        everFullscreen,
        iphone,
        sharing,
        permissionGrace: permGrace || typing,
        coverDismissed,
        shareReminderDismissed,
        iphoneHintDismissed,
      })
    : 'off';

  const returnToFullscreen = useCallback(async () => {
    const ok = await enterFullscreen();
    setIsFullscreen(isFullscreenNow());
    if (ok) {
      setEverFullscreen(true);
      setCoverDismissed(false);
      setShareReminderDismissed(false);
    } else if (everFullscreen) {
      // Never soft-lock the teacher if the browser/OS refuses fullscreen on click.
      setCoverDismissed(true);
    }
  }, [everFullscreen]);

  const dismiss = useCallback(() => {
    if (gate === 'share-reminder') setShareReminderDismissed(true);
    else if (gate === 'iphone-hint') setIphoneHintDismissed(true);
    else if (gate === 'cover') setCoverDismissed(true);
  }, [gate]);

  const exit = useCallback(() => {
    void exitFullscreenIfActive();
  }, []);

  return {
    gate,
    text: gate === 'off' ? null : teacherFullscreenText(gate),
    exempt,
    isFullscreen,
    returnToFullscreen,
    dismiss,
    exit,
  };
}
