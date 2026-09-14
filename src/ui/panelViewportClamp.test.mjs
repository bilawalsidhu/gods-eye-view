// panelViewportClamp.test.mjs — pins the pure clamp math (PR #215) that BOTH
// the drag handler and the localStorage position restore run through, so a
// position saved at one window size can never restore off-screen at another
// (audit U2). A source anchor pins the ui.js call sites so the delegation
// cannot silently detach.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PANEL_VIEWPORT_INSET_PX, clampPanelToViewport } from './panelViewportClamp.js';
import { readSource } from '../testSupport/readSource.js';

const VIEW = { width: 1440, height: 900 };

test('in-range positions pass through unchanged', () => {
  assert.deepEqual(
    clampPanelToViewport({ left: 320, top: 200, width: 400, height: 300 }, VIEW),
    { left: 320, top: 200 },
  );
});

test('positions past any edge are pulled back to the inset', () => {
  assert.deepEqual(
    clampPanelToViewport({ left: -192, top: -50, width: 400, height: 300 }, VIEW),
    { left: PANEL_VIEWPORT_INSET_PX, top: PANEL_VIEWPORT_INSET_PX },
    'audit U2: the restored x:-192 panel',
  );
  assert.deepEqual(
    clampPanelToViewport({ left: 5000, top: 5000, width: 400, height: 300 }, VIEW),
    { left: VIEW.width - 400 - PANEL_VIEWPORT_INSET_PX, top: VIEW.height - 300 - PANEL_VIEWPORT_INSET_PX },
    'past right/bottom edges',
  );
});

test('a panel larger than the viewport keeps its top-left at the inset', () => {
  assert.deepEqual(
    clampPanelToViewport({ left: 100, top: 100, width: 2000, height: 1200 }, VIEW),
    { left: PANEL_VIEWPORT_INSET_PX, top: PANEL_VIEWPORT_INSET_PX },
  );
});

test('a tiny viewport still yields inset coordinates (no negatives, no NaN)', () => {
  assert.deepEqual(
    clampPanelToViewport({ left: 10, top: 10, width: 50, height: 50 }, { width: 0, height: 0 }),
    { left: PANEL_VIEWPORT_INSET_PX, top: PANEL_VIEWPORT_INSET_PX },
  );
});

test('both ui.js clamp paths delegate to the shared helper', () => {
  const ui = readSource('../ui.js', import.meta.url);
  const clampCalls = ui.match(/clampPanelToViewport\(/g) || [];
  assert.ok(clampCalls.length >= 2, 'the drag handler AND the restore path must clamp');
  assert.doesNotMatch(ui, /window\.innerWidth - rect\.width - 6/, 'no inline duplicate of the clamp math');
});
