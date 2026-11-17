// A solid-colour PNG, built by hand. The image data goes in zlib "stored"
// (uncompressed) blocks rather than through node:zlib: Bun and Node ship
// different zlib implementations, and compressed bytes could differ between
// them, while stored blocks are the same bytes everywhere.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  typeAndData.copy(out, 4);
  out.writeUInt32BE(crc32(typeAndData), 8 + data.length);
  return out;
}

// zlib stream of stored blocks, at most 65535 bytes each.
function storedZlib(raw: Uint8Array): Buffer {
  const parts: Buffer[] = [Buffer.from([0x78, 0x01])];
  for (let offset = 0; offset < raw.length || offset === 0; offset += 65535) {
    const block = raw.subarray(offset, offset + 65535);
    const last = offset + 65535 >= raw.length ? 1 : 0;
    const header = Buffer.alloc(5);
    header.writeUInt8(last, 0);
    header.writeUInt16LE(block.length, 1);
    header.writeUInt16LE(~block.length & 0xffff, 3);
    parts.push(header, Buffer.from(block));
    if (last) break;
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(adler32(raw), 0);
  parts.push(checksum);
  return Buffer.concat(parts);
}

export function solidPng(size: number, [r, g, b]: readonly [number, number, number]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // colour type: truecolour RGB
  // compression, filter and interlace methods stay 0

  const row = 1 + size * 3; // filter byte + pixels
  const raw = new Uint8Array(row * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = y * row + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", storedZlib(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
