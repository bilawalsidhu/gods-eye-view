// GIF header checks shared by the message-signs proxy (which relays MnDOT's
// rendered sign images) and the browser (which sizes faces from them).

/** Largest image accepted; MnDOT's renderings are about 230-450 x 82-100. */
export const GIF_MAX_WIDTH = 640;
export const GIF_MAX_HEIGHT = 200;
/** Largest body accepted; MnDOT's renderings are 3-12 KB. */
export const GIF_MAX_BYTES = 64 * 1024;

const SIGNATURES = ['GIF87a', 'GIF89a'];

/**
 * The logical screen size of a GIF within the accepted bounds, or null for
 * anything that is not one.
 * @param {Uint8Array} bytes
 * @returns {?{ width: number, height: number }}
 */
export function gifSize(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 13) return null;
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (!SIGNATURES.includes(signature)) return null;
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  if (width < 1 || height < 1) return null;
  if (width > GIF_MAX_WIDTH || height > GIF_MAX_HEIGHT) return null;
  return { width, height };
}
