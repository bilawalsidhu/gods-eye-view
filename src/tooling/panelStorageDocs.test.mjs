import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('CCTV panel recovery instructions use the current position storage key', async () => {
  const uiSource = await readFile(path.join(root, 'src/ui.js'), 'utf8');
  const [, version] = uiSource.match(
    /const PANEL_POSITION_STORAGE_VERSION = '([^']+)';/,
  ) || [];
  assert.ok(version, 'ui.js must declare the panel position storage version');

  const expectedKey = `godsEyeView.${version}.panelPos.cctv-panel`;
  const instructionFiles = [
    'docs/KNOWN-ISSUES.md',
    'scripts/dev-fresh.sh',
  ];

  for (const file of instructionFiles) {
    const content = await readFile(path.join(root, file), 'utf8');
    assert.ok(content.includes(expectedKey), `${file} must use ${expectedKey}`);
  }

  const currentState = await readFile(path.join(root, 'docs/CURRENT-STATE.md'), 'utf8');
  assert.ok(
    currentState.includes(`godsEyeView.${version}.panelPos.<id>`),
    'docs/CURRENT-STATE.md must use the current panel position storage version',
  );
});
