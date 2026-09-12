import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateByGantry, gantriesInBox, isCodedName, speedBand } from './ndwGantries.js';

const sites = new Map([
  ['a1', { lat: 51.9244, lon: 4.3579, name: '00D01001D404D007000B' }],
  ['a2', { lat: 51.9244, lon: 4.3579, name: 'N470 km 8.949 Re' }],
  ['b1', { lat: 52.0039, lon: 4.3856, name: '00D01001A45AD0050009' }],
]);
const m = (siteId, speedKph, flowVph = 600) => ({ siteId, speedKph, flowVph, lanes: 1, at: 'T' });

test('sensors sharing a mast fold into one point', () => {
  // Measured on the A20 at Kethelplein: fourteen sites, one coordinate.
  const out = aggregateByGantry([m('a1', 89), m('a2', 120), m('b1', 103)], sites);
  assert.equal(out.length, 2);
  assert.equal(out.find((g) => g.lat === 51.9244).sensors, 2);
});

test('the slowest lane decides the colour, not the average', () => {
  // 89 and 120 average to 104, which would paint a blocked lane as free.
  const g = aggregateByGantry([m('a1', 12), m('a2', 120)], sites)[0];
  assert.equal(g.slowestKph, 12);
  assert.equal(g.fastestKph, 120);
  assert.equal(g.band, 'jam');
});

test('flow is summed over the sensors that reported it', () => {
  const g = aggregateByGantry([m('a1', 90, 2520), m('a2', 95, 1860)], sites)[0];
  assert.equal(g.flowVph, 4380);
});

test('a human road name wins over a machine code at the same mast', () => {
  const g = aggregateByGantry([m('a1', 90), m('a2', 95)], sites)[0];
  assert.equal(g.name, 'N470 km 8.949 Re');
  // …and the order it arrives in must not change that.
  const reversed = aggregateByGantry([m('a2', 95), m('a1', 90)], sites)[0];
  assert.equal(reversed.name, 'N470 km 8.949 Re');
});

test('a MONICA code is recognised as a code and a road name is not', () => {
  assert.equal(isCodedName('00D01001D404D007000B'), true);
  assert.equal(isCodedName('N470 km 8.949 Re'), false);
  assert.equal(isCodedName('Boterdorpseweg N472'), false);
  assert.equal(isCodedName(''), false);
});

test('a measurement without a speed or without a site is dropped', () => {
  assert.equal(aggregateByGantry([m('a1', null)], sites).length, 0);
  assert.equal(aggregateByGantry([m('unknown-site', 90)], sites).length, 0);
});

test('bands are bounded at both ends', () => {
  assert.equal(speedBand(24), 'jam');
  assert.equal(speedBand(25), 'slow');
  assert.equal(speedBand(49), 'slow');
  assert.equal(speedBand(50), 'busy');
  assert.equal(speedBand(79), 'busy');
  assert.equal(speedBand(80), 'flowing');
});

test('a site that measured nothing gets no band rather than a free-flowing one', () => {
  assert.equal(speedBand(null), null);
  assert.equal(speedBand(-1), null);
  assert.equal(speedBand(NaN), null);
});

test('the box keeps what is inside it and rejects what is outside', () => {
  const all = aggregateByGantry([m('a1', 90), m('b1', 100)], sites);
  const box = { south: 51.92, west: 4.35, north: 51.93, east: 4.36 };
  const kept = gantriesInBox(all, box);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].lat, 51.9244);
  assert.equal(gantriesInBox(all, { south: 0, west: 0, north: 1, east: 1 }).length, 0);
  assert.equal(gantriesInBox(all, null).length, 0);
});

test('over the cap the centre of the view wins, not the feed order', () => {
  const far = { key: 'f', lat: 52.0, lon: 5.0, name: '', slowestKph: 90 };
  const near = { key: 'n', lat: 52.5, lon: 5.0, name: '', slowestKph: 90 };
  const box = { south: 52.4, west: 4.9, north: 52.6, east: 5.1 };
  // `far` is first in the array but outside the box; only `near` survives.
  assert.deepEqual(gantriesInBox([far, near], box, 1).map((g) => g.key), ['n']);
  const wide = { south: 51.9, west: 4.9, north: 52.6, east: 5.1 };
  // Centre of `wide` is 52.25: `near` at 52.5 is 0.25 away, `far` at 52.0 is 0.25 —
  // so widen slightly to make the winner unambiguous.
  const biased = { south: 52.2, west: 4.9, north: 52.6, east: 5.1 };
  assert.deepEqual(gantriesInBox([far, near], biased, 1).map((g) => g.key), ['n']);
  assert.equal(gantriesInBox([far, near], wide, 2).length, 2);
});
