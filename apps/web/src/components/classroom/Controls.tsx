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
  IconChat,
  IconHand,
  IconUsers,
  IconPen,
  IconBoard,
  IconVideo,
} from '@/components/ui/Icons';
import { cn } from '@/lib/cn';
import { LeaveEndMenu } from './LeaveEndMenu';
import { MicOptions } from './MicOptions';
import type { ReactNode } from 'react';

/** A toolbar button with a short visible caption under it (dock and phone bar; not the narrow rail). */
function Tool({ caption, show, wide, children }: { caption: string; show: boolean; wide?: boolean; children: ReactNode }) {
  if (!show) return <>{children}</>;
  return (
    <div className={cn('flex flex-col items-center gap-1', wide ? 'min-w-[3.5rem]' : 'w-12')}>
      {children}
      <span className="max-w-full truncate text-[10px] font-medium leading-none text-slate-300" aria-hidden>
        {caption}
      </span>
    </div>
  );
}

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
  /** Teacher: mute every student (no "allow all to unmute": unmute is per student, Nov 25). */
  onMuteAll?: () => void;
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
  onMuteAll,
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
  micWaitNote,
}: Props) {
  void _canPublishVideo;
  const teacherMuted = !!mutedByTeacher && !isTeacher;
  const lockReason = !isTeacher && micLockReason ? micLockReason : null;
  const micLocked = teacherMuted || !!lockReason;
  const isFloat = variant === 'float';
  const rail = isFloat && layout === 'rail';
  const btn = rail ? ('sm' as const) : undefined;
  // Visible words under the icons wherever there is room (not the landscape rail).
  const captions = !rail;
  const wide = !isFloat;

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
          !rail && (isFloat ? 'gap-1' : 'gap-2')
        )}
      >
        <Tool caption={micLocked ? 'Muted' : 'Mic'} show={captions} wide={wide || !micLocked}>
        <span className="relative inline-flex items-center gap-1">
        <IconButton
          size={btn}
          data-no-auto-fullscreen
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
        {!micLocked && <MicOptions isTeacher={!!isTeacher} small={rail} />}
        </span>
        </Tool>

        <Tool caption="Camera" show={captions} wide={wide}>
        <IconButton
          size={btn}
          data-no-auto-fullscreen
          label={camOn ? 'Turn camera off' : 'Turn camera on'}
          active={camOn}
          danger={!camOn}
          onClick={onToggleCam}
        >
          {camOn ? <IconCam /> : <IconCamOff />}
        </IconButton>
        </Tool>

        {onCycleVideoPanel && (
          <Tool caption="Videos" show={captions} wide={wide}>
          <button
            type="button"
            data-testid="video-panel"
            aria-label="Video panel"
            // The full sentence is the title, which assistive tech also reads
            // as the description (aria-description is not valid on a button).
            title={videoPanelLabel || 'Video panel'}
            onClick={onCycleVideoPanel}
            className={cn(
              'inline-flex items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-center font-semibold leading-tight text-slate-100 hover:bg-white/[0.12]',
              rail
                ? 'h-auto min-h-[var(--rail-btn,36px)] w-[var(--rail-btn,36px)] flex-col gap-0.5 px-0.5 py-1 text-[8px]'
                : 'h-11 w-11'
            )}
          >
            <IconVideo size={rail ? 14 : 18} />
            {/* The rail has no captions: a one-word state (All / Teacher / Hidden) under the icon. */}
            {rail && <span className="max-w-full truncate">{videoPanelShortLabel || 'Videos'}</span>}
            <span className="sr-only">{videoPanelLabel || 'Video panel'}</span>
          </button>
          </Tool>
        )}

        {showScreenShare && (
          <Tool caption={screenOn ? 'Stop share' : 'Share'} show={captions} wide={wide}>
          <IconButton
            data-no-auto-fullscreen
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
          </Tool>
        )}

        {onToggleWhiteboard && (
          <Tool caption="Whiteboard" show={captions} wide={wide}>
          <IconButton label={whiteboardOn ? 'Stop whiteboard sharing' : 'Share a whiteboard (students see it live)'} active={!!whiteboardOn} onClick={onToggleWhiteboard}>
            <IconBoard />
          </IconButton>
          </Tool>
        )}

        {!isTeacher && onToggleHand && (
          <Tool caption={handRaised ? 'Lower' : 'Hand'} show={captions} wide={wide}>
          <IconButton
            size={btn}
            data-no-auto-fullscreen
            label={handRaised ? 'Lower hand' : 'Raise hand'}
            active={!!handRaised}
            onClick={onToggleHand}
          >
            <IconHand />
          </IconButton>
          </Tool>
        )}

        {!isTeacher && drawState && onToggleDraw && (
          <Tool caption="Draw" show={captions} wide={wide}>
          <IconButton
            size={btn}
            label={
              drawState === 'drawing'
                ? 'Stop drawing'
                : drawState === 'requested'
                  ? 'Cancel request to draw'
                  : 'Request to draw on the whiteboard'
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
          </Tool>
        )}

        {!isTeacher && dataSaver && onCycleDataSaver && (
          <Tool caption="Quality" show={captions} wide={wide}>
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
          </Tool>
        )}

        {onToggleChat && (
          <Tool caption="Chat" show={captions} wide={wide}>
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
          </Tool>
        )}

        {isTeacher && onToggleRoster && (
          <Tool caption="Roster" show={captions} wide={wide}>
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
            </span>
          </IconButton>
          </Tool>
        )}

        {!isFloat && (
          <div className="mx-1 hidden h-8 w-px bg-white/10 sm:block" aria-hidden />
        )}

        {isTeacher && onMuteAll && !isFloat && (
          <Button variant="warning" size="sm" onClick={onMuteAll}>
            Mute all
          </Button>
        )}

        {/* Teacher: one button, both choices (Leave: just me; End class: everyone).
            Students only have Leave. */}
        <Tool caption="Leave" show={captions} wide={wide}>
          {isTeacher && onEnd ? (
            <LeaveEndMenu
              onLeave={onLeave}
              onEnd={onEnd}
              triggerClassName="inline-flex h-11 w-11 items-center justify-center rounded-full border border-red-400/40 bg-red-500/80 text-white hover:bg-red-500"
            >
              <IconLeave />
            </LeaveEndMenu>
          ) : (
            <IconButton size={btn} data-no-auto-fullscreen label="Leave class" danger onClick={onLeave}>
              <IconLeave />
            </IconButton>
          )}
        </Tool>
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
