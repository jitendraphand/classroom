/**
 * GET /api/student/check — the cheap poll behind the /student page's
 * auto-check. Read-only (no check-in, no writes besides the sliding session
 * cookie), takes no parameters: the routing is computed for the student in
 * the session cookie only, and the answer is just a signature + kind, no class
 * or student details. When the signature changes, the page calls
 * POST /api/student/route, which checks the student in and moves them on.
 */
export type CheckDeps<S> = {
  getPupil: () => Promise<S | null>;
  signatureFor: (student: S) => Promise<{ sig: string; kind: string }>;
  refreshSession?: (student: S) => Promise<void>;
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export async function handleStudentCheck<S>(deps: CheckDeps<S>): Promise<Response> {
  const student = await deps.getPupil();
  if (!student) return json({ error: 'Open the class from the school app.', reason: 'missing' }, 401);
  try {
    const { sig, kind } = await deps.signatureFor(student);
    await deps.refreshSession?.(student).catch(() => undefined);
    return json({ sig, kind });
  } catch (e) {
    console.error('student check failed', e instanceof Error ? e.message : e);
    return json({ error: 'Could not check your classes.' }, 500);
  }
}

/** Next poll delay: base ± jitter (default 10–15 s), so a class of students does not poll in lockstep. */
export function nextPollDelay(baseMs = 12_500, jitterMs = 2_500, rand: () => number = Math.random): number {
  return Math.round(baseMs - jitterMs + rand() * 2 * jitterMs);
}
