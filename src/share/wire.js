/**
 * Byte-level primitives for the compact share-view format: base64url text,
 * protobuf-style varints, and a tag-length-value reader and writer.
 *
 * Pure: no DOM, no Cesium, no platform buffers. Every integrity failure is a
 * {@link ShareWireError} with a stable `reason`, so the view codec can turn it
 * into a rejected link instead of an exception at app start.
 */

/** Wire types. Field numbers and their wire types are permanent. */
export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LEN = 2;
export const WIRE_FIXED32 = 5;

/** Field numbers stay inside protobuf's range so tags fit in five bytes. */
export const MAX_FIELD_NUMBER = 2 ** 29 - 1;
const MAX_VARINT_BYTES = 8; // 56 bits covers every safe integer.

/** A malformed or out-of-bounds payload. `reason` is a stable code. */
export class ShareWireError extends Error {
  constructor(reason, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ShareWireError';
    this.reason = reason;
  }
}

const BASE64URL =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const BASE64URL_INDEX = new Map(
  [...BASE64URL].map((char, index) => [char, index]),
);

/** Unpadded base64url text for `bytes`. */
export function encodeBase64Url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += BASE64URL[(triple >> 18) & 63] + BASE64URL[(triple >> 12) & 63];
    if (i + 1 < bytes.length) out += BASE64URL[(triple >> 6) & 63];
    if (i + 2 < bytes.length) out += BASE64URL[triple & 63];
  }
  return out;
}

/**
 * Bytes for unpadded base64url text. Rejects padding, foreign characters, an
 * impossible length and non-zero trailing bits, so every payload has exactly
 * one spelling.
 */
export function decodeBase64Url(text) {
  if (typeof text !== 'string' || text.length === 0)
    throw new ShareWireError('empty');
  if (text.length % 4 === 1) throw new ShareWireError('bad-base64');
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let out = 0;
  for (const char of text) {
    const value = BASE64URL_INDEX.get(char);
    if (value === undefined) throw new ShareWireError('bad-base64');
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (buffer >> bits) & 0xff;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0)
    throw new ShareWireError('bad-base64', 'non-zero trailing bits');
  return bytes;
}

/**
 * CRC-8 (polynomial x⁸ + x² + x + 1, 0x07; initial value 0; no reflection;
 * no final XOR) of `bytes`. A degree-8 CRC detects every error burst of up to
 * 8 bits, so any one mistyped base64url character (6 bits) is caught.
 */
export function crc8(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

/** Map a signed integer onto the unsigned varint space (0,-1,1,-2 → 0,1,2,3). */
export function zigzag(value) {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

/** Inverse of {@link zigzag}. */
export function unzigzag(value) {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

/** Largest magnitude a zigzag field can carry without losing precision. */
export const MAX_ZIGZAG_MAGNITUDE = Math.floor(Number.MAX_SAFE_INTEGER / 2);

/** Append-only byte sink with protobuf-style field helpers. */
export class WireWriter {
  constructor() {
    this.bytes = [];
  }

  varint(value) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError(`varint out of range: ${value}`);
    let rest = value;
    while (rest >= 0x80) {
      this.bytes.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.bytes.push(rest);
    return this;
  }

  tag(field, wireType) {
    if (!Number.isInteger(field) || field < 1 || field > MAX_FIELD_NUMBER)
      throw new RangeError(`field number out of range: ${field}`);
    return this.varint(field * 8 + wireType);
  }

  uintField(field, value) {
    return this.tag(field, WIRE_VARINT).varint(value);
  }

  sintField(field, value) {
    if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_ZIGZAG_MAGNITUDE)
      throw new RangeError(`signed value out of range: ${value}`);
    return this.tag(field, WIRE_VARINT).varint(zigzag(value));
  }

  bytesField(field, bytes) {
    this.tag(field, WIRE_LEN).varint(bytes.length);
    for (const byte of bytes) this.bytes.push(byte);
    return this;
  }

  /** ASCII-only text; every share-view string is drawn from ASCII grammars. */
  textField(field, text) {
    return this.bytesField(field, asciiBytes(text));
  }

  finish() {
    return Uint8Array.from(this.bytes);
  }
}

/** Printable-ASCII bytes for `text`; anything else is a programming error. */
export function asciiBytes(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e)
      throw new RangeError('share-view text must be printable ASCII');
    bytes.push(code);
  }
  return bytes;
}

/** Printable-ASCII text from bytes; anything else is a malformed payload. */
export function asciiText(bytes) {
  let out = '';
  for (const byte of bytes) {
    if (byte < 0x20 || byte > 0x7e) throw new ShareWireError('bad-text');
    out += String.fromCharCode(byte);
  }
  return out;
}

/** Bounds-checked cursor over one message (or one packed blob). */
export class WireReader {
  constructor(bytes, start = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = start;
    this.end = end;
  }

  get done() {
    return this.pos >= this.end;
  }

  /** One canonical varint no larger than Number.MAX_SAFE_INTEGER. */
  varint() {
    let value = 0;
    let scale = 1;
    for (let count = 0; count < MAX_VARINT_BYTES; count += 1) {
      if (this.pos >= this.end) throw new ShareWireError('truncated');
      const byte = this.bytes[this.pos++];
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        // A zero final byte after a continuation is an overlong spelling.
        if (count > 0 && byte === 0)
          throw new ShareWireError('non-canonical-varint');
        if (!Number.isSafeInteger(value))
          throw new ShareWireError('varint-overflow');
        return value;
      }
      scale *= 0x80;
    }
    throw new ShareWireError('varint-overflow');
  }

  svarint() {
    return unzigzag(this.varint());
  }

  /** The next field's number and wire type, rejecting reserved wire types. */
  tag() {
    const key = this.varint();
    const field = Math.floor(key / 8);
    const wireType = key % 8;
    if (field < 1 || field > MAX_FIELD_NUMBER)
      throw new ShareWireError('bad-field-number');
    if (
      wireType !== WIRE_VARINT &&
      wireType !== WIRE_FIXED64 &&
      wireType !== WIRE_LEN &&
      wireType !== WIRE_FIXED32
    )
      throw new ShareWireError('bad-wire-type', String(wireType));
    return { field, wireType };
  }

  /** A length-delimited body as a sub-reader over the same bytes. */
  lengthDelimited() {
    const length = this.varint();
    if (length > this.end - this.pos)
      throw new ShareWireError('truncated', 'length exceeds payload');
    const reader = new WireReader(this.bytes, this.pos, this.pos + length);
    this.pos += length;
    return reader;
  }

  /** Remaining bytes of this reader as a fresh array. */
  rest() {
    const out = this.bytes.slice(this.pos, this.end);
    this.pos = this.end;
    return out;
  }

  /** Skip one value of `wireType`, so newer fields cost older decoders nothing. */
  skip(wireType) {
    if (wireType === WIRE_VARINT) this.varint();
    else if (wireType === WIRE_LEN) this.lengthDelimited();
    else {
      const size = wireType === WIRE_FIXED64 ? 8 : 4;
      if (size > this.end - this.pos) throw new ShareWireError('truncated');
      this.pos += size;
    }
  }
}
