// The HUD's passive place lookup spends paid Google requests on its own, so
// it must look up the view center and one more point, and only again once the
// view shows a different area.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { getBasemapLabelContext } from './gevActions.js';
import {
  hudViewportSamples,
  placeLookupView,
  placeLookupViewChanged,
} from '../hudPlaceLookup.js';

globalThis.window = globalThis.window || { setTimeout, clearTimeout };

/**
 * A looking-down camera `heightM` above the ellipsoid. Ellipsoid picks map
 * screen pixels linearly to degrees; the view target sits on terrain
 * `groundM` high under the camera.
 */
function createViewer({ latitude, longitude, heightM, groundM = 0 }) {
  const state = { latitude, longitude, heightM, groundM };
  const canvas = { clientWidth: 1200, clientHeight: 800 };
  const degreesPerPixel = () => state.heightM / 111_000 / canvas.clientHeight;
  const camera = {
    heading: 0,
    pitch: -Math.PI / 2,
    frustum: { fov: Math.PI / 3, aspectRatio: 1.5 },
    pickEllipsoid(point) {
      return Cesium.Cartesian3.fromDegrees(
        state.longitude +
          (point.x - canvas.clientWidth / 2) * degreesPerPixel(),
        state.latitude -
          (point.y - canvas.clientHeight / 2) * degreesPerPixel(),
      );
    },
  };
  Object.defineProperties(camera, {
    positionCartographic: {
      get: () =>
        Cesium.Cartographic.fromDegrees(
          state.longitude,
          state.latitude,
          state.heightM,
        ),
    },
    positionWC: {
      get: () =>
        Cesium.Cartesian3.fromDegrees(
          state.longitude,
          state.latitude,
          state.heightM,
        ),
    },
  });
  const scene = {
    canvas,
    pickPositionSupported: true,
    pickPosition: () =>
      Cesium.Cartesian3.fromDegrees(
        state.longitude,
        state.latitude,
        state.groundM,
      ),
  };
  return { viewer: { camera, scene }, state, degreesPerPixel };
}

/** Answers every lookup with a label naming the point it was asked about. */
function createService() {
  const calls = { reverse: 0, nearby: 0 };
  return {
    calls,
    async reverseGeocode(latitude, longitude) {
      calls.reverse += 1;
      const point = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
      return { formattedAddress: `Place ${point}`, labels: [`Area ${point}`] };
    },
    async nearby() {
      calls.nearby += 1;
      return [{ name: `Nearby ${calls.nearby}` }];
    },
  };
}

test('a view counts as new after a quarter-width move or a doubled distance', () => {
  const view = placeLookupView({ latitude: 30, longitude: -97, rangeM: 1000 });
  // A 60° field of view at 1 km shows about 1155 m across.
  assert.ok(Math.abs(view.spanM - 1154.7) < 1);
  const near = placeLookupView({
    latitude: 30.002,
    longitude: -97,
    rangeM: 1100,
  });
  assert.equal(
    placeLookupViewChanged(view, near),
    false,
    '~220 m is under a quarter width',
  );
  const far = placeLookupView({
    latitude: 30.003,
    longitude: -97,
    rangeM: 1000,
  });
  assert.equal(
    placeLookupViewChanged(view, far),
    true,
    '~330 m is over a quarter width',
  );
  const closer = placeLookupView({ latitude: 30, longitude: -97, rangeM: 500 });
  assert.equal(placeLookupViewChanged(view, closer), true);
  const farther = placeLookupView({
    latitude: 30,
    longitude: -97,
    rangeM: 2000,
  });
  assert.equal(placeLookupViewChanged(view, farther), true);
  assert.equal(placeLookupViewChanged(null, view), true);
  // The antimeridian is a short hop, not a world away.
  const west = placeLookupView({
    latitude: 0,
    longitude: 179.9999,
    rangeM: 1000,
  });
  const east = placeLookupView({
    latitude: 0,
    longitude: -179.9999,
    rangeM: 1000,
  });
  assert.equal(placeLookupViewChanged(west, east), false);
});

test('a portrait screen measures its narrower width', () => {
  const landscape = placeLookupView({
    latitude: 0,
    longitude: 0,
    rangeM: 1000,
    aspectRatio: 1.5,
  });
  const portrait = placeLookupView({
    latitude: 0,
    longitude: 0,
    rangeM: 1000,
    aspectRatio: 0.5,
  });
  assert.ok(Math.abs(landscape.spanM - 1154.7) < 1);
  assert.ok(Math.abs(portrait.spanM - 577.4) < 1);
});

test('a view in another height tier is new however close it is', () => {
  const a = placeLookupView({
    latitude: 0,
    longitude: 0,
    rangeM: 1000,
    tier: 'x',
  });
  const b = placeLookupView({
    latitude: 0,
    longitude: 0,
    rangeM: 1000,
    tier: 'y',
  });
  assert.equal(placeLookupViewChanged(a, b), true);
});

test('the HUD geocodes one viewport point besides the center', () => {
  const samples = [{ i: 0 }, { i: 1 }, { i: 2 }];
  assert.deepEqual(hudViewportSamples(samples, true), [{ i: 1 }]);
  assert.deepEqual(hudViewportSamples(samples, false), [{ i: 0 }, { i: 1 }]);
  assert.deepEqual(hudViewportSamples([], true), []);
});

test('a regional view spends two reverse geocodes and a nearby search', async () => {
  const { viewer } = createViewer({
    latitude: 30.26,
    longitude: -97.74,
    heightM: 20_000,
  });
  const service = createService();
  const labels = await getBasemapLabelContext(viewer, service);
  // Before: the center plus three viewport samples (the first of them the
  // center again, which shares its cache key in this stub).
  assert.deepEqual(service.calls, { reverse: 2, nearby: 1 });
  assert.ok(labels.placeLabels.length > 0);
});

test('a small pan reuses the last lookup; a real move looks up again', async () => {
  const { viewer, state } = createViewer({
    latitude: 30.26,
    longitude: -97.74,
    heightM: 600,
  });
  const service = createService();
  const first = await getBasemapLabelContext(viewer, service);
  assert.deepEqual(service.calls, { reverse: 1, nearby: 1 });

  state.latitude += 0.0005; // ~55 m at 600 m height
  const panned = await getBasemapLabelContext(viewer, service, {
    previous: first,
  });
  assert.deepEqual(
    panned.placeLabels,
    first.placeLabels,
    'the same area keeps its labels',
  );
  assert.deepEqual(service.calls, { reverse: 1, nearby: 1 });

  state.latitude += 0.002; // ~280 m from the first lookup
  const moved = await getBasemapLabelContext(viewer, service, {
    previous: panned,
  });
  assert.notDeepEqual(moved.placeLabels, first.placeLabels);
  assert.deepEqual(service.calls, { reverse: 2, nearby: 2 });
});

test('over high terrain the visible width is measured from the ground', async () => {
  // 100 m above a 3000 m plateau shows ~115 m across, not the ~3.6 km a
  // 3100 m ellipsoid height would suggest.
  const { viewer, state } = createViewer({
    latitude: 30.26,
    longitude: -97.74,
    heightM: 3100,
    groundM: 3000,
  });
  const service = createService();
  const first = await getBasemapLabelContext(viewer, service);
  state.latitude += 0.0045; // ~500 m
  await getBasemapLabelContext(viewer, service, { previous: first });
  assert.equal(service.calls.reverse, 2);
});

test('crossing into the Nearby Places height looks up again', async () => {
  const { viewer, state } = createViewer({
    latitude: 30.26,
    longitude: -97.74,
    heightM: 30_000,
  });
  const service = createService();
  const high = await getBasemapLabelContext(viewer, service);
  assert.equal(service.calls.nearby, 0);
  state.heightM = 20_000; // a 1.5× zoom, under the distance rule
  const low = await getBasemapLabelContext(viewer, service, { previous: high });
  assert.equal(service.calls.nearby, 1);
  assert.ok(low.nearbyPlaceLabels.length > 0);
});

test('a lookup that timed out is completed from the cache, not frozen', async () => {
  const { viewer, state } = createViewer({
    latitude: 30.26,
    longitude: -97.74,
    heightM: 600,
  });
  const service = createService();
  let answer;
  service.reverseGeocode = () => {
    service.calls.reverse += 1;
    return new Promise((resolve) => {
      answer = resolve;
    });
  };
  // Expire the 1.5 s wait at once.
  const { setTimeout: wait } = globalThis.window;
  globalThis.window.setTimeout = (fn) => wait(fn, 0);
  let first;
  try {
    first = await getBasemapLabelContext(viewer, service);
  } finally {
    globalThis.window.setTimeout = wait;
  }
  assert.deepEqual(first.placeLabels, []);
  assert.ok(
    first.nearbyPlaceLabels.length > 0,
    'the nearby answer arrived in time',
  );

  answer({ formattedAddress: 'Late place', labels: [] });
  await new Promise((resolve) => setImmediate(resolve));
  state.latitude += 0.0005;
  const next = await getBasemapLabelContext(viewer, service, {
    previous: first,
  });
  assert.deepEqual(next.placeLabels, ['Late place']);
  assert.deepEqual(
    service.calls,
    { reverse: 1, nearby: 1 },
    'the late answer is a cache hit',
  );
});

test('an empty answer is asked again rather than held', async () => {
  const { viewer, state } = createViewer({
    latitude: 30.26,
    longitude: -97.74,
    heightM: 600,
  });
  const service = createService();
  service.reverseGeocode = async () => {
    service.calls.reverse += 1;
    return null;
  };
  const empty = await getBasemapLabelContext(viewer, service);
  state.latitude += 0.0005;
  await getBasemapLabelContext(viewer, service, { previous: empty });
  assert.deepEqual(
    service.calls,
    { reverse: 2, nearby: 1 },
    'the cached nearby answer is not asked again',
  );
});

test('a failed lookup is asked again once the provider recovers', async () => {
  const { viewer, state } = createViewer({
    latitude: 30.26,
    longitude: -97.74,
    heightM: 600,
  });
  const service = createService();
  const working = service.reverseGeocode;
  service.reverseGeocode = async () => {
    service.calls.reverse += 1;
    throw new Error('503');
  };
  const failed = await getBasemapLabelContext(viewer, service);
  assert.deepEqual(failed.placeLabels, []);

  service.reverseGeocode = working;
  state.latitude += 0.0005;
  const recovered = await getBasemapLabelContext(viewer, service, {
    previous: failed,
  });
  assert.ok(recovered.placeLabels.length > 0);
  assert.deepEqual(
    service.calls,
    { reverse: 2, nearby: 1 },
    'only the failed geocode is asked again',
  );
});

test('cached-only lookups read every cached viewport sample and never request', async () => {
  const { viewer, state, degreesPerPixel } = createViewer({
    latitude: 30.26,
    longitude: -97.74,
    heightM: 20_000,
  });
  const service = createService();
  // Geocode view A's upper-left sample (screen x = 300).
  const a = await getBasemapLabelContext(viewer, service);
  const cachedLabel = a.placeLabels.find(
    (label) => label.startsWith('Area') && label !== 'Area 30.2600,-97.7400',
  );
  assert.ok(cachedLabel, 'the upper-left sample was geocoded');
  // View B puts that same point at its upper-right sample (screen x = 900),
  // which only a read of every sample finds.
  state.longitude -= 600 * degreesPerPixel();
  const before = { ...service.calls };
  const b = await getBasemapLabelContext(viewer, service, { cachedOnly: true });
  assert.ok(b.placeLabels.includes(cachedLabel));
  assert.deepEqual(service.calls, before);
});
