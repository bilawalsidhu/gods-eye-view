import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTransitSelectionCopy,
  transitDetectionClass,
  transitDetectionId,
  transitDetectionMetric,
  transitModeAbbr,
  transitModeWord,
} from './policy.js';
import { getTransitFeed } from '../../data/transitFeeds.js';

const ttc = () => getTransitFeed('ttc-toronto');
const hsl = () => getTransitFeed('hsl-helsinki');

test('an operator that names its own vehicles overrides the shared mode word', () => {
  // A Toronto 501 is a streetcar. A Helsinki 1010 is a tram. Both are the
  // `tram` mode, so the word a reader sees has to come from the operator,
  // not from the mode.
  assert.equal(transitModeWord('tram', ttc()), 'Streetcar');
  assert.equal(transitModeAbbr('tram', ttc()), 'STREETCAR');
  assert.equal(transitModeWord('tram', hsl()), 'Tram');
  assert.equal(transitModeAbbr('tram', hsl()), 'TRAM');
});

test('an override renames one mode, never the rest of the feed', () => {
  assert.equal(transitModeWord('bus', ttc()), 'Bus');
  assert.equal(transitModeWord('subway', ttc()), 'Subway');
  assert.equal(transitModeAbbr('bus', ttc()), 'BUS');
});

test('a missing feed or unknown mode falls back to the shared table', () => {
  assert.equal(transitModeWord('tram', null), 'Tram');
  assert.equal(transitModeWord('spaceship', ttc()), 'Transit vehicle');
  assert.equal(transitModeAbbr('spaceship', ttc()), 'TRANSIT');
  assert.equal(transitModeWord('tram', { name: 'No override' }), 'Tram');
});

test('the selection card calls a Toronto 501 a streetcar', () => {
  const record = { id: '4400', routeId: '501', timestamp: 0 };
  const copy = buildTransitSelectionCopy(ttc(), record, 'tram', 0, null, null);
  assert.match(copy.details.join(' | '), /Streetcar · TTC/);
  assert.doesNotMatch(copy.details.join(' | '), /Tram/);
});

test('detection labels carry the operator vocabulary within the field width', () => {
  const klass = transitDetectionClass('tram', ttc());
  assert.equal(klass, 'STREETCAR TTC');
  assert.ok(klass.length <= 20, 'fits the detection class field');
  assert.equal(transitDetectionClass('tram', hsl()), 'TRAM HSL');
  const metric = transitDetectionMetric({ mode: 'tram' }, 'tram', 0, ttc());
  assert.match(metric, /^STREETCAR/);
});

test('a Guelph vehicle is labelled with the number on the bus, not the database key', () => {
  const guelph = getTransitFeed('guelph-transit');
  const record = { id: '196', routeId: '2991', timestamp: 0 };
  const copy = buildTransitSelectionCopy(guelph, record, 'bus', 0, null, null);
  assert.match(copy.title, /Route 1\b/);
  assert.doesNotMatch(copy.title, /2991/);
  assert.equal(transitDetectionId(record, guelph), '1');
});

test('a feed that already speaks rider route numbers is untouched', () => {
  const record = { id: '4400', routeId: '501', timestamp: 0 };
  assert.equal(transitDetectionId(record, ttc()), '501');
  const copy = buildTransitSelectionCopy(ttc(), record, 'tram', 0, null, null);
  assert.match(copy.title, /Route 501/);
  // No feed at all still renders the raw route rather than throwing.
  assert.equal(transitDetectionId(record), '501');
});

test('a vehicle with no route still falls back to its fleet number', () => {
  const guelph = getTransitFeed('guelph-transit');
  assert.equal(transitDetectionId({ id: '196', label: '196' }, guelph), '196');
});
