import test from 'node:test';
import assert from 'node:assert/strict';
import { syncRadioPanelPlacement } from './radioPanelPlacement.js';

function node() {
  return {
    children: [],
    selectors: {},
    parentElement: null,
    moves: 0,
    querySelector(selector) {
      return this.selectors[selector] || null;
    },
    append(child) {
      this.insertBefore(child, null);
    },
    insertBefore(child, before) {
      if (child.parentElement) {
        const siblings = child.parentElement.children;
        siblings.splice(siblings.indexOf(child), 1);
      }
      const index = before
        ? this.children.indexOf(before)
        : this.children.length;
      this.children.splice(index, 0, child);
      child.parentElement = this;
      child.moves++;
    },
  };
}

test('all themes keep the same Radio controls nested in Context', () => {
  const panel = node(),
    context = node(),
    rail = node(),
    inner = node(),
    body = node();
  context.selectors['.global-context-panel-inner'] = inner;
  context.selectors['.cyber-panel-body'] = body;
  inner.append(panel);
  const nodes = {
    'radio-panel': panel,
    'global-context-panel': context,
    'right-context-rail': rail,
  };
  const doc = {
    documentElement: { dataset: {} },
    getElementById: (id) => nodes[id],
  };
  for (let cycle = 0; cycle < 3; cycle++) {
    doc.documentElement.dataset.uiTheme = 'cyber';
    syncRadioPanelPlacement(doc);
    assert.equal(panel.parentElement, body);
    const moves = panel.moves;
    syncRadioPanelPlacement(doc);
    assert.equal(panel.moves, moves, 'no mutation feedback loop');
    delete doc.documentElement.dataset.uiTheme;
    syncRadioPanelPlacement(doc);
    assert.equal(panel.parentElement, body);
  }
  // Recover a hierarchy left by the previous Cyber implementation without
  // recreating the player, changing playback, or mutating collapse state.
  rail.append(panel);
  doc.documentElement.dataset.uiTheme = 'cyber';
  syncRadioPanelPlacement(doc);
  assert.equal(panel.parentElement, body);
});

test('placement is inert before the complete shell exists', () => {
  assert.doesNotThrow(() => syncRadioPanelPlacement(null));
  assert.doesNotThrow(() =>
    syncRadioPanelPlacement({
      documentElement: { dataset: { uiTheme: 'cyber' } },
      getElementById: () => null,
    }),
  );
});
