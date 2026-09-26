'use client';

import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import {
  IconMic,
  IconMicOff,
  IconCam,
  IconCamOff,
  IconScreen,
  IconLeave,
  IconRotate,
  IconChat,
  IconHand,
} from '@/components/ui/Icons';
import { cn } from '@/lib/cn';

type Props = {
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onToggleScreen: () => void;
  onLeave: () => void;
  isTeacher?: boolean;
  onEnd?: () => void;
  onRotateSample?: () => void;
  onMuteAll?: () => void;
  onUnmuteAll?: () => void;
  canPublishVideo: boolean;
  mutedByTeacher?: boolean;
  /** When false, hide the screen-share button (students). Default true. */
  showScreenShare?: boolean;
  /** Dock sits in the bottom bar; float is a denser floating panel. */
  variant?: 'dock' | 'float';
  /** Float mode: open chat overlay */
  onOpenChat?: () => void;
  chatUnread?: number;
  /** Student raise-hand */
  handRaised?: boolean;
  onToggleHand?: () => void;
};

export function Controls({
  micOn,
  camOn,
  screenOn,
  onToggleMic,
  onToggleCam,
  onToggleScreen,
  onLeave,
  isTeacher,
  onEnd,
  onRotateSample,
  onMuteAll,
  onUnmuteAll,
  canPublishVideo: _canPublishVideo,
  mutedByTeacher,
  showScreenShare = true,
  variant = 'dock',
  onOpenChat,
  chatUnread = 0,
  handRaised,
  onToggleHand,
}: Props) {
  void _canPublishVideo;
  const micLocked = !!mutedByTeacher && !isTeacher;
  const isFloat = variant === 'float';

  return (
    <div
      className={cn(
        isFloat
          ? 'control-float mx-auto w-auto max-w-[95vw]'
          : 'control-dock mx-auto w-full max-w-5xl'
      )}
    >
      <div className={cn('flex flex-wrap items-center justify-center', isFloat ? 'gap-1.5' : 'gap-2')}>
        <IconButton
          label={
            micLocked
              ? 'Muted by teacher'
              : micOn
                ? 'Mute microphone'
                : 'Unmute microphone'
          }
          active={micOn && !micLocked}
          danger={!micOn || micLocked}
          disabled={micLocked}
          onClick={() => {
            if (micLocked) return;
            onToggleMic();
          }}
        >
          {micOn && !micLocked ? <IconMic /> : <IconMicOff />}
        </IconButton>

        <IconButton
          label={camOn ? 'Turn camera off' : 'Turn camera on'}
          active={camOn}
          danger={!camOn}
          onClick={onToggleCam}
        >
          {camOn ? <IconCam /> : <IconCamOff />}
        </IconButton>

        {showScreenShare && (
          <IconButton
            label={screenOn ? 'Stop sharing screen' : 'Share screen'}
            active={screenOn}
            onClick={onToggleScreen}
          >
            <IconScreen />
          </IconButton>
        )}

        {!isTeacher && onToggleHand && (
          <IconButton
            label={handRaised ? 'Lower hand' : 'Raise hand'}
            active={!!handRaised}
            onClick={onToggleHand}
          >
            <IconHand />
          </IconButton>
        )}

        {isFloat && onOpenChat && (
          <IconButton label="Open chat" onClick={onOpenChat}>
            <span className="relative inline-flex">
              <IconChat />
              {chatUnread > 0 && (
                <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-500 px-0.5 text-[9px] font-bold text-white">
                  {chatUnread > 9 ? '9+' : chatUnread}
                </span>
              )}
            </span>
          </IconButton>
        )}

        {isTeacher && onRotateSample && !isFloat && (
          <IconButton label="Rotate video sample" onClick={onRotateSample}>
            <IconRotate />
          </IconButton>
        )}

        {!isFloat && (
          <div className="mx-1 hidden h-8 w-px bg-white/10 sm:block" aria-hidden />
        )}

        {isTeacher && onMuteAll && !isFloat && (
          <Button variant="warning" size="sm" onClick={onMuteAll}>
            Mute all
          </Button>
        )}
        {isTeacher && onUnmuteAll && !isFloat && (
          <Button variant="secondary" size="sm" onClick={onUnmuteAll}>
            Unmute all
          </Button>
        )}

        <IconButton label="Leave class" danger onClick={onLeave}>
          <IconLeave />
        </IconButton>

        {isTeacher && onEnd && !isFloat && (
          <Button variant="danger" size="sm" onClick={onEnd}>
            End class
          </Button>
        )}
      </div>

      {micLocked && (
        <p className="mt-2 w-full text-center text-2xs text-amber-200/90">
          Muted by teacher — wait to be unmuted
        </p>
      )}
    </div>
  );
}
