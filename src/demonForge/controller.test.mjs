import test from 'node:test';
import assert from 'node:assert/strict';
import { initDemonForge } from './controller.js';

const IDS = [
  'demon-forge-open',
  'demon-forge-dialog',
  'demon-forge-close',
  'demon-forge-lock',
  'demon-forge-unlock-form',
  'demon-forge-passphrase',
  'demon-forge-case-id',
  'demon-forge-import-file',
  'demon-forge-import-status',
  'demon-forge-review-list',
  'demon-forge-draft-form',
  'demon-forge-draft-output',
  'demon-forge-approve',
  'demon-forge-approval-actor',
  'demon-forge-official-route',
  'demon-forge-ledger-output',
  'demon-forge-status',
];

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
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
    const event = { type, preventDefault() {}, ...properties };
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  focus() { this.focused = true; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
}

function fakeDocument() {
  const elements = new Map(IDS.map((id) => [id, new FakeElement(id)]));
  return {
    defaultView: { open() { throw new Error('window.open must not run during open/close.'); } },
    createElement: () => new FakeElement(),
    getElementById: (id) => elements.get(id) ?? null,
    element: (id) => elements.get(id),
  };
}

function fakeVault() {
  return {
    locks: 0,
    async unlock() {},
    async saveCase() {},
    async lock() { this.locks += 1; },
  };
}

test('workspace is hidden until user-opened and close clears rendered personal text', async () => {
  const document = fakeDocument();
  const vault = fakeVault();
  const controller = initDemonForge({ document, vault, now: () => 10 });
  const dialog = document.element('demon-forge-dialog');
  const openButton = document.element('demon-forge-open');

  assert.equal(dialog.hidden, true);
  openButton.dispatch('click');
  assert.equal(dialog.hidden, false);
  assert.equal(openButton.getAttribute('aria-expanded'), 'true');

  document.element('demon-forge-draft-output').textContent = 'personal draft';
  document.element('demon-forge-review-list').append(new FakeElement());
  await controller.close();

  assert.equal(dialog.hidden, true);
  assert.equal(document.element('demon-forge-draft-output').textContent, '');
  assert.equal(document.element('demon-forge-review-list').children.length, 0);
  assert.equal(vault.locks, 1);
});

test('open and keyboard close stay local: no fetch and no globe dependency', () => {
  const document = fakeDocument();
  const vault = fakeVault();
  const originalFetch = globalThis.fetch;
  const originalCesium = Object.getOwnPropertyDescriptor(globalThis, 'Cesium');
  let prevented = false;

  globalThis.fetch = () => { throw new Error('network access is forbidden'); };
  Object.defineProperty(globalThis, 'Cesium', {
    configurable: true,
    get() { throw new Error('globe access is forbidden'); },
  });

  try {
    const controller = initDemonForge({ document, vault, now: () => 20 });
    controller.open();
    document.element('demon-forge-dialog').dispatch('keydown', {
      key: 'Escape',
      preventDefault() { prevented = true; },
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
