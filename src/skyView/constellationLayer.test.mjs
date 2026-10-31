import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  constellationModel,
  drawConstellations,
  positionConstellations,
  prepareBoundaries,
  prepareConstellations,
  starNameCandidates,
  starNameLimit,
} from './constellationLayer.js';
import { TERRAIN_ALPHA, createStarField, starModel } from './starLayer.js';
import { occlusion as profileOcclusion } from './horizonProfile.js';
import { placeLabels, textWidth } from './skyLabels.js';
import { makeView, radecToVector } from './skyMath.js';
import { parseBoundaries, parseSkyData } from './starData.js';

const read = (name) =>
  JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url)));
const data = parseSkyData(read('stars.json'), read('constellations.json'));
const edges = parseBoundaries(read('boundaries.json'));
const HOUSTON = { latDeg: 29.7604, lonDeg: -95.3698 };
const ORION_MS = Date.parse('2026-01-16T03:00:00Z');
const W = 1280;
const H = 800;

function setup(ms = ORION_MS, observer = HOUSTON) {
  const field = createStarField(data.stars);
  field.update(ms, observer);
  const prepared = prepareConstellations(data.constellations, data.stars);
  const boundaries = prepareBoundaries(edges);
  const positioned = positionConstellations(prepared, boundaries, field.matrix);
  return { field, prepared, boundaries, positioned };
}

test('boundaries.json: 781 B1875 edges precessed to J2000, every point valid', () => {
  assert.equal(edges.length, 781);
  const points = edges.reduce((sum, e) => sum + e.ra.length, 0);
  assert.equal(points, read('manifest.json').counts.boundaryPoints);
  assert.throws(() => parseBoundaries({ format: 'x' }), /format/);
  assert.throws(
    () =>
      parseBoundaries({
        format: 'gev-sky-boundaries/1',
        edges: [{ a: 'A', b: 'B', points: [1, 2, 3] }],
      }),
    /points/,
  );
});

test("names sit at the unit-vector mean of each figure's line stars", () => {
  const { prepared } = setup();
  const k = data.constellations.findIndex((c) => c.iau === 'Ori');
  const members = new Set(data.constellations[k].lines.flat());
  const sum = [0, 0, 0];
  for (const i of members) {
    const v = radecToVector(data.stars.ra[i], data.stars.dec[i]);
    for (let j = 0; j < 3; j++) sum[j] += v[j];
  }
  const len = Math.hypot(...sum);
  assert.ok(Math.abs(prepared.centroid.x[k] - sum[0] / len) < 1e-12);
  assert.ok(Math.abs(prepared.centroid.y[k] - sum[1] / len) < 1e-12);
  assert.ok(Math.abs(prepared.centroid.z[k] - sum[2] / len) < 1e-12);
  // Orion's figure centre is near RA 5h 30m, Dec +3 (J2000)
  const ra =
    (Math.atan2(prepared.centroid.y[k], prepared.centroid.x[k]) * 180) /
    Math.PI;
  const dec = (Math.asin(prepared.centroid.z[k]) * 180) / Math.PI;
  assert.ok(ra > 78 && ra < 90, `ra ${ra}`);
  assert.ok(dec > -5 && dec < 12, `dec ${dec}`);
  assert.equal(prepared.pairs.length / 2, 674); // manifest lineSegments
});

test('lines join the drawn star positions; only segments with both ends above the horizon', () => {
  const { field, prepared, positioned } = setup();
  const view = makeView({ azDeg: 145, elDeg: 52, fovDeg: 60 });
  const model = constellationModel(prepared, positioned, field, {
    view,
    width: W,
    height: H,
  });
  assert.ok(model.segments.length / 4 > 10);
  // every catalogue star (line stars may be fainter than 6.5)
  const stars = starModel(field, { view, width: W, height: H, lim: 99 });
  const near = (x, y) => {
    for (let k = 0; k < stars.count; k++)
      if (Math.abs(stars.x[k] - x) < 0.01 && Math.abs(stars.y[k] - y) < 0.01)
        return true;
    return false;
  };
  // every segment endpoint that is on the canvas is a drawn star
  const s = model.segments;
  let onCanvas = 0;
  for (let k = 0; k < s.length; k += 2) {
    const [x, y] = [s[k], s[k + 1]];
    if (x < 10 || y < 10 || x > W - 10 || y > H - 10) continue;
    onCanvas++;
    assert.ok(near(x, y), `${x},${y}`);
  }
  assert.ok(onCanvas > 10);
  // looking at the ground: no constellation line at all
  const down = constellationModel(prepared, positioned, field, {
    view: makeView({ azDeg: 0, elDeg: -10, fovDeg: 20 }),
    width: W,
    height: H,
  });
  assert.equal(down.segments.length, 0);
});

test('each switch drives exactly its own part of the model', () => {
  const { field, prepared, positioned } = setup();
  const view = makeView({ azDeg: 145, elDeg: 52, fovDeg: 90 });
  const run = (opts) =>
    constellationModel(prepared, positioned, field, {
      view,
      width: W,
      height: H,
      ...opts,
    });
  const all = run({ lines: true, names: true, boundaries: true });
  assert.ok(all.segments.length && all.names.length && all.boundaries.length);
  const noLines = run({ lines: false, names: true, boundaries: true });
  assert.equal(noLines.segments.length, 0);
  assert.deepEqual(noLines.names, all.names);
  assert.deepEqual(noLines.boundaries, all.boundaries);
  const noNames = run({ lines: true, names: false, boundaries: true });
  assert.equal(noNames.names.length, 0);
  assert.deepEqual(noNames.segments, all.segments);
  const noBounds = run({ lines: true, names: true, boundaries: false });
  assert.equal(noBounds.boundaries.length, 0);
  assert.deepEqual(noBounds.segments, all.segments);
  // default: boundaries off
  assert.equal(
    constellationModel(prepared, positioned, field, {
      view,
      width: W,
      height: H,
    }).boundaries.length,
    0,
  );
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get: (t, k) => (k in t ? t[k] : (...a) => calls.push(k)),
      set: (t, k, v) => ((t[k] = v), true),
    },
  );
  drawConstellations(ctx, noBounds);
  const strokesWithout = calls.filter((k) => k === 'stroke').length;
  calls.length = 0;
  drawConstellations(ctx, all);
  // boundaries add exactly one batched stroke
  assert.equal(calls.filter((k) => k === 'stroke').length, strokesWithout + 1);
});

test('ACCEPTANCE: all 88 constellation names are placed in an all-sky wide setting (collision culled)', () => {
  const names = new Set();
  for (const latDeg of [45, -45])
    for (const hour of [0, 6, 12, 18]) {
      const ms = Date.parse('2026-03-20T00:00:00Z') + hour * 3600_000;
      const { field, prepared, positioned } = setup(ms, {
        latDeg,
        lonDeg: 0,
      });
      for (const [azDeg, elDeg] of [
        [0, 30],
        [90, 30],
        [180, 30],
        [270, 30],
        [0, 90],
      ]) {
        const view = makeView({ azDeg, elDeg, fovDeg: 100 });
        const model = constellationModel(prepared, positioned, field, {
          view,
          width: 1600,
          height: 1000,
        });
        const placed = placeLabels(
          model.names.map((n) => ({
            ...n,
            width: textWidth(null, n.text, '500 11px system-ui'),
            height: 13,
            align: 'center',
            priority: 50,
          })),
          { width: 1600, height: 1000 },
        );
        for (const p of placed) names.add(p.iau);
      }
    }
  assert.equal(names.size, 88, `missing ${88 - names.size}`);
});

test('proper star names: brightest named stars first, fewer in a wide view', () => {
  const { field } = setup();
  assert.equal(starNameLimit(90, 6.5), 1.5);
  assert.equal(starNameLimit(45, 6.5), 2.5);
  assert.equal(starNameLimit(20, 6.5), 4.0);
  assert.equal(starNameLimit(20, 3), 3);
  const view = makeView({ azDeg: 145, elDeg: 52, fovDeg: 60 });
  const model = starModel(field, { view, width: W, height: H, lim: 6.5 });
  const names = starNameCandidates(field, model, { fovDeg: 60 });
  const texts = names.map((n) => n.text);
  assert.ok(texts.includes('Betelgeuse') && texts.includes('Rigel'), texts);
  assert.ok(names.every((n) => n.mag <= 2.5));
  const close = starNameCandidates(field, model, { fovDeg: 20 });
  assert.ok(close.length > names.length);
});

test('R3: lines and names behind a terrain ridge are dimmed, the rest unchanged', () => {
  const { field, prepared, positioned } = setup();
  const view = makeView({ azDeg: 145, elDeg: 30, fovDeg: 100 });
  const base = { view, width: W, height: H };
  const open = constellationModel(prepared, positioned, field, {
    ...base,
    occlusion: (az, el) => profileOcclusion(null, az, el),
  });
  assert.equal(open.dimSegments.length, 0);
  assert.ok(open.names.every((n) => n.alpha === 1));
  const ridgeDeg = 40;
  const ridge = {
    azCount: 180,
    anglesDeg: new Float32Array(180).fill(ridgeDeg),
  };
  const dim = constellationModel(prepared, positioned, field, {
    ...base,
    occlusion: (az, el) => profileOcclusion(ridge, az, el),
  });
  // same segments in total, split by the ridge
  assert.equal(
    dim.segments.length + dim.dimSegments.length,
    open.segments.length,
  );
  assert.ok(dim.dimSegments.length > 0 && dim.segments.length > 0);
  const c = positioned.centroids;
  for (const name of dim.names) {
    const k = prepared.list.findIndex((e) => e.iau === name.iau);
    assert.equal(
      name.alpha,
      c.el[k] < ridgeDeg ? TERRAIN_ALPHA : 1,
      `${name.iau} el ${c.el[k]}`,
    );
  }
  assert.ok(dim.names.some((n) => n.alpha === TERRAIN_ALPHA));
  // draw: the dimmed lines are one stroke at TERRAIN_ALPHA
  const ops = [];
  const ctx = new Proxy(
    { globalAlpha: 1 },
    {
      get: (t, k) =>
        k in t
          ? t[k]
          : () => {
              if (k === 'stroke') ops.push(t.globalAlpha);
            },
      set: (t, k, v) => ((t[k] = v), true),
    },
  );
  drawConstellations(ctx, dim);
  assert.deepEqual(ops, [1, TERRAIN_ALPHA]);
  assert.equal(ctx.globalAlpha, 1);
});

/** Does segment (a, b) really cross the rectangle [0, w] x [0, h]? */
function segmentHitsRect(ax, ay, bx, by, w, h) {
  // Liang-Barsky clip
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  for (const [p, q] of [
    [-dx, ax],
    [dx, w - ax],
    [-dy, ay],
    [dy, h - ay],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

const segmentsOf = (runs) => {
  const out = [];
  for (const run of runs)
    for (let i = 2; i < run.length; i += 2)
      out.push([run[i - 2], run[i - 1], run[i], run[i + 1]]);
  return out;
};

test('boundary culling (edge caps + off-canvas segments) drops nothing that crosses the canvas', () => {
  const { field, prepared, positioned } = setup();
  // the same edges with no caps and no segment culling = every point
  const uncapped = {
    ...positioned,
    boundaries: positioned.boundaries.map(({ cap, ...rest }) => rest),
  };
  assert.ok(positioned.boundaries.every((b) => b.cap));
  let kept = 0;
  let culled = 0;
  for (const [azDeg, elDeg, fovDeg, width, height] of [
    [145, 52, 60, W, H],
    [145, 52, 100, W, H],
    [10, 5, 60, 412, 915],
    [250, 80, 30, 412, 915],
    [300, 20, 5, W, H],
    [0, 89, 100, W, H],
  ]) {
    const view = makeView({ azDeg, elDeg, fovDeg });
    const opts = { view, width, height, lines: false, boundaries: true };
    const fast = constellationModel(prepared, positioned, field, opts);
    const full = constellationModel(prepared, uncapped, field, opts);
    const key = (s) => s.map((v) => v.toFixed(3)).join(',');
    const fastSet = new Set(segmentsOf(fast.boundaries).map(key));
    for (const s of segmentsOf(full.boundaries)) {
      if (!segmentHitsRect(...s, width, height)) continue;
      assert.ok(fastSet.has(key(s)), `visible boundary segment kept ${s}`);
      kept++;
    }
    culled += positioned.boundaries.length;
  }
  assert.ok(kept > 100, `checked ${kept} visible segments`);
  assert.ok(culled > 0);
});

test('boundary culling skips most edges outside a 60 deg view', () => {
  const { field, prepared, positioned } = setup();
  const walked = new Set();
  const counting = {
    ...positioned,
    boundaries: positioned.boundaries.map((b, k) => ({
      ...b,
      get el() {
        walked.add(k);
        return b.el;
      },
    })),
  };
  constellationModel(prepared, counting, field, {
    view: makeView({ azDeg: 145, elDeg: 52, fovDeg: 60 }),
    width: W,
    height: H,
    lines: false,
    boundaries: true,
  });
  assert.ok(
    walked.size < positioned.boundaries.length / 3,
    `${walked.size} of ${positioned.boundaries.length} edges walked`,
  );
});
