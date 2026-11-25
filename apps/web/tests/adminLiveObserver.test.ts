import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminApiDenied } from '../src/lib/adminGuard';
import { pageAccess, sectionForPath } from '../src/lib/adminSections';
import { isObserverIdentityForAdmin, partitionObserverLeases } from '../src/lib/adminObservers';
import { handleAdminEndClass, handleObserverHeartbeat } from '../src/lib/adminLiveApi';
import { endedByFromPacket, isClassEndedPacket } from '../src/lib/classEnded';
import { classEndedCopy } from '../src/lib/classFinish';
import { formatAuditLine } from '../src/lib/auditLog';
import { studentCameraAllowed } from '../src/lib/speakingRules';
import { camWanted } from '../src/lib/camOnDemand';
import { buildStudentTrackPermissions } from '../src/components/classroom/StudentMediaPrivacy';

const emptyPrivs = {
  monitorLive: false,
  schedule: false,
  manageTeachers: false,
  manageSchool: false,
  viewReports: false,
};

test('privilege enforcement: monitorLive or SYSTEM required for live tab, observer page, and all live APIs', () => {
  // Page access
  assert.equal(sectionForPath('/admin/live').id, 'live');
  assert.equal(sectionForPath('/admin/live/CLS-1').id, 'live');
  assert.equal(pageAccess('/admin/live', emptyPrivs, 'SUB').ok, false);
  assert.equal(pageAccess('/admin/live/CLS-1', emptyPrivs, 'SUB').ok, false);
  assert.equal(pageAccess('/admin/live/CLS-1', { ...emptyPrivs, schedule: true, viewReports: true }, 'SUB').ok, false);
  assert.equal(pageAccess('/admin/live/CLS-1', { ...emptyPrivs, monitorLive: true }, 'SUB').ok, true);
  assert.equal(pageAccess('/admin/live/CLS-1', emptyPrivs, 'SYSTEM').ok, true);

  // API guard
  assert.equal(adminApiDenied(null, 'monitorLive')?.status, 401);
  assert.equal(adminApiDenied({ kind: 'SUB', privileges: emptyPrivs }, 'monitorLive')?.status, 403);
  assert.equal(adminApiDenied({ kind: 'SUB', privileges: { ...emptyPrivs, manageSchool: true } }, 'monitorLive')?.status, 403);
  assert.equal(adminApiDenied({ kind: 'SUB', privileges: { ...emptyPrivs, monitorLive: true } }, 'monitorLive'), null);
  assert.equal(adminApiDenied({ kind: 'SYSTEM', privileges: emptyPrivs }, 'monitorLive'), null);

  // Every live API route invokes requireAdminApi('monitorLive')
  for (const route of [
    'src/app/api/admin/live/route.ts',
    'src/app/api/admin/live/[code]/route.ts',
    'src/app/api/admin/live/[code]/token/route.ts',
    'src/app/api/admin/live/[code]/whiteboard/route.ts',
    'src/app/api/admin/live/[code]/observer/route.ts',
    'src/app/api/admin/live/[code]/end/route.ts',
  ]) {
    const src = readFileSync(route, 'utf8');
    assert.match(src, /requireAdminApi\(\s*'monitorLive'\s*\)/, `${route} must require monitorLive`);
  }
});

test('observer leases: active vs expired partitioning and identity ownership check', () => {
  const now = 1_700_000_000_000;
  const part = partitionObserverLeases(
    {
      adminobserver_a1_111: String(now + 10_000),
      adminobserver_a2_222: String(now - 1),
      adminobserver_a3_333: 'not-a-number',
      student_s1: String(now + 30_000),
    },
    now
  );
  assert.deepEqual(part.active, ['adminobserver_a1_111']);
  assert.deepEqual(part.expired.sort(), ['adminobserver_a2_222', 'adminobserver_a3_333', 'student_s1'].sort());

  assert.equal(isObserverIdentityForAdmin('adminobserver_adm1_abc', 'adm1'), true);
  assert.equal(isObserverIdentityForAdmin('adminobserver_adm2_abc', 'adm1'), false);
  assert.equal(isObserverIdentityForAdmin('adminpreview_adm1_abc', 'adm1'), false);
  assert.equal(isObserverIdentityForAdmin('student_adm1', 'adm1'), false);
  assert.equal(isObserverIdentityForAdmin('teacher_adm1', 'adm1'), false);
});

test('observer heartbeat handler enforces admin ownership, active flag, and room existence', async () => {
  const adminGuardOk = async () => ({
    admin: { id: 'adm1', kind: 'SUB', email: 'a@b.c', name: 'Admin', privileges: { ...emptyPrivs, monitorLive: true } },
  });
  const baseDeps = {
    guard: adminGuardOk,
    exists: async () => true,
    refresh: async () => ({ activeCount: 1 }),
    unregister: async () => ({ activeCount: 0 }),
  };

  // Unauthorized
  const r403Other = await handleObserverHeartbeat('cls1', { identity: 'adminobserver_adm2_xyz', active: true }, baseDeps);
  assert.equal(r403Other.status, 403);

  // Bad active type
  const r400 = await handleObserverHeartbeat('cls1', { identity: 'adminobserver_adm1_xyz', active: 'yes' }, baseDeps);
  assert.equal(r400.status, 400);

  // Class ended on active:true -> 404
  const r404 = await handleObserverHeartbeat(
    'cls1',
    { identity: 'adminobserver_adm1_xyz', active: true },
    { ...baseDeps, exists: async () => false }
  );
  assert.equal(r404.status, 404);

  // Heartbeat success
  const rOk = await handleObserverHeartbeat('cls1', { identity: 'adminobserver_adm1_xyz', active: true }, baseDeps);
  assert.equal(rOk.status, 200);
  assert.deepEqual(await rOk.json(), { ok: true, active: true, activeCount: 1 });

  // Unregister succeeds even if class ended
  let unregistered = '';
  const rOff = await handleObserverHeartbeat(
    'cls1',
    { identity: 'adminobserver_adm1_xyz', active: false },
    {
      ...baseDeps,
      exists: async () => false,
      unregister: async (_code, id) => {
        unregistered = id;
        return { activeCount: 0 };
      },
    }
  );
  assert.equal(rOff.status, 200);
  assert.equal(unregistered, 'adminobserver_adm1_xyz');
});

test('camera gating and SFU track permissions: observer sees all cam-on students without exposing them to classmates or flooding teacher', () => {
  // Outside teacher sample: normally off, enabled when observerActive is true
  assert.equal(studentCameraAllowed({ inSample: false, spotlighted: false, unmuted: false, observerActive: false }), false);
  assert.equal(studentCameraAllowed({ inSample: false, spotlighted: false, unmuted: false, observerActive: true }), true);

  assert.equal(camWanted({ isTeacher: false, inSample: false, panelRaw: '0', spotlighted: false, observerActive: false }), false);
  assert.equal(camWanted({ isTeacher: false, inSample: false, panelRaw: '0', spotlighted: false, observerActive: true }), true);

  const nonSpotlightPerms = buildStudentTrackPermissions({
    teachers: ['teacher_1'],
    observers: ['adminobserver_adm1_99'],
    classmates: ['student_2'],
    spotlighted: false,
    micSid: 'TR_mic',
    camSid: 'TR_cam',
    allowTeacherCam: false,
  });

  // Hidden observer gets allowAll (camera + mic when observer enables audio)
  assert.deepEqual(nonSpotlightPerms.find((p) => p.participantIdentity === 'adminobserver_adm1_99'), {
    participantIdentity: 'adminobserver_adm1_99',
    allowAll: true,
  });

  // Teacher gets mic-only when student is outside teacher's sample (no 200-camera auto-subscribe flood)
  assert.deepEqual(nonSpotlightPerms.find((p) => p.participantIdentity === 'teacher_1'), {
    participantIdentity: 'teacher_1',
    allowAll: false,
    allowedTrackSids: ['TR_mic'],
  });

  // Non-spotlighted classmate never gets student camera
  assert.deepEqual(nonSpotlightPerms.find((p) => p.participantIdentity === 'student_2'), {
    participantIdentity: 'student_2',
    allowAll: false,
    allowedTrackSids: ['TR_mic'],
  });

  // Spotlighted student exposes camera to classmates as well
  const spotlightPerms = buildStudentTrackPermissions({
    teachers: ['teacher_1'],
    observers: ['adminobserver_adm1_99'],
    classmates: ['student_2'],
    spotlighted: true,
    micSid: 'TR_mic',
    camSid: 'TR_cam',
    allowTeacherCam: true,
  });
  assert.deepEqual(spotlightPerms.find((p) => p.participantIdentity === 'student_2'), {
    participantIdentity: 'student_2',
    allowAll: false,
    allowedTrackSids: ['TR_mic', 'TR_cam'],
  });
  assert.deepEqual(spotlightPerms.find((p) => p.participantIdentity === 'teacher_1'), {
    participantIdentity: 'teacher_1',
    allowAll: true,
  });
});

test('Live overview streams zero media; observer stage disables zoom and defaults audio OFF', () => {
  const overview = readFileSync('src/components/admin/OngoingClasses.tsx', 'utf8');
  assert.doesNotMatch(overview, /LiveKitRoom|StudentViewStage|RoomAudioRenderer|@livekit\/components-react|\/token/);

  const page = readFileSync('src/app/admin/live/[code]/page.tsx', 'utf8');
  assert.match(page, /useState\(false\)/); // audioEnabled defaults false
  assert.match(page, /data-testid="observer-audio-toggle"/);
  assert.match(page, /\{audioEnabled && \(\s*<>\s*<RoomAudioRenderer \/>/);
  assert.match(page, /<StudentViewStage[^>]*disableZoom/);
  assert.match(page, /OBSERVER_HIDDEN_DISCONNECT_MS/);
  assert.match(page, /pagehide/);

  const stage = readFileSync('src/components/classroom/StudentViewStage.tsx', 'utf8');
  assert.match(stage, /mode === 'observe' && audioEnabled/);
  assert.match(stage, /disableZoom=\{disableZoom\}/);

  const wb = readFileSync('src/lib/whiteboard/WhiteboardBoard.tsx', 'utf8');
  assert.match(wb, /disableZoom = false/);
  assert.match(wb, /if \(disableZoom\) return;/);
  assert.match(wb, /!disableZoom && mode !== 'edit' && isZoomed\(zp\)/);
});

test('admin end class: monitorLive required, 404 when not live, reuses endRoom with admin actor', async () => {
  const admin = { id: 'adm1', name: 'Head', email: 'h@x.org' };
  const adminGuardOk = async () => ({ admin });
  const unauthorized = async () => ({
    res: new Response(JSON.stringify({ error: 'Admin sign-in required' }), { status: 401 }),
  });
  const room = { id: 'r1', code: 'ABC123', sessionId: 's1', classSessionId: 'cs1', status: 'LIVE' };
  const load = async (code: string) => (code === 'ABC123' ? room : null);
  const ended: unknown[] = [];
  const end = async (...args: unknown[]) => {
    ended.push(args);
  };

  const r401 = await handleAdminEndClass('ABC123', { guard: unauthorized, load, end });
  assert.equal(r401.status, 401);
  assert.equal(ended.length, 0);

  const r404 = await handleAdminEndClass('NOPE', { guard: adminGuardOk, load, end });
  assert.equal(r404.status, 404);
  assert.equal(ended.length, 0);

  const already = await handleAdminEndClass('ABC123', {
    guard: adminGuardOk,
    load: async () => ({ ...room, status: 'ENDED' }),
    end,
  });
  assert.equal(already.status, 404);
  assert.equal(ended.length, 0);

  const ok = await handleAdminEndClass('abc123', { guard: adminGuardOk, load, end });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.code, 'ABC123');
  assert.equal(body.classSessionId, 'cs1');
  assert.equal(ended.length, 1);
  assert.equal((ended[0] as unknown[])[0], room);
  assert.deepEqual((ended[0] as unknown[])[1], { endedBy: 'admin', admin });
});

test('class-ended packet and teacher copy distinguish an admin end; student copy stays generic', () => {
  assert.equal(isClassEndedPacket({ v: 1, type: 'class-ended' }), true);
  assert.equal(isClassEndedPacket({ v: 1, type: 'class-ended', by: 'admin' }), true);
  assert.equal(endedByFromPacket({ v: 1, type: 'class-ended' }), undefined);
  assert.equal(endedByFromPacket({ v: 1, type: 'class-ended', by: 'admin' }), 'admin');
  assert.equal(endedByFromPacket({ v: 1, type: 'nudge' }), undefined);

  assert.equal(classEndedCopy(true).title, 'Class finished');
  assert.equal(classEndedCopy(true, 'admin').title, 'Class ended by admin');
  assert.match(classEndedCopy(true, 'admin').body, /administrator ended this class/);
  assert.equal(classEndedCopy(false, 'admin').title, 'Class ended');

  const line = formatAuditLine({
    at: '2026-11-25T13:00:00.000Z',
    action: 'end_class',
    actorKind: 'admin',
    actorId: 'adm1',
    actorName: 'Head',
    actorEmail: 'h@x.org',
    roomCode: 'ABC123',
    classSessionId: 'cs1',
  });
  assert.match(line, /\[audit\]/);
  assert.match(line, /end_class/);
  assert.match(line, /adm1/);
  assert.match(line, /ABC123/);
  assert.match(line, /cs1/);
});

test('observer and Live tab expose End class with a confirmation dialog; endRoom stays the shared closer', () => {
  const page = readFileSync('src/app/admin/live/[code]/page.tsx', 'utf8');
  assert.match(page, /data-testid="admin-end-class"/);
  assert.match(page, /EndClassDialog/);
  assert.match(page, /requestAdminEndClass/);

  const cards = readFileSync('src/components/admin/OngoingClasses.tsx', 'utf8');
  assert.match(cards, /data-testid="live-card-end-class"/);
  assert.match(cards, /End this class for everyone\?|EndClassDialog/);

  const dialog = readFileSync('src/components/admin/EndClassDialog.tsx', 'utf8');
  assert.match(dialog, /End this class for everyone\?/);
  assert.match(dialog, /data-testid="admin-end-class-confirm"/);

  const endLib = readFileSync('src/lib/teacherRoom.ts', 'utf8');
  const signalAt = endLib.indexOf("type: 'class-ended'");
  const deleteAt = endLib.indexOf('deleteRoom(');
  const adminAt = endLib.indexOf("by: 'admin'");
  assert.ok(signalAt > 0 && deleteAt > signalAt, 'class-ended packet still goes out before the room is deleted');
  assert.ok(adminAt > 0 && adminAt < deleteAt, 'admin end marks the packet before deleteRoom');

  const route = readFileSync('src/app/api/admin/live/[code]/end/route.ts', 'utf8');
  assert.match(route, /endRoom\(/);
  assert.match(route, /handleAdminEndClass/);
});
