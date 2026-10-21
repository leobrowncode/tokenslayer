import zlib from 'node:zlib';
import type { AlertLevel } from './types';

export const LEVEL_COLORS: Record<AlertLevel | 'idle', [number, number, number]> = {
  idle: [100, 116, 139],
  ok: [52, 211, 153],
  compact: [245, 158, 11],
  newChat: [239, 68, 68],
};

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

/** A token "coin" in the level color with a white slash through it, as straight RGBA pixels. */
export function renderIconRGBA(size: number, rgb: [number, number, number]): Buffer {
  const out = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          const d = Math.hypot(u - 0.5, v - 0.5);
          if (d > 0.47) continue;
          let c: [number, number, number] = rgb;
          if (Math.abs(d - 0.34) < 0.035) c = [rgb[0] * 0.6, rgb[1] * 0.6, rgb[2] * 0.6];
          if (segDist(u, v, 0.74, 0.22, 0.26, 0.78) < 0.065) c = [255, 255, 255];
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      const cov = a / n;
      const k = a > 0 ? 255 / a : 0;
      out[i] = Math.round(r * k);
      out[i + 1] = Math.round(g * k);
      out[i + 2] = Math.round(b * k);
      out[i + 3] = Math.round(cov);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePNG(rgba: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function iconPNG(size: number, level: AlertLevel | 'idle'): Buffer {
  return encodePNG(renderIconRGBA(size, LEVEL_COLORS[level]), size, size);
}
