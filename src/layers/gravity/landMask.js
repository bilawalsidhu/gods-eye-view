/**
 * CSR's 0.25° land mask, as the gravity proxy serves it from
 * /api/gravity/landmask: per row, alternating sea and land run lengths (sea
 * first), LEB128. Row 0 is north and column 0 starts at 180°W.
 */
export const LAND_MASK_SIZE = Object.freeze({ nx: 1440, ny: 720 });

/**
 * Unpack the served runs into one byte per cell, 1 for land. Throws on a
 * payload that does not tile the grid exactly.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function decodeLandMaskRuns(bytes) {
  const { nx, ny } = LAND_MASK_SIZE;
  const mask = new Uint8Array(nx * ny);
  let at = 0;
  let cell = 0;
  for (let row = 0; row < ny; row++) {
    const end = (row + 1) * nx;
    let land = 0;
    while (cell < end) {
      let run = 0;
      for (let shift = 0; ; shift += 7) {
        if (at >= bytes.length || shift > 21)
          throw new Error('Malformed land mask');
        const byte = bytes[at++];
        run |= (byte & 127) << shift;
        if (byte < 128) break;
      }
      if (cell + run > end) throw new Error('Malformed land mask');
      mask.fill(land, cell, cell + run);
      cell += run;
      land ^= 1;
    }
  }
  if (at !== bytes.length) throw new Error('Malformed land mask');
  return mask;
}

/** Whether a position is land in a decoded mask. */
export function landMaskAt(mask, lat, lon) {
  const { nx, ny } = LAND_MASK_SIZE;
  if (!mask || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90) return null;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  const row = Math.min(ny - 1, Math.floor((90 - lat) * 4));
  const col = Math.min(nx - 1, Math.floor((wrapped + 180) * 4));
  return mask[row * nx + col] === 1;
}
