import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

// Every document that tells a reader to delete a panel position key, and the
// shape each one writes the key in.
const DOCUMENTED_KEYS = [
  ['docs/KNOWN-ISSUES.md', 'godsEyeView.{v}.panelPos.cctv-panel'],
  ['scripts/dev-fresh.sh', 'godsEyeView.{v}.panelPos.cctv-panel'],
  ['docs/KNOWN-ISSUES.md', 'godsEyeView.{v}.panelPos.<panel-id>'],
  ['docs/CURRENT-STATE.md', 'godsEyeView.{v}.panelPos.<panel-id>'],
  ['docs/CURRENT-STATE.md', 'godsEyeView.{v}.panelPos.<id>'],
];

test('panel recovery instructions use the current position storage key', async () => {
  const source = await readFile(
    path.join(root, 'src/ui/panelPositionControls.js'),
    'utf8',
  );
  const [, version] =
    source.match(/const PANEL_POSITION_STORAGE_VERSION = '([^']+)';/) || [];
  assert.ok(
    version,
    'panelPositionControls.js must declare the panel position storage version',
  );

  const seen = new Map();
  for (const [file, shape] of DOCUMENTED_KEYS) {
    if (!seen.has(file))
      seen.set(file, await readFile(path.join(root, file), 'utf8'));
    const expected = shape.replace('{v}', version);
    assert.ok(
      seen.get(file).includes(expected),
      `${file} must use ${expected}`,
    );
  }

  // A document that still names a superseded version sends the reader to a key
  // nothing writes.
  for (const [file, content] of seen) {
    const stale = [...content.matchAll(/godsEyeView\.(v\d+)\.panelPos/g)]
      .map(([, found]) => found)
      .filter((found) => found !== version);
    assert.deepEqual(stale, [], `${file} names superseded position keys`);
  }
});
