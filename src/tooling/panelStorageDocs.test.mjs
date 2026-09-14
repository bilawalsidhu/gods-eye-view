import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

// Documentation consistency only: that every storage key a document spells out
// is the key the code writes. Whether deleting one has the effect the document
// claims is not checked here.
const DOCUMENTED_KEYS = [
  ['docs/KNOWN-ISSUES.md', 'godsEyeView.{layout}.panelCollapsed.cctv-panel'],
  ['docs/KNOWN-ISSUES.md', 'godsEyeView.{layout}.panelCollapsed.<panel-id>'],
  ['docs/KNOWN-ISSUES.md', 'godsEyeView.{position}.panelPos.<panel-id>'],
  ['scripts/dev-fresh.sh', 'godsEyeView.{layout}.panelCollapsed.cctv-panel'],
  ['docs/CURRENT-STATE.md', 'godsEyeView.{position}.panelPos.<panel-id>'],
  ['docs/CURRENT-STATE.md', 'godsEyeView.{position}.panelPos.<id>'],
  ['docs/CURRENT-STATE.md', 'godsEyeView.{layout}.panelCollapsed.<panel-id>'],
];

test('documented panel storage keys are the keys the code writes', async () => {
  const source = await readFile(
    path.join(root, 'src/ui/panelPositionControls.js'),
    'utf8',
  );
  const version = (name) => {
    const [, found] =
      source.match(new RegExp(`const ${name} = '([^']+)';`)) || [];
    assert.ok(found, `panelPositionControls.js must declare ${name}`);
    return found;
  };
  const position = version('PANEL_POSITION_STORAGE_VERSION');
  const layout = version('PANEL_LAYOUT_STORAGE_VERSION');

  const seen = new Map();
  for (const [file, shape] of DOCUMENTED_KEYS) {
    if (!seen.has(file))
      seen.set(file, await readFile(path.join(root, file), 'utf8'));
    const expected = shape
      .replace('{position}', position)
      .replace('{layout}', layout);
    assert.ok(
      seen.get(file).includes(expected),
      `${file} must use ${expected}`,
    );
  }

  // A document that still names a superseded version sends the reader to a key
  // nothing writes.
  for (const [file, content] of seen) {
    const stalePositions = [
      ...content.matchAll(/godsEyeView\.(v\d+)\.panelPos/g),
    ]
      .map(([, found]) => found)
      .filter((found) => found !== position);
    assert.deepEqual(
      stalePositions,
      [],
      `${file} names superseded position keys`,
    );
    const staleCollapsed = [
      ...content.matchAll(/godsEyeView\.(v\d+)\.panelCollapsed/g),
    ]
      .map(([, found]) => found)
      .filter((found) => found !== layout);
    assert.deepEqual(
      staleCollapsed,
      [],
      `${file} names superseded collapsed-state keys`,
    );
  }
});

test('the documented reset restores the panel default, and the documented value opens it', async () => {
  // The instructions promise two different outcomes; both are exercised here
  // against the code that decides them.
  const { PanelPositionControls } =
    await import('../ui/panelPositionControls.js');
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  assert.match(
    html,
    /<div id="cctv-panel" class="panel-collapsible collapsed"/,
    'the CCTV panel starts collapsed in the markup',
  );

  const saved = {
    document: globalThis.document,
    localStorage: globalThis.localStorage,
  };
  const classes = new Set(['panel-collapsible', 'collapsed']);
  const panel = {
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, active) =>
        active ? classes.add(name) : classes.delete(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
  };
  const store = new Map();
  globalThis.document = { getElementById: () => panel };
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    const controls = new PanelPositionControls({
      syncPanelCollapseButton: () => {},
      layoutRightPanels: () => {},
      syncCctvPanelViewport: () => {},
      showToast: () => {},
    });

    // Nothing stored: the markup default wins, and the panel is collapsed. So
    // deleting the key is a reset, not a way to open the panel.
    controls._restorePanelCollapsedState('cctv-panel');
    assert.equal(classes.has('collapsed'), true);

    // The value the documents tell a reader to set.
    store.set('godsEyeView.v6.panelCollapsed.cctv-panel', '0');
    controls._restorePanelCollapsedState('cctv-panel');
    assert.equal(classes.has('collapsed'), false);

    // ...and the opposite value keeps it shut, so '0' is doing the work.
    store.set('godsEyeView.v6.panelCollapsed.cctv-panel', '1');
    controls._restorePanelCollapsedState('cctv-panel');
    assert.equal(classes.has('collapsed'), true);
  } finally {
    globalThis.document = saved.document;
    globalThis.localStorage = saved.localStorage;
  }
});
