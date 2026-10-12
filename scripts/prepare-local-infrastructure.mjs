import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DATASET_IDS = Object.freeze([
  'eia-plants',
  'osm-ga-sites',
  'osm-ga-mapped-plants',
  'osm-ga-substations',
  'osm-ga-telecom',
]);

/** Pack operator-supplied public records into bounded two-degree local tiles. */
export function packInfrastructure(records) {
  if (!Array.isArray(records) || records.length > 100000)
    throw new Error('Provide at most 100,000 normalized public records');
  const tiles = new Map();
  for (const row of records) {
    if (
      !row ||
      !Number.isFinite(row.lat) ||
      !Number.isFinite(row.lon) ||
      Math.abs(row.lat) > 90 ||
      Math.abs(row.lon) > 180
    )
      throw new Error('Every record needs finite latitude/longitude');
    if (
      typeof row.id !== 'string' ||
      !row.id ||
      row.id.length > 150 ||
      typeof row.name !== 'string' ||
      row.name.length > 250
    )
      throw new Error('Every record needs bounded id/name strings');
    const south = Math.min(88, Math.floor(row.lat / 2) * 2),
      west = Math.min(178, Math.floor(row.lon / 2) * 2);
    const tile = `tile_${south}_${west}`;
    if (!tiles.has(tile))
      tiles.set(tile, {
        tile,
        south,
        north: south + 2,
        west,
        east: west + 2,
        rows: [],
      });
    // Keep source-reported fields distinct. No operator/carrier/technology inference.
    tiles.get(tile).rows.push({ ...row });
  }
  const index = {
    tiles: [...tiles.values()].map(({ rows, ...tile }) => ({
      ...tile,
      count: rows.length,
      lat: tile.south + 1,
      lon: tile.west + 1,
    })),
  };
  return { index, tiles };
}

/** Write an ignored local pack after validating all input; never downloads data. */
export async function prepareLocalInfrastructure({
  input,
  dataset,
  outputRoot = 'public/infrastructure',
}) {
  if (!DATASET_IDS.includes(dataset))
    throw new Error('Choose a documented dataset id');
  const stat = await fs.stat(input);
  if (stat.size > 32 * 1024 * 1024) throw new Error('Input exceeds 32 MiB');
  const records = JSON.parse(await fs.readFile(input, 'utf8'));
  const packed = packInfrastructure(records);
  const target = path.resolve(outputRoot, dataset);
  await fs.mkdir(target, { recursive: true });
  for (const tile of packed.tiles.values())
    await fs.writeFile(
      path.join(target, `${tile.tile}.json`),
      JSON.stringify(tile.rows),
    );
  await fs.writeFile(
    path.join(target, 'index.json'),
    JSON.stringify(packed.index),
  );
  return { records: records.length, tiles: packed.tiles.size };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const value = (flag) => process.argv[process.argv.indexOf(flag) + 1];
  if (
    !process.argv.includes('--input') ||
    !process.argv.includes('--dataset')
  ) {
    console.error(
      'Usage: node scripts/prepare-local-infrastructure.mjs --input public-records.json --dataset <id>',
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(
        JSON.stringify(
          await prepareLocalInfrastructure({
            input: value('--input'),
            dataset: value('--dataset'),
          }),
        ),
      );
    } catch {
      console.error(
        'Could not prepare the local pack; check the documented input schema and permissions.',
      );
      process.exitCode = 1;
    }
  }
}
