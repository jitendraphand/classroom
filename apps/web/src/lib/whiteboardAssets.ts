/**
 * Whiteboard images (Nov 2026): pictures and PDF pages the teacher puts on the
 * board are uploaded once and stored in Redis for the class; the board item
 * only carries `asset:<id>` and every viewer fetches the image over HTTP
 * (cached by the browser: an asset never changes). Data packets and the
 * stored board snapshot stay small however many pages are imported.
 *
 * Pure helpers here are unit-tested; the Redis calls are thin.
 */
import { createHash } from 'node:crypto';
import { ensureRedis } from './redis';

export type AssetType = 'image/jpeg' | 'image/png' | 'image/webp';
export const ASSET_TYPES: AssetType[] = ['image/jpeg', 'image/png', 'image/webp'];
/** One image (a PDF page is ~150–600 KB as JPEG). */
export const ASSET_MAX_BYTES = 2 * 1024 * 1024;
/** All images of one class together. */
export const ASSET_ROOM_MAX_BYTES = 80 * 1024 * 1024;
/** Kept as long as a long class day; content-addressed so re-uploads are free. */
export const ASSET_TTL_S = 12 * 60 * 60;
export const ASSET_ID_RE = /^[a-f0-9]{32}$/;

export const assetKey = (code: string, id: string) => `room:${code}:wbasset:${id}`;
export const assetTypeKey = (code: string, id: string) => `room:${code}:wbasset:${id}:t`;
export const assetBytesKey = (code: string) => `room:${code}:wbasset-bytes`;
export const assetSetKey = (code: string) => `room:${code}:wbassets`;

/** Content id: the same picture uploaded twice is stored once. */
export function assetId(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}

/** The bytes really are the declared image type (magic numbers), within the size cap. */
export function assetBytesValid(bytes: Uint8Array, type: string): type is AssetType {
  if (bytes.length < 12 || bytes.length > ASSET_MAX_BYTES) return false;
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes[0] === 0x89 && ascii(1, 4) === 'PNG';
  if (type === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  return false;
}

/** Read a request body, giving up past `max` bytes (no Content-Length needed). */
export async function readBodyCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Store an image; `null` when the class is over its image budget. */
export async function storeAsset(code: string, bytes: Uint8Array, type: AssetType): Promise<string | null> {
  const id = assetId(bytes);
  const redis = await ensureRedis();
  if (await redis.exists(assetKey(code, id))) {
    await redis.expire(assetKey(code, id), ASSET_TTL_S);
    await redis.expire(assetTypeKey(code, id), ASSET_TTL_S);
    return id;
  }
  const used = Number(await redis.get(assetBytesKey(code))) || 0;
  if (used + bytes.length > ASSET_ROOM_MAX_BYTES) return null;
  await redis
    .multi()
    .set(assetKey(code, id), Buffer.from(bytes), 'EX', ASSET_TTL_S)
    .set(assetTypeKey(code, id), type, 'EX', ASSET_TTL_S)
    .incrby(assetBytesKey(code), bytes.length)
    .expire(assetBytesKey(code), ASSET_TTL_S)
    .sadd(assetSetKey(code), id)
    .expire(assetSetKey(code), ASSET_TTL_S)
    .exec();
  return id;
}

export async function loadAsset(code: string, id: string): Promise<{ bytes: Buffer; type: AssetType } | null> {
  if (!ASSET_ID_RE.test(id)) return null;
  const redis = await ensureRedis();
  const [bytes, type] = await Promise.all([redis.getBuffer(assetKey(code, id)), redis.get(assetTypeKey(code, id))]);
  if (!bytes || !type || !ASSET_TYPES.includes(type as AssetType)) return null;
  return { bytes, type: type as AssetType };
}

/** Class ended: drop its images now instead of waiting for the TTL. */
export async function clearAssets(code: string): Promise<void> {
  const redis = await ensureRedis();
  const ids = await redis.smembers(assetSetKey(code));
  const del = ids.filter((id) => ASSET_ID_RE.test(id)).flatMap((id) => [assetKey(code, id), assetTypeKey(code, id)]);
  await redis.del(...del, assetSetKey(code), assetBytesKey(code));
}
