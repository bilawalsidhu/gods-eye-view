import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { transitFeedCredit } from './dataCredits.js';
import {
  getTransitFeed,
  publicTransitCatalog,
  transitFeedsInRange,
  transitModeFor,
  transitModeResolved,
} from './transitFeeds.js';

// Route ids below are as published in the live feeds and the operators'
// static routes.txt (checked 16 Oct 2026).

test('TransLink feeds are keyless, routable and cover their own city only', () => {
  const seq = getTransitFeed('translink-seq');
  const cairns = getTransitFeed('translink-cairns');
  assert.equal(
    cairns.url,
    'https://gtfsrt.api.translink.com.au/api/realtime/CNS/VehiclePositions',
  );
  for (const feed of [seq, cairns]) {
    assert.equal(feed.headers, undefined, `${feed.id} needs no extra header`);
  }
  for (const feed of [seq, cairns]) {
    assert.equal(feed.license, 'CC BY 4.0');
  }
  const ids = (lat, lon) => transitFeedsInRange(lat, lon).map((f) => f.id);
  assert.deepEqual(ids(-27.4698, 153.0251), ['translink-seq']);
  assert.deepEqual(ids(-16.9186, 145.7781), ['translink-cairns']);
  assert.deepEqual(ids(-37.8136, 144.9631), [], 'Melbourne has no feed');
});

test('TransLink route ids resolve rail, light rail and ferries; buses stay a default', () => {
  const seq = getTransitFeed('translink-seq');
  const cases = [
    ['BRBN-5187', 'rail'],
    ['SHCL-5187', 'rail'],
    ['RPIP-5201', 'rail'],
    ['L1-5029', 'tram'],
    ['F1-4055', 'ferry'],
    ['F23-4055', 'ferry'],
    ['F50-4430', 'ferry'],
    ['SMBI-3779', 'ferry'],
  ];
  for (const [routeId, mode] of cases) {
    assert.equal(transitModeFor(seq, routeId), mode, routeId);
    assert.equal(transitModeResolved(seq, routeId), true, routeId);
  }
  // Buses, Brisbane Metro and the rail-replacement shuttle are buses by the
  // feed default, so movement plausibility does not treat them as known.
  for (const routeId of ['600', '250-5169', 'M1-4949', 'SHUT-5213', null]) {
    assert.equal(transitModeFor(seq, routeId), 'bus', String(routeId));
    assert.equal(transitModeResolved(seq, routeId), false, String(routeId));
  }
  const cairns = getTransitFeed('translink-cairns');
  assert.equal(transitModeFor(cairns, 'C111-5061'), 'bus');
  assert.equal(transitModeResolved(cairns, 'C111-5061'), false);
});

test('Adelaide Metro route ids resolve trains, trams and the SeaLink ferry', () => {
  // The feed entry is main's; this PR adds only its routeMode.
  const adelaide = getTransitFeed('adelaide-metro');
  const cases = [
    ['BEL', 'rail'],
    ['GAWC', 'rail'],
    ['OUTHA', 'rail'],
    ['SEAFRD', 'rail'],
    ['PTDOCK', 'rail'],
    ['BTANIC', 'tram'],
    ['GLNELG', 'tram'],
    ['FESTVL', 'tram'],
    ['SEALNK', 'ferry'],
  ];
  for (const [routeId, mode] of cases) {
    assert.equal(transitModeFor(adelaide, routeId), mode, routeId);
    assert.equal(transitModeResolved(adelaide, routeId), true, routeId);
  }
  // All-letter bus routes exist (INDSTA/INDSTB), so letters alone are not rail.
  for (const routeId of ['100', 'G10', 'H33C', 'INDSTA', 'T721', null]) {
    assert.equal(transitModeFor(adelaide, routeId), 'bus', String(routeId));
    assert.equal(
      transitModeResolved(adelaide, routeId),
      false,
      String(routeId),
    );
  }
});

test('TransLink feeds credit the operator and department as text', () => {
  const credit = (id) =>
    transitFeedCredit(publicTransitCatalog().find((feed) => feed.id === id))
      .html;
  for (const id of ['translink-seq', 'translink-cairns']) {
    assert.match(
      credit(id),
      /^Transit \(Translink, Department of Transport and Main Roads\): <a href="https:\/\/translink\.com\.au\/about-translink\/open-data"[^>]*>CC BY 4\.0<\/a>$/,
    );
  }
});

test('DATA_SOURCES documents the TransLink feeds in the transit row style', () => {
  const rows = readFileSync(
    new URL('../../DATA_SOURCES.md', import.meta.url),
    'utf8',
  ).split('\n');
  const translink = rows.find((line) => line.startsWith('| **TransLink**'));
  assert.match(translink, /South East Queensland and Cairns/);
  assert.match(translink, /open realtime vehicle data/);
  assert.match(
    translink,
    /published for developer use and not against their use/,
  );
  assert.doesNotMatch(translink, /licen[cs]e|CC BY|terms/i);
  // The Rail layer documents Adelaide Metro in a row of its own.
  const adelaide = rows.filter(
    (line) =>
      line.startsWith('| **Adelaide Metro**') && /Transit layer/.test(line),
  );
  assert.equal(
    adelaide.length,
    1,
    'exactly one Adelaide Metro transit row (main’s)',
  );
});
