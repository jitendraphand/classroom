'use client';

/**
 * Whiteboard meeting column, docked on the right. Same order as the Windows
 * MeetingBar: mic, camera, chat, people/hands, admit, student drawing,
 * mute all, student videos, class info, Stop whiteboard, End.
 * No allow-all-unmute (Nov 25): students are unmuted one at a time
 * from the roster, and only while their camera is on.
 */
import { useEffect, type ReactNode } from 'react';
import { notifyFloatBounds } from './FloatingPanel';
import { IconCam, IconCamOff, IconChat, IconLeave, IconMic, IconMicOff, IconPen, IconScreen, IconSpeakerOff, IconUserPlus, IconUsers, IconVideo } from '@/components/ui/Icons';
import { LeaveEndMenu } from './LeaveEndMenu';
import { FlyoutBar, barBtn, type FlyoutGroup } from '@/lib/whiteboard/FlyoutBar';
import { ALLOW_GREEN, MEETING_BAR_PX, admitLabel, focusAlertDanger, peopleBadgeCount } from '@/lib/shareChrome';

export type MeetingPerson = { id: string; displayName: string };

export function WhiteboardMeetingBar({
  micOn,
  onToggleMic,
  camOn,
  onToggleCam,
  chatUnread,
  chatOpen,
  onToggleChat,
  hands,
  focusAlerts,
  rosterOpen,
  onToggleRoster,
  waiting,
  onAdmit,
  onAdmitAll,
  requests,
  drawers,
  onAllowDraw,
  onRevokeDraw,
  onMuteAll,
  info,
  videosOn,
  onToggleVideos,
  onStopWhiteboard,
  onEndClass,
  onLeave,
}: {
  micOn: boolean;
  onToggleMic: () => void;
  camOn: boolean;
  onToggleCam: () => void;
  chatUnread: number;
  chatOpen: boolean;
  onToggleChat: () => void;
  hands: number;
  focusAlerts: number;
  rosterOpen: boolean;
  onToggleRoster: () => void;
  waiting: MeetingPerson[];
  onAdmit: (id: string) => void;
  onAdmitAll: () => void;
  requests: MeetingPerson[];
  drawers: MeetingPerson[];
  onAllowDraw: (id: string) => void;
  onRevokeDraw: (id?: string) => void;
  /** Mutes every student (one-way; unmuting is per student). */
  onMuteAll: () => void;
  /** Class info (i) button, hover/tap (Nov 25: replaces the teacher header). */
  info?: ReactNode;
  videosOn: boolean;
  onToggleVideos: () => void;
  onStopWhiteboard: () => void;
  onEndClass: () => void;
  /** Teacher leaves; the class keeps running (with End, in one menu). */
  onLeave: () => void;
}) {
  // Floats (roster, chat, videos, spotlight) re-clamp left of this bar when it
  // appears and spread back when it goes (Nov 25).
  useEffect(() => {
    notifyFloatBounds();
    return () => {
      requestAnimationFrame(() => notifyFloatBounds());
    };
  }, []);
  const ic = (node: ReactNode) => node;
  const waitingN = waiting.length;
  const oldest = waiting[0];
  const groups: FlyoutGroup[] = [
    {
      id: 'mic',
      label: micOn ? 'Mute microphone' : 'Unmute microphone',
      icon: ic(micOn ? <IconMic size={18} /> : <IconMicOff size={18} />),
      danger: !micOn,
      onClick: onToggleMic,
      testId: 'wbm-mic',
    },
    {
      id: 'cam',
      label: camOn ? 'Turn camera off' : 'Turn camera on',
      icon: ic(camOn ? <IconCam size={18} /> : <IconCamOff size={18} />),
      onClick: onToggleCam,
      testId: 'wbm-cam',
    },
    {
      id: 'chat',
      label: chatOpen ? 'Close chat' : 'Open chat',
      icon: ic(<IconChat size={18} />),
      badge: chatOpen ? 0 : chatUnread,
      active: chatOpen,
      onClick: onToggleChat,
      testId: 'wbm-chat',
    },
    {
      id: 'people',
      label: rosterOpen ? 'Close roster' : 'Open roster',
      // Same icon and name as the class toolbar and share controls ("Roster");
      // raised hands and fullscreen alerts are the badge.
      icon: ic(<IconUsers size={18} />),
      badge: peopleBadgeCount(hands, focusAlerts),
      danger: focusAlertDanger(focusAlerts),
      active: rosterOpen,
      onClick: onToggleRoster,
      testId: 'wbm-people',
    },
    {
      id: 'admit',
      label: admitLabel(waitingN, oldest?.displayName),
      icon: ic(<IconUserPlus size={18} />),
      badge: waitingN,
      warn: waitingN > 0,
      disabled: waitingN === 0,
      onClick: () => (waitingN > 1 ? onAdmitAll() : oldest && onAdmit(oldest.id)),
      testId: 'wbm-admit',
    },
    {
      id: 'perm',
      label: requests.length ? `${requests.length} asking to draw` : 'Student drawing',
      icon: ic(<IconPen size={18} />),
      badge: requests.length,
      active: drawers.length > 0,
      testId: 'wbm-perm',
      content: (
        <>
          {!requests.length && !drawers.length ? (
            <span style={{ color: '#94a3b8', fontSize: 12, padding: 6, width: 160 }}>No requests. Students ask with their pen button.</span>
          ) : null}
          {requests.map((p) => (
            <span key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#e2e8f0', fontSize: 12 }}>
              <span style={{ flex: 1, minWidth: 80 }}>{p.displayName}</span>
              <button type="button" style={barBtn(false, { background: ALLOW_GREEN })} data-testid="wbm-draw-allow" title={`Let ${p.displayName} draw on the board`} onClick={() => onAllowDraw(p.id)}>
                Allow
              </button>
              <button type="button" style={barBtn()} data-testid="wbm-draw-deny" title={`Decline ${p.displayName}`} onClick={() => onRevokeDraw(p.id)}>
                Deny
              </button>
            </span>
          ))}
          {drawers.map((p) => (
            <span key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#e2e8f0', fontSize: 12 }}>
              <span style={{ flex: 1, minWidth: 80 }}>✎ {p.displayName}</span>
              <button type="button" style={barBtn(false, { background: '#b91c1c' })} onClick={() => onRevokeDraw(p.id)}>
                Stop
              </button>
            </span>
          ))}
        </>
      ),
    },
    {
      id: 'muteall',
      label: 'Mute all students',
      icon: ic(<IconSpeakerOff size={18} />),
      onClick: onMuteAll,
      testId: 'wbm-mute-all',
    },
    {
      id: 'videos',
      label: videosOn ? 'Close student videos' : 'Show student videos',
      icon: ic(<IconVideo size={18} />),
      active: videosOn,
      onClick: onToggleVideos,
      testId: 'wbm-videos',
    },
  ];
  const tail = (
    <>
      {info ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }} data-testid="wbm-info">
          {info}
        </div>
      ) : null}
      <span style={{ flex: 1 }} />
      <button type="button" style={barBtn(false, { background: '#b91c1c', width: 40 })} title="Stop whiteboard sharing" aria-label="Stop whiteboard sharing" data-testid="wbm-stop" onClick={onStopWhiteboard}>
        <IconScreen size={18} />
      </button>
      <LeaveEndMenu onLeave={onLeave} onEnd={onEndClass} placement="left" testId="wbm-end" triggerStyle={barBtn(false, { width: 40, background: '#b91c1c' })}>
        <IconLeave size={18} />
      </LeaveEndMenu>
    </>
  );
  return (
    <div data-testid="meeting-bar" data-float-bound="right" style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: MEETING_BAR_PX, zIndex: 110 }}>
      <FlyoutBar
        groups={groups}
        orient="vertical"
        side="before"
        label="Meeting"
        tail={tail}
        style={{ height: '100%', width: MEETING_BAR_PX, boxSizing: 'border-box', borderLeft: '1px solid #ffffff1f', borderRadius: 0 }}
      />
    </div>
  );
}
