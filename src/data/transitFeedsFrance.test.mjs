import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSIT_FEED_REGISTRY,
  TRANSIT_FEED_ID_PATTERN,
  getTransitFeed,
  publicTransitCatalog,
  transitFeedsInRange,
  transitModeFor,
  transitModeResolved,
  transitRouteLabel,
} from './transitFeeds.js';
import { FRANCE_TRANSIT_FEED_ROWS } from './transitFeedsFrance.js';
import { FRANCE_ROUTE_NAMES } from './transitRouteNamesFrance.js';
import {
  TRANSIT_ADMISSION_MAX_GLOBAL,
  TRANSIT_ADMISSION_WINDOW_MS,
  TRANSIT_PROXY_TTL_MS,
} from './transitProxy.js';

const FRANCE_IDS = new Set(FRANCE_TRANSIT_FEED_ROWS.map((row) => row.id));

test('every French row becomes a live feed under its record’s open licence', () => {
  assert.equal(FRANCE_IDS.size, FRANCE_TRANSIT_FEED_ROWS.length);
  for (const row of FRANCE_TRANSIT_FEED_ROWS) {
    assert.match(row.id, TRANSIT_FEED_ID_PATTERN);
    const feed = getTransitFeed(row.id);
    assert.ok(feed, `${row.id} is routable`);
    assert.ok(
      publicTransitCatalog().some((entry) => entry.id === row.id),
      `${row.id} is offered to the browser`,
    );
    assert.ok(
      ['lov2', 'odc-odbl'].includes(row.licence),
      `${row.id} states an open licence`,
    );
    assert.equal(
      feed.license,
      row.licence === 'lov2' ? 'Licence Ouverte 2.0' : 'ODbL',
    );
    assert.equal(
      feed.licenseUrl,
      `https://transport.data.gouv.fr/datasets/${row.record}`,
      `${row.id} links its dataset record`,
    );
    assert.equal(feed.terms.quote, `licence: ${row.licence}`);
    assert.match(
      feed.terms.note,
      /\(\d+ vehicles on 2026-11-13\)/,
      `${row.id} records the day it was seen live`,
    );
    assert.ok(row.vehicles > 0, `${row.id} had vehicles when it was added`);
    assert.ok(
      transitFeedsInRange(row.center.lat, row.center.lon).some(
        (entry) => entry.id === row.id,
      ),
      `${row.id} covers its own centre`,
    );
  }
});

test('no French row repeats a feed that is already registered', () => {
  const seen = new Map();
  for (const feed of TRANSIT_FEED_REGISTRY) {
    const url = new URL(feed.url);
    const key = `${url.origin}${url.pathname.replace(/\/$/, '')}${url.search}`;
    assert.equal(
      seen.has(key),
      false,
      `${feed.id} and ${seen.get(key)} fetch the same upstream`,
    );
    seen.set(key, feed.id);
  }
  // The networks that were already here through the operator's own endpoint
  // stay single: no French row points at a dataset record one of them cites.
  const earlier = TRANSIT_FEED_REGISTRY.filter(
    (feed) => !FRANCE_IDS.has(feed.id),
  );
  for (const id of [
    'tbm-bordeaux',
    'tam-montpellier',
    'astuce-rouen',
    'mpm-toulon',
    'lia-le-havre',
    'filbleu-tours',
  ]) {
    assert.ok(earlier.some((feed) => feed.id === id));
  }
  const earlierRecords = new Set(earlier.map((feed) => feed.licenseUrl));
  for (const row of FRANCE_TRANSIT_FEED_ROWS) {
    assert.equal(
      earlierRecords.has(getTransitFeed(row.id).licenseUrl),
      false,
      `${row.id} is not a second copy of an earlier feed`,
    );
  }
});

test('one viewpoint never asks for more feeds than the proxy admits', () => {
  // The browser polls each in-range feed once per proxy TTL, and the proxy
  // admits a fixed number of upstream requests a minute across all feeds.
  const pollsPerFeed = TRANSIT_ADMISSION_WINDOW_MS / TRANSIT_PROXY_TTL_MS;
  for (const feed of TRANSIT_FEED_REGISTRY) {
    const inRange = transitFeedsInRange(feed.center.lat, feed.center.lon);
    assert.ok(
      inRange.length * pollsPerFeed <= TRANSIT_ADMISSION_MAX_GLOBAL,
      `${inRange.length} feeds overlap at ${feed.id}`,
    );
  }
});

test('French trams and boats take their mode; every other route stays a default', () => {
  const cases = [
    ['divia-dijon', '4-T1', 'tram'],
    ['bibus-brest', 'A', 'tram'],
    ['setram-le-mans', 'T2', 'tram'],
    ['lignes-dazur-nice', 'L2', 'tram'],
    ['irigo-angers', 'C', 'tram'],
    ['orizo-avignon', 'T1', 'tram'],
    ['transvilles-valenciennes', 'NAVINEO:Line::190:LOC', 'tram'],
    ['aleop-pays-de-la-loire', 'YEU', 'ferry'],
    ['martinique-sud', '4001', 'ferry'],
  ];
  for (const [id, routeId, mode] of cases) {
    const feed = getTransitFeed(id);
    assert.equal(transitModeFor(feed, routeId), mode, `${id} ${routeId}`);
    assert.equal(transitModeResolved(feed, routeId), true);
    assert.equal(transitModeFor(feed, 'no-such-route'), 'bus');
    assert.equal(
      transitModeResolved(feed, 'no-such-route'),
      false,
      `${id} defaults rather than resolves an unlisted route`,
    );
  }
  const busOnly = getTransitFeed('ametis-amiens');
  assert.equal(transitModeFor(busOnly, '7'), 'bus');
  assert.equal(transitModeResolved(busOnly, '7'), false);
});

test('French feeds that publish km/h are marked for conversion, and only those', () => {
  assert.deepEqual(
    FRANCE_TRANSIT_FEED_ROWS.filter((row) => row.speedUnit === 'km/h')
      .map((row) => row.id)
      .sort(),
    [
      'azalys-blois',
      'divia-dijon',
      'maelis-montlucon',
      'rubis-bourg-en-bresse',
      'setram-le-mans',
    ],
  );
  for (const row of FRANCE_TRANSIT_FEED_ROWS.filter((r) => r.speedUnit)) {
    assert.match(getTransitFeed(row.id).terms.note, /Speeds are km\/h/);
  }
});

test('French route-name tables belong to registered feeds and never blank a line', () => {
  for (const [id, names] of Object.entries(FRANCE_ROUTE_NAMES)) {
    assert.ok(FRANCE_IDS.has(id), `${id} is a registered French feed`);
    const feed = getTransitFeed(id);
    for (const [routeId, name] of Object.entries(names)) {
      assert.ok(typeof name === 'string' && name.trim() === name && name);
      assert.notEqual(name, routeId, `${id} ${routeId} is not a no-op`);
      assert.equal(transitRouteLabel(feed, routeId), name);
    }
    assert.equal(transitRouteLabel(feed, 'no-such-route'), 'no-such-route');
    assert.equal(transitRouteLabel(feed, null), null);
  }
  assert.equal(transitRouteLabel(getTransitFeed('divia-dijon'), '4-T1'), 'T1');
  assert.equal(
    transitRouteLabel(
      getTransitFeed('transvilles-valenciennes'),
      'NAVINEO:Line::190:LOC',
    ),
    'T1',
  );
  // A feed whose ids already read as the line has no table and is left alone.
  assert.equal(transitRouteLabel(getTransitFeed('ametis-amiens'), '7'), '7');
});

test('every French feed is documented with its licence', () => {
  const lines = readFileSync(
    new URL('../../DATA_SOURCES.md', import.meta.url),
    'utf8',
  ).split('\n');
  for (const row of FRANCE_TRANSIT_FEED_ROWS) {
    const feed = getTransitFeed(row.id);
    const line = lines.find((l) => l.startsWith(`| **${feed.name}** `));
    assert.ok(line, `${feed.name} has a DATA_SOURCES row`);
    assert.ok(
      line.includes(feed.licenseUrl),
      `${feed.name} row links its record`,
    );
    assert.ok(
      line.includes(feed.license),
      `${feed.name} row names its licence`,
    );
  }
});
