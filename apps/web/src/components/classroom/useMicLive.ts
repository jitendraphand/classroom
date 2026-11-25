'use client';

import { useEffect, useState } from 'react';
import { RoomEvent, Track, type Room } from 'livekit-client';

/** Identities whose microphone track is published and not muted (teacher roster, Nov 25). */
export function micLiveIdentities(room: Pick<Room, 'remoteParticipants'> | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!room) return out;
  for (const p of Array.from(room.remoteParticipants.values())) {
    const pub = p.getTrackPublication(Track.Source.Microphone);
    if (pub && !pub.isMuted) out.add(p.identity);
  }
  return out;
}

export function useMicLive(room: Room | null | undefined): ReadonlySet<string> {
  const [live, setLive] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!room) return;
    const update = () =>
      setLive((prev) => {
        const next = micLiveIdentities(room);
        if (next.size === prev.size && Array.from(next).every((id) => prev.has(id))) return prev;
        return next;
      });
    update();
    const evs = [
      RoomEvent.TrackPublished,
      RoomEvent.TrackUnpublished,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
      RoomEvent.TrackSubscribed,
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
    ] as const;
    evs.forEach((e) => room.on(e, update));
    return () => evs.forEach((e) => room.off(e, update));
  }, [room]);
  return live;
}
