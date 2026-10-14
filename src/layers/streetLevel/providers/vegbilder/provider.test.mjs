import assert from 'node:assert/strict';
import test from 'node:test';
import { createVegbilderProvider, vegbilderZoomFor } from './index.js';
import { MISSING_FILE_MESSAGE, normalizeImage } from './policy.js';
import { validateProviders } from '../../registry.js';
import { fakeHost, until } from '../../../../testSupport/kartaViewFakes.mjs';
import {
  driveFeatures,
  vegbilderFeature,
} from '../../../../testSupport/vegbilderFakes.mjs';

const NOW = Date.UTC(2026, 9, 14);
const OSLO = { lat: 59.91, lon: 10.757 };

/** A source over `byLayer` (feature type → features), recording calls. */
function fakeSource(byLayer = {}) {
  const calls = { boxes: [], images: [], drives: [] };
  const all = () => Object.values(byLayer).flat();
  return {
    calls,
    async imagesInBox(layer, box) {
      calls.boxes.push(layer);
      return (byLayer[layer] ?? []).filter(
        ({
          geometry: {
            coordinates: [lon, lat],
          },
        }) =>
          lon >= box.west &&
          lon <= box.east &&
          lat >= box.south &&
          lat <= box.north,
      );
    },
    async getImage(id) {
      calls.images.push(id);
      return all().find((feature) => feature.id === id) ?? null;
    },
    async driveImages(layer, cql) {
      calls.drives.push(cql);
      return (byLayer[layer] ?? []).map((feature) => {
        const { URL, URLPREVIEW, ...rest } = feature.properties;
        return { ...feature, properties: rest };
      });
    },
  };
}

function fakeContext(filter = { pano: 'all', sinceMs: null }) {
  const actions = { opened: [], nearest: [], instance: null, filter };
  return {
    actions,
    context: {
      services: {},
      getFilter: () => actions.filter,
      isActive: () => true,
      groundCaster: null,
      meshSampler: null,
      getSurface: () => 'draped',
      notify() {},
      actions: {
        openImage: async (id, options) => {
          actions.opened.push({ id, options });
          await actions.instance?.viewer.open(id);
          return true;
        },
        openNearest: (point) => actions.nearest.push(point),
        reportError() {},
      },
    },
  };
}

function setup(byLayer, { filter, loadPano, missing = [] } = {}) {
  const source = fakeSource(byLayer);
  const loads = [];
  const probed = [];
  const definition = createVegbilderProvider({
    source,
    now: () => NOW,
    probeImage: async (image) => {
      probed.push(image.id);
      return !missing.includes(image.id);
    },
    viewerOptions: {
      loadFlat: async (url) => {
        loads.push(url);
        return { src: url };
      },
      loadPano:
        loadPano ??
        (async (url) => {
          loads.push(url);
          return { close() {} };
        }),
      createRenderer: () => ({
        setView() {},
        getView: () => ({ yaw: 0, pitch: 0, fov: 80 }),
        setImage() {},
        resize() {},
        clear() {},
        destroy() {},
      }),
    },
  });
  const { context, actions } = fakeContext(filter);
  const instance = definition.create(context);
  actions.instance = instance;
  return { definition, instance, source, actions, loads, probed };
}

test('Vegbilder registers keyless, off by default, with both filters and Statens vegvesen’s credit', () => {
  const { definition } = setup();
  assert.equal(definition.id, 'vegbilder');
  assert.equal(definition.label, 'VEGBILDER');
  assert.equal(definition.requiresKeyId, null);
  assert.equal(definition.defaultOn, false);
  assert.deepEqual(definition.filters, ['pano', 'since']);
  assert.equal(definition.sinceBasis, undefined, 'SINCE is the capture date');
  assert.match(definition.credit.html, /Statens vegvesen<\/a>, NLOD 2\.0/);
  assert.equal(definition.colors.coverage, '#f28c00');
  validateProviders([
    { ...definition, id: 'mapillary', pickPrefix: 'mly:' },
    { ...definition, id: 'google', pickPrefix: 'gsv:' },
    { ...definition, id: 'kartaview', pickPrefix: 'kv:' },
    definition,
  ]);
});

test('coverage is drawn at z15 near the street only', () => {
  assert.deepEqual(vegbilderZoomFor(300), { zoom: 15, kind: 'sequence' });
  assert.deepEqual(vegbilderZoomFor(1_500), { zoom: 15, kind: 'sequence' });
  assert.equal(vegbilderZoomFor(1_501), null);
  assert.equal(vegbilderZoomFor(NaN), null);
});

test('the nearest photo is the closest within 50 m in the newest year that has one', async () => {
  const near = vegbilderFeature({
    year: 2025,
    lat: OSLO.lat + 10 / 110_540,
    lon: OSLO.lon,
  });
  const nearer2024 = vegbilderFeature({
    year: 2024,
    lat: OSLO.lat,
    lon: OSLO.lon,
  });
  const far = vegbilderFeature({
    year: 2025,
    meter: 900,
    lat: OSLO.lat + 45 / 110_540,
    lon: OSLO.lon,
  });
  const { instance, source, loads } = setup({
    'vegbilder_1_0:Vegbilder_2025': [far, near],
    'vegbilder_1_0:Vegbilder_2024': [nearer2024],
  });
  const id = await instance.nearestImage(OSLO);
  assert.equal(id, near.id, 'the newest year wins over a nearer older photo');
  assert.equal(source.calls.boxes[0], 'vegbilder_1_0:Vegbilder_2026');
  await instance.viewer.mount(fakeHost());
  await instance.viewer.open(id);
  assert.deepEqual(
    source.calls.images,
    [],
    'the lookup brought the signed address',
  );
  assert.equal(loads[0], normalizeImage(near).urls.full);
});

test('a photo whose file is missing is skipped for the next feature type’s nearest', async () => {
  const pano = vegbilderFeature({
    year: 2026,
    pano: true,
    lat: OSLO.lat,
    lon: OSLO.lon,
  });
  const flat = vegbilderFeature({ year: 2025, lat: OSLO.lat, lon: OSLO.lon });
  const { instance, probed } = setup(
    {
      'vegbilder_1_0:Vegbilder_360_2026': [pano],
      'vegbilder_1_0:Vegbilder_2025': [flat],
    },
    { missing: [pano.id] },
  );
  assert.equal(await instance.nearestImage(OSLO), flat.id);
  assert.deepEqual(probed, [pano.id, flat.id]);
  const none = setup(
    { 'vegbilder_1_0:Vegbilder_360_2026': [pano] },
    { missing: [pano.id] },
  );
  await assert.rejects(none.instance.nearestImage(OSLO), {
    message: MISSING_FILE_MESSAGE,
  });
});

test('outside Norway nothing is asked; no photo in range is null', async () => {
  const { instance, source } = setup({
    'vegbilder_1_0:Vegbilder_2025': [
      vegbilderFeature({ lat: OSLO.lat + 0.01 }),
    ],
  });
  assert.equal(await instance.nearestImage({ lat: 48.85, lon: 2.35 }), null);
  assert.equal(source.calls.boxes.length, 0);
  assert.equal(await instance.nearestImage(OSLO), null);
});

test('a 360° only filter searches 360° photos; SINCE skips older years', async () => {
  const { instance, source } = setup(
    {},
    { filter: { pano: 'pano', sinceMs: Date.UTC(2025, 0, 1) } },
  );
  await instance.nearestImage(OSLO);
  assert.deepEqual(source.calls.boxes, [
    'vegbilder_1_0:Vegbilder_360_2026',
    'vegbilder_1_0:Vegbilder_360_2025',
  ]);
});

test('› and ‹ walk along the drive in the order it was taken; the ends stop', async () => {
  const drive = driveFeatures(4);
  const { instance, actions } = setup({
    'vegbilder_1_0:Vegbilder_2025': drive,
  });
  const host = fakeHost();
  await instance.viewer.mount(host);
  const poses = [];
  instance.viewer.onPose((pose) => poses.push(pose));
  const [, , prev, next] = host.children[0].children;
  await instance.viewer.open(drive[1].id);
  assert.equal(poses.at(-1).title, 'Rv. 162');
  assert.equal(poses.at(-1).creator, 'Statens vegvesen');
  assert.equal(poses.at(-1).sequenceId, normalizeImage(drive[1]).driveId);
  next.fire('click');
  assert.ok(await until(() => poses.at(-1)?.imageId === drive[2].id));
  assert.deepEqual(actions.opened.at(-1), {
    id: drive[2].id,
    options: { frame: false },
  });
  prev.fire('click');
  assert.ok(await until(() => poses.at(-1)?.imageId === drive[1].id));
  await instance.viewer.open(drive[3].id);
  assert.ok(await until(() => next.disabled), 'nothing after the last photo');
});

test('a 360° photo whose file is missing shows its front view instead', async () => {
  const pano = vegbilderFeature({ pano: true });
  const { instance, loads } = setup(
    { 'vegbilder_1_0:Vegbilder_360_2025': [pano] },
    {
      loadPano: async () => {
        throw new Error(MISSING_FILE_MESSAGE);
      },
    },
  );
  await instance.viewer.mount(fakeHost());
  const poses = [];
  instance.viewer.onPose((pose) => poses.push(pose));
  await instance.viewer.open(pano.id);
  assert.match(loads.at(-1), /_preview\.jpg/);
  assert.equal(poses.at(-1).isPano, false);
});

test('a line opens the photo nearest the click; a cone opens its photo', () => {
  const { instance, actions } = setup();
  // Only what the pick asks for is checked: the viewer is not mounted.
  actions.instance = null;
  assert.equal(
    instance.handlePick('vb:line:x', { groundPoint: () => OSLO }),
    true,
  );
  assert.deepEqual(actions.nearest, [OSLO]);
  assert.equal(instance.handlePick('vb:img:Vegbilder_2025.a'), true);
  assert.equal(actions.opened[0].id, 'Vegbilder_2025.a');
  assert.equal(instance.handlePick('kv:line:x'), false);
});

test('coverage stats report Vegbilder as configured and key-free', async () => {
  const { instance } = setup();
  assert.deepEqual(await instance.status(), { configured: true });
  const stats = instance.coverageStats();
  assert.equal(stats.keyRequired, false);
  assert.equal(stats.count, 0);
});
