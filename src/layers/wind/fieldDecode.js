/** Split a headerless little-endian Float32 grid body into its components. */
export function decodeFieldGrid(grid, bytes, components = 2) {
  const count = grid.nx * grid.ny;
  if (bytes.byteLength !== count * 4 * components)
    throw new Error('Malformed wind grid');
  const aligned =
    bytes.byteOffset % 4 === 0
      ? new Float32Array(bytes.buffer, bytes.byteOffset, count * components)
      : new Float32Array(bytes.slice().buffer);
  if (!aligned.every(Number.isFinite)) throw new Error('Malformed wind grid');
  return Array.from({ length: components }, (_, i) =>
    aligned.slice(i * count, (i + 1) * count),
  );
}
