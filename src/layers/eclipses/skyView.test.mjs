import test from 'node:test';
import assert from 'node:assert/strict';
import { centralPoint, fromGeodetic } from './besselian.js';
import { paintSky, skyDarkness } from './skyPanel.js';
import { coveredShare, skyViewAt } from './skyView.js';
import { createEclipseElementsSource } from './source.js';

const catalog = await createEclipseElementsSource().getCatalog();
const byId = (id) => catalog.find((eclipse) => eclipse.id === id);

test('the covered share of the Sun runs from none to all of it', () => {
  assert.equal(coveredShare(1, 2), 0);
  assert.equal(coveredShare(1.05, 0.02), 1);
  // A smaller Moon dead centre leaves a ring: its own area is all it hides.
  assert.ok(Math.abs(coveredShare(0.9, 0) - 0.81) < 1e-12);
  // Two equal discs a radius apart share about 39% of their area.
  assert.ok(Math.abs(coveredShare(1, 1) - 0.391) < 0.001);
  // Closer always hides more.
  let previous = 0;
  for (let distance = 1.9; distance > 0.1; distance -= 0.1) {
    const share = coveredShare(1, distance);
    assert.ok(share > previous);
    previous = share;
  }
});

test('on the central line at greatest eclipse the Moon sits dead centre on the Sun, high in the sky', () => {
  const eclipse = byId('2027-08-02');
  const view = skyViewAt(
    eclipse,
    eclipse.greatestMs,
    centralPoint(eclipse, eclipse.greatestMs),
  );
  assert.equal(view.phase, 'total');
  assert.equal(view.covered, 1);
  assert.ok(view.distance < 1e-6);
  // The catalogue's magnitude is the Moon's disc against the Sun's.
  assert.ok(Math.abs(view.moonRadius - eclipse.magnitude) < 2e-3);
  assert.ok(Math.abs(view.sunAltitude - 82) < 1);
});

test('the Moon crosses the Sun from the upper right to the lower left in a morning sky in the north', () => {
  const eclipse = byId('2027-08-02');
  // Málaga: the Sun is in the east, where west on the sky is up and right.
  const malaga = fromGeodetic(36.72, -4.42);
  const before = skyViewAt(eclipse, Date.UTC(2027, 7, 2, 8, 20), malaga);
  assert.equal(before.phase, 'partial');
  assert.ok(before.covered > 0.4 && before.covered < 0.6);
  assert.ok(before.moonX > 0 && before.moonY > 0);
  assert.ok(Math.abs(before.sunAltitude - 33.5) < 1);
  // Totality there is at 08:47 UTC.
  const peak = skyViewAt(eclipse, Date.UTC(2027, 7, 2, 8, 47), malaga);
  assert.ok(peak.covered > 0.99);
  const after = skyViewAt(eclipse, Date.UTC(2027, 7, 2, 9, 20), malaga);
  assert.equal(after.phase, 'partial');
  assert.ok(after.moonX < 0 && after.moonY < 0);
});

test('an annular eclipse leaves a ring; far from the shadow there is no eclipse; at night the Sun is down', () => {
  const annular = byId('2023-10-14');
  const ring = skyViewAt(
    annular,
    annular.greatestMs,
    centralPoint(annular, annular.greatestMs),
  );
  assert.equal(ring.phase, 'annular');
  assert.ok(ring.moonRadius < 1);
  assert.ok(ring.covered > 0.85 && ring.covered < 1);
  const eclipse = byId('2027-08-02');
  assert.equal(
    skyViewAt(eclipse, eclipse.greatestMs, fromGeodetic(-23.5, -46.6)).phase,
    'none',
  );
  assert.ok(
    skyViewAt(eclipse, eclipse.greatestMs, fromGeodetic(35.7, 139.7))
      .sunAltitude < 0,
  );
});

test('the sky stays bright until most of the Sun is gone, then falls dark', () => {
  assert.ok(skyDarkness({ phase: 'partial', covered: 0.5 }) < 0.02);
  assert.ok(skyDarkness({ phase: 'partial', covered: 0.99 }) > 0.7);
  assert.equal(skyDarkness({ phase: 'total', covered: 1 }), 1);
});

test('painting draws the Sun and the Moon over it, and only night when the Sun is down', () => {
  const calls = [];
  const gradient = { addColorStop() {} };
  const context = new Proxy(
    {},
    {
      get: (_target, name) =>
        name === 'createLinearGradient' || name === 'createRadialGradient'
          ? () => gradient
          : (...args) => calls.push([name, ...args]),
      set: () => true,
    },
  );
  paintSky(context, {
    phase: 'partial',
    covered: 0.4,
    moonRadius: 1.05,
    moonX: 0.8,
    moonY: 0.2,
    distance: 0.82,
  });
  const discs = calls.filter(([name]) => name === 'arc');
  assert.equal(discs.length, 2, 'the Sun and the Moon');
  // The Moon is drawn right of centre and above it (canvas y runs down).
  assert.ok(discs[1][1] > discs[0][1]);
  assert.ok(discs[1][2] < discs[0][2]);
  calls.length = 0;
  paintSky(context, { night: true, phase: 'none' });
  assert.equal(calls.filter(([name]) => name === 'arc').length, 0);
});
