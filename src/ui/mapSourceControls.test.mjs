import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapSourceControls } from './mapSourceControls.js';

function fixture() {
  const sources = [
    { id: 'osm', label: 'OSM' },
    { id: 'esri-imagery', label: 'Esri' },
    {
      id: 'bing-aerial',
      label: 'Bing',
      available: false,
      unavailableReason: 'Unavailable for this test',
    },
  ];
  let state = { activeId: 'osm', activeStack: sources[0], status: 'ready' };
  const listeners = new Set();
  const requests = [];
  const calls = [];
  const views = [];
  const controller = {
    getStacks: () => sources.map((source) => ({ ...source })),
    getActiveId: () => state.activeId,
    getState: (status) => ({ ...state, status: status || state.status }),
    setStack: (id) => {
      calls.push(['select', id]);
      return new Promise((resolve, reject) =>
        requests.push({ id, resolve, reject }),
      );
    },
  };
  const controls = createMapSourceControls({
    controller,
    publish: (view) => views.push(view),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    claimSelection: () => calls.push(['claim']),
    onStateChanged: () => calls.push(['state']),
    onError: (message) => calls.push(['error', message]),
  });
  const view = () => views.at(-1);
  const chip = (id) => view().chips.find((model) => model.id === id);
  const active = () =>
    view()
      .chips.filter((model) => model.active)
      .map((model) => model.id);
  function change(id, lastError = null) {
    state = {
      activeId: id,
      activeStack: sources.find((source) => source.id === id),
      status: 'ready',
      lastError,
    };
    return controller.getState();
  }
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    sources,
    controls,
    requests,
    calls,
    listeners,
    views,
    view,
    chip,
    active,
    change,
    emit,
  };
}

test('initial presentation uses actual state and retains unavailable chip semantics', () => {
  const f = fixture();
  assert.deepEqual(f.active(), ['osm']);
  assert.deepEqual(f.view().status, { text: 'OSM', warn: false });
  assert.deepEqual(
    f.view().chips.map((model) => model.id),
    ['bing-aerial', 'esri-imagery', 'osm'],
  );
  const unavailable = f.chip('bing-aerial');
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.title, 'Unavailable for this test');
  assert.equal(
    unavailable.ariaLabel,
    'Bing unavailable: Unavailable for this test',
  );
  assert.equal(f.chip('osm').ariaLabel, null);
  f.controls.destroy();
});

test('selection claims authority before requesting and never lights a pending source optimistically', async () => {
  const f = fixture();
  const pending = f.controls.select('esri-imagery');
  assert.deepEqual(f.calls, [['claim'], ['select', 'esri-imagery']]);
  assert.equal(f.view().status.text, '...');
  assert.deepEqual(f.active(), ['osm']);
  f.requests[0].resolve(f.change('esri-imagery'));
  await pending;
  assert.deepEqual(f.active(), ['esri-imagery']);
  assert.equal(f.view().status.text, 'Esri');
  f.controls.destroy();
});

test('provider-driven fallback updates the active chip and durable state notification', () => {
  const f = fixture();
  f.change('esri-imagery');
  f.emit();
  f.change('osm', 'Source unavailable; using OSM');
  f.emit();
  assert.deepEqual(f.active(), ['osm']);
  assert.deepEqual(f.view().status, { text: 'OSM', warn: true });
  assert.deepEqual(f.calls, [['state'], ['state']]);
  f.controls.destroy();
});

test('a late superseded response cannot overwrite the latest displayed selection', async () => {
  const f = fixture();
  const first = f.controls.select('esri-imagery');
  const second = f.controls.select('osm');
  f.requests[1].resolve(f.change('osm'));
  await second;
  const count = f.calls.length;
  f.requests[0].resolve({
    activeId: 'esri-imagery',
    activeStack: { label: 'old' },
    lastError: 'obsolete failure',
  });
  await first;
  assert.equal(f.view().status.text, 'OSM');
  assert.equal(f.calls.length, count);
  f.controls.destroy();
});

test('failed selection keeps the real source lit and reports its error', async () => {
  const f = fixture();
  const pending = f.controls.select('esri-imagery');
  f.requests[0].resolve(f.change('osm', 'Unavailable'));
  await pending;
  assert.deepEqual(f.active(), ['osm']);
  assert.equal(f.view().status.warn, true);
  assert.ok(
    f.calls.some((call) => call[0] === 'error' && call[1] === 'Unavailable'),
  );
  f.controls.destroy();
});

test('rejected selection leaves switching presentation and propagates a useful error', async () => {
  const f = fixture();
  const pending = f.controls.select('esri-imagery');
  f.requests[0].reject(new Error('Request failed'));
  await assert.rejects(pending, /Request failed/);
  assert.equal(f.view().status.text, 'OSM');
  assert.ok(
    f.calls.some((call) => call[0] === 'error' && call[1] === 'Request failed'),
  );
  f.controls.destroy();
});

test('restoration may select without claiming or publishing a user gesture', async () => {
  const f = fixture();
  const pending = f.controls.select('esri-imagery', { syncShare: false });
  f.requests[0].resolve(f.change('esri-imagery'));
  await pending;
  assert.deepEqual(f.calls, [['select', 'esri-imagery']]);
  f.controls.destroy();
});

test('availability is read on refresh, and destruction removes the subscription', () => {
  const f = fixture();
  f.sources[2].available = true;
  f.emit();
  assert.equal(f.chip('bing-aerial').available, false);
  f.controls.refresh();
  assert.equal(f.chip('bing-aerial').available, true);
  f.controls.destroy();
  f.controls.destroy();
  assert.equal(f.listeners.size, 0);
});

test('completion after destruction cannot paint or notify', async () => {
  const f = fixture();
  const pending = f.controls.select('esri-imagery');
  f.controls.destroy();
  const count = f.calls.length;
  const published = f.views.length;
  f.requests[0].resolve(f.change('esri-imagery'));
  await pending;
  assert.equal(f.calls.length, count);
  assert.equal(f.views.length, published);
  assert.equal(await f.controls.select('osm'), null);
});
