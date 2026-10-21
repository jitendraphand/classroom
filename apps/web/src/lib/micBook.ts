import { ensureRedis, keys } from './redis';
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
