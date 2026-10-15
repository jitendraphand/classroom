/**
 * Waiting-room (lobby) rules for the join page. A student waiting when the
 * class ends must see "Class ended", not an endless lobby: the room answer
 * says ENDED (or, when the permanent room already restarted, that this seat
 * was closed: meLeft).
 */
export function lobbyEndedFor(data: { status?: string; ended?: boolean; meLeft?: boolean } | null | undefined): boolean {
  return !!data && (data.status === 'ENDED' || !!data.ended || !!data.meLeft);
}
