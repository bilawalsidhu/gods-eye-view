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
  const { dispatcher, click } = setup({ 10: [{ id: 'cctv-1' }] });
  registerPickOwner('cctv', (id) => id.startsWith('cctv'));
  try {
    const flights = recorder();
    dispatcher.register('flights', {
      owns: (id) => id === 'x',
      ...flights.handlers,
    });
    assert.equal(
      isOwnedByOtherLayer('cctv', 'x'),
      true,
      'registered for legacy handlers',
    );
    click(10);
    assert.deepEqual(flights.calls, []);
  } finally {
    unregisterPickOwner('cctv');
  }
});

test('a pick no layer owns is empty space, as for the old handlers', () => {
  const { dispatcher, click } = setup({ 10: [{ id: 'unclaimed-entity' }] });
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
  const { dispatcher, click } = setup({
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
  const { dispatcher, click } = setup({
    10: [{ id: 'cctv-1' }, { id: 'adsb:abc' }],
  });
  registerPickOwner('cctv', (id) => id.startsWith('cctv'));
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
    unregisterPickOwner('cctv');
  }
});

test('a drag selects nothing and deselects nothing; a long press still selects', () => {
  const { dispatcher, click } = setup({ 10: [{ id: 'ae01ce' }] });
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
  assert.equal(isOwnedByOtherLayer('other', 'a'), false);
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
