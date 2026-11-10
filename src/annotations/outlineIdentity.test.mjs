// Multipart outline identity and street highlights in the annotation engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnnotationEngine,
  promoteStreetHighlight,
} from './annotationEngine.js';

function installAnimationFrameStubs(t) {
  const raf = globalThis.requestAnimationFrame;
  const caf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => {
    if (raf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = raf;
    if (caf === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = caf;
  });
}

const renderer = { add() {}, update() {}, remove() {}, sync() {} };
const outer = [
  [0, 0],
  [0.01, 0],
  [0.01, 0.01],
  [0, 0.01],
  [0, 0],
];
const hole = (d) => [
  [0.004, 0.004],
  [0.004 + d, 0.004],
  [0.004 + d, 0.004 + d],
  [0.004, 0.004],
];

test('outlines sharing an outer ring but not their holes stay two marks', async (t) => {
  installAnimationFrameStubs(t);
  const shapes = {
    a: [[outer, hole(0.001)]],
    b: [[outer, hole(0.002)]],
    same: [[outer, hole(0.001)]],
  };
  const resolveTarget = async ({ target }) => ({
    lon: 0.005,
    lat: 0.005,
    height: 0,
    label: target,
    source: 'fake',
    ring: outer,
    polygons: shapes[target],
    footprintKind: 'area',
  });
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget,
  });
  await engine.annotate({ type: 'area', target: 'a', label: 'A' });
  await engine.annotate({ type: 'area', target: 'b', label: 'B' });
  assert.equal(engine.list().length, 2, 'different holes: different marks');
  await engine.annotate({ type: 'area', target: 'same', label: 'Same' });
  assert.equal(engine.list().length, 2, 'identical parts and holes: one mark');
});

test('a street highlight asks for the street outline', () => {
  assert.deepEqual(
    promoteStreetHighlight({ type: 'highlight', target: 'Congress Avenue' }),
    { type: 'area', target: 'Congress Avenue', entityKind: 'street' },
  );
  assert.equal(
    promoteStreetHighlight({
      type: 'highlight',
      target: 'Lombard St, San Francisco',
    }).type,
    'area',
  );
  assert.equal(
    promoteStreetHighlight({
      type: 'highlight',
      target: 'the Alamo',
      entityKind: 'street',
    }).type,
    'area',
  );
  for (const spec of [
    { type: 'highlight', target: "St Peter's Basilica" },
    { type: 'highlight', target: 'Zilker Park' },
    { type: 'highlight', target: 'Congress Avenue', footprint: false },
    { type: 'highlight', target: 'Congress Avenue', entityKind: 'building' },
    { type: 'pin', target: 'Congress Avenue' },
  ])
    assert.equal(promoteStreetHighlight(spec), spec, JSON.stringify(spec));
});

test('the engine resolves a bare street highlight with its footprint', async (t) => {
  installAnimationFrameStubs(t);
  const seen = [];
  const resolveTarget = async (args) => {
    seen.push(args);
    return {
      lon: -97.74,
      lat: 30.27,
      height: 0,
      label: args.target,
      source: 'fake',
      ring: null,
    };
  };
  const engine = createAnnotationEngine({
    viewer: {},
    renderer,
    resolveTarget,
  });
  await engine.annotate({
    type: 'highlight',
    target: 'Congress Avenue',
    label: 'Congress',
  });
  assert.equal(seen[0].footprint, true);
  assert.equal(seen[0].entityKind, 'street');
});

test('a duplicate that fails to clean up never costs the new outline', async (t) => {
  installAnimationFrameStubs(t);
  const polygons = [[outer]];
  const outline = { ring: outer, polygons, footprintKind: 'area' };
  const point = { lon: 0.005, lat: 0.005, height: 0, source: 'fake' };
  // "Old" draws at once; "New" resolves the same polygon later.
  const resolveTarget = async ({ target }) =>
    target === 'old'
      ? { ...point, label: target, ...outline }
      : {
          ...point,
          label: target,
          resolveOutline: async () => ({ ...point, ...outline }),
        };
  const stuck = new Set();
  const outcomes = [];
  const engine = createAnnotationEngine({
    viewer: {},
    renderer: {
      ...renderer,
      add(anno) {
        if (anno.label === 'Old') stuck.add(anno);
      },
      remove(anno) {
        if (stuck.has(anno)) throw new Error('renderer refused');
      },
    },
    resolveTarget,
  });
  engine.onOutlineEvent((event) => outcomes.push(event));
  await engine.annotate({ type: 'area', target: 'old', label: 'Old' });
  await engine.annotate({ type: 'area', target: 'new', label: 'New' });
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  const fresh = engine.list().find((mark) => mark.label === 'New');
  assert.equal(fresh?.footprintKind, 'area', 'the new mark keeps its outline');
  assert.notEqual(fresh.outlineUnavailable, true);
  assert.deepEqual(
    outcomes.filter((event) => event.label === 'New').map((e) => e.status),
    ['resolved'],
  );
});
