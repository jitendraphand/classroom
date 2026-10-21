export async function register() {
  // Next.js also compiles this file for the edge runtime. The import must sit
  // inside a literal NEXT_RUNTIME === 'nodejs' check so webpack drops it from the
  // edge bundle (ioredis needs Node built-ins such as stream, crypto, dns).
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const g = globalThis as unknown as { __classroomRankJob?: boolean };
    if (g.__classroomRankJob) return;
    g.__classroomRankJob = true;
    const { startRankScheduler } = await import('./lib/rankScheduler');
    startRankScheduler();
  }
}
