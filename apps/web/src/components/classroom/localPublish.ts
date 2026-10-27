/**
 * Local track publish helpers: one publish/unpublish at a time per page, and
 * safe stop of captured tracks. (Split out of ClassroomRoom.tsx.)
 */
import { LocalVideoTrack, LocalAudioTrack } from 'livekit-client';

/** Release a local track. LocalVideoTrack.stop throws if a simulcast MediaStreamTrack is null. */
export function safeStop(track: LocalVideoTrack | LocalAudioTrack | null | undefined) {
  if (!track) return;
  if (track instanceof LocalVideoTrack) {
    track.simulcastCodecs.forEach((info) => {
      try {
        const raw = info?.mediaStreamTrack;
        if (raw && raw.readyState !== 'ended') raw.stop();
      } catch {
        /* already stopped */
      }
    });
  }
  try {
    const raw = track.mediaStreamTrack;
    if (raw && raw.readyState !== 'ended') raw.stop();
  } catch {
    /* media track already released */
  }
  try {
    track.stop();
  } catch {
    /* simulcast mediaStreamTrack already null */
  }
}

export function simulcastMediaTracks(track: LocalVideoTrack | LocalAudioTrack): MediaStreamTrack[] {
  if (!(track instanceof LocalVideoTrack)) return [];
  const tracks: MediaStreamTrack[] = [];
  track.simulcastCodecs.forEach((info) => {
    if (info?.mediaStreamTrack) tracks.push(info.mediaStreamTrack);
  });
  return tracks;
}

/**
 * Negotiate the unpublish before the media track ends. The default path stops
 * the track first, which throws once a simulcast MediaStreamTrack is null and
 * ends the remote subscription before publication metadata arrives.
 */
export async function unpublishThenStop(
  localParticipant: {
    unpublishTrack: (
      track: LocalVideoTrack | LocalAudioTrack,
      stopOnUnpublish?: boolean
    ) => Promise<unknown>;
  },
  track: LocalVideoTrack | LocalAudioTrack
) {
  const simulcast = simulcastMediaTracks(track);
  try {
    await localParticipant.unpublishTrack(track, false);
  } catch {
    /* already unpublished */
  }
  for (const raw of simulcast) {
    try {
      if (raw.readyState !== 'ended') raw.stop();
    } catch {
      /* already stopped */
    }
  }
  safeStop(track);
}

/**
 * One local publish or unpublish at a time. A second offer that starts before
 * the first answer arrives times out; LiveKit then reconnects and unpublishes
 * the screen share, which used to close the teacher's controls.
 */
export let localPublishChain: Promise<void> = Promise.resolve();

export function enqueueLocalPublish(task: () => Promise<void>): Promise<void> {
  const run = localPublishChain.catch(() => undefined).then(task);
  localPublishChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
