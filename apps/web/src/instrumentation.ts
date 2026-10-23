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
    try {
      const { schoolJoinModeFromEnv, signedModeProblem } = await import('./lib/schoolJoin');
      const { schoolJwtConfigFromEnv } = await import('./lib/schoolJwt');
      const problem = signedModeProblem(schoolJoinModeFromEnv(), schoolJwtConfigFromEnv());
      if (problem) console.error(`[school-join] ${problem}`);
    } catch (e) {
      console.error('[school-join] could not read the signed-link config:', e instanceof Error ? e.message : e);
    }
  }
}
