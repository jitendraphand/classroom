/**
 * Snapshot compression for late joiners / rejoiners: deflate-raw via the
 * standard CompressionStream (Chrome, Edge, Safari 16.4+, Firefox, Node 18+),
 * base64 for the JSON packet. Falls back to plain JSON (z: 0) where the API
 * is missing (very old iOS).
 */
import { cleanDoc, type Doc, type Packet } from './model';

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }): Promise<Uint8Array> {
  const w = stream.writable.getWriter();
  void w.write(bytes).then(() => w.close());
  const buf = await new Response(stream.readable).arrayBuffer();
  return new Uint8Array(buf);
}

export function compressionAvailable(): boolean {
  return typeof (globalThis as { CompressionStream?: unknown }).CompressionStream === 'function';
}

export async function encodeSnapshot(doc: Doc): Promise<Packet> {
  const json = JSON.stringify(doc);
  if (!compressionAvailable()) return { v: 1, t: 'snap', doc: json, z: 0 };
  const CS = (globalThis as unknown as { CompressionStream: new (f: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } }).CompressionStream;
  const z = await pipe(new TextEncoder().encode(json), new CS('deflate-raw'));
  return { v: 1, t: 'snap', doc: toB64(z), z: 1 };
}

export async function decodeSnapshot(p: Extract<Packet, { t: 'snap' }>): Promise<Doc | null> {
  try {
    if (!p.z) return cleanDoc(JSON.parse(p.doc));
    const DS = (globalThis as unknown as { DecompressionStream?: new (f: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } }).DecompressionStream;
    if (!DS) return null;
    const raw = await pipe(fromB64(p.doc), new DS('deflate-raw'));
    return cleanDoc(JSON.parse(new TextDecoder().decode(raw)));
  } catch {
    return null;
  }
}
