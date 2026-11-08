import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStubRenderer } from './index.js';
import { createStubHarness } from './harness.js';
import { runConformance } from '../conformance/index.js';
import { toEcef } from './math.js';

test('the stub passes the conformance suite', async () => {
  const report = await runConformance(createStubHarness());
  const failed = report.results.filter((r) => r.status === 'fail');
  assert.deepEqual(
    failed.map((r) => `${r.id}: ${r.detail}`),
    [],
  );
  const skipped = report.results
    .filter((r) => r.status === 'skip')
    .map((r) => r.id);
  assert.deepEqual(skipped, []);
});

test('a frame runs the contract’s steps in order', () => {
  const r = createStubRenderer();
  r.frame.requestRender('test');
  r.testing.tick();
  assert.deepEqual(r.testing.lastSteps(), [
    'flight',
    'input',
    'changed',
    'follow',
    'preUpdate',
    'moveDetection',
    'preRender',
    'render',
    'postRender',
  ]);
  r.testing.tick();
  assert.deepEqual(
    r.testing.lastSteps().at(-1),
    'moveDetection',
    'an idle frame stops before preRender',
  );
});

test('a throwing listener with no error listener is reported and the frame goes on', async () => {
  const reported = [];
  const saved = globalThis.reportError;
  globalThis.reportError = (error) => reported.push(error.message);
  try {
    const r = createStubRenderer();
    r.frame.on('preUpdate', () => {
      throw new Error('phase');
    });
    let after = false;
    r.frame.on('preUpdate', () => (after = true));
    r.frame.requestRender('test');
    r.testing.tick();
    assert.ok(after, 'the next listener still ran');
    assert.equal(
      r.testing.lastSteps().at(-1),
      'postRender',
      'the frame ran on',
    );
    const flight = r.camera.flyTo(
      { lon: 0, lat: 0, height: 1e6 },
      {
        durationS: 0,
        onComplete: () => {
          throw new Error('complete');
        },
      },
    );
    assert.equal(await flight.done, 'complete', 'the flight still resolved');
    assert.deepEqual(reported, ['phase', 'complete']);
  } finally {
    globalThis.reportError = saved;
  }
});

test('a model load is told once, even when a listener loads it again', () => {
  const r = createStubRenderer({ capabilities: ['models'] });
  const set = r.draw.models({ id: 'm' });
  const told = [];
  const model = (id, url) => ({
    id,
    pos: { lon: 0, lat: 0 },
    url,
    orientation: { heading: 0, pitch: 0, roll: 0 },
  });
  set.on('ready', (id) => told.push(`ready ${id}`));
  set.on('loadFailed', (id) => {
    told.push(`failed ${id}`);
    // Pointing b at another failing url is a new load, told by its upsert.
    if (id === 'a') set.upsert([model('b', 'stub-fail:other.glb')]);
  });
  set.set([model('a', 'stub-fail:a.glb'), model('b', 'stub-fail:b.glb')]);
  assert.deepEqual(told, ['failed a', 'failed b']);
  set.remove(['a']);
  set.upsert([model('a', 'good.glb')]);
  assert.deepEqual(told.slice(2), ['ready a']);
});

test('a draped rectangle across the antimeridian picks on both sides of it, turned too', () => {
  const r = createStubRenderer();
  r.camera.setView({
    destination: { lon: 180, lat: 0, height: 400_000 },
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
  const shapes = r.draw.shapes({ id: 'dateline' });
  const rect = (rotation) => ({
    id: 'r',
    geometry: {
      kind: 'rectangle',
      rect: { west: 179, south: -0.25, east: -179, north: 0.25 },
      rotation,
    },
    fill: '#f00',
    height: 'clampGround',
  });
  const picked = (lon, lat) => {
    const s = r.query.project(toEcef({ lon, lat, height: 0 }));
    return r.query.drillPick(s.x, s.y).some((hit) => hit.set === 'dateline');
  };
  shapes.set([rect(0)]);
  for (const lon of [179.5, 180, -179.5])
    assert.ok(picked(lon, 0), `at ${lon}`);
  assert.ok(!picked(178.5, 0) && !picked(-178.5, 0), 'not past its ends');
  assert.ok(!picked(180, 0.5), 'not past its north');
  shapes.set([rect(Math.PI / 2)]);
  assert.ok(picked(180, 0.75), 'a quarter turn stands it north to south');
  assert.ok(!picked(179.5, 0), 'and narrows it');
  r.destroy();
});
