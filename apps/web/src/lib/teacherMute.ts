/**
 * Mute / unmute one student on the teacher's behalf (DB flag, Redis muted set,
 * mic book, LiveKit permissions, the student's client). Shared by POST /mute
 * and the camera-off auto mute (POST /camera). Rules: lib/speakingRules.ts.
 */
import { prisma } from './db';
import { ensureRedis, keys } from './redis';
import { getSchoolSettings } from './schoolSettings';
import { updateMicBook } from './micBook';
import { teacherSetMic } from './micSlots';
import { setParticipantMicAllowed } from './livekit';
import { getVisibleSample, rotateVisibleSample } from './sample';
import { nudgeRoomState, pushMuteState } from './roomNudge';
import { isStudentCamOn, setStudentCam } from './studentCamera';
import { muteOnCameraOff } from './speakingRules';

export type MuteRoom = { id: string; code: string; sessionId: string };
export type MuteTarget = { id: string; livekitIdentity: string };

async function applyOne(room: MuteRoom, p: MuteTarget, muted: boolean, visible: string[]) {
  const redis = await ensureRedis();
  await prisma.participant.update({ where: { id: p.id }, data: { mutedByTeacher: muted } });
  if (muted) await redis.sadd(keys.muted(room.code), p.id);
  else await redis.srem(keys.muted(room.code), p.id);
  // Camera: in the sample, or unmuted (speaking students may publish camera so
  // the teacher's pop-up can show them; subscribers are unchanged).
  await setParticipantMicAllowed(room.code, p.livekitIdentity, !muted, !muted || visible.includes(p.livekitIdentity));
  pushMuteState(room.code, room.sessionId, [p.livekitIdentity], muted);
}

/**
 * Set one student's teacher mute. With a mic limit, an unmute may queue, and a
 * mute may promote the next teacher-approved waiter; a promoted student whose
 * camera is off is not unmuted (their slot is released again).
 */
export async function setStudentMuted(
  room: MuteRoom,
  participant: MuteTarget,
  wantMuted: boolean
): Promise<{ muted: boolean; waiting: boolean; touched: string[] }> {
  const { maxOpenStudentMics: micLimit } = await getSchoolSettings();
  const { visible } = await getVisibleSample(room.code);
  const touched = [participant.id];
  if (micLimit <= 0) {
    await applyOne(room, participant, wantMuted, visible);
    nudgeRoomState(room.code, { participantIds: touched });
    return { muted: wantMuted, waiting: false, touched };
  }
  const { next } = await updateMicBook(room.code, (book) => ({ next: teacherSetMic(book, participant.id, wantMuted, micLimit) }));
  const muted = wantMuted || !next.granted;
  await applyOne(room, participant, muted, visible);
  let promoted = 'promoted' in next ? (next as { promoted?: string | null }).promoted ?? null : null;
  for (let guard = 0; promoted && guard < 20; guard++) {
    const nextStudent = await prisma.participant.findFirst({
      where: { id: promoted, roomId: room.id, role: 'STUDENT' },
      select: { id: true, livekitIdentity: true },
    });
    if (!nextStudent) break;
    touched.push(nextStudent.id);
    if (await isStudentCamOn(room.code, nextStudent.livekitIdentity)) {
      await applyOne(room, nextStudent, false, visible);
      break;
    }
    // Camera off: give the slot up again (may promote the next waiter).
    const res = await updateMicBook(room.code, (book) => ({ next: teacherSetMic(book, nextStudent.id, true, micLimit) }));
    await applyOne(room, nextStudent, true, visible);
    promoted = 'promoted' in res.next ? (res.next as { promoted?: string | null }).promoted ?? null : null;
  }
  nudgeRoomState(room.code, { participantIds: touched });
  return { muted, waiting: next.waiting, touched };
}

/**
 * Record a student's camera report; mute them when it goes off while they are
 * unmuted. Used by POST /camera and the heartbeat (which repairs a lost report).
 */
export async function applyCameraReport(
  room: MuteRoom,
  me: { id: string; livekitIdentity: string; status: string },
  on: boolean
): Promise<{ autoMuted: boolean }> {
  const was = await setStudentCam(room.code, me.livekitIdentity, on);
  let autoMuted = false;
  // Only on an on→off change: a camera-off student cannot have been unmuted
  // (unmute needs the camera), so the heartbeat costs no DB read.
  if (me.status === 'ADMITTED' && was && !on) {
    const row = await prisma.participant.findUnique({ where: { id: me.id }, select: { mutedByTeacher: true, role: true } });
    if (row && muteOnCameraOff({ camOn: false, mutedByTeacher: row.mutedByTeacher, role: row.role })) {
      await setStudentMuted(room, { id: me.id, livekitIdentity: me.livekitIdentity }, true);
      autoMuted = true;
    }
  }
  if (was !== on && !autoMuted) nudgeRoomState(room.code, 'teacher');
  // Video pages list only camera-on students: refresh the current page.
  if (was !== on && me.status === 'ADMITTED') void schedulePageRefresh(room.code);
  return { autoMuted };
}

/** Coalesce window for page refreshes after camera changes (many students at once). */
export const PAGE_REFRESH_COALESCE_MS = 1500;

/**
 * One page recompute per room per window: the first camera change in the
 * window schedules it (on this worker), later ones in the window are covered
 * because the recompute reads every camera flag when it runs.
 */
async function schedulePageRefresh(code: string): Promise<void> {
  try {
    const r = await ensureRedis();
    const first = await r.set(keys.videoPageRefresh(code), '1', 'PX', PAGE_REFRESH_COALESCE_MS, 'NX');
    if (first !== 'OK') return;
    setTimeout(() => {
      void rotateVisibleSample(code).catch((e) => console.warn('video page refresh', code, e instanceof Error ? e.message : e));
    }, PAGE_REFRESH_COALESCE_MS - 250).unref?.();
  } catch {
    /* Redis down: the periodic refresh (ensureSampleFresh) catches up */
  }
}
