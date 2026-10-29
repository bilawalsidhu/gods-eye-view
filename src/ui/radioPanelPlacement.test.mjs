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
    dock = node(),
    mini = node();
  const inner = node(),
    contextHeader = node(),
    radioHeader = node();
  const contextCollapse = node(),
    radioCollapse = node();
  context.selectors['.global-context-panel-inner'] = inner;
  const body = node();
  context.selectors['.cyber-panel-body'] = body;
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
    assert.equal(panel.parentElement, body);
    assert.deepEqual(contextHeader.children, [dock, contextCollapse]);
    assert.equal(mini.parentElement, dock);
    const moves = [panel.moves, dock.moves, mini.moves];
    syncRadioPanelPlacement(doc);
    assert.deepEqual(
      [panel.moves, dock.moves, mini.moves],
      moves,
      'no mutation feedback loop',
    );
    delete doc.documentElement.dataset.uiTheme;
    syncRadioPanelPlacement(doc);
    assert.equal(panel.parentElement, body);
    assert.deepEqual(contextHeader.children, [dock, contextCollapse]);
    assert.equal(mini.parentElement, dock);
  }
  // Recover a hierarchy left by the previous Cyber implementation without
  // recreating the player, changing playback, or mutating collapse state.
  rail.append(panel);
  radioHeader.insertBefore(dock, radioCollapse);
  panel.append(mini);
  doc.documentElement.dataset.uiTheme = 'cyber';
  syncRadioPanelPlacement(doc);
  assert.equal(panel.parentElement, body);
  assert.deepEqual(contextHeader.children, [dock, contextCollapse]);
  assert.equal(mini.parentElement, dock);
});

test('the compact launcher sits in the rail tool slot on desktop and in Context header on phones', () => {
  const panel = node(),
    context = node(),
    dock = node(),
    mini = node(),
    slot = node();
  const inner = node(),
    header = node(),
    collapse = node();
  context.selectors['.global-context-panel-inner'] = inner;
  context.selectors['.panel-header'] = header;
  header.selectors['.panel-collapse-btn'] = collapse;
  inner.append(panel);
  header.append(dock);
  header.append(collapse);
  dock.append(mini);
  const nodes = {
    'radio-panel': panel,
    'global-context-panel': context,
    'context-radio-dock': dock,
    'context-radio-mini': mini,
    'right-rail-tools': slot,
  };
  let phone = false;
  const doc = {
    documentElement: { dataset: {} },
    body: { classList: { contains: (name) => phone && name === 'mobile-shell' } },
    getElementById: (id) => nodes[id],
  };
  syncRadioPanelPlacement(doc);
  assert.deepEqual(slot.children, [dock], 'desktop: the launcher is in the slot');
  assert.deepEqual(header.children, [collapse]);
  assert.equal(mini.parentElement, dock);
  const moves = [dock.moves, mini.moves];
  syncRadioPanelPlacement(doc);
  assert.deepEqual([dock.moves, mini.moves], moves, 'no mutation feedback loop');
  phone = true;
  syncRadioPanelPlacement(doc);
  assert.deepEqual(slot.children, []);
  assert.deepEqual(
    header.children,
    [dock, collapse],
    'phone: back in the header, before the collapse button',
  );
  assert.equal(mini.parentElement, dock);
  phone = false;
  syncRadioPanelPlacement(doc);
  assert.deepEqual(slot.children, [dock], 'desktop again: back in the slot');
  delete nodes['right-rail-tools'];
  syncRadioPanelPlacement(doc);
  assert.deepEqual(header.children, [dock, collapse], 'no slot: the header');
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
