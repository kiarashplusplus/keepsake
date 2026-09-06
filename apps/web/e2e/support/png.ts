/**
 * A minimal, real PNG encoder for the file the give flow uploads.
 *
 * It has to be a *decodable* image, not the JPEG magic bytes
 * `apps/api/test/helpers.ts` gets away with: the browser side of the give
 * flow runs `createImageBitmap` (`src/lib/images/resizeImage.ts`) and checks
 * the decoded dimensions against `MIN_SOURCE_EDGE_PX` before it will upload
 * anything, so a fake header would fail the picker rather than the assertion
 * under test. Encoding one here (rather than committing a fixture file) keeps
 * the size and the colour under the test's control and the repo free of
 * binary blobs.
 */
import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * An 8-bit truecolour PNG of `width` x `height`, filled with a soft vertical
 * gradient so it is visibly a photo-ish thing rather than one flat colour in
 * any screenshot a failing run leaves behind.
 */
export function makePng(width: number, height: number, seed = 0): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3;
      raw[at] = (150 + ((x + seed) % 80)) & 0xff;
      raw[at + 1] = (90 + ((y + seed) % 90)) & 0xff;
      raw[at + 2] = (60 + ((x + y + seed) % 60)) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
