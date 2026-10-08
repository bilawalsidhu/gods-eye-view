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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import { loadVancouverSourcesFromCatalog } from '../../server/providers/cctv/sources.js';
import { shouldWriteCatalog } from '../../scripts/build-vancouver-cctv.mjs';
import { allocateSourceCap } from '../../server/providers/cctv/cap.js';
import {
  DEFAULT_VANCOUVER_MAX_SOURCES,
  CCTV_MAX_SOURCES_CEILING,
} from '../../server/providers/cctv/constants.js';

const PACK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'config',
  'cctv_sources.vancouver.json',
);
// Repo root so the live loader resolves config/cctv_sources.vancouver.json from
// the same path depth the CITY_POIS seeds in src/data use.
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
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

test('Vancouver loads as a default live pack, trimmed to the DEFAULT_VANCOUVER_MAX_SOURCES cap', (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const saved = process.env.CCTV_VANCOUVER_SOURCES_FILE;
  const savedMax = process.env.CCTV_VANCOUVER_MAX_SOURCES;
  try {
    // No override env: the loader reads the shipped DEFAULT_VANCOUVER_SOURCE_FILE
    // and trims to DEFAULT_VANCOUVER_MAX_SOURCES (nearest-downtown first).
    delete process.env.CCTV_VANCOUVER_SOURCES_FILE;
    delete process.env.CCTV_VANCOUVER_MAX_SOURCES;
    const raw = loadPack();
    const cameras = loadVancouverSourcesFromCatalog({ sourceRoot: REPO_ROOT });
    assert.equal(
      cameras.length,
      Math.min(raw.length, DEFAULT_VANCOUVER_MAX_SOURCES),
      'the live loader trims to the measured per-pack cap (nearest-downtown first)',
    );
    assert.ok(
      raw.length > DEFAULT_VANCOUVER_MAX_SOURCES,
      'the shipped Vancouver pack exceeds the default cap',
    );
    assert.ok(
      cameras.every((c) => c.city === 'Vancouver'),
      'every camera is Vancouver',
    );
    assert.ok(
      cameras.every((c) => c.url.startsWith(ORIGIN)),
      'every frame stays on the official origin',
    );
    assert.equal(
      cameras[0].snapshotUrl,
      cameras[0].url,
      'snapshot mirrors the frame url',
    );
    assert.ok(
      cameras.every((c) => c.poseSource === 'curated'),
      'poses are curated',
    );
    assert.deepEqual(
      cameras.map((c) => c.id),
      [...new Set(cameras.map((c) => c.id))],
      'ids are unique',
    );
  } finally {
    if (saved === undefined) delete process.env.CCTV_VANCOUVER_SOURCES_FILE;
    else process.env.CCTV_VANCOUVER_SOURCES_FILE = saved;
    if (savedMax === undefined) delete process.env.CCTV_VANCOUVER_MAX_SOURCES;
    else process.env.CCTV_VANCOUVER_MAX_SOURCES = savedMax;
  }
});

test('Vancouver ships a measured default cap that the catalog invariant counts', () => {
  // Mirrors Austin/Tallinn/Calgary/etc.: a NEW pack must export a default cap so
  // #644's catalog-invariant discovery (sum of DEFAULT_<PACK>_MAX_SOURCES <=
  // CCTV_MAX_SOURCES_CEILING) counts it instead of silently adding ~830 cameras.
  assert.equal(
    typeof DEFAULT_VANCOUVER_MAX_SOURCES,
    'number',
    'DEFAULT_VANCOUVER_MAX_SOURCES is exported as a measured number',
  );
  assert.ok(DEFAULT_VANCOUVER_MAX_SOURCES > 0, 'the default cap is positive');
  assert.ok(
    DEFAULT_VANCOUVER_MAX_SOURCES <= CCTV_MAX_SOURCES_CEILING,
    'the Vancouver cap fits inside the catalog ceiling',
  );
  assert.ok(
    DEFAULT_VANCOUVER_MAX_SOURCES < loadPack().length,
    'the default cap trims the shipped Vancouver pack (bounded-pack contract)',
  );
});

test('Vancouver loader honors CCTV_VANCOUVER_MAX_SOURCES within the ceiling', (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const saved = process.env.CCTV_VANCOUVER_SOURCES_FILE;
  const savedMax = process.env.CCTV_VANCOUVER_MAX_SOURCES;
  try {
    delete process.env.CCTV_VANCOUVER_SOURCES_FILE;
    const raw = loadPack();
    // A cap below the default trims more aggressively (nearest downtown kept).
    process.env.CCTV_VANCOUVER_MAX_SOURCES = '50';
    const few = loadVancouverSourcesFromCatalog({ sourceRoot: REPO_ROOT });
    assert.equal(few.length, 50, 'env cap is honored below the default');
    // A cap above the shipped pack serves the whole catalog (clamped by ceiling).
    process.env.CCTV_VANCOUVER_MAX_SOURCES = String(raw.length + 9999);
    const full = loadVancouverSourcesFromCatalog({ sourceRoot: REPO_ROOT });
    assert.equal(
      full.length,
      raw.length,
      'a raised env cap serves the full shipped pack',
    );
  } finally {
    if (saved === undefined) delete process.env.CCTV_VANCOUVER_SOURCES_FILE;
    else process.env.CCTV_VANCOUVER_SOURCES_FILE = saved;
    if (savedMax === undefined) delete process.env.CCTV_VANCOUVER_MAX_SOURCES;
    else process.env.CCTV_VANCOUVER_MAX_SOURCES = savedMax;
  }
});

test('Vancouver loader fails closed: a missing/unreadable file returns [] without throwing', (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const saved = process.env.CCTV_VANCOUVER_SOURCES_FILE;
  try {
    process.env.CCTV_VANCOUVER_SOURCES_FILE = '/nonexistent/gev-vancouver.json';
    // A broken Vancouver pack must not reject the whole refresh — catalog.js
    // wraps each LIVE_PACK in allSettled, so this [] keeps peer regions alive.
    assert.doesNotThrow(() =>
      loadVancouverSourcesFromCatalog({ sourceRoot: REPO_ROOT }),
    );
    assert.deepEqual(
      loadVancouverSourcesFromCatalog({ sourceRoot: REPO_ROOT }),
      [],
    );
  } finally {
    if (saved === undefined) delete process.env.CCTV_VANCOUVER_SOURCES_FILE;
    else process.env.CCTV_VANCOUVER_SOURCES_FILE = saved;
  }
});

test('incomplete generator acquisition preserves the existing catalog', () => {
  assert.equal(
    shouldWriteCatalog({
      failedPages: 1,
      pagesWithCameras: 200,
      sourceCount: 800,
      outExists: true,
    }),
    false,
  );
  assert.equal(
    shouldWriteCatalog({
      failedPages: 0,
      pagesWithCameras: 0,
      sourceCount: 0,
      outExists: true,
    }),
    false,
  );
  assert.equal(
    shouldWriteCatalog({
      failedPages: 0,
      pagesWithCameras: 218,
      sourceCount: 830,
      outExists: true,
    }),
    true,
  );
});

test('Vancouver loader skips malformed rows and off-host URLs', (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-van-bad-'));
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(
    path.join(dir, 'config', 'cctv_sources.vancouver.json'),
    JSON.stringify([
      null,
      {
        id: 'van-offhost',
        url: 'https://evil.example/x.jpg',
        snapshotUrl: 'https://evil.example/x.jpg',
        lat: 49.28,
        lon: -123.12,
        headingDeg: 90,
        headingConfidence: 'high',
        feedType: 'image',
        sourceKind: 'vancouver-open-data',
        city: 'Vancouver',
        cityId: 'vancouver',
        provider: 'City of Vancouver Traffic Cams',
        license: 'x',
      },
      {
        id: 'van-bad-coords',
        url: 'https://trafficcams.vancouver.ca/cameraimages/a.jpg',
        snapshotUrl: 'https://trafficcams.vancouver.ca/cameraimages/a.jpg',
        lat: 'not-a-number',
        lon: -123.12,
        headingDeg: 180,
        headingConfidence: 'high',
        feedType: 'image',
        sourceKind: 'vancouver-open-data',
        city: 'Vancouver',
        cityId: 'vancouver',
        provider: 'City of Vancouver Traffic Cams',
        license: 'x',
      },
      {
        id: 'van-ok-south',
        url: 'https://trafficcams.vancouver.ca/cameraimages/a.jpg',
        snapshotUrl: 'https://trafficcams.vancouver.ca/cameraimages/a.jpg',
        lat: 49.28,
        lon: -123.12,
        headingDeg: 180,
        headingConfidence: 'high',
        feedType: 'image',
        sourceKind: 'vancouver-open-data',
        city: 'Vancouver',
        cityId: 'vancouver',
        provider: 'City of Vancouver Traffic Cams',
        license: 'x',
        poseSource: 'curated',
      },
    ]),
  );
  const saved = process.env.CCTV_VANCOUVER_SOURCES_FILE;
  try {
    process.env.CCTV_VANCOUVER_SOURCES_FILE = path.join(
      dir,
      'config',
      'cctv_sources.vancouver.json',
    );
    const cameras = loadVancouverSourcesFromCatalog({ sourceRoot: REPO_ROOT });
    assert.deepEqual(
      cameras.map((c) => c.id),
      ['van-ok-south'],
    );
    assert.equal(
      cameras[0].poseSource,
      'curated',
      'curated flag survives the loader',
    );
  } finally {
    if (saved === undefined) delete process.env.CCTV_VANCOUVER_SOURCES_FILE;
    else process.env.CCTV_VANCOUVER_SOURCES_FILE = saved;
  }
});

test('Vancouver shares the global catalog cap with other packs (round-robin, no silent eviction)', () => {
  // Proves Vancouver + another pack coexist in the served catalog: the fair
  // cap thins BOTH instead of evicting whichever pack was appended last.
  const pack = (name, count) => ({
    name,
    sources: Array.from({ length: count }, (_, i) => ({
      id: `${name}-${i}`,
      rank: i,
    })),
  });
  const { sources, packs } = allocateSourceCap(
    [pack('austin', 250), pack('vancouver', 830)],
    40,
  );
  assert.equal(sources.length, 40, 'the cap is honored');
  assert.ok(
    sources.some((s) => s.id.startsWith('vancouver-')),
    'Vancouver is served when Austin is also present',
  );
  assert.ok(
    sources.some((s) => s.id.startsWith('austin-')),
    'Austin is served when Vancouver is also present',
  );
  const byName = Object.fromEntries(packs.map((p) => [p.name, p]));
  assert.ok(byName.austin.kept > 0, 'Austin keeps its share');
  assert.ok(byName.vancouver.kept > 0, 'Vancouver keeps its share');
  assert.equal(byName.austin.kept + byName.vancouver.kept, 40);
});

test('the Vancouver LIVE_PACKS entry is enabled by default, off only via CCTV_VANCOUVER_ENABLED=0', () => {
  // Vancouver's enabled() gate in server/providers/cctv/catalog.js uses the
  // same envEnabled() predicate as the eight regional packs (tfl/ontario/
  // fintraffic/drivebc/txdot/tallinn/tarktee/warendorf/calgary). Lock the
  // convention so Vancouver can never be silently dropped and can't blank peers.
  const envEnabled = (name) => String(process.env[name] || '1').trim() !== '0';
  const saved = process.env.CCTV_VANCOUVER_ENABLED;
  try {
    delete process.env.CCTV_VANCOUVER_ENABLED;
    assert.equal(envEnabled('CCTV_VANCOUVER_ENABLED'), true, 'default-on');
    process.env.CCTV_VANCOUVER_ENABLED = '0';
    assert.equal(envEnabled('CCTV_VANCOUVER_ENABLED'), false, "off via '0'");
    process.env.CCTV_VANCOUVER_ENABLED = '1';
    assert.equal(envEnabled('CCTV_VANCOUVER_ENABLED'), true, "on via '1'");
  } finally {
    if (saved === undefined) delete process.env.CCTV_VANCOUVER_ENABLED;
    else process.env.CCTV_VANCOUVER_ENABLED = saved;
  }
});
