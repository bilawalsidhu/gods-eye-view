import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrails } from './trails.js';
import { TERRAIN_NEED } from './policy.js';
import {
  createLagReservoir,
  createTrack,
  insertFix,
} from '../../data/contactPlayback.js';

/** A vehicle with four fixes 100 m apart, its marker between the third and fourth. */
function vehicle() {
  const track = createTrack({ policy: { feedLag: createLagReservoir() } });
  for (let i = 0; i < 4; i++)
    insertFix(track, { t: 1_000 + i * 10_000, lat: 42.36, lon: -71.06 + i * 0.0012 });
  return {
    key: 'bus',
    track,
    sample: {
      fromSeq: track.baseSeq + 2,
      toSeq: track.baseSeq + 3,
      displayT: 21_000,
    },
  };
}

function trailsAsking(t) {
  const asked = [];
  const state = { _enabled: true, _selectedKey: null, _viewer: null, _heightDirty: new Set() };
  const trails = createTrails({
    state,
    services: { render: { governorRequestRender() {} } },
    parts: {
      height: {
        requestHeight(lat, lon, entry, need) {
          asked.push(need);
          return { cell: 'c', height: 10, prior: null };
        },
      },
    },
    source: {},
  });
  t.after(() => trails.clear());
  return { trails, asked, state };
}

test('an unselected trail asks for its undrawn history at the lowest need', (t) => {
  const { trails, asked } = trailsAsking(t);
  const entry = vehicle();
  trails.prepareEntry(entry);
  const fixes = asked.slice(0, 4);
  assert.deepEqual(fixes, [TERRAIN_NEED.HISTORY, TERRAIN_NEED.HISTORY, TERRAIN_NEED.PATH, TERRAIN_NEED.PATH]);
  assert.ok(asked.slice(4).length > 0 && asked.slice(4).every((need) => (need ?? TERRAIN_NEED.PATH) === TERRAIN_NEED.PATH), 'the corridor is the path');
});

test('a selected trail asks for every fix as its path', (t) => {
  const { trails, asked, state } = trailsAsking(t);
  const entry = vehicle();
  state._selectedKey = entry.key;
  trails.select(entry);
  asked.length = 0;
  trails.prepareEntry(entry);
  assert.ok(asked.length > 4);
  assert.ok(asked.every((need) => (need ?? TERRAIN_NEED.PATH) === TERRAIN_NEED.PATH), JSON.stringify(asked.slice(0, 6)));
});
