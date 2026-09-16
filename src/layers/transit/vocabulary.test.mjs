import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTransitSelectionCopy,
  transitDetectionClass,
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
