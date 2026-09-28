import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  decodePng,
  encodePng,
  encodePngAsync,
} from '../../server/providers/xweather/png.js';

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
function png({ width, height, depth, type, rows, plte, trns, interlace = 0 }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = type;
  ihdr[12] = interlace;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    ...(plte ? [chunk('PLTE', Buffer.from(plte))] : []),
    ...(trns ? [chunk('tRNS', Buffer.from(trns))] : []),
    chunk('IDAT', zlib.deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('encodePng output decodes back to the same RGBA pixels', () => {
  const data = Uint8Array.from([
    255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 9, 9, 9, 9,
  ]);
  const back = decodePng(encodePng({ width: 2, height: 2, data }));
  assert.equal(back.width, 2);
  assert.equal(back.height, 2);
  assert.deepEqual([...back.data], [...data]);
});

test('1-bit indexed tiles expand through PLTE and tRNS like lightning-flash', () => {
  // One row of 3 px, bits 1 0 1, filter None; index 0 transparent, index 1 white.
  const bytes = png({
    width: 3,
    height: 1,
    depth: 1,
    type: 3,
    plte: [0, 0, 0, 255, 255, 255],
    trns: [0, 255],
    rows: [0, 0b10100000],
  });
  assert.deepEqual(
    [...decodePng(bytes).data],
    [255, 255, 255, 255, 0, 0, 0, 0, 255, 255, 255, 255],
  );
});

test('every PNG row filter reconstructs the same pixels', () => {
  // 2x2 RGBA, second row uses Paeth (4), first row Sub (1).
  const rows = [1, 10, 20, 30, 255, 5, 5, 5, 0, 4, 1, 2, 3, 0, 1, 1, 1, 0];
  const { data } = decodePng(
    png({ width: 2, height: 2, depth: 8, type: 6, rows }),
  );
  assert.deepEqual(
    [...data.subarray(0, 8)],
    [10, 20, 30, 255, 15, 25, 35, 255],
  );
  assert.deepEqual(
    [...data.subarray(8, 16)],
    [11, 22, 33, 255, 16, 26, 36, 255],
  );
});

test('interlaced and 16-bit images are refused, not guessed', () => {
  const rows = [0, 0, 0, 0, 0];
  assert.throws(
    () =>
      decodePng(
        png({ width: 1, height: 1, depth: 8, type: 6, rows, interlace: 1 }),
      ),
    { code: 'unsupported_png' },
  );
  assert.throws(
    () => decodePng(png({ width: 1, height: 1, depth: 16, type: 6, rows })),
    { code: 'unsupported_png' },
  );
  assert.throws(() => decodePng(Buffer.from('not a png')), {
    code: 'invalid_png',
  });
});

test('encodePngAsync produces the same bytes as encodePng off the event loop', async () => {
  const data = Uint8Array.from(
    { length: 300 * 150 * 4 },
    (_, i) => (i * 37) & 255,
  );
  const image = { width: 300, height: 150, data };
  const pending = encodePngAsync(image);
  assert.ok(pending instanceof Promise);
  assert.deepEqual(await pending, encodePng(image));
});
