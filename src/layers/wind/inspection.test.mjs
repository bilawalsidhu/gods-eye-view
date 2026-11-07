import test from 'node:test';
import assert from 'node:assert/strict';
import {
  windFrom,
  formatWindSpeed,
  inspectWindAtCenter,
} from './inspection.js';
import { fromDegrees } from '../../geo/ellipsoid.js';

test('wind directions describe the source of the flow and calm is not north', () => {
  assert.equal(windFrom(10, 0), 'W');
  assert.equal(windFrom(-10, 0), 'E');
  assert.equal(windFrom(0, 10), 'S');
  assert.equal(windFrom(0, -10), 'N');
  assert.equal(windFrom(0, 0), 'Calm');
  assert.equal(formatWindSpeed(10, 'km/h'), '36.0 km/h');
  assert.equal(formatWindSpeed(10, 'mph'), '22.4 mph');
});
test('center inspection uses a fixed forecast reading without double-converting scalar units', () => {
  const snapshot = {
    grid: { nx: 2, ny: 2, lo1: 0, la1: 90, dx: 180, dy: 180 },
    u: Float32Array.from([10, 10, 10, 10]),
    v: new Float32Array(4),
    scalar: {
      kind: 'temperature',
      units: '°C',
      values: Float32Array.from([20, 20, 20, 20]),
    },
  };
  let center = fromDegrees(0, 0);
  const picks = [];
  const view = {
    canvas: { clientWidth: 800, clientHeight: 600 },
    query: {
      pickEllipsoid(x, y) {
        picks.push([x, y]);
        return center;
      },
    },
  };
  const result = inspectWindAtCenter(snapshot, view, {
    overlay: 'temperature',
    units: 'km/h',
    model: 'GFS',
    validTime: 'fixed',
    status: 'forecast',
  });
  assert.equal(result.wind, '36.0 km/h from W');
  assert.equal(result.scalarValue, '20.0 °C');
  assert.equal(result.validTime, 'fixed');
  assert.equal(result.coordinates, '0.00°N · 0.00°E');
  assert.deepEqual(picks, [[400, 300]], 'the pick is at the canvas center');
  assert.equal(result.position, center);
  center = fromDegrees(70, 20);
  assert.equal(
    inspectWindAtCenter(snapshot, view).coordinates,
    '20.00°N · 70.00°E',
  );
  center = null;
  assert.equal(
    inspectWindAtCenter(snapshot, view).coordinates,
    'No surface reading',
  );
  assert.equal(
    inspectWindAtCenter(snapshot, { query: view.query }).coordinates,
    'No surface reading',
    'no canvas, no reading',
  );
});
