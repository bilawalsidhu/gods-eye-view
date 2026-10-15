// Inspect encoded headers before allowing the browser to decode local images.
export const MAX_IMPORT_IMAGE_PIXELS = 16 * 1024 * 1024;
const MAX_SIDE = 8192;

/** Width and height from a supported raster header; no image is decoded. */
export function importImageSize(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at, n) => String.fromCharCode(...bytes.subarray(at, at + n));
  const u24 = (at) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
  if (
    bytes.length >= 24 &&
    v.getUint32(0) === 0x89504e47 &&
    ascii(12, 4) === 'IHDR'
  )
    return [v.getUint32(16), v.getUint32(20)];
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(ascii(0, 6)))
    return [v.getUint16(6, true), v.getUint16(8, true)];
  if (bytes.length >= 26 && ascii(0, 2) === 'BM') {
    if (v.getUint32(14, true) === 12)
      return [v.getUint16(18, true), v.getUint16(20, true)];
    return [Math.abs(v.getInt32(18, true)), Math.abs(v.getInt32(22, true))];
  }
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4);
    if (kind === 'VP8X') return [1 + u24(24), 1 + u24(27)];
    if (kind === 'VP8 ' && u24(23) === 0x2a019d)
      return [v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff];
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      const bits = v.getUint32(21, true);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
  }
  if (bytes.length >= 4 && v.getUint16(0) === 0xffd8) {
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at++] !== 0xff) break;
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 1 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = v.getUint16(at);
      if (length < 2 || at + length > bytes.length) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker) &&
        length >= 8
      )
        return [v.getUint16(at + 5), v.getUint16(at + 3)];
      at += length;
    }
  }
  return null;
}

/** Charge each distinct encoded image once against the file's decoded budget. */
export function createImportImageBudget() {
  const seen = new Set();
  let pixels = 0;
  return (key, bytes) => {
    if (seen.has(key)) return;
    const size = importImageSize(bytes);
    if (
      !size ||
      size.some((n) => !Number.isInteger(n) || n <= 0 || n > MAX_SIDE) ||
      pixels + size[0] * size[1] > MAX_IMPORT_IMAGE_PIXELS
    )
      throw new Error(
        'Local images exceed the decoded image limit or have an unreadable header.',
      );
    pixels += size[0] * size[1];
    seen.add(key);
  };
}
