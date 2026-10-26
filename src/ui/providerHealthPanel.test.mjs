import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderHealthPanel } from './providerHealthPanel.js';

function fakeElement(tag = 'div') {
  return {
    tagName: tag.toUpperCase(),
    hidden: false,
    className: '',
    textContent: '',
    children: [],
    attributes: new Map(),
    summary: null,
    setAttribute(key, value) {
      this.attributes.set(key, String(value));
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    append(...nodes) {
      for (const child of nodes) this.appendChild(child);
    },
    replaceChildren(...nodes) {
      this.children = [...nodes];
    },
    querySelector(selector) {
      if (selector === '[data-health-summary]') return this.summary;
      return null;
    },
  };
}

/** Node has no global document, so any stray `document` use throws here. */
function panelFixture() {
  const toggle = fakeElement('button');
  toggle.summary = fakeElement('span');
  const popover = fakeElement('div');
  popover.hidden = true;
  const list = fakeElement('div');
  const elements = new Map([
    ['provider-health-toggle', toggle],
    ['provider-health-panel', popover],
    ['provider-health-list', list],
  ]);
  const documentRef = {
    createElement: (tag) => fakeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    getElementById: (id) => elements.get(id) ?? null,
  };
  return { documentRef, toggle, popover, list };
}

const layers = [
  {
    id: 'flights',
    name: 'Flights',
    source: 'OpenSky',
    enabled: true,
    stats: { status: 'live', count: 42, lastUpdate: 99_000 },
  },
  {
    id: 'firms',
    name: 'Active Fires',
    source: 'NASA FIRMS',
    enabled: true,
    stats: { status: 'unavailable', keyRequired: true, error: 'KEY REQUIRED' },
  },
];

test('renders rows and summary through the injected document only', () => {
  const { documentRef, toggle, popover, list } = panelFixture();
  const panel = new ProviderHealthPanel({ documentRef, now: () => 100_000 });
  panel.connect({ getAll: () => layers });
  assert.equal(toggle.summary.children[0].textContent, '1 live · 1 attention');
  assert.equal(list.children.length, 0, 'a closed popover renders no rows');
  popover.hidden = false;
  panel.render();
  assert.equal(list.children.length, 2);
  panel.destroy();
});

test('follows the activity channel that carries out-of-band updates', () => {
  const { documentRef, popover, list } = panelFixture();
  popover.hidden = false;
  const listeners = [];
  const manager = {
    getAll: () => layers,
    subscribe() {
      throw new Error('subscribeActivity must win when both channels exist');
    },
    subscribeActivity(listener) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
  };
  const panel = new ProviderHealthPanel({ documentRef, now: () => 100_000 });
  panel.connect(manager);
  assert.equal(list.children.length, 2);
  list.replaceChildren();
  listeners[0]({ type: 'status', layerId: 'flights' });
  assert.equal(list.children.length, 2, 'an activity event repaints the rows');
  panel.destroy();
  assert.equal(listeners.length, 0, 'destroy unsubscribes');
});

test('a manager that only publishes lifecycle still refreshes the panel', () => {
  const { documentRef, popover, list } = panelFixture();
  popover.hidden = false;
  let listener = null;
  const manager = {
    getAll: () => layers,
    subscribe(fn) {
      listener = fn;
      return () => {
        listener = null;
      };
    },
  };
  const panel = new ProviderHealthPanel({ documentRef, now: () => 100_000 });
  panel.connect(manager);
  list.replaceChildren();
  listener?.();
  assert.equal(list.children.length, 2);
  panel.destroy();
  assert.equal(listener, null);
});
