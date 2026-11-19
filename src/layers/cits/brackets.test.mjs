import test from 'node:test';
import assert from 'node:assert/strict';
import { citsBracketCard, citsBracketTier } from './brackets.js';

const NOW = Date.parse('2026-10-05T08:00:00.000Z');

test('tram cards carry line, destination, vehicle number and motion', () => {
  const card = citsBracketCard(
    {
      id: '00:30:e7:00:06:68',
      kind: 'tram',
      line: '6',
      destination: 'St. Peter',
      vehicleNumber: '217',
      speedKmh: 23.4,
      heading: 259.7,
      lastSeen: new Date(NOW - 4_000).toISOString(),
    },
    NOW,
  );
  assert.equal(card.primary, 'TRAM 6 → St. Peter');
  assert.equal(card.secondary, '#217 · 23 km/h · 260° · 4s');
});

test('bracket tiers follow the detection palette', () => {
  assert.equal(citsBracketTier({ kind: 'tram' }), 'transit_tram');
  assert.equal(citsBracketTier({ kind: 'car', speedKmh: 50 }), 'veh_free');
  assert.equal(citsBracketTier({ kind: 'car', speedKmh: 2 }), 'veh_jam');
  assert.equal(citsBracketTier({ kind: 'car' }), 'veh_nodata');
});
