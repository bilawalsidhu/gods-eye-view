import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapSourceControls } from './mapSourceControls.js';

function makeElement(tagName = 'div') {
  const element = {
    tagName,
    type: '',
    className: '',
    title: '',
    disabled: false,
    textContent: '',
    dataset: {},
    attributes: {},
    listeners: {},
    children: [],
    classList: {
      toggle(name, force) {
        const classes = new Set(
          String(element.className).split(/\s+/).filter(Boolean),
        );
        const next = force === undefined ? !classes.has(name) : !!force;
        if (next) classes.add(name);
        else classes.delete(name);
        element.className = [...classes].join(' ');
      },
      contains(name) {
        return String(element.className).split(/\s+/).includes(name);
      },
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      element.attributes[name] = String(value);
    },
    getAttribute(name) {
      return element.attributes[name] ?? null;
    },
    addEventListener(type, handler) {
      (element.listeners[type] ||= []).push(handler);
    },
    removeEventListener(type, handler) {
      element.listeners[type] = (element.listeners[type] || []).filter(
        (current) => current !== handler,
      );
    },
    click() {
      for (const handler of element.listeners.click || []) handler();
    },
  };
  Object.defineProperty(element, 'innerHTML', {
    get() {
      return '';
    },
    set() {
      element.children.length = 0;
    },
  });
  return element;
}

function fixture() {
  const container = makeElement();
  container.ownerDocument = { createElement: (tag) => makeElement(tag) };
  const statusElement = makeElement();
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
  const controller = {
    getStacks: () => sources,
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
    container,
    statusElement,
    controller,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    claimSelection: () => calls.push(['claim']),
    onStateChanged: () => calls.push(['state']),
    onError: (message) => calls.push(['error', message]),
  });
  const chip = (id) =>
    container.children.find((el) => el.dataset.stackId === id);
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
    container,
    statusElement,
    controller,
    controls,
    requests,
    calls,
    listeners,
    chip,
    change,
    emit,
  };
}

test('initial presentation uses actual state and retains unavailable chip semantics', () => {
  const f = fixture();
  assert.equal(f.chip('osm').getAttribute('aria-pressed'), 'true');
  assert.equal(f.statusElement.textContent, 'OSM');
  const unavailable = f.chip('bing-aerial');
  assert.equal(
    unavailable.disabled,
    false,
    'unavailable chips remain focusable',
  );
  assert.equal(unavailable.getAttribute('aria-disabled'), 'true');
  unavailable.click();
  assert.equal(f.requests.length, 0);
  f.controls.destroy();
});

test('selection claims authority before requesting and never lights a pending source optimistically', async () => {
  const f = fixture();
  const pending = f.controls.select('esri-imagery');
  assert.deepEqual(f.calls, [['claim'], ['select', 'esri-imagery']]);
  assert.equal(f.statusElement.textContent, '...');
  assert.equal(f.chip('osm').getAttribute('aria-pressed'), 'true');
  f.requests[0].resolve(f.change('esri-imagery'));
  await pending;
  assert.equal(f.chip('esri-imagery').getAttribute('aria-pressed'), 'true');
  assert.equal(f.statusElement.textContent, 'Esri');
  f.controls.destroy();
});

test('provider-driven fallback updates the active chip and durable state notification', () => {
  const f = fixture();
  f.change('esri-imagery');
  f.emit();
  f.change('osm', 'Source unavailable; using OSM');
  f.emit();
  assert.equal(f.chip('osm').getAttribute('aria-pressed'), 'true');
  assert.equal(f.statusElement.textContent, 'OSM');
  assert.equal(f.statusElement.classList.contains('warn'), true);
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
  assert.equal(f.statusElement.textContent, 'OSM');
  assert.equal(f.calls.length, count);
  f.controls.destroy();
});

test('failed selection keeps the real source lit and reports its error', async () => {
  const f = fixture();
  const pending = f.controls.select('esri-imagery');
  f.requests[0].resolve(f.change('osm', 'Unavailable'));
  await pending;
  assert.equal(f.chip('osm').getAttribute('aria-pressed'), 'true');
  assert.equal(f.statusElement.classList.contains('warn'), true);
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
  assert.equal(f.statusElement.textContent, 'OSM');
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

test('refresh removes detached chip listeners and destruction removes all subscriptions', () => {
  const f = fixture();
  const old = f.chip('esri-imagery');
  f.controls.refresh();
  old.click();
  assert.equal(f.requests.length, 0);
  const current = f.chip('esri-imagery');
  f.controls.destroy();
  f.controls.destroy();
  current.click();
  assert.equal(f.requests.length, 0);
  assert.equal(f.listeners.size, 0);
});

test('completion after destruction cannot paint or notify', async () => {
  const f = fixture();
  const pending = f.controls.select('esri-imagery');
  f.controls.destroy();
  const count = f.calls.length;
  const label = f.statusElement.textContent;
  f.requests[0].resolve(f.change('esri-imagery'));
  await pending;
  assert.equal(f.calls.length, count);
  assert.equal(f.statusElement.textContent, label);
  assert.equal(await f.controls.select('osm'), null);
});
