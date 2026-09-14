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
  ['docs/KNOWN-ISSUES.md', 'godsEyeView.{position}.panelPos.pp-toggles'],
  ['docs/KNOWN-ISSUES.md', 'godsEyeView.{position}.panelPos.<panel-id>'],
  ['docs/KNOWN-ISSUES.md', 'godsEyeView.{layout}.panelCollapsed.cctv-panel'],
  ['docs/KNOWN-ISSUES.md', 'godsEyeView.{layout}.panelCollapsed.<panel-id>'],
  ['scripts/dev-fresh.sh', 'godsEyeView.{position}.panelPos.pp-toggles'],
  ['scripts/dev-fresh.sh', 'godsEyeView.{layout}.panelCollapsed.cctv-panel'],
  ['docs/CURRENT-STATE.md', 'godsEyeView.{position}.panelPos.<panel-id>'],
  ['docs/CURRENT-STATE.md', 'godsEyeView.{position}.panelPos.<id>'],
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

test('the position key is written for the one panel the documents name', async () => {
  const source = await readFile(
    path.join(root, 'src/ui/panelPositionControls.js'),
    'utf8',
  );
  // The documents tell a reader that a stored position exists only for the
  // draggable DISPLAY rail. That is true only while this is the one panel given
  // a drag spec.
  const specs = source.slice(
    source.indexOf('const dragSpecs = ['),
    source.indexOf('].filter(Boolean)'),
  );
  const ids = [...specs.matchAll(/id: '([^']+)'/g)].map(([, id]) => id);
  assert.deepEqual(ids, ['pp-toggles']);
});
