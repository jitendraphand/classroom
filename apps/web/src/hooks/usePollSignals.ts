'use client';

import { useEffect, useState } from 'react';
import { ConnectionState, RoomEvent, type Room } from 'livekit-client';

export { usePageHidden } from './usePageHidden';

/** True while the LiveKit connection is up, i.e. server pushes can arrive. */
export function usePushLive(room: Room | null | undefined): boolean {
  const [live, setLive] = useState(() => room?.state === ConnectionState.Connected);
  useEffect(() => {
    if (!room) {
      setLive(false);
      return;
    }
    const on = () => setLive(room.state === ConnectionState.Connected);
    on();
    room.on(RoomEvent.ConnectionStateChanged, on);
    return () => {
      room.off(RoomEvent.ConnectionStateChanged, on);
    };
  }, [room]);
  return live;
}
