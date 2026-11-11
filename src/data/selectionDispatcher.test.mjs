import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import {
  createSelectionDispatcher,
  selectionDispatcherFor,
} from './selectionDispatcher.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  unregisterPickOwner,
} from './pickRegistry.js';

function setup(picks = {}) {
  const engine = createFakeEngine();
  // Scripted picks by window x: what lies under each column.
  engine.fake.script('pick', (screen) => picks[screen.x]?.[0]);
  engine.fake.script('drillPick', (screen, limit) =>
    (picks[screen.x] ?? []).slice(0, limit),
  );
  const keys = new EventTarget();
  let now = 0;
  const dispatcher = createSelectionDispatcher(engine, {
    keyTarget: keys,
    now: () => now,
    isPointerFree: () => true,
  });
  // A press, a release and the engine's click at x (an optional drag).
  const click = (x, { travel = 0, ms = 50 } = {}) => {
    engine.fake.input('down', { position: { x, y: 10 } });
    if (travel)
      engine.fake.input('move', {
        startPosition: { x, y: 10 },
        endPosition: { x: x + travel, y: 10 },
      });
    now += ms;
    engine.fake.input('up', { position: { x: x + travel, y: 10 } });
    engine.fake.input('click', { position: { x: x + travel, y: 10 } });
  };
  const escape = () =>
    keys.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
  return { engine, dispatcher, click, escape };
}

const recorder = () => {
  const calls = [];
  return {
    calls,
    handlers: {
      onSelect: (id, ctx) => calls.push(['select', id, ctx.picked?.owner]),
      onEmptyClick: (ctx) => calls.push(['empty', ctx.gesture.travelPx]),
      onEscape: () => calls.push(['escape']),
    },
  };
};

test('a click on an owned object selects it; empty space deselects everyone', () => {
  const { engine, dispatcher, click } = setup({
    10: [{ id: 'ae01ce', owner: 'flights-fleet', instance: 1 }],
  });
  const flights = recorder();
  const military = recorder();
  dispatcher.register('flights', {
    owns: (id) => id === 'ae01ce',
    ...flights.handlers,
  });
  dispatcher.register('military', {
    owns: (id) => id.startsWith('mil'),
    ...military.handlers,
  });
  click(10);
  click(500);
  assert.deepEqual(flights.calls, [
    ['select', 'ae01ce', 'flights-fleet'],
    ['empty', 0],
  ]);
  assert.deepEqual(military.calls, [['empty', 0]]);
});

test("another layer's pick is not empty space, owned through the shared registry", () => {
  const { engine, dispatcher, click } = setup({ 10: [{ id: 'cctv-1' }] });
  registerPickOwner('cctv', (id) => id.startsWith('cctv'), engine);
  try {
    const flights = recorder();
    dispatcher.register('flights', {
      owns: (id) => id === 'x',
      ...flights.handlers,
    });
    assert.equal(
      isOwnedByOtherLayer('cctv', 'x', engine),
      true,
      'registered for legacy handlers',
    );
    click(10);
    assert.deepEqual(flights.calls, []);
  } finally {
    unregisterPickOwner('cctv', engine);
  }
});

test('a pick no layer owns is empty space, as for the old handlers', () => {
  const { engine, dispatcher, click } = setup({
    10: [{ id: 'unclaimed-entity' }],
  });
  const flights = recorder();
  dispatcher.register('flights', {
    owns: (id) => id === 'x',
    ...flights.handlers,
  });
  click(10);
  click(10, { ms: 900 });
  assert.deepEqual(
    flights.calls,
    [['empty', 0]],
    'a long press does not deselect',
  );
});

test('trails do not take clicks: the object under a trail is selected', () => {
  const { engine, dispatcher, click } = setup({
    10: [{ id: 'trail-ae01ce', owner: 'flights-trail' }, { id: 'ae01ce' }],
  });
  const flights = recorder();
  dispatcher.register('flights', {
    owns: (id) => id === 'ae01ce' || id.startsWith('trail-'),
    passThrough: (picked) => picked.owner === 'flights-trail',
    ...flights.handlers,
  });
  click(10);
  assert.deepEqual(flights.calls, [['select', 'ae01ce', undefined]]);
});

test("a drill-through owner finds its object under another layer's", () => {
  const { engine, dispatcher, click } = setup({
    10: [{ id: 'cctv-1' }, { id: 'adsb:abc' }],
  });
  registerPickOwner('cctv', (id) => id.startsWith('cctv'), engine);
  try {
    const local = recorder();
    dispatcher.register('local-adsb', {
      owns: (id) => id.startsWith('adsb:'),
      drillThrough: true,
      ...local.handlers,
    });
    click(10);
    assert.deepEqual(local.calls, [['select', 'adsb:abc', undefined]]);
  } finally {
    unregisterPickOwner('cctv', engine);
  }
});

test('a drag selects nothing and deselects nothing; a long press still selects', () => {
  const { engine, dispatcher, click } = setup({ 10: [{ id: 'ae01ce' }] });
  const flights = recorder();
  dispatcher.register('flights', {
    owns: (id) => id === 'ae01ce',
    ...flights.handlers,
  });
  click(10, { travel: 20 });
  click(500, { ms: 900 });
  assert.deepEqual(flights.calls, []);
  click(10, { ms: 900 });
  assert.deepEqual(flights.calls, [['select', 'ae01ce', undefined]]);
});

test('Escape reaches every owner; an owner without handlers only owns', () => {
  const { dispatcher, click, escape } = setup({ 10: [{ id: 'quiet-1' }] });
  const flights = recorder();
  dispatcher.register('flights', { owns: () => false, ...flights.handlers });
  dispatcher.register('quiet', { owns: (id) => id.startsWith('quiet') });
  click(10);
  escape();
  assert.deepEqual(flights.calls, [['escape']]);
});

test('unregister and destroy remove the subscriptions', () => {
  const { engine, dispatcher, click, escape } = setup({ 10: [{ id: 'a' }] });
  const flights = recorder();
  const off = dispatcher.register('flights', {
    owns: (id) => id === 'a',
    ...flights.handlers,
  });
  off();
  click(10);
  escape();
  assert.deepEqual(flights.calls, []);
  dispatcher.register('flights', {
    owns: (id) => id === 'a',
    ...flights.handlers,
  });
  dispatcher.destroy();
  click(10);
  assert.deepEqual(flights.calls, []);
  assert.equal(isOwnedByOtherLayer('other', 'a', engine), false);
  assert.ok(engine.fake.callsOf('input.on').length >= 1);
});

test('the application has one dispatcher per engine', () => {
  const engine = createFakeEngine();
  const other = createFakeEngine();
  assert.equal(selectionDispatcherFor(engine), selectionDispatcherFor(engine));
  assert.notEqual(
    selectionDispatcherFor(engine),
    selectionDispatcherFor(other),
  );
  assert.equal(selectionDispatcherFor(null), null);
  selectionDispatcherFor(engine).destroy();
  selectionDispatcherFor(other).destroy();
});

test('a look-under owner (local ADS-B) keeps its own click rule beside the others', () => {
  // x: what lies under each column, top first.
  const { engine, dispatcher, click } = setup({
    10: [{ id: 'local-adsb:a' }], // its own marker
    20: [{ primitive: { tileset: true } }, { id: 'local-adsb:a' }], // under a tile
    30: [{ id: 'gev-trail:local-adsb-head-1' }, { id: 'local-adsb:b' }], // under a trail
    40: [{ id: 'gev-trail:x' }], // a trail alone
    50: [{ id: 'ae01ce' }, { id: 'local-adsb:a' }], // another layer's on top
    60: [{ id: 'cctv-1' }, { id: 'local-adsb:a' }], // a registry owner's on top
    70: [], // empty map
  });
  registerPickOwner('trails', (id) => id.startsWith('gev-trail:'), engine);
  registerPickOwner('cctv', (id) => id.startsWith('cctv'), engine);
  try {
    const local = recorder();
    const flights = recorder();
    dispatcher.register('local-adsb', {
      owns: (id) => id.startsWith('local-adsb:'),
      lookUnder: (id) => id.startsWith('gev-trail:'),
      ...local.handlers,
    });
    dispatcher.register('flights', {
      owns: (id) => id === 'ae01ce',
      ...flights.handlers,
    });
    for (const x of [10, 20, 30, 40, 50, 60, 70]) click(x);
    // A long press on empty map still reaches it (its old LEFT_CLICK rule).
    click(70, { ms: 900 });
    assert.deepEqual(local.calls, [
      ['select', 'local-adsb:a', undefined],
      ['select', 'local-adsb:a', undefined],
      ['select', 'local-adsb:b', undefined],
      // 40: a trail alone is not empty map: nothing.
      ['empty', 0], // 50: another layer's contact releases local's selection
      ['empty', 0], // 60: the same for a registry owner's
      ['empty', 0], // 70
      ['empty', 0], // 70, long press
    ]);
    // Flights, as before: its own contact at 50 and empty map at 70 (the
    // long press does not deselect); a local marker (even under a tile), a
    // trail or another owner's object is not its empty space.
    assert.deepEqual(flights.calls, [
      ['select', 'ae01ce', undefined],
      ['empty', 0],
    ]);
  } finally {
    unregisterPickOwner('trails', engine);
    unregisterPickOwner('cctv', engine);
  }
});

test('an own-rule owner (vessels) gets every click with its top pick and is another layer to the rest', () => {
  const { dispatcher, click, escape } = setup({
    10: [{ id: { id: 'ship-1', mmsi: '111' } }], // its own object (Cesium: the record)
    20: [{ id: 'ae01ce' }], // flights' contact
    30: [], // empty map
  });
  const seen = [];
  const flights = recorder();
  let owned = true;
  dispatcher.register('ais-live-vessels', {
    owns: (id) => owned && id === 'ship-1',
    onClick: (ctx) =>
      seen.push([ctx.position.x, ctx.picked?.id ?? null, ctx.gesture.travelPx]),
  });
  dispatcher.register('flights', {
    owns: (id) => id === 'ae01ce',
    ...flights.handlers,
  });
  click(10);
  click(20);
  click(30);
  // No gesture rule: a long press and a drag still reach it (LEFT_CLICK).
  click(30, { ms: 900 });
  click(30, { travel: 40 });
  escape();
  assert.deepEqual(seen, [
    [10, { id: 'ship-1', mmsi: '111' }, 0],
    [20, 'ae01ce', 0],
    [30, null, 0],
    [30, null, 0],
    [70, null, 40],
  ]);
  // To flights a vessel is another layer's object: not its empty space.
  assert.deepEqual(flights.calls, [
    ['select', 'ae01ce', undefined],
    ['empty', 0],
    ['escape'],
  ]);
  // A disowned vessel pick (the layer disabled) is empty space again.
  owned = false;
  click(10);
  assert.deepEqual(flights.calls.at(-1), ['empty', 0]);
});
