import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindApplicationShortcuts,
  createStyleParameters,
} from './visualInput.js';

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

test('number keys retain the seven style mappings', () => {
  const f = shortcuts();
  for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', 'Space'])
    f.press(key);
  assert.deepEqual(
    f.calls,
    ['normal', 'retro', 'surveillance', 'thermal', 'anime', 'noir', 'snow'].map(
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

function parameters() {
  const documentRef = {
    createElement: (tag) => new Element(tag.toUpperCase(), documentRef),
  };
  const container = new Element('DIV', documentRef);
  const controller = createStyleParameters({ container });
  const values = { amount: 0.25, scale: 2 };
  const uniforms = {
    amount: { label: '<Amount>', min: 0, max: 1 },
    scale: { label: 'Scale', min: 0, max: 10 },
  };
  const order = [];
  const options = {
    uniforms,
    readValue: (name) => values[name],
    writeValue: (name, value) => {
      order.push(['write', name, value]);
      values[name] = value;
    },
    onChange: () => {
      order.push(['change', container.children[0]?.children[2].textContent]);
    },
  };
  controller.render(options);
  return { container, controller, values, options, order };
}

test('parameter rows preserve labels, bounds, precision and initial values', () => {
  const f = parameters();
  assert.equal(f.container.children.length, 2);
  const [label, slider, value] = f.container.children[0].children;
  assert.equal(label.textContent, '<Amount>');
  assert.equal(slider.attributes.get('aria-label'), '<Amount>');
  assert.equal(slider.type, 'range');
  assert.equal(slider.className, 'param-slider');
  assert.equal(slider.min, 0);
  assert.equal(slider.max, 1);
  assert.equal(slider.step, '0.01');
  assert.equal(value.textContent, '0.25');
  assert.equal(f.container.children[1].children[1].step, '0.1');
  assert.equal(f.container.children[1].children[2].textContent, '2.0');
  assert.deepEqual(
    f.order,
    [],
    'rendering must not write shader values or publish changes',
  );
});

test('input writes numeric values, updates the readout, then requests a change', () => {
  const f = parameters();
  const slider = f.container.children[0].children[1];
  slider.value = '0.75';
  slider.emit('input');
  assert.equal(f.values.amount, 0.75);
  assert.deepEqual(f.order, [
    ['write', 'amount', 0.75],
    ['change', '0.75'],
  ]);
});

test('rebuilding the parameter panel revokes detached slider listeners', () => {
  const f = parameters();
  const oldSlider = f.container.children[0].children[1];
  f.controller.render({
    ...f.options,
    uniforms: { scale: f.options.uniforms.scale },
  });
  oldSlider.value = '0.8';
  oldSlider.emit('input');
  assert.equal(f.values.amount, 0.25);
  assert.equal(oldSlider.listeners.get('input').size, 0);
  assert.equal(f.container.children.length, 1);
  f.container.children[0].children[1].value = '3.5';
  f.container.children[0].children[1].emit('input');
  assert.equal(f.values.scale, 3.5);
});

test('clearing removes rows and listeners but allows another style', () => {
  const f = parameters();
  const oldSlider = f.container.children[0].children[1];
  f.controller.clear();
  oldSlider.emit('input');
  assert.equal(f.container.children.length, 0);
  assert.deepEqual(f.order, []);
  f.controller.render(f.options);
  assert.equal(f.container.children.length, 2);
});

test('destroy is final and cannot clear a subsequent owner’s DOM', () => {
  const f = parameters();
  const oldSlider = f.container.children[0].children[1];
  f.controller.destroy();
  const nextOwner = new Element();
  f.container.appendChild(nextOwner);
  f.controller.render(f.options);
  f.controller.clear();
  f.controller.destroy();
  oldSlider.emit('input');
  assert.deepEqual(f.container.children, [nextOwner]);
  assert.deepEqual(f.order, []);
});
