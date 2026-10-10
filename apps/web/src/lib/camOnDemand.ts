/**
 * Student cameras on demand. A student's camera video leaves the device only
 * while (a) they are in the teacher's visible tile set (the sample; the SFU
 * permission also follows it) AND (b) the teacher's student-video panel is
 * shown (not minimized / closed). Otherwise the published track is paused
 * upstream (RTCRtpSender.replaceTrack(null): zero video bytes), and resumed
 * in one replaceTrack when shown again (no renegotiation, ~100 ms).
 */

/** Panel-hidden flag lifetime: a teacher who vanishes cannot freeze cameras off forever. */
export const VIDEO_PANEL_TTL_S = 60 * 60 * 6;

/** Server: should this student publish camera video now? Teachers always may. */
export function camWanted(opts: { isTeacher: boolean; inSample: boolean; panelRaw: string | null }): boolean {
  if (opts.isTeacher) return true;
  return opts.inSample && opts.panelRaw !== '0';
}

/** Client: older servers omit camWanted → follow canPublishVideo as before. */
export function effectiveCamWanted(me: { canPublishVideo?: boolean; camWanted?: boolean } | null | undefined): boolean {
  if (!me) return false;
  return typeof me.camWanted === 'boolean' ? me.camWanted && !!me.canPublishVideo : !!me.canPublishVideo;
}

/** Teacher panel visibility as reported to the server. */
export function panelShown(opts: { minimized: boolean; portalHidden: boolean }): boolean {
  return !opts.minimized && !opts.portalHidden;
}
