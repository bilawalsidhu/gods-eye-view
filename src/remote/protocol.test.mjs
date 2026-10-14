import assert from 'node:assert/strict';
import test from 'node:test';
import { createView, viewToParams, viewUrl } from '../view/index.js';
import {
  applyRemotePlan,
  normalizeRemoteView,
  parseRemoteEvent,
  planRemoteApply,
  remoteSessionFromSearch,
  remoteSessionId,
} from './protocol.js';

const viewOf = (input) => {
  const result = normalizeRemoteView(input);
  assert.equal(result.ok, true, result.error);
  return result.view;
};

test('camera values clamp and omitted aim uses share-link defaults', () => {
  const view = viewOf({
    lat: 120,
    lon: -200,
    alt: 1e12,
    heading: -10,
    pitch: 100,
  });
  assert.deepEqual(view, {
    lat: 90,
    lon: -180,
    alt: 20_000_000,
    heading: 350,
    pitch: 90,
  });
  assert.deepEqual(viewOf({ lat: 30.2, lon: -97.7 }), {
    lat: 30.2,
    lon: -97.7,
    alt: 800,
    heading: 0,
    pitch: -35,
  });
});

test('a bbox is [west, south, east, north] and frames ahead of a point', () => {
  const view = viewOf({
    lat: 1,
    lon: 2,
    bbox: [190, 40, -190, -40],
    heading: 370,
  });
  assert.deepEqual(view.bbox, [180, -40, -180, 40]);
  assert.equal(planRemoteApply(view).camera.kind, 'bbox');
  assert.equal(planRemoteApply(view).camera.heading, 10);
  const rejected = normalizeRemoteView({ bbox: [1, 2, 3] });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /bbox/);
});

test('layers, imagery, style, pins and follow are validated', () => {
  const view = viewOf({
    style: 'nvg',
    imagery: 'osm',
    layers: { flights: true, earthquakes: false },
    annotations: [{ lat: 10, lon: 20, label: '  Pad  ' }],
    follow: { type: 'vessel', id: '123456789' },
  });
  assert.equal(view.style, 'surveillance');
  assert.equal(view.imagery, 'osm');
  assert.deepEqual(view.layers, { flights: true, earthquakes: false });
  assert.deepEqual(view.annotations, [{ lat: 10, lon: 20, label: 'Pad' }]);
  assert.deepEqual(view.follow, { type: 'vessel', id: '123456789' });
  assert.equal(viewOf({ style: 'crt' }).style, 'retro');
  assert.equal(viewOf({ style: 'osm' }).imagery, 'osm');
  assert.equal(viewOf({ imagery: 'flir' }).style, 'thermal');
  assert.equal(
    normalizeRemoteView({ layers: { 'not-a-layer': true } }).ok,
    false,
  );
  assert.equal(
    normalizeRemoteView({ follow: { type: 'ship', id: '1' } }).ok,
    false,
  );
  assert.equal(normalizeRemoteView({ lat: 1, lon: 2, zoom: 4 }).ok, false);
  assert.equal(normalizeRemoteView({}).ok, false);
  assert.equal(normalizeRemoteView({ lat: 1, lon: 2, alt: 0 }).ok, false);
  assert.equal(normalizeRemoteView({ alt: 100 }).ok, false);
  assert.equal(
    normalizeRemoteView({
      annotations: Array.from({ length: 25 }, () => ({ lat: 1, lon: 2 })),
    }).ok,
    false,
  );
});

test('apply toggles only the named layers, then flies, then follows', async () => {
  const view = viewOf({
    lat: 30,
    lon: -97,
    alt: 1500,
    heading: 20,
    pitch: -40,
    layers: { flights: true, earthquakes: false },
    imagery: 'osm',
    style: 'nvg',
    clearAnnotations: true,
    annotations: [{ lat: 30.1, lon: -97.2, label: 'Here' }],
    follow: { type: 'aircraft', id: 'ABC123' },
  });
  const calls = [];
  const applied = await applyRemotePlan(view, {
    setStyle: async (style) => calls.push(['style', style]),
    setImagery: async (stack) => calls.push(['imagery', stack]),
    setLayer: async (id, enabled) => calls.push(['layer', id, enabled]),
    clearAnnotations: async () => calls.push(['clear']),
    addAnnotations: async (pins) => calls.push(['pins', pins]),
    flyTo: async (camera) => calls.push(['fly', camera.kind, camera.alt]),
    follow: async (follow) =>
      calls.push(['follow', follow.type, follow.id, follow.layerId]),
  });
  assert.deepEqual(
    applied.steps.map((step) => step.step),
    [
      'style',
      'imagery',
      'layer',
      'layer',
      'clear',
      'annotations',
      'camera',
      'layer',
      'follow',
    ],
  );
  assert.deepEqual(calls[0], ['style', 'surveillance']);
  assert.deepEqual(calls[1], ['imagery', 'osm']);
  assert.deepEqual(calls[5][1], [
    { type: 'pin', latitude: 30.1, longitude: -97.2, label: 'Here' },
  ]);
  assert.deepEqual(calls.at(-1), ['follow', 'aircraft', 'abc123', 'flights']);
  assert.equal(applied.camera, 'point');
  assert.equal(applied.cleared, true);
  const vessel = planRemoteApply(
    viewOf({ follow: { type: 'vessel', id: '211000000' } }),
  );
  assert.equal(vessel.follow.layerId, 'ais-live-vessels');
  const thrown = await applyRemotePlan(
    viewOf({ lat: 1, lon: 2, style: 'noir' }),
    {
      setStyle: async () => {
        throw new Error('style unavailable');
      },
      flyTo: async () => calls.push('still-flew'),
    },
  );
  assert.equal(thrown.steps[0].ok, false);
  assert.equal(thrown.steps[1].step, 'camera');
  assert.equal(calls.at(-1), 'still-flew');
});

test('a share link restores that view, and explicit fields apply on top', async () => {
  const share = createView({
    camera: {
      lat: 30.2672,
      lon: -97.7431,
      altitude_m: 9091,
      heading_deg: 10,
      pitch_deg: -90,
    },
    layers: ['earthquakes', 'flights'],
    style: 'thermal',
    map: 'esri-imagery',
    follow: { kind: 'military_aircraft', id: 'AE1234' },
    annotations: [
      { type: 'pin', latitude: 30.27, longitude: -97.74, label: 'Pad' },
    ],
  });
  const url = viewUrl('https://maps.example/view?x=1', share);
  const hash = new URL(url).hash;
  const fromUrl = viewOf({ link: url });
  const fromHash = viewOf({ link: hash });
  const fromQuery = viewOf({ link: hash.slice(1) });
  assert.equal(fromUrl.lat, 30.2672);
  assert.equal(fromUrl.lon, -97.7431);
  assert.equal(fromUrl.alt, 9091);
  assert.equal(fromUrl.heading, 10);
  assert.equal(fromUrl.pitch, -90);
  assert.equal(fromUrl.style, 'thermal');
  assert.equal(fromUrl.imagery, 'esri-imagery');
  assert.equal(fromUrl.layers.earthquakes, true);
  assert.equal(fromUrl.layers.flights, true);
  assert.equal(fromUrl.layers.military, true);
  assert.equal(fromUrl.layers.transit, false);
  assert.deepEqual(fromUrl.follow, {
    type: 'military_aircraft',
    id: 'ae1234',
  });
  assert.deepEqual(fromUrl.linkAnnotations, share.annotations);
  assert.deepEqual(
    [fromHash.lat, fromHash.alt, fromHash.follow.id],
    [fromUrl.lat, fromUrl.alt, fromUrl.follow.id],
  );
  assert.equal(fromQuery.imagery, 'esri-imagery');
  assert.equal(new URLSearchParams(hash.slice(1)).get('style'), 'flir');

  const over = viewOf({
    link: url,
    lat: 1,
    lon: 2,
    layers: { earthquakes: false },
    annotations: [{ lat: 4, lon: 5, label: 'Extra' }],
    follow: { type: 'vessel', id: '211000000' },
  });
  assert.equal(over.lat, 1);
  assert.equal(over.alt, 800);
  assert.equal(over.pitch, -35);
  assert.equal(over.style, 'thermal');
  assert.equal(over.layers.earthquakes, false);
  assert.equal(over.layers.flights, true);
  assert.deepEqual(over.follow, { type: 'vessel', id: '211000000' });
  assert.deepEqual(over.linkAnnotations, share.annotations);
  assert.deepEqual(over.annotations, [{ lat: 4, lon: 5, label: 'Extra' }]);

  const aim = viewOf({ link: `#${viewToParams(share)}`, alt: 1200 });
  assert.equal(aim.lat, 30.2672);
  assert.equal(aim.alt, 1200);
  assert.equal(aim.heading, 10);

  const cleared = planRemoteApply(
    viewOf({ link: url, clearAnnotations: true }),
  );
  assert.equal(cleared.clearAnnotations, true);
  assert.deepEqual(cleared.annotations, []);
  const stacked = planRemoteApply(over);
  assert.equal(stacked.annotations[0].label, 'Pad');
  assert.equal(stacked.annotations[1].label, 'Extra');
  assert.equal(stacked.follow.layerId, 'ais-live-vessels');
  assert.equal(
    stacked.layers.find((layer) => layer.id === 'military').enabled,
    true,
  );

  const cameraOnly = viewOf({
    link: viewUrl(
      'https://maps.example/',
      createView({
        camera: { lat: 10, lon: 20, altitude_m: 500, pitch_deg: -40 },
      }),
    ),
  });
  assert.equal(cameraOnly.layers, undefined);
  assert.equal(cameraOnly.pitch, -40);
  assert.equal(cameraOnly.follow, undefined);

  assert.equal(
    normalizeRemoteView({ link: 'https://maps.example/' }).ok,
    false,
  );
  assert.match(normalizeRemoteView({ link: '#style=crt' }).error, /no camera/);
  assert.equal(normalizeRemoteView({ link: 4 }).ok, false);
  assert.equal(viewToParams(share).get('v'), '2');
  assert.equal(viewToParams(share).get('roll'), '0');
});

test('the view the hub publishes for a share link parses again', () => {
  const link =
    'https://maps.example/#v=2&lat=37.7561&lon=-122.4760&alt=4000' +
    '&heading=0&pitch=-35&roll=0&l=e&an=' +
    encodeURIComponent(
      JSON.stringify([
        {
          type: 'pin',
          latitude: 37.7561,
          longitude: -122.476,
          label: 'Here',
        },
      ]),
    );
  const published = normalizeRemoteView({ link });
  assert.equal(published.ok, true, published.error);
  assert.equal(published.view.linkAnnotations[0].label, 'Here');
  const again = parseRemoteEvent(JSON.stringify({ view: published.view }));
  assert.equal(again.ok, true, again.error);
  assert.deepEqual(again.view, published.view);
  const plan = planRemoteApply(again.view);
  assert.equal(plan.camera.lat, 37.7561);
  assert.equal(plan.camera.alt, 4000);
  assert.equal(plan.annotations[0].label, 'Here');
  assert.equal(
    plan.layers.find((layer) => layer.id === 'earthquakes').enabled,
    true,
  );

  const followed = normalizeRemoteView({
    link: viewUrl(
      'https://maps.example/',
      createView({
        camera: {
          lat: 37.7561,
          lon: -122.476,
          altitude_m: 4000,
          pitch_deg: -35,
        },
        follow: { kind: 'military_aircraft', id: 'AE1234' },
      }),
    ),
  });
  const followedAgain = parseRemoteEvent(
    JSON.stringify({ view: followed.view }),
  );
  assert.equal(followedAgain.ok, true, followedAgain.error);
  assert.deepEqual(followedAgain.view.follow, {
    type: 'military_aircraft',
    id: 'ae1234',
  });
  assert.equal(planRemoteApply(followedAgain.view).follow.layerId, 'military');
});

test('session selection and SSE payloads', () => {
  assert.deepEqual(remoteSessionFromSearch(''), {
    enabled: true,
    session: 'default',
  });
  assert.deepEqual(remoteSessionFromSearch('?remote=studio'), {
    enabled: true,
    session: 'studio',
  });
  assert.deepEqual(remoteSessionFromSearch('?remote=off'), {
    enabled: false,
    session: null,
  });
  assert.equal(remoteSessionFromSearch('?remote=*').enabled, false);
  assert.equal(remoteSessionId('*', { allowStar: true }), '*');
  assert.equal(remoteSessionId('bad session'), null);
  const parsed = parseRemoteEvent(
    JSON.stringify({ view: { lat: 95, lon: 1, alt: 50 } }),
  );
  assert.equal(parsed.view.lat, 90);
  assert.equal(parseRemoteEvent('not json').ok, false);
});
