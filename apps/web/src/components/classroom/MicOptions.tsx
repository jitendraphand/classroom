'use client';

/**
 * Small caret on the mic button: noise removal (Standard / Enhanced / Strong)
 * and, for teachers, voice focus. Saved on this device; a change republishes
 * the mic with the new chain (SelectivePublisher). The same choices exist in
 * the Windows app; the Android app uses the phone's own processing.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { NOISE_MODES, type NoiseMode } from '@/lib/audio/voiceSettings';
import {
  detectVoiceEnv,
  onVoiceSettings,
  onVoiceStatus,
  primeVoiceAudio,
  saveVoiceSettings,
  voiceSettings,
  voiceStatus,
} from '@/lib/audio/voiceProcessor';
import { cn } from '@/lib/cn';
import { placePopover } from '@/lib/popoverPlacement';

export function MicOptions({ isTeacher, small }: { isTeacher: boolean; small?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Offset of the panel inside `box` that keeps it in the viewport (null until measured).
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const settings = useSyncExternalStore(
    onVoiceSettings,
    () => JSON.stringify(voiceSettings(isTeacher)),
    () => ''
  );
  const status = useSyncExternalStore(onVoiceStatus, voiceStatus, () => null);
  const s = settings ? (JSON.parse(settings) as ReturnType<typeof voiceSettings>) : null;
  const supported = typeof window !== 'undefined' && detectVoiceEnv().worklet;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The caret can sit anywhere (bottom bar, a top corner on the student
  // layout, the compact toolbar), so a fixed "above, centred" placement was
  // clipped at 1280x720 (Nov 7 trial). Measure and keep it on screen.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const b = button.current?.getBoundingClientRect();
      const host = box.current?.getBoundingClientRect();
      const p = panel.current;
      if (!b || !host || !p) return;
      const r = placePopover({
        anchor: { left: b.left, top: b.top, width: b.width, height: b.height },
        size: { width: p.offsetWidth, height: p.scrollHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      setPos({ left: r.left - host.left, top: r.top - host.top, maxHeight: r.maxHeight ?? undefined });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, isTeacher, status?.label]);

  const choose = (noise: NoiseMode) => {
    if (!s) return;
    saveVoiceSettings({ ...s, noise });
    primeVoiceAudio(isTeacher);
  };

  return (
    <div ref={box} className="relative z-[5] inline-flex shrink-0">
      <button
        ref={button}
        type="button"
        data-testid="mic-options"
        aria-label="Microphone options"
        title="Microphone options"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center justify-center rounded-full border border-white/25 bg-surface-1 text-slate-100 shadow-lift hover:bg-surface-2',
          small ? 'h-6 w-6' : 'h-9 w-9'
        )}
      >
        <svg viewBox="0 0 12 12" width={small ? 8 : 10} height={small ? 8 : 10} aria-hidden>
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && s && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Microphone options"
          data-testid="mic-options-panel"
          // Hidden for the first layout pass, then placed inside the viewport.
          style={pos ?? { left: 0, top: 0, visibility: 'hidden' }}
          className="absolute z-[90] w-[min(18rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-white/15 bg-surface-1/95 p-3 text-left text-xs text-slate-100 shadow-lift backdrop-blur"
        >
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Noise removal</p>
          <div role="radiogroup" aria-label="Noise removal" className="space-y-1">
            {NOISE_MODES.map((m) => {
              const disabled = m.id !== 'standard' && !supported;
              return (
                <label
                  key={m.id}
                  className={cn(
                    'flex cursor-pointer gap-2 rounded-lg px-2 py-1.5 hover:bg-white/[0.06]',
                    s.noise === m.id && 'bg-white/[0.08]',
                    disabled && 'cursor-not-allowed opacity-50'
                  )}
                >
                  <input
                    type="radio"
                    name="noise-mode"
                    className="mt-0.5 accent-brand-500"
                    checked={s.noise === m.id}
                    disabled={disabled}
                    onChange={() => choose(m.id)}
                  />
                  <span>
                    <span className="block font-semibold">{m.label}</span>
                    <span className="block text-[11px] leading-snug text-slate-300">{m.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {isTeacher && (
            <label className={cn('mt-2 flex cursor-pointer gap-2 rounded-lg px-2 py-1.5 hover:bg-white/[0.06]', !supported && 'cursor-not-allowed opacity-50')}>
              <input
                type="checkbox"
                className="mt-0.5 accent-brand-500"
                checked={s.focus}
                disabled={!supported}
                onChange={(e) => {
                  saveVoiceSettings({ ...s, focus: e.target.checked });
                  primeVoiceAudio(true);
                }}
              />
              <span>
                <span className="block font-semibold">Voice focus</span>
                <span className="block text-[11px] leading-snug text-slate-300">
                  Turns down voices and sounds well below your own speaking level, between your sentences.
                </span>
              </span>
            </label>
          )}
          <p className="mt-2 border-t border-white/10 pt-2 text-[11px] leading-snug text-slate-300" data-testid="mic-options-status">
            {!supported
              ? 'This browser uses its own noise suppression.'
              : status
                ? `Now: ${status.label}.${status.note ? ` ${status.note}` : ''}`
                : 'Applies when your microphone is on.'}
          </p>
        </div>
      )}
    </div>
  );
}
