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
function fixture() {
  const elements = {
    search: node(),
    searchToggle: node(),
  };
  const doc = node();
  doc.createElement = node;
  const cities = {
    a: { name: 'City A', pois: [{ name: 'First' }, { name: 'Second' }] },
    b: { name: 'City B', pois: [{ name: 'Elsewhere' }] },
  };
  const calls = [];
  const frames = new Map();
  const cancelled = [];
  let next = 0;
  const views = [];
  const controls = new LocationControls({
    elements,
    cities,
    getExpandedCity: () => 'a',
    onCity: (id) => calls.push(['city', id]),
    onPoi: (id, index) => calls.push(['poi', id, index]),
    onSearch: (query) => calls.push(['search', query]),
    onSearchEdit: () => calls.push(['edit']),
    onReset: () => calls.push(['reset']),
    publish: (view) => views.push(view),
    doc,
    requestFrame: (fn) => {
      const id = next++;
      frames.set(id, fn);
      return id;
    },
    cancelFrame: (id) => cancelled.push(id),
  });
  const view = () => views.at(-1);
  return { elements, doc, controls, calls, frames, cancelled, views, view };
}
test('the tray presents its cities, empty status and no landmarks at first', () => {
  const f = fixture();
  assert.deepEqual(f.view(), {
    cities: [
      { id: 'a', label: 'City A', active: false },
      { id: 'b', label: 'City B', active: false },
    ],
    poiCity: null,
    pois: [],
    poisExpanded: false,
    status: { city: '📍 Location: --', poi: 'Landmark: --' },
    searchError: null,
    orbit: null,
  });
  f.controls.highlightCity('b');
  assert.deepEqual(
    f.view().cities.map((city) => city.active),
    [false, true],
  );
  f.controls.setSearchError('Not found');
  assert.equal(f.view().searchError, 'Not found');
  f.controls.setSearchError(null);
  assert.equal(f.view().searchError, null);
});
test('hiding a POI row cancels frame zero and rejects an already queued expansion', () => {
  const f = fixture();
  f.controls.showPois('a');
  const callback = f.frames.get(0);
  f.controls.hidePois();
  callback();
  assert.deepEqual(f.cancelled, [0]);
  assert.equal(f.view().poisExpanded, false);
});
test('replacing POIs routes clicks to the final row and expands it a frame later', () => {
  const f = fixture();
  f.controls.showPois('a');
  f.controls.highlightPoi(1);
  assert.deepEqual(
    f.view().pois.map((poi) => [poi.key, poi.name, poi.active]),
    [
      ['Q', 'First', false],
      ['W', 'Second', true],
    ],
  );
  f.controls.showPois('b');
  assert.equal(f.view().poiCity, 'b');
  assert.deepEqual(
    f.view().pois.map((poi) => [poi.name, poi.active]),
    [['Elsewhere', false]],
  );
  f.controls.choosePoi(0);
  assert.deepEqual(f.calls, [['poi', 'b', 0]]);
  f.frames.get(0)();
  assert.equal(f.view().poisExpanded, false);
  f.frames.get(1)();
  assert.equal(f.view().poisExpanded, true);
});
test('destruction revokes document, search, reset, city and POI actions and removes orbit UI', () => {
  const f = fixture();
  f.controls.showPois('a');
  f.controls.showOrbit(true);
  assert.deepEqual(f.view().orbit, { active: true });
  f.controls.destroy();
  assert.equal(f.view().orbit, null);
  f.controls.destroy();
  const published = f.views.length;
  f.controls.showOrbit(true);
  f.controls.chooseCity('a');
  f.controls.choosePoi(0);
  f.controls.highlightCity('a');
  f.elements.search.value = 'Place';
  f.elements.search.fire('keydown', { key: 'Enter' });
  f.doc.fire('keydown', { key: 'Q' });
  f.controls.reset();
  f.frames.get(0)();
  assert.deepEqual(f.calls, []);
  assert.equal(f.views.length, published);
});
test('the mini status shows the city, a landmark or a searched place', () => {
  const f = fixture();
  f.controls.renderStatus({ searchedLabel: 'Somewhere' });
  assert.equal(f.view().status.poi, 'Searched location');
  f.controls.renderStatus({});
  assert.deepEqual(f.view().status, {
    city: '📍 Location: --',
    poi: 'Landmark: --',
  });
});
test('location and POI keys route once while form controls retain typing', () => {
  const f = fixture();
  f.doc.fire('keydown', { key: 'W', target: { matches: () => false } });
  f.doc.fire('keydown', { key: 'Q', target: { matches: () => true } });
  f.controls.reset();
  assert.deepEqual(f.calls, [['poi', 'a', 1], ['reset']]);
});
test('typing clears a failed search error and closing the emptied field drops it too', () => {
  const f = fixture();
  f.elements.search.value = 'Pariss';
  f.elements.search.fire('blur');
  assert.deepEqual(f.calls, [], 'leaving a kept query keeps its error');
  f.elements.search.fire('input');
  f.elements.search.value = '';
  f.elements.search.fire('blur');
  assert.deepEqual(f.calls, [['edit'], ['edit']]);
});
