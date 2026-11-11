import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { createSessionHandoff } from '../app/sessionHandoff.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEngineAddress,
  createEngineSwitch,
  handOffSession,
  resumeSession,
  waitForFirstFrame,
} from './engineSwitch.js';

const ORIGIN = 'https://gev.test/';

/** A browser history with entries, Back/Forward and the page address. */
function fakeBrowser(urls) {
  const entries = urls.map((url) => ({
    url: new URL(url, ORIGIN).href,
    state: null,
  }));
  let index = entries.length - 1;
  const location = {
    get href() {
      return entries[index].url;
    },
  };
  const history = {
    get state() {
      return entries[index].state;
    },
    replaceState(state, _title, url) {
      entries[index] = { url: new URL(url, location.href).href, state };
    },
    pushState(state, _title, url) {
      entries.splice(index + 1);
      entries.push({ url: new URL(url, location.href).href, state });
      index += 1;
    },
  };
  return {
    location,
    history,
    entries,
    go(delta) {
      index += delta;
    },
    get index() {
      return index;
    },
    engines: () =>
      entries.map(({ url }) => new URL(url).searchParams.get('engine')),
    requested: () =>
      new URL(location.href).searchParams.get('engine') ?? 'cesium',
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A layer session with the parts a handoff parks and resumes. */
function fakeSession(log) {
  const module = (id, extra = {}) => ({
    attachRenderer() {},
    resumeViewport: () => log.push(`viewport:${id}`),
    ...extra,
  });
  const layers = new Map([
    ['flights', { module: module('flights') }],
    [
      'directions',
      {
        module: module('directions', {
          cameraOwner: {
            suspend: () => log.push('suspend:directions'),
            resume: () => log.push('resume:directions'),
          },
        }),
      },
    ],
    [
      'satellites',
      {
        module: module('satellites', {
          cameraOwner: { suspend: () => log.push('suspend:satellites'), resume() {} },
        }),
      },
    ],
  ]);
  return {
    handoff: null,
    manager: {
      layers,
      resumeScene() {
        for (const { module } of layers.values()) module.resumeViewport();
        for (const { module } of layers.values()) module.cameraOwner?.resume();
      },
      isEffectivelyEnabled: (id) => id === 'flights',
    },
    director: {
      suspendScene: () => log.push('suspend:director'),
      resumeScene: () => log.push('resume:director'),
      destroy: () => log.push('destroy:director'),
    },
  };
}

/**
 * The machine wired to a fake browser, session and renderers. `outcome(kind,
 * attempt)` may return a promise or throw to script each start.
 */
function harness({
  urls = ['/?engine=cesium'],
  kind = 'cesium',
  outcome,
} = {}) {
  const browser = fakeBrowser(urls);
  const lifetime = new AbortController();
  const log = [];
  const remembered = [];
  const failures = [];
  const session = fakeSession(log);
  // Parked renderers: a start of a parked engine is warm, any other cold.
  const parked = new Set();
  let running = kind;
  const machine = createEngineSwitch({
    kind,
    requested: browser.requested,
    signal: lifetime.signal,
    async leave(from, to) {
      log.push(`leave:${from}->${to}`);
      session.handoff = createSessionHandoff(session, { addressLayerIds: session.addressLayerIds });
      handOffSession(session);
      parked.add(from);
      running = null;
    },
    async enter(next, attempt) {
      const warm = parked.delete(next);
      log.push(
        `enter:${next}:${warm ? 'warm' : 'cold'}${attempt.recovery ? ':recovery' : ''}`,
      );
      await outcome?.(next, { ...attempt, warm });
      running = next;
      await resumeSession(session);
    },
    address: createEngineAddress({
      location: browser.location,
      history: browser.history,
      flush: () => log.push('flush'),
    }),
    settle: () => {
      if (running) session.handoff = null;
    },
    remember: (next) => remembered.push(next),
    onFailure: (error, outcome) =>
      failures.push({ message: error.message, ...outcome }),
  });
  return {
    browser,
    lifetime,
    log,
    remembered,
    failures,
    session,
    parked,
    machine,
  };
}

test('a picked engine hands the session off and adds one history entry', async () => {
  const h = harness({ urls: ['/?welcome=0#lat=1'] });
  await h.machine.select('navara');
  assert.deepEqual(h.browser.engines(), ['cesium', 'navara']);
  assert.equal(new URL(h.browser.entries[0].url).hash, '#lat=1');
  assert.deepEqual(h.remembered, ['navara']);
  assert.deepEqual(h.log, [
    'flush',
    'leave:cesium->navara',
    'suspend:directions',
    'suspend:satellites',
    'suspend:director',
    'enter:navara:cold',
    'viewport:flights',
    'viewport:directions',
    'viewport:satellites',
    'resume:directions',
    'resume:director',
  ]);
  assert.equal(h.machine.state().kind, 'navara');
  assert.equal(h.machine.state().busy, false);
});

test('Back and Forward hand the session off exactly like the picker', async () => {
  const h = harness();
  // The outgoing address lists flights; directions run off the record.
  h.session.addressLayerIds = ['flights'];
  let captured;
  h.session.director.suspendScene = () => {
    captured = h.session.handoff.layers;
    h.log.push('suspend:director');
  };
  await h.machine.select('navara');
  const picked = h.log.splice(0).filter((line) => line !== 'flush');
  const record = (handoff) =>
    Object.fromEntries(
      [...handoff].map(([id, { enabled, durable }]) => [
        id,
        { enabled, durable },
      ]),
    );
  const afterPick = record(captured);
  assert.deepEqual(afterPick.flights, { enabled: true, durable: true });
  assert.deepEqual(afterPick.directions, { enabled: false, durable: false });
  h.browser.go(-1);
  await h.machine.reconcile();
  assert.equal(h.machine.state().kind, 'cesium');
  // The same handoff, mirrored: layers retained, cameras and Director parked
  // and resumed, nothing destroyed.
  assert.deepEqual(
    h.log,
    picked.map((line) =>
      line
        .replace('leave:cesium->navara', 'leave:navara->cesium')
        .replace('enter:navara:cold', 'enter:cesium:warm'),
    ),
  );
  assert.ok(!h.log.includes('destroy:director'));
  // The visit records the same running state and outgoing address; the
  // layer-state coordinator compares that with the visited entry.
  assert.deepEqual(record(captured), afterPick);
  assert.equal('entry' in captured.get('flights'), false);
  h.browser.go(1);
  await h.machine.reconcile();
  assert.equal(h.machine.state().kind, 'navara');
  assert.ok(h.log.includes('leave:cesium->navara'));
  // History visits neither add entries nor change the stored choice.
  assert.deepEqual(h.browser.engines(), ['cesium', 'navara']);
  assert.deepEqual(h.remembered, ['navara']);
});

test('a visit during a switch is reconciled once the attempt settles', async () => {
  const gate = deferred();
  const h = harness({
    urls: ['/?engine=cesium#before', '/?engine=cesium#now'],
    outcome: (kind) => (kind === 'navara' ? gate.promise : undefined),
  });
  const switching = h.machine.select('navara');
  assert.equal(h.machine.state().busy, true);
  // Back while Navara starts: the earlier entry asks for Cesium.
  h.browser.go(-1);
  const visit = h.machine.reconcile();
  gate.resolve();
  await Promise.all([switching, visit]);
  assert.equal(h.machine.state().kind, 'cesium');
  assert.deepEqual(
    h.log.filter(
      (line) => line.startsWith('enter') || line.startsWith('leave'),
    ),
    [
      'leave:cesium->navara',
      'enter:navara:cold',
      'leave:navara->cesium',
      'enter:cesium:warm',
    ],
  );
  // The pick was superseded before it settled: no entry was pushed for it,
  // and neither entry was rewritten.
  assert.deepEqual(h.browser.engines(), ['cesium', 'cesium']);
  assert.deepEqual(h.remembered, []);
});

test('a pick that fails after Back rewrites no entry', async () => {
  const gate = deferred();
  const h = harness({
    urls: ['/?engine=cesium#a', '/?engine=cesium#b'],
    outcome: (kind) => (kind === 'navara' ? gate.promise : undefined),
  });
  const switching = h.machine.select('navara');
  h.browser.go(-1);
  void h.machine.reconcile();
  gate.reject(new Error('Navara refused'));
  await switching;
  assert.equal(h.machine.state().kind, 'cesium');
  assert.equal(h.browser.index, 0);
  assert.deepEqual(h.browser.engines(), ['cesium', 'cesium']);
  assert.deepEqual(
    h.browser.entries.map(({ url }) => new URL(url).hash),
    ['#a', '#b'],
  );
});

test('rollback goes to the last engine that worked, not the one that just failed', async () => {
  const gate = deferred();
  const h = harness({
    urls: ['/?engine=cesium#before', '/?engine=cesium#now'],
    outcome: (kind, { recovery }) => {
      if (kind === 'navara' && !recovery) return gate.promise;
      if (kind === 'cesium') throw new Error('Cesium refused');
    },
  });
  const switching = h.machine.select('navara');
  h.browser.go(-1);
  void h.machine.reconcile();
  gate.resolve();
  await switching;
  assert.deepEqual(
    h.log.filter((line) => line.startsWith('enter')),
    ['enter:navara:cold', 'enter:cesium:warm', 'enter:navara:warm:recovery'],
  );
  assert.equal(h.machine.state().kind, 'navara');
  assert.equal(h.machine.state().failed, false);
  assert.deepEqual(h.failures, [
    { message: 'Cesium refused', recovered: true, kind: 'navara' },
  ]);
  // The visited entry now names the engine that runs; no entry was added.
  assert.equal(h.browser.index, 0);
  assert.deepEqual(h.browser.engines(), ['navara', 'cesium']);
});

test('a pick made during a switch is queued, not dropped', async () => {
  const gate = deferred();
  const h = harness({
    outcome: (kind, { warm }) =>
      kind === 'navara' && !warm ? gate.promise : undefined,
  });
  const switching = h.machine.select('navara');
  assert.equal(h.machine.select('cesium'), switching);
  gate.resolve();
  await switching;
  assert.equal(h.machine.state().kind, 'cesium');
  assert.deepEqual(h.browser.engines(), ['cesium', 'navara', 'cesium']);
  assert.deepEqual(h.remembered, ['navara', 'cesium']);
});

for (const [from, to] of [
  ['cesium', 'navara'],
  ['navara', 'cesium'],
]) {
  test(`a failed ${from} to ${to} switch rolls back without a history entry`, async () => {
    let refuse = true;
    const h = harness({
      urls: [`/?engine=${from}#view`],
      kind: from,
      outcome: (kind) => {
        if (kind === to && refuse) throw new Error(`${to} refused`);
      },
    });
    await h.machine.select(to);
    assert.equal(h.machine.state().kind, from);
    assert.deepEqual(h.browser.engines(), [from]);
    assert.equal(new URL(h.browser.entries[0].url).hash, '#view');
    assert.deepEqual(h.remembered, []);
    assert.deepEqual(h.failures, [
      { message: `${to} refused`, recovered: true, kind: from },
    ]);
    // The recovery restarts the parked engine on the retained session.
    assert.deepEqual(
      h.log.filter(
        (line) =>
          line.startsWith('enter') || line.startsWith('resume:director'),
      ),
      [`enter:${to}:cold`, `enter:${from}:warm:recovery`, 'resume:director'],
    );
    // An ordinary retry afterwards works.
    refuse = false;
    await h.machine.select(to);
    assert.equal(h.machine.state().kind, to);
    assert.deepEqual(h.browser.engines(), [from, to]);
  });
}

test('a warm start that fails rolls back warm and later starts cold', async () => {
  let refuseWarmNavara = false;
  const h = harness({
    outcome: (kind, { warm, recovery }) => {
      if (kind === 'navara' && warm && refuseWarmNavara && !recovery)
        throw new Error('parked Navara lost');
    },
  });
  await h.machine.select('navara');
  await h.machine.select('cesium');
  refuseWarmNavara = true;
  await h.machine.select('navara');
  assert.equal(h.machine.state().kind, 'cesium');
  await h.machine.select('navara');
  assert.equal(h.machine.state().kind, 'navara');
  assert.deepEqual(
    h.log.filter((line) => line.startsWith('enter')),
    [
      'enter:navara:cold',
      'enter:cesium:warm',
      'enter:navara:warm',
      'enter:cesium:warm:recovery',
      'enter:navara:cold',
    ],
  );
  assert.deepEqual(h.browser.engines(), [
    'cesium',
    'navara',
    'cesium',
    'navara',
  ]);
});

test('after a failed recovery the page stays usable and the next pick starts an engine', async () => {
  let refuse = true;
  const h = harness({
    outcome: () => {
      if (refuse) throw new Error('no WebGL');
    },
  });
  await h.machine.select('navara');
  assert.equal(h.machine.state().failed, true);
  assert.equal(h.machine.state().busy, false);
  assert.deepEqual(
    h.failures.map(({ recovered }) => recovered),
    [false],
  );
  assert.deepEqual(h.browser.engines(), ['cesium']);
  refuse = false;
  // No running engine to leave: the pick starts one directly.
  await assert.doesNotReject(async () => h.machine.select('navara'));
  assert.equal(h.machine.state().kind, 'navara');
  assert.equal(h.machine.state().failed, false);
  assert.equal(h.log.filter((line) => line.startsWith('leave')).length, 1);
  // Nothing ran to return to: the pick names the current entry.
  assert.deepEqual(h.browser.engines(), ['navara']);
});

test('pagehide during a start neither rolls back nor starts another engine', async () => {
  const gate = deferred();
  const entered = deferred();
  const h = harness({
    outcome: (kind) => {
      if (kind !== 'navara') return undefined;
      entered.resolve();
      return gate.promise;
    },
  });
  const switching = h.machine.select('navara');
  await entered.promise;
  h.lifetime.abort();
  gate.reject(new DOMException('aborted', 'AbortError'));
  await switching;
  assert.deepEqual(
    h.log.filter((line) => line.startsWith('enter')),
    ['enter:navara:cold'],
  );
  assert.deepEqual(h.failures, []);
  assert.equal(h.machine.select('cesium'), null);
});

test('pagehide while the outgoing engine is released starts nothing', async () => {
  const gate = deferred();
  const h = harness();
  const enter = [];
  const machine = createEngineSwitch({
    kind: 'cesium',
    requested: h.browser.requested,
    signal: h.lifetime.signal,
    leave: () => gate.promise,
    enter: async (kind) => enter.push(kind),
    address: createEngineAddress({
      location: h.browser.location,
      history: h.browser.history,
    }),
  });
  const switching = machine.select('navara');
  h.lifetime.abort();
  gate.resolve();
  await switching;
  assert.deepEqual(enter, []);
});

test('a slow first frame never rolls back a started engine', async () => {
  const timers = [];
  const engine = createFakeEngine();
  const h = harness();
  let frame;
  const machine = createEngineSwitch({
    kind: 'cesium',
    requested: h.browser.requested,
    signal: h.lifetime.signal,
    leave: async () => {},
    enter: async () => {},
    settle: async () => {
      frame = waitForFirstFrame(engine, {
        document: {
          hidden: false,
          addEventListener() {},
          removeEventListener() {},
        },
        setTimer: (fn) => timers.push(fn),
        clearTimer() {},
      });
      timers.shift()();
      await frame;
    },
    address: createEngineAddress({
      location: h.browser.location,
      history: h.browser.history,
    }),
    onFailure: () => assert.fail('a slow frame must not fail the switch'),
  });
  await machine.select('navara');
  assert.equal(await frame, false);
  assert.equal(machine.state().kind, 'navara');
  assert.deepEqual(h.browser.engines(), ['cesium', 'navara']);
});

test('the first-frame wait resolves on a frame, on a hidden tab and on timeout', async () => {
  const listeners = new Set();
  const doc = {
    hidden: false,
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
  };
  let draw;
  let requests = 0;
  const engine = createFakeEngine();
  engine.frames.postRender.addEventListener = (fn) => {
    draw = fn;
    return () => { draw = null; };
  };
  engine.render.request = () => requests++;
  const timers = new Map();
  const options = {
    document: doc,
    setTimer: (fn) => {
      const id = Symbol('timer');
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  };
  // A drawn frame.
  const drawn = waitForFirstFrame(engine, options);
  draw();
  assert.equal(await drawn, true);
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
  // The tab hides while waiting.
  const hiding = waitForFirstFrame(engine, options);
  doc.hidden = true;
  for (const fn of [...listeners]) fn();
  assert.equal(await hiding, false);
  assert.equal(draw, null);
  // Already hidden: nothing to wait for and no frame requested.
  const before = requests;
  assert.equal(await waitForFirstFrame(engine, options), false);
  assert.equal(requests, before);
  // No frame in time: resolved, never rejected.
  doc.hidden = false;
  const slow = waitForFirstFrame(engine, options);
  [...timers.values()][0]();
  assert.equal(await slow, false);
});

test('the address keeps the outgoing view on the earlier entry', () => {
  const browser = fakeBrowser(['/?look=cinematic#lat=1']);
  const address = createEngineAddress({
    location: browser.location,
    history: browser.history,
  });
  const token = address.select('cesium');
  // The address stays as it is while the picked engine starts.
  assert.deepEqual(browser.engines(), [null]);
  // The incoming engine writes its own view while it starts.
  browser.history.replaceState(
    null,
    '',
    '/?look=cinematic&engine=navara#lat=2',
  );
  address.commit(token, 'navara');
  assert.deepEqual(
    browser.entries.map(({ url }) => url.replace(ORIGIN, '/')),
    [
      '/?look=cinematic&engine=cesium#lat=1',
      '/?look=cinematic&engine=navara#lat=2',
    ],
  );
});

test('a settle failure is not fatal and later requests are still reconciled', async () => {
  const h = harness();
  let settles = 0;
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const machine = createEngineSwitch({
      kind: 'cesium',
      requested: h.browser.requested,
      signal: h.lifetime.signal,
      leave: async () => {},
      enter: async () => {},
      settle: async () => {
        settles += 1;
        if (settles === 1) {
          // A pick arrives while the first reveal fails.
          void machine.select('cesium');
          throw new Error('cover failed');
        }
      },
      address: createEngineAddress({
        location: h.browser.location,
        history: h.browser.history,
      }),
      onFailure: () => assert.fail('a settle error must not report a failure'),
    });
    await machine.select('navara');
    assert.equal(machine.state().kind, 'cesium');
    assert.equal(machine.state().failed, false);
    assert.equal(settles, 2);
    assert.equal(errors.length, 1);
  } finally {
    console.error = original;
  }
});
