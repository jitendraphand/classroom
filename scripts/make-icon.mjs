/**
 * Writes build/icon.png and build/icon.ico for electron-builder and the window icon.
 * A filled rounded square in the classroom slate / sky palette. No external assets.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(width, height, rgba) {
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

function paint(size, alert) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const r = size * 0.42;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c + 0.5;
      const dy = y - c + 0.5;
      const i = (y * size + x) * 4;
      const inside = dx * dx + dy * dy <= r * r;
      if (!inside) continue;
      rgba[i] = alert ? 245 : 14;
      rgba[i + 1] = alert ? 158 : 165;
      rgba[i + 2] = alert ? 11 : 233;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

function icoFromPng(png, w, h) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = w >= 256 ? 0 : w;
  entry[1] = h >= 256 ? 0 : h;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

const dir = path.join(root, 'build');
fs.mkdirSync(dir, { recursive: true });
const png = encodePng(256, 256, paint(256, false));
fs.writeFileSync(path.join(dir, 'icon.png'), png);
fs.writeFileSync(path.join(dir, 'icon.ico'), icoFromPng(png, 256, 256));
fs.writeFileSync(path.join(dir, 'tray.png'), encodePng(32, 32, paint(32, false)));
fs.writeFileSync(path.join(dir, 'tray-alert.png'), encodePng(32, 32, paint(32, true)));
console.log('wrote build/icon.ico');
