/**
 * Which student videos the teacher still shows.
 *
 * The roster drops a crashed student (no leave) once the heartbeat is stale
 * or the teacher's ConnectionQuality.Lost grace has elapsed. LiveKit itself
 * keeps the participant for ~20s, so every teacher video surface must use
 * this same set or the tile lingers after the name is gone.
 *
 * `dropped` is either the teacher's map of identity → moment the grace
 * already elapsed (hide when `now >= since`; a future since is still in
 * grace) or the server's set of identities whose heartbeat/leave is already
 * gone. `liveRoster`, when provided, is who the server still lists as
 * admitted: a `student_` identity missing from it was removed by the
 * heartbeat path. Null means the roster has not loaded yet — do not hide
 * anyone for that reason. Reconnect clears the entry; the same identity
 * comes back once, never as a second tile.
 */

export type DroppedMarks = ReadonlyMap<string, number> | ReadonlySet<string> | null | undefined;

export function isRosterDropped(identity: string, dropped: DroppedMarks, now: number): boolean {
  if (!identity || !dropped) return false;
  const asMap = dropped as { get?: (id: string) => number | undefined };
  if (typeof asMap.get === 'function') {
    const since = asMap.get(identity);
    return typeof since === 'number' && Number.isFinite(since) && now >= since;
  }
  return (dropped as ReadonlySet<string>).has(identity);
}

/**
 * True when this identity must not have a tile (and its tracks must not
 * stay subscribed). Teachers are never hidden just because they are absent
 * from the student roster.
 */
export function videoHidden(
  identity: string,
  opts: { dropped?: DroppedMarks; now: number; liveRoster?: ReadonlySet<string> | null }
): boolean {
  if (!identity) return false;
  if (isRosterDropped(identity, opts.dropped, opts.now)) return true;
  if (opts.liveRoster && identity.startsWith('student_') && !opts.liveRoster.has(identity)) return true;
  return false;
}

/**
 * Visible-video / sample selection. Order is kept. Dropped identities are
 * removed. Duplicates collapse to the first remaining entry so a reconnect
 * cannot paint two tiles for one student.
 */
export function selectTeacherVideos(
  candidates: readonly string[],
  opts: { dropped?: DroppedMarks; now: number; liveRoster?: ReadonlySet<string> | null }
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of candidates) {
    if (!id || seen.has(id) || videoHidden(id, opts)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
