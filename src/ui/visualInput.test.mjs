import assert from 'node:assert/strict';
import test from 'node:test';
// Generated parameter rows render through Vue: styleParameters.test.mjs.
import { bindApplicationShortcuts } from './visualInput.js';

class Element {
  constructor(tagName = 'DIV', ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
  }
  addEventListener(type, listener, capture) {
    assert.notEqual(
      capture,
      true,
      'these controls must not preempt capture-phase surfaces',
    );
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) || [])])
      listener(event);
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  append(...children) {
    this.children.push(...children);
  }
  appendChild(child) {
    this.children.push(child);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  matches() {
    return ['INPUT', 'SELECT', 'TEXTAREA'].includes(this.tagName);
  }
}

function shortcuts() {
  const documentRef = new Element();
  const searchInput = new Element();
  const calls = [];
  const names = [
    'setStyle',
    'dismissSearch',
    'toggleHud',
    'toggleOrbit',
    'toggleCleanView',
    'toggleLayers',
    'cycleDetection',
    'toggleCctv',
  ];
  const actions = Object.fromEntries(
    names.map((name) => [name, (...args) => calls.push([name, ...args])]),
  );
  const controller = bindApplicationShortcuts({
    documentRef,
    searchInput,
    actions,
  });
  const press = (key, target = new Element(), rest = {}) =>
    documentRef.emit('keydown', { key, target, ...rest });
  return { documentRef, searchInput, calls, controller, press };
}

test('number keys retain the six style mappings', () => {
  const f = shortcuts();
  for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', 'Space'])
    f.press(key);
  assert.deepEqual(
    f.calls,
    ['normal', 'retro', 'surveillance', 'thermal', 'anime', 'noir'].map(
      (style) => ['setStyle', style],
    ),
  );
});

test('letter shortcuts retain uppercase handling and existing actions', () => {
  const f = shortcuts();
  for (const key of ['H', 'o', 'V', 'f', 'D', 'c']) f.press(key);
  assert.deepEqual(
    f.calls,
    [
      'toggleHud',
      'toggleOrbit',
      'toggleCleanView',
      'toggleLayers',
      'cycleDetection',
      'toggleCctv',
    ].map((name) => [name]),
  );
});

for (const tag of ['INPUT', 'SELECT', 'TEXTAREA']) {
  test(`${tag} retains native editing, while Escape reaches search dismissal`, () => {
    const f = shortcuts();
    for (const key of ['1', 'h', 'o', 'v', 'f', 'd', 'c'])
      f.press(key, new Element(tag));
    assert.deepEqual(f.calls, []);
    f.press('Escape', new Element(tag));
    assert.deepEqual(f.calls, [['dismissSearch']]);
  });
}

test('the supplied search target retains editing even without form markup', () => {
  const f = shortcuts();
  f.press('1', f.searchInput);
  f.press('Escape', f.searchInput);
  assert.deepEqual(f.calls, [['dismissSearch']]);
});

test('shortcut extraction does not change repeat or modifier policy', () => {
  const f = shortcuts();
  f.press('h', new Element(), { repeat: true, ctrlKey: true });
  assert.deepEqual(f.calls, [['toggleHud']]);
});

test('destroy synchronously removes shortcuts and a replacement binds once', () => {
  const f = shortcuts();
  f.controller.destroy();
  f.controller.destroy();
  f.press('h');
  assert.deepEqual(f.calls, []);
  assert.equal(f.documentRef.listeners.get('keydown').size, 0);
  const replacement = bindApplicationShortcuts({
    documentRef: f.documentRef,
    searchInput: f.searchInput,
    actions: { toggleHud: () => f.calls.push('new') },
  });
  f.press('h');
  assert.deepEqual(f.calls, ['new']);
  replacement.destroy();
});
