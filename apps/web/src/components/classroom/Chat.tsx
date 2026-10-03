'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, DataPacket_Kind } from 'livekit-client';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconChat, IconSend } from '@/components/ui/Icons';
import { Button } from '@/components/ui/Button';
import { roomFetch } from '@/lib/classroomClient';

export type ChatMessage = {
  id: string;
  roomId: string;
  senderParticipantId: string;
  senderName: string;
  senderRole: string;
  body: string;
  scope: 'TEACHER' | 'BROADCAST' | 'DIRECT' | string;
  recipientParticipantId: string | null;
  recipientName: string | null;
  createdAt: string;
};

type StudentOpt = { id: string; displayName: string };

type ThreadProps = {
  code: string;
  isTeacher: boolean;
  myParticipantId: string | null;
  onUnreadChange?: (n: number) => void;
  /** True while a chat surface (dock panel or share HUD) is open. */
  active?: boolean;
  /** When true, stop polling (class ended) */
  stopped?: boolean;
};

export type ChatThread = {
  messages: ChatMessage[];
  ended: boolean;
  sending: boolean;
  error: string;
  send: (text: string, destination: string) => Promise<boolean>;
};

const CHAT_TOPIC = 'chat';
const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

type ChatPacket = { v: 1; type: 'message'; message: ChatMessage };

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

/**
 * One chat subscription for the whole class. Call this from RoomInner so the
 * unread count keeps running after the floating panel unmounts its children.
 */
export function useChatThread({
  code,
  isTeacher,
  myParticipantId,
  onUnreadChange,
  active = true,
  stopped = false,
}: ThreadProps): ChatThread {
  const room = useRoomContext();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const lastSeenId = useRef<string | null>(null);
  const baselineDone = useRef(false);
  const sendingRef = useRef(false);
  /** Messages created before this client joined are history, not unread. */
  const joinedAt = useRef(Date.now());

  const mergeMessages = useCallback((incoming: ChatMessage[]) => {
    setMessages((prev) => {
      const map = new Map<string, ChatMessage>();
      for (const m of prev) map.set(m.id, m);
      for (const m of incoming) map.set(m.id, m);
      return Array.from(map.values()).sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    });
  }, []);

  const fetchMessages = useCallback(async () => {
    if (stopped || ended) return;
    try {
      const res = await roomFetch(code, '/messages');
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 410 || res.status === 401 || data.ended) {
          setEnded(true);
          setHydrated(true);
          return;
        }
        return;
      }
      if (data.ended) {
        setEnded(true);
        setHydrated(true);
        return;
      }
      if (Array.isArray(data.messages)) {
        mergeMessages(data.messages);
        setHydrated(true);
      }
    } catch {
      /* ignore poll errors */
    }
  }, [code, mergeMessages, stopped, ended]);

  useEffect(() => {
    if (stopped) {
      setEnded(true);
      return;
    }
    fetchMessages();
    const t = setInterval(fetchMessages, 2000);
    return () => clearInterval(t);
  }, [fetchMessages, stopped]);

  // Baseline only after the first fetch. History from before this client
  // joined stays read; anything newer counts while every chat surface is closed.
  useEffect(() => {
    if (!onUnreadChange) return;
    if (!hydrated) return;
    if (active) {
      lastSeenId.current = messages[messages.length - 1]?.id ?? null;
      baselineDone.current = true;
      onUnreadChange(0);
      return;
    }
    if (!baselineDone.current) {
      let lastPrior: string | null = null;
      for (const m of messages) {
        const t = new Date(m.createdAt).getTime();
        if (Number.isFinite(t) && t <= joinedAt.current) lastPrior = m.id;
      }
      lastSeenId.current = lastPrior;
      baselineDone.current = true;
    }
    if (!lastSeenId.current) {
      onUnreadChange(messages.length);
      return;
    }
    const idx = messages.findIndex((m) => m.id === lastSeenId.current);
    const unread = idx < 0 ? messages.length : messages.length - idx - 1;
    onUnreadChange(Math.max(0, unread));
  }, [messages, active, hydrated, onUnreadChange]);

  useEffect(() => {
    if (!room) return;
    const onData = (
      payload: Uint8Array,
      participant?: { identity?: string },
      _kind?: DataPacket_Kind,
      topic?: string
    ) => {
      if (topic !== CHAT_TOPIC) return;
      // Chat packets are only ever sent by the server (POST /messages →
      // RoomServiceClient.sendData, addressed to the allowed readers). A packet
      // that names a participant came from a browser and is forged.
      if (participant) return;
      if (!decoder) return;
      try {
        const msg = JSON.parse(decoder.decode(payload)) as ChatPacket;
        if (!msg || msg.v !== 1 || msg.type !== 'message' || !msg.message?.id) return;
        const m = msg.message;
        if (!isTeacher) {
          if (m.scope === 'BROADCAST') {
            /* ok */
          } else if (m.scope === 'TEACHER' && m.senderParticipantId === myParticipantId) {
            /* own */
          } else if (m.scope === 'DIRECT' && m.recipientParticipantId === myParticipantId) {
            /* DM to me */
          } else {
            return;
          }
        }
        mergeMessages([m]);
      } catch {
        /* ignore */
      }
    };
    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, isTeacher, myParticipantId, mergeMessages]);

  const send = useCallback(
    async (raw: string, destination: string) => {
      const trimmed = raw.trim();
      if (!trimmed || sendingRef.current || ended) return false;
      sendingRef.current = true;
      setSending(true);
      setError('');
      try {
        const res = await roomFetch(code, '/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: trimmed, to: destination }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 410) {
            setEnded(true);
            setError('Class has ended');
            return false;
          }
          setError(data.error || 'Send failed');
          return false;
        }
        // The server pushes the stored message to the other readers.
        if (data.message) mergeMessages([data.message]);
        return true;
      } catch {
        setError('Network error');
        return false;
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [code, ended, mergeMessages]
  );

  return { messages, ended, sending, error, send };
}

export function ChatView({
  thread,
  isTeacher,
  myParticipantId,
  students,
}: {
  thread: ChatThread;
  isTeacher: boolean;
  myParticipantId: string | null;
  students: StudentOpt[];
}) {
  const { messages, ended, sending, error, send } = thread;
  const [text, setText] = useState('');
  const [to, setTo] = useState<'all' | string>('all');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const studentOptions = useMemo(
    () => students.filter((s) => s.id !== myParticipantId),
    [students, myParticipantId]
  );

  async function onSubmit(e?: FormEvent) {
    e?.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || sending || ended) return;
    const destination = isTeacher ? (to === 'all' ? 'all' : to) : 'teacher';
    const ok = await send(trimmed, destination);
    if (ok) {
      setText('');
      // A private message is one-off: go back to Everyone so the next message
      // is not sent privately by accident.
      if (destination !== 'all' && destination !== 'teacher') setTo('all');
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={listRef} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1">
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
        {messages.map((m) => {
          const mine = m.senderParticipantId === myParticipantId;
          return (
            <div
              key={m.id}
              className={`rounded-xl px-3 py-2.5 text-sm ${
                mine
                  ? 'border border-brand-500/25 bg-brand-600/15'
                  : 'border border-white/[0.06] bg-black/25'
              }`}
            >
              <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-2xs text-slate-400">
                <Avatar name={m.senderName} size="sm" className="!h-5 !w-5 !text-[9px]" />
                <span className="font-medium text-slate-200">{m.senderName}</span>
                {scopeBadge(m.scope)}
                {m.scope === 'DIRECT' && m.recipientName && (
                  <span className="text-slate-500">→ {m.recipientName}</span>
                )}
                <span className="ml-auto tabular-nums text-slate-500">{formatTime(m.createdAt)}</span>
              </div>
              <p className="whitespace-pre-wrap break-words text-slate-100">{m.body}</p>
            </div>
          );
        })}
      </div>

      <form onSubmit={onSubmit} className="mt-3 shrink-0 space-y-2 border-t border-white/5 pt-3">
        {ended ? (
          <p className="text-2xs text-slate-400">Class ended — chat closed.</p>
        ) : isTeacher ? (
          <label className="block text-2xs font-medium text-slate-400">
            To
            <select
              className="input mt-1 py-1.5 text-sm"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            >
              <option value="all">Everyone</option>
              {studentOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.displayName}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-2xs text-slate-400">
            To <span className="font-medium text-slate-200">teacher</span>
          </p>
        )}
        {!ended && (
          <div className="flex gap-2">
            <input
              className="input flex-1 py-2"
              placeholder="Write a message…"
              value={text}
              maxLength={2000}
              onChange={(e) => setText(e.target.value)}
              disabled={sending}
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
