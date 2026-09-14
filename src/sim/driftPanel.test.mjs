import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDriftPanel, POSITION_CHOICES } from './driftPanel.js';

/**
 * A DOM stub just deep enough for the panel's construction path.
 *
 * The panel builds its whole UI imperatively and returns a no-op object when
 * `document` is undefined, so under plain node NOTHING in it executes — the
 * parameter row, the selects and their labels were entirely uncovered. This is
 * the same gap that let the field legend ship every colour swatch as
 * `background:undefined`.
 */
function installDom() {
  const make = (tag) => {
    const node = {
      tagName: tag.toUpperCase(),
      children: [],
      attributes: {},
      style: { cssText: '' },
      dataset: {},
      textContent: '',
      hidden: false,
      value: '',
      options: [],
      appendChild(child) { this.children.push(child); return child; },
      append(...parts) {
        for (const part of parts) this.children.push(typeof part === 'string' ? { text: part } : part);
      },
      remove() {},
      setAttribute(k, v) { this.attributes[k] = String(v); },
      getAttribute(k) { return this.attributes[k] ?? null; },
      addEventListener() {},
      querySelectorAll() { return []; },
    };
    if (tag === 'select') {
      const realAppend = node.appendChild.bind(node);
      node.appendChild = (child) => {
        if (child.tagName === 'OPTION') {
          node.options.push(child);
          // Mirror the browser: the select's value is its selected option.
          if (child.selected || node.options.length === 1) node.value = child.value;
        }
        return realAppend(child);
      };
    }
    return node;
  };
  globalThis.document = {
    createElement: make,
    body: make('body'),
    addEventListener() {},
    removeEventListener() {},
  };
  return () => { delete globalThis.document; };
}

/** Depth-first walk of the constructed tree. */
function walk(node, out = []) {
  out.push(node);
  for (const child of node.children ?? []) if (child.tagName) walk(child, out);
  return out;
}

function buildPanel(params) {
  const restore = installDom();
  let root = null;
  const originalAppend = globalThis.document.body.appendChild;
  globalThis.document.body.appendChild = (child) => { root = child; return originalAppend.call(globalThis.document.body, child); };
  const panel = createDriftPanel({
    particleCount: 10000,
    classLabel: 'PIW — person in water',
    frameCount: 145,
    horizonH: 24,
    params,
    onRerun() {},
    onScrub() {},
    onPlayPause() {},
    onClose() {},
  });
  return { panel, root, restore };
}

test('the panel builds a real DOM tree under a stub document', () => {
  const { panel, root, restore } = buildPanel({ horizonH: 24, n: 10000, sigmaTurbMs: 0.05, posSigmaM: 1000, backward: false });
  try {
    assert.ok(root, 'the panel must attach a root element');
    assert.equal(root.id, 'gev-drift-panel');
    assert.equal(typeof panel.setFrame, 'function');
    assert.ok(walk(root).length > 5, 'the tree must actually be built, not stubbed away');
  } finally { restore(); }
});

test('the position-uncertainty select offers every band, labelled by meaning', () => {
  const { root, restore } = buildPanel({ horizonH: 24, n: 10000, sigmaTurbMs: 0.05, posSigmaM: 1000, backward: false });
  try {
    const selects = walk(root).filter((n) => n.tagName === 'SELECT');
    const position = selects.find((s) => s.attributes['aria-label'] === 'Last known position uncertainty');
    assert.ok(position, 'the control must exist and be labelled for a screen reader');

    assert.deepEqual(
      position.options.map((o) => Number(o.value)),
      POSITION_CHOICES.map((b) => b.posSigmaM),
    );
    // Every option must name the DISTANCE, so it cannot read as a display knob.
    for (const option of position.options) {
      assert.match(option.textContent, /\d+\s*(m|km)/, option.textContent);
    }
    assert.match(position.options.map((o) => o.textContent).join(' '), /witnessed.*estimated.*uncertain/);
  } finally { restore(); }
});

test('the select preselects the run’s actual posSigmaM, not the first option', () => {
  for (const band of POSITION_CHOICES) {
    const { root, restore } = buildPanel({ horizonH: 24, n: 10000, sigmaTurbMs: 0.05, posSigmaM: band.posSigmaM, backward: false });
    try {
      const position = walk(root).filter((n) => n.tagName === 'SELECT')
        .find((s) => s.attributes['aria-label'] === 'Last known position uncertainty');
      const selected = position.options.find((o) => o.selected);
      assert.ok(selected, `no option selected for ${band.id}`);
      assert.equal(Number(selected.value), band.posSigmaM,
        `a rerun at ${band.label} must reopen showing ${band.label}`);
    } finally { restore(); }
  }
});
