import Bunzip from 'seek-bzip';

// Both products are 0.25 km x 1 degree; packet 16's range scale is a pixel
// ratio, not a gate length.
const PRODUCTS = Object.freeze({
  N0U: Object.freeze({ code: 99, gateKm: 0.25 }),
  N0C: Object.freeze({ code: 161, gateKm: 0.25 }),
});
const MESSAGE_HEADER_BYTES = 18;
const DESCRIPTION_BYTES = 102;
const MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024;

const fail = (reason) => {
  throw new Error(`Invalid Level III product: ${reason}`);
};

function messageStart(bytes) {
  // WMO heading line, then the AWIPS id line, each ending "\r\r\n".
  let lines = 0;
  for (let i = 0; i + 2 < Math.min(bytes.length, 64); i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 13 && bytes[i + 2] === 10) {
      if (++lines === 2) return i + 3;
      i += 2;
    }
  }
  return fail('missing WMO heading');
}

function scanTimeOf(view, at) {
  const days = view.getInt16(at);
  const seconds = view.getInt32(at + 2);
  if (days < 1 || seconds < 0 || seconds >= 86_400) fail('scan time');
  return new Date(((days - 1) * 86_400 + seconds) * 1000).toISOString();
}

function decodeValue(product, thresholds) {
  if (product === 'N0U') {
    const minimum = thresholds.getInt16(0) / 10;
    const increment = thresholds.getInt16(2) / 10;
    if (!(increment > 0)) fail('velocity thresholds');
    return (code) => (code < 2 ? NaN : minimum + (code - 2) * increment);
  }
  const scale = thresholds.getFloat32(0);
  const offset = thresholds.getFloat32(4);
  if (!(scale > 0) || !Number.isFinite(offset)) fail('correlation thresholds');
  return (code) => (code < 2 ? NaN : (code - offset) / scale);
}

/**
 * One tgftp `sn.NNNN` file of a digital radial product (NWS ICD 2620001,
 * packet 16) as physical values. N0U is m/s positive away from the radar;
 * N0C is the correlation coefficient. NaN marks below-threshold or folded gates.
 */
export function decodeLevel3(bytes, expected) {
  if (!(bytes instanceof Uint8Array)) fail('bytes');
  if (!Object.hasOwn(PRODUCTS, expected)) fail('requested product');
  const start = messageStart(bytes);
  if (bytes.length < start + MESSAGE_HEADER_BYTES + DESCRIPTION_BYTES)
    fail('truncated header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const code = view.getInt16(start);
  const pdb = start + MESSAGE_HEADER_BYTES;
  const { gateKm } = PRODUCTS[expected];
  if (code !== PRODUCTS[expected].code || view.getInt16(pdb + 12) !== code)
    fail(`product code ${code}`);
  if (view.getInt16(pdb) !== -1) fail('description divider');
  const position = {
    lat: view.getInt32(pdb + 2) / 1000,
    lon: view.getInt32(pdb + 6) / 1000,
    elevM: view.getInt16(pdb + 10) * 0.3048,
  };
  if (
    !(Math.abs(position.lat) <= 90) ||
    !(Math.abs(position.lon) <= 180) ||
    !Number.isFinite(position.elevM)
  )
    fail('radar position');
  const scanTime = scanTimeOf(view, pdb + 22);
  const elevationDeg = view.getInt16(pdb + 40) / 10;
  const value = decodeValue(
    expected,
    new DataView(bytes.buffer, bytes.byteOffset + pdb + 42, 32),
  );
  const compression = view.getInt16(pdb + 82);
  const uncompressedSize = view.getUint32(pdb + 84);
  const symbologyAt = start + view.getUint32(pdb + 90) * 2;
  if (compression !== 1) fail(`compression ${compression}`);
  if (uncompressedSize > MAX_UNCOMPRESSED_BYTES) fail('uncompressed size');
  const symbology = new Uint8Array(
    Bunzip.decode(Buffer.from(bytes.subarray(symbologyAt))),
  );
  if (symbology.length !== uncompressedSize) fail('decompressed size');
  const block = new DataView(symbology.buffer, symbology.byteOffset);
  if (block.getInt16(0) !== -1 || block.getInt16(2) !== 1)
    fail('symbology block');
  // Block header (10 B), then the first layer's divider and length (6 B).
  const packet = 16;
  if (block.getUint16(packet) !== 16) fail('not a digital radial packet');
  const firstBin = block.getInt16(packet + 2);
  const bins = block.getInt16(packet + 4);
  const count = block.getInt16(packet + 12);
  if (firstBin < 0 || bins <= 0 || bins > 2000 || count <= 0 || count > 1000)
    fail('radial packet header');
  const radials = [];
  let at = packet + 14;
  for (let r = 0; r < count; r++) {
    if (at + 6 > symbology.length) fail('truncated radial');
    const length = block.getInt16(at);
    const azimuthDeg = block.getInt16(at + 2) / 10;
    const widthDeg = block.getInt16(at + 4) / 10;
    at += 6;
    if (length < 0 || at + length > symbology.length) fail('radial length');
    const values = new Float32Array(bins);
    for (let i = 0; i < bins; i++)
      values[i] = i < length ? value(symbology[at + i]) : NaN;
    radials.push({ azimuthDeg, widthDeg, values });
    at += length + (length % 2);
  }
  return {
    product: expected,
    scanTime,
    position,
    elevationDeg,
    firstGateKm: firstBin * gateKm,
    gateKm,
    radials,
  };
}
