import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import type { PanelSnapshot, TeacherAction } from '../shared/actions';
import type { AdmittedPerson } from '../shared/apiModel';
import { replyTargetFor, resolveChatRecipient } from '../shared/chatReply';
import { sortRoster } from '../shared/classLogic';
import { focusLabel, isFocusAlert } from '../shared/session';
import { desktop } from './bridge';
import { avatarHue, initials, personChips, scopeBadge } from './people';

const kind = new URLSearchParams(location.search).get('kind') || 'chat';

function send(action: TeacherAction): void {
  desktop().sendAction(action);
}

function Avatar({ name, small }: { name: string; small?: boolean }) {
  const style = { '--hue': String(avatarHue(name)) } as CSSProperties;
  return (
    <span className={small ? 'avatar sm' : 'avatar'} style={style} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

function Person({ p }: { p: AdmittedPerson }) {
  const focus = focusLabel(p.focus);
  const meta = [p.rollNumber, p.gradeDivision].filter(Boolean).join(' · ');
  return (
    <div className="person">
      <Avatar name={p.displayName} />
      <div className="person-main">
        <strong>{p.displayName}</strong>
        {meta ? <div className="meta">{meta}</div> : null}
        <div className="chips">
          {personChips(p).map((chip) => (
            <span key={chip.text} className={chip.kind ? `chip ${chip.kind}` : 'chip'}>{chip.text}</span>
          ))}
        </div>
        {focus ? <div className={isFocusAlert(p.focus) ? 'focus' : 'meta'}>{focus}</div> : null}
        <div className="person-actions">
          <button className="btn" type="button" onClick={() => send({ type: 'mute-one', id: p.id, muted: !p.mutedByTeacher })}>
            {p.mutedByTeacher ? 'Allow unmute' : 'Mute'}
          </button>
          <button
            className="btn"
            type="button"
            aria-label={p.pinned ? `Unpin ${p.displayName}'s video` : `Pin ${p.displayName}'s video`}
            onClick={() => send({ type: 'pin', id: p.id, pinned: !p.pinned })}
          >
            {p.pinned ? 'Unpin' : 'Pin'}
          </button>
          {p.handRaised ? (
            <button className="btn" type="button" onClick={() => send({ type: 'lower-hand', id: p.id })}>
              Lower hand
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Roster({ snap }: { snap: PanelSnapshot }) {
  const students = sortRoster(snap.admitted.filter((p) => p.role === 'STUDENT'));
  const waitingOn = snap.hud.waitingRoomOn;
  return (
    <div className="panel-stack">
      <div className="pane-head">
        <div>
          <h2>{students.length ? `People · ${students.length}` : 'People'}</h2>
          <p className="hint">
            {waitingOn ? 'Lobby is at the top. Admitted students follow, raised hands first.' : 'Waiting room is off. New students enter muted.'}
          </p>
        </div>
        {snap.waiting.length ? (
          <button className="btn ok" type="button" onClick={() => send({ type: 'admit-all' })}>
            Admit all
          </button>
        ) : null}
      </div>
      <div className="row roster-tools">
        <button
          className={'btn' + (waitingOn ? ' on' : ' warn')}
          type="button"
          aria-pressed={waitingOn}
          aria-label={waitingOn ? 'Waiting room on. Turn off to let students in directly.' : 'Waiting room off. Turn on to hold new students.'}
          onClick={() => send({ type: 'waiting-room', on: !waitingOn })}
        >
          {waitingOn ? 'Waiting room on' : 'Waiting room off'}
        </button>
        <button className="btn" type="button" onClick={() => send({ type: 'mute-all', muted: true })}>Mute all</button>
        <button className="btn" type="button" onClick={() => send({ type: 'mute-all', muted: false })}>Allow unmute</button>
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
      </div>
      {snap.waiting.length ? <p className="lobby-label">Lobby · {snap.waiting.length}</p> : null}
      {snap.waiting.map((w) => (
        <div className="person wait" key={w.id}>
          <Avatar name={w.displayName} />
          <div className="person-main">
            <strong>{w.displayName}</strong>
            <div className="meta">Waiting to be admitted</div>
          </div>
          <button className="btn primary" type="button" aria-label={`Admit ${w.displayName}`} onClick={() => send({ type: 'admit', id: w.id })}>
            Admit
          </button>
        </div>
      ))}
      {students.length ? students.map((p) => <Person key={p.id} p={p} />) : (
        <div className="empty-state compact">
          <p className="empty-title">No students in class yet</p>
          <p className="hint">Admitted students appear under the lobby.</p>
        </div>
      )}
    </div>
  );
}

function Chat({ snap }: { snap: PanelSnapshot }) {
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const students = snap.admitted.filter((p) => p.role === 'STUDENT');
  const ids = new Set(students.map((p) => p.id));
  const to = resolveChatRecipient(snap.chatTo === 'all' ? 'all' : snap.chatTo, ids);
  const hands = sortRoster(students.filter((p) => p.handRaised));
  useEffect(() => {
    const el = log.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [snap.messages.length]);
  return (
    <div className="chat-wrap">
      {hands.length ? (
        <div className="hands" aria-label="Raised hands">
          {hands.map((p) => (
            <span className="hand-pair" key={p.id}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  send({ type: 'chat-to', to: p.id });
                  input.current?.focus();
                }}
              >
                ✋ {p.displayName}
              </button>
              <button type="button" className="btn" aria-label={`Lower ${p.displayName}'s hand`} onClick={() => send({ type: 'lower-hand', id: p.id })}>
                Lower
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="chat-top">
        <label className="hint" htmlFor="chat-to">To</label>
        <select
          id="chat-to"
          value={to}
          onChange={(e) => send({ type: 'chat-to', to: e.target.value })}
        >
          <option value="all">Everyone</option>
          {students.map((p) => (
            <option key={p.id} value={p.id}>{p.displayName}</option>
          ))}
        </select>
      </div>
      <div className="log" ref={log}>
        {snap.messages.length ? snap.messages.map((m) => {
          const replyTo = replyTargetFor(m, snap.meId);
          const mine = !!snap.meId && m.senderParticipantId === snap.meId;
          const badge = scopeBadge(m.scope);
          return (
            <div className={'msg' + (mine ? ' mine' : '') + (m.scope === 'DIRECT' ? ' direct' : '')} key={m.id}>
              <div className="msg-top">
                <Avatar name={m.senderName} small />
                <strong>{m.senderName}</strong>
                <span className={badge.kind ? `chip ${badge.kind}` : 'chip'}>{badge.text}</span>
              </div>
              {m.scope === 'DIRECT' && m.recipientName ? <div className="meta">to {m.recipientName}</div> : null}
              <p className="bubble">{m.body}</p>
              {replyTo ? (
                <button
                  type="button"
                  className="btn"
                  aria-label={`Reply to ${m.senderRole === 'STUDENT' ? m.senderName : m.recipientName || 'student'}`}
                  onClick={() => {
                    send({ type: 'chat-to', to: replyTo });
                    input.current?.focus();
                  }}
                >
                  Reply
                </button>
              ) : null}
            </div>
          );
        }) : (
          <div className="empty-state">
            <p className="empty-title">No messages yet</p>
            <p className="hint">Broadcast to everyone, or choose a student for a direct message.</p>
          </div>
        )}
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          const text = input.current?.value.trim() ?? '';
          if (!text) return;
          send({ type: 'send-chat', text, to });
          if (input.current) input.current.value = '';
        }}
      >
        <input ref={input} maxLength={2000} placeholder="Write a message…" aria-label="Message" />
        <button className="btn primary" type="submit" aria-label="Send message">Send</button>
      </form>
    </div>
  );
}

function Devices({ snap }: { snap: PanelSnapshot }) {
  const mics = snap.devices.filter((d) => d.kind === 'audioinput');
  const cams = snap.devices.filter((d) => d.kind === 'videoinput');
  return (
    <>
      <div className="pane-head">
        <div>
          <h2>This class</h2>
          <p className="hint">Pick the microphone and camera Classroom should use.</p>
        </div>
      </div>
      <label htmlFor="mic-dev">Microphone</label>
      <select id="mic-dev" value={mics.some((d) => d.id === snap.micId) ? snap.micId : ''} onChange={(e) => send({ type: 'set-mic', deviceId: e.target.value })}>
        <option value="">System default</option>
        {mics.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
      <label htmlFor="cam-dev">Camera</label>
      <select id="cam-dev" value={cams.some((d) => d.id === snap.camId) ? snap.camId : ''} onChange={(e) => send({ type: 'set-cam', deviceId: e.target.value })}>
        <option value="">System default</option>
        {cams.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
      </select>
      <p className="hint">Shortcuts use Electron accelerators, for example CommandOrControl+Shift+M.</p>
    </>
  );
}

function Panel() {
  const [snap, setSnap] = useState<PanelSnapshot | null>(null);
  useEffect(() => desktop().onHud((next) => {
    if (next?.hud) setSnap(next);
  }), []);
  if (!snap) return <p className="hint">Waiting for the class…</p>;
  if (kind === 'roster') return <Roster snap={snap} />;
  if (kind === 'devices') return <Devices snap={snap} />;
  return <Chat snap={snap} />;
}

const title = document.getElementById('title');
if (title) title.textContent = kind === 'roster' ? 'People' : kind === 'devices' ? 'Devices' : 'Messages';
document.getElementById('close')?.addEventListener('click', () => desktop().togglePanel(kind as 'chat' | 'roster' | 'devices'));

const body = document.getElementById('body');
if (body) createRoot(body).render(<Panel />);
