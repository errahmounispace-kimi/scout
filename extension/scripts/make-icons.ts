// Generates placeholder PNG icons (amber square on dark zinc) into dist/icons.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

function crc32(buf: Buffer): number {
  let table: number[] = (crc32 as any)._t;
  if (!table) {
    table = (crc32 as any)._t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(size: number): Buffer {
  // RGBA rows, each prefixed with filter byte 0.
  const row = Buffer.alloc(1 + size * 4);
  const rows: Buffer[] = [];
  const r = Math.floor(size / 4); // corner radius-ish
  for (let y = 0; y < size; y++) {
    const buf = Buffer.from(row);
    for (let x = 0; x < size; x++) {
      const inCorner =
        (x < r && y < r && (x - r) ** 2 + (y - r) ** 2 > r * r) ||
        (x >= size - r && y < r && (x - (size - r - 1)) ** 2 + (y - r) ** 2 > r * r) ||
        (x < r && y >= size - r && (x - r) ** 2 + (y - (size - r - 1)) ** 2 > r * r) ||
        (x >= size - r && y >= size - r && (x - (size - r - 1)) ** 2 + (y - (size - r - 1)) ** 2 > r * r);
      const o = 1 + x * 4;
      if (inCorner) {
        buf[o + 3] = 0;
      } else if (x > size * 0.3 && x < size * 0.7 && y > size * 0.3 && y < size * 0.7) {
        buf[o] = 0xf5; buf[o + 1] = 0x9e; buf[o + 2] = 0x0b; buf[o + 3] = 255; // amber
      } else {
        buf[o] = 0x27; buf[o + 1] = 0x27; buf[o + 2] = 0x2a; buf[o + 3] = 255; // zinc-800
      }
    }
    rows.push(buf);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("dist/icons", { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(`dist/icons/icon${size}.png`, makePng(size));
}
console.log("icons written");
