import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  cardinalBoxes,
  COMPASS_STRIP_PX,
  createSkyContent,
  overlayPixelRatio,
} from './skyContent.js';
import { overlayModel } from './overlay.js';
import { makeView } from './skyMath.js';
import { parseBoundaries, parseSkyData } from './starData.js';
import { STAR_UPDATE_MS } from './starLayer.js';

const read = (name) =>
  JSON.parse(readFileSync(new URL(`./data/${name}`, import.meta.url)));
const data = parseSkyData(read('stars.json'), read('constellations.json'));
const edges = parseBoundaries(read('boundaries.json'));
const HOUSTON = {
  latDeg: 29.7604,
  lonDeg: -95.3698,
  groundHeightM: 15,
  eyeHeightM: 1.7,
};
const ORION_MS = Date.parse('2026-01-16T03:00:00Z');
const W = 1280;
const H = 800;

/** A 2-D context that records calls and measures text at 6.5 px/char. */
function recordingContext() {
  const calls = [];
  const target = {
    calls,
    measureText: (text) => ({ width: String(text).length * 6.5 }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      return (...args) => calls.push([key, ...args]);
    },
    set(t, key, value) {
      t[key] = value;
      return true;
    },
  });
}

async function content(options = {}) {
  let view = makeView({ azDeg: 145, elDeg: 52, fovDeg: 90 });
  const applied = [];
  const c = createSkyContent({
    doc: null,
    getView: () => view,
    applyView: (next) => {
      view = next;
      applied.push(next);
    },
    loadData: () => data,
    loadBoundaryData: () => edges,
    createCanvas: () => null,
    reducedMotion: () => true,
    ...options,
  });
  await c.start(HOUSTON, ORION_MS);
  return {
    c,
    applied,
    get view() {
      return view;
    },
    draw: (opts = {}) =>
      c.draw(recordingContext(), {
        view,
        width: W,
        height: H,
        sunAltDeg: -40,
        ...opts,
      }),
  };
}

const countKinds = (stats) => {
  const out = {};
  for (const label of stats.labels)
    out[label.kind] = (out[label.kind] || 0) + 1;
  return out;
};

test('ACCEPTANCE: each switch shows/hides exactly its own layer', async () => {
  const s = await content();
  s.c.setFlags({ boundaries: true });
  await new Promise((r) => setTimeout(r, 0));
  const all = s.draw();
  assert.ok(all.stars > 100, `stars ${all.stars}`);
  assert.ok(all.segments > 10 && all.names > 3 && all.boundaries > 10);
  assert.ok(all.bodies >= 1, `bodies ${all.bodyNames}`); // Jupiter near Gemini
  assert.ok(all.starNames > 0);
  const base = countKinds(all);
  const layers = (st) => ({
    stars: st.stars,
    segments: st.segments,
    names: st.names,
    boundaries: st.boundaries,
    bodies: st.bodies,
  });
  const expectOnly = (flag, change) => {
    s.c.setFlags({ [flag]: false });
    const st = s.draw();
    const want = { ...layers(all), ...change };
    assert.deepEqual(layers(st), want, flag);
    s.c.setFlags({ [flag]: true });
    return st;
  };
  // stars off: no star sprites (proper names label drawn stars, so they go too)
  const noStars = expectOnly('stars', { stars: 0 });
  assert.equal(countKinds(noStars).star || 0, 0);
  const noLines = expectOnly('lines', { segments: 0 });
  assert.equal(countKinds(noLines).constellation, base.constellation);
  const noNames = expectOnly('names', { names: 0 });
  assert.equal(countKinds(noNames).constellation || 0, 0);
  assert.ok((countKinds(noNames).star || 0) >= (base.star || 0));
  const noBounds = expectOnly('boundaries', { boundaries: 0 });
  assert.equal(noBounds.segments, all.segments);
  const noPlanets = expectOnly('planets', { bodies: 0 });
  assert.equal(countKinds(noPlanets).body || 0, 0);
  s.c.setFlags({ starNames: false });
  const noStarNames = s.draw();
  assert.deepEqual(layers(noStarNames), layers(all));
  assert.equal(countKinds(noStarNames).star || 0, 0);
  assert.equal(noStarNames.starNames, 0);
  s.c.setFlags({ starNames: true });
  // back to everything on: identical to the first frame
  assert.deepEqual(layers(s.draw()), layers(all));
});

test('telescopic switch adds Uranus/Neptune only when they are up (night)', async () => {
  const s = await content();
  const eph = s.c.ephemeris;
  const up = eph.planets.filter((p) => p.telescopic && p.elDeg > 1);
  const seen = (telescopic) => {
    s.c.setFlags({ telescopic });
    const names = new Set();
    for (let az = 0; az < 360; az += 40)
      for (const el of [20, 60])
        for (const n of s.c.draw(recordingContext(), {
          view: makeView({ azDeg: az, elDeg: el, fovDeg: 100 }),
          width: W,
          height: H,
          sunAltDeg: -40,
        }).bodyNames)
          names.add(n);
    return names;
  };
  const off = seen(false);
  assert.ok(!off.has('Uranus') && !off.has('Neptune'));
  const on = seen(true);
  for (const p of up) assert.ok(on.has(p.name), `${p.name} up but not drawn`);
});

test('ACCEPTANCE: in a daylight state no star is drawn; only Sun/Moon/Venus/Jupiter bodies', async () => {
  const s = await content();
  for (const sunAltDeg of [0.1, 5, 40]) {
    const st = s.draw({ sunAltDeg });
    assert.equal(st.stars, 0);
    assert.equal(st.lim, -4);
    for (const name of st.bodyNames)
      assert.ok(['Sun', 'Moon', 'Venus', 'Jupiter'].includes(name), name);
  }
  // twilight: every drawn star is brighter than the limit
  const st = s.draw({ sunAltDeg: -8 });
  assert.ok(st.stars > 0);
  assert.ok(st.lim < 2.5);
});

test('positions refresh on the 2 s cadence; a redraw in between only re-projects', async () => {
  const s = await content();
  assert.equal(s.c.update(ORION_MS + STAR_UPDATE_MS / 2, HOUSTON), false);
  assert.equal(s.c.update(ORION_MS + STAR_UPDATE_MS, HOUSTON), true);
  assert.equal(s.c.update(ORION_MS - 86_400_000, HOUSTON), true);
  assert.equal(s.c.field.updatedAt, ORION_MS - 86_400_000);
});

test('search "Orion" looks at the figure and the marker sits at the view centre', async () => {
  const s = await content();
  const results = s.c.search('Orion');
  assert.equal(results[0].target.iau, 'Ori');
  const at = s.c.lookAt(results[0]);
  assert.ok(at.elDeg > 30);
  assert.ok(Math.abs(s.view.azDeg - at.azDeg) < 1e-9);
  assert.ok(Math.abs(s.view.elDeg - at.elDeg) < 1e-9);
  const st = s.draw();
  assert.ok(Math.abs(st.marker.x - W / 2) < 0.5, `marker x ${st.marker.x}`);
  // projection uses the full canvas (the camera's frustum); only drawing is
  // clipped above the compass strip
  assert.ok(Math.abs(st.marker.y - H / 2) < 0.5, `marker y ${st.marker.y}`);
  assert.ok(st.labels.some((l) => l.kind === 'marker' && l.text === 'Orion'));
  s.c.clearMarker();
  assert.equal(s.draw().marker, null);
  // animated (no reduced motion): frames step towards the target
  const frames = [];
  let t = 0;
  const anim = await content({
    reducedMotion: () => false,
    now: () => t,
    requestFrame: (fn) => (frames.push(fn), frames.length),
  });
  anim.c.lookAt(anim.c.search('Vega')[0]);
  assert.equal(frames.length, 1);
  t = 450;
  frames.shift()();
  const mid = anim.view;
  t = 2000;
  frames.shift()();
  assert.equal(frames.length, 0, 'animation ends');
  const vega = anim.c.lastResults[0];
  assert.equal(vega.label, 'Vega');
  assert.notDeepEqual(mid, anim.view);
});

test('a satellite provider makes satellites searchable and marked', async () => {
  const s = await content({
    satellites: {
      search: () => [{ id: 25544, name: 'ISS (ZARYA)' }],
      position: (id) => (id === 25544 ? { azDeg: 200, elDeg: 35 } : null),
    },
  });
  const [iss] = s.c.search('iss');
  assert.equal(iss.kind, 'satellite');
  assert.deepEqual(s.c.lookAt(iss), { azDeg: 200, elDeg: 35 });
  assert.equal(s.view.azDeg, 200);
});

test('a missing catalogue leaves the sky drawable (no stars) and reports the error', async () => {
  const s = await content({
    loadData: () => {
      throw new Error('404');
    },
  });
  assert.equal(s.c.status, 'error');
  const st = s.draw();
  assert.equal(st.stars, 0);
  assert.equal(st.segments, 0);
  assert.ok(st.bodies >= 0);
});

test('labels keep clear of the horizon cardinal labels and the compass strip', async () => {
  const s = await content();
  const view = makeView({ azDeg: 180, elDeg: 10, fovDeg: 100 });
  const model = overlayModel({ view, width: W, height: H });
  const reserved = cardinalBoxes(model.cardinals);
  assert.ok(reserved.length >= 3);
  const st = s.c.draw(recordingContext(), {
    view,
    width: W,
    height: H,
    sunAltDeg: -40,
    reserved,
  });
  for (const { box } of st.labels) {
    assert.ok(box.y1 <= H - COMPASS_STRIP_PX);
    for (const r of reserved)
      assert.ok(
        !(box.x0 < r.x1 && r.x0 < box.x1 && box.y0 < r.y1 && r.y0 < box.y1),
      );
  }
  assert.equal(s.c.perf().count >= 1, true);
});

test('overlay pixel ratio is capped at 2x', () => {
  assert.equal(overlayPixelRatio(1), 1);
  assert.equal(overlayPixelRatio(1.5), 1.5);
  assert.equal(overlayPixelRatio(2.625), 2);
  assert.equal(overlayPixelRatio(3), 2);
  assert.equal(overlayPixelRatio(undefined), 1);
  assert.equal(overlayPixelRatio(0), 1);
});

test('R1: a switch change notifies only the changed key (never the whole stale copy)', async () => {
  const notified = [];
  const { c } = await content({ onFlagsChange: (next) => notified.push(next) });
  c.setFlags({ flatHorizon: false, grid: false });
  c.setFlags({ lines: false }, { notify: true });
  c.setFlags({ boundaries: true }, { notify: true });
  assert.deepEqual(notified, [{ lines: false }, { boundaries: true }]);
});
