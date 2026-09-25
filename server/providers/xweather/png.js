import { promisify } from 'node:util';
import zlib from 'node:zlib';

const deflate = promisify(zlib.deflate);

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Channels per colour type this decoder accepts: RGB, indexed, RGBA.
const CHANNELS = new Map([
  [2, 3],
  [3, 1],
  [6, 4],
]);

const fail = (code) => Object.assign(new Error(code), { code });

/**
 * Decode the PNG subset Xweather serves to RGBA: non-interlaced 8-bit RGB or
 * RGBA, and indexed colour at 1, 2, 4 or 8 bits with optional `tRNS`.
 * Anything else is refused rather than guessed.
 *
 * @param {Uint8Array} input PNG bytes.
 * @returns {{width: number, height: number, data: Uint8Array}} RGBA pixels.
 */
export function decodePng(input) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE))
    throw fail('invalid_png');
  let header = null;
  let palette = null;
  let alpha = null;
  const idat = [];
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('ascii', at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (data.length !== length) throw fail('invalid_png');
    if (type === 'IHDR') header = data;
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') alpha = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!header || header.length !== 13 || !idat.length)
    throw fail('invalid_png');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [depth, colour, , , interlace] = header.subarray(8);
  const channels = CHANNELS.get(colour);
  const depthOk = colour === 3 ? [1, 2, 4, 8].includes(depth) : depth === 8;
  if (!channels || !depthOk || interlace !== 0) throw fail('unsupported_png');
  if (colour === 3 && !palette) throw fail('invalid_png');
  if (!width || !height || width > 4096 || height > 4096)
    throw fail('invalid_png');
  const stride = Math.ceil((width * channels * depth) / 8);
  const bpp = Math.max(1, (channels * depth) >> 3);
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), {
      maxOutputLength: height * (stride + 1),
    });
  } catch {
    throw fail('invalid_png');
  }
  if (raw.length < height * (stride + 1)) throw fail('invalid_png');
  const out = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Uint8Array.from(
      raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)),
    );
    unfilter(filter, line, previous, bpp);
    expandRow(line, out, y * width * 4, width, colour, depth, palette, alpha);
    previous = line;
  }
  return { width, height, data: out };
}

function unfilter(filter, line, previous, bpp) {
  for (let i = 0; i < line.length; i++) {
    const left = i >= bpp ? line[i - bpp] : 0;
    const up = previous[i];
    const upLeft = i >= bpp ? previous[i - bpp] : 0;
    if (filter === 1) line[i] = (line[i] + left) & 255;
    else if (filter === 2) line[i] = (line[i] + up) & 255;
    else if (filter === 3) line[i] = (line[i] + ((left + up) >> 1)) & 255;
    else if (filter === 4) {
      const p = left + up - upLeft;
      const pa = Math.abs(p - left);
      const pb = Math.abs(p - up);
      const pc = Math.abs(p - upLeft);
      line[i] =
        (line[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) &
        255;
    } else if (filter !== 0) throw fail('invalid_png');
  }
}

function expandRow(line, out, offset, width, colour, depth, palette, alpha) {
  for (let x = 0; x < width; x++) {
    const o = offset + x * 4;
    if (colour === 6) {
      out.set(line.subarray(x * 4, x * 4 + 4), o);
    } else if (colour === 2) {
      out.set(line.subarray(x * 3, x * 3 + 3), o);
      out[o + 3] = 255;
    } else {
      const bit = x * depth;
      const index =
        (line[bit >> 3] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
      out[o] = palette[index * 3] ?? 0;
      out[o + 1] = palette[index * 3 + 1] ?? 0;
      out[o + 2] = palette[index * 3 + 2] ?? 0;
      out[o + 3] = alpha && index < alpha.length ? alpha[index] : 255;
    }
  }
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(
    zlib.crc32(out.subarray(4, 8 + data.length)),
    8 + data.length,
  );
  return out;
}

/** The IHDR payload and filter-None scanlines for an RGBA image. */
function prepare({ width, height, data }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    raw.set(
      data.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  return { header, raw };
}

const assemble = (header, deflated) =>
  Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', deflated),
    chunk('IEND', Buffer.alloc(0)),
  ]);

/**
 * Encode RGBA pixels as an 8-bit RGBA PNG (filter None, zlib level 6).
 *
 * @param {{width: number, height: number, data: Uint8Array}} image RGBA pixels.
 * @returns {Buffer} PNG bytes.
 */
export function encodePng(image) {
  const { header, raw } = prepare(image);
  return assemble(header, zlib.deflateSync(raw, { level: 6 }));
}

/**
 * `encodePng` with the deflate on libuv's thread pool, so a 4096×2048
 * composition does not hold the event loop while it compresses. The bytes
 * are identical.
 *
 * @param {{width: number, height: number, data: Uint8Array}} image RGBA pixels.
 * @returns {Promise<Buffer>} PNG bytes.
 */
export async function encodePngAsync(image) {
  const { header, raw } = prepare(image);
  return assemble(header, await deflate(raw, { level: 6 }));
}
