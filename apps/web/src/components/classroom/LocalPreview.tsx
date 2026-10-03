'use client';

import { useEffect, useRef } from 'react';
import { Avatar } from '@/components/ui/Avatar';

type Props = {
  stream: MediaStream | null;
  label: string;
  inSample: boolean;
  showMayBeVisible: boolean;
  /** When true (students), hide sample/local chips and publishing status. */
  hideSampleStatus?: boolean;
  /** The teacher's own tile: teacher wording, no student "sample" chips. */
  isTeacher?: boolean;
};

export function LocalPreview({
  stream,
  label,
  inSample,
  showMayBeVisible,
  hideSampleStatus = false,
  isTeacher = false,
}: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const hasVideo = !!stream && stream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
  }, [stream]);

  return (
    <div className="video-tile aspect-video">
      {hasVideo ? (
        <video ref={ref} autoPlay muted playsInline className="video-mirror h-full w-full object-cover" />
      ) : (
        <>
          <video ref={ref} autoPlay muted playsInline className="hidden" />
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-surface-3 to-ink-950">
            <Avatar name={label} size="lg" />
          </div>
        </>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/75 via-black/30 to-transparent p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-white">
            {hideSampleStatus ? 'You' : isTeacher ? `${label} (you, teacher)` : `${label} (you)`}
          </p>
          {!hideSampleStatus && (
            <p className="text-2xs text-slate-300">
              {isTeacher
                ? inSample
                  ? 'Visible to students'
                  : 'Not visible to students'
                : inSample
                  ? 'Publishing to teacher'
                  : 'Local preview only'}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {!hideSampleStatus &&
            !isTeacher &&
            (inSample ? (
              <span className="chip-sample">In sample</span>
            ) : (
              <span className="chip-local">Local only</span>
            ))}
          {(showMayBeVisible || hideSampleStatus) && (
            <span className="chip border-emerald-400/20 bg-emerald-500/10 text-emerald-200">
              <span className="indicator-pulse scale-75">
                <span />
              </span>
              In class
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
