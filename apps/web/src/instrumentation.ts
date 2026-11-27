export async function register() {
  // Next.js also compiles this file for the edge runtime. The import must sit
  // inside a literal NEXT_RUNTIME === 'nodejs' check so webpack drops it from the
  // edge bundle (ioredis needs Node built-ins such as stream, crypto, dns).
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const g = globalThis as unknown as { __classroomJobs?: boolean };
    if (g.__classroomJobs) return;
    g.__classroomJobs = true;
    const { startRankScheduler } = await import('./lib/rankScheduler');
    startRankScheduler();
    const { startAbsenceSweeper } = await import('./lib/teacherPresence');
    startAbsenceSweeper();
    const { startMicIdleSweeper } = await import('./lib/micSlotService');
    startMicIdleSweeper();
    const { startAttendanceFlusher } = await import('./lib/attendanceQueue');
    startAttendanceFlusher();
    const { startRetentionJob } = await import('./lib/retention');
    startRetentionJob();
    try {
      const { ensureJoinAudience } = await import('./lib/joinClassSeed');
      const { planAddsAnything } = await import('./lib/joinClassForm');
      const plan = await ensureJoinAudience();
      if (planAddsAnything(plan)) {
        console.info(
          '[join-class] added missing options:',
          `${plan.gradesToAdd.length} grade(s), ${plan.campusesToAdd.length} campus(es)`,
        );
      }
    } catch (e) {
      console.error('[join-class] could not seed grade/campus options:', e instanceof Error ? e.message : e);
    }
    try {
      const { schoolJoinModeFromEnv, signedModeProblem } = await import('./lib/schoolJoin');
      const { schoolJwtConfigFromEnv } = await import('./lib/schoolJwt');
      const problem = signedModeProblem(schoolJoinModeFromEnv(), schoolJwtConfigFromEnv());
      if (problem) console.error(`[school-join] ${problem}`);
      const { unauthenticatedJoinWarning } = await import('./lib/schoolJoin');
      const warn = unauthenticatedJoinWarning();
      if (warn) console.warn(`[school-join] WARNING: ${warn}`);
    } catch (e) {
      console.error('[school-join] could not read the signed-link config:', e instanceof Error ? e.message : e);
    }
  }
}
