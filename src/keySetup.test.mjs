import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBackendUrlRow,
  collectKeyUpdates,
  initCapacitorBackendSetup,
  isCapacitorHost,
  keySetupChipLabel,
  localApiBaseStorage,
  mirrorApiBaseToLocalStorage,
  stripKeylessBasemapFromHash,
  bindKeySetupPlacement,
  waitForChatGptOAuth,
} from './keySetup.js';

test('setup placement moves the same button only in Cyber and disconnects on teardown', () => {
  const home = {};
  const chip = { parentNode: home, hidden: true };
  const root = {
    parentNode: home,
    before: (node) => {
      node.parentNode = home;
    },
  };
  let moves = 0;
  const toolbar = {
    append: (node) => {
      moves++;
      node.parentNode = toolbar;
    },
  };
  const theme = { dataset: { uiTheme: 'tactical' } };
  let notify,
    disconnected = false;
  class Observer {
    constructor(callback) {
      notify = callback;
    }
    observe(target, options) {
      assert.equal(target, theme);
      assert.deepEqual(options.attributeFilter, ['data-ui-theme']);
    }
    disconnect() {
      disconnected = true;
    }
  }
  const dispose = bindKeySetupPlacement(
    {
      documentElement: theme,
      getElementById: () => toolbar,
      defaultView: { MutationObserver: Observer },
    },
    chip,
    root,
  );
  assert.equal(chip.parentNode, home);
  for (const variant of ['cyber', 'operator', 'cyber', 'minimal']) {
    theme.dataset.uiTheme = variant;
    notify();
    assert.equal(chip.parentNode, variant === 'cyber' ? toolbar : home);
    notify();
  }
  assert.equal(moves, 2, 'identical theme sync does not reparent again');
  assert.equal(chip.hidden, true, 'placement cannot reveal a retired button');
  dispose();
  assert.equal(disconnected, true);
});

test('the chip counts what is missing, and retires the count at zero', () => {
  assert.equal(
    keySetupChipLabel({ setCount: 0, total: 8 }),
    'POWER UP · 8 KEYS WAITING',
  );
  assert.equal(
    keySetupChipLabel({ setCount: 7, total: 8 }),
    'POWER UP · 1 KEY WAITING',
  );
  assert.equal(keySetupChipLabel({ setCount: 8, total: 8 }), 'POWERED UP');
  assert.equal(
    keySetupChipLabel(null),
    'POWERED UP',
    'no status is not a broken label',
  );
});

test('collectKeyUpdates keeps only non-empty trimmed values', () => {
  const updates = collectKeyUpdates([
    { envVar: 'OPENAI_API_KEY', value: '  sk-abc  ' },
    { envVar: 'FIRMS_MAP_KEY', value: '' },
    { envVar: 'TOMTOM_API_KEY', value: '   ' },
    { envVar: '', value: 'orphan' },
    null,
  ]);
  assert.deepEqual(updates, { OPENAI_API_KEY: 'sk-abc' });
  assert.deepEqual(collectKeyUpdates([]), {});
  assert.deepEqual(collectKeyUpdates(null), {});
});

test('OAuth login polling stops as soon as local ChatGPT auth becomes available', async () => {
  let checks = 0;
  let clock = 0;
  const available = await waitForChatGptOAuth({
    fetchImpl: async () => {
      checks += 1;
      return {
        ok: true,
        json: async () => ({ available: checks >= 3 }),
      };
    },
    timeoutMs: 10_000,
    pollMs: 100,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(available, true);
  assert.equal(checks, 3);
});

test('OAuth login polling stops on login or HTTP failure instead of waiting for timeout', async () => {
  for (const result of [
    {
      ok: true,
      payload: {
        available: false,
        loginFailed: true,
        error: 'Sign-in failed.',
      },
    },
    { ok: false, payload: { error: 'Sign-in is local only.' } },
  ]) {
    let checks = 0;
    await assert.rejects(
      waitForChatGptOAuth({
        fetchImpl: async () => {
          checks += 1;
          return { ok: result.ok, json: async () => result.payload };
        },
        sleep: () => assert.fail('failed login must stop polling'),
      }),
      { message: result.payload.error },
    );
    assert.equal(checks, 1);
  }
});

test('OAuth login polling respects timeout and an aborted setup surface', async () => {
  let clock = 0;
  let checks = 0;
  const poll = {
    fetchImpl: async () => {
      checks += 1;
      return {
        ok: true,
        json: async () => ({ available: false, pending: true }),
      };
    },
  };
  assert.equal(
    await waitForChatGptOAuth({
      ...poll,
      timeoutMs: 100,
      pollMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }),
    false,
  );
  assert.equal(checks, 2);
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await waitForChatGptOAuth({ ...poll, signal: controller.signal }),
    false,
  );
  assert.equal(checks, 2, 'aborted polling does not fetch');
});

test('OAuth polling ignores a ready response received after the surface was aborted', async () => {
  const controller = new AbortController();
  const available = await waitForChatGptOAuth({
    signal: controller.signal,
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return { available: true };
      },
    }),
    sleep: () => assert.fail('aborted polling must not continue'),
  });
  assert.equal(available, false);
});

test('the first Google key strips ONLY the keyless OSM basemap from the share hash', () => {
  const stripped = stripKeylessBasemapFromHash(
    'lat=30.2&lon=-97.7&map=osm&style=normal',
  );
  assert.ok(stripped !== null);
  const params = new URLSearchParams(stripped);
  assert.equal(params.get('map'), null, 'osm basemap removed');
  assert.equal(params.get('lat'), '30.2', 'camera survives');
  assert.equal(params.get('style'), 'normal', 'style survives');
  // A stack under any other name was chosen or shared on purpose.
  assert.equal(stripKeylessBasemapFromHash('map=bing-aerial&lat=1'), null);
  assert.equal(
    stripKeylessBasemapFromHash('lat=1&lon=2'),
    null,
    'no stack, nothing to do',
  );
  assert.equal(stripKeylessBasemapFromHash(''), null);
  assert.equal(stripKeylessBasemapFromHash(undefined), null);
});

test('aborting pending setup removes its surface and ignores a late response', async () => {
  const { initKeySetup } = await import('./keySetup.js');
  const removed = [];
  const chip = { remove: () => removed.push('chip') };
  const root = { dataset: {}, remove: () => removed.push('root') };
  let resolveResponse;
  let requestSignal;
  const controller = new AbortController();
  const pending = initKeySetup({
    documentRef: {
      getElementById: (id) => (id === 'key-setup-chip' ? chip : root),
    },
    signal: controller.signal,
    fetchImpl: (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    },
  });
  controller.abort();
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(removed, ['chip', 'root']);
  resolveResponse({ ok: true, json: async () => ({ keys: [] }) });
  assert.equal(await pending, null);
});

/** Minimal fake DOM for the Capacitor backend-URL surface. */
function fakeBackendElement(tag = 'div') {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    hidden: true,
    textContent: '',
    value: '',
    title: '',
    placeholder: '',
    type: '',
    spellcheck: false,
    isConnected: true,
    _removed: false,
    _classes: new Set(),
    classList: {
      add: (...names) => names.forEach((name) => el._classes.add(name)),
      remove: (...names) => names.forEach((name) => el._classes.delete(name)),
      contains: (name) => el._classes.has(name),
    },
    append(...nodes) {
      el.children.push(...nodes);
      return nodes[0];
    },
    appendChild(node) {
      el.children.push(node);
      return node;
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener(type, listener) {
      const list = listeners.get(type) || [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) || []).filter((fn) => fn !== listener),
      );
    },
    getClientRects() {
      return [{}];
    },
    focus() {},
    remove() {
      el._removed = true;
    },
    contains(node) {
      if (node === el) return true;
      return (el.children || []).some(
        (child) => child === node || child.contains?.(node),
      );
    },
    querySelector(selector) {
      return queryFake(el, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return queryFake(el, selector);
    },
    fire(type, event = {}) {
      for (const listener of listeners.get(type) || [])
        listener({ target: el, ...event });
    },
  };
  return el;
}

function matchesFakeSelector(el, selector) {
  for (const part of String(selector).split(',')) {
    const text = part.trim();
    const match = text.match(
      /^([a-zA-Z][a-zA-Z0-9]*)?(?:\[([^\]="]+)(?:="([^"]*)")?\])?$/,
    );
    if (!match) continue;
    const [, tag, attr, expected] = match;
    if (!tag && !attr) continue;
    if (tag && el.tagName !== tag.toUpperCase()) continue;
    if (attr) {
      const key = attr.startsWith('data-')
        ? attr.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())
        : attr;
      const actual = el.dataset?.[key];
      if (expected !== undefined && actual !== expected) continue;
      if (expected === undefined && actual === undefined) continue;
    }
    return true;
  }
  return false;
}

function queryFake(root, selector) {
  const found = [];
  const visit = (node) => {
    for (const child of node.children || []) {
      if (matchesFakeSelector(child, selector)) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

function fakeBackendDocument({ capacitor = false } = {}) {
  const listeners = new Map();
  const byId = new Map();
  return {
    defaultView: capacitor
      ? { Capacitor: { getPlatform: () => 'android' } }
      : {},
    activeElement: null,
    addEventListener(type, listener) {
      const list = listeners.get(type) || [];
      list.push(listener);
      listeners.set(type, list);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) || []).filter((fn) => fn !== listener),
      );
    },
    createElement: (tag) => fakeBackendElement(tag),
    getElementById: (id) => byId.get(id) || null,
    _ids: byId,
  };
}

/** Preferences-shaped stub store plus a DOM hosting the backend surface. */
function makeBackendHarness({ stored = null, capacitor = true } = {}) {
  const values = new Map(stored === null ? [] : [['GEV_API_BASE', stored]]);
  const storage = {
    values,
    get: async ({ key }) => ({
      value: values.has(key) ? values.get(key) : null,
    }),
    set: async ({ key, value }) => {
      values.set(key, String(value));
    },
    remove: async ({ key }) => {
      values.delete(key);
    },
  };
  const documentRef = fakeBackendDocument({ capacitor });
  const chip = fakeBackendElement('button');
  const chipLabel = fakeBackendElement('span');
  chip.querySelector = (selector) =>
    selector === '[data-key-setup-chip-label]' ? chipLabel : null;
  const root = fakeBackendElement('aside');
  root.dataset = {};
  const rowsHost = fakeBackendElement('div');
  const applyButton = fakeBackendElement('button');
  const closeButton = fakeBackendElement('button');
  const statusLine = fakeBackendElement('p');
  root.append(rowsHost, applyButton, closeButton, statusLine);
  const bySelector = new Map([
    ['[data-key-setup-rows]', rowsHost],
    ['[data-key-setup-apply]', applyButton],
    ['[data-key-setup-close]', closeButton],
    ['[data-key-setup-status]', statusLine],
  ]);
  const recursiveQuery = root.querySelector.bind(root);
  root.querySelector = (selector) =>
    bySelector.get(selector) || recursiveQuery(selector);
  documentRef._ids.set('key-setup-chip', chip);
  documentRef._ids.set('key-setup', root);
  return { storage, documentRef, chip, chipLabel, root, applyButton };
}

const flushAsyncHandlers = async () => {
  for (let i = 0; i < 5; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

test('isCapacitorHost is true only with a Capacitor runtime', () => {
  assert.equal(isCapacitorHost(undefined), false);
  assert.equal(isCapacitorHost(null), false);
  assert.equal(isCapacitorHost({}), false);
  assert.equal(
    isCapacitorHost({ Capacitor: { getPlatform: () => 'android' } }),
    true,
  );
  assert.equal(isCapacitorHost(), false, 'node has no window');
});

test('buildBackendUrlRow carries the GEV_API_BASE field prefilled', () => {
  const documentRef = fakeBackendDocument();
  const row = buildBackendUrlRow(documentRef, 'https://home:4173');
  assert.equal(row.dataset.keyId, 'backend-url');
  assert.equal(row.dataset.set, 'true');
  const input = row.querySelector('input[data-env-var="GEV_API_BASE"]');
  assert.equal(input.value, 'https://home:4173');
  assert.equal(buildBackendUrlRow(documentRef).dataset.set, 'false');
});

test('localApiBaseStorage mirrors the Preferences shape over localStorage', async () => {
  const backing = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
  };
  try {
    const adapter = localApiBaseStorage();
    assert.deepEqual(await adapter.get({ key: 'GEV_API_BASE' }), {
      value: null,
    });
    assert.deepEqual(await adapter.get({ key: 'OTHER' }), { value: null });
    await adapter.set({ key: 'GEV_API_BASE', value: 'https://home:4173' });
    assert.deepEqual(await adapter.get({ key: 'GEV_API_BASE' }), {
      value: 'https://home:4173',
    });
    await adapter.remove({ key: 'GEV_API_BASE' });
    assert.deepEqual(await adapter.get({ key: 'GEV_API_BASE' }), {
      value: null,
    });
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('mirrorApiBaseToLocalStorage tracks the resolved base for the boot seam', () => {
  const backing = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (backing.has(key) ? backing.get(key) : null),
    setItem: (key, value) => backing.set(key, String(value)),
    removeItem: (key) => backing.delete(key),
  };
  try {
    mirrorApiBaseToLocalStorage('https://home:4173');
    assert.equal(backing.get('GEV_API_BASE'), 'https://home:4173');
    mirrorApiBaseToLocalStorage('');
    assert.equal(backing.has('GEV_API_BASE'), false);
  } finally {
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});

test('web without a dev server still removes the setup surface', async () => {
  const { initKeySetup } = await import('./keySetup.js');
  const documentRef = fakeBackendDocument({ capacitor: false });
  const chip = fakeBackendElement('button');
  const root = fakeBackendElement('aside');
  root.dataset = {};
  documentRef._ids.set('key-setup-chip', chip);
  documentRef._ids.set('key-setup', root);
  const result = await initKeySetup({
    documentRef,
    fetchImpl: async () => {
      throw new Error('no dev server on web prod');
    },
  });
  assert.equal(result, null);
  assert.equal(chip._removed, true);
  assert.equal(root._removed, true);
});

test('capacitor without a dev server shows the backend field and saves through storage', async () => {
  const { initKeySetup } = await import('./keySetup.js');
  const harness = makeBackendHarness({ stored: 'https://home:4173' });
  const mirror = new Map();
  const previousLocalStorage = globalThis.localStorage;
  const previousEnv = globalThis.process?.env?.GEV_API_BASE;
  if (globalThis.process?.env) delete globalThis.process.env.GEV_API_BASE;
  globalThis.localStorage = {
    getItem: (key) => (mirror.has(key) ? mirror.get(key) : null),
    setItem: (key, value) => mirror.set(key, String(value)),
    removeItem: (key) => mirror.delete(key),
  };
  let reloads = 0;
  try {
    const controls = await initKeySetup({
      documentRef: harness.documentRef,
      fetchImpl: async () => {
        throw new Error('no dev server in the shell');
      },
      apiBaseStorage: harness.storage,
      reloadImpl: () => {
        reloads += 1;
      },
    });
    assert.ok(controls, 'surface survives under Capacitor');
    assert.equal(harness.chip.hidden, false);
    assert.equal(harness.chipLabel.textContent, 'SET BACKEND');
    const input = harness.root.querySelector(
      'input[data-env-var="GEV_API_BASE"]',
    );
    assert.equal(input.value, 'https://home:4173');

    harness.chip.fire('click');
    assert.equal(harness.root.hidden, false);

    input.value = 'https://gev-backend.example:4173/';
    harness.applyButton.fire('click');
    await flushAsyncHandlers();
    assert.equal(
      harness.storage.values.get('GEV_API_BASE'),
      'https://gev-backend.example:4173',
    );
    assert.equal(
      mirror.get('GEV_API_BASE'),
      'https://gev-backend.example:4173',
    );
    assert.equal(reloads, 1);

    input.value = 'http://localhost:9999/evil?.js';
    harness.applyButton.fire('click');
    await flushAsyncHandlers();
    assert.equal(harness.storage.values.has('GEV_API_BASE'), false);
    assert.equal(mirror.has('GEV_API_BASE'), false);
    assert.equal(reloads, 2, 'clearing the field still reloads to same-origin');
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
    if (globalThis.process?.env && previousEnv !== undefined)
      globalThis.process.env.GEV_API_BASE = previousEnv;
  }
});

test('initCapacitorBackendSetup falls back to the boot seam when storage is empty', async () => {
  const harness = makeBackendHarness({ stored: null });
  const previousEnv = globalThis.process?.env?.GEV_API_BASE;
  if (globalThis.process?.env) delete globalThis.process.env.GEV_API_BASE;
  const previousLocalStorage = globalThis.localStorage;
  delete globalThis.localStorage;
  try {
    const controls = await initCapacitorBackendSetup({
      documentRef: harness.documentRef,
      chip: harness.chip,
      root: harness.root,
      storage: harness.storage,
      reload: () => {},
    });
    assert.ok(controls);
    const input = harness.root.querySelector(
      'input[data-env-var="GEV_API_BASE"]',
    );
    assert.equal(input.value, '');
    controls.dispose();
  } finally {
    if (previousLocalStorage !== undefined)
      globalThis.localStorage = previousLocalStorage;
    if (globalThis.process?.env && previousEnv !== undefined)
      globalThis.process.env.GEV_API_BASE = previousEnv;
  }
});
