/** Build a synthetic UTFGrid with logical cell counts and repeated hit pixels. */
export function syntheticGrid({
  z = 2,
  x = 1,
  y = 1,
  cells = [
    { row: 1, column: 51, count: 6, iconic: 3 },
    { row: 3, column: 49, count: 12, iconic: 47170 },
  ],
} = {}) {
  const pixels = Array.from({ length: 64 }, () => Array(64).fill(' '));
  const keys = [''];
  const data = {};
  cells.forEach((cell, index) => {
    const key = String(900_000_000 + index);
    keys.push(key);
    const value = index + 1;
    let code = value + 32;
    if (code >= 34) code += 1;
    if (code >= 92) code += 1;
    const character = String.fromCharCode(code);
    for (const [row, column] of [
      [cell.row, cell.column],
      [cell.row - 1, cell.column],
      [cell.row + 1, cell.column],
      [cell.row, cell.column - 1],
      [cell.row, cell.column + 1],
    ]) {
      if (row >= 0 && row < 64 && column >= 0 && column < 64)
        pixels[row][column] = character;
    }
    data[key] = {
      captive: null,
      cellCount: cell.count,
      geoprivacy: null,
      id: Number(key),
      latitude:
        (Math.atan(
          Math.sinh(Math.PI * (1 - 2 * ((y + cell.row / 64) / 2 ** z))),
        ) *
          180) /
        Math.PI,
      longitude: ((x + cell.column / 64) / 2 ** z) * 360 - 180,
      private_location: null,
      quality_grade: 'needs_id',
      'taxon.iconic_taxon_id': cell.iconic,
      uuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    };
  });
  return { grid: pixels.map((row) => row.join('')), keys, data };
}
