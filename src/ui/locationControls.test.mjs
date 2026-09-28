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

function fixture(extraCities = {}, overriddenIds = []) {
  const elements = {
    pills: node(),
    pillsScrollLeft: node(),
    pillsScrollRight: node(),
    addPin: node(),
    editInput: node(),
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
    onRenamePin: (id, name) => calls.push(['renamePin', id, name]),
    onResetPin: (id) => calls.push(['resetPin', id]),
    onAddPoi: (id, name) => calls.push(['addPoi', id, name]),
    onRenamePoi: (id, index, name) =>
      calls.push(['renamePoi', id, index, name]),
    onRemovePoi: (id, index) => calls.push(['removePoi', id, index]),
    isOverridden: (id) => overriddenIds.includes(id),
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

/** The pill wrap for a city id — children are [select, rename, remove, reset?]. */
function pillWrapFor(elements, id) {
  return elements.pills.children.find(
    (child) => child.children[0]?.dataset.locationId === id,
  );
}

/** The POI wrap at a given index in the (already expanded) POI row. */
function poiWrapAt(elements, index) {
  return elements.poiRow.children[index];
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
  const old = poiWrapAt(f.elements, 0).children[0];
  f.controls.showPois('b');
  old.fire('click');
  assert.deepEqual(f.calls, []);
  poiWrapAt(f.elements, 0).children[0].fire('click');
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
  const city = pillWrapFor(f.elements, 'a').children[0];
  const poi = poiWrapAt(f.elements, 0).children[0];
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

test('the add-pin button opens the shared edit input in add mode', () => {
  const f = fixture();
  f.elements.addPin.fire('click');
  assert.equal(f.elements.editInput.classList.contains('expanded'), true);
  assert.equal(f.elements.editInput.focused, true);
  f.elements.editInput.value = 'Waterloo Intl Airport';
  f.elements.editInput.fire('keydown', { key: 'Enter' });
  assert.deepEqual(f.calls, [['addPin', 'Waterloo Intl Airport']]);
  assert.equal(f.elements.editInput.value, '');
  assert.equal(f.elements.editInput.classList.contains('expanded'), false);
});

test('Escape in the edit input discards it without saving', () => {
  const f = fixture();
  f.elements.addPin.fire('click');
  f.elements.editInput.value = 'Abandoned';
  f.elements.editInput.fire('keydown', { key: 'Escape' });
  assert.deepEqual(f.calls, []);
  assert.equal(f.elements.editInput.value, '');
});

test('every pill gets rename and remove controls, as siblings not nested in the button', () => {
  const f = fixture();
  const wrap = pillWrapFor(f.elements, 'a');
  assert.equal(wrap.className, 'location-pill-wrap');
  const [pill, rename, remove] = wrap.children;
  assert.equal(pill.dataset.locationId, 'a');
  assert.equal(rename.className, 'location-pill-rename');
  assert.equal(remove.className, 'location-pill-remove');
});

test('a bundled city remove is a hide, not a delete label, and never carries data-custom', () => {
  const f = fixture();
  const wrap = pillWrapFor(f.elements, 'a');
  const [pill] = wrap.children;
  assert.equal(pill.dataset.custom, undefined);
});

test('a custom pin renders with data-custom and removes without flying there', () => {
  const f = fixture({
    pin: { name: 'Waterloo Intl', custom: true, pois: [{ name: 'Terminal' }] },
  });
  const wrap = pillWrapFor(f.elements, 'pin');
  const [pill, , remove] = wrap.children;
  assert.equal(pill.dataset.custom, 'true');
  remove.fire('click');
  assert.deepEqual(f.calls, [['removePin', 'pin']]);
  pill.fire('click');
  assert.deepEqual(f.calls, [
    ['removePin', 'pin'],
    ['city', 'pin'],
  ]);
});

test('the rename control opens the shared edit input prefilled with the current name', () => {
  const f = fixture();
  const [, rename] = pillWrapFor(f.elements, 'b').children;
  rename.fire('click');
  assert.equal(f.elements.editInput.value, 'City B');
  assert.equal(f.elements.editInput.classList.contains('expanded'), true);
  f.elements.editInput.value = 'Renamed City';
  f.elements.editInput.fire('keydown', { key: 'Enter' });
  assert.deepEqual(f.calls, [['renamePin', 'b', 'Renamed City']]);
});

test('a reset control appears only for overridden cities and is wired to onResetPin', () => {
  const f = fixture({}, ['a']);
  const overriddenWrap = pillWrapFor(f.elements, 'a');
  const plainWrap = pillWrapFor(f.elements, 'b');
  assert.equal(overriddenWrap.children.length, 4);
  assert.equal(plainWrap.children.length, 3);
  const reset = overriddenWrap.children[3];
  assert.equal(reset.className, 'location-pill-reset-btn');
  reset.fire('click');
  assert.deepEqual(f.calls, [['resetPin', 'a']]);
});

test('highlightCity finds a pill nested inside its wrap', () => {
  const f = fixture();
  f.controls.highlightCity('b');
  const wrap = pillWrapFor(f.elements, 'b');
  assert.equal(wrap.children[0].classList.contains('active'), true);
});

test('the POI row gets a trailing add-landmark control wired to onAddPoi', () => {
  const f = fixture();
  f.controls.showPois('a');
  const add = f.elements.poiRow.children[f.elements.poiRow.children.length - 1];
  assert.equal(add.className, 'poi-pill-add');
  add.fire('click');
  assert.equal(f.elements.editInput.classList.contains('expanded'), true);
  f.elements.editInput.value = 'New Landmark';
  f.elements.editInput.fire('keydown', { key: 'Enter' });
  assert.deepEqual(f.calls, [['addPoi', 'a', 'New Landmark']]);
});

test('each POI gets a rename control, prefilled with its current name', () => {
  const f = fixture();
  f.controls.showPois('a');
  const [, rename] = poiWrapAt(f.elements, 0).children;
  rename.fire('click');
  assert.equal(f.elements.editInput.value, 'First');
  f.elements.editInput.value = 'Renamed Landmark';
  f.elements.editInput.fire('keydown', { key: 'Enter' });
  assert.deepEqual(f.calls, [['renamePoi', 'a', 0, 'Renamed Landmark']]);
});

test('a POI with siblings gets a remove control wired to onRemovePoi', () => {
  const f = fixture();
  f.controls.showPois('a'); // city 'a' has two POIs
  const [, , remove] = poiWrapAt(f.elements, 0).children;
  assert.equal(remove.className, 'poi-pill-remove');
  remove.fire('click');
  assert.deepEqual(f.calls, [['removePoi', 'a', 0]]);
});

test('the last remaining POI has no remove control', () => {
  const f = fixture();
  f.controls.showPois('b'); // city 'b' has exactly one POI
  const wrap = poiWrapAt(f.elements, 0);
  assert.equal(wrap.children.length, 2); // select + rename, no remove
});
