'use client';

import { dataSaverBadge, dataSaverLabel, type DataSaverMode } from '@/lib/dataSaver';
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
  IconUsers,
  IconPen,
  IconBoard,
  IconVideo,
} from '@/components/ui/Icons';
import { cn } from '@/lib/cn';

type Props = {
  micOn: boolean;
  camOn: boolean;
  screenOn: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onToggleScreen: () => void;
  /** Teacher: open/close the whiteboard (shared with students over data channels). */
  onToggleWhiteboard?: () => void;
  whiteboardOn?: boolean;
  onLeave: () => void;
  isTeacher?: boolean;
  onEnd?: () => void;
  onRotateSample?: () => void;
  onMuteAll?: () => void;
  onUnmuteAll?: () => void;
  canPublishVideo: boolean;
  mutedByTeacher?: boolean;
  /**
   * Student mic locked for a reason other than a teacher mute (e.g. the
   * teacher is not connected). Disables unmute and shows this short reason.
   */
  micLockReason?: string | null;
  /** When false, hide the screen-share button (students). Default true. */
  showScreenShare?: boolean;
  /** Dock sits in the bottom bar; float is a denser floating panel. */
  variant?: 'dock' | 'float';
  /**
   * Float only. 'rail': phone landscape, a slim vertical column of small
   * buttons (status text moves to a small pill at the top). 'phone': portrait
   * phone, tighter padding.
   */
  layout?: 'rail' | 'phone';
  /** Toggle chat floating panel (open ↔ close) */
  onToggleChat?: () => void;
  chatOpen?: boolean;
  chatUnread?: number;
  /** Teacher: toggle roster floating panel (open ↔ close) */
  onToggleRoster?: () => void;
  rosterOpen?: boolean;
  rosterBadge?: number;
  /** Teacher: raised hands, badged on the roster button while it is closed. */
  handsCount?: number;
  /** Student raise-hand */
  handRaised?: boolean;
  onToggleHand?: () => void;
  /**
   * Student: drawing on the teacher's share. 'off' → "Request to draw",
   * 'requested' → cancel the request, 'drawing' → stop drawing. Hidden when
   * undefined (no share).
   */
  drawState?: 'off' | 'requested' | 'drawing';
  onToggleDraw?: () => void;
  /**
   * Fired on pointer-down / Enter / Space before the share click, so Firefox
   * and Safari can open the controls popup without consuming the gesture that
   * getDisplayMedia needs.
   */
  onPrepareScreenShare?: () => void;
  /** Student data saver (cycles off → Low quality → Audio + share only). */
  dataSaver?: DataSaverMode;
  onCycleDataSaver?: () => void;
  /** Student: cycles teacher+self / teacher / minimized. Shown only when set. */
  videoPanelLabel?: string;
  /** Rail: short word (Both / Teacher / Hidden). Full sentence stays in title. */
  videoPanelShortLabel?: string;
  onCycleVideoPanel?: () => void;
  /** Student mic queue. Label is "Ask to speak" or "Waiting (#n)". */
  askToSpeakLabel?: string;
  onAskToSpeak?: () => void;
  /** Shown near the buttons while this student is in the speaking queue. */
  micWaitNote?: string | null;
};

export function Controls({
  micOn,
  camOn,
  screenOn,
  onToggleMic,
  onToggleCam,
  onToggleScreen,
  onToggleWhiteboard,
  whiteboardOn,
  onLeave,
  isTeacher,
  onEnd,
  onRotateSample,
  onMuteAll,
  onUnmuteAll,
  canPublishVideo: _canPublishVideo,
  mutedByTeacher,
  micLockReason,
  showScreenShare = true,
  variant = 'dock',
  layout,
  onToggleChat,
  chatOpen = false,
  chatUnread = 0,
  onToggleRoster,
  rosterOpen = false,
  rosterBadge = 0,
  handsCount = 0,
  handRaised,
  onToggleHand,
  drawState,
  onToggleDraw,
  onPrepareScreenShare,
  dataSaver,
  onCycleDataSaver,
  videoPanelLabel,
  videoPanelShortLabel,
  onCycleVideoPanel,
  askToSpeakLabel,
  onAskToSpeak,
  micWaitNote,
}: Props) {
  void _canPublishVideo;
  const teacherMuted = !!mutedByTeacher && !isTeacher;
  const lockReason = !isTeacher && micLockReason ? micLockReason : null;
  const micLocked = teacherMuted || !!lockReason;
  const isFloat = variant === 'float';
  const rail = isFloat && layout === 'rail';
  const btn = rail ? ('sm' as const) : undefined;

  return (
    <>
    <div
      className={cn(
        rail
          ? 'control-rail'
          : isFloat
            ? cn('control-float mx-auto w-auto max-w-[95vw]', layout === 'phone' && 'control-float-phone')
            : 'control-dock mx-auto w-full max-w-5xl'
      )}
    >
      <div
        className={cn(
          'flex items-center justify-center',
          rail ? 'flex-col gap-1' : 'flex-wrap',
          !rail && (isFloat ? 'gap-1.5' : 'gap-2')
        )}
      >
        <IconButton
          size={btn}
          label={
            teacherMuted
              ? 'Muted by teacher'
              : lockReason
                ? lockReason
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
          size={btn}
          label={camOn ? 'Turn camera off' : 'Turn camera on'}
          active={camOn}
          danger={!camOn}
          onClick={onToggleCam}
        >
          {camOn ? <IconCam /> : <IconCamOff />}
        </IconButton>

        {onCycleVideoPanel && (
          <button
            type="button"
            data-testid="video-panel"
            aria-label="Video panel"
            aria-description={videoPanelLabel || 'Video panel'}
            title={videoPanelLabel || 'Video panel'}
            onClick={onCycleVideoPanel}
            className={cn(
              'inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-center font-semibold leading-tight text-slate-100 hover:bg-white/[0.12]',
              rail
                ? 'h-auto min-h-[var(--rail-btn,36px)] w-[var(--rail-btn,36px)] flex-col gap-0.5 px-0.5 py-1 text-[8px]'
                : 'h-11 max-w-[11rem] gap-1 px-2 text-[10px]'
            )}
          >
            <IconVideo size={rail ? 14 : 16} />
            <span className="max-w-full truncate">{videoPanelShortLabel || 'Videos'}</span>
            <span className="sr-only">{videoPanelLabel || 'Video panel'}</span>
          </button>
        )}

        {onAskToSpeak && (
          <button
            type="button"
            data-testid="ask-to-speak"
            onClick={onAskToSpeak}
            className={cn(
              'inline-flex items-center justify-center rounded-full border border-amber-400/40 bg-amber-500/20 font-semibold leading-tight text-amber-100 hover:bg-amber-500/30',
              rail ? 'w-full px-1 py-1 text-[9px]' : 'h-9 px-2.5 text-[11px]'
            )}
          >
            {askToSpeakLabel || 'Ask to speak'}
          </button>
        )}

        {showScreenShare && (
          <IconButton
            label={screenOn ? 'Stop sharing screen' : 'Share screen'}
            active={screenOn}
            onPointerDown={() => {
              if (!screenOn) onPrepareScreenShare?.();
            }}
            onKeyDown={(e) => {
              if (screenOn) return;
              if (e.key === 'Enter' || e.key === ' ') onPrepareScreenShare?.();
            }}
            onClick={onToggleScreen}
          >
            <IconScreen />
          </IconButton>
        )}

        {onToggleWhiteboard && (
          <IconButton label={whiteboardOn ? 'Stop whiteboard sharing' : 'Share a whiteboard (students see it live)'} active={!!whiteboardOn} onClick={onToggleWhiteboard}>
            <IconBoard />
          </IconButton>
        )}

        {!isTeacher && onToggleHand && (
          <IconButton
            size={btn}
            label={handRaised ? 'Lower hand' : 'Raise hand'}
            active={!!handRaised}
            onClick={onToggleHand}
          >
            <IconHand />
          </IconButton>
        )}

        {!isTeacher && drawState && onToggleDraw && (
          <IconButton
            size={btn}
            label={
              drawState === 'drawing'
                ? 'Stop drawing'
                : drawState === 'requested'
                  ? 'Cancel request to draw'
                  : 'Request to draw on the screen'
            }
            active={drawState !== 'off'}
            onClick={onToggleDraw}
          >
            <span className="relative inline-flex">
              <IconPen />
              {drawState === 'requested' && (
                <span className="absolute -right-1.5 -top-1.5 h-2.5 w-2.5 animate-pulse rounded-full bg-amber-400" aria-hidden />
              )}
            </span>
          </IconButton>
        )}

        {!isTeacher && dataSaver && onCycleDataSaver && (
          <IconButton
            size={btn}
            label={dataSaverLabel(dataSaver)}
            active={dataSaver !== 'off'}
            onClick={onCycleDataSaver}
          >
            <span className="text-[10px] font-bold leading-none tracking-tight" aria-hidden>
              {dataSaverBadge(dataSaver)}
            </span>
          </IconButton>
        )}

        {onToggleChat && (
          <IconButton
            size={btn}
            label={chatOpen ? 'Close chat' : 'Open chat'}
            active={chatOpen}
            onClick={onToggleChat}
          >
            <span className="relative inline-flex">
              <IconChat />
              {!chatOpen && chatUnread > 0 && (
                <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-500 px-0.5 text-[9px] font-bold text-white">
                  {chatUnread > 9 ? '9+' : chatUnread}
                </span>
              )}
            </span>
          </IconButton>
        )}

        {isTeacher && onToggleRoster && (
          <IconButton
            label={
              rosterOpen
                ? 'Close roster'
                : handsCount > 0
                  ? `Open roster (${handsCount} raised ${handsCount === 1 ? 'hand' : 'hands'})`
                  : 'Open roster'
            }
            active={rosterOpen}
            onClick={onToggleRoster}
          >
            <span className="relative inline-flex">
              <IconUsers />
              {!rosterOpen && handsCount > 0 && (
                <span
                  className="absolute -bottom-1.5 -left-2 flex h-4 min-w-4 items-center justify-center gap-px rounded-full bg-amber-400 px-0.5 text-[9px] font-bold text-ink-950"
                  aria-hidden
                >
                  <IconHand size={9} />
                  {handsCount > 9 ? '9+' : handsCount}
                </span>
              )}
              {!rosterOpen && rosterBadge > 0 && (
                <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-0.5 text-[9px] font-bold text-white">
                  {rosterBadge > 9 ? '9+' : rosterBadge}
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

        <IconButton size={btn} label="Leave class" danger onClick={onLeave}>
          <IconLeave />
        </IconButton>

        {isTeacher && onEnd && !isFloat && (
          <Button variant="danger" size="sm" onClick={onEnd}>
            End class
          </Button>
        )}
      </div>

      {micLocked && !rail && (
        <p
          className={cn('w-full text-center text-2xs text-amber-200/90', layout === 'phone' ? 'mt-1' : 'mt-2')}
          role="status"
        >
          {teacherMuted ? 'Muted by teacher — wait to be unmuted' : lockReason}
        </p>
      )}
      {micWaitNote && !rail && (
        <p className="mt-1 w-full text-center text-2xs text-amber-200/90" role="status">
          {micWaitNote}
        </p>
      )}
    </div>
    {micLocked && rail && (
      // Outside the rail (its backdrop-filter would trap position: fixed).
      <p className="control-status-pill" role="status">
        {teacherMuted ? 'Muted by teacher' : lockReason}
      </p>
    )}
    {micWaitNote && rail && (
      <p className={cn('control-status-pill', micLocked && 'is-second')} role="status">
        {micWaitNote}
      </p>
    )}
    </>
  );
}
