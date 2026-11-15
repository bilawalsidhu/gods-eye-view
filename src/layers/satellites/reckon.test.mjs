// src/layers/satellites/reckon.test.mjs — every frame each shown point moves
// to where its satellite is at the world time; samples are taken again when
// time has moved far from them, and dense extras are sampled faster the
// faster time plays.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { twoline2satrec } from 'satellite.js';
import { createCatalog } from './catalog.js';
import { createOrbits } from './orbits.js';
import { createRendering } from './rendering.js';
import { sampleOrbit } from './motion.js';
import {
  DENSE_REFRESH_FRAMES,
  DENSE_SAMPLES_PER_FRAME_MAX,
  ORBIT_RECKON_LIMIT_MS,
  ORBIT_SAMPLE_HORIZON_MS,
} from './policy.js';

const ISS = twoline2satrec(
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537',
);
const AT_MS = Date.UTC(2008, 8, 20, 12, 30, 0);
const orbits = createOrbits({ state: {}, services: {}, parts: {} });

/** A point primitive that counts position writes. */
function point(show = true) {
  let position = new Cesium.Cartesian3();
  return {
    show,
    writes: 0,
    get position() {
      return position;
    },
    set position(value) {
      this.writes++;
      position = Cesium.Cartesian3.clone(value);
    },
  };
}

function scene(entries, { tracked = null } = {}) {
  const state = {
    _points: new Map(),
    _catalog: new Map(),
    _trackedNorad: tracked,
    _denseIds: [],
    _denseCursor: 0,
  };
  for (const [id, entry] of Object.entries(entries)) {
    state._points.set(id, entry.point);
    state._catalog.set(id, { satrec: ISS, group: 'core', ...entry.sat });
  }
  const rendering = createRendering({
    state,
    services: { focus: {} },
    parts: {},
  });
  return { state, rendering };
}

function sgp4At(atMs) {
  const pos = orbits.propagatePosition(ISS, new Date(atMs));
  return Cesium.Cartesian3.fromDegrees(
    pos.longitude,
    pos.latitude,
    pos.altitude,
  );
}

test('a shown point moves to its satellite at the world time; hidden and tracked ones do not', () => {
  const shown = point();
  const hidden = point(false);
  const tracked = point();
  const { rendering } = scene(
    {
      shown: { point: shown },
      hidden: { point: hidden },
      tracked: { point: tracked },
    },
    { tracked: 'tracked' },
  );
  rendering._reckonPoints(AT_MS);
  assert.ok(Cesium.Cartesian3.distance(shown.position, sgp4At(AT_MS)) < 1);
  assert.equal(hidden.writes, 0);
  assert.equal(tracked.writes, 0);
  // The same time again (the clock paused): nothing is written.
  rendering._reckonPoints(AT_MS);
  assert.equal(shown.writes, 1);
  // Shown while paused, a hidden point moves at once.
  hidden.show = true;
  rendering._reckonPoints(AT_MS);
  assert.equal(hidden.writes, 1);
});

test('between samples the point keeps to the track; far from its sample, a core satellite is sampled again', () => {
  const p = point();
  const { state, rendering } = scene({ iss: { point: p } });
  rendering._reckonPoints(AT_MS);
  const sample = state._catalog.get('iss').orbitSample;
  assert.equal(sample[0], AT_MS);
  // Within the horizon the same sample moves it on.
  const soon = AT_MS + ORBIT_SAMPLE_HORIZON_MS / 2;
  rendering._reckonPoints(soon);
  assert.equal(state._catalog.get('iss').orbitSample[0], AT_MS);
  assert.ok(Cesium.Cartesian3.distance(p.position, sgp4At(soon)) < 5);
  // A seek an hour back samples it again there.
  const back = AT_MS - 3_600_000;
  rendering._reckonPoints(back);
  assert.equal(state._catalog.get('iss').orbitSample[0], back);
  assert.ok(Cesium.Cartesian3.distance(p.position, sgp4At(back)) < 1);
});

test('a dense extra is left for its round-robin, and stays put once too far from its sample', () => {
  const p = point();
  const { rendering } = scene({
    starlink: {
      point: p,
      sat: { group: 'dense', orbitSample: sampleOrbit(ISS, AT_MS) },
    },
  });
  rendering._reckonPoints(AT_MS + ORBIT_SAMPLE_HORIZON_MS * 2);
  assert.equal(p.writes, 1, 'reckoned from its own sample');
  rendering._reckonPoints(AT_MS + ORBIT_RECKON_LIMIT_MS + 1);
  assert.equal(p.writes, 1, 'too far: left where it is');
});

test('the dense slice grows with how fast the world time moves, up to its cap', () => {
  const sampled = (count, worldStepMs) => {
    const state = {
      _denseIds: [],
      _denseCursor: 0,
      _catalog: new Map(),
      _trackedNorad: null,
      now: () => AT_MS,
    };
    for (let i = 0; i < count; i++) {
      state._denseIds.push(String(i));
      state._catalog.set(String(i), { satrec: ISS, group: 'dense' });
    }
    createCatalog({
      state,
      services: {},
      parts: {},
      source: {},
    })._propagateDenseChunk(worldStepMs);
    return [...state._catalog.values()].filter((sat) => sat.orbitSample).length;
  };
  // Real time: the set over DENSE_REFRESH_FRAMES frames.
  assert.equal(sampled(3000, 16), Math.ceil(3000 / DENSE_REFRESH_FRAMES));
  // A tenth of the horizon a frame: a tenth of the set.
  assert.equal(sampled(3000, ORBIT_SAMPLE_HORIZON_MS / 10), 300);
  // A seek, or the first frame: as many as the cap allows.
  assert.equal(sampled(3000, Number.NaN), DENSE_SAMPLES_PER_FRAME_MAX);
  assert.equal(sampled(1000, -ORBIT_SAMPLE_HORIZON_MS * 5), 1000);
});
