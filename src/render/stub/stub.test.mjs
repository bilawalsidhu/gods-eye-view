import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStubRenderer } from './index.js';
import { createStubHarness } from './harness.js';
import {
  CAMERA_SCRIPTS,
  runConformance,
  usesInput,
} from '../conformance/index.js';
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
  // It draws only models into pixels, so the sweep's, a lit shape's, a line outline's and
  // the blends' (over a drawn shape) and video tiles' pixels go unread; its camera takes no user gestures: the drag and wheel scripts are for a
  // camera that does (a controller over it, say).
  assert.deepEqual(skipped, [
    'effects.screenModulation.pixels',
    'draw.shapes.lit',
    'draw.lines.outline',
    'draw.sets.blend',
    'draw.models.blend',
    'globe.imagery.video',
    ...CAMERA_SCRIPTS.filter(usesInput).map((s) => `camera.trace.${s.name}`),
  ]);
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

test('the stub says where it draws an item, for a camera that is not its own', () => {
  const r = createStubRenderer();
  const t0 = r.frame.time();
  const from = toEcef({ lon: -97.74, lat: 30.27, height: 1000 });
  const to = toEcef({ lon: -97.7, lat: 30.27, height: 1000 });
  const set = r.draw.icons({ id: 'drawn', motionClock: { kind: 'scene' } });
  set.set([
    {
      id: 'm',
      pos: from,
      image: 'data:,',
      size: [16, 16],
      motion: { kind: 'lerp', from, to, t0, t1: t0 + 60000 },
    },
  ]);
  const at = (p) => [p.x, p.y, p.z];
  assert.deepEqual(
    at(r.testing.drawnPosition({ set: 'drawn', id: 'm' })),
    at(from),
  );
  r.frame.setTime(t0 + 30000);
  const mid = r.testing.drawnPosition({ set: 'drawn', id: 'm' });
  for (const k of ['x', 'y', 'z'])
    assert.ok(Math.abs(mid[k] - (from[k] + to[k]) / 2) < 1e-6, k);
  const ahead = r.testing.drawnPosition({ set: 'drawn', id: 'm' }, 30000);
  for (const k of ['x', 'y', 'z'])
    assert.ok(Math.abs(ahead[k] - to[k]) < 1e-6, k);
  assert.equal(r.testing.drawnPosition({ set: 'drawn', id: 'gone' }), null);
  assert.equal(r.testing.drawnPosition({ set: 'nothing', id: 'm' }), null);
  r.destroy();
});

test('the stub camera ends no move while it follows', () => {
  const r = createStubRenderer();
  const seen = [];
  r.camera.on('moveStart', () => seen.push('start'));
  r.camera.on('moveEnd', () => seen.push('end'));
  r.testing.tick();
  const target = toEcef({ lon: -97.74, lat: 30.27, height: 0 });
  r.camera.follow({
    key: 'still',
    position: () => target,
    frame: 'enu',
    viewFrom: { x: 0, y: -500, z: 300 },
  });
  r.testing.advance(2000);
  assert.deepEqual(seen, ['start'], 'moveEnd waits for the follow to end');
  r.camera.follow(null);
  r.testing.advance(1000);
  assert.deepEqual(seen, ['start', 'end']);
  r.destroy();
});

test('a slow vector setBase a later setBase supersedes changes nothing, nor one the destroy ends', async () => {
  const held = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, { signal } = {}) =>
    new Promise((resolve) => {
      held.push({
        signal,
        answer: () =>
          resolve({
            ok: true,
            status: 200,
            json: async () => ({ version: 8, sources: {}, layers: [] }),
          }),
      });
    });
  try {
    const r = createStubRenderer();
    const slow = r.globe.setBase({
      vector: { styleUrl: 'https://s.invalid/a' },
    });
    const fast = await r.globe.setBase({
      imagery: [{ kind: 'xyz', url: 'https://one.invalid/{z}/{x}/{y}.png' }],
    });
    assert.equal(held[0].signal.aborted, true, 'its style load is aborted');
    held[0].answer();
    const status = await slow;
    assert.deepEqual([status.imagery, status.settled], [[], false]);
    assert.deepEqual(r.globe.imagery.list(), fast.imagery);

    const ended = r.globe.setBase({
      vector: { styleUrl: 'https://s.invalid/b' },
    });
    r.destroy();
    held[1].answer();
    assert.deepEqual((await ended).imagery, []);
    assert.deepEqual(r.globe.imagery.list(), fast.imagery);
  } finally {
    globalThis.fetch = original;
  }
});

test('two setBase calls, neither awaited, leave the later one’s imagery alone', async () => {
  const r = createStubRenderer();
  const url = (name) => `https://${name}.invalid/{z}/{x}/{y}.png`;
  const first = r.globe.setBase({
    photoreal: null,
    imagery: [{ kind: 'xyz', url: url('a') }],
  });
  const second = r.globe.setBase({ imagery: [{ kind: 'xyz', url: url('b') }] });
  const [, later] = await Promise.all([first, second]);
  assert.deepEqual(r.globe.imagery.list(), later.imagery);
  assert.equal((await first).settled, false, 'the overtaken one');
  r.destroy();
});

test('a later setBase whose style fails leaves the earlier one the base, settled', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  try {
    const r = createStubRenderer();
    const first = r.globe.setBase({
      photoreal: null,
      imagery: [{ kind: 'xyz', url: 'https://a.invalid/{z}/{x}/{y}.png' }],
    });
    const second = r.globe.setBase({
      vector: { styleUrl: 'https://s.invalid/x' },
    });
    await assert.rejects(second);
    const status = await first;
    assert.deepEqual(r.globe.imagery.list(), status.imagery);
    assert.equal(status.settled, true, 'its base is the one drawn');
    r.destroy();
  } finally {
    globalThis.fetch = original;
  }
});

test('a setBase that ends while a later one’s style still loads is settled; the later one then replaces it', async () => {
  const held = [];
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    new Promise((resolve) => {
      held.push(() =>
        resolve({
          ok: true,
          status: 200,
          json: async () => ({ version: 8, sources: {}, layers: [] }),
        }),
      );
    });
  try {
    const r = createStubRenderer();
    const first = r.globe.setBase({
      photoreal: null,
      imagery: [{ kind: 'xyz', url: 'https://a.invalid/{z}/{x}/{y}.png' }],
    });
    const second = r.globe.setBase({
      vector: { styleUrl: 'https://s.invalid/x' },
    });
    const status = await first;
    assert.equal(status.settled, true, 'its base is still the one drawn');
    assert.deepEqual(r.globe.imagery.list(), status.imagery);
    held[0]();
    const later = await second;
    assert.equal(later.settled, true);
    assert.deepEqual(r.globe.imagery.list(), later.imagery);
    r.destroy();
  } finally {
    globalThis.fetch = original;
  }
});
