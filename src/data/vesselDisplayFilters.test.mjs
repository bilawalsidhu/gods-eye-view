import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVesselFilters,
  vesselFilterType,
  vesselMatchesFilters,
  vesselSpeedKn,
  selectVesselDisplay,
} from './vesselDisplayFilters.js';

test('vessel filters validate settings, normalize AIS types and handle unavailable speeds', () => {
  assert.equal(vesselFilterType(71), 'CARGO');
  assert.equal(vesselFilterType('35'), 'MILITARY');
  assert.equal(vesselFilterType('Bulk carrier'), 'CARGO');
  assert.equal(vesselFilterType('Ferry'), 'PASSENGER');
  assert.equal(vesselFilterType(0), 'UNKNOWN');
  assert.equal(vesselFilterType('Custom'), 'OTHER');
  for (const speed of [null, undefined, NaN, -1, 102.3])
    assert.equal(vesselSpeedKn({ speed }), null);
  assert.equal(vesselSpeedKn({ speed: 0 }), 0);
  const f = normalizeVesselFilters({
    minSpeedKn: 200,
    maxSpeedKn: -5,
    types: ['CARGO', 'bogus'],
    density: 'bad',
    underwayOnly: 'true',
  });
  assert.equal(f.minSpeedKn, 0);
  assert.equal(f.maxSpeedKn, 102.2);
  assert.deepEqual(f.types, ['CARGO']);
  assert.equal(f.density, 'balanced');
  assert.equal(f.underwayOnly, false);
  assert.deepEqual(normalizeVesselFilters(null), normalizeVesselFilters());
  const underway = normalizeVesselFilters({ underwayOnly: true });
  assert.equal(vesselMatchesFilters({ speed: 1 }, underway), false);
  assert.equal(vesselMatchesFilters({ speed: null }, underway), false);
  assert.equal(vesselMatchesFilters({ speed: 1.1 }, underway), true);
  const type = normalizeVesselFilters({
    typeFilterEnabled: true,
    types: ['MILITARY'],
  });
  assert.equal(vesselMatchesFilters({ type: 35 }, type), true);
  assert.equal(vesselMatchesFilters({ type: 71 }, type), false);
  assert.equal(
    vesselMatchesFilters(
      { type: 35 },
      normalizeVesselFilters({ typeFilterEnabled: true, types: [] }),
    ),
    false,
  );
  const range = normalizeVesselFilters({
    speedFilterEnabled: true,
    minSpeedKn: 5,
    maxSpeedKn: 15,
  });
  for (const speed of [5, 15])
    assert.equal(vesselMatchesFilters({ speed }, range), true);
  for (const speed of [0, 16, null, 102.3])
    assert.equal(vesselMatchesFilters({ speed }, range), false);
});
test('wide vessel views thin stably, close views restore all and selection bypasses filters', () => {
  const candidates = Array.from({ length: 1000 }, (_, i) => ({
    record: { mmsi: String(i), type: 71, speed: 0 },
    position: { x: i * 10, y: i * 5, z: 0 },
  }));
  const choose = (filters, altitudeM = 500000, list = candidates) =>
    selectVesselDisplay(list, { filters, altitudeM, metresPerPixel: 100 });
  const defaults = normalizeVesselFilters();
  const wide = choose(defaults);
  assert.ok(wide.size < 20);
  assert.deepEqual(choose(defaults, 500000, [...candidates].reverse()), wide);
  assert.equal(choose(defaults, 50000).size, 1000);
  assert.equal(
    choose(normalizeVesselFilters({ declutterEnabled: false })).size,
    1000,
  );
  candidates[8].protected = true;
  const result = choose(
    normalizeVesselFilters({
      underwayOnly: true,
      typeFilterEnabled: true,
      types: [],
    }),
  );
  assert.deepEqual([...result], [candidates[8].record]);
  assert.equal(candidates.length, 1000);
});
