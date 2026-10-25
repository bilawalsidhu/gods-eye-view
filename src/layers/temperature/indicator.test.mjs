import assert from 'node:assert/strict';
import test from 'node:test';
import { createMonthIndicator } from './indicator.js';

/** Just enough DOM for the panel; insertBefore refuses a stranger, as browsers do. */
function fakeDocument() {
  const document = {
    createElement(tag) {
      const node = new EventTarget();
      const classes = new Set();
      Object.assign(node, {
        tagName: tag.toUpperCase(),
        ownerDocument: document,
        children: [],
        parentNode: null,
        dataset: {},
        hidden: false,
        disabled: false,
        title: '',
        textContent: '',
        offsetWidth: 0,
        style: { setProperty() {} },
        classList: {
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name),
          toggle: (name, on) =>
            (on ?? !classes.has(name))
              ? classes.add(name)
              : classes.delete(name),
          contains: (name) => classes.has(name),
        },
        attributes: new Map(),
        setAttribute(key, value) {
          this.attributes.set(key, String(value));
        },
        getAttribute(key) {
          return this.attributes.get(key) ?? null;
        },
        appendChild(child) {
          return this.insertBefore(child, null);
        },
        insertBefore(child, reference) {
          if (reference && !this.children.includes(reference))
            throw new Error('NotFoundError');
          child.remove();
          const at = reference
            ? this.children.indexOf(reference)
            : this.children.length;
          this.children.splice(at, 0, child);
          child.parentNode = this;
          return child;
        },
        append(...nodes) {
          for (const child of nodes) this.appendChild(child);
        },
        remove() {
          if (!this.parentNode) return;
          const siblings = this.parentNode.children;
          siblings.splice(siblings.indexOf(this), 1);
          this.parentNode = null;
        },
        closest(selector) {
          return classes.has(selector.slice(1))
            ? this
            : (this.parentNode?.closest?.(selector) ?? null);
        },
      });
      // A real accessor: Object.assign would copy a getter's value instead.
      Object.defineProperty(node, 'className', {
        get: () => [...classes].join(' '),
        set(value) {
          classes.clear();
          for (const name of String(value).split(/\s+/).filter(Boolean))
            classes.add(name);
        },
      });
      return node;
    },
  };
  return document;
}

const find = (node, className) => {
  if (node.classList?.contains(className)) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, className);
    if (hit) return hit;
  }
  return null;
};

test('the panel minimizes to a pill and back without touching playback', () => {
  const container = fakeDocument().createElement('div');
  const calls = [];
  const panel = createMonthIndicator({
    container,
    onYear: (year) => calls.push(['year', year]),
    onMonth: (month) => calls.push(['month', month]),
    onToggle: () => calls.push(['toggle']),
  });
  const view = {
    years: [2024, 2025, 2026],
    year: 2026,
    loadingYear: null,
    error: null,
    dates: ['2026-01-01', '2026-02-01'],
    position: 0.5,
    dominant: 0,
    playing: true,
    reading: null,
  };
  panel.render(view);
  const root = container.children[0];
  const minimize = find(root, 'temperature-timeline-collapse');
  assert.equal(minimize.title, 'Minimize timeline');
  assert.equal(minimize.getAttribute('aria-expanded'), 'true');
  minimize.dispatchEvent(new Event('click'));
  assert.equal(root.classList.contains('is-collapsed'), true);
  assert.equal(minimize.title, 'Expand timeline');
  assert.equal(minimize.getAttribute('aria-expanded'), 'false');
  panel.render({ ...view, dominant: 1 });
  assert.equal(panel.isCollapsed(), true, 'a redraw keeps it minimized');
  assert.deepEqual(calls, [], 'minimizing neither pauses nor seeks');
  panel.setCollapsed(false);
  assert.equal(root.classList.contains('is-collapsed'), false);
  panel.destroy();
  assert.equal(container.children.length, 0);
});
