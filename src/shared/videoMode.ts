/**
 * Share Video mode (30 fps, motion). Manual only since 2026-10-10: the teacher
 * turns it on and off on the control panel; it starts OFF for every share.
 * (Auto-detect was removed: keep-alive frames, cursor moves and ink made it
 * flip unexpectedly.) Computer sound follows it unless overridden.
 */
export type VideoModeState = { on: boolean; auto: false };

export const VIDEO_MODE_OFF: VideoModeState = { on: false, auto: false };
