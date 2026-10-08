import { prisma } from './db';
import { hashPassword } from './auth';
import { generatePassword } from './passwords';
import { allocateUniqueCode } from './teacherRoom';
import { formatAssignment, normalizeCampus, type Assignment } from './grades';
import { loadCampuses } from './campusMaster';
import { campusProblem } from './campusLogic';
import { endRoom } from './teacherRoom';
import { kickReplacedTeacher } from './sessionKick';
import { loadMaster } from './gradeMaster';
import { assignmentsProblem } from './gradeMasterLogic';

export type TeacherRow = {
  id: string;
  name: string;
  email: string;
  disabled: boolean;
  mustChangePassword: boolean;
  permanentCode: string;
  assignments: Assignment[];
  assignmentsText: string;
  createdAt: Date;
};

function toRow(t: {
  id: string;
  name: string;
  email: string;
  disabled: boolean;
  mustChangePassword: boolean;
  permanentCode: string;
  createdAt: Date;
  assignments: { campus: string; grade: string; division: string }[];
}): TeacherRow {
  const assignments = t.assignments
    .map((a) => ({ campus: a.campus, grade: a.grade, division: a.division }))
    .sort(
      (a, b) =>
        a.campus.localeCompare(b.campus) ||
        a.grade.localeCompare(b.grade, undefined, { numeric: true }) ||
        a.division.localeCompare(b.division)
    );
  return {
    id: t.id,
    name: t.name,
    email: t.email,
    disabled: t.disabled,
    mustChangePassword: t.mustChangePassword,
    permanentCode: t.permanentCode,
    assignments,
    assignmentsText: assignments.map(formatAssignment).join(', '),
    createdAt: t.createdAt,
  };
}

export async function listTeachers(): Promise<TeacherRow[]> {
  const rows = await prisma.teacher.findMany({
    where: { deletedAt: null },
    orderBy: [{ disabled: 'asc' }, { name: 'asc' }],
    include: { assignments: true },
  });
  return rows.map(toRow);
}

export async function getTeacherAssignments(teacherId: string): Promise<Assignment[]> {
  const rows = await prisma.teacherAssignment.findMany({ where: { teacherId } });
  return rows.map((r) => ({ campus: r.campus, grade: r.grade, division: r.division }));
}

export class TeacherError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

/** Create a teacher with a temporary password (returned once, never stored in clear). */
/** New assignments must use grades/divisions from Admin → Grades & divisions. */
async function checkAssignments(assignments: Assignment[], keep: Assignment[] = []) {
  const problem = assignmentsProblem(await loadMaster(), assignments, keep);
  if (problem) throw new TeacherError(problem);
  const held = new Set(keep.map((a) => a.campus));
  const campuses = await loadCampuses();
  for (const c of new Set(assignments.map((a) => normalizeCampus(a.campus)))) {
    if (held.has(c)) continue;
    const p = campusProblem(campuses, c);
    if (p) throw new TeacherError(p);
  }
}

export async function createTeacher(input: { name: string; email: string; assignments: Assignment[] }) {
  await checkAssignments(input.assignments);
  const email = input.email.trim().toLowerCase();
  const [existing, admin] = await Promise.all([
    prisma.teacher.findUnique({ where: { email } }),
    prisma.admin.findUnique({ where: { email } }),
  ]);
  if (existing || admin) throw new TeacherError('An account with this email already exists', 409);
  const temporaryPassword = generatePassword();
  const teacher = await prisma.teacher.create({
    data: {
      email,
      name: input.name.trim(),
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      permanentCode: await allocateUniqueCode(),
      assignments: { create: input.assignments },
    },
    include: { assignments: true },
  });
  return { teacher: toRow(teacher), temporaryPassword };
}

export async function updateTeacher(
  id: string,
  input: { name?: string; disabled?: boolean; assignments?: Assignment[] }
) {
  const current = await prisma.teacher.findUnique({ where: { id } });
  if (!current || current.deletedAt) throw new TeacherError('Teacher not found', 404);
  if (input.assignments) await checkAssignments(input.assignments, await getTeacherAssignments(id));
  const teacher = await prisma.$transaction(async (tx) => {
    if (input.assignments) {
      await tx.teacherAssignment.deleteMany({ where: { teacherId: id } });
      if (input.assignments.length) {
        await tx.teacherAssignment.createMany({
          data: input.assignments.map((a) => ({ teacherId: id, campus: a.campus, grade: a.grade, division: a.division })),
        });
      }
    }
    return tx.teacher.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name.trim() } : {}),
        ...(input.disabled !== undefined && input.disabled !== current.disabled
          ? { disabled: input.disabled, sessionVersion: { increment: 1 } }
          : {}),
      },
      include: { assignments: true },
    });
  });
  return toRow(teacher);
}

/**
 * Delete a teacher (soft delete). The row stays so past classes, attendance
 * and reports keep their teacher name; everything forward-looking goes:
 * - sign-in stops at once (disabled, sessions revoked, email freed for reuse);
 * - a class they are running is ended and they are disconnected;
 * - grade assignments, weekly timetable slots (with their overrides) and
 *   extra / substitute overrides naming them are removed.
 */
export async function deleteTeacher(id: string) {
  const current = await prisma.teacher.findUnique({ where: { id } });
  if (!current || current.deletedAt) throw new TeacherError('Teacher not found', 404);
  await kickReplacedTeacher(id);
  const rooms = await prisma.room.findMany({ where: { teacherId: id, status: { not: 'ENDED' } } });
  for (const room of rooms) await endRoom(room);
  await prisma.$transaction([
    prisma.teacherAssignment.deleteMany({ where: { teacherId: id } }),
    prisma.scheduleOverride.deleteMany({ where: { teacherId: id } }),
    prisma.timetableSlot.deleteMany({ where: { teacherId: id } }),
    prisma.teacher.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        disabled: true,
        activeSessionId: null,
        sessionVersion: { increment: 1 },
        // Free the address so a new account can use it; keep a trace for audit.
        email: `deleted-${id}@deleted.invalid`,
      },
    }),
  ]);
  return { ok: true as const, name: current.name, email: current.email };
}

/** New temporary password; ends every session of the teacher. */
export async function resetTeacherPassword(id: string) {
  const current = await prisma.teacher.findUnique({ where: { id } });
  if (!current || current.deletedAt) throw new TeacherError('Teacher not found', 404);
  const temporaryPassword = generatePassword();
  const teacher = await prisma.teacher.update({
    where: { id },
    data: {
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      sessionVersion: { increment: 1 },
    },
    include: { assignments: true },
  });
  return { teacher: toRow(teacher), temporaryPassword };
}
