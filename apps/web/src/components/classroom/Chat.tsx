'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChat, IconHand, IconHandDown, IconReply, IconSearch, IconSend } from '@/components/ui/Icons';
import { filterMessages, filterPeople, normalizeQuery } from '@/lib/peopleSearch';
import { cn } from '@/lib/cn';
import { replyTargetFor, resolveChatRecipient } from '@/lib/chatReply';
import { Button } from '@/components/ui/Button';
import { useChatThread, type ChatMessage, type ChatThread, type StudentOpt, type ThreadProps } from './chatThread';

export { replyTargetFor, resolveChatRecipient, useChatThread };
export type { ChatMessage, ChatThread };

function formatTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function scopeBadge(scope: string) {
  if (scope === 'BROADCAST') {
    return (
      <Badge tone="violet" className="!py-0.5">
        Everyone
      </Badge>
    );
  }
  if (scope === 'DIRECT') {
    return (
      <Badge tone="sky" className="!py-0.5">
        DM
      </Badge>
    );
  }
  return (
    <Badge tone="warning" className="!py-0.5">
      To teacher
    </Badge>
  );
}

export type RaisedHand = { id: string; displayName: string };

export function ChatView({
  thread,
  isTeacher,
  myParticipantId,
  students,
  to: toProp,
  onToChange,
  raisedHands,
  onLowerHand,
  compact = false,
}: {
  thread: ChatThread;
  isTeacher: boolean;
  myParticipantId: string | null;
  students: StudentOpt[];
  /**
   * Teacher recipient ('all' or a participant id). Pass with onToChange to
   * share one choice between chat surfaces (dock panel and share HUD), so it
   * survives the panel closing and a share starting.
   */
  to?: 'all' | string;
  onToChange?: (to: 'all' | string) => void;
  /** Teacher: students with a hand up, earliest first (shown above the thread). */
  raisedHands?: RaisedHand[];
  onLowerHand?: (participantId: string) => void;
  /** Phone sheet: tighter rows so more of the stage stays visible. */
  compact?: boolean;
}) {
  const { messages, ended, sending, error, send } = thread;
  const [text, setText] = useState('');
  const [toLocal, setToLocal] = useState<'all' | string>('all');
  const toRaw = toProp ?? toLocal;
  const setTo = useCallback(
    (next: 'all' | string) => {
      if (onToChange) onToChange(next);
      else setToLocal(next);
    },
    [onToChange]
  );
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const studentOptions = useMemo(
    () => students.filter((s) => s.id !== myParticipantId),
    [students, myParticipantId]
  );
  const studentIds = useMemo(() => new Set(studentOptions.map((s) => s.id)), [studentOptions]);
  // A recipient who left the class falls back to Everyone (never DM a ghost).
  const to = resolveChatRecipient(toRaw, studentIds);
  useEffect(() => {
    if (to !== toRaw && studentOptions.length > 0) setTo('all');
  }, [to, toRaw, studentOptions.length, setTo]);

  const replyTo = useCallback(
    (participantId: string) => {
      if (!isTeacher || !studentIds.has(participantId)) return;
      setTo(participantId);
      // After the render that shows the new recipient.
      window.setTimeout(() => inputRef.current?.focus(), 0);
    },
    [isTeacher, studentIds, setTo]
  );

  async function onSubmit(e?: FormEvent) {
    e?.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || sending || ended) return;
    const destination = isTeacher ? (to === 'all' ? 'all' : to) : 'teacher';
    const ok = await send(trimmed, destination);
    if (ok) {
      // The recipient stays selected: a conversation with one student is
      // usually several lines. The composer label always names who gets it.
      setText('');
      inputRef.current?.focus();
    }
  }

  const toName = to === 'all' ? null : studentOptions.find((s) => s.id === to)?.displayName ?? null;
  const hands = isTeacher ? raisedHands ?? [] : [];

  // Teacher search: narrows the "To" list (name / SID) and the messages.
  const [query, setQuery] = useState('');
  const searching = isTeacher && !!normalizeQuery(query);
  const matchedStudents = useMemo(() => filterPeople(studentOptions, query), [studentOptions, query]);
  // The current recipient always stays in the list so the select never lies.
  const toOptions = useMemo(() => {
    if (!searching || to === 'all' || matchedStudents.some((s) => s.id === to)) return matchedStudents;
    const cur = studentOptions.find((s) => s.id === to);
    return cur ? [cur, ...matchedStudents] : matchedStudents;
  }, [searching, to, matchedStudents, studentOptions]);
  const sidById = useMemo(() => new Map(studentOptions.map((s) => [s.id, s.sid])), [studentOptions]);
  const shownMessages = useMemo(
    () => (searching ? filterMessages(messages, query, sidById) : messages),
    [searching, messages, query, sidById]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {hands.length > 0 && (
        <div
          className="chat-hands mb-2 shrink-0"
          role="status"
          aria-label={`${hands.length} raised ${hands.length === 1 ? 'hand' : 'hands'}`}
          data-no-drag
        >
          <span className="chat-hands-label" title="Raised hands, earliest first">
            <IconHand size={12} />
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
                {onLowerHand && (
                  <button
                    type="button"
                    className="chat-hand-lower"
                    onClick={() => onLowerHand(h.id)}
                    aria-label={`Lower ${h.displayName}'s hand`}
                    title="Lower hand"
                  >
                    <IconHandDown size={11} />
                  </button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
      {isTeacher && (
        <div className="chat-search mb-2 shrink-0" data-no-drag>
          <IconSearch size={13} aria-hidden />
          <input
            type="search"
            className="chat-search-input"
            placeholder="Search students (name / SID) or messages…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Enter with exactly one matching student: message them.
              if (e.key === 'Enter' && matchedStudents.length === 1) {
                e.preventDefault();
                replyTo(matchedStudents[0].id);
              }
              if (e.key === 'Escape') setQuery('');
            }}
            aria-label="Search students or messages"
          />
          {searching && (
            <span className="chat-search-count" aria-live="polite">
              {matchedStudents.length} student{matchedStudents.length === 1 ? '' : 's'} · {shownMessages.length} msg
            </span>
          )}
        </div>
      )}
      <div
        ref={listRef}
        className={cn('min-h-0 flex-1 overflow-y-auto pr-1', compact ? 'space-y-1.5' : 'space-y-2.5')}
      >
        {searching && shownMessages.length === 0 && messages.length > 0 && (
          <p className="py-4 text-center text-2xs text-slate-400">No messages match “{query.trim()}”.</p>
        )}
        {messages.length === 0 && (
          <EmptyState
            icon={<IconChat size={24} />}
            title={ended ? 'Class ended' : 'No messages yet'}
            description={
              ended
                ? 'Chat is closed for this class.'
                : isTeacher
                  ? 'Broadcast to everyone or DM a student.'
                  : 'Say hello to your teacher.'
            }
            className="py-8"
          />
        )}
        {shownMessages.map((m) => {
          const mine = m.senderParticipantId === myParticipantId;
          const replyId = isTeacher ? replyTargetFor(m, myParticipantId) : null;
          const canReply = !!replyId && studentIds.has(replyId) && !ended;
          const replyName = replyId === m.senderParticipantId ? m.senderName : m.recipientName;
          return (
            <div
              key={m.id}
              className={cn(
                'rounded-xl',
                compact ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2.5 text-sm',
                mine
                  ? 'border border-brand-500/25 bg-brand-600/15'
                  : 'border border-white/[0.06] bg-black/25',
                canReply && replyId === to && 'ring-1 ring-sky-400/40'
              )}
            >
              <div
                className={cn(
                  'flex flex-wrap items-center gap-1.5 text-2xs text-slate-400',
                  compact ? 'mb-0.5' : 'mb-1.5'
                )}
              >
                {!compact && <Avatar name={m.senderName} size="sm" className="!h-5 !w-5 !text-[9px]" />}
                <span className="font-medium text-slate-200">{m.senderName}</span>
                {scopeBadge(m.scope)}
                {m.scope === 'DIRECT' && m.recipientName && (
                  <span className="text-slate-500">→ {m.recipientName}</span>
                )}
                <span className="ml-auto tabular-nums text-slate-500">{formatTime(m.createdAt)}</span>
                {canReply && (
                  <button
                    type="button"
                    className="chat-reply-btn"
                    onClick={() => replyTo(replyId!)}
                    aria-label={`Reply to ${replyName || 'student'}`}
                    title={`Reply privately to ${replyName || 'this student'}`}
                    data-no-drag
                  >
                    <IconReply size={12} />
                                      </button>
                )}
              </div>
              <p className="whitespace-pre-wrap break-words text-slate-100">{m.body}</p>
            </div>
          );
        })}
      </div>

      <form
        onSubmit={onSubmit}
        className={cn('shrink-0 border-t border-white/5', compact ? 'mt-1.5 space-y-1.5 pt-1.5' : 'mt-3 space-y-2 pt-3')}
      >
        {ended ? (
          <p className="text-2xs text-slate-400">Class ended — chat closed.</p>
        ) : isTeacher ? (
          <label className="block text-2xs font-medium text-slate-400">
            <span className="flex items-center gap-2">
              To
              {toName && (
                <button
                  type="button"
                  className="ml-auto text-2xs font-semibold text-sky-300 hover:underline"
                  onClick={() => setTo('all')}
                  title="Send the next message to everyone"
                >
                  Back to Everyone
                </button>
              )}
            </span>
            <select
              className={cn('input mt-1 py-1.5 text-sm', toName && 'border-sky-400/50')}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-label="Send to"
            >
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
          </label>
        ) : compact ? null : (
          <p className="text-2xs text-slate-400">
            To <span className="font-medium text-slate-200">teacher</span>
          </p>
        )}
        {!ended && (
          <div className="flex gap-2">
            <input
              ref={inputRef}
              className={cn('input flex-1', compact ? 'py-1.5 text-sm' : 'py-2')}
              placeholder={
                isTeacher
                  ? toName
                    ? `Private message to ${toName}…`
                    : 'Write a message…'
                  : compact
                    ? 'Message your teacher…'
                    : 'Write a message…'
              }
              value={text}
              maxLength={2000}
              onChange={(e) => setText(e.target.value)}
              // readOnly (not disabled) while sending keeps the focus, so the
              // next line can be typed straight after Enter.
              readOnly={sending}
              aria-busy={sending}
              aria-label="Chat message"
            />
            <Button
              type="submit"
              size="sm"
              className="!px-3 !py-2"
              disabled={sending || !text.trim()}
              aria-label="Send message"
            >
              <IconSend size={16} />
            </Button>
          </div>
        )}
        {error && (
          <p className="text-xs text-danger-fg" role="alert">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

type Props = ThreadProps & { students: StudentOpt[] };

/** Standalone chat. Prefer useChatThread + ChatView when the panel can unmount. */
export function Chat({ students, ...threadProps }: Props) {
  const thread = useChatThread(threadProps);
  return (
    <ChatView
      thread={thread}
      isTeacher={threadProps.isTeacher}
      myParticipantId={threadProps.myParticipantId}
      students={students}
    />
  );
}
