// Node only: PNG images built in memory for the browser suite and the preview (ADR-0087), as Team re-encodes an image's
// rendition (an opaque RGB PNG). Never loaded by the application or a scenario the browser runs.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const framed = Buffer.alloc(8 + data.length + 4);
  framed.writeUInt32BE(data.length, 0);
  body.copy(framed, 4);
  framed.writeUInt32BE(crc(body), 4 + body.length);
  return framed;
}

/** One RGB PNG of `width` by `height` pixels, a diagonal blend from the colour `from` to `to` (each `[r, g, b]`). */
export function png(width, height, from = [90, 90, 90], to = from) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const pixels = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const mix = (x / width + y / height) / 2;
      for (let channel = 0; channel < 3; channel += 1) {
        pixels[row + 1 + x * 3 + channel] = Math.round(from[channel] + (to[channel] - from[channel]) * mix);
      }
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
