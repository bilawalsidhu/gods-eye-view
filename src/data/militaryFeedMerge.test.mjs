// Military layer coverage (field report 2026-09-01: a low pass showed on neither
// the commercial nor the military layer). `/api/adsblol/mil` now fans out to
// adsb.lol + adsb.fi and merges by hex, so a contact one volunteer network
// misses — or has just dropped — is held by the other. `mergeMilitaryFeeds`
// takes any number of feeds, so some cases below exercise a third.
// Pure-function tests of the merge, no network.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMilitaryFeeds, militaryRowPositionAgeSeconds } from '../../vite.config.js';

const row = (hex, extra = {}) => ({ hex, lat: 51.5, lon: -0.1, seen_pos: 1, ...extra });
const feed = (source, ac, extra = {}) => ({ source, ok: true, body: { ac, now: 1_700_000_000, ...extra } });

test('militaryRowPositionAgeSeconds: seen_pos wins, seen is the fallback, no position is infinite', () => {
  assert.equal(militaryRowPositionAgeSeconds({ lat: 1, lon: 2, seen_pos: 4, seen: 90 }), 4);
  assert.equal(militaryRowPositionAgeSeconds({ lat: 1, lon: 2, seen: 12 }), 12, 'falls back to seen');
  assert.equal(militaryRowPositionAgeSeconds({ lat: 1, lon: 2 }), Infinity, 'positioned but no age');
  assert.equal(militaryRowPositionAgeSeconds({ seen_pos: 3 }), Infinity, 'no lat/lon → unpositioned');
  assert.equal(militaryRowPositionAgeSeconds({ lat: 1, lon: 2, seen_pos: -5 }), 0, 'negative age clamps to 0');
  assert.equal(militaryRowPositionAgeSeconds(null), Infinity);
});

test('feeds are unioned and de-duplicated by hex, case-insensitively', () => {
  const merged = mergeMilitaryFeeds([
    feed('adsb.lol', [row('AE1234'), row('43C6DB')]),
    feed('adsb.fi', [row('ae1234'), row('4CA7B2')]),
    feed('extra-feed', [row('4ca7b2')]),
  ]);
  const hexes = merged.ac.map((a) => a.hex.toLowerCase()).sort();
  assert.deepEqual(hexes, ['43c6db', '4ca7b2', 'ae1234']);
  assert.equal(merged.total, 3);
  assert.deepEqual(merged.sources, ['adsb.lol', 'adsb.fi', 'extra-feed']);
  assert.match(merged.msg, /^merged: adsb\.lol, adsb\.fi, extra-feed$/);
});

test('on a duplicate hex the fresher position wins', () => {
  const merged = mergeMilitaryFeeds([
    feed('adsb.lol', [row('AE1', { seen_pos: 40, gs: 111 })]),
    feed('adsb.fi', [row('ae1', { seen_pos: 2, gs: 420 })]),
  ]);
  assert.equal(merged.ac.length, 1);
  assert.equal(merged.ac[0].gs, 420, 'kept the 2s-old row, not the 40s-old one');
});

test('a positioned row beats an unpositioned duplicate even with a worse seen_pos', () => {
  const merged = mergeMilitaryFeeds([
    feed('adsb.lol', [{ hex: 'AE2', seen_pos: 0.1, gs: 5 }]),          // no lat/lon
    feed('adsb.fi', [row('ae2', { seen_pos: 30, gs: 300 })]),         // positioned
  ]);
  assert.equal(merged.ac[0].gs, 300);
});

test('feed order breaks exact ties — adsb.lol stays authoritative', () => {
  const merged = mergeMilitaryFeeds([
    feed('adsb.lol', [row('AE3', { seen_pos: 3, r: 'from-lol' })]),
    feed('adsb.fi', [row('ae3', { seen_pos: 3, r: 'from-fi' })]),
  ]);
  assert.equal(merged.ac[0].r, 'from-lol');
});

test('a failed, timed-out, or malformed feed is skipped without sinking the rest', () => {
  const merged = mergeMilitaryFeeds([
    { source: 'adsb.lol', ok: false, body: null },
    { source: 'adsb.fi', ok: true, body: { ac: [row('AE4')] } },
    { source: 'extra-feed', ok: true, body: { ac: 'not-an-array' } },
    null,
  ]);
  assert.equal(merged.ac.length, 1);
  assert.deepEqual(merged.sources, ['adsb.fi'], 'only the feed that delivered rows is credited');
});

test('every feed down → an empty, honestly-labelled envelope with a sane clock', () => {
  const before = Math.floor(Date.now() / 1000);
  const merged = mergeMilitaryFeeds([
    { source: 'adsb.lol', ok: false, body: null },
    { source: 'adsb.fi', ok: false, body: null },
  ]);
  assert.deepEqual(merged.ac, []);
  assert.equal(merged.total, 0);
  assert.deepEqual(merged.sources, []);
  assert.equal(merged.msg, 'no military feed reachable');
  assert.ok(merged.now >= before && merged.now <= Math.floor(Date.now() / 1000) + 1);
});

test('rows without a usable hex are dropped', () => {
  const merged = mergeMilitaryFeeds([
    feed('adsb.lol', [row('AE5'), { hex: '' }, { hex: '   ' }, { lat: 1, lon: 2 }, null]),
  ]);
  assert.equal(merged.ac.length, 1);
  assert.equal(merged.ac[0].hex, 'AE5');
});

test('non-array input is inert', () => {
  const merged = mergeMilitaryFeeds(undefined);
  assert.deepEqual(merged.ac, []);
  assert.equal(merged.msg, 'no military feed reachable');
});
