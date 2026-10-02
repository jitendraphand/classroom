import { prisma } from './db';
import { hashPassword } from './auth';
import { generatePassword } from './passwords';
import { allocateUniqueCode } from './teacherRoom';
import { formatAssignment, type Assignment } from './grades';
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
  assignments: { grade: string; division: string }[];
}): TeacherRow {
  const assignments = t.assignments
    .map((a) => ({ grade: a.grade, division: a.division }))
    .sort((a, b) => a.grade.localeCompare(b.grade, undefined, { numeric: true }) || a.division.localeCompare(b.division));
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
    orderBy: [{ disabled: 'asc' }, { name: 'asc' }],
    include: { assignments: true },
  });
  return rows.map(toRow);
}

export async function getTeacherAssignments(teacherId: string): Promise<Assignment[]> {
  const rows = await prisma.teacherAssignment.findMany({ where: { teacherId } });
  return rows.map((r) => ({ grade: r.grade, division: r.division }));
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
  if (!current) throw new TeacherError('Teacher not found', 404);
  if (input.assignments) await checkAssignments(input.assignments, await getTeacherAssignments(id));
  const teacher = await prisma.$transaction(async (tx) => {
    if (input.assignments) {
      await tx.teacherAssignment.deleteMany({ where: { teacherId: id } });
      if (input.assignments.length) {
        await tx.teacherAssignment.createMany({
          data: input.assignments.map((a) => ({ teacherId: id, grade: a.grade, division: a.division })),
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

/** New temporary password; ends every session of the teacher. */
export async function resetTeacherPassword(id: string) {
  const current = await prisma.teacher.findUnique({ where: { id } });
  if (!current) throw new TeacherError('Teacher not found', 404);
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
