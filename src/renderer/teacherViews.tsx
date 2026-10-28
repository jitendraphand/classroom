/**
 * Teacher roster and chat, laid out like the website's Roster and Chat
 * panels (same labels, icons, search and order). Used by the class window's
 * side panes and by the floating People / Messages windows during a share,
 * so both always look the same.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { PanelSnapshot, TeacherAction } from '../shared/actions';
import type { AdmittedPerson, ChatMessage } from '../shared/apiModel';
import { replyTargetFor, resolveChatRecipient } from '../shared/chatReply';
import { sortRoster } from '../shared/classLogic';
import { focusLabel, isFocusAlert } from '../shared/session';
import { filterMessages, filterPeople, normalizeQuery } from '../shared/web/peopleSearch';
import { ROSTER_PAGE, rosterWindow } from '../shared/web/rosterWindow';
import { ICONS, type IconName } from './icons';
import { avatarHue, initials, scopeBadge } from './people';

export type Send = (action: TeacherAction) => void;

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <span
      className="ico"
      style={{ width: size, height: size } as CSSProperties}
      aria-hidden="true"
      // Static SVG strings from icons.ts (generated from the website's icons), never user data.
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

export function Avatar({ name, small }: { name: string; small?: boolean }) {
  const style = { '--hue': String(avatarHue(name)) } as CSSProperties;
  return (
    <span className={small ? 'avatar xs' : 'avatar sm'} style={style} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

function IconBtn(props: { label: string; tone?: 'plain' | 'warn' | 'on'; pressed?: boolean; onClick: () => void; children: ReactNode }) {
  const tone = props.tone && props.tone !== 'plain' ? ` roster-icon-btn-${props.tone}` : '';
  return (
    <button
      type="button"
      className={'roster-icon-btn' + tone}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function rosterLabel(p: { displayName: string; rollNumber?: string | null; gradeDivision?: string | null; late?: boolean }): string {
  const bits = [p.displayName];
  if (p.rollNumber) bits.push(`Roll ${p.rollNumber}`);
  if (p.gradeDivision) bits.push(p.gradeDivision);
  if (p.late) bits.push('late');
  return bits.join(' · ');
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function RosterView({ snap, send, showLayout = false }: { snap: PanelSnapshot; send: Send; showLayout?: boolean }) {
  const [query, setQuery] = useState('');
  // Large classes: a page of rows at a time (shared lib/rosterWindow; search finds anyone).
  const [limit, setLimit] = useState(ROSTER_PAGE);
  const [waitLimit, setWaitLimit] = useState(ROSTER_PAGE);
  useEffect(() => {
    setLimit(ROSTER_PAGE);
    setWaitLimit(ROSTER_PAGE);
  }, [query]);
  const students = useMemo(() => sortRoster(snap.admitted.filter((p) => p.role === 'STUDENT')), [snap.admitted]);
  const matched = useMemo(() => filterPeople(students, query), [students, query]);
  const win = rosterWindow(matched, limit);
  const shown = win.shown;
  const waitWin = rosterWindow(filterPeople(snap.waiting, query), waitLimit);
  const waiting = waitWin.shown;
  const waitingOn = snap.hud.waitingRoomOn;
  // Students may draw on a shared screen or on the shared whiteboard.
  const sharing = snap.hud.sharing || !!snap.hud.whiteboardOn;
  const holder = snap.hud.drawHolderName;
  return (
    <div className="roster-view">
      {snap.waiting.length > 0 && (
        <div className="waiting-block">
          <div className="waiting-head">
            <h3>Waiting ({snap.waiting.length})</h3>
            {snap.waiting.length > 1 && (
              <button
                type="button"
                className="roster-admit-all"
                onClick={() => send({ type: 'admit-all' })}
                aria-label={`Admit all ${snap.waiting.length} waiting students`}
                title="Admit everyone waiting"
              >
                <Icon name="userPlus" size={12} />
                All
              </button>
            )}
          </div>
          <ul className="roster-list waiting-list">
            {waiting.map((p) => (
              <li key={p.id} className="roster-row" title={rosterLabel(p)}>
                <Avatar name={p.displayName} small />
                <span className="roster-name">{p.displayName}</span>
                {p.gradeDivision && <span className="roster-meta">{p.gradeDivision}</span>}
                {p.late && <span className="roster-chip roster-chip-red">Late</span>}
                <span className="roster-actions">
                  <IconBtn label={`Admit ${p.displayName}`} tone="warn" onClick={() => send({ type: 'admit', id: p.id })}>
                    <Icon name="userPlus" />
                  </IconBtn>
                </span>
              </li>
            ))}
            {waitWin.hidden > 0 && (
              <li>
                <button type="button" className="roster-more" onClick={() => setWaitLimit((n) => n + ROSTER_PAGE)}>
                  Show {waitWin.next} more ({waitWin.hidden} not shown; search finds anyone)
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
      <div className="roster-tools">
        <button type="button" className="btn sm warn" onClick={() => send({ type: 'mute-all', muted: true })}>
          Mute all
        </button>
        <button type="button" className="btn sm" onClick={() => send({ type: 'mute-all', muted: false })}>
          Unmute all
        </button>
        {showLayout && (
          <div className="seg" role="group" aria-label="Videos on screen">
            {([2, 4, 6] as const).map((n) => (
              <button
                key={n}
                className={'sym texty' + (snap.hud.layout === n ? ' on' : '')}
                type="button"
                title={`Show ${n} videos, including you`}
                aria-label={`Show ${n} videos, including you`}
                aria-pressed={snap.hud.layout === n}
                onClick={() => send({ type: 'layout', slots: n })}
              >
                {n}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={waitingOn}
          className={'waiting-toggle ' + (waitingOn ? 'is-on' : 'is-off')}
          onClick={() => send({ type: 'waiting-room', on: !waitingOn })}
          aria-label={waitingOn ? 'Waiting room on. Turn off to let students in directly' : 'Waiting room off. Turn on to admit students yourself'}
          title={
            waitingOn
              ? 'Waiting room on: you admit each student. Click to turn off (admits everyone waiting).'
              : 'Waiting room off: students enter directly, muted. Click to turn on.'
          }
        >
          <Icon name="door" size={13} />
          <span>{waitingOn ? 'Waiting room' : 'Direct entry'}</span>
        </button>
      </div>
      {sharing && (holder || snap.hud.drawStrokes > 0) && (
        <div className="draw-strip" role="status">
          <Icon name="pen" size={13} />
          <span className="draw-strip-text">{holder ? `${holder} ${holder.includes(', ') ? 'are' : 'is'} drawing` : 'Student drawing on screen'}</span>
          {snap.hud.drawStrokes > 0 && (
            <button type="button" className="roster-chip" onClick={() => send({ type: 'draw-clear' })}>
              Clear drawing
            </button>
          )}
          {holder && (
            <button type="button" className="roster-chip roster-chip-red" onClick={() => send({ type: 'draw-revoke' })}>
              Revoke
            </button>
          )}
        </div>
      )}
      {(snap.micQueue?.length ?? 0) > 0 && (
        <div className="mic-queue" data-testid="mic-queue">
          <h3 className="mic-queue-title">Speaking queue</h3>
          <ul>
            {snap.micQueue!.map((q) => (
              <li key={q.id} className="mic-queue-row">
                <span className="roster-name">{q.name}</span>
                <span className="roster-meta">waiting to speak</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {snap.spotlight && (
        <p className="spotlight-line" data-testid="spotlight-line">
          Spotlight: {snap.spotlight.name}
        </p>
      )}
      <label className="roster-search">
        <Icon name="search" size={13} />
        <input
          type="search"
          className="roster-search-input"
          placeholder="Search name or SID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
          aria-label="Search students"
        />
        {query.trim() && (
          <span className="chat-search-count">
            {matched.length}/{students.length}
          </span>
        )}
      </label>
      <ul className="roster-list">
        {students.length === 0 && (
          <li className="empty-state compact">
            <p className="empty-title">No students yet</p>
            <p className="hint">Admitted students will show up in this roster.</p>
          </li>
        )}
        {students.length > 0 && shown.length === 0 && <li className="roster-none">No student matches “{query.trim()}”.</li>}
        {shown.map((p) => (
          <RosterRow key={p.id} p={p} send={send} sharing={sharing} spotlit={snap.spotlight?.participantId === p.id} />
        ))}
        {win.hidden > 0 && (
          <li>
            <button type="button" className="roster-more" onClick={() => setLimit((n) => n + ROSTER_PAGE)}>
              Show {win.next} more ({win.hidden} not shown; search finds anyone)
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

/** Unmute a student who raised a hand, then lower the hand (one click to give the floor). */
function letSpeak(send: Send, id: string): void {
  send({ type: 'mute-one', id, muted: false });
  send({ type: 'lower-hand', id });
}

function RosterRow({ p, send, sharing, spotlit = false }: { p: AdmittedPerson; send: Send; sharing: boolean; spotlit?: boolean }) {
  const raised = p.handRaised;
  const focus = focusLabel(p.focus);
  return (
    <li className={'roster-row' + (raised || p.drawRequested || p.drawing ? ' roster-row-raised' : '')} title={rosterLabel(p)}>
      {(p.drawing || p.drawRequested) && (
        <span
          className={'roster-hand' + (p.drawing ? ' is-drawing' : '')}
          title={p.drawing ? 'Drawing on your screen' : 'Asks to draw'}
          aria-label={p.drawing ? 'Drawing on your screen' : 'Asks to draw'}
        >
          <Icon name="pen" size={13} />
        </span>
      )}
      {raised && (
        <span className="roster-hand" title="Hand raised" aria-label="Hand raised">
          <Icon name="hand" size={13} />
        </span>
      )}
      <Avatar name={p.displayName} small />
      <span className="roster-name">{p.displayName}</span>
      {p.gradeDivision && <span className="roster-meta">{p.gradeDivision}</span>}
      {focus && (
        <span className={'roster-chip' + (isFocusAlert(p.focus) ? ' roster-chip-warn' : '')} title={focus}>
          {focus}
        </span>
      )}
      {p.late && <span className="roster-chip roster-chip-red">Late</span>}
      {p.reconnecting && (
        <span className="roster-chip roster-chip-warn" title="Connection dropped; waiting for them to come back">
          Reconnecting
        </span>
      )}
      <span className="roster-actions">
        <button
          type="button"
          className={'roster-chip' + (spotlit ? ' roster-chip-warn' : '')}
          data-testid="spotlight"
          title={spotlit ? `Stop showing ${p.displayName}'s camera to the class` : `Show ${p.displayName}'s camera to the class`}
          onClick={() => send({ type: 'spotlight', id: spotlit ? null : p.id })}
        >
          {spotlit ? 'Stop spotlight' : 'Spotlight'}
        </button>
        <IconBtn
          label={p.mutedByTeacher ? `Unmute ${p.displayName}` : `Mute ${p.displayName}`}
          tone={p.mutedByTeacher ? 'warn' : 'plain'}
          pressed={p.mutedByTeacher}
          onClick={() => send({ type: 'mute-one', id: p.id, muted: !p.mutedByTeacher })}
        >
          <Icon name={p.mutedByTeacher ? 'micOff' : 'mic'} />
        </IconBtn>
        <IconBtn
          label={p.pinned ? `Unpin ${p.displayName}'s video` : `Pin ${p.displayName}'s video`}
          tone={p.pinned ? 'on' : 'plain'}
          pressed={p.pinned}
          onClick={() => send({ type: 'pin', id: p.id, pinned: !p.pinned })}
        >
          <Icon name="pin" size={13} />
        </IconBtn>
        {raised && p.mutedByTeacher && (
          // Giving the floor in one click: unmute, then lower the hand (web "Let … speak").
          <button
            type="button"
            className="roster-chip roster-chip-warn"
            data-testid="let-speak"
            title={`Unmute ${p.displayName} and lower their hand`}
            onClick={() => letSpeak(send, p.id)}
          >
            Let speak
          </button>
        )}
        {raised && (
          <IconBtn label={`Lower ${p.displayName}'s hand`} tone="warn" onClick={() => send({ type: 'lower-hand', id: p.id })}>
            <Icon name="handDown" />
          </IconBtn>
        )}
        {p.drawing ? (
          <button type="button" className="roster-chip roster-chip-red" onClick={() => send({ type: 'draw-revoke', id: p.id })}>
            Revoke
          </button>
        ) : p.drawRequested ? (
          <>
            <button
              type="button"
              className="roster-chip roster-chip-warn"
              disabled={!sharing}
              data-testid="draw-allow"
              title={sharing ? `Let ${p.displayName} draw` : 'Share your screen or the whiteboard first'}
              onClick={() => send({ type: 'draw-allow', id: p.id })}
            >
              Allow
            </button>
            <button
              type="button"
              className="roster-chip"
              data-testid="draw-deny"
              title={`Decline ${p.displayName}'s request to draw`}
              onClick={() => send({ type: 'draw-revoke', id: p.id })}
            >
              Deny
            </button>
          </>
        ) : null}
      </span>
    </li>
  );
}

export function ChatView({ snap, send }: { snap: PanelSnapshot; send: Send }) {
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [query, setQuery] = useState('');
  const [text, setText] = useState('');
  const students = useMemo(() => snap.admitted.filter((p) => p.role === 'STUDENT'), [snap.admitted]);
  const ids = useMemo(() => new Set(students.map((p) => p.id)), [students]);
  // Reply target chosen here wins until the class view catches up (no race with Enter).
  const [replyPick, setReplyPick] = useState<string | null>(null);
  const to = resolveChatRecipient(replyPick ?? (snap.chatTo === 'all' ? 'all' : snap.chatTo), ids);
  const focusReply = useRef(false);
  const toName = to === 'all' ? null : students.find((s) => s.id === to)?.displayName ?? null;
  const hands = useMemo(() => sortRoster(students.filter((p) => p.handRaised)), [students]);
  const searching = !!normalizeQuery(query);
  const matched = useMemo(() => filterPeople(students, query), [students, query]);
  const toOptions = useMemo(() => {
    if (!searching || to === 'all' || matched.some((s) => s.id === to)) return matched;
    const cur = students.find((s) => s.id === to);
    return cur ? [cur, ...matched] : matched;
  }, [searching, to, matched, students]);
  const sidById = useMemo(() => new Map(students.map((s) => [s.id, s.sid])), [students]);
  const shown: ChatMessage[] = useMemo(
    () => (searching ? filterMessages(snap.messages, query, sidById) : snap.messages),
    [searching, snap.messages, query, sidById]
  );
  const replyTo = (id: string) => {
    setReplyPick(id);
    send({ type: 'chat-to', to: id });
    focusReply.current = true;
    input.current?.focus();
  };
  const pickTo = (id: string) => {
    setReplyPick(id);
    send({ type: 'chat-to', to: id });
  };
  useEffect(() => {
    if (replyPick !== null && snap.chatTo === replyPick) setReplyPick(null);
  }, [snap.chatTo, replyPick]);
  // "Reply privately": the reply box gets focus after the re-render, never the search box.
  useEffect(() => {
    if (!focusReply.current) return;
    focusReply.current = false;
    const el = input.current;
    if (!el) return;
    el.focus();
    window.requestAnimationFrame(() => {
      if (document.activeElement !== el) el.focus();
    });
  }, [to]);
  const last = shown.length ? shown[shown.length - 1]?.id : '';
  useEffect(() => {
    const el = log.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [last, shown.length]);
  return (
    <div className="chat-view">
      {hands.length > 0 && (
        <div className="chat-hands" role="status" aria-label={`${hands.length} raised ${hands.length === 1 ? 'hand' : 'hands'}`}>
          <span className="chat-hands-label" title="Raised hands, earliest first">
            <Icon name="hand" size={12} />
            {hands.length}
          </span>
          <div className="chat-hands-list">
            {hands.map((h) => (
              <span key={h.id} className="chat-hand-chip">
                <button
                  type="button"
                  className="chat-hand-name"
                  onClick={() => replyTo(h.id)}
                  title={`Message ${h.displayName} privately`}
                  aria-label={`Reply to ${h.displayName} (hand raised)`}
                >
                  {h.displayName}
                </button>
                {h.mutedByTeacher && (
                  <button
                    type="button"
                    className="chat-hand-speak"
                    onClick={() => letSpeak(send, h.id)}
                    aria-label={`Let ${h.displayName} speak`}
                    title="Unmute and lower the hand"
                  >
                    Let speak
                  </button>
                )}
                <button
                  type="button"
                  className="chat-hand-lower"
                  onClick={() => send({ type: 'lower-hand', id: h.id })}
                  aria-label={`Lower ${h.displayName}'s hand`}
                  title="Lower hand"
                >
                  <Icon name="handDown" size={11} />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      <label className="chat-search">
        <Icon name="search" size={13} />
        <input
          type="search"
          className="chat-search-input"
          placeholder="Search students (name / SID) or messages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter with exactly one matching student: message them.
            const only = matched.length === 1 ? matched[0] : undefined;
            if (e.key === 'Enter' && searching && only) {
              e.preventDefault();
              replyTo(only.id);
            }
            if (e.key === 'Escape') setQuery('');
          }}
          aria-label="Search students or messages"
        />
        {searching && (
          <span className="chat-search-count" aria-live="polite">
            {matched.length} student{matched.length === 1 ? '' : 's'} · {shown.length} msg
          </span>
        )}
      </label>
      <div
        className="chat-log"
        ref={log}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {searching && shown.length === 0 && snap.messages.length > 0 && <p className="roster-none">No messages match “{query.trim()}”.</p>}
        {snap.messages.length === 0 && (
          <div className="empty-state">
            <p className="empty-title">No messages yet</p>
            <p className="hint">Broadcast to everyone or DM a student.</p>
          </div>
        )}
        {shown.map((m) => {
          const mine = !!snap.meId && m.senderParticipantId === snap.meId;
          const replyId = replyTargetFor(m, snap.meId);
          const canReply = !!replyId && ids.has(replyId);
          const replyName = replyId === m.senderParticipantId ? m.senderName : m.recipientName;
          const badge = scopeBadge(m.scope);
          return (
            <div key={m.id} className={'chat-msg' + (mine ? ' mine' : '') + (canReply && replyId === to ? ' to-this' : '')}>
              <div className="chat-msg-top">
                <Avatar name={m.senderName} small />
                <span className="chat-msg-name">{m.senderName}</span>
                <span className={'badge-scope ' + (badge.kind || 'all')}>{badge.text}</span>
                {m.scope === 'DIRECT' && m.recipientName && <span className="chat-msg-to">→ {m.recipientName}</span>}
                <span className="chat-msg-time">{formatTime(m.createdAt)}</span>
                {canReply && (
                  <button
                    type="button"
                    className="chat-reply-btn"
                    onClick={() => replyTo(replyId!)}
                    aria-label={`Reply to ${replyName || 'student'}`}
                    title={`Reply privately to ${replyName || 'this student'}`}
                  >
                    <Icon name="reply" size={12} />
                  </button>
                )}
              </div>
              <p className="chat-msg-body">{m.body}</p>
            </div>
          );
        })}
      </div>
      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          const body = text.trim();
          if (!body) return;
          send({ type: 'send-chat', text: body, to });
          setText('');
          stick.current = true;
          input.current?.focus();
        }}
      >
        <div className="chat-to-row">
          <label htmlFor="chat-to">To</label>
          {toName && (
            <button type="button" className="chat-back" onClick={() => pickTo('all')} title="Send the next message to everyone">
              Back to Everyone
            </button>
          )}
        </div>
        <select id="chat-to" className={toName ? 'dm' : ''} value={to} onChange={(e) => pickTo(e.target.value)} aria-label="Send to">
          <option value="all">Everyone</option>
          {toOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.sid ? `${s.displayName} · ${s.sid}` : s.displayName}
            </option>
          ))}
          {searching && toOptions.length === 0 && (
            <option value="" disabled>
              No student matches
            </option>
          )}
        </select>
        {toName && (
          <p className="chat-replying" role="status" aria-live="polite">
            Replying privately to <strong>{toName}</strong>
          </p>
        )}
        <div className="chat-send-row">
          <input
            ref={input}
            value={text}
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
            placeholder={toName ? `Private message to ${toName}…` : 'Write a message…'}
            aria-label="Chat message"
          />
          <button className="btn primary icon" type="submit" disabled={!text.trim()} aria-label="Send message" title="Send message">
            <Icon name="send" size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
