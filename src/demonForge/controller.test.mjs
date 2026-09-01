import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initDemonForge } from './controller.js';

const IDS = [
  'demon-forge-open', 'demon-forge-dialog', 'demon-forge-close', 'demon-forge-lock',
  'demon-forge-unlock-form', 'demon-forge-passphrase', 'demon-forge-case-id',
  'demon-forge-import-file', 'demon-forge-import-status', 'demon-forge-review-list',
  'demon-forge-draft-form', 'demon-forge-action', 'demon-forge-controller-name',
  'demon-forge-contact-route', 'demon-forge-draft-output', 'demon-forge-approve',
  'demon-forge-approval-actor', 'demon-forge-official-route',
  'demon-forge-ledger-output', 'demon-forge-status',
];

class FakeElement {
  constructor(id = '', ownerDocument = null) {
    this.id = id;
    this.ownerDocument = ownerDocument;
    this.hidden = false;
    this.disabled = false;
    this.inert = false;
    this.value = '';
    this.textContent = '';
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
    this.queryResults = [];
    this.formValues = new Map();
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== handler));
  }

  dispatch(type, properties = {}) {
    const event = { type, preventDefault() {}, shiftKey: false, ...properties };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  async dispatchAsync(type, properties = {}) {
    const event = { type, preventDefault() {}, shiftKey: false, ...properties };
    await Promise.all((this.listeners.get(type) ?? []).map((handler) => handler(event)));
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelectorAll() { return this.queryResults; }
  contains(target) { return target === this || this.children.some((child) => child?.contains?.(target)); }
}

function fakeDocument({ open = () => ({}) } = {}) {
  const document = { activeElement: null, defaultView: { open }, body: { children: [] } };
  const elements = new Map(IDS.map((id) => [id, new FakeElement(id, document)]));
  const background = new FakeElement('background', document);
  document.createElement = () => new FakeElement('', document);
  document.getElementById = (id) => elements.get(id) ?? null;
  document.element = (id) => elements.get(id);
  document.body.children = [background, elements.get('demon-forge-open'), elements.get('demon-forge-dialog')];
  document.background = background;
  elements.get('demon-forge-dialog').children = IDS
    .filter((id) => !['demon-forge-open', 'demon-forge-dialog'].includes(id))
    .map((id) => elements.get(id));
  elements.get('demon-forge-dialog').queryResults = elements.get('demon-forge-dialog').children;
  return document;
}

function fakeVault() {
  return {
    locks: 0,
    saves: [],
    timeline: [],
    failNextSave: false,
    async unlock() {},
    async saveCase(record) {
      this.timeline.push('save');
      if (this.failNextSave) {
        this.failNextSave = false;
        throw new Error('disk unavailable');
      }
      this.saves.push(JSON.parse(JSON.stringify(record)));
    },
    async lock() { this.locks += 1; },
  };
}

async function prepareApprovedDraft(document, vault) {
  const originalFormData = globalThis.FormData;
  globalThis.FormData = class {
    constructor(form) { this.values = form.formValues; }
    get(name) { return this.values.get(name); }
  };
  try {
    let tick = 100;
    const controller = initDemonForge({ document, vault, now: () => tick++ });
    controller.open();
    document.element('demon-forge-case-id').value = 'case-1';
    document.element('demon-forge-passphrase').value = 'local secret';
    await document.element('demon-forge-unlock-form').dispatchAsync('submit');

    document.element('demon-forge-import-file').files = [{
      type: 'application/json',
      async text() {
        return JSON.stringify({ detected: [{ site: 'Example', url: 'https://example.test/profile', username: 'local-user', rate: 99 }] });
      },
    }];
    await document.element('demon-forge-import-file').dispatchAsync('change');
    await document.element('demon-forge-review-list').children[0].children[1].dispatchAsync('click');

    const draftForm = document.element('demon-forge-draft-form');
    draftForm.formValues = new Map([
      ['action', 'erasure'], ['controllerName', 'Example Controller'], ['contactRoute', 'https://example.test/privacy'],
    ]);
    await draftForm.dispatchAsync('submit');
    document.element('demon-forge-approval-actor').value = 'owner';
    await document.element('demon-forge-approve').dispatchAsync('click');
    assert.equal(document.element('demon-forge-official-route').disabled, false);
    return controller;
  } finally {
    globalThis.FormData = originalFormData;
  }
}

test('modal makes the background inert, traps focus, and restores the opener', async () => {
  const document = fakeDocument();
  const controller = initDemonForge({ document, vault: fakeVault(), now: () => 10 });
  const dialog = document.element('demon-forge-dialog');
  const opener = document.element('demon-forge-open');
  const first = document.element('demon-forge-close');
  const last = document.element('demon-forge-lock');
  dialog.queryResults = [first, last];

  opener.focus();
  opener.dispatch('click');
  assert.equal(document.background.inert, true);
  assert.equal(opener.inert, true);
  assert.equal(document.activeElement, first);

  last.focus();
  dialog.dispatch('keydown', { key: 'Tab', preventDefault() {} });
  assert.equal(document.activeElement, first);
  first.focus();
  dialog.dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} });
  assert.equal(document.activeElement, last);

  await controller.close();
  assert.equal(document.background.inert, false);
  assert.equal(opener.inert, false);
  assert.equal(document.activeElement, opener);
});

test('close and lock scrub rendered text and every draft control', async () => {
  for (const action of ['close', 'lock']) {
    const document = fakeDocument();
    const controller = initDemonForge({ document, vault: fakeVault(), now: () => 10 });
    controller.open();
    document.element('demon-forge-draft-output').textContent = 'personal draft';
    document.element('demon-forge-controller-name').value = 'Personal Controller';
    document.element('demon-forge-contact-route').value = 'https://personal.test/request';
    document.element('demon-forge-approval-actor').value = 'Personal Name';
    document.element('demon-forge-action').value = 'correction';

    if (action === 'close') await controller.close();
    else await document.element('demon-forge-lock').dispatchAsync('click');

    assert.equal(document.element('demon-forge-draft-output').textContent, '');
    assert.equal(document.element('demon-forge-controller-name').value, '');
    assert.equal(document.element('demon-forge-contact-route').value, '');
    assert.equal(document.element('demon-forge-approval-actor').value, '');
    assert.equal(document.element('demon-forge-action').value, 'erasure');
  }
});

test('close and lock invalidate awaited local file text before it can repopulate', async () => {
  for (const action of ['close', 'lock']) {
    const document = fakeDocument();
    const vault = fakeVault();
    const controller = initDemonForge({ document, vault, now: () => 30 });
    controller.open();
    document.element('demon-forge-case-id').value = 'case-stale';
    await document.element('demon-forge-unlock-form').dispatchAsync('submit');

    let resolveText;
    const textReady = new Promise((resolve) => { resolveText = resolve; });
    const fileInput = document.element('demon-forge-import-file');
    fileInput.files = [{ type: 'application/json', text: () => textReady }];
    const importing = fileInput.dispatchAsync('change');
    if (action === 'close') await controller.close();
    else document.element('demon-forge-lock').dispatch('click');
    resolveText(JSON.stringify({ detected: [{ site: 'Late', url: 'https://late.test/user', rate: 90 }] }));
    await importing;

    assert.equal(document.element('demon-forge-review-list').children.length, 0);
    assert.equal(document.element('demon-forge-import-status').textContent, '');
    assert.equal(vault.saves.length, 0);
  }
});

test('Demon Forge opener is outside the Globe actions navigation landmark', async () => {
  const html = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
  const globeNav = html.match(/<nav id="top-center-actions"[\s\S]*?<\/nav>/u)?.[0];
  assert.ok(globeNav);
  assert.doesNotMatch(globeNav, /demon-forge-open/u);
  assert.match(html, /<\/nav>\s*<button id="demon-forge-open"/u);
});

test('Demon Forge opener is hidden by clean-view, cockpit, and recording modes', async () => {
  const css = await readFile(new URL('../../style.css', import.meta.url), 'utf8');
  assert.match(css, /body\.ui-clean-view #demon-forge-open,/u);
  assert.match(css, /body\.recording-mode #demon-forge-open,/u);
  const cockpitHide = css.match(/body\.cockpit-mode :is\([\s\S]*?\) \{ display: none !important; \}/u)?.[0];
  assert.ok(cockpitHide);
  assert.match(cockpitHide, /#demon-forge-open/u);
});

test('Demon Forge docs keep the boundary language in sync', async () => {
  const [readme, changelog, currentState] = await Promise.all([
    readFile(new URL('../../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../../CHANGELOG.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/CURRENT-STATE.md', import.meta.url), 'utf8'),
  ]);
  const docs = `${readme}\n${changelog}\n${currentState}`;

  assert.match(docs, /local-first/u);
  assert.match(docs, /no automatic request submission/u);
  assert.match(docs, /signed mandate/u);
  assert.match(docs, /Social Analyzer report/u);
  assert.match(docs, /human confirmation/u);
  assert.match(docs, /encrypted evidence/u);
  assert.match(docs, /official handoff/u);
  assert.match(docs, /France\/EU-first/u);
  assert.match(docs, /not legal advice/u);
});

test('official route requires durable audit before navigation', async () => {
  let openCalls = 0;
  const document = fakeDocument({ open: () => { openCalls += 1; return {}; } });
  const vault = fakeVault();
  await prepareApprovedDraft(document, vault);
  vault.timeline = [];
  vault.failNextSave = true;
  await document.element('demon-forge-official-route').dispatchAsync('click');

  assert.equal(openCalls, 0);
  assert.deepEqual(vault.timeline, ['save']);
  assert.match(document.element('demon-forge-status').textContent, /audit record was not saved/i);
});

test('noopener handoff return value never claims an actual open or block outcome', async () => {
  for (const returnValue of [null, {}]) {
    const vault = fakeVault();
    const document = fakeDocument({ open: () => { vault.timeline.push('handoff'); return returnValue; } });
    await prepareApprovedDraft(document, vault);
    vault.timeline = [];
    await document.element('demon-forge-official-route').dispatchAsync('click');

    assert.deepEqual(vault.timeline, ['save', 'handoff', 'save']);
    const eventTypes = vault.saves.at(-1).ledger.map((event) => event.type);
    assert.deepEqual(eventTypes, ['MANUAL_ROUTE_ATTEMPTED', 'MANUAL_ROUTE_HANDOFF_TRIGGERED']);
    assert.doesNotMatch(eventTypes.join(','), /OPENED|BLOCKED/u);
    assert.match(document.element('demon-forge-status').textContent, /whether the official route opened is unknown/i);
  }
});

test('a thrown browser handoff is recorded as failed without claiming an open', async () => {
  const vault = fakeVault();
  const document = fakeDocument({ open: () => { throw new Error('browser denied call'); } });
  await prepareApprovedDraft(document, vault);
  vault.timeline = [];
  await document.element('demon-forge-official-route').dispatchAsync('click');

  assert.deepEqual(vault.saves.at(-1).ledger.map((event) => event.type), [
    'MANUAL_ROUTE_ATTEMPTED', 'MANUAL_ROUTE_HANDOFF_FAILED',
  ]);
  assert.match(document.element('demon-forge-status').textContent, /handoff failed/i);
});

test('Escape close stays local with poisoned fetch and globe globals', () => {
  const document = fakeDocument();
  const originalFetch = globalThis.fetch;
  const originalCesium = Object.getOwnPropertyDescriptor(globalThis, 'Cesium');
  let prevented = false;
  globalThis.fetch = () => { throw new Error('network access is forbidden'); };
  Object.defineProperty(globalThis, 'Cesium', { configurable: true, get() { throw new Error('globe access is forbidden'); } });
  try {
    const controller = initDemonForge({ document, vault: fakeVault(), now: () => 20 });
    controller.open();
    document.element('demon-forge-dialog').dispatch('keydown', {
      key: 'Escape', preventDefault() { prevented = true; },
    });
    assert.equal(prevented, true);
    assert.equal(document.element('demon-forge-dialog').hidden, true);
    controller.destroy();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCesium) Object.defineProperty(globalThis, 'Cesium', originalCesium);
    else delete globalThis.Cesium;
  }
});
