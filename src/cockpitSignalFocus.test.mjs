import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatAwarenessLabel } from './data/militaryAwarenessEngine.js';

const source = readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
const renderStart = source.indexOf('  renderCockpitSignals() {');
const renderEnd = source.indexOf('  setContextCollapsed(', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart);
const clickSource = source.match(/this\._listen\(this\.signalList, 'click', (\(event\) => \{[\s\S]*?\n    \})\);/)?.[1];
assert.ok(clickSource, 'the installed signal click route exists');

// Model native focus loss on removal AND on ordinary DOM moves. Keeping an
// object reference alone is insufficient if reconciliation disconnects it.
function fixture() {
  const document = { activeElement: null };
  let focusLosses = 0;
  let focusCalls = 0;
  class Node {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.dataset = {};
      this.attributes = new Map();
      this.className = '';
      this._text = '';
      this.classList = {
        add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      };
    }
    get isConnected() { return this === document.body || Boolean(this.parentNode?.isConnected); }
    get firstElementChild() { return this.children[0] || null; }
    get nextElementSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    get textContent() { return this._text + this.children.map((node) => node.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
    append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
    insertBefore(node, anchor) {
      assert.ok(anchor === null || anchor.parentNode === this, 'insert anchor belongs to its parent');
      if (node === anchor) return node;
      node.remove();
      const index = anchor === null ? this.children.length : this.children.indexOf(anchor);
      this.children.splice(index, 0, node);
      node.parentNode = this;
      return node;
    }
    remove() {
      if (!this.parentNode) return;
      if (this.contains(document.activeElement)) {
        document.activeElement = document.body;
        focusLosses += 1;
      }
      this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    }
    replaceChildren(...nodes) {
      for (const child of [...this.children]) child.remove();
      this._text = '';
      this.append(...nodes);
    }
    matches(selector) {
      if (selector === 'button[data-signal-layer][data-signal-id]') {
        return this.tagName === 'BUTTON' && this.dataset.signalLayer != null && this.dataset.signalId != null;
      }
      return selector.startsWith('.') ? this.className.split(/\s+/).includes(selector.slice(1))
        : this.tagName === selector.toUpperCase();
    }
    closest(selector) {
      for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node;
      return null;
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [ ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector) ]);
    }
    focus() {
      assert.ok(this.isConnected, 'a focus destination must still be connected');
      focusCalls += 1;
      document.activeElement = this;
    }
  }
  document.body = new Node('body');
  document.createElement = (tag) => new Node(tag);
  document.activeElement = document.body;
  const controller = new (new Function('document', 'formatAwarenessLabel',
    `return class { ${source.slice(renderStart, renderEnd)} };`)(document, formatAwarenessLabel))();
  controller.signalList = new Node('ol');
  controller.signalToggle = new Node('button');
  controller.briefTabs = [new Node('button'), new Node('button'), new Node('button')];
  controller.briefPageIndex = 0;
  controller.signalItems = [];
  controller.signalSignatures = new Map();
  controller.scheduleContextLayout = () => {};
  const display = new Node('button');
  const radio = new Node('button');
  const outside = new Node('button');
  document.body.append(controller.signalToggle, controller.signalList, ...controller.briefTabs, display, radio, outside);
  const selected = [];
  const click = new Function('militaryAwarenessLayer', `return ${clickSource};`)({
    focusTarget: (...args) => selected.push(args),
  });
  const buttons = () => controller.signalList.querySelectorAll('button');
  const tab = () => {
    const nodes = document.body.querySelectorAll('button');
    const index = nodes.indexOf(document.activeElement);
    nodes[(index + 1) % nodes.length].focus();
  };
  return { controller, document, buttons, display, radio, outside, selected, click, tab,
    losses: () => focusLosses, focusCalls: () => focusCalls };
}

const item = (id, overrides = {}) => ({
  key: `flight:flights:${id}`, tone: 'nearby', title: `Flight ${id}`, detail: 'COMMERCIAL FLIGHT · 2 KM',
  target: { layerId: 'flights', id }, timestamp: 1_700_000_000_000, ...overrides,
});
const render = (f, items) => { f.controller.signalItems = items; f.controller.renderCockpitSignals(); };
const snapshot = (distanceM = 2000) => ({
  evaluatedAt: 1_700_000_000_000,
  subject: { layerId: 'flights', id: 'current', label: 'CURRENT' },
  cohorts: [{ id: 'flights', count: 1, nearest: [{ id: 'nearby', label: 'NEARBY', distanceM }] }],
});

test('actual Context refresh retains the focused signal button across unchanged and changed details', () => {
  const f = fixture();
  f.controller.updateCockpitSignals(snapshot(), 0);
  const target = f.buttons()[1]; target.focus();
  const calls = f.focusCalls();
  for (let tick = 0; tick < 8; tick += 1) f.controller.updateCockpitSignals(snapshot(2500), 0);
  assert.equal(f.buttons()[1], target);
  assert.equal(f.document.activeElement, target);
  assert.equal(f.losses(), 0);
  assert.equal(f.focusCalls(), calls, 'refresh must preserve focus without repeatedly restoring it');
  assert.match(f.controller.signalList.textContent, /2\.5 KM/);
});

test('signal content and accessible name update without replacing the active target', () => {
  const f = fixture(); render(f, [item('a')]);
  const target = f.buttons()[0]; target.focus();
  render(f, [item('a', { title: 'RENAMED', tone: 'track', detail: 'CURRENT', timestamp: 1_700_000_001_000 })]);
  assert.equal(f.buttons()[0], target);
  assert.equal(target.getAttribute('aria-label'), 'Select flight RENAMED');
  assert.match(target.textContent, /RENAMED/);
  assert.match(f.controller.signalList.textContent, /CURRENT/);
  assert.equal(f.controller.signalList.children[0].className, 'track actionable');
  assert.equal(f.document.activeElement, target);
  assert.equal(f.losses(), 0);
});

test('signal ranking changes move surrounding rows without disconnecting the focused row', () => {
  const f = fixture(); render(f, ['a', 'b', 'c', 'd'].map((id) => item(id)));
  const target = f.buttons()[1]; target.focus();
  const calls = f.focusCalls();
  for (const order of [['d', 'c', 'b', 'a'], ['b', 'c', 'd', 'a'], ['a', 'd', 'c', 'b']]) {
    render(f, order.map((id) => item(id)));
    assert.deepEqual(f.buttons().map((button) => button.dataset.signalId), order);
    assert.equal(f.document.activeElement, target);
    assert.equal(f.losses(), 0);
  }
  assert.equal(f.focusCalls(), calls);
});

test('a new pushed signal preserves existing focus and delegated selection reads the current target', () => {
  const f = fixture(); render(f, [item('a'), item('b')]);
  const target = f.buttons()[1]; target.focus();
  f.controller.pushCockpitSignal('status', 'warning', 'INPUT UNKNOWN', 'SOURCE UNAVAILABLE');
  assert.equal(f.document.activeElement, target);
  assert.equal(f.losses(), 0);
  const event = { target: target.children[0], prevented: false, preventDefault() { this.prevented = true; } };
  f.click(event);
  assert.equal(event.prevented, true);
  assert.deepEqual(f.selected, [['flights', 'b', { origin: 'user' }]]);
});

test('removing the focused identity uses the existing briefing tab once and permits forward traversal', () => {
  const f = fixture(); render(f, [item('a'), item('b')]);
  const removed = f.buttons()[1]; removed.focus();
  const calls = f.focusCalls();
  render(f, [item('a')]);
  assert.equal(removed.isConnected, false);
  assert.equal(f.document.activeElement, f.controller.briefTabs[0]);
  assert.equal(f.focusCalls(), calls + 1);
  f.tab(); f.tab(); f.tab();
  assert.equal(f.document.activeElement, f.display);
  render(f, [item('a', { detail: 'UPDATED' })]);
  assert.equal(f.document.activeElement, f.display, 'later refresh must not pull focus back');
  f.tab();
  assert.equal(f.document.activeElement, f.radio);
});

test('a changed target cannot reuse a focused action for another flight', () => {
  const f = fixture(); render(f, [item('a', { key: 'shared-status-key' })]);
  const removed = f.buttons()[0]; removed.focus();
  render(f, [item('b', { key: 'shared-status-key', target: { layerId: 'military', id: 'b' } })]);
  const target = f.buttons()[0];
  assert.notEqual(target, removed);
  assert.equal(removed.isConnected, false);
  assert.equal(f.document.activeElement, f.controller.briefTabs[0]);
  f.click({ target, preventDefault() {} });
  assert.deepEqual(f.selected, [['military', 'b', { origin: 'user' }]]);
});

test('empty, informational and duplicate-key rows have no stale or aliased actions', () => {
  const f = fixture();
  render(f, [item('a'), item('a')]);
  const [first, second] = f.buttons();
  assert.notEqual(first, second);
  second.focus();
  render(f, [item('a'), item('a')]);
  assert.deepEqual(f.buttons(), [first, second]);
  assert.equal(f.document.activeElement, second);
  render(f, [item('status', { target: null, title: 'UNKNOWN' })]);
  assert.equal(f.buttons().length, 0);
  assert.match(f.controller.signalList.textContent, /UNKNOWN/);
  assert.equal(f.document.activeElement, f.controller.briefTabs[0]);
  f.outside.focus();
  render(f, []);
  assert.equal(f.controller.signalList.children.length, 0);
  render(f, [item('a')]);
  assert.notEqual(f.buttons()[0], first);
  assert.equal(f.document.activeElement, f.outside);
});
