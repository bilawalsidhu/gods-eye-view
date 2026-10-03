import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  EXPECTED_PROVIDERS,
  isCollapsed,
  RAIL_ORDER,
  VIEWPORTS,
} from '../../scripts/qa-street-level.mjs';

test('the QA harness exercises both review viewports', () => {
  assert.deepEqual(
    VIEWPORTS.map((v) => `${v.width}x${v.height}`),
    ['1440x900', '1280x800'],
  );
});

test('the harness expects exactly the registered providers', () => {
  assert.deepEqual(EXPECTED_PROVIDERS, ['mapillary']);
});

test('rail order puts Street Level between CCTV and Context', () => {
  assert.deepEqual(RAIL_ORDER, [
    'pp-toggles',
    'cctv-panel',
    'weather-panel',
    'recent-imagery-panel',
    'street-level-panel',
    'global-context-panel',
  ]);
  assert.equal(isCollapsed(['panel-collapsible', 'collapsed']), true);
  assert.equal(isCollapsed(['panel-collapsible']), false);
});

test('the harness only runs its browser flow when executed directly', () => {
  const source = fs.readFileSync(
    new URL('../../scripts/qa-street-level.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href/,
  );
  assert.match(source, /PUPPETEER_EXECUTABLE_PATH/);
  assert.match(source, /--url/);
});
