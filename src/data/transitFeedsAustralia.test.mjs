import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { transitFeedCredit } from './dataCredits.js';
import { transitUpstreamHeaders } from './transitProxy.js';
import {
  getTransitFeed,
  publicTransitCatalog,
  transitFeedsInRange,
  transitModeFor,
  transitModeResolved,
} from './transitFeeds.js';

// Route ids below are as published in the live feeds and the operators'
// static routes.txt (checked 16 Oct 2026).

test('Australian feeds are keyless, routable and cover their own city only', () => {
  const seq = getTransitFeed('translink-seq');
  const cairns = getTransitFeed('translink-cairns');
  const adelaide = getTransitFeed('adelaide-metro');
  assert.equal(
    cairns.url,
    'https://gtfsrt.api.translink.com.au/api/realtime/CNS/VehiclePositions',
  );
  assert.equal(
    adelaide.url,
    'https://gtfs.adelaidemetro.com.au/v1/realtime/vehicle_positions',
  );
  for (const feed of [seq, cairns]) {
    assert.equal(feed.headers, undefined, `${feed.id} needs no extra header`);
  }
  for (const feed of [seq, cairns, adelaide]) {
    assert.equal(feed.license, 'CC BY 4.0');
  }
  const ids = (lat, lon) => transitFeedsInRange(lat, lon).map((f) => f.id);
  assert.deepEqual(ids(-27.4698, 153.0251), ['translink-seq']);
  assert.deepEqual(ids(-16.9186, 145.7781), ['translink-cairns']);
  assert.deepEqual(ids(-34.9285, 138.6007), ['adelaide-metro']);
  assert.deepEqual(ids(-37.8136, 144.9631), [], 'Melbourne has no feed');
});

test('Adelaide is asked for its own protobuf type, or its gateway answers base64 JSON', () => {
  // Offered the default Accept list (application/x-protobuf, ..., */*), the
  // Adelaide Metro gateway replies application/json carrying the protobuf as
  // base64, which the decoder rejects. Its own media type gets raw protobuf.
  const adelaide = getTransitFeed('adelaide-metro');
  assert.deepEqual(Object.keys(adelaide.headers), ['Accept']);
  const headers = transitUpstreamHeaders(adelaide);
  assert.equal(headers.Accept, 'application/x-google-protobuf');
  assert.equal(headers['Accept-Encoding'], 'gzip');
  assert.match(headers['User-Agent'], /gods-eye-view/);
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

test('Australian feeds credit the operator and department as text', () => {
  const credit = (id) =>
    transitFeedCredit(publicTransitCatalog().find((feed) => feed.id === id))
      .html;
  for (const id of ['translink-seq', 'translink-cairns']) {
    assert.match(
      credit(id),
      /^Transit \(Translink, Department of Transport and Main Roads\): <a href="https:\/\/translink\.com\.au\/about-translink\/open-data"[^>]*>CC BY 4\.0<\/a>$/,
    );
  }
  assert.match(
    credit('adelaide-metro'),
    /^Transit \(Adelaide Metro – Department for Infrastructure and Transport, South Australia\): <a href="https:\/\/data\.sa\.gov\.au\/[^"]+"[^>]*>CC BY 4\.0<\/a>$/,
  );
});

test('DATA_SOURCES documents the Australian feeds in the transit row style', () => {
  const rows = readFileSync(
    new URL('../../DATA_SOURCES.md', import.meta.url),
    'utf8',
  ).split('\n');
  const translink = rows.find((line) => line.startsWith('| **TransLink**'));
  assert.match(translink, /South East Queensland and Cairns/);
  const adelaide = rows.find((line) => line.startsWith('| **Adelaide Metro**'));
  assert.ok(adelaide, 'Adelaide Metro row exists');
  for (const row of [translink, adelaide]) {
    assert.match(row, /open realtime vehicle data/);
    assert.match(row, /published for developer use and not against their use/);
    assert.doesNotMatch(row, /licen[cs]e|CC BY|terms/i);
  }
});
