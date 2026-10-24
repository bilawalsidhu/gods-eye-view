import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyView,
  installViews,
  isEmbedded,
  keepPanelRendering,
} from './embed.js';
import { createView, viewToParams } from '../view/index.js';

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

test('a view with street-level photos lets the action fly and open them', async () => {
  const viewer = fakeViewer();
  const { calls, run } = recorder();
  const view = createView({
    camera: { lat: 38.5799, lon: -121.4937, altitude_m: 500 },
    street_level: { provider: 'google' },
  });
  const steps = await applyView(view, {
    viewer,
    dataManager: fakeLayers(new Set()),
    run,
  });
  assert.deepEqual(
    calls.map(([name]) => name),
    [
      'set_map_stack',
      'stop_tracking',
      'clear_annotations',
      'show_street_level',
    ],
  );
  assert.deepEqual(calls.at(-1)[1], {
    latitude: 38.5799,
    longitude: -121.4937,
    provider: 'google',
    fly: true,
  });
  assert.equal(viewer.flights.length, 0, 'the action frames the camera');
  assert.ok(steps.every((step) => step.ok));
  assert.equal(steps.at(-1).step, 'show_street_level');
});

test('a link to street-level photos opens them after it restores', async () => {
  const { calls, run } = recorder();
  const toasts = [];
  const panels = [];
  installViews({
    shell: {
      initialRestorePromise: Promise.resolve(),
      _showToast: (text) => toasts.push(text),
      setPanelCollapsed: (...args) => panels.push(args),
    },
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run,
    location: {
      search: '',
      hash: '#v=2&lat=1&lon=2&sl=mapillary,38.58000,-121.49000',
    },
    windowRef: new EventTarget(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [
    [
      'show_street_level',
      {
        latitude: 38.58,
        longitude: -121.49,
        provider: 'mapillary',
        fly: true,
        autoOpen: false,
      },
    ],
  ]);
  assert.deepEqual(
    [toasts, panels],
    [[], []],
    'an opened photo needs no toast or panel nudge',
  );
  // A failure (no key) is not an armed state either.
  const failed = recorder({
    show_street_level: () => ({
      ok: false,
      stage: 'key',
      error: 'needs its key',
    }),
  });
  installViews({
    shell: {
      initialRestorePromise: Promise.resolve(),
      _showToast: (text) => toasts.push(text),
      setPanelCollapsed: (...args) => panels.push(args),
    },
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run: failed.run,
    location: {
      search: '',
      hash: '#v=2&lat=1&lon=2&sl=google,1.00000,2.00000',
    },
    windowRef: new EventTarget(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual([toasts, panels], [[], []]);
});

test('a link that follows an entity keeps the camera: its photos are not opened', async () => {
  const { calls, run } = recorder();
  const params = viewToParams(
    createView({
      camera: { lat: 1, lon: 2 },
      follow: { kind: 'satellite', id: '25544' },
    }),
  );
  params.set('sl', 'mapillary,1.00000,2.00000');
  installViews({
    shell: { initialRestorePromise: Promise.resolve() },
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run,
    location: { search: '', hash: `#${params}` },
    windowRef: new EventTarget(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, []);
});

test('a failing link step does not take the next one with it', async () => {
  const calls = [];
  const run = async (name, args) => {
    calls.push(name);
    if (name === 'annotate_map') throw new Error('marks failed');
    return { ok: true, armed: false, ...args };
  };
  const an = encodeURIComponent(
    JSON.stringify([{ type: 'pin', target: 'Austin' }]),
  );
  installViews({
    shell: { initialRestorePromise: Promise.resolve() },
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run,
    location: {
      search: '',
      hash: `#v=2&lat=1&lon=2&an=${an}&sl=mapillary,1.00000,2.00000`,
    },
    windowRef: new EventTarget(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['annotate_map', 'show_street_level']);
});

test('a plain link never auto-loads a billed photo: it arms the panel and says so; an embedded view opens', async () => {
  const toasts = [];
  const panels = [];
  const { calls, run } = recorder({
    show_street_level: () => ({ ok: true, armed: true }),
  });
  installViews({
    shell: {
      initialRestorePromise: Promise.resolve(),
      _showToast: (text) => toasts.push(text),
      setPanelCollapsed: (id, collapsed, options) =>
        panels.push([id, collapsed, options]),
    },
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run,
    location: {
      search: '',
      hash: '#v=2&lat=1&lon=2&map=photoreal&sl=google,38.57986,-121.49372',
    },
    windowRef: new EventTarget(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls[0][1].autoOpen, false);
  assert.deepEqual(toasts, [
    'Street View is ready: press OPEN GOOGLE STREET VIEW to load it',
  ]);
  assert.deepEqual(
    panels,
    [['street-level-panel', false, { explicit: true }]],
    'the panel opens so OPEN is in view',
  );
  // Adding ?embed=1 to a published link does not lift the gate: the page is
  // still a plain top-level load.
  const framedToasts = [];
  const framedPanels = [];
  const framed = recorder({
    show_street_level: () => ({ ok: true, armed: true }),
  });
  const windowRef = new EventTarget();
  windowRef.document = { body: { classList: { add() {} } } };
  windowRef.parent = { postMessage() {} };
  installViews({
    shell: {
      initialRestorePromise: Promise.resolve(),
      setCleanView() {},
      _showToast: (text) => framedToasts.push(text),
      setPanelCollapsed: (...args) => framedPanels.push(args),
    },
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run: framed.run,
    location: {
      search: '?embed=1',
      hash: '#v=2&lat=1&lon=2&map=photoreal&sl=google,38.57986,-121.49372',
    },
    windowRef,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(framed.calls[0][1].autoOpen, false);
  // In a frame the rail that holds OPEN is hidden: no nudge, no toast.
  assert.deepEqual([framedToasts, framedPanels], [[], []]);
  // Only the panel page's own link (inline embed) is the client's request.
  globalThis.GEV_EMBED_INLINE = true;
  try {
    const inline = recorder({ show_street_level: () => ({ ok: true }) });
    const inlineWindow = new EventTarget();
    inlineWindow.document = { body: { classList: { add() {} } } };
    inlineWindow.postMessage = () => {};
    // The inline panel keeps rendering from a timer; give it inert clocks.
    Object.assign(inlineWindow, {
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval: () => 1,
      clearInterval() {},
    });
    const stop = installViews({
      shell: { initialRestorePromise: Promise.resolve(), setCleanView() {} },
      viewer: fakeViewer(),
      dataManager: fakeLayers(new Set()),
      run: inline.run,
      location: {
        search: '',
        hash: '#v=2&lat=1&lon=2&map=photoreal&sl=google,38.57986,-121.49372',
      },
      windowRef: inlineWindow,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal('autoOpen' in inline.calls[0][1], false);
    stop();
  } finally {
    delete globalThis.GEV_EMBED_INLINE;
  }
  // applyView (a posted view) opens too.
  const posted = recorder();
  await applyView(
    createView({
      camera: { lat: 1, lon: 2 },
      street_level: { provider: 'google' },
    }),
    {
      viewer: fakeViewer(),
      dataManager: fakeLayers(new Set()),
      run: posted.run,
    },
  );
  assert.equal('autoOpen' in posted.calls.at(-1)[1], false);
});

test('a view whose photos fail before any flight still gets its camera', async () => {
  const viewer = fakeViewer();
  const { calls, run } = recorder({
    show_street_level: () => ({
      ok: false,
      stage: 'key',
      error: 'needs its key',
    }),
  });
  const view = createView({
    camera: { lat: 1, lon: 2, altitude_m: 500 },
    street_level: { provider: 'google' },
  });
  const steps = await applyView(view, {
    viewer,
    dataManager: fakeLayers(new Set()),
    run,
  });
  assert.equal(viewer.flights.length, 1, 'the view flies itself');
  assert.deepEqual(
    steps.map((step) => [step.step, step.ok]),
    [
      ['set_map_stack', true],
      ['stop_tracking', true],
      ['clear_annotations', true],
      ['show_street_level', false],
      ['camera', true],
    ],
  );
  assert.ok(calls.some(([name]) => name === 'show_street_level'));
  // A flight that happened (the action reports where) is not repeated.
  const flown = fakeViewer();
  const { run: flownRun } = recorder({
    show_street_level: () => ({
      ok: false,
      stage: 'imagery',
      location: 'Somewhere',
      error: 'no imagery',
    }),
  });
  await applyView(view, {
    viewer: flown,
    dataManager: fakeLayers(new Set()),
    run: flownRun,
  });
  assert.equal(flown.flights.length, 0);
});

test('a link runs its marks and photos in order, and posted views wait behind them', async () => {
  const log = [];
  let releaseStreetLevel = null;
  let releaseMarks = null;
  const run = async (name, args) => {
    log.push(`start:${name}`);
    if (name === 'annotate_map')
      await new Promise((resolve) => {
        releaseMarks = resolve;
      });
    if (name === 'show_street_level')
      await new Promise((resolve) => {
        releaseStreetLevel = resolve;
      });
    log.push(`end:${name}`);
    return {
      ok: true,
      ...(name === 'show_street_level' ? { location: 'x' } : {}),
    };
  };
  const windowRef = new EventTarget();
  windowRef.document = { body: { classList: { add() {} } } };
  // A framing page: answers go to it, not to the app's own window.
  windowRef.parent = {
    postMessage: (message) => log.push(`post:${message.type}`),
  };
  const an = encodeURIComponent(
    JSON.stringify([{ type: 'pin', target: 'Austin' }]),
  );
  installViews({
    shell: { initialRestorePromise: Promise.resolve(), setCleanView() {} },
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run,
    location: {
      search: '?embed=1',
      hash: `#v=2&lat=1&lon=2&an=${an}&sl=mapillary,1.00000,2.00000`,
    },
    windowRef,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // A view arrives while the link's photos are still opening.
  windowRef.dispatchEvent(
    Object.assign(new Event('message'), {
      source: windowRef.parent,
      origin: 'null',
      data: {
        type: 'gev:view',
        id: 'v1',
        view: { camera: { lat: 3, lon: 4 } },
      },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const actions = () => log.filter((entry) => !entry.startsWith('post:'));
  assert.deepEqual(
    actions(),
    ['start:annotate_map'],
    'the photos wait for the marks',
  );
  releaseMarks();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(actions().slice(0, 3), [
    'start:annotate_map',
    'end:annotate_map',
    'start:show_street_level',
  ]);
  assert.ok(
    !log.includes('start:stop_tracking'),
    'the posted view waits for the link',
  );
  releaseStreetLevel();
  for (
    let tick = 0;
    tick < 20 && !log.includes('post:gev:view-applied');
    tick++
  )
    await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    log.indexOf('end:show_street_level') < log.indexOf('start:stop_tracking'),
    true,
  );
  assert.ok(log.includes('post:gev:view-applied'), log.join(' '));
});

test('an aborted install never runs the link photos', async () => {
  const { calls, run } = recorder();
  const controller = new AbortController();
  controller.abort();
  installViews({
    shell: { initialRestorePromise: Promise.resolve() },
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run,
    signal: controller.signal,
    location: {
      search: '',
      hash: '#v=2&lat=1&lon=2&sl=google,1.00000,2.00000',
    },
    windowRef: new EventTarget(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, []);
});

test('a passive link stands down when someone navigated while it waited behind its marks', async () => {
  const calls = [];
  let releaseMarks = null;
  const shell = {
    initialRestorePromise: Promise.resolve(),
    _navigationGeneration: 7,
  };
  const run = async (name) => {
    calls.push(name);
    if (name === 'annotate_map')
      await new Promise((resolve) => {
        releaseMarks = resolve;
      });
    return { ok: true };
  };
  const an = encodeURIComponent(
    JSON.stringify([{ type: 'pin', target: 'Austin' }]),
  );
  installViews({
    shell,
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run,
    location: {
      search: '',
      hash: `#v=2&lat=1&lon=2&an=${an}&sl=mapillary,1.00000,2.00000`,
    },
    windowRef: new EventTarget(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['annotate_map']);
  shell._navigationGeneration = 8; // the recipient searched, or the assistant flew
  releaseMarks();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(
    calls,
    ['annotate_map'],
    'the link did not fly over the newer navigation',
  );

  // Unchanged navigation: the photos open as before.
  const quiet = [];
  installViews({
    shell: {
      initialRestorePromise: Promise.resolve(),
      _navigationGeneration: 3,
    },
    viewer: fakeViewer(),
    dataManager: fakeLayers(new Set()),
    run: async (name) => {
      quiet.push(name);
      return { ok: true };
    },
    location: {
      search: '',
      hash: `#v=2&lat=1&lon=2&an=${an}&sl=mapillary,1.00000,2.00000`,
    },
    windowRef: new EventTarget(),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(quiet, ['annotate_map', 'show_street_level']);
});
