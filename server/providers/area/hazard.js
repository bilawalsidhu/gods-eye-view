import { open } from 'node:fs/promises';

const defaultFile = new URL(
  '../../../output/area-data/v2023_1_pga_475_rock_3min.tif',
  import.meta.url,
);

/** Read a single GEM 2023.1 uncompressed Float64 GeoTIFF sample, without loading 173 MB. */
export async function readGemHazard(
  lat,
  lon,
  file = process.env.GEM_HAZARD_FILE || defaultFile,
) {
  const handle = await open(file, 'r');
  try {
    const read = async (offset, length) => {
      const buffer = Buffer.alloc(length);
      const result = await handle.read(buffer, 0, length, offset);
      if (result.bytesRead !== length) throw new Error('GEM raster incompleto');
      return buffer;
    };
    const header = await read(0, 8);
    if (
      header.toString('ascii', 0, 2) !== 'II' ||
      header.readUInt16LE(2) !== 42
    )
      throw new Error('Formato GEM non supportato');
    const offset = header.readUInt32LE(4),
      count = (await read(offset, 2)).readUInt16LE();
    if (count > 100) throw new Error('Intestazione GEM non valida');
    const entries = await read(offset + 2, count * 12),
      tags = new Map();
    const sizes = { 2: 1, 3: 2, 4: 4, 12: 8 };
    for (let i = 0; i < count; i++) {
      const entry = entries.subarray(i * 12, i * 12 + 12);
      const type = entry.readUInt16LE(2),
        n = entry.readUInt32LE(4),
        size = sizes[type];
      if (!size || n * size > 100000) continue;
      const data =
        n * size <= 4
          ? entry.subarray(8)
          : await read(entry.readUInt32LE(8), n * size);
      const values = Array.from({ length: n }, (_, j) =>
        type === 12
          ? data.readDoubleLE(j * 8)
          : type === 4
            ? data.readUInt32LE(j * 4)
            : type === 3
              ? data.readUInt16LE(j * 2)
              : data[j],
      );
      tags.set(entry.readUInt16LE(0), values);
    }
    const one = (tag) => tags.get(tag)?.[0];
    if (
      one(259) !== 1 ||
      one(258) !== 64 ||
      one(339) !== 3 ||
      one(278) !== 1 ||
      one(277) !== 1
    )
      throw new Error('Codifica GEM non supportata');
    const scale = tags.get(33550),
      tie = tags.get(33922);
    if (!scale || !tie || scale[0] <= 0 || scale[1] <= 0)
      throw new Error('Georeferenziazione GEM assente');
    const x = Math.floor((lon - tie[3]) / scale[0] + tie[0]);
    const y = Math.floor((tie[4] - lat) / scale[1] + tie[1]);
    if (x < 0 || y < 0 || x >= one(256) || y >= one(257)) return null;
    const pga = (await read(tags.get(273)[y] + x * 8, 8)).readDoubleLE();
    return Number.isFinite(pga) && pga >= 0 && pga <= 10
      ? { pga, resolutionDegrees: scale[0] }
      : null;
  } finally {
    await handle.close();
  }
}
