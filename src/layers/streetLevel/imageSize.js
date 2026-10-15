/**
 * An image's pixel size read from its header, before anything decodes it:
 * a picture host can serve a small file that declares enormous dimensions,
 * and a decode of it alone can take the tab (or the GPU process) down.
 * JPEG (SOFn), PNG (IHDR), WebP (VP8, VP8L, VP8X) and GIF; null for any
 * other format, or a header this does not reach.
 * @param {Uint8Array} bytes   The start of the file (a JPEG's EXIF can push its SOF past 64 kB).
 * @returns {{width: number, height: number}|null}
 */
export function imageSize(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const b = bytes;
  const be16 = (i) => (b[i] << 8) | b[i + 1];
  const le16 = (i) => b[i] | (b[i + 1] << 8);
  const le24 = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const ascii = (i, text) =>
    [...text].every((char, k) => b[i + k] === char.charCodeAt(0));
  // JPEG: walk the markers to the first start-of-frame.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      // Fill bytes, and markers with no length.
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      const isFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isFrame) return { width: be16(i + 7), height: be16(i + 5) };
      i += 2 + be16(i + 2);
    }
    return null;
  }
  // PNG: IHDR is the first chunk.
  if (b[0] === 0x89 && ascii(1, 'PNG') && ascii(12, 'IHDR')) {
    const u32 = (i) =>
      ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    return { width: u32(16), height: u32(20) };
  }
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP') && b.length >= 30) {
    if (ascii(12, 'VP8 '))
      return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (ascii(12, 'VP8L'))
      return {
        width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
        height:
          1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
      };
    if (ascii(12, 'VP8X')) return { width: 1 + le24(24), height: 1 + le24(27) };
    return null;
  }
  if (ascii(0, 'GIF8')) return { width: le16(6), height: le16(8) };
  return null;
}
