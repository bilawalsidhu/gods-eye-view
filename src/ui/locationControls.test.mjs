import assert from 'node:assert/strict';
import test from 'node:test';
import { LocationControls } from './locationControls.js';

/** A document stand-in that only takes listeners. */
function node() {
  const listeners = new Map();
  return {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) {
      listeners.get(name)?.delete(callback);
    },
    fire(name, event = {}) {
      for (const callback of listeners.get(name) || []) callback(event);
    },
  };
}
function fixture(options = {}) {
  const doc = node();
  const cities = {
    a: { name: 'City A', pois: [{ name: 'First' }, { name: 'Second' }] },
    b: { name: 'City B', pois: [{ name: 'Elsewhere' }] },
  };
  const calls = [];
  const views = [];
  const controls = new LocationControls({
    cities,
    getExpandedCity: () => 'a',
    onCity: (id) => calls.push(['city', id]),
    onPoi: (id, index) => calls.push(['poi', id, index]),
    onSearch: (query) => calls.push(['search', query]),
    onSearchEdit: () => calls.push(['edit']),
    onReset: () => calls.push(['reset']),
    publish: (view) => views.push(view),
    doc,
    ...options,
  });
  const view = () => views.at(-1);
  return { doc, controls, calls, views, view };
}
test('the controls present no landmarks, error or lookup at first', () => {
  const f = fixture();
  assert.deepEqual(f.view(), {
    poiCity: null,
    searchError: null,
    searching: false,
    searchOrigin: null,
    orbit: null,
  });
  f.controls.setSearchError('Not found');
  assert.equal(f.view().searchError, 'Not found');
  f.controls.setSearchError(null);
  assert.equal(f.view().searchError, null);
});
test('a chosen landmark belongs to the city whose landmarks are shown', () => {
  const f = fixture();
  f.controls.choosePoi(0);
  assert.deepEqual(f.calls, [], 'no city shows its landmarks yet');
  f.controls.showPois('a');
  f.controls.showPois('missing');
  assert.equal(f.view().poiCity, 'a');
  f.controls.showPois('b');
  f.controls.choosePoi(0);
  f.controls.chooseCity('a');
  assert.deepEqual(f.calls, [
    ['poi', 'b', 0],
    ['city', 'a'],
  ]);
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
  assert.equal(f.controls.search('Place'), false);
  f.doc.fire('keydown', { key: 'Q' });
  f.controls.reset();
  assert.deepEqual(f.calls, []);
  assert.equal(f.views.length, published);
});
test('location and POI keys route once while form controls retain typing', () => {
  const f = fixture();
  f.doc.fire('keydown', { key: 'W', target: { matches: () => false } });
  f.doc.fire('keydown', { key: 'Q', target: { matches: () => true } });
  f.controls.reset();
  assert.deepEqual(f.calls, [['poi', 'a', 1], ['reset']]);
});
test('POI keys held with Cmd, Ctrl or Alt run no POI; Shift still does', () => {
  const f = fixture();
  const target = { matches: () => false };
  for (const modifier of ['metaKey', 'ctrlKey', 'altKey'])
    for (const key of ['q', 'w', 'r', 'R'])
      f.doc.fire('keydown', { key, target, [modifier]: true });
  assert.deepEqual(f.calls, []);
  f.doc.fire('keydown', { key: 'W', target, shiftKey: true });
  assert.deepEqual(f.calls, [['poi', 'a', 1]]);
});
test('a lookup records who ran it, and editing clears only the Omnibar’s error', () => {
  const f = fixture({
    onSearch: (query) => {
      f.calls.push(['search', query]);
      f.controls.setSearching(true);
    },
  });
  assert.equal(f.controls.search('   '), false);
  f.controls.search('Paris', { origin: 'voice' });
  assert.equal(f.view().searchOrigin, 'voice');
  assert.equal(f.view().searching, true);
  f.controls.settleSearch();
  assert.equal(f.view().searching, false);
  f.controls.editSearch();
  f.controls.search('Rome');
  assert.equal(f.view().searchOrigin, 'omnibar');
  f.controls.editSearch();
  assert.deepEqual(f.calls, [
    ['search', 'Paris'],
    ['search', 'Rome'],
    ['edit'],
  ]);
});
