/**
 * Idempotent seed of the grades, campuses and foundations the "Join the class"
 * form offers. Existing rows are never renamed, reactivated or deleted.
 * Called at process start and again from the join form routes as a safety net.
 */
import { Prisma } from '@prisma/client';
import { prisma } from './db';
import { loadCampuses } from './campusMaster';
import { loadMaster } from './gradeMaster';
import { planAddsAnything, planJoinAudience, type JoinAudiencePlan } from './joinClassForm';

function isUnique(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/** Add any missing advertised grades, campuses and foundation divisions. */
export async function ensureJoinAudience(): Promise<JoinAudiencePlan> {
  const plan = planJoinAudience(await loadMaster(), await loadCampuses());
  if (!planAddsAnything(plan)) return plan;

  for (const g of plan.gradesToAdd) {
    try {
      await prisma.grade.create({ data: { name: g.name, label: g.label, sortOrder: g.sortOrder, active: true } });
    } catch (e) {
      if (!isUnique(e)) throw e;
    }
  }

  for (const c of plan.campusesToAdd) {
    try {
      await prisma.campus.create({ data: { name: c.name, label: c.label, sortOrder: c.sortOrder, active: true } });
    } catch (e) {
      if (!isUnique(e)) throw e;
    }
  }

  if (plan.divisionsToAdd.length) {
    const grades = await prisma.grade.findMany({
      where: { name: { in: [...new Set(plan.divisionsToAdd.map((d) => d.gradeName))] } },
      select: { id: true, name: true },
    });
    const idByName = new Map(grades.map((g) => [g.name, g.id]));
    for (const d of plan.divisionsToAdd) {
      const gradeId = idByName.get(d.gradeName);
      if (!gradeId) continue;
      try {
        await prisma.division.create({ data: { gradeId, name: d.name, label: d.label, active: true } });
      } catch (e) {
        if (!isUnique(e)) throw e;
      }
    }
  }

  return plan;
}

/** Once the master lists are complete, re-check at most this often per worker. */
const SEED_RECHECK_MS = 10 * 60 * 1000;
let seededAt = 0;

/**
 * ensureJoinAudience for request paths (the join page and API): after a
 * check that found nothing to add, skip it for SEED_RECHECK_MS instead of
 * re-reading grades and campuses on every page view and every join (PERF-07).
 * Boot still runs the full ensureJoinAudience.
 */
export async function ensureJoinAudienceCached(now: number = Date.now()): Promise<void> {
  if (seededAt && now - seededAt < SEED_RECHECK_MS) return;
  const plan = await ensureJoinAudience();
  // Rows were just added: the next request re-checks (cheap) to confirm.
  seededAt = planAddsAnything(plan) ? 0 : now;
}
