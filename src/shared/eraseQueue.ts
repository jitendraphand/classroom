/**
 * Teacher eraser over student ink: an eraser drag reports the same strokes
 * on many pointer moves. Ids are de-duplicated (each stroke is deleted once
 * per session), collected for `flushMs`, then sent with at most `concurrency`
 * requests in flight. The server route deletes one stroke per call (web
 * /draw {action:'erase'}), so this caps the request burst instead of one
 * request per pointer move.
 */
export function createEraseQueue(
  send: (id: string) => Promise<void>,
  opts: { flushMs?: number; concurrency?: number; schedule?: (fn: () => void, ms: number) => unknown } = {}
) {
  const flushMs = opts.flushMs ?? 120;
  const concurrency = opts.concurrency ?? 3;
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const seen = new Set<string>();
  const pending: string[] = [];
  let timer: unknown = null;
  let inflight = 0;
  let sent = 0;
  const pump = () => {
    while (inflight < concurrency && pending.length) {
      const id = pending.shift()!;
      inflight++;
      sent++;
      void send(id)
        .catch(() => undefined)
        .finally(() => {
          inflight--;
          pump();
        });
    }
  };
  return {
    add(ids: readonly string[]) {
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push(id);
      }
      if (!pending.length || timer !== null) return;
      timer = schedule(() => {
        timer = null;
        pump();
      }, flushMs);
    },
    stats: () => ({ sent, pending: pending.length, inflight }),
  };
}
