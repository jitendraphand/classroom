/**
 * Who may speak, and whose camera the teacher sees while they speak
 * (Nov 25 request). Pure, unit-tested; the routes and the classroom UI apply it.
 *
 * - The teacher unmutes students one by one, by hand. There is no "allow all
 *   to unmute"; several students may be unmuted at the same time.
 * - Only a student whose camera is on can be unmuted (button disabled with
 *   CAMERA_REQUIRED, and the server refuses with 409).
 * - A student who turns the camera off while unmuted is muted again by the
 *   server. The teacher unmutes them again once the camera is back.
 * - While unmuted, the student may publish camera video even outside the
 *   rotating sample, so the teacher's speaking pop-up can show them. Who can
 *   SUBSCRIBE is unchanged: classmates still never receive another student's
 *   camera (StudentMediaPrivacy), except the spotlighted student.
 */

export const CAMERA_REQUIRED = 'Camera must be on';

/** Error for POST /mute {all:true, muted:false}, which no longer exists. */
export const NO_UNMUTE_ALL = 'Unmute students one at a time.';

/** Why the teacher may not unmute this student now, or null when allowed. */
export function teacherUnmuteBlock(student: { camOn: boolean | null | undefined }): string | null {
  return student.camOn ? null : CAMERA_REQUIRED;
}

/** Camera publish permission for a student. */
export function studentCameraAllowed(opts: {
  inSample: boolean;
  spotlighted?: boolean;
  unmuted?: boolean;
  observerActive?: boolean;
}): boolean {
  return !!(opts.inSample || opts.spotlighted || opts.unmuted || opts.observerActive);
}

/** Should the server mute this student because their camera went off? */
export function muteOnCameraOff(opts: { camOn: boolean; mutedByTeacher: boolean; role: string }): boolean {
  return opts.role === 'STUDENT' && !opts.camOn && !opts.mutedByTeacher;
}

/** Redis hash value → camera flag (missing = unknown = off). */
export function parseCamFlag(raw: string | null | undefined): boolean {
  return raw === '1';
}

export type SpeakingCandidate = {
  id: string;
  role: string;
  livekitIdentity: string;
  displayName: string;
  mutedByTeacher: boolean;
};

/**
 * Students the teacher's speaking pop-up shows: unmuted students, in roster
 * order, minus those the roster has dropped (`hidden`). The pop-up closes when
 * the list is empty.
 */
export function speakingStudents<T extends SpeakingCandidate>(admitted: readonly T[], hidden: (identity: string) => boolean = () => false): T[] {
  return admitted.filter((p) => p.role === 'STUDENT' && !p.mutedByTeacher && !hidden(p.livekitIdentity));
}

/**
 * Speaking pop-up visibility (Nov 25): open while anyone is unmuted; a close
 * by the teacher holds until a student not in the closed set is unmuted.
 */
export function speakingFloatState(
  speakerIds: readonly string[],
  closedFor: readonly string[] | null
): { open: boolean; reopen: boolean } {
  if (speakerIds.length === 0) return { open: false, reopen: !!closedFor };
  if (!closedFor) return { open: true, reopen: false };
  const fresh = speakerIds.some((id) => !closedFor.includes(id));
  return { open: fresh, reopen: fresh };
}

/** Roster mic button, three states (Nov 25). */
export type RosterMicState = 'locked' | 'allowed' | 'live';

export type RosterMicView = {
  state: RosterMicState;
  /** Tooltip / aria-label. */
  label: string;
  /** What a click does: let the student unmute, or mute them again. */
  action: 'allow' | 'mute';
  /** Allow is blocked (camera off): greyed, tooltip says why. */
  disabled: boolean;
};

/**
 * - locked: muted by the teacher, not allowed to unmute. Click allows (camera must be on).
 * - allowed: teacher allowed the mic, the student's mic is still off. Click mutes (revokes).
 * - live: allowed and the student's mic track is on. Click mutes.
 * `micLive` is the LiveKit microphone publication (present and not muted);
 * `allowed` false (e.g. no speaking slot under the mic limit) also counts as locked.
 */
export function rosterMicState(p: {
  name: string;
  mutedByTeacher: boolean;
  micLive: boolean;
  camOn?: boolean | null;
  allowed?: boolean;
}): RosterMicView {
  const permitted = !p.mutedByTeacher && p.allowed !== false;
  if (!permitted) {
    const block = teacherUnmuteBlock({ camOn: p.camOn });
    return {
      state: 'locked',
      label: block ? `${p.name}: muted, not allowed to unmute. ${block}` : `${p.name}: muted, not allowed to unmute. Click to allow`,
      action: 'allow',
      disabled: !!block,
    };
  }
  if (!p.micLive) {
    return { state: 'allowed', label: `${p.name}: allowed to unmute (mic off). Click to mute`, action: 'mute', disabled: false };
  }
  return { state: 'live', label: `${p.name}: unmuted (mic on). Click to mute`, action: 'mute', disabled: false };
}
