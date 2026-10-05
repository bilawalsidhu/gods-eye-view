import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyView,
  installViews,
  isEmbedded,
  keepPanelRendering,
} from './embed.js';
import { createView } from '../view/index.js';

const fakeViewer = () => {
  const flights = [];
  return {
    flights,
    camera: {
      flyTo(options) {
        flights.push(options);
        options.complete();
      },
    },
  };
};
const fakeLayers = (enabled) => ({
  getAll: () =>
    ['flights', 'earthquakes', 'ais-live-vessels'].map((id) => ({
      id,
      enabled: enabled.has(id),
    })),
  isEnabled: (id) => enabled.has(id),
});
const recorder = (answers = {}) => {
  const calls = [];
  const run = async (name, args) => {
    calls.push([name, args]);
    const answer = answers[name];
    return typeof answer === 'function'
      ? answer(calls)
      : (answer ?? { ok: true });
  };
  return { calls, run };
};

test('embed mode is opt-in by query parameter', () => {
  assert.equal(isEmbedded({ search: '?embed=1' }), true);
  assert.equal(isEmbedded({ search: '?welcome=0' }), false);
});

test('a view is applied through the app actions in order', async () => {
  const viewer = fakeViewer();
  const { calls, run } = recorder();
  const view = createView({
    camera: { lat: 25, lon: 121, altitude_m: 300000, pitch_deg: -40 },
    layers: ['ais-live-vessels'],
    style: 'thermal',
    map: 'osm',
    annotations: [{ type: 'pin', target: 'Taipei 101' }],
  });
  const steps = await applyView(view, {
    viewer,
    dataManager: fakeLayers(new Set(['earthquakes'])),
    run,
  });
  assert.deepEqual(
    calls.map(([name, args]) => [
      name,
      args.layerId ?? args.style ?? args.stack ?? null,
      args.enabled ?? null,
    ]),
    [
      ['set_visual_style', 'thermal', null],
      ['set_map_stack', 'osm', null],
      ['set_layer_visibility', 'earthquakes', false],
      ['set_layer_visibility', 'ais-live-vessels', true],
      ['stop_tracking', null, null],
      ['clear_annotations', null, null],
      ['annotate_map', null, null],
    ],
  );
  assert.equal(viewer.flights.length, 1);
  assert.ok(steps.every((step) => step.ok));
  assert.ok(steps.some((step) => step.step === 'camera'));
});

test('a followed entity is retried until its layer has it', async () => {
  let tries = 0;
  const { run } = recorder({
    track_entity: () => ({ ok: ++tries >= 3 }),
  });
  const view = createView({
    camera: { lat: 0, lon: 0 },
    follow: { kind: 'aircraft', id: 'abc123' },
  });
  const steps = await applyView(view, {
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run,
    retryMs: 1,
  });
  assert.equal(tries, 3);
  assert.deepEqual(steps.at(-1), { step: 'follow', ok: true });
});

test('an embedded page takes views only from its parent and answers it', async () => {
  const posted = [];
  const targets = [];
  const parent = {
    postMessage: (message, target) => {
      posted.push(message);
      targets.push(target);
    },
  };
  const windowRef = new EventTarget();
  windowRef.parent = parent;
  windowRef.document = { body: { classList: new Set() } };
  windowRef.document.body.classList.add = Set.prototype.add;
  const shell = {
    initialRestorePromise: Promise.resolve(),
    clean: null,
    setCleanView(value) {
      this.clean = value;
    },
  };
  const { calls, run } = recorder();
  const remove = installViews({
    shell,
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run,
    location: { search: '?embed=1', hash: '' },
    windowRef,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(shell.clean, true);
  assert.deepEqual(posted, [{ type: 'gev:ready' }]);
  const send = (source, data, origin = 'https://host.example') => {
    const event = new Event('message');
    Object.assign(event, { source, data, origin });
    windowRef.dispatchEvent(event);
  };
  send({}, { type: 'gev:view', id: 1, view: { camera: { lat: 1, lon: 2 } } });
  send(parent, { type: 'gev:view', id: 2, view: { camera: {} } });
  send(parent, {
    type: 'gev:view',
    id: 3,
    view: { camera: { lat: 1, lon: 2 }, layers: ['flights'] },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(posted[1], {
    type: 'gev:view-applied',
    id: 2,
    ok: false,
    error: 'A view needs a camera lat and lon',
  });
  assert.equal(posted[2].id, 3);
  assert.equal(posted[2].ok, true);
  assert.ok(
    calls.some(
      ([name, args]) =>
        name === 'set_layer_visibility' && args.layerId === 'flights',
    ),
  );
  assert.equal(posted.filter((message) => message.id === 1).length, 0);
  // Ready names no data and goes to any parent; answers go only to the
  // origin that asked.
  assert.deepEqual(targets, [
    '*',
    'https://host.example',
    'https://host.example',
  ]);
  remove();
});

test('an app loaded inline into a panel page talks through its own window', async () => {
  const posted = [];
  const windowRef = new EventTarget();
  windowRef.parent = windowRef;
  windowRef.postMessage = (message) => posted.push(message);
  windowRef.document = { body: { classList: new Set() } };
  windowRef.document.body.classList.add = Set.prototype.add;
  Object.assign(windowRef, {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setInterval: () => 1,
    clearInterval() {},
  });
  globalThis.GEV_EMBED_INLINE = true;
  try {
    assert.equal(isEmbedded({ search: '' }), true);
    const remove = installViews({
      shell: { initialRestorePromise: Promise.resolve() },
      viewer: fakeViewer(),
      dataManager: fakeLayers(new Set()),
      run: recorder().run,
      location: { search: '', hash: '' },
      windowRef,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(posted, [{ type: 'gev:ready' }]);
    const event = new Event('message');
    Object.assign(event, {
      source: windowRef,
      data: { type: 'gev:view', id: 7, view: { camera: { lat: 1, lon: 2 } } },
    });
    windowRef.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(posted[1].id, 7);
    assert.equal(posted[1].ok, true);
    remove();
  } finally {
    delete globalThis.GEV_EMBED_INLINE;
  }
});

test('annotations in a link are drawn after it restores, embedded or not', async () => {
  const { calls, run } = recorder();
  const an = encodeURIComponent(
    JSON.stringify([{ type: 'pin', target: 'Austin' }]),
  );
  installViews({
    shell: { initialRestorePromise: Promise.resolve() },
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run,
    location: { search: '', hash: `#v=2&lat=1&lon=2&an=${an}` },
    windowRef: new EventTarget(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [
    ['annotate_map', { annotations: [{ type: 'pin', target: 'Austin' }] }],
  ]);
});

test('a panel keeps drawing from a timer while animation frames stop', () => {
  let clock = 0;
  let tick = null;
  let frame = null;
  const windowRef = {
    requestAnimationFrame: (fn) => ((frame = fn), 1),
    cancelAnimationFrame: () => (frame = null),
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval: () => (tick = null),
  };
  const drawn = [];
  const viewer = {
    resize: () => drawn.push('resize'),
    render: () => drawn.push('render'),
  };
  const stop = keepPanelRendering(viewer, { windowRef, now: () => clock });
  // Frames arrive: the render loop draws, so the timer does nothing.
  clock = 100;
  frame();
  tick();
  assert.deepEqual(drawn, []);
  // Frames stop, as in a panel its host reports hidden: the timer draws.
  clock = 400;
  tick();
  assert.deepEqual(drawn, ['resize', 'render']);
  stop();
  assert.equal(tick, null);
  assert.equal(frame, null);
});

test('a panel reports a render error in full and stops drawing', () => {
  let listener = null;
  let tick = null;
  const windowRef = {
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval() {},
  };
  const drawn = [];
  const viewer = {
    resize() {},
    render: () => drawn.push('render'),
    scene: {
      renderError: {
        addEventListener: (fn) => ((listener = fn), () => (listener = null)),
      },
    },
  };
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    let clock = 0;
    const stop = keepPanelRendering(viewer, { windowRef, now: () => clock });
    listener(viewer.scene, { name: 'RuntimeError', message: 'worker failed' });
    assert.match(logged[0], /render error: .*"message":"worker failed"/);
    clock = 1000;
    tick();
    assert.deepEqual(drawn, []);
    stop();
    assert.equal(listener, null);
  } finally {
    console.error = original;
  }
});

test('a followed aircraft owns the camera, and cockpit view is entered after it', async () => {
  const viewer = fakeViewer();
  const { calls, run } = recorder();
  const steps = await applyView(
    createView({
      camera: { lat: 32.7, lon: -117.2 },
      follow: { kind: 'military_aircraft', id: 'AE1234', cockpit: true },
    }),
    { viewer, dataManager: fakeLayers(new Set()), run, retryMs: 0 },
  );
  // Following worked at once, so no camera flight ended it.
  assert.equal(viewer.flights.length, 0);
  assert.deepEqual(calls.slice(-2), [
    ['track_entity', { query: 'ae1234', layerId: 'military' }],
    ['control_cockpit', { action: 'enter', targetLayer: 'military' }],
  ]);
  assert.ok(steps.every((step) => step.ok));
  assert.throws(
    () =>
      createView({
        camera: { lat: 0, lon: 0 },
        follow: { kind: 'satellite', id: '25544', cockpit: true },
      }),
    /no cockpit view/,
  );
});
