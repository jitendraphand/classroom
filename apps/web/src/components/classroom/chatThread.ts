'use client';

/** Chat data (polling + LiveKit push), split from the chat UI so the UI can load lazily. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, DataPacket_Kind } from 'livekit-client';
import { replyTargetFor, resolveChatRecipient } from '@/lib/chatReply';
import { roomFetch } from '@/lib/classroomClient';
import { chatPollMs } from '@/lib/pollPolicy';
import { usePageHidden, usePushLive } from '@/hooks/usePollSignals';

export { replyTargetFor, resolveChatRecipient };

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

export type StudentOpt = { id: string; displayName: string; sid?: string | null };

export type ThreadProps = {
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
  }, [fetchMessages, stopped]);

  // Messages arrive as server data packets while connected; the poll repairs gaps.
  const hidden = usePageHidden();
  const pushLive = usePushLive(room);
  useEffect(() => {
    if (stopped) return;
    const t = setInterval(fetchMessages, chatPollMs({ hidden, pushLive }));
    return () => clearInterval(t);
  }, [fetchMessages, stopped, hidden, pushLive]);

  // Reconnected after a drop: packets sent meanwhile were missed, fetch now.
  const wasLive = useRef(pushLive);
  useEffect(() => {
    if (pushLive && !wasLive.current && !stopped) void fetchMessages();
    wasLive.current = pushLive;
  }, [pushLive, fetchMessages, stopped]);

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

