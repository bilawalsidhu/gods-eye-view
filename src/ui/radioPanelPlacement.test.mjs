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

test('Cyber reuses Radio controls and restores the original non-Cyber hierarchy', () => {
  const panel = node(),
    context = node(),
    rail = node(),
    dock = node(),
    mini = node();
  const inner = node(),
    contextHeader = node(),
    radioHeader = node();
  const contextCollapse = node(),
    radioCollapse = node();
  context.selectors['.global-context-panel-inner'] = inner;
  context.selectors['.panel-header'] = contextHeader;
  panel.selectors['.panel-header'] = radioHeader;
  contextHeader.selectors['.panel-collapse-btn'] = contextCollapse;
  radioHeader.selectors['.panel-collapse-btn'] = radioCollapse;
  inner.append(panel);
  contextHeader.append(dock);
  contextHeader.append(contextCollapse);
  radioHeader.append(radioCollapse);
  dock.append(mini);
  const nodes = {
    'radio-panel': panel,
    'global-context-panel': context,
    'right-context-rail': rail,
    'context-radio-dock': dock,
    'context-radio-mini': mini,
  };
  const doc = {
    documentElement: { dataset: {} },
    getElementById: (id) => nodes[id],
  };
  for (let cycle = 0; cycle < 3; cycle++) {
    doc.documentElement.dataset.uiTheme = 'cyber';
    syncRadioPanelPlacement(doc);
    assert.equal(panel.parentElement, rail);
    assert.deepEqual(radioHeader.children, [dock, radioCollapse]);
    assert.equal(mini.parentElement, panel);
    const moves = [panel.moves, dock.moves, mini.moves];
    syncRadioPanelPlacement(doc);
    assert.deepEqual(
      [panel.moves, dock.moves, mini.moves],
      moves,
      'no mutation feedback loop',
    );
    delete doc.documentElement.dataset.uiTheme;
    syncRadioPanelPlacement(doc);
    assert.equal(panel.parentElement, inner);
    assert.deepEqual(contextHeader.children, [dock, contextCollapse]);
    assert.equal(mini.parentElement, dock);
  }
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
