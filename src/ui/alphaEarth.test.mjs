import test from 'node:test';
import assert from 'node:assert/strict';

import { createAlphaEarthPanel } from './alphaEarth.js';
import { createAlphaEarthLayer } from '../layers/alphaEarth/index.js';
import { createAlphaEarthRenderer } from '../layers/alphaEarth/rendering.js';
import {
  changePayload,
  fakeCollection,
  fakeRendererDeps,
  fakeSource,
  tick,
} from '../layers/alphaEarth/testDoubles.mjs';

const BOX = { west: -97.64, south: 30.21, east: -97.6, north: 30.24 };

// ---- a small DOM double ------------------------------------------------------
class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.hidden = false;
    this.disabled = false;
    this.id = '';
    this.value = '';
    this._text = '';
  }
  get classList() {
    const node = this;
    const names = () => new Set(node.className.split(/\s+/).filter(Boolean));
    return {
      contains: (name) => names().has(name),
      toggle(name) {
        const set = names();
        if (set.has(name)) set.delete(name);
        else set.add(name);
        node.className = [...set].join(' ');
      },
    };
  }
  get textContent() {
    return this.children.length
      ? this.children.map((child) => child.textContent).join('')
      : this._text;
  }
  set textContent(value) {
    this.children = [];
    this._text = String(value);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...children) {
    for (const child of children) this.appendChild(child);
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
  dispatch(type) {
    for (const handler of [...(this.listeners.get(type) || [])])
      handler({ type, target: this });
  }
  click() {
    if (!this.disabled) this.dispatch('click');
  }
  find(predicate) {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const inner = child.find(predicate);
      if (inner) return inner;
    }
    return null;
  }
  querySelector(selector) {
    const target = /^\[data-collapse-target="([^"]+)"\]$/.exec(selector)?.[1];
    return this.find((node) => node.dataset.collapseTarget === target);
  }
  listenerCount() {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}

/** The static rail panel skeleton from templates/context.html. */
function fixture() {
  const document = {
    activeElement: null,
    createElement: (tag) => new FakeElement(tag, document),
    getElementById: (id) => document.body.find((node) => node.id === id),
  };
  document.body = new FakeElement('body', document);
  const panel = document.createElement('div');
  panel.id = 'alpha-earth-panel';
  panel.className = 'panel-collapsible collapsed';
  panel.hidden = true;
  const count = document.createElement('span');
  count.id = 'alpha-earth-panel-count';
  const collapse = document.createElement('button');
  collapse.dataset.collapseTarget = 'alpha-earth-panel';
  collapse.click = () => panel.classList.toggle('collapsed');
  const body = document.createElement('div');
  body.id = 'alpha-earth-panel-body';
  panel.append(count, collapse, body);
  document.body.appendChild(panel);

  const source = fakeSource();
  const layer = createAlphaEarthLayer({
    source,
    renderer: createAlphaEarthRenderer(fakeRendererDeps()),
    host: () => ({ collection: fakeCollection(), kind: 'globe' }),
  });
  const calls = [];
  let active = false;
  const tool = {
    start: () => {
      active = true;
      calls.push('start');
    },
    cancel: (reason) => {
      active = false;
      calls.push(`cancel:${reason}`);
    },
    isActive: () => active,
  };
  const ui = createAlphaEarthPanel({ container: body, layer, tool });
  const byText = (text) =>
    ui.root.find((node) => node.tagName === 'BUTTON' && node.textContent === text);
  const byLabel = (label) =>
    ui.root.find((node) => node.getAttribute('aria-label') === label);
  return { panel, count, layer, source, ui, calls, byText, byLabel };
}

test('the panel appears with the layer, opens once and reads the comparison', async () => {
  const { panel, count, layer, source, ui, byLabel } = fixture();
  assert.equal(panel.hidden, true, 'hidden while the layer is off');
  layer.enable({});
  await tick();
  assert.equal(panel.hidden, false);
  assert.equal(panel.classList.contains('collapsed'), false, 'opened on first appearance');
  const from = byLabel('From year');
  assert.deepEqual(
    from.children.map((option) => option.value),
    ['2017', '2018', '2024'],
  );
  assert.equal(from.value, '2018');
  assert.equal(byLabel('To year').value, '2024');

  layer.setBox(BOX);
  const status = ui.root.find((node) => node.getAttribute('role') === 'status');
  assert.match(status.textContent, /Comparing 2018 → 2024/);
  source.requests[0].resolve(changePayload());
  await tick();
  assert.match(status.textContent, /not single-day events/);
  assert.equal(count.textContent, '57.1% CHANGED');

  layer.disable();
  assert.equal(panel.hidden, true);
  assert.equal(count.textContent, '');
});

test('controls drive the layer and the slider never re-requests', async () => {
  const { layer, source, calls, byText, byLabel } = fixture();
  layer.enable({});
  await tick();
  byText('SELECT BOX').click();
  assert.deepEqual(calls, ['start']);
  byText('SELECT BOX').click();
  assert.deepEqual(calls, ['start', 'cancel:toggle']);

  layer.setBox(BOX);
  source.requests[0].resolve(changePayload());
  await tick();
  const threshold = byLabel('Change threshold');
  threshold.value = '90';
  threshold.dispatch('input');
  assert.equal(layer.getSnapshot().threshold, 0.9);
  assert.equal(source.requests.length, 1);

  const from = byLabel('From year');
  from.value = '2017';
  from.dispatch('change');
  assert.equal(source.requests.length, 2);
  assert.equal(source.requests[1].query.from, 2017);

  byText('CLEAR').click();
  assert.equal(layer.getSnapshot().box, null);
  assert.equal(byText('CLEAR').disabled, true);
});

test('destroy removes the readout and every listener', () => {
  const { panel, layer, ui } = fixture();
  layer.enable({});
  const controls = [];
  ui.root.find((node) => {
    if (node.listenerCount() > 0) controls.push(node);
    return false;
  });
  assert.ok(controls.length >= 6);
  ui.destroy();
  assert.equal(ui.root.parentNode, null);
  assert.equal(panel.hidden, true);
  assert.ok(controls.every((node) => node.listenerCount() === 0));
});

test('a quiet result says so and offers the threshold that shows it', async () => {
  const { layer, source, ui, byLabel } = fixture();
  layer.enable({});
  await tick();
  layer.setBox(BOX);
  // 1,000 still pixels but one strong change and nine moderate ones.
  const grid = new Uint8Array(1000).fill(3);
  grid.fill(51, 990, 999);
  grid[999] = 122;
  source.requests[0].resolve({
    ...changePayload({ width: 40, height: 25 }),
    grid: Buffer.from(grid).toString('base64'),
  });
  await tick();
  const status = ui.root.find((node) => node.getAttribute('role') === 'status');
  assert.match(status.textContent, /Almost nothing reaches 0\.35 here · strongest change 0\.48/);
  const reveal = ui.root.find((node) => node.className.includes('ae-reveal'));
  assert.equal(reveal.hidden, false);
  assert.equal(reveal.textContent, 'SHOW STRONGEST 1% · ≥ 0.20');
  reveal.click();
  assert.equal(layer.getSnapshot().threshold, 0.2);
  assert.equal(byLabel('Change threshold').value, '20');
  assert.equal(reveal.hidden, true);
  assert.match(status.textContent, /annual embeddings/);
  assert.equal(source.requests.length, 1, 'revealing never re-requests');
});
