import test from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec, propagate } from 'satellite.js';
import {
  satelliteFixture,
  SATELLITE_FIXTURE_EPOCH,
} from './satelliteFixture.js';

test('satellite fixture has distinct, valid SGP4 catalogs including LEO, MEO and GEO', () => {
  const ids = new Set();
  const counts = {
    stations: 1,
    visual: 720,
    'gps-ops': 32,
    'glo-ops': 24,
    galileo: 30,
    geo: 32,
    starlink: 6000,
    resource: 12,
    weather: 8,
    planet: 24,
    sar: 6,
    science: 6,
  };
  for (const [group, count] of Object.entries(counts)) {
    const lines = satelliteFixture(group).trim().split('\n');
    assert.equal(lines.length, count * 3);
    for (let i = 0; i < lines.length; i += 3) {
      for (const line of [lines[i + 1], lines[i + 2]]) {
        assert.equal(line.length, 69);
        const sum = [...line.slice(0, 68)].reduce(
          (n, c) => n + (/\d/.test(c) ? Number(c) : c === '-' ? 1 : 0),
          0,
        );
        assert.equal(Number(line[68]), sum % 10);
      }
      const rec = twoline2satrec(lines[i + 1], lines[i + 2]);
      assert.equal(rec.error, 0);
      assert.ok(!ids.has(rec.satnum));
      ids.add(rec.satnum);
      const position = propagate(
        rec,
        new Date(SATELLITE_FIXTURE_EPOCH),
      ).position;
      assert.ok(position && Number.isFinite(position.x));
      const radius = Math.hypot(position.x, position.y, position.z);
      if (group === 'geo') assert.ok(radius > 41000 && radius < 43000);
      if (group === 'gps-ops') assert.ok(radius > 26000 && radius < 27000);
    }
  }
});
