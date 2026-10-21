#!/usr/bin/env node
/** Build the IGN Argentina admin-2 outline pack. Raw WFS downloads stay in
 * --cache (default: OS temp). Content hashes exclude volatile WFS timestamps.
 * Usage: node scripts/build-argentina-admin.mjs [--cache <directory>]
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  simplifyUnit,
  encodeUnit,
  geojsonPolygons,
} from './lib/admin-pack-geometry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER = path.join(ROOT, 'src/data/local_data/argentina_admin');
export const PARAMS = Object.freeze({
  toleranceFactor: 0.003,
  minToleranceDeg: 0.0001,
  maxToleranceDeg: 0.01,
  decimals: 4,
  minPartKm2: 0.1,
  minPartShare: 0.001,
  minHoleKm2: 0.1,
});

/** Stable content digest: keeps every feature/property/coordinate, sorts the
 * features by official ID, and ignores response timestamps and WFS ordering. */
export function contentHash(collection) {
  const features = [...collection.features].sort((a, b) =>
    String(a.properties.in1).localeCompare(String(b.properties.in1)),
  );
  return createHash('sha256').update(JSON.stringify(features)).digest('hex');
}

/** Simplify the complete source, retaining official names, codes and metadata. */
export function buildPack(departments, provinces, provenance) {
  if (
    departments.features.length !==
      provenance.sources.departments.featureCount ||
    departments.totalFeatures !== departments.features.length ||
    provinces.features.length !== provenance.sources.provinces.featureCount
  )
    throw new Error('Incomplete IGN WFS response');
  const provinceById = new Map(
    provinces.features.map((f) => [f.properties.in1, f.properties]),
  );
  const seen = new Set();
  const features = [...departments.features]
    .sort((a, b) =>
      String(a.properties.in1).localeCompare(String(b.properties.in1)),
    )
    .map((f) => {
      const p = f.properties;
      const province = provinceById.get(p.in1?.slice(0, 2));
      if (
        !/^\d{5}$/.test(p.in1) ||
        seen.has(p.in1) ||
        !province ||
        !p.fna ||
        !p.nam ||
        !['Departamento', 'Partido', 'Comuna'].includes(p.gna)
      )
        throw new Error(`Invalid IGN administrative unit: ${p.in1}`);
      seen.add(p.in1);
      const polygons = geojsonPolygons(f.geometry);
      for (const polygon of polygons)
        for (const ring of polygon)
          for (const point of ring) {
            // The Antarctic source contains -90.00000001; round that floating-point
            // excess to the pole before simplification, without shifting other data.
            if (
              !Number.isFinite(point[0]) ||
              !Number.isFinite(point[1]) ||
              Math.abs(point[0]) > 180 ||
              Math.abs(point[1]) > 90.000001
            )
              throw new Error(`Invalid IGN coordinate: ${p.in1}`);
          }
      const bounded = polygons.map((poly) =>
        poly.map((ring) =>
          ring.map(([lon, lat]) => [lon, Math.max(-90, Math.min(90, lat))]),
        ),
      );
      const unit = simplifyUnit(bounded, PARAMS);
      if (!unit.polygons.length) throw new Error(`Empty outline: ${p.in1}`);
      return {
        id: p.in1,
        name: p.nam,
        full: p.fna,
        type: p.gna,
        region: province.nam,
        regionCode: province.in1,
        sourceFeatureId: f.id,
        sourceProperties: p,
        ...(unit.decimals !== PARAMS.decimals ? { d: unit.decimals } : {}),
        polygons: encodeUnit(unit),
      };
    });
  return {
    meta: { ...provenance, decimals: PARAMS.decimals, curation: PARAMS },
    features,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--cache');
  const cache =
    index < 0 ? path.join(os.tmpdir(), 'gev-argentina-admin') : argv[index + 1];
  if (!cache) throw new Error('--cache needs a directory');
  await mkdir(cache, { recursive: true });
  const provenance = JSON.parse(
    await readFile(path.join(FOLDER, 'source.json'), 'utf8'),
  );
  const collections = {};
  for (const [name, source] of Object.entries(provenance.sources)) {
    const file = path.join(cache, `${name}.geojson`);
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const response = await fetch(source.url);
      if (!response.ok) throw new Error(`IGN ${name}: HTTP ${response.status}`);
      raw = await response.text();
      await writeFile(file, raw);
    }
    const collection = JSON.parse(raw);
    if (contentHash(collection) !== source.contentSha256)
      throw new Error(
        `IGN ${name} changed: review the source and provenance before updating the pin`,
      );
    collections[name] = collection;
  }
  const pack = buildPack(
    collections.departments,
    collections.provinces,
    provenance,
  );
  const output = JSON.stringify(pack) + '\n';
  await writeFile(path.join(FOLDER, 'departments.json'), output);
  console.log(
    `IGN Argentina: ${pack.features.length} outlines, ${Buffer.byteLength(output)} bytes`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
