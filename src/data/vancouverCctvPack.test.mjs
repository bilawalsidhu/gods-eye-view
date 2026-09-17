/**
 * Offline schema checks for the generated Vancouver CCTV source pack.
 *
 * The pack (config/cctv_sources.vancouver.json) is committed data regenerated
 * by scripts/build-vancouver-cctv.mjs from the City of Vancouver traffic-camera
 * KML and page catalogs. These checks keep the artifact honest without network:
 * canonical source shape, unique stable ids, official-origin URL pins,
 * city-bounds coordinates, and cardinal direction-derived headings.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';

const PACK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'config',
  'cctv_sources.vancouver.json',
);
const ORIGIN = 'https://trafficcams.vancouver.ca/';
const CITY = {
  latMin: 49.19787,
  latMax: 49.313479,
  lonMin: -123.27214,
  lonMax: -123.011432,
};
const CARDINALS = Object.freeze({ north: 0, east: 90, south: 180, west: 270 });

function loadPack() {
  return JSON.parse(fs.readFileSync(PACK, 'utf8'));
}

test('Vancouver pack is a non-empty canonical source list', () => {
  const sources = loadPack();
  assert.ok(Array.isArray(sources));
  assert.ok(
    sources.length >= 800,
    `expected a full city pack, got ${sources.length}`,
  );
  for (const source of sources) {
    const normalized = normalizeSourceItem(source);
    assert.equal(
      normalized.id,
      source.id,
      'canonical normalization must pass ids through',
    );
    assert.ok(normalized.id);
    assert.ok(Number.isFinite(normalized.lat), normalized.id);
    assert.ok(Number.isFinite(normalized.lon), normalized.id);
    assert.equal(normalized.city, 'Vancouver', normalized.id);
    assert.equal(normalized.cityId, 'vancouver', normalized.id);
    assert.equal(normalized.feedType, 'image', normalized.id);
    assert.match(normalized.headingConfidence, /^(high|low)$/, normalized.id);
  }
});

test('Vancouver ids are unique, prefixed, and direction-styled', () => {
  const seen = new Set();
  for (const source of loadPack()) {
    assert.ok(!seen.has(source.id), `duplicate id ${source.id}`);
    seen.add(source.id);
    assert.match(
      source.id,
      /^van-[a-z0-9-]+-(north|east|south|west)$/,
      source.id,
    );
  }
});

test('Vancouver frames are pinned to the official traffic-camera origin', () => {
  for (const source of loadPack()) {
    assert.ok(source.url.startsWith(ORIGIN), `${source.id} url ${source.url}`);
    assert.equal(
      source.url,
      source.snapshotUrl,
      `${source.id} snapshot must match url`,
    );
    assert.match(
      source.url,
      /\/cameraimages\/.+\.(jpg|jpeg|png|webp)$/i,
      source.id,
    );
  }
});

test('Vancouver coordinates stay inside the official city bounds', () => {
  for (const source of loadPack()) {
    assert.ok(
      source.lat >= CITY.latMin && source.lat <= CITY.latMax,
      `${source.id} lat ${source.lat}`,
    );
    assert.ok(
      source.lon >= CITY.lonMin && source.lon <= CITY.lonMax,
      `${source.id} lon ${source.lon}`,
    );
  }
});

test('Vancouver headings come from the official direction labels', () => {
  for (const source of loadPack()) {
    const direction = /-(north|east|south|west)$/.exec(source.id)?.[1];
    assert.ok(direction, source.id);
    assert.equal(source.headingDeg, CARDINALS[direction], source.id);
    assert.equal(source.headingConfidence, 'high', source.id);
  }
});
