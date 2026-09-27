'use client';

import dynamic from 'next/dynamic';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent, DataPacket_Kind } from 'livekit-client';
import { DefaultStylePanel, getSnapshot, loadSnapshot } from '@tldraw/tldraw';
import '@tldraw/tldraw/tldraw.css';
import { roomFetch } from '@/lib/classroomClient';
import { cn } from '@/lib/cn';

const Tldraw = dynamic(async () => (await import('@tldraw/tldraw')).Tldraw, {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center bg-[#f9fafb] text-slate-500">
      Loading whiteboard…
    </div>
  ),
});

type Props = {
  code: string;
  onEnded?: () => void;
  /** When false, board is view-only (hand tool + no local publish). */
  canWrite?: boolean;
  isTeacher?: boolean;
};

const WB_TOPIC = 'whiteboard';
const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

type WbMessage =
  | { v: 1; type: 'diff'; changes: unknown; from: string }
  | { v: 1; type: 'snapshot'; snapshot: unknown; from: string }
  | { v: 1; type: 'hello'; from: string };

type StylesCtxValue = { open: boolean };
const StylesCtx = createContext<StylesCtxValue>({ open: false });

/** tldraw StylePanel slot — renders nothing until Colors toggle opens it. */
function GatedStylePanel(props: ComponentProps<typeof DefaultStylePanel>) {
  const { open } = useContext(StylesCtx);
  if (!open) return null;
  return <DefaultStylePanel {...props} />;
}

/**
 * Shared whiteboard: LiveKit reliable data messages for near-realtime sync,
 * Redis snapshot for late joiners / refresh. No local-only persistenceKey.
 */
export function Whiteboard({ code, onEnded, canWrite = false, isTeacher }: Props) {
  const [ready, setReady] = useState(false);
  const [stylesOpen, setStylesOpen] = useState(false);
  const [initialSnapshot, setInitialSnapshot] = useState<unknown | null | undefined>(undefined);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<any>(null);
  const applyingRemote = useRef(false);
  const identityRef = useRef('anon');
  const lastPersistedHash = useRef('');
  const lastAppliedHash = useRef('');
  const canWriteRef = useRef(canWrite);
  const room = useRoomContext();
  const endedRef = useRef(false);
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);
  useEffect(() => {
    canWriteRef.current = canWrite;
  }, [canWrite]);

  const hashSnap = useCallback((snap: unknown) => {
    try {
      const s = JSON.stringify(snap);
      return `${s.length}:${s.slice(0, 160)}`;
    } catch {
      return '';
    }
  }, []);

  useEffect(() => {
    setReady(true);
  }, []);

  useEffect(() => {
    if (room?.localParticipant?.identity) {
      identityRef.current = room.localParticipant.identity;
    }
  }, [room?.localParticipant?.identity]);

  // Apply readonly when canWrite changes
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    try {
      editor.updateInstanceState({ isReadonly: !canWrite });
      if (!canWrite) {
        editor.setCurrentTool('hand');
      }
    } catch (e) {
      console.warn('wb readonly', e);
    }
  }, [canWrite]);

  // Load Redis snapshot once for late joiners
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await roomFetch(code, '/whiteboard');
        if (res.status === 410 || res.status === 401) {
          endedRef.current = true;
          onEndedRef.current?.();
          if (!cancelled) setInitialSnapshot(null);
          return;
        }
        const data = await res.json();
        if (data.ended) {
          endedRef.current = true;
          onEndedRef.current?.();
        }
        if (!cancelled) setInitialSnapshot(data.snapshot ?? null);
      } catch {
        if (!cancelled) setInitialSnapshot(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const persist = useCallback(
    async (snapshot: unknown) => {
      if (endedRef.current) return;
      if (!canWriteRef.current) return;
      try {
        lastPersistedHash.current = hashSnap(snapshot);
        const res = await roomFetch(code, '/whiteboard', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ snapshot }),
        });
        if (res.status === 410 || res.status === 401) {
          endedRef.current = true;
          onEndedRef.current?.();
        }
      } catch {
        /* ignore */
      }
    },
    [code, hashSnap]
  );

  const publishData = useCallback(
    async (msg: WbMessage) => {
      if (!room?.localParticipant || !encoder) return;
      if (!canWriteRef.current && msg.type === 'diff') return;
      if (!canWriteRef.current && msg.type === 'snapshot') return;
      try {
        const bytes = encoder.encode(JSON.stringify(msg));
        if (bytes.byteLength > 14_000) {
          if (msg.type === 'diff' && editorRef.current && canWriteRef.current) {
            const snap = getSnapshot(editorRef.current.store);
            await persist(snap);
            const small: WbMessage = {
              v: 1,
              type: 'hello',
              from: identityRef.current,
            };
            await room.localParticipant.publishData(encoder.encode(JSON.stringify(small)), {
              reliable: true,
              topic: WB_TOPIC,
            });
          }
          return;
        }
        await room.localParticipant.publishData(bytes, {
          reliable: true,
          topic: WB_TOPIC,
        });
      } catch (e) {
        console.warn('wb publish', e);
      }
    },
    [room, persist]
  );

  const applyDiff = useCallback((changes: any) => {
    const editor = editorRef.current;
    if (!editor || !changes) return;
    applyingRemote.current = true;
    try {
      editor.store.mergeRemoteChanges(() => {
        const added = changes.added ? Object.values(changes.added) : [];
        const updated = changes.updated ? Object.values(changes.updated) : [];
        const removed = changes.removed ? Object.values(changes.removed) : [];
        for (const record of added as any[]) {
          editor.store.put([record]);
        }
        for (const entry of updated as any[]) {
          const to = Array.isArray(entry) ? entry[1] : entry;
          if (to) editor.store.put([to]);
        }
        for (const record of removed as any[]) {
          if (record?.id) editor.store.remove([record.id]);
        }
      });
    } catch (e) {
      console.warn('wb apply diff', e);
    } finally {
      applyingRemote.current = false;
    }
  }, []);

  const applySnapshot = useCallback((snapshot: unknown) => {
    const editor = editorRef.current;
    if (!editor || !snapshot) return;
    applyingRemote.current = true;
    try {
      loadSnapshot(editor.store, snapshot as any);
    } catch (e) {
      console.warn('wb apply snapshot', e);
    } finally {
      applyingRemote.current = false;
    }
  }, []);

  useEffect(() => {
    if (!room) return;

    const onData = (
      payload: Uint8Array,
      participant?: { identity?: string },
      _kind?: DataPacket_Kind,
      topic?: string
    ) => {
      if (topic && topic !== WB_TOPIC) return;
      if (!decoder) return;
      try {
        const msg = JSON.parse(decoder.decode(payload)) as WbMessage;
        if (!msg || msg.v !== 1) return;
        if (msg.from && msg.from === identityRef.current) return;

        if (msg.type === 'diff') {
          applyDiff(msg.changes);
        } else if (msg.type === 'snapshot') {
          applySnapshot(msg.snapshot);
        } else if (msg.type === 'hello') {
          const editor = editorRef.current;
          if (editor && room.localParticipant && canWriteRef.current) {
            const snap = getSnapshot(editor.store);
            const reply: WbMessage = {
              v: 1,
              type: 'snapshot',
              snapshot: snap,
              from: identityRef.current,
            };
            void publishData(reply);
            void persist(snap);
          }
        }
      } catch {
        /* ignore malformed */
      }
    };

    room.on(RoomEvent.DataReceived, onData);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room, applyDiff, applySnapshot, publishData, persist]);

  useEffect(() => {
    const t = setInterval(async () => {
      if (endedRef.current) return;
      if (!editorRef.current || applyingRemote.current) return;
      try {
        const res = await roomFetch(code, '/whiteboard');
        if (res.status === 410 || res.status === 401) {
          endedRef.current = true;
          onEndedRef.current?.();
          return;
        }
        if (!res.ok) return;
        const data = await res.json();
        if (data.ended) {
          endedRef.current = true;
          onEndedRef.current?.();
          return;
        }
        if (!data.snapshot) return;
        const h = hashSnap(data.snapshot);
        if (!h || h === lastPersistedHash.current || h === lastAppliedHash.current) return;
        lastAppliedHash.current = h;
        applySnapshot(data.snapshot);
      } catch {
        /* ignore */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [code, applySnapshot, hashSnap]);

  const stylesCtx = useMemo(() => ({ open: stylesOpen }), [stylesOpen]);

  // Stable component slot — GatedStylePanel itself decides visibility via context
  const tldrawComponents = useMemo(
    () => ({
      StylePanel: GatedStylePanel,
    }),
    []
  );

  if (!ready || initialSnapshot === undefined) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#f9fafb] text-slate-500">
        Loading whiteboard…
      </div>
    );
  }

  return (
    <StylesCtx.Provider value={stylesCtx}>
      <div
        className={cn(
          'tldraw-wrap',
          !canWrite && 'tldraw-readonly',
          isTeacher && 'tldraw-teacher',
          stylesOpen && 'tldraw-styles-open'
        )}
        data-styles-open={stylesOpen ? '1' : '0'}
      >
        {canWrite && (
          <button
            type="button"
            className={cn('wb-styles-toggle', stylesOpen && 'wb-styles-toggle-active')}
            onClick={() => setStylesOpen((v) => !v)}
            aria-pressed={stylesOpen}
            title={stylesOpen ? 'Hide color & style panel' : 'Show color & style panel'}
          >
            Colors
          </button>
        )}
        <Tldraw
          // Intentionally NO persistenceKey — shared board must not use local IndexedDB alone
          className="tldraw-fill"
          components={tldrawComponents}
          onMount={(editor) => {
            editorRef.current = editor;

            try {
              editor.updateInstanceState({ isReadonly: !canWriteRef.current });
              if (!canWriteRef.current) {
                editor.setCurrentTool('hand');
              }
            } catch {
              /* ignore */
            }

            if (initialSnapshot) {
              try {
                loadSnapshot(editor.store, initialSnapshot as any);
              } catch (e) {
                console.warn('wb initial load', e);
              }
            }

            void publishData({ v: 1, type: 'hello', from: identityRef.current });

            const unsub = editor.store.listen(
              (entry) => {
                if (applyingRemote.current) return;
                if (entry.source !== 'user') return;
                if (!canWriteRef.current) return;

                void publishData({
                  v: 1,
                  type: 'diff',
                  changes: entry.changes,
                  from: identityRef.current,
                });

                if (saveTimer.current) clearTimeout(saveTimer.current);
                saveTimer.current = setTimeout(() => {
                  try {
                    const snap = getSnapshot(editor.store);
                    void persist(snap);
                  } catch {
                    /* ignore */
                  }
                }, 400);
              },
              { source: 'user', scope: 'document' }
            );

            return () => {
              unsub();
              if (saveTimer.current) clearTimeout(saveTimer.current);
            };
          }}
        />
      </div>
    </StylesCtx.Provider>
  );
}
