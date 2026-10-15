#!/usr/bin/env node
/** Rebuild the IGN supplement offline: node scripts/build-argentina-dams.mjs.
 * The original WFS response and its checksum live beside the generated pack.
 * Source dates are preserved; a download date is not an observation date.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  parseGeojsonLines,
  featurePoint,
} from '../src/sources/infrastructureData.js';

const PACK = new URL('../src/data/local_data/argentina_dams/', import.meta.url);
const OSM = new URL(
  '../src/data/local_data/dams/dams.geojsonl',
  import.meta.url,
);

function fold(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\b(dique|presa|represa|embalse|dam)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function distance(a, b) {
  const rad = Math.PI / 180;
  const p = ((b.lat - a.lat) * rad) / 2;
  const q = ((b.lon - a.lon) * rad) / 2;
  const h =
    Math.sin(p) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(q) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function contains(ring, point) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, y] = ring[i];
    const [px, py] = ring[j];
    if (
      y > point.lat !== py > point.lat &&
      point.lon < ((px - x) * (point.lat - y)) / (py - y) + x
    )
      inside = !inside;
  }
  return inside;
}

function duplicateOf(feature, candidates) {
  const point = featurePoint(feature);
  const name = fold(feature.properties.name);
  for (const candidate of candidates) {
    const other = featurePoint(candidate);
    if (!other) continue;
    const geometry = candidate.geometry;
    const polygons =
      geometry?.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon'
          ? geometry.coordinates
          : [];
    if (
      polygons.some(
        ([outer, ...holes]) =>
          contains(outer, point) && !holes.some((h) => contains(h, point)),
      )
    )
      return { candidate, reason: 'inside-existing-dam-polygon' };
    const tags = candidate.properties?.tags || {};
    const names = [
      candidate.properties?.name,
      tags.name,
      tags['name:es'],
      tags['name:en'],
      tags.official_name,
    ];
    if (
      name &&
      names.some((n) => fold(n) === name) &&
      distance(point, other) <= 1500
    )
      return { candidate, reason: 'same-name-within-1500m' };
    if (geometry?.type === 'Point' && distance(point, other) <= 5)
      return { candidate, reason: 'coincident-point-within-5m' };
  }
  return null;
}

/** Normalize official points, preserve their source fields, and suppress audited duplicates. */
export function buildSupplement(collection, existing, provenance) {
  if (
    collection?.type !== 'FeatureCollection' ||
    !Array.isArray(collection.features) ||
    collection.features.length !== collection.totalFeatures
  )
    throw new Error('Expected a complete IGN FeatureCollection');
  const features = [];
  const omitted = [];
  const seen = new Set();
  for (const raw of [...collection.features].sort(
    (a, b) => a.properties.gid - b.properties.gid,
  )) {
    const p = raw.properties;
    const coords = raw.geometry?.coordinates;
    if (
      raw.geometry?.type !== 'Point' ||
      !Number.isInteger(p?.gid) ||
      seen.has(p.gid) ||
      coords?.length !== 2 ||
      !coords.every(Number.isFinite) ||
      coords[0] < -74 ||
      coords[0] > -53 ||
      coords[1] < -56 ||
      coords[1] > -21
    )
      throw new Error('Invalid or duplicate IGN dam: ' + raw.id);
    seen.add(p.gid);
    const feature = {
      type: 'Feature',
      id: 'ign-ar-dique-' + p.gid,
      properties: {
        name: p.fna || p.nam || null,
        data_source: 'IGN Argentina · Dique',
        source_layer: 'ign:puntos_de_aguas_continentales_BH051',
        source_feature_id: raw.id,
        source_updated_at: provenance.sourceUpdatedAt,
        retrieved_at: provenance.retrievedAt,
        ign: p,
      },
      geometry: raw.geometry,
    };
    const duplicate = duplicateOf(feature, [...existing, ...features]);
    if (duplicate)
      omitted.push({
        id: feature.id,
        name: feature.properties.name,
        retainedId:
          duplicate.candidate.id ?? duplicate.candidate.properties?.osm_id,
        retainedName: duplicate.candidate.properties?.name || null,
        reason: duplicate.reason,
      });
    else features.push(feature);
  }
  return { features, omitted };
}

async function main() {
  const bytes = await readFile(new URL('source.geojson', PACK));
  const metadata = JSON.parse(
    await readFile(new URL('source.json', PACK), 'utf8'),
  );
  if (
    createHash('sha256').update(bytes).digest('hex') !== metadata.sourceSha256
  )
    throw new Error(
      'IGN snapshot checksum mismatch; review provenance before updating',
    );
  const existing = parseGeojsonLines(await readFile(OSM, 'utf8'));
  const result = buildSupplement(JSON.parse(bytes), existing, metadata);
  await writeFile(
    new URL('dams.geojsonl', PACK),
    result.features.map((f) => JSON.stringify(f)).join('\n') + '\n',
  );
  await writeFile(
    new URL('deduplication.json', PACK),
    JSON.stringify(
      {
        inputCount: metadata.featureCount,
        outputCount: result.features.length,
        existingCount: existing.length,
        omitted: result.omitted,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    'IGN dams: ' +
      metadata.featureCount +
      ' input, ' +
      result.features.length +
      ' additional, ' +
      result.omitted.length +
      ' duplicates suppressed',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
