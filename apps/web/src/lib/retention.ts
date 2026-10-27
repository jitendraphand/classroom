/**
 * Housekeeping on one worker (leader lock), every few hours: a teacher's
 * permanent room is reused for every class, so its Participant rows (one per
 * student per class) only ever grew. Rows of students who LEFT more than
 * PARTICIPANT_RETENTION_DAYS ago (default 30; 0 = keep forever) are deleted in
 * small batches. Attendance, feedback and reports do not use them (they are
 * keyed on Student + ClassSession), and their chat was already cleared when the
 * room reopened.
 */
import { prisma } from './db';
import { runIfLeader } from './leaderLock';

const EVERY_MS = 6 * 60 * 60 * 1000;
const BATCH = 2_000;

export function participantRetentionDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PARTICIPANT_RETENTION_DAYS?.trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 30;
}

export async function pruneOldParticipants(now = new Date(), days = participantRetentionDays()): Promise<number> {
  if (days <= 0) return 0;
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  let total = 0;
  for (;;) {
    const ids = (
      await prisma.participant.findMany({
        where: { role: 'STUDENT', status: 'LEFT', leftAt: { lt: cutoff } },
        select: { id: true },
        take: BATCH,
      })
    ).map((p) => p.id);
    if (!ids.length) return total;
    total += (await prisma.participant.deleteMany({ where: { id: { in: ids } } })).count;
    if (ids.length < BATCH) return total;
    await new Promise((r) => setTimeout(r, 200));
  }
}

export function startRetentionJob() {
  const tick = () => {
    void runIfLeader('leader:retention', 30 * 60, async () => {
      const n = await pruneOldParticipants();
      if (n) console.log(`[retention] removed ${n} old participant row(s)`);
    }).catch((e) => console.error('[retention]', e instanceof Error ? e.message : e));
  };
  const first = setTimeout(tick, 5 * 60_000);
  const every = setInterval(tick, EVERY_MS);
  first.unref?.();
  every.unref?.();
}
