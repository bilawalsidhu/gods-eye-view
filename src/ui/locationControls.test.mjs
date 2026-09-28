import assert from 'node:assert/strict';
import test from 'node:test';
import { LocationControls } from './locationControls.js';

function node() {
  const classes = new Set();
  return {
    children: [],
    dataset: {},
    listeners: new Map(),
    className: '',
    textContent: '',
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle(name, enabled = !classes.has(name)) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    addEventListener(name, callback) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) {
      this.listeners.get(name)?.delete(callback);
    },
    fire(name, event = {}) {
      for (const callback of this.listeners.get(name) || []) callback(event);
    },
    appendChild(child) {
      this.children.push(child);
      child.parent = this;
    },
    append(...children) {
      for (const child of children)
        if (typeof child !== 'string') this.appendChild(child);
    },
    replaceChildren() {
      this.children = [];
    },
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter(
          (child) => child !== this,
        );
    },
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(child.className === selector.slice(1) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    },
    focus() {
      this.focused = true;
    },
  };
}
function fixture(extraCities = {}) {
  const elements = {
    pills: node(),
    pillsScrollLeft: node(),
    pillsScrollRight: node(),
    addPin: node(),
    addPinInput: node(),
    poiRow: node(),
    divider: node(),
    search: node(),
    searchToggle: node(),
    resetButtons: [node(), node()],
    statusCity: node(),
    statusPoi: node(),
  };
  const doc = node();
  doc.createElement = node;
  doc.body = node();
  const cities = {
    a: { name: 'City A', pois: [{ name: 'First' }, { name: 'Second' }] },
    b: { name: 'City B', pois: [{ name: 'Elsewhere' }] },
    ...extraCities,
  };
  const calls = [];
  const frames = new Map();
  const cancelled = [];
  let next = 0;
  const controls = new LocationControls({
    elements,
    cities,
    getExpandedCity: () => 'a',
    onCity: (id) => calls.push(['city', id]),
    onPoi: (id, index) => calls.push(['poi', id, index]),
    onSearch: (query) => calls.push(['search', query]),
    onReset: () => calls.push(['reset']),
    onAddPin: (name) => calls.push(['addPin', name]),
    onRemovePin: (id) => calls.push(['removePin', id]),
    doc,
    requestFrame: (fn) => {
      const id = next++;
      frames.set(id, fn);
      return id;
    },
    cancelFrame: (id) => cancelled.push(id),
  });
  return { elements, doc, controls, calls, frames, cancelled };
}
test('hiding a POI row cancels frame zero and rejects an already queued expansion', () => {
  const f = fixture();
  f.controls.showPois('a');
  const callback = f.frames.get(0);
  f.controls.hidePois();
  callback();
  assert.deepEqual(f.cancelled, [0]);
  assert.equal(f.elements.poiRow.classList.contains('expanded'), false);
  assert.equal(f.elements.divider.classList.contains('visible'), false);
});
test('replacing POIs removes old click actions and presents the final row', () => {
  const f = fixture();
  f.controls.showPois('a');
  const old = f.elements.poiRow.children[0];
  f.controls.showPois('b');
  old.fire('click');
  assert.deepEqual(f.calls, []);
  f.elements.poiRow.children[0].fire('click');
  assert.deepEqual(f.calls, [['poi', 'b', 0]]);
  f.frames.get(0)();
  assert.equal(f.elements.poiRow.classList.contains('expanded'), false);
  f.frames.get(1)();
  assert.equal(f.elements.poiRow.classList.contains('expanded'), true);
});
test('destruction revokes document, search, reset, city and POI actions and removes orbit UI', () => {
  const f = fixture();
  f.controls.showPois('a');
  f.controls.createOrbitIndicator();
  assert.equal(f.doc.body.children.length, 1);
  const city = f.elements.pills.children[0];
  const poi = f.elements.poiRow.children[0];
  f.controls.destroy();
  f.controls.destroy();
  city.fire('click');
  poi.fire('click');
  f.elements.search.value = 'Place';
  f.elements.search.fire('keydown', { key: 'Enter' });
  f.doc.fire('keydown', { key: 'Q' });
  f.elements.resetButtons[0].fire('click');
  f.frames.get(0)();
  assert.deepEqual(f.calls, []);
  assert.equal(f.doc.body.children.length, 0);
});
test('location and POI keys route once while form controls retain typing', () => {
  const f = fixture();
  f.doc.fire('keydown', { key: 'W', target: { matches: () => false } });
  f.doc.fire('keydown', { key: 'Q', target: { matches: () => true } });
  f.elements.resetButtons[1].fire('click');
  assert.deepEqual(f.calls, [['poi', 'a', 1], ['reset']]);
});

test('a vertical wheel over the pill row scrolls it horizontally', () => {
  const f = fixture();
  f.elements.pills.scrollLeft = 0;
  let prevented = false;
  f.elements.pills.fire('wheel', {
    deltaY: 40,
    deltaX: 0,
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(f.elements.pills.scrollLeft, 40);
  assert.equal(prevented, true);
});

test('a horizontal wheel gesture (deltaX set) is left to native scrolling', () => {
  const f = fixture();
  f.elements.pills.scrollLeft = 0;
  f.elements.pills.fire('wheel', { deltaY: 40, deltaX: 5 });
  assert.equal(f.elements.pills.scrollLeft, 0);
});

test('the scroll arrows step the pill row left and right', () => {
  const f = fixture();
  f.elements.pills.scrollLeft = 100;
  f.elements.pillsScrollLeft.fire('click');
  assert.equal(f.elements.pills.scrollLeft, -60);
  f.elements.pillsScrollRight.fire('click');
  f.elements.pillsScrollRight.fire('click');
  assert.equal(f.elements.pills.scrollLeft, 260);
});

test('the add-pin button expands the name input and focuses it', () => {
  const f = fixture();
  f.elements.addPin.fire('click');
  assert.equal(f.elements.addPinInput.classList.contains('expanded'), true);
  assert.equal(f.elements.addPinInput.focused, true);
  f.elements.addPin.fire('click');
  assert.equal(f.elements.addPinInput.classList.contains('expanded'), false);
});

test('Enter in the name input saves the pin and collapses the input', () => {
  const f = fixture();
  f.elements.addPinInput.value = 'Waterloo Intl Airport';
  f.elements.addPinInput.fire('keydown', { key: 'Enter' });
  assert.deepEqual(f.calls, [['addPin', 'Waterloo Intl Airport']]);
  assert.equal(f.elements.addPinInput.value, '');
  assert.equal(f.elements.addPinInput.classList.contains('expanded'), false);
});

test('Escape in the name input discards it without saving', () => {
  const f = fixture();
  f.elements.addPinInput.value = 'Abandoned';
  f.elements.addPinInput.fire('keydown', { key: 'Escape' });
  assert.deepEqual(f.calls, []);
  assert.equal(f.elements.addPinInput.value, '');
});

test('a custom pin renders with a remove control that removes without flying there', () => {
  const f = fixture({
    pin: { name: 'Waterloo Intl', custom: true, pois: [{ name: 'Terminal' }] },
  });
  const wrap = f.elements.pills.children.find(
    (child) => child.className === 'location-pill-wrap',
  );
  assert.ok(wrap, 'custom pin renders inside a wrap with a remove control');
  const [pill, remove] = wrap.children;
  assert.equal(pill.dataset.custom, 'true');
  assert.equal(remove.className, 'location-pill-remove');
  remove.fire('click');
  assert.deepEqual(f.calls, [['removePin', 'pin']]);
  pill.fire('click');
  assert.deepEqual(f.calls, [
    ['removePin', 'pin'],
    ['city', 'pin'],
  ]);
});

test('highlightCity finds a custom pin nested inside its wrap', () => {
  const f = fixture({
    pin: { name: 'Waterloo Intl', custom: true, pois: [{ name: 'Terminal' }] },
  });
  f.controls.highlightCity('pin');
  const wrap = f.elements.pills.children.find(
    (child) => child.className === 'location-pill-wrap',
  );
  assert.equal(wrap.children[0].classList.contains('active'), true);
});
