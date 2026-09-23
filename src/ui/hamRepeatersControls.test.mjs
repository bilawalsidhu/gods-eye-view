import assert from 'node:assert/strict';
import test from 'node:test';

import { HamRepeatersControls } from './hamRepeaters.js';
import {
  REPEATER_BAND_FILTERS,
  REPEATER_KIND_FILTERS,
} from '../sources/hamRepeaters.js';

const ELEMENT_KEYS = [
  '_hamRepeatersPanel',
  '_hamRepeatersLayerState',
  '_hamRepeatersEnableBtn',
  '_hamRepeatersSummary',
  '_hamRepeatersRadius',
  '_hamRepeatersBand',
  '_hamRepeatersKind',
  '_hamRepeatersLoadBtn',
  '_hamRepeatersArea',
  '_hamRepeatersList',
];

/** Just enough element for the panel and its presentation module; no jsdom here. */
class FakeElement extends EventTarget {
  constructor(tagName = 'div') {
    super();
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.classes = new Set();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this.tabIndex = -1;
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, on) =>
        on ? this.classes.add(name) : this.classes.delete(name),
    };
  }
  set innerHTML(html) {
    this.children = [];
    this._innerHTML = String(html);
  }
  get innerHTML() {
    return this._innerHTML ?? '';
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  fire(type) {
    this.dispatchEvent(new Event(type));
  }
}

const textOf = (node) =>
  node == null
    ? ''
    : `${node.textContent ?? ''}${(node.children || []).map(textOf).join('')}`;

const options = (select) =>
  select.children.map((option) => [option.value, option.textContent]);

/** Let the click handlers' async chains run to completion. */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const FM = Object.freeze({
  id: 'fm-db0tv',
  kind: 'FM',
  callsign: 'DB0TV',
  outputHz: 439_425_000,
  inputHz: 431_825_000,
  toneHz: 67,
  city: 'Berlin',
  country: 'Germany',
  echolink: '123456',
  distanceKm: 12.4,
  confidence: 'verified',
  sourceLabel: 'HamRig FM table',
  recordUpdatedAt: '2025-05-06',
  status: 'On-air',
  statusKnown: true,
  positionPrecise: true,
});

const DSTAR = Object.freeze({
  id: 'ds-db0xyz',
  kind: 'D-STAR',
  callsign: 'DB0XYZ',
  module: 'B',
  outputHz: 439_550_000,
  distanceKm: null,
  confidence: 'unverified',
  source: 'dstarinfo',
  positionPrecise: false,
});

const baseState = (patch = {}) => ({
  enabled: false,
  loading: false,
  error: null,
  stale: false,
  partial: false,
  errors: {},
  count: 0,
  filteredCount: 0,
  selectedId: null,
  selected: null,
  filter: { kind: 'all', band: 'all' },
  filters: { kinds: REPEATER_KIND_FILTERS, bands: REPEATER_BAND_FILTERS },
  items: [],
  area: null,
  areaLabel: '',
  gate: { heightM: null, withinGate: false, gateM: 1_500_000 },
  lastLoad: null,
  ...patch,
});

function fixture({ registered = true, enabled = false, state = {} } = {}) {
  const priorDocument = globalThis.document;
  const doc = new EventTarget();
  doc.createElement = (tag) => new FakeElement(tag);
  doc.createTextNode = (text) => ({ textContent: String(text) });
  globalThis.document = doc;

  const el = {};
  for (const key of ELEMENT_KEYS) el[key] = new FakeElement();
  el._hamRepeatersRadius.value = '100';

  const calls = [];
  let current = baseState({ enabled, ...state });
  let listener = null;
  let lastListener = null;
  let isRegistered = registered;
  let isEnabled = enabled;
  let lifecycle = null;
  let centre = { lat: 52.52, lon: 13.4, heightM: 900 };
  let loadResult = { ok: true, count: 0 };

  const emit = (patch = {}) => {
    current = { ...current, ...patch };
    listener?.(current);
    return current;
  };

  const layer = {
    subscribe(callback) {
      calls.push(['subscribe']);
      listener = callback;
      lastListener = callback;
      callback(current);
      return () => {
        calls.push(['unsubscribe']);
        listener = null;
      };
    },
    setFilter(patch) {
      calls.push(['setFilter', patch]);
    },
    async loadAround(lat, lon, radiusKm, requestOptions) {
      calls.push(['loadAround', lat, lon, radiusKm, requestOptions]);
      return loadResult;
    },
    select(id, selectOptions) {
      calls.push(['select', id, selectOptions]);
    },
  };

  const actions = {
    isRegistered: () => isRegistered,
    isEnabled: () => isEnabled,
    getLifecycle: () => lifecycle,
    async setEnabled(value, setOptions) {
      calls.push(['setEnabled', value, setOptions]);
      isEnabled = value;
      emit({ enabled: value });
      return true;
    },
    async runUserAction(operation, message) {
      calls.push(['runUserAction', message]);
      return operation('token');
    },
    setPanelCollapsed: (...args) => calls.push(['setPanelCollapsed', ...args]),
    readViewCentre: () => centre,
  };

  const controls = new HamRepeatersControls({ elements: el, layer, actions });
  return {
    controls,
    el,
    doc,
    layer,
    actions,
    calls,
    emit,
    state: () => current,
    notifyDetached: (patch = {}) => lastListener?.({ ...current, ...patch }),
    setRegistered: (value) => {
      isRegistered = value;
    },
    setLifecycle: (value) => {
      lifecycle = value;
    },
    setCentre: (value) => {
      centre = value;
    },
    setLoadResult: (value) => {
      loadResult = value;
    },
    cleanup() {
      controls.destroy();
      globalThis.document = priorDocument;
    },
  };
}

test('connect subscribes and renders the off state into every element', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());

  f.controls.connect();
  assert.deepEqual(f.calls, [['subscribe']]);
  assert.equal(f.el._hamRepeatersLayerState.textContent, 'OFF');
  assert.equal(
    f.el._hamRepeatersLayerState.classList.contains('active'),
    false,
  );
  assert.equal(
    f.el._hamRepeatersPanel.classList.contains('radio-enabled'),
    false,
  );
  assert.equal(f.el._hamRepeatersEnableBtn.textContent, 'ENABLE');
  assert.equal(
    f.el._hamRepeatersEnableBtn.getAttribute('aria-pressed'),
    'false',
  );
  assert.equal(
    f.el._hamRepeatersEnableBtn.getAttribute('aria-label'),
    'Enable Repeaters',
  );
  assert.equal(f.el._hamRepeatersEnableBtn.getAttribute('aria-busy'), 'false');
  assert.equal(
    f.el._hamRepeatersSummary.textContent,
    'Repeaters off — LOAD HERE switches it on',
  );
  assert.deepEqual(options(f.el._hamRepeatersBand), [
    ['all', 'All bands'],
    ['6m', '6 m'],
    ['2m', '2 m'],
    ['1.25m', '1.25 m'],
    ['70cm', '70 cm'],
    ['23cm', '23 cm'],
  ]);
  assert.deepEqual(options(f.el._hamRepeatersKind), [
    ['all', 'All repeaters'],
    ['FM', 'FM'],
    ['D-STAR', 'D-STAR'],
  ]);
  assert.equal(f.el._hamRepeatersBand.value, 'all');
  assert.equal(f.el._hamRepeatersKind.value, 'all');
  // The layer is off, so the filters are not interactive yet.
  assert.equal(f.el._hamRepeatersBand.disabled, true);
  assert.equal(f.el._hamRepeatersKind.disabled, true);
  assert.equal(f.el._hamRepeatersLoadBtn.disabled, false);
  assert.equal(f.el._hamRepeatersArea.textContent, '');
  assert.equal(f.el._hamRepeatersList.children.length, 1);
  assert.equal(
    f.el._hamRepeatersList.children[0].className,
    'ham-repeaters-list-empty',
  );
  assert.equal(
    f.el._hamRepeatersList.children[0].textContent,
    'Enable Repeaters (or press LOAD HERE) for FM and D-STAR repeaters around the view.',
  );

  const firstOption = f.el._hamRepeatersBand.children[0];
  f.emit({
    enabled: true,
    count: 3,
    filteredCount: 2,
    filter: { kind: 'FM', band: '2m' },
  });
  assert.equal(f.el._hamRepeatersLayerState.textContent, '2/3');
  assert.equal(
    f.el._hamRepeatersPanel.classList.contains('radio-enabled'),
    true,
  );
  assert.equal(f.el._hamRepeatersSummary.textContent, '2/3 repeaters');
  assert.equal(f.el._hamRepeatersBand.value, '2m');
  assert.equal(f.el._hamRepeatersKind.value, 'FM');
  assert.equal(f.el._hamRepeatersBand.disabled, false);
  // Unchanged option sets are not rebuilt.
  assert.equal(f.el._hamRepeatersBand.children[0], firstOption);
});

test('the enable button drives runUserAction and mirrors the resulting state', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.controls.connect();

  f.el._hamRepeatersEnableBtn.fire('click');
  assert.equal(
    f.el._hamRepeatersEnableBtn.disabled,
    true,
    'busy while toggling',
  );
  await settle();
  assert.deepEqual(f.calls.slice(1, 3), [
    ['runUserAction', 'Repeaters could not start cleanly'],
    ['setEnabled', true, { origin: 'user', notificationToken: 'token' }],
  ]);
  assert.equal(f.el._hamRepeatersEnableBtn.disabled, false);
  assert.equal(f.el._hamRepeatersEnableBtn.textContent, 'DISABLE');
  assert.equal(
    f.el._hamRepeatersEnableBtn.getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(f.el._hamRepeatersEnableBtn.classList.contains('active'), true);
  assert.equal(
    f.el._hamRepeatersEnableBtn.getAttribute('aria-label'),
    'Disable Repeaters',
  );

  f.el._hamRepeatersEnableBtn.fire('click');
  await settle();
  assert.deepEqual(f.calls.slice(-2), [
    ['runUserAction', 'Repeaters could not stop cleanly'],
    ['setEnabled', false, { origin: 'user', notificationToken: 'token' }],
  ]);
  assert.equal(f.el._hamRepeatersEnableBtn.textContent, 'ENABLE');
  assert.equal(
    f.el._hamRepeatersEnableBtn.getAttribute('aria-pressed'),
    'false',
  );

  const before = f.calls.length;
  f.setRegistered(false);
  f.el._hamRepeatersEnableBtn.fire('click');
  await settle();
  assert.equal(
    f.calls.length,
    before,
    'an unregistered layer is never toggled',
  );
});

test('lifecycle transitions and uncertainty take over the chip, button and controls', (t) => {
  const f = fixture({ enabled: false });
  t.after(() => f.cleanup());
  f.controls.connect();

  f.setLifecycle({
    lifecycleState: 'enabling',
    enabled: true,
    uncertain: false,
  });
  f.emit({ enabled: true, count: 4, filteredCount: 4 });
  assert.equal(f.el._hamRepeatersLayerState.textContent, 'ENABLING');
  assert.equal(f.el._hamRepeatersEnableBtn.textContent, 'ENABLING');
  assert.equal(f.el._hamRepeatersEnableBtn.getAttribute('aria-busy'), 'true');
  assert.equal(f.el._hamRepeatersLoadBtn.disabled, true);
  assert.equal(
    f.el._hamRepeatersBand.disabled,
    true,
    'no filtering mid-transition',
  );

  f.setLifecycle({ lifecycleState: 'enabled', enabled: true, uncertain: true });
  f.emit({});
  assert.equal(f.el._hamRepeatersLayerState.textContent, 'UNCERTAIN');
  assert.equal(f.el._hamRepeatersEnableBtn.textContent, 'RECONCILE');
  assert.equal(
    f.el._hamRepeatersEnableBtn.getAttribute('aria-label'),
    'Reconcile Repeaters — lifecycle uncertain',
  );
  assert.equal(
    f.el._hamRepeatersPanel.classList.contains('lifecycle-uncertain'),
    true,
  );
  assert.equal(f.el._hamRepeatersLoadBtn.disabled, true);

  f.setLifecycle({
    lifecycleState: 'enabled',
    enabled: true,
    uncertain: false,
  });
  f.emit({ loading: true });
  assert.equal(f.el._hamRepeatersLayerState.textContent, 'SYNC');
  assert.equal(f.el._hamRepeatersSummary.textContent, 'Loading repeaters…');
  assert.equal(f.el._hamRepeatersLoadBtn.disabled, false);
});

test('the band and kind selects push their value through layer.setFilter', (t) => {
  const f = fixture({
    enabled: true,
    state: { enabled: true, count: 5, filteredCount: 5 },
  });
  t.after(() => f.cleanup());
  f.controls.connect();

  f.el._hamRepeatersBand.value = '70cm';
  f.el._hamRepeatersBand.fire('change');
  f.el._hamRepeatersKind.value = 'D-STAR';
  f.el._hamRepeatersKind.fire('change');
  assert.deepEqual(f.calls.slice(1), [
    ['setFilter', { band: '70cm' }],
    ['setFilter', { kind: 'D-STAR' }],
  ]);
});

test('LOAD HERE switches the layer on and loads the view centre at the chosen radius', async (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.controls.connect();
  f.el._hamRepeatersRadius.value = '200';

  f.el._hamRepeatersLoadBtn.fire('click');
  // The state emitted by the enable step re-renders and re-opens the button.
  assert.equal(f.el._hamRepeatersLoadBtn.disabled, false);
  await settle();
  assert.deepEqual(f.calls.slice(1), [
    ['runUserAction', 'Repeaters could not start cleanly'],
    ['setEnabled', true, { origin: 'user', notificationToken: 'token' }],
    ['loadAround', 52.52, 13.4, 200, { origin: 'user', reason: 'panel' }],
  ]);
  assert.equal(f.el._hamRepeatersLoadBtn.disabled, false);

  // Already on: no second enable, and an unreadable radius falls back to 100 km.
  f.el._hamRepeatersRadius.value = '';
  f.el._hamRepeatersLoadBtn.fire('click');
  await settle();
  assert.deepEqual(f.calls.at(-1), [
    'loadAround',
    52.52,
    13.4,
    100,
    { origin: 'user', reason: 'panel' },
  ]);
  assert.equal(
    f.calls.filter((call) => call[0] === 'setEnabled').length,
    1,
    'an enabled layer is not switched on again',
  );
});

test('LOAD HERE reports an unreadable view centre and loads nothing', async (t) => {
  const f = fixture({ enabled: true, state: { enabled: true } });
  t.after(() => f.cleanup());
  f.controls.connect();
  f.setCentre(null);

  f.el._hamRepeatersLoadBtn.fire('click');
  await settle();
  assert.equal(
    f.el._hamRepeatersArea.textContent,
    'The view centre could not be read',
  );
  assert.equal(f.el._hamRepeatersArea.classList.contains('error'), true);
  assert.equal(
    f.calls.some((call) => call[0] === 'loadAround'),
    false,
  );
  assert.equal(f.el._hamRepeatersLoadBtn.disabled, false);
});

test('a superseded or cancelled load stays silent while a real failure reaches the area line', async (t) => {
  const f = fixture({ enabled: true, state: { enabled: true } });
  t.after(() => f.cleanup());
  f.controls.connect();

  for (const error of ['superseded', 'cancelled']) {
    f.setLoadResult({ ok: false, count: 0, error });
    f.el._hamRepeatersArea.textContent = 'area sentinel';
    f.el._hamRepeatersLoadBtn.fire('click');
    await settle();
    assert.equal(f.el._hamRepeatersArea.textContent, 'area sentinel', error);
    assert.equal(f.el._hamRepeatersArea.classList.contains('error'), false);
  }

  f.setLoadResult({ ok: false, count: 0, error: 'HamRig did not answer' });
  f.el._hamRepeatersLoadBtn.fire('click');
  assert.equal(
    f.el._hamRepeatersLoadBtn.disabled,
    true,
    'busy while the load is in flight',
  );
  await settle();
  assert.equal(f.el._hamRepeatersLoadBtn.disabled, false);
  assert.equal(f.el._hamRepeatersArea.textContent, 'HamRig did not answer');
  assert.equal(f.el._hamRepeatersArea.classList.contains('error'), true);

  f.setLoadResult({ ok: true, count: 3 });
  f.el._hamRepeatersLoadBtn.fire('click');
  await settle();
  assert.equal(
    f.el._hamRepeatersArea.textContent,
    'HamRig did not answer',
    'a successful load leaves the previous note to the next state render',
  );
});

test('repeater selection and panel events open the Repeaters panel', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.controls.connect();

  f.doc.dispatchEvent(new Event('gev:ham-repeater-selected'));
  f.doc.dispatchEvent(new Event('gev:ham-repeaters-panel'));
  assert.deepEqual(f.calls.slice(1), [
    ['setPanelCollapsed', 'ham-repeaters-panel', false, { explicit: true }],
    ['setPanelCollapsed', 'ham-repeaters-panel', false, { explicit: true }],
  ]);
});

test('the list renders one row per repeater with details, provenance and selection', (t) => {
  const f = fixture({ enabled: true });
  t.after(() => f.cleanup());
  f.controls.connect();
  f.emit({
    enabled: true,
    count: 2,
    filteredCount: 2,
    items: [FM, DSTAR],
    selectedId: DSTAR.id,
    area: { lat: 52.52, lon: 13.4, radiusKm: 100 },
    areaLabel: '100 km around 52.52, 13.40',
  });

  const [first, second] = f.el._hamRepeatersList.children;
  assert.equal(f.el._hamRepeatersList.children.length, 2);

  assert.equal(first.className, 'ham-repeaters-row');
  assert.equal(first.getAttribute('role'), 'option');
  assert.equal(first.getAttribute('aria-selected'), 'false');
  assert.equal(first.dataset.repeaterId, 'fm-db0tv');
  assert.equal(first.tabIndex, 0);
  assert.equal(first.children[0].textContent, '12 km');
  assert.equal(textOf(first.children[1]), 'DB0TV 439.425 MHz');
  assert.equal(first.children[1].children[0].style.color, '#f59e0b');
  assert.equal(first.children[2].textContent, 'FM');
  assert.equal(
    first.children[3].textContent,
    'FM · Berlin, Germany · CTCSS 67 · in 431.825 MHz · EchoLink 123456',
  );
  assert.equal(
    first.children[4].textContent,
    'HamRig FM table · verified · record 2025-05-06 · status On-air (as listed)',
  );

  assert.equal(second.className, 'ham-repeaters-row selected unverified');
  assert.equal(second.getAttribute('aria-selected'), 'true');
  assert.equal(second.children[0].textContent, '', 'no distance, no lead');
  assert.equal(textOf(second.children[1]), 'DB0XYZ 439.550 MHz');
  assert.equal(second.children[1].children[0].style.color, '#a855f7');
  assert.equal(second.children[2].textContent, 'D-STAR B');
  assert.equal(second.children[3].textContent, 'D-STAR');
  assert.equal(
    second.children[4].textContent,
    'dstarinfo · unverified · approximate position',
  );

  first.fire('click');
  assert.deepEqual(f.calls.at(-1), [
    'select',
    'fm-db0tv',
    { flyTo: true, origin: 'user' },
  ]);
});

test('the area line carries the load, gate, partial and error wording', (t) => {
  const f = fixture({ enabled: true });
  t.after(() => f.cleanup());
  f.controls.connect();

  f.emit({
    enabled: true,
    count: 2,
    filteredCount: 2,
    items: [FM, DSTAR],
    partial: true,
    errors: { dstarinfo: 'timeout' },
    area: { lat: 52.52, lon: 13.4, radiusKm: 100 },
    areaLabel: '100 km around 52.52, 13.40',
    lastLoad: { count: 2, at: new Date(Date.now() - 120_000).toISOString() },
    gate: { heightM: 2_400_000, withinGate: false, gateM: 1_500_000 },
  });
  assert.equal(
    f.el._hamRepeatersArea.textContent,
    '100 km around 52.52, 13.40 · 2 loaded 2 min ago · auto-load below 1500 km (now 2400 km) · dstarinfo did not answer',
  );
  assert.equal(f.el._hamRepeatersArea.classList.contains('error'), false);
  assert.equal(
    f.el._hamRepeatersSummary.textContent,
    '2/2 repeaters · partial',
  );

  f.emit({
    count: 0,
    filteredCount: 0,
    items: [],
    stale: true,
    partial: false,
    errors: {},
    error: 'HamRig did not answer',
    lastLoad: null,
    gate: { heightM: 900, withinGate: true, gateM: 1_500_000 },
  });
  assert.equal(
    f.el._hamRepeatersArea.textContent,
    '100 km around 52.52, 13.40 · HamRig did not answer',
  );
  assert.equal(f.el._hamRepeatersArea.classList.contains('error'), true);
  assert.equal(f.el._hamRepeatersSummary.textContent, '0/0 repeaters · cached');
  assert.equal(f.el._hamRepeatersSummary.classList.contains('error'), true);
  assert.deepEqual(
    f.el._hamRepeatersList.children.map((node) => [
      node.className,
      node.textContent,
    ]),
    [['ham-repeaters-list-empty', 'No repeaters in this area.']],
  );

  f.emit({ area: null, areaLabel: '', error: null, stale: false });
  assert.equal(
    f.el._hamRepeatersList.children[0].textContent,
    'Fly below 1500 km or press LOAD HERE.',
  );
  assert.equal(f.el._hamRepeatersArea.textContent, '');

  f.emit({ loading: true });
  assert.equal(f.el._hamRepeatersList.children[0].textContent, 'Loading…');
});

test('reconnecting drops the previous subscription', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.controls.connect();
  f.controls.connect();
  assert.deepEqual(f.calls, [['subscribe'], ['unsubscribe'], ['subscribe']]);
});

test('destroy revokes every listener and a late layer notification renders nothing', async (t) => {
  const f = fixture({
    enabled: true,
    state: { enabled: true, count: 1, filteredCount: 1, items: [FM] },
  });
  t.after(() => f.cleanup());
  f.controls.connect();
  const renderedRows = f.el._hamRepeatersList.children;
  assert.equal(renderedRows.length, 1);

  f.controls.destroy();
  f.controls.destroy();
  assert.deepEqual(f.calls.at(-1), ['unsubscribe']);
  const snapshot = f.calls.length;

  f.el._hamRepeatersEnableBtn.fire('click');
  f.el._hamRepeatersLoadBtn.fire('click');
  f.el._hamRepeatersBand.value = '2m';
  f.el._hamRepeatersBand.fire('change');
  f.el._hamRepeatersKind.fire('change');
  f.doc.dispatchEvent(new Event('gev:ham-repeater-selected'));
  f.doc.dispatchEvent(new Event('gev:ham-repeaters-panel'));
  await settle();
  assert.equal(f.calls.length, snapshot, 'no listener survives destruction');

  f.notifyDetached({
    count: 9,
    filteredCount: 9,
    items: [FM, DSTAR],
    loading: true,
  });
  assert.equal(f.el._hamRepeatersList.children, renderedRows);
  assert.equal(f.el._hamRepeatersLayerState.textContent, '1/1');

  // A reconnect after destruction stays inert too.
  f.controls.connect();
  assert.equal(f.calls.length, snapshot);
});

test('a load that fails after destroy writes nothing into the torn-down panel', async (t) => {
  const f = fixture({ enabled: true });
  t.after(() => f.cleanup());
  f.controls.connect();

  // Hold the load open so the panel can be destroyed while it is in flight,
  // the way a layer teardown or a shell re-init does.
  let settleLoad;
  f.layer.loadAround = (lat, lon, radiusKm, requestOptions) => {
    f.calls.push(['loadAround', lat, lon, radiusKm, requestOptions]);
    return new Promise((resolve) => {
      settleLoad = resolve;
    });
  };

  f.el._hamRepeatersLoadBtn.fire('click');
  await settle();
  const before = f.el._hamRepeatersArea.textContent;

  f.controls.destroy();
  settleLoad({ ok: false, error: 'HamRig did not answer' });
  await settle();

  assert.equal(f.controls.destroyed, true);
  assert.equal(
    f.el._hamRepeatersArea.textContent,
    before,
    'a detached or reused area line is never written after destroy',
  );
  assert.equal(
    f.el._hamRepeatersArea.classList.contains('error'),
    false,
    'and it does not inherit an error class from a dead panel',
  );
});
