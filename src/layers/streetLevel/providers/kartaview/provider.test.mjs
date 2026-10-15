import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createKartaViewProvider,
  createTileCache,
  kartaViewZoomFor,
} from './index.js';
import {
  FILTERED_OUT_MESSAGE,
  NO_COVERAGE_HINT,
  SEQUENCE_PAGE_SIZE,
  TOO_HIGH_HINT,
} from './policy.js';
import { validateProviders } from '../../registry.js';
import { fakeHost, until } from '../../../../testSupport/kartaViewFakes.mjs';
import {
  coverageViewer,
  tileCentre,
} from '../../../../testSupport/streetLevelFakes.mjs';

/** A photo record `metres` east of (42.3314, -83.0458), in sequence `seq` at `index`. */
function photoRecord(id, { metres = 0, seq = '14010', index = 0 } = {}) {
  const lon = -83.0458 + metres / 82_300;
  return {
    id: String(id),
    sequenceId: seq,
    sequenceIndex: String(index),
    lat: '42.3314',
    lng: String(lon),
    heading: '90',
    projection: 'PLANE',
    fieldOfView: '0',
    shotDate: '2016-08-23 20:17:47.000',
    storage: 'storage2',
    filepathLTh: `2016/8/24/lth/${id}.jpg`,
    filepathProc: `2016/8/24/proc/${id}.jpg`,
  };
}

/** KartaView's shotDate for `ms` ago. */
const shotAgo = (ms) =>
  new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 23);

/**
 * A source over `sequences` (id → indexes present, in page order: KartaView
 * pages follow photo ids, which only roughly follow the index), recording
 * calls. Photos whose id is in `archived` answer 409.
 */
function fakeSource({ nearest = [], sequences = {}, archived = [] } = {}) {
  const calls = {
    nearest: 0,
    nearestFilters: [],
    photo: [],
    pages: [],
    probes: [],
  };
  return {
    calls,
    probeImage: async (url) => {
      calls.probes.push(url);
      return !archived.some((id) => url.includes(`/${id}.jpg`));
    },
    getTile: async () => ({ lines: [] }),
    nearestPhotos: async ({ filter }) => {
      calls.nearest++;
      calls.nearestFilters.push(filter);
      return nearest;
    },
    getPhoto: async (id) => {
      calls.photo.push(id);
      for (const [seq, indexes] of Object.entries(sequences))
        for (const index of indexes)
          if (`${seq}-${index}` === id)
            return photoRecord(id, { seq, index, metres: index * 5 });
      throw new Error('KartaView has no such photo');
    },
    getSequencePhotos: async (seq, { page, itemsPerPage }) => {
      calls.pages.push(`${seq}:${page}`);
      const indexes = sequences[seq] || [];
      const rows = indexes.slice(
        (page - 1) * itemsPerPage,
        page * itemsPerPage,
      );
      return {
        photos: rows.map((index) =>
          photoRecord(`${seq}-${index}`, { seq, index, metres: index * 5 }),
        ),
        hasMore: page * itemsPerPage < indexes.length,
      };
    },
  };
}

function fakeContext({ filter = { pano: 'all', sinceMs: null } } = {}) {
  // `actions.filter` is the resolved filter now; a test may change it.
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
        // As the core does: the provider's own viewer opens it.
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

function setup(sourceOptions, contextOptions, { readMask } = {}) {
  const source = fakeSource(sourceOptions);
  const loads = [];
  const definition = createKartaViewProvider({
    source,
    readMask,
    viewerOptions: {
      load: async (url) => {
        loads.push(url);
        return { src: url };
      },
      createRenderer: () => {
        throw new Error('no WebGL in Node');
      },
    },
  });
  const { context, actions } = fakeContext(contextOptions);
  const instance = definition.create(context);
  actions.instance = instance;
  return { definition, instance, source, actions, loads };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('KartaView registers keyless, off by default, with Mapillary’s filters and its own wording', () => {
  const { definition } = setup();
  assert.equal(definition.id, 'kartaview');
  assert.equal(definition.requiresKeyId, null);
  assert.equal(definition.defaultOn, false);
  assert.deepEqual(definition.filters, ['pano', 'since']);
  assert.equal(
    definition.sinceBasis,
    'upload',
    'SINCE is KartaView’s upload date',
  );
  assert.equal(
    definition.highlightsSequence,
    false,
    'its lines are streets: a selected drive shows as cones',
  );
  assert.match(
    definition.credit.html,
    /KartaView<\/a> contributors, CC BY-SA 4\.0/,
  );
  assert.equal(definition.colors.coverage, '#635bff');
  assert.deepEqual(definition.coverageLabel, {
    noun: 'streets',
    action: 'click a line for its nearest photo',
  });
  // Its prefix fits beside the others.
  validateProviders([
    { ...definition, id: 'mapillary', pickPrefix: 'mly:' },
    { ...definition, id: 'google', pickPrefix: 'gsv:' },
    definition,
  ]);
});

test('coverage is drawn from z14 near the street and z13 a little higher; never from orbit', () => {
  assert.deepEqual(kartaViewZoomFor(300), { zoom: 14, kind: 'sequence' });
  assert.deepEqual(kartaViewZoomFor(2_500), { zoom: 14, kind: 'sequence' });
  assert.deepEqual(kartaViewZoomFor(4_000), { zoom: 13, kind: 'sequence' });
  assert.deepEqual(
    kartaViewZoomFor(6_000),
    { zoom: 13, kind: 'sequence' },
    'the top of the range still draws',
  );
  assert.equal(kartaViewZoomFor(6_001), null);
  assert.equal(kartaViewZoomFor(NaN), null);
});

test('the nearest photo is the closest within 50 m, and opening it asks nothing more', async () => {
  const { instance, source, loads } = setup({
    nearest: [
      photoRecord('far', { metres: 80 }),
      photoRecord('mid', { metres: 30 }),
      photoRecord('near', { metres: 12 }),
    ],
  });
  const id = await instance.nearestImage({ lat: 42.3314, lon: -83.0458 });
  assert.equal(id, 'near');
  const host = fakeHost();
  await instance.viewer.mount(host);
  await instance.viewer.open(id);
  assert.deepEqual(source.calls.photo, [], 'the lookup filled the cache');
  assert.equal(
    Buffer.from(loads[0].split('/').at(-1), 'base64url').toString(),
    'https://storage2.openstreetcam.org/files/photo/2016/8/24/proc/near.jpg',
    'the proxy shrinks the photo on its real storage host',
  );
  const none = setup({ nearest: [photoRecord('far', { metres: 80 })] });
  assert.equal(
    await none.instance.nearestImage({ lat: 42.3314, lon: -83.0458 }),
    null,
  );
});

test('the nearest photo passes the imagery filter by its upload date, as KartaView filters; none passing says so', async () => {
  const since = Date.now() - 86_400_000;
  const filter = { pano: 'pano', sinceMs: since };
  const pano = (id, metres, uploaded) => ({
    ...photoRecord(id, { metres }),
    projection: 'SPHERE',
    fieldOfView: '360',
    shotDate: '2016-08-23 20:17:47.000',
    dateAdded: uploaded,
  });
  // Both taken in 2016; only the second was uploaded since yesterday.
  const { instance, source } = setup(
    {
      nearest: [
        pano('stale', 5, '2016-08-24 04:01:07'),
        pano('fresh', 20, shotAgo(3_600_000).slice(0, 19)),
      ],
    },
    { filter },
  );
  const at = { lat: 42.3314, lon: -83.0458 };
  assert.equal(await instance.nearestImage(at), 'fresh');
  assert.deepEqual(source.calls.nearestFilters, [filter]);
  const stale = setup(
    { nearest: [pano('stale', 5, '2016-08-24 04:01:07')] },
    { filter },
  );
  await assert.rejects(stale.instance.nearestImage(at), {
    message: FILTERED_OUT_MESSAGE,
  });
  // Uploaded earlier on the cut-off's UTC day: KartaView's startDate keeps
  // it, and so does the check.
  const day = new Date(since).toISOString().slice(0, 10);
  const sameDay = setup(
    { nearest: [pano('early', 5, `${day} 00:00:01`)] },
    { filter },
  );
  assert.equal(await sameDay.instance.nearestImage(at), 'early');
});

test('a cone opens its photo; a line opens the photo nearest the click', () => {
  const { instance, actions } = setup();
  actions.instance = null;
  assert.equal(instance.handlePick('kv:img:123'), true);
  assert.deepEqual(actions.opened, [{ id: '123', options: undefined }]);
  const point = { lon: -83.0458, lat: 42.3314 };
  assert.equal(
    instance.handlePick('kv:line:14/1/2/3', { groundPoint: () => point }),
    true,
  );
  assert.deepEqual(actions.nearest, [point]);
  // Over the sky the line is still ours, but there is nowhere to look.
  assert.equal(
    instance.handlePick('kv:line:14/1/2/3', { groundPoint: () => null }),
    true,
  );
  assert.equal(actions.nearest.length, 1);
  assert.equal(instance.handlePick('mly:seq:1'), false);
});

test('coverage stats report KartaView as configured and key-free', async () => {
  const { instance } = setup();
  assert.deepEqual(await instance.status(), { configured: true });
  const stats = instance.coverageStats();
  assert.equal(stats.keyRequired, false);
  assert.equal(stats.keyRejected, false);
  assert.equal(stats.count, 0);
});

/** Press a step button and wait until it has opened a photo (`opened` grew). */
const press = async (button, opened) => {
  const before = opened.length;
  button.fire('click');
  await until(() => opened.length > before);
  await settle();
};

async function mounted(sourceOptions, contextOptions) {
  const env = setup(sourceOptions, contextOptions);
  const host = fakeHost();
  await env.instance.viewer.mount(host);
  const poses = [];
  env.instance.viewer.onPose((pose) => poses.push(pose.imageId));
  const [, , prev, next] = host.children[0].children;
  return { ...env, poses, prev, next };
}

test('› walks across sequence pages without moving the camera; ‹ walks back; the ends stop', async () => {
  const size = SEQUENCE_PAGE_SIZE;
  const indexes = Array.from({ length: size + 5 }, (_, i) => i);
  const { instance, actions, source, poses, prev, next } = await mounted({
    sequences: { s: indexes },
  });
  await instance.viewer.open(`s-${size - 1}`);
  await press(next, poses);
  assert.equal(poses.at(-1), `s-${size}`, 'onto the second page');
  assert.deepEqual(actions.opened.at(-1), {
    id: `s-${size}`,
    options: { frame: false },
  });
  assert.ok(source.calls.pages.includes('s:2'));
  await press(prev, poses);
  assert.equal(poses.at(-1), `s-${size - 1}`);
  await instance.viewer.open('s-0');
  assert.ok(await until(() => prev.disabled), 'nothing before the first photo');
  // ‹ at the start opens nothing: presses run in turn, so once a later ›
  // has opened its photo, a ‹ that opened one would show before it.
  const before = actions.opened.length;
  prev.fire('click');
  await press(next, poses);
  assert.deepEqual(
    actions.opened.slice(before).map((open) => open.id),
    ['s-1'],
  );
});

test('pages that overlap in index (id order) step one photo at a time across the edge', async () => {
  const size = SEQUENCE_PAGE_SIZE;
  // As KartaView pages by id: page 1 holds 0…size+2 less two, page 2 starts
  // with those two (size-2, size) before the rest.
  const first = Array.from({ length: size + 3 }, (_, i) => i).filter(
    (i) => i !== size - 2 && i !== size,
  );
  const second = [
    size - 2,
    size,
    ...Array.from({ length: 50 }, (_, i) => size + 3 + i),
  ];
  const { instance, poses, next } = await mounted({
    sequences: { s: [...first, ...second] },
  });
  await instance.viewer.open(`s-${size - 5}`);
  for (let k = 1; k <= 8; k++) await press(next, poses);
  assert.deepEqual(
    poses.slice(-9).map((id) => Number(id.slice(2))),
    Array.from({ length: 9 }, (_, i) => size - 5 + i),
    'no photo skipped at the page edge',
  );
});

test('a photo whose index outruns the page count is found, and its neighbours are real', async () => {
  // 1,000 photos with 500–1499 deleted: index 1500 is on page 2, not 4.
  const indexes = [
    ...Array.from({ length: 500 }, (_, i) => i),
    ...Array.from({ length: 500 }, (_, i) => 1500 + i),
  ];
  const { instance, poses, prev, next } = await mounted({
    sequences: { s: indexes },
  });
  await instance.viewer.open('s-1500');
  await press(next, poses);
  assert.equal(poses.at(-1), 's-1501');
  await press(prev, poses);
  await press(prev, poses);
  assert.equal(poses.at(-1), 's-499', 'back across the gap');
  await instance.viewer.open('s-1999');
  assert.ok(await until(() => next.disabled), 'the last photo');
});

test('archived photos are skipped: by the nearest lookup, and by › and ‹', async () => {
  const { instance, poses, next } = await mounted({
    nearest: [
      photoRecord('gone', { metres: 3 }),
      photoRecord('kept', { metres: 9 }),
    ],
    archived: ['gone', 's-2', 's-3'],
    sequences: { s: [0, 1, 2, 3, 4] },
  });
  assert.equal(
    await instance.nearestImage({ lat: 42.3314, lon: -83.0458 }),
    'kept',
  );
  await instance.viewer.open('s-1');
  await press(next, poses);
  assert.equal(poses.at(-1), 's-4', 'two archived photos stepped over');
  const allGone = setup({
    nearest: [photoRecord('gone', { metres: 3 })],
    archived: ['gone'],
  });
  await assert.rejects(
    allGone.instance.nearestImage({ lat: 42.3314, lon: -83.0458 }),
    /archived and cannot be shown/,
  );
  const noFiles = setup({
    nearest: [
      {
        ...photoRecord('bare', { metres: 2 }),
        filepathLTh: '',
        filepathProc: '',
      },
    ],
  });
  assert.equal(
    await noFiles.instance.nearestImage({ lat: 42.3314, lon: -83.0458 }),
    null,
    'a record with no file is not a photo',
  );
});

/** A stand-in Cesium viewer the cones can draw on; `cones()` lists their photo indexes. */
async function withCones(t, env) {
  const Cesium = await import('cesium');
  const drawing = new Proxy({}, { get: () => () => {}, set: () => true });
  const saved = globalThis.document;
  globalThis.document = {
    createElement: () => ({ getContext: () => drawing }),
  };
  t.after(() => (globalThis.document = saved));
  let collection = null;
  env.instance.init({
    scene: {
      frameState: { mode: Cesium.SceneMode.SCENE3D },
      updateHeight: () => () => {},
      getHeight: () => undefined,
      primitives: { add: (c) => (collection = c), remove() {} },
      preRender: { addEventListener: () => () => {} },
    },
    camera: { positionWC: new Cesium.Cartesian3(0, 0, 1e8) },
  });
  const cones = () => {
    const indexes = [];
    for (let i = 0; i < collection.length; i++)
      indexes.push(Number(collection.get(i).id.split('-').at(-1)));
    return [Math.min(...indexes), Math.max(...indexes)];
  };
  cones.count = () => collection?.length ?? 0;
  return cones;
}

test('the cones follow the open photo to another page of a long sequence, cached or not', async (t) => {
  const size = SEQUENCE_PAGE_SIZE;
  const env = await mounted({
    sequences: { s: Array.from({ length: size * 5 }, (_, i) => i) },
  });
  const cones = await withCones(t, env);
  const drawnAround = (index) =>
    until(
      () =>
        !env.instance.sequenceStats().loading &&
        cones.count() > 0 &&
        cones()[0] <= index &&
        cones()[1] >= index,
    );
  await env.instance.viewer.open('s-10');
  await env.instance.selectSequence('s');
  assert.ok(await drawnAround(10));
  assert.ok(cones()[1] < size, `first page: ${cones()}`);
  // A line click further along the same drive: the core does not reselect.
  await env.instance.viewer.open(`s-${size * 4 + 10}`);
  assert.ok(await drawnAround(size * 4 + 10), `re-centred: ${cones()}`);
  assert.ok(cones()[0] >= size * 3, `re-centred: ${cones()}`);
  // Closed and reopened on another page: not the sequence's cached cones.
  env.instance.clearSequence();
  await env.instance.viewer.open(`s-${size * 2 + 10}`);
  await env.instance.selectSequence('s');
  assert.ok(await drawnAround(size * 2 + 10), `around the photo: ${cones()}`);
});

test('a storage hiccup is not remembered as an archived photo', async () => {
  const env = setup({ nearest: [photoRecord('near', { metres: 3 })] });
  let answer = null;
  env.source.probeImage = async () => answer;
  // No answer: the photo is tried rather than called archived.
  assert.equal(
    await env.instance.nearestImage({ lat: 42.3314, lon: -83.0458 }),
    'near',
  );
  answer = false;
  await assert.rejects(
    env.instance.nearestImage({ lat: 42.3314, lon: -83.0458 }),
    /archived/,
    'asked again, and now it is gone',
  );
});

test('a photo far past a run of deleted photos still finds its page and neighbours', async () => {
  const indexes = [
    ...Array.from({ length: 1000 }, (_, i) => i),
    ...Array.from({ length: 20 }, (_, i) => 6000 + i),
  ];
  const { instance, poses, next, prev, source } = await mounted({
    sequences: { s: indexes },
  });
  await instance.viewer.open('s-6005');
  // Both ends checks have found a neighbour (and probed it) before the look.
  const probed = (id) =>
    source.calls.probes.some((url) => url.endsWith(`/${id}.jpg`));
  assert.ok(await until(() => probed('s-6004') && probed('s-6006')));
  await settle();
  assert.equal(next.disabled, false);
  assert.equal(prev.disabled, false);
  await press(next, poses);
  assert.equal(poses.at(-1), 's-6006');
});

test('coverage tiles are kept for a while: panning back asks KartaView nothing', async () => {
  let now = 0;
  const asked = [];
  const tiles = createTileCache({
    load: async (tile) => {
      asked.push(`${tile.z}/${tile.x}/${tile.y}`);
      return { sequences: [], overview: [] };
    },
    size: 2,
    ttlMs: 1000,
    now: () => now,
  });
  const a = { x: 1, y: 2, z: 14 };
  const b = { x: 2, y: 2, z: 14 };
  const c = { x: 3, y: 2, z: 14 };
  const first = await tiles.get(a, {});
  assert.equal(await tiles.get(a, {}), first, 'the same decoded tile');
  await tiles.get(b, {});
  await tiles.get(c, {});
  await tiles.get(a, {});
  assert.deepEqual(
    asked,
    ['14/1/2', '14/2/2', '14/3/2', '14/1/2'],
    'oldest dropped',
  );
  now = 2000;
  await tiles.get(a, {});
  assert.equal(asked.length, 5, 'stale after the TTL');
  // The same x/y at another zoom is another tile.
  await tiles.get({ ...a, z: 13 }, {});
  assert.deepEqual(asked.at(-1), '13/1/2');
  assert.equal(asked.length, 6);
  // A failed load is not kept.
  const failing = createTileCache({
    load: async () => {
      throw new Error('KartaView did not answer in time — try again');
    },
    size: 2,
    ttlMs: 1000,
  });
  await assert.rejects(failing.get(a, {}), /did not answer/);
});

test('a page in id order, its indexes out of order, still steps in index order', async () => {
  const { instance, poses, next, prev } = await mounted({
    sequences: { s: [0, 2, 1, 3, 4] },
  });
  await instance.viewer.open('s-0');
  await press(next, poses);
  assert.equal(poses.at(-1), 's-1');
  await press(next, poses);
  assert.equal(poses.at(-1), 's-2');
  await press(prev, poses);
  assert.equal(poses.at(-1), 's-1');
});

test('a sequence page that failed once is asked again: › then reaches the next photo', async () => {
  const env = await mounted({ sequences: { s: [0, 1, 2, 3] } });
  const real = env.source.getSequencePhotos;
  let fail = true;
  env.source.getSequencePhotos = async (...args) => {
    env.source.calls.pages.push('failing');
    if (fail) throw new Error('KartaView did not answer in time — try again');
    return real(...args);
  };
  await env.instance.viewer.open('s-1');
  // The ends checks ask for the page and get no answer.
  assert.ok(await until(() => env.source.calls.pages.includes('failing')));
  await settle();
  fail = false;
  await press(env.next, env.poses);
  assert.equal(env.poses.at(-1), 's-2');
});

test('a lookup overtaken while it probes shares the probe with the next one, which finds the photo', async () => {
  const env = setup({ nearest: [photoRecord('kept', { metres: 9 })] });
  let answer;
  env.source.probeImage = (url) => {
    env.source.calls.probes.push(url);
    return new Promise((resolve) => (answer = resolve));
  };
  env.source.nearestPhotos = async (point, { signal } = {}) => {
    signal?.throwIfAborted();
    return [photoRecord('kept', { metres: 9 })];
  };
  const point = { lat: 42.3314, lon: -83.0458 };
  const controller = new AbortController();
  const first = env.instance.nearestImage(point, { signal: controller.signal });
  assert.ok(await until(() => env.source.calls.probes.length === 1));
  controller.abort(new Error('overtaken'));
  const second = env.instance.nearestImage(point);
  await settle();
  answer(true);
  assert.equal(await second, 'kept');
  await first.catch(() => {});
  assert.equal(env.source.calls.probes.length, 1, 'one probe, shared');
  // A definite answer is kept: the next lookup asks storage nothing.
  assert.equal(await env.instance.nearestImage(point), 'kept');
  assert.equal(env.source.calls.probes.length, 1);
  // A lookup aborted before KartaView answers gives up.
  const late = new AbortController();
  late.abort(new Error('closed'));
  await assert.rejects(
    env.instance.nearestImage(point, { signal: late.signal }),
    /closed/,
  );
});

test('a probe that fails outright is tried, and asked again next time', async () => {
  const env = setup({ nearest: [photoRecord('near', { metres: 3 })] });
  let probe = async () => {
    throw new TypeError('Failed to fetch');
  };
  env.source.probeImage = (url) => probe(url);
  const point = { lat: 42.3314, lon: -83.0458 };
  assert.equal(await env.instance.nearestImage(point), 'near');
  probe = async () => false;
  await assert.rejects(env.instance.nearestImage(point), /archived/);
});

test('a photo past the last page asks for no page beyond it', async () => {
  const env = await mounted({
    sequences: { s: Array.from({ length: 10 }, (_, i) => i) },
  });
  // KartaView knows photo 12, but no page lists it (moved or re-indexed).
  const getPhoto = env.source.getPhoto;
  env.source.getPhoto = async (id) =>
    id === 's-12'
      ? photoRecord('s-12', { seq: 's', index: 12, metres: 60 })
      : getPhoto(id);
  await env.instance.viewer.open('s-12');
  await press(env.prev, env.poses);
  assert.equal(env.poses.at(-1), 's-9');
  assert.deepEqual([...new Set(env.source.calls.pages)], ['s:1']);
});

test('the cones re-centre when ‹ › walk off the page they were drawn from', async (t) => {
  const size = SEQUENCE_PAGE_SIZE;
  const env = await mounted({
    sequences: { s: Array.from({ length: size * 3 }, (_, i) => i) },
  });
  const cones = await withCones(t, env);
  const settled = () =>
    until(() => !env.instance.sequenceStats().loading && cones.count() > 0);
  // Near the start of page 2: the cones show page 2 alone.
  await env.instance.viewer.open(`s-${size + 12}`);
  await env.instance.selectSequence('s');
  assert.ok(await settled());
  assert.deepEqual(cones(), [size, size * 2 - 1]);
  // ‹ back across the edge onto page 1.
  for (let k = 0; k < 13; k++) await press(env.prev, env.poses);
  assert.equal(env.poses.at(-1), `s-${size - 1}`);
  assert.ok(
    await until(() => cones()[0] < size),
    `drawn around page 1 now: ${cones()}`,
  );
  // › forward, off the far end of page 2.
  await env.instance.viewer.open(`s-${size * 2 - 13}`);
  assert.ok(await until(() => cones()[0] >= size), `${cones()}`);
  for (let k = 0; k < 13; k++) await press(env.next, env.poses);
  assert.equal(env.poses.at(-1), `s-${size * 2}`);
  assert.ok(
    await until(() => cones()[1] >= size * 2),
    `drawn around page 3 now: ${cones()}`,
  );
});

test('the imagery filter thins the cones by each photo’s upload date and projection', async (t) => {
  const env = await mounted(
    { sequences: { s: [0, 1, 2, 3] } },
    { filter: { pano: 'pano', sinceMs: Date.now() - 86_400_000 } },
  );
  // 0 and 1: 360° photos uploaded an hour ago (taken in 2016, as all);
  // 2 and 3: flat ones uploaded in 2016.
  const shaped = (record) =>
    Number(record.sequenceIndex) < 2
      ? {
          ...record,
          projection: 'SPHERE',
          fieldOfView: '360',
          dateAdded: shotAgo(3_600_000).slice(0, 19),
        }
      : { ...record, dateAdded: '2016-08-24 04:01:07' };
  const getPhoto = env.source.getPhoto;
  env.source.getPhoto = async (id) => shaped(await getPhoto(id));
  const getPage = env.source.getSequencePhotos;
  env.source.getSequencePhotos = async (...args) => {
    const page = await getPage(...args);
    return { ...page, photos: page.photos.map(shaped) };
  };
  const cones = await withCones(t, env);
  await env.instance.viewer.open('s-1');
  await env.instance.selectSequence('s');
  assert.ok(await until(() => !env.instance.sequenceStats().loading));
  assert.equal(env.instance.sequenceStats().images, 4, 'the drive is whole');
  assert.equal(cones.count(), 2, 'the 360° photos uploaded since yesterday');
  assert.deepEqual(cones(), [0, 1]);
  env.actions.filter = { pano: 'flat', sinceMs: null };
  env.instance.setFilter();
  assert.deepEqual(cones(), [2, 3], 'the flat ones');
  env.actions.filter = { pano: 'all', sinceMs: null };
  env.instance.setFilter();
  assert.equal(cones.count(), 4, 'every cone, unfiltered');
});

/**
 * The provider drawing coverage on a stand-in viewer above one z14 tile.
 * `lines` are the tile's tracks as [lon, lat] pairs; `getTile` may be held.
 */
function coverageSetup(
  t,
  { lines = [], filter, height = 900, drawnRows = () => [] } = {},
) {
  // A filtered tile's mask: 512 px square, drawn on the rows
  // `drawnRows(query)` lists as [from, to].
  const env = setup(
    {},
    { filter },
    {
      readMask: async ({ query }) => {
        const alpha = new Uint8Array(512 * 512);
        for (const [from, to] of drawnRows(query))
          alpha.fill(255, from * 512, (to + 1) * 512);
        return { width: 512, height: 512, alpha };
      },
    },
  );
  const masks = [];
  let maskHold = null;
  env.source.getTileMask = async (tile, query) => {
    masks.push(query);
    await maskHold;
    return { query };
  };
  const centre = tileCentre(-83.0458, 42.3314);
  const viewer = coverageViewer(
    { lon: centre.lon, lat: centre.lat, height },
    t,
  );
  const tiles = [];
  let hold = null;
  env.source.getTile = (tile) => {
    tiles.push(`${tile.z}/${tile.x}/${tile.y}`);
    const answer = {
      lines: lines.map((track) => ({
        track: track.map(([lon, lat]) => ({
          lat: String(lat),
          lng: String(lon),
        })),
      })),
    };
    return hold ? hold.then(() => answer) : Promise.resolve(answer);
  };
  env.instance.init(viewer);
  t.after(() => env.instance.destroy(viewer));
  return {
    ...env,
    viewer,
    centre,
    tiles,
    masks,
    holdMasks() {
      let release;
      maskHold = new Promise((resolve) => (release = resolve));
      return () => {
        maskHold = null;
        release();
      };
    },
    holdTiles() {
      let release;
      hold = new Promise((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

test('a filter thins the lines to those its PNG mask draws; without one they all show', async (t) => {
  const { lon, lat } = tileCentre(-83.0458, 42.3314);
  // Across the tile's middle row (mask row ~256), and a quarter up (~130).
  const across = (at) => [
    [lon - 0.001, at],
    [lon + 0.001, at],
  ];
  const env = coverageSetup(t, {
    filter: { pano: 'pano', sinceMs: null },
    lines: [across(lat), across(lat + 0.004)],
    // 360° photos lie on the middle line only.
    drawnRows: (query) => (query === 'fieldOfView=360' ? [[254, 258]] : []),
  });
  env.instance.activate(env.viewer);
  assert.ok(await until(() => env.instance.coverageStats().count === 1));
  assert.deepEqual(env.masks, ['fieldOfView=360']);
  // Unfiltered: every line, and the tile's lines are not asked for again.
  env.actions.filter = { pano: 'all', sinceMs: null };
  env.instance.setFilter();
  assert.ok(await until(() => env.instance.coverageStats().count === 2));
  assert.equal(env.tiles.length, 1, 'the segments are kept');
  // SINCE a day: uploaded since yesterday (UTC) — none here. The lines
  // drawn now stay on the globe while KartaView draws the filtered tile.
  const since = Date.now() - 86_400_000;
  const release = env.holdMasks();
  env.actions.filter = { pano: 'all', sinceMs: since };
  env.instance.setFilter();
  assert.ok(await until(() => env.instance.coverageStats().loading));
  assert.ok(
    env.viewer.scene.groundPrimitives.items.size > 0,
    'the unfiltered lines show meanwhile',
  );
  release();
  assert.ok(
    await until(
      () =>
        !env.instance.coverageStats().loading &&
        env.instance.coverageStats().count === 0,
    ),
  );
  assert.equal(
    env.masks.at(-1),
    `startDate=${new Date(since).toISOString().slice(0, 10)}`,
  );
  assert.equal(env.instance.coverageStats().hint, NO_COVERAGE_HINT);
  assert.ok(
    await until(() => env.viewer.scene.groundPrimitives.items.size === 0),
    'and go once it is in',
  );
  // The same filter again asks KartaView for nothing.
  env.instance.setFilter();
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(env.masks.length, 2);
});

test('coverage hints: zoom in from too high, “no photos” only once an empty view has loaded', async (t) => {
  const env = coverageSetup(t, { height: 7_000 });
  env.instance.activate(env.viewer);
  assert.equal(env.instance.coverageStats().hint, TOO_HIGH_HINT);
  assert.deepEqual(env.tiles, [], 'nothing asked from up there');
  const release = env.holdTiles();
  env.viewer.view.height = 900;
  env.instance.refreshCoverage();
  assert.ok(await until(() => env.instance.coverageStats().loading));
  assert.equal(env.instance.coverageStats().hint, '', 'not while it loads');
  release();
  assert.ok(await until(() => !env.instance.coverageStats().loading));
  assert.equal(env.instance.coverageStats().count, 0);
  assert.equal(env.instance.coverageStats().hint, NO_COVERAGE_HINT);
});

test('coverage tiles are kept while KartaView is on and dropped once it is switched off', async (t) => {
  const env = coverageSetup(t, {
    lines: [
      [
        [-83.0458 - 0.001, 42.3314],
        [-83.0458 + 0.001, 42.3314],
      ],
    ],
  });
  env.instance.activate(env.viewer);
  assert.ok(await until(() => env.instance.coverageStats().count === 1));
  env.instance.refreshCoverage();
  assert.ok(await until(() => env.instance.coverageStats().count === 1));
  assert.equal(env.tiles.length, 1, 'kept while on');
  // Switched off: the decoded lines are not kept, so on again asks again.
  env.instance.deactivate();
  env.instance.activate(env.viewer);
  assert.ok(await until(() => env.instance.coverageStats().count === 1));
  assert.equal(env.tiles.length, 2);
});

test('a photo no page lists steps to the photos either side of its index', async () => {
  const env = await mounted({ sequences: { s: [0, 1, 2, 3, 4, 6, 7, 8, 9] } });
  const getPhoto = env.source.getPhoto;
  env.source.getPhoto = async (id) =>
    id === 's-5'
      ? photoRecord('s-5', { seq: 's', index: 5, metres: 25 })
      : getPhoto(id);
  await env.instance.viewer.open('s-5');
  await press(env.next, env.poses);
  assert.equal(env.poses.at(-1), 's-6');
  await env.instance.viewer.open('s-5');
  await press(env.prev, env.poses);
  assert.equal(env.poses.at(-1), 's-4');
});

test('Esc in the docked viewer clears the selected drive and is consumed; with none, it goes on to the panel', async (t) => {
  const env = await mounted({ sequences: { s: [0, 1, 2, 3] } });
  await withCones(t, env);
  await env.instance.viewer.open('s-1');
  await env.instance.selectSequence('s');
  assert.ok(await until(() => env.instance.sequenceStats().images === 4));
  const root = env.next.parentNode;
  const press = () => {
    const flags = { stopped: false, prevented: false };
    root.fire('keydown', {
      key: 'Escape',
      stopPropagation: () => (flags.stopped = true),
      preventDefault: () => (flags.prevented = true),
    });
    return flags;
  };
  assert.deepEqual(press(), { stopped: true, prevented: true });
  assert.equal(env.instance.sequenceStats().selectedId, null, 'drive cleared');
  assert.deepEqual(press(), { stopped: false, prevented: false });
});

test('the panel counts the drive’s photos, not the thinned page of them the cones show', async (t) => {
  const env = await mounted({
    sequences: { s: Array.from({ length: 40 }, (_, i) => i) },
  });
  const asked = [];
  env.source.getSequenceCount = async (id) => {
    asked.push(id);
    return 2385;
  };
  await withCones(t, env);
  await env.instance.viewer.open('s-3');
  await env.instance.selectSequence('s');
  assert.ok(
    await until(() => env.instance.sequenceStats().images === 2385),
    `images: ${env.instance.sequenceStats().images}`,
  );
  // Asked once per drive.
  env.instance.clearSequence();
  await env.instance.viewer.open('s-30');
  await env.instance.selectSequence('s');
  assert.ok(await until(() => env.instance.sequenceStats().images === 2385));
  assert.deepEqual(asked, ['s']);
});

test('after a GPU reset the photo is drawn again by the viewer, not through the core; a failure is reported', async () => {
  const source = fakeSource();
  const record = {
    ...photoRecord('pano', { seq: 'p', index: 0 }),
    projection: 'SPHERE',
    fieldOfView: '360',
    filepathProc: '2022/10/6/wrapped_proc/pano.jpg',
  };
  source.getPhoto = async () => record;
  const view = { yaw: 0, pitch: 0, fov: 80 };
  let failLoads = false;
  const definition = createKartaViewProvider({
    source,
    viewerOptions: {
      load: async (url) => {
        if (failLoads)
          throw new Error('The KartaView photo could not be loaded');
        return { src: url };
      },
      createRenderer: () => ({
        setImage() {},
        setView: (next) => Object.assign(view, next),
        getView: () => ({ ...view }),
        resize() {},
        clear() {},
        destroy() {},
      }),
    },
  });
  const { context, actions } = fakeContext();
  const errors = [];
  context.actions.reportError = (message) => errors.push(message);
  const instance = definition.create(context);
  actions.instance = instance;
  const host = fakeHost();
  await instance.viewer.mount(host);
  const poses = [];
  instance.viewer.onPose((pose) => poses.push(pose.imageId));
  await instance.viewer.open('pano');
  const canvas = () => host.children[0].children[1];
  const kind = () => host.children[0].dataset.kind;
  canvas().fire('webglcontextlost');
  assert.equal(kind(), '', 'cleared while it is drawn again');
  assert.ok(await until(() => kind() === 'pano'), 'drawn again');
  assert.ok(poses.length >= 2);
  assert.deepEqual(actions.opened, [], 'the core (and its lookup) left alone');
  failLoads = true;
  canvas().fire('webglcontextlost');
  assert.ok(await until(() => errors.length === 1));
  assert.match(errors[0], /could not be loaded/);
});

test('the marker is KartaView’s own cone, and it points along the drive, not at a wrong compass', async () => {
  const env = setup({
    sequences: { s: Array.from({ length: 10 }, (_, i) => i) },
  });
  assert.deepEqual(env.definition.marker, {
    kind: 'view-cone',
    color: '#635bff',
  });
  // Photos run east (photoRecord puts index i at 5·i m east); the compass says 200°.
  const getPhoto = env.source.getPhoto;
  env.source.getPhoto = async (id) => ({
    ...(await getPhoto(id)),
    heading: '200',
  });
  const getPage = env.source.getSequencePhotos;
  env.source.getSequencePhotos = async (...args) => {
    const page = await getPage(...args);
    return {
      ...page,
      photos: page.photos.map((record) => ({ ...record, heading: '200' })),
    };
  };
  const host = fakeHost();
  await env.instance.viewer.mount(host);
  const bearings = [];
  env.instance.viewer.onPose((pose) => bearings.push(pose.bearing));
  await env.instance.viewer.open('s-4');
  assert.equal(bearings[0], 200, 'the compass until the drive is known');
  assert.ok(
    await until(() => Math.abs(bearings.at(-1) - 90) < 1),
    `then along the drive: ${bearings}`,
  );
});

/** Hold `seq`'s page `page` until the returned function is called. */
function holdPage(source, seq, page) {
  const getPage = source.getSequencePhotos;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  source.getSequencePhotos = async (id, options) => {
    if (id === seq && options.page === page) await gate;
    return getPage(id, options);
  };
  return () => release();
}

test('a photo opened while the cones first load is the one they centre on', async (t) => {
  const size = SEQUENCE_PAGE_SIZE;
  const env = await mounted({
    sequences: { s: Array.from({ length: size * 5 }, (_, i) => i) },
  });
  const cones = await withCones(t, env);
  const release = holdPage(env.source, 's', 1);
  await env.instance.viewer.open('s-10');
  const selected = env.instance.selectSequence('s');
  // A line click further along the drive while page 1 is still loading:
  // nothing is drawn yet for its re-centre to move.
  await env.instance.viewer.open(`s-${size * 4 + 10}`);
  release();
  await selected;
  assert.ok(
    await until(
      () => !env.instance.sequenceStats().loading && cones.count() > 0,
    ),
  );
  assert.ok(
    cones()[0] <= size * 4 + 10 && cones()[1] >= size * 4 + 10,
    `around the newer photo, not the first: ${cones()}`,
  );
});

test('a sequence page that lands while a lost GPU context recovers still draws its cones', async (t) => {
  const env = setup({ sequences: { p: [0, 1, 2, 3] } });
  const sphere = (record) => ({
    ...record,
    projection: 'SPHERE',
    fieldOfView: '360',
    filepathProc: `2022/10/6/wrapped_proc/${record.id}.jpg`,
  });
  const getPhoto = env.source.getPhoto;
  env.source.getPhoto = async (id) => sphere(await getPhoto(id));
  const getPage = env.source.getSequencePhotos;
  env.source.getSequencePhotos = async (...args) => {
    const page = await getPage(...args);
    return { ...page, photos: page.photos.map(sphere) };
  };
  const release = holdPage(env.source, 'p', 1);
  let holdImages = false;
  let releaseImage = null;
  const view = { yaw: 0, pitch: 0, fov: 80 };
  const definition = createKartaViewProvider({
    source: env.source,
    viewerOptions: {
      load: async (url) => {
        if (holdImages) await new Promise((r) => (releaseImage = r));
        return { src: url };
      },
      createRenderer: () => ({
        setImage() {},
        setView: (next) => Object.assign(view, next),
        getView: () => ({ ...view }),
        resize() {},
        clear() {},
        destroy() {},
      }),
    },
  });
  const { context, actions } = fakeContext();
  const errors = [];
  context.actions.reportError = (message) => errors.push(message);
  const instance = definition.create(context);
  actions.instance = instance;
  const cones = await withCones(t, { instance });
  const host = fakeHost();
  await instance.viewer.mount(host);
  await instance.viewer.open('p-0');
  // › to the next panorama; the GPU resets while it loads.
  holdImages = true;
  const opening = instance.viewer.open('p-1');
  assert.ok(await until(() => releaseImage !== null));
  host.children[0].children[1].fire('webglcontextlost');
  const selected = instance.selectSequence('p');
  release();
  await selected;
  assert.ok(
    await until(() => !instance.sequenceStats().loading && cones.count() > 0),
    'the page is drawn, not dropped',
  );
  releaseImage();
  await opening;
  assert.equal(host.children[0].dataset.kind, 'pano', 'p-1 shows');
  // reportError(null) clears; nothing was reported.
  assert.deepEqual(errors.filter(Boolean), []);
});
