import { ensureRedis, keys } from './redis';
import { withRedisLock } from './redisLock';
import { queuePosition, type MicBook, type MicWaiter } from './micSlots';

const EMPTY: MicBook = { open: [], queue: [] };

export async function readMicBook(code: string): Promise<MicBook> {
  const redis = await ensureRedis();
  const raw = await redis.get(keys.micBook(code));
  if (!raw) return { open: [], queue: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<MicBook>;
    const open = Array.isArray(parsed.open) ? parsed.open.filter((id) => typeof id === 'string') : [];
    const queue: MicWaiter[] = Array.isArray(parsed.queue)
      ? parsed.queue.filter((w): w is MicWaiter => !!w && typeof w.id === 'string' && (w.source === 'teacher' || w.source === 'student'))
      : [];
    return { open, queue };
  } catch {
    return { open: [], queue: [] };
  }
}

export async function writeMicBook(code: string, book: MicBook) {
  const redis = await ensureRedis();
  if (!book.open.length && !book.queue.length) {
    await redis.del(keys.micBook(code));
    return;
  }
  await redis.set(keys.micBook(code), JSON.stringify({ open: book.open, queue: book.queue }), 'EX', 12 * 60 * 60);
}

/**
 * Read-modify-write the room's mic book under a short Redis lock, so two
 * students asking to speak at once (or a teacher mute racing them) cannot
 * overwrite each other's change and exceed the cap.
 */
export async function updateMicBook<R extends { next: MicBook }>(code: string, fn: (book: MicBook) => R | Promise<R>): Promise<R> {
  return withRedisLock(`lock:mic-book:${code}`, async () => {
    const out = await fn(await readMicBook(code));
    await writeMicBook(code, out.next);
    return out;
  });
}

export function micQueueView(book: MicBook, names: Map<string, string>) {
  return book.queue.map((w, i) => ({
    id: w.id,
    name: names.get(w.id) ?? 'Student',
    source: w.source,
    position: i + 1,
  }));
}

export function micPosition(book: MicBook, id: string) {
  return queuePosition(book.queue, id);
}

export { EMPTY as emptyMicBook };
