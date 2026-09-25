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

type Props = {
  code: string;
  isTeacher: boolean;
  myParticipantId: string | null;
  students: StudentOpt[];
  onUnreadChange?: (n: number) => void;
  active?: boolean;
  /** When true, stop polling (class ended) */
  stopped?: boolean;
};

const CHAT_TOPIC = 'chat';
const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
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

export function Chat({
  code,
  isTeacher,
  myParticipantId,
  students,
  onUnreadChange,
  active = true,
  stopped = false,
}: Props) {
  const room = useRoomContext();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [to, setTo] = useState<'all' | string>('all');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [ended, setEnded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const lastSeenId = useRef<string | null>(null);
  const baselineDone = useRef(false);
  const activeRef = useRef(active);
  const identityRef = useRef('anon');

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (room?.localParticipant?.identity) {
      identityRef.current = room.localParticipant.identity;
    }
  }, [room?.localParticipant?.identity]);

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
          return;
        }
        return;
      }
      if (data.ended) {
        setEnded(true);
        return;
      }
      if (Array.isArray(data.messages)) {
        mergeMessages(data.messages);
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

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Unread badge: baseline current history once, then count only new while Roster is active
  useEffect(() => {
    if (!onUnreadChange) return;
    if (active) {
      const last = messages[messages.length - 1];
      lastSeenId.current = last?.id ?? null;
      baselineDone.current = true;
      onUnreadChange(0);
      return;
    }
    if (!baselineDone.current) {
      lastSeenId.current = messages[messages.length - 1]?.id ?? null;
      baselineDone.current = true;
      onUnreadChange(0);
      return;
    }
    if (!lastSeenId.current) {
      onUnreadChange(messages.length);
      return;
    }
    const idx = messages.findIndex((m) => m.id === lastSeenId.current);
    const unread = idx < 0 ? messages.length : messages.length - idx - 1;
    onUnreadChange(Math.max(0, unread));
  }, [messages, active, onUnreadChange]);

  const publishChat = useCallback(
    async (message: ChatMessage) => {
      if (!room?.localParticipant || !encoder) return;
      try {
        const packet: ChatPacket = { v: 1, type: 'message', message };
        await room.localParticipant.publishData(encoder.encode(JSON.stringify(packet)), {
          reliable: true,
          topic: CHAT_TOPIC,
        });
      } catch (e) {
        console.warn('chat publish', e);
      }
    },
    [room]
  );

  useEffect(() => {
    if (!room) return;
    const onData = (
      payload: Uint8Array,
      _participant?: { identity?: string },
      _kind?: DataPacket_Kind,
      topic?: string
    ) => {
      if (topic && topic !== CHAT_TOPIC) return;
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

  const studentOptions = useMemo(
    () => students.filter((s) => s.id !== myParticipantId),
    [students, myParticipantId]
  );

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || sending || ended) return;
    setSending(true);
    setError('');
    try {
      const payload: { text: string; to?: string } = { text: trimmed };
      if (isTeacher) {
        payload.to = to === 'all' ? 'all' : to;
      } else {
        payload.to = 'teacher';
      }
      const res = await roomFetch(code, '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 410) {
          setEnded(true);
          setError('Class has ended');
          return;
        }
        setError(data.error || 'Send failed');
        return;
      }
      if (data.message) {
        mergeMessages([data.message]);
        void publishChat(data.message);
      }
      setText('');
    } catch {
      setError('Network error');
    } finally {
      setSending(false);
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

      <form onSubmit={send} className="mt-3 shrink-0 space-y-2 border-t border-white/5 pt-3">
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
