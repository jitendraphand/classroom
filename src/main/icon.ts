import { nativeImage, type NativeImage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[(stride + 1) * y] = 0;
    rgba.copy(raw, (stride + 1) * y + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function dot(size: number, alert: boolean): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const r = size * 0.42;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c + 0.5;
      const dy = y - c + 0.5;
      if (dx * dx + dy * dy > r * r) continue;
      const i = (y * size + x) * 4;
      rgba[i] = alert ? 245 : 14;
      rgba[i + 1] = alert ? 158 : 165;
      rgba[i + 2] = alert ? 11 : 233;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function fromFile(file: string): NativeImage | null {
  try {
    if (!fs.existsSync(file)) return null;
    const img = nativeImage.createFromPath(file);
    return img.isEmpty() ? null : img;
  } catch {
    return null;
  }
}

export function windowIcon(resourcesDir: string): NativeImage {
  return fromFile(path.join(resourcesDir, 'icon.png')) ?? nativeImage.createFromBuffer(encodePng(32, 32, dot(32, false)));
}

export function trayIcons(resourcesDir: string): { normal: NativeImage; alert: NativeImage } {
  const normal =
    fromFile(path.join(resourcesDir, 'tray.png')) ?? nativeImage.createFromBuffer(encodePng(32, 32, dot(32, false)));
  const alert =
    fromFile(path.join(resourcesDir, 'tray-alert.png')) ?? nativeImage.createFromBuffer(encodePng(32, 32, dot(32, true)));
  return { normal, alert };
}
