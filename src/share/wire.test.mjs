import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ShareWireError,
  WIRE_FIXED32,
  WIRE_FIXED64,
  WIRE_LEN,
  WIRE_VARINT,
  WireReader,
  WireWriter,
  crc8,
  decodeBase64Url,
  encodeBase64Url,
  unzigzag,
  zigzag,
} from './wire.js';

const reasonOf = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ShareWireError, String(error));
    return error.reason;
  }
  assert.fail('expected a ShareWireError');
};

test('base64url round-trips every length and byte value without padding', () => {
  for (let length = 0; length < 70; length += 1) {
    const bytes = Uint8Array.from(
      { length },
      (_, i) => (i * 97 + length) & 0xff,
    );
    const text = encodeBase64Url(bytes);
    assert.match(text, /^[A-Za-z0-9_-]*$/);
    if (length) assert.deepEqual(decodeBase64Url(text), bytes);
  }
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.deepEqual(decodeBase64Url(encodeBase64Url(all)), all);
  assert.equal(encodeBase64Url(Uint8Array.of(0xfb, 0xff)), '-_8');
});

test('base64url rejects padding, foreign characters, bad lengths and stray bits', () => {
  for (const text of ['', 'AQ==', 'A+Q', 'A/Q', 'A Q', 'AQ%', 'A', 'AQAAA']) {
    assert.ok(
      ['empty', 'bad-base64'].includes(reasonOf(() => decodeBase64Url(text))),
      text,
    );
  }
  // "AR" carries one byte (0x01) plus four trailing bits that must be zero.
  assert.equal(
    reasonOf(() => decodeBase64Url('AR')),
    'bad-base64',
  );
  assert.deepEqual(decodeBase64Url('AQ'), Uint8Array.of(1));
});

test('zigzag maps small magnitudes of either sign to small codes', () => {
  assert.deepEqual([0, -1, 1, -2, 2].map(zigzag), [0, 1, 2, 3, 4]);
  for (const value of [0, 1, -1, 63, -64, 1e9, -1e9, 2 ** 51, -(2 ** 51)]) {
    assert.equal(unzigzag(zigzag(value)), value);
  }
});

test('varints round-trip up to the largest safe integer', () => {
  const values = [
    0,
    1,
    127,
    128,
    300,
    2 ** 21,
    2 ** 31,
    2 ** 32 + 5,
    Number.MAX_SAFE_INTEGER,
  ];
  const writer = new WireWriter();
  for (const value of values) writer.varint(value);
  const reader = new WireReader(writer.finish());
  for (const value of values) assert.equal(reader.varint(), value);
  assert.ok(reader.done);
  assert.deepEqual(
    new WireWriter().varint(300).finish(),
    Uint8Array.of(0xac, 0x02),
  );
});

test('the writer refuses values the format cannot carry', () => {
  assert.throws(() => new WireWriter().varint(-1), RangeError);
  assert.throws(() => new WireWriter().varint(1.5), RangeError);
  assert.throws(() => new WireWriter().varint(2 ** 53), RangeError);
  assert.throws(() => new WireWriter().tag(0, WIRE_VARINT), RangeError);
  assert.throws(() => new WireWriter().textField(1, 'é'), RangeError);
});

test('the reader rejects truncated, overlong and overflowing varints', () => {
  assert.equal(
    reasonOf(() => new WireReader(Uint8Array.of(0x80)).varint()),
    'truncated',
  );
  assert.equal(
    reasonOf(() => new WireReader(Uint8Array.of(0x81, 0x00)).varint()),
    'non-canonical-varint',
  );
  const tooLong = new Uint8Array(9).fill(0xff);
  assert.equal(
    reasonOf(() => new WireReader(tooLong).varint()),
    'varint-overflow',
  );
  const beyondSafe = Uint8Array.of(
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0x7f,
  );
  assert.equal(
    reasonOf(() => new WireReader(beyondSafe).varint()),
    'varint-overflow',
  );
});

test('the reader bounds lengths and rejects group and reserved wire types', () => {
  const absurd = new WireWriter().tag(3, WIRE_LEN).varint(1_000_000).finish();
  const reader = new WireReader(absurd);
  reader.tag();
  assert.equal(
    reasonOf(() => reader.lengthDelimited()),
    'truncated',
  );
  for (const wireType of [3, 4, 6, 7]) {
    const bytes = new WireWriter().varint(8 + wireType).finish();
    assert.equal(
      reasonOf(() => new WireReader(bytes).tag()),
      'bad-wire-type',
    );
  }
  assert.equal(
    reasonOf(() => new WireReader(Uint8Array.of(0x00)).tag()),
    'bad-field-number',
  );
});

test('skip steps over each wire type and stops at a truncated value', () => {
  const writer = new WireWriter()
    .uintField(1, 300)
    .bytesField(2, [1, 2, 3])
    .tag(3, WIRE_FIXED32);
  writer.bytes.push(1, 2, 3, 4);
  writer.tag(4, WIRE_FIXED64);
  writer.bytes.push(1, 2, 3, 4, 5, 6, 7, 8);
  writer.uintField(5, 9);
  const reader = new WireReader(writer.finish());
  for (let field = 1; field <= 4; field += 1)
    reader.skip(reader.tag().wireType);
  assert.deepEqual(reader.tag(), { field: 5, wireType: WIRE_VARINT });
  assert.equal(reader.varint(), 9);
  const short = new WireWriter().tag(1, WIRE_FIXED64).finish();
  const shortReader = new WireReader(Uint8Array.of(...short, 1, 2));
  assert.equal(
    reasonOf(() => shortReader.skip(shortReader.tag().wireType)),
    'truncated',
  );
});

test('crc8 is CRC-8/SMBUS and catches every burst of up to 8 bits', () => {
  // The catalogued check value for the ASCII digits 1–9.
  assert.equal(crc8(new TextEncoder().encode('123456789')), 0xf4);
  assert.equal(crc8([]), 0);
  const bytes = [1, 0x10, 0x82, 0x40, 0x7f, 0xff, 0x00, 0x33];
  const sum = crc8(bytes);
  for (let bit = 0; bit + 8 <= bytes.length * 8; bit += 1) {
    for (let pattern = 1; pattern < 256; pattern += 1) {
      // Flip a burst starting at `bit` (its first bit always set).
      if (!(pattern & 1)) continue;
      const flipped = [...bytes];
      for (let k = 0; k < 8; k += 1) {
        if (!(pattern & (1 << k))) continue;
        const at = bit + k;
        flipped[at >> 3] ^= 0x80 >> (at & 7);
      }
      assert.notEqual(crc8(flipped), sum, `burst ${pattern} at bit ${bit}`);
    }
  }
});
