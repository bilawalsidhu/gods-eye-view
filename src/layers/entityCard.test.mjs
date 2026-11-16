import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEntityCard,
  createEntityCardOverlayEntry,
  pickedEntityId,
} from './entityCard.js';

function harness(overrides = {}) {
  const calls = [];
  const overlayHost = {
    setEntries: (...args) => calls.push(['set', ...args]),
    clearSource: (...args) => calls.push(['clear', ...args]),
    setVisible: (...args) => calls.push(['visible', ...args]),
  };
  const card = createEntityCard({
    layerId: 'demo',
    overlayHost,
    sourceId: 'demo-selected',
    owns: (id) => id.startsWith('demo:'),
    resolve: (id) =>
      id === 'demo:a'
        ? { title: 'A', details: ['one'], accent: '#fff', position: { x: 1 } }
        : null,
    ...overrides,
  });
  return { card, calls };
}

test('a pick id is read from the draw hit of a click, and only a string counts', () => {
  assert.equal(pickedEntityId({ drawHit: { id: 'x' } }), 'x');
  assert.equal(pickedEntityId({ drawHit: { id: 7 } }), null);
  assert.equal(pickedEntityId({ drawHit: null }), null);
  assert.equal(pickedEntityId(null), null);
});

function clickHarness(overrides = {}) {
  let listener = null;
  const registered = [];
  const inputFor = () => ({
    onClick(fn) {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  });
  const made = harness({
    inputFor,
    interaction: {
      registerPickOwner: (...args) => registered.push(['register', ...args]),
      unregisterPickOwner: (...args) =>
        registered.push(['unregister', ...args]),
    },
    ...overrides,
  });
  return {
    ...made,
    registered,
    click: (event) => listener?.(event),
    get listening() {
      return listener !== null;
    },
  };
}

test('a click on an owned item opens its card; a click elsewhere closes it', () => {
  const h = clickHarness();
  h.card.install({});
  assert.equal(h.listening, true);
  assert.deepEqual(h.registered[0].slice(0, 2), ['register', 'demo']);
  h.click({ drawHit: { id: 'demo:a' }, ground: () => ({ x: 1, y: 2, z: 3 }) });
  assert.equal(h.card.selectedId, 'demo:a');
  h.click({ drawHit: null, ground: () => null });
  assert.equal(h.card.selectedId, null);
});

test('a click on a line anchors the card where it landed', () => {
  const h = clickHarness({
    resolve: (id, click) => ({
      title: 'Zone',
      accent: '#fff',
      position: click.position,
    }),
  });
  h.card.install({});
  h.click({ drawHit: { id: 'demo:z' }, ground: () => ({ x: 4, y: 5, z: 6 }) });
  const [, , entries] = h.calls.at(-1);
  assert.deepEqual(entries[0].position, { x: 4, y: 5, z: 6 });
});

test('a pointer a tool holds opens nothing; remove stops listening', () => {
  const h = clickHarness({
    interaction: { isPointerFree: () => false },
  });
  h.card.install({});
  h.click({ drawHit: { id: 'demo:a' }, ground: () => null });
  assert.equal(h.card.selectedId, null);
  h.card.remove();
  assert.equal(h.listening, false);
});

test('selecting an owned id publishes one selected card', () => {
  const { card, calls } = harness();
  assert.equal(card.select('demo:a'), true);
  assert.equal(card.selectedId, 'demo:a');
  const [kind, source, entries, options] = calls.at(-1);
  assert.equal(kind, 'set');
  assert.equal(source, 'demo-selected');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'A');
  assert.equal(entries[0].selected, true);
  assert.equal(options.cohortLimit, 1);
});

test('an id the layer cannot resolve opens nothing', () => {
  const { card, calls } = harness();
  assert.equal(card.select('demo:gone'), false);
  assert.equal(card.selectedId, null);
  assert.equal(calls.length, 0);
});

test('clear closes the card once and tells the layer', () => {
  let cleared = 0;
  const { card, calls } = harness({ onClear: () => (cleared += 1) });
  card.select('demo:a');
  card.clear();
  card.clear();
  assert.equal(cleared, 1);
  assert.equal(calls.filter((call) => call[0] === 'clear').length, 2);
});

test('an overlay entry needs an id and an anchor', () => {
  assert.equal(
    createEntityCardOverlayEntry('', { x: 1 }, { title: 't' }),
    null,
  );
  assert.equal(createEntityCardOverlayEntry('a', null, { title: 't' }), null);
});

test('remove without install is safe and releases the slot', () => {
  const { card, calls } = harness();
  card.remove();
  assert.deepEqual(calls.at(-1), ['visible', 'demo-selected', false]);
});
