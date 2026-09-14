/**
 * @file Codec for the bundled 2-bit land/sea mask asset.
 *
 * Binary layout (byte-exact, size-pinned by the asset test): 16-byte header —
 * magic `GEVM`, uint16 LE version=1, uint16 reserved, uint32 LE width,
 * uint32 LE height — then a payload of 2 bits/cell, 4 cells/byte, LSB-first,
 * row-major with `idx = row*width + col`, row 0 = lat band starting at −90,
 * col 0 = lon band starting at −180. Pure module: importable by the build
 * script, the click-gating loader, and the leeway worker alike.
 *
 * @module data/landSeaMaskCodec
 */

/** @const {number} Cell state: open water. */
export const MASK_WATER = 0;
/** @const {number} Cell state: land. */
export const MASK_LAND = 1;
/** @const {number} Cell state: coastal-mixed — never trusted as land or water. */
export const MASK_COASTAL = 2;
/** @const {number} Production grid width: 2880 columns of 1/8 deg from −180. */
export const MASK_WIDTH = 2880;
/** @const {number} Production grid height: 1440 rows of 1/8 deg from −90. */
export const MASK_HEIGHT = 1440;

/** @const {number} Header bytes preceding the packed payload. */
const HEADER_BYTES = 16;
/** @const {number} File format version stamped in the header. */
const FORMAT_VERSION = 1;
/** ASCII `GEVM`. */
const MAGIC = [0x47, 0x45, 0x56, 0x4d];

/**
 * Normalize a longitude into [-180, 180).
 *
 * @param {number} lon - Degrees, any range.
 * @returns {number} Equivalent longitude in [-180, 180).
 */
export function wrapLon(lon) {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

/**
 * Pack per-cell states into 2-bit cells, 4 per byte, LSB-first.
 *
 * @param {Uint8Array} states - One state (0..3) per cell, row-major.
 * @returns {Uint8Array} ceil(states.length / 4) packed bytes.
 */
export function packMaskStates(states) {
  const packed = new Uint8Array(Math.ceil(states.length / 4));
  for (let i = 0; i < states.length; i += 1) {
    packed[i >> 2] |= (states[i] & 0b11) << ((i & 3) * 2);
  }
  return packed;
}

/**
 * Assemble the full asset file: header plus packed payload.
 *
 * @param {Uint8Array} states - width*height cell states, row-major.
 * @param {number} width - Grid columns.
 * @param {number} height - Grid rows.
 * @returns {ArrayBuffer} Exactly 16 + ceil(width*height/4) bytes.
 */
export function buildMaskFileBuffer(states, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`mask dimensions must be positive integers, got ${width}x${height}`);
  }
  if (states.length !== width * height) {
    throw new Error(`states length ${states.length} != width*height ${width * height}`);
  }
  const packed = packMaskStates(states);
  const buffer = new ArrayBuffer(HEADER_BYTES + packed.length);
  const bytes = new Uint8Array(buffer);
  bytes.set(MAGIC, 0);
  const view = new DataView(buffer);
  view.setUint16(4, FORMAT_VERSION, true);
  view.setUint16(6, 0, true); // reserved
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  bytes.set(packed, HEADER_BYTES);
  return buffer;
}

/**
 * Validate and decode an asset file into an addressable mask.
 *
 * @param {ArrayBuffer|ArrayBufferView} buffer - Raw file contents.
 * @returns {{width: number, height: number, data: Uint8Array}} `data` stays
 *   packed (2 bits/cell); address it via {@link maskStateAt}.
 * @throws {Error} On bad magic, version, dimensions, or byte length.
 */
export function decodeMaskBuffer(buffer) {
  const bytes = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
  if (bytes.byteLength < HEADER_BYTES) {
    throw new Error(`mask file truncated: ${bytes.byteLength} bytes < ${HEADER_BYTES}-byte header`);
  }
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) throw new Error('mask file has bad magic (expected GEVM)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  if (version !== FORMAT_VERSION) {
    throw new Error(`unsupported mask version ${version} (expected ${FORMAT_VERSION})`);
  }
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  if (width === 0 || height === 0) {
    throw new Error(`mask has zero dimension: width=${width} height=${height}`);
  }
  const expected = HEADER_BYTES + Math.ceil((width * height) / 4);
  if (bytes.byteLength !== expected) {
    throw new Error(`mask file length ${bytes.byteLength} != expected ${expected} (truncated or padded)`);
  }
  return { width, height, data: bytes.subarray(HEADER_BYTES) };
}

/**
 * Read the state of the cell containing (lat, lon). Allocation-free — safe
 * inside the per-particle leeway step loop.
 *
 * @param {{width: number, height: number, data: Uint8Array}} mask - From
 *   {@link decodeMaskBuffer}.
 * @param {number} lat - Degrees; +90 clamps into the top row.
 * @param {number} lon - Degrees, any range (wrapped).
 * @returns {number} MASK_WATER | MASK_LAND | MASK_COASTAL (3 reserved).
 */
export function maskStateAt(mask, lat, lon) {
  const col = Math.min(
    mask.width - 1,
    Math.max(0, Math.floor((wrapLon(lon) + 180) * mask.width / 360)),
  );
  const row = Math.min(
    mask.height - 1,
    Math.max(0, Math.floor((lat + 90) * mask.height / 180)),
  );
  const idx = row * mask.width + col;
  return (mask.data[idx >> 2] >> ((idx & 3) * 2)) & 0b11;
}
