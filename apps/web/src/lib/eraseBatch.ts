/**
 * Batched teacher erase of student strokes (pure, shared with the Windows
 * app). POST /api/rooms/:code/draw {action:'erase', ids:[...]} deletes up to
 * ERASE_BATCH_MAX strokes in one request; {action:'erase', id} still works.
 */
export const ERASE_BATCH_MAX = 50;

export function eraseBatchBodies(ids: readonly string[], max = ERASE_BATCH_MAX): { action: 'erase'; ids: string[] }[] {
  const uniq = [...new Set(ids.filter((x) => typeof x === 'string' && x.length > 0))];
  const out: { action: 'erase'; ids: string[] }[] = [];
  for (let i = 0; i < uniq.length; i += max) out.push({ action: 'erase', ids: uniq.slice(i, i + max) });
  return out;
}

/**
 * Collects eraser hits (one drag reports the same strokes many times), dedupes
 * them for the session, and sends one batch per `flushMs`.
 */
export function createEraseBatcher(
  send: (body: { action: 'erase'; ids: string[] }) => Promise<unknown>,
  opts: { flushMs?: number; schedule?: (fn: () => void, ms: number) => unknown } = {}
) {
  const flushMs = opts.flushMs ?? 120;
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const seen = new Set<string>();
  let pending: string[] = [];
  let timer: unknown = null;
  let requests = 0;
  const flush = () => {
    timer = null;
    const ids = pending;
    pending = [];
    for (const body of eraseBatchBodies(ids)) {
      requests++;
      void Promise.resolve(send(body)).catch(() => undefined);
    }
  };
  return {
    add(ids: readonly string[]) {
      for (const id of ids) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        pending.push(id);
      }
      if (pending.length && timer === null) timer = schedule(flush, flushMs);
    },
    requests: () => requests,
  };
}
