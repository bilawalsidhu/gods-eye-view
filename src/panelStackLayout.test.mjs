import { readSource } from './testSupport/readSource.js';
import assert from 'node:assert/strict';

import test from 'node:test';
import {
  allocatePanelStackHeights,
  panelStackAutoCollapseIndices,
  resolveLeftStackBottomBoundary,
  resolvePanelStackCorridor,
} from './panelStackLayout.js';

// Measured in Cockpit at 1512x790: CONTACT card at y541, HUD corner at y659,
// Cesium credits at y758, viewport inset boundary at y758.4. Every surface is
// a hard boundary even when a standard map panel is reopened in Cockpit.
const cockpitLane = {
  baseBottom: 758.4,
  safeGap: 9.5,
  obstacles: [
    { top: 541.2, cockpitOverlay: true },
    { top: 659, cockpitOverlay: true },
    { top: 758, cockpitOverlay: false },
  ],
};

test('every left-lane obstacle shortens the corridor', () => {
  assert.equal(
    resolveLeftStackBottomBoundary(cockpitLane),
    531.7,
  );
});

test('an expanded Cockpit panel remains above the Contact and HUD surfaces', () => {
  assert.equal(
    resolveLeftStackBottomBoundary(cockpitLane),
    531.7,
  );
});

test('the Cesium credit line limits the corridor even in Cockpit', () => {
  const boundary = resolveLeftStackBottomBoundary({
    baseBottom: 900,
    safeGap: 9.5,
    obstacles: [{ top: 758 }],
  });
  assert.equal(boundary, 748.5);
});

test('an empty or malformed obstacle set leaves the viewport inset intact', () => {
  assert.equal(resolveLeftStackBottomBoundary({ baseBottom: 700 }), 700);
  assert.equal(
    resolveLeftStackBottomBoundary({
      baseBottom: 700,
      obstacles: [{ top: Number.NaN }, {}, null],
      safeGap: 8,
    }),
    700,
  );
});

test('multiple expanded panels retain natural heights when the corridor fits', () => {
  assert.deepEqual(allocatePanelStackHeights({
    naturalHeights: [280, 160],
    availableHeight: 500,
  }), [280, 160]);
});

test('multiple expanded panels share a constrained corridor without overflow', () => {
  const allocated = allocatePanelStackHeights({
    naturalHeights: [520, 300],
    availableHeight: 600,
  });
  assert.equal(Math.round(allocated.reduce((sum, height) => sum + height, 0)), 600);
  assert.ok(allocated.every((height) => height >= 96));
  assert.ok(allocated[0] > allocated[1]);
});

test('very short corridors remain bounded with every panel represented', () => {
  const allocated = allocatePanelStackHeights({
    naturalHeights: [420, 260, 180],
    availableHeight: 150,
  });
  assert.equal(Math.round(allocated.reduce((sum, height) => sum + height, 0)), 150);
  assert.ok(allocated.every((height) => height > 0));
});

test('later panels below half their natural height auto-collapse while the first is preserved', () => {
  assert.deepEqual(panelStackAutoCollapseIndices({
    naturalHeights: [520, 300, 180],
    allocatedHeights: [180, 149, 120],
  }), [1]);
});

test('the half-height boundary remains expanded', () => {
  assert.deepEqual(panelStackAutoCollapseIndices({
    naturalHeights: [520, 300],
    allocatedHeights: [100, 150],
  }), []);
});

test('Tactical focus preserves the primary panel and collapses later competitors', () => {
  assert.deepEqual(panelStackAutoCollapseIndices({
    naturalHeights: [320, 240, 180],
    allocatedHeights: [220, 180, 140],
    collapseLaterPanels: true,
  }), [1, 2]);
});

test('viewport growth retains the aligned corridor when midpoint centering would cross Cockpit panels', () => {
  assert.deepEqual(resolvePanelStackCorridor({
    viewportHeight: 1026,
    safeTop: 266.76,
    safeBottom: 515.24,
    obstacleSafeTop: 41.04,
    obstacleSafeBottom: 515.24,
    minimumHeight: 164.16,
  }), {
    safeTop: 266.76,
    safeBottom: 515.24,
  });
});

// --- Branch floor (cycle 4): the allocation/clamp exits are contracts -------

test('allocation degenerate inputs: empty set, zero corridor, malformed heights', () => {
  assert.deepEqual(allocatePanelStackHeights({ naturalHeights: [], availableHeight: 500 }), [],
    'no expanded panels → no allocations');
  assert.deepEqual(allocatePanelStackHeights({ naturalHeights: [300, 200], availableHeight: 0 }), [0, 0],
    'a zero corridor starves every panel equally');
  assert.deepEqual(allocatePanelStackHeights({ naturalHeights: [Number.NaN, -80], availableHeight: 500 }), [0, 0],
    'malformed naturals coerce to 0 and are still allocated');
  assert.deepEqual(allocatePanelStackHeights({ naturalHeights: [300], availableHeight: Number.NaN }), [0],
    'a malformed corridor is not a fit corridor');
});

test('allocation: panels already at the floor scale down proportionally when floors saturate', () => {
  // Two panels with a 96 floor and a 150 corridor: floors sum 192 > 150, so the
  // floors themselves are what shrinks — 96 × 150/192 = 75 exactly.
  const allocated = allocatePanelStackHeights({
    naturalHeights: [300, 200],
    availableHeight: 150,
  });
  assert.deepEqual(allocated, [75, 75]);
  // An exact floor fit takes the proportional branch with scale 1.
  assert.deepEqual(allocatePanelStackHeights({
    naturalHeights: [96, 96],
    availableHeight: 192,
  }), [96, 96]);
});

test('allocation: zero minimum height leaves the floors at zero and skips the unmet pass', () => {
  assert.deepEqual(allocatePanelStackHeights({
    naturalHeights: [300, 200],
    availableHeight: 100,
    minimumHeight: 0,
  }), [60, 40], 'base is all zeros, so the whole corridor is shared by unmet share');
  // All-natural-zero panels with a real minimum: unmet stays 0 → the base passes.
  assert.deepEqual(allocatePanelStackHeights({
    naturalHeights: [0, 0],
    availableHeight: 100,
  }), [0, 0]);
});

test('bottom boundary: malformed gap and base coerce, hostile tops still clamp', () => {
  assert.equal(resolveLeftStackBottomBoundary({ baseBottom: Number.NaN }), 0,
    'a malformed inset boundary collapses to 0 rather than Infinity');
  assert.equal(resolveLeftStackBottomBoundary({ baseBottom: 700, safeGap: Number.NaN }), 700,
    'a malformed gap behaves as no gap');
  assert.equal(
    resolveLeftStackBottomBoundary({ baseBottom: 700, obstacles: [{ top: -50 }] }),
    -50,
    'an obstacle above the viewport top (negative top) genuinely limits the lane',
  );
});

test('auto-collapse: zero-natural and malformed later panels never collapse', () => {
  assert.deepEqual(panelStackAutoCollapseIndices({
    naturalHeights: [520, 0, Number.NaN, 180],
    allocatedHeights: [520, 40, 1, 90],
  }), [], 'zero-natural has no share to defend; 90/180 sits exactly at the strict threshold');
  assert.deepEqual(panelStackAutoCollapseIndices({
    naturalHeights: [520, 200],
    allocatedHeights: [520, 100],
    minimumVisibleRatio: Number.NaN,
  }), [], 'a malformed threshold behaves as 0 → everything visible is useful');
  assert.deepEqual(panelStackAutoCollapseIndices({
    naturalHeights: [520],
    allocatedHeights: [10],
  }), [], 'a single lane has no later competitor, whatever the allocation');
  // The threshold comparison is strict: exactly at the threshold stays expanded.
  assert.deepEqual(panelStackAutoCollapseIndices({
    naturalHeights: [520, 200],
    allocatedHeights: [520, 100],
    minimumVisibleRatio: 0.5,
  }), []);
});

test('corridor clamp: malformed viewport, inverted obstacle bounds, and an unusable centering', () => {
  // Malformed viewport → height 1, so the boundary band collapses to the
  // obstacle top (5) and both edges clamp into it.
  assert.deepEqual(resolvePanelStackCorridor({
    viewportHeight: Number.NaN,
    safeTop: 10,
    safeBottom: 20,
    obstacleSafeTop: 5,
    obstacleSafeBottom: 30,
    minimumHeight: 0,
  }), { safeTop: 5, safeBottom: 5 });
  // An obstacle-safe bottom above the viewport clamps to the viewport height;
  // a bottom below the top collapses the boundary band to the top.
  assert.deepEqual(resolvePanelStackCorridor({
    viewportHeight: 800,
    safeTop: 100,
    safeBottom: 700,
    obstacleSafeTop: 50,
    obstacleSafeBottom: 900,
    minimumHeight: 0,
  }), { safeTop: 100, safeBottom: 700 }, 'a boundary past the viewport pins at the viewport height');
  assert.deepEqual(resolvePanelStackCorridor({
    viewportHeight: 800,
    safeTop: 100,
    safeBottom: 700,
    obstacleSafeTop: 600,
    obstacleSafeBottom: 100,
    minimumHeight: 0,
  }), { safeTop: 600, safeBottom: 600 }, 'inverted obstacle bounds collapse to the top boundary');
  // A corridor entirely below the midpoint never takes the centering branch,
  // and the minimum pass moves the TOP up to the floor, then re-clamps.
  const low = resolvePanelStackCorridor({
    viewportHeight: 800,
    safeTop: 700,
    safeBottom: 760,
    obstacleSafeTop: 0,
    obstacleSafeBottom: 790,
    minimumHeight: 100,
  });
  assert.deepEqual(low, { safeTop: 660, safeBottom: 760 },
    'a 60px lane at the viewport bottom grows to 100px by moving its top');
});

test('a corridor straddling the midpoint is balanced toward it while it stays usable', () => {
  // Centering is a presentation win, not a requirement: when the centered lane
  // is still at least the minimum height it is taken (the oversized bottom is
  // pulled UP toward the midpoint), otherwise the aligned corridor is retained.
  assert.deepEqual(resolvePanelStackCorridor({
    viewportHeight: 1026,
    safeTop: 420,
    safeBottom: 700,
    obstacleSafeTop: 41.04,
    obstacleSafeBottom: 900,
    minimumHeight: 164.16,
  }), {
    safeTop: 420,
    safeBottom: 606,
  });
});

test('minimum panel corridor expands upward without crossing the lower obstacle boundary', () => {
  const corridor = resolvePanelStackCorridor({
    viewportHeight: 1026,
    safeTop: 510.76,
    safeBottom: 515.24,
    obstacleSafeTop: 41.04,
    obstacleSafeBottom: 515.24,
    minimumHeight: 164.16,
  });
  assert.equal(Number(corridor.safeTop.toFixed(2)), 351.08);
  assert.equal(corridor.safeBottom, 515.24);
});

test('desktop panel lanes use per-panel allocations and presentation-only auto-collapse', () => {
  const ui = readSource('./ui.js', import.meta.url);
  // Batch 5 seam 4: the adaptive layout pass lives in src/ui/panelAdaptiveLayout.js.
  const panelAdaptiveUi = readSource('./ui/panelAdaptiveLayout.js', import.meta.url);
  const css = readSource('../style.css', import.meta.url);
  assert.doesNotMatch(ui, /_enforce(?:Left|Right)PanelAccordion/);
  assert.match(panelAdaptiveUi, /classList\.add\('collapsed', 'layout-auto-collapsed'\)/);
  assert.match(panelAdaptiveUi, /classList\.remove\('collapsed', 'layout-auto-collapsed'\)/);
  assert.match(panelAdaptiveUi, /reconsiderAutoCollapse/);
  assert.match(
    ui,
    /_rightPanelStack\?\.contains\(panelEl\)[\s\S]*?_scheduleRightPanelLayout\(\{ reconsiderAutoCollapse: true \}\)/,
  );
  assert.match(
    ui,
    /_scheduleLeftPanelLayout\(\{[\s\S]*?reconsiderAutoCollapse: this\._leftPanelStack\?\.contains\(panelEl\) === true/,
  );
  assert.match(panelAdaptiveUi, /collapseLaterPanels: shouldFocus && mgr\.hud\.getVariant\(\) === 'tactical'/);
  assert.match(ui, /this\._leftStackPreferredPanelId = leftOwnerPanel\.id;/);
  assert.match(
    panelAdaptiveUi,
    /preferredExpandedPanel[\s\S]*?\[preferredExpandedPanel, \.\.\.expandedPanelsInDomOrder/,
    'the latest explicitly opened left panel must receive primary allocation',
  );
  assert.match(ui, /this\._rightStackPreferredPanelId = rightOwnerPanel\.id;/);
  assert.match(
    panelAdaptiveUi,
    /panel\.id === mgr\._rightStackPreferredPanelId[\s\S]*?\[preferredExpandedPanel, \.\.\.expandedPanelsInDomOrder/,
    'the latest explicitly opened right panel must receive primary allocation',
  );
  assert.match(ui, /panelId === 'radio-panel'[\s\S]*?document\.getElementById\('global-context-panel'\)/);
  assert.match(panelAdaptiveUi, /focusedExpandedPanel = expandedPanelsInDomOrder\.find\(\(panel\) => panel\.contains\(document\.activeElement\)\)/);
  assert.match(ui, /setAttribute\('aria-expanded', String\(!collapsed\)\)/);
  assert.match(panelAdaptiveUi, /--left-panel-allocated-height/);
  assert.match(panelAdaptiveUi, /--right-panel-allocated-height/);
  assert.match(
    panelAdaptiveUi,
    /expandedPanels[\s\S]*?removeProperty\('--left-panel-allocated-height'\)[\s\S]*?measureLeftPanelNaturalHeight\(mgr,/,
    'left intrinsic measurement must clear the prior allocation first',
  );
  assert.match(
    panelAdaptiveUi,
    /panel !== mgr\._ppToggles[\s\S]*?removeProperty\('--right-panel-allocated-height'\)[\s\S]*?const naturalHeight/,
    'right intrinsic measurement must retain Display allocation while clearing other panel allocations',
  );
  assert.match(css, /var\(--left-panel-allocated-height/);
  assert.match(css, /var\(--right-panel-allocated-height/);
  assert.match(
    css,
    /#left-panel-stack\.layout-focus > \[data-panel-id\]\.collapsed\s*\{\s*display:\s*none;/,
    'focus mode must hide every collapsed sibling, including presentation-only auto-collapses',
  );
  assert.doesNotMatch(css, /layout-focus > \[data-panel-id\]\.collapsed:not\(\.layout-auto-collapsed\)/);
  assert.match(
    panelAdaptiveUi,
    /const hiddenSibling = \(shouldFocus \|\| exclusive\) && panel\.classList\.contains\('collapsed'\);/,
    'collapsed siblings hidden by focus mode or the tactical lane contract are aria-hidden',
  );
});

test('share-panel state excludes responsive collapse and preserves recipient preferences', () => {
  const ui = readSource('./ui.js', import.meta.url);
  const sharelink = readSource('./sharelink.js', import.meta.url);

  assert.match(
    ui,
    /const collapsed = panelEl\.classList\.contains\('layout-auto-collapsed'\)\s*\? false\s*: panelEl\.classList\.contains\('collapsed'\);/,
    'responsive auto-collapse must serialize the explicit expanded preference',
  );
  assert.match(
    ui,
    /_setCommandDockPanelPinState\(spec\.id, state\.pinned, \{\s*restore: true,\s*persist: false,\s*syncShare: false,/,
    'restoring a pin must not overwrite local panel preferences or emit an intermediate hash',
  );
  assert.match(
    ui,
    /_setCommandDockPanelPinState[\s\S]*?if \(syncShare\) this\.shareLinkManager\?\.onPanelStateChange\?\.\(\);/,
    'pin and unpin must update the share hash even when collapse state is unchanged',
  );
  assert.match(ui, /\{ id: 'param-slider-panel' \}/);
  assert.match(sharelink, /\{ id: 'param-slider-panel', token: 'm', pinnable: false \}/);
});

test('parameterized Display presets keep one stable scroll owner', () => {
  const ui = readSource('./ui.js', import.meta.url);
  // Batch 5 seam 4: the adaptive layout pass lives in src/ui/panelAdaptiveLayout.js.
  const panelAdaptiveUi = readSource('./ui/panelAdaptiveLayout.js', import.meta.url);
  const css = readSource('../style.css', import.meta.url);

  assert.match(css, /#pp-toggles:not\(\.collapsed\) > #param-slider-panel\.active\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?max-height:\s*none;[\s\S]*?overflow-y:\s*visible;/);
  assert.match(panelAdaptiveUi, /const displayScrollTop = mgr\._displayPortalScrollRestoreOwner === 'standard'[\s\S]*?mgr\._standardDisplayScrollTop[\s\S]*?mgr\._ppToggles\?\.scrollTop \|\| 0/);
  assert.match(panelAdaptiveUi, /mgr\._ppToggles\.scrollTop = Math\.min\(displayScrollTop, maxScrollTop\);/);
  assert.match(
    ui,
    /this\._sliderPanel\.classList\.remove\('active'\);\s*this\._scheduleRightPanelLayout\(\);/,
  );
  assert.match(
    ui,
    /this\._sliderPanel\.classList\.add\('active'\);\s*this\._scheduleRightPanelLayout\(\);/,
  );
  assert.match(
    css,
    /\.param-slider\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-width:\s*0;/,
    'parameter sliders must shrink before their value column can overflow',
  );
});

test('expanded Display uses its container shell instead of a nested header card', () => {
  const css = readSource('../style.css', import.meta.url);

  assert.match(
    css,
    /#pp-toggles:not\(\.collapsed\) > \.pp-header-row\s*\{[\s\S]*?border:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/,
  );
  assert.match(
    css,
    /#pp-toggles\.collapsed \.pp-header-row\s*\{[\s\S]*?width:\s*var\(--right-collapsed-width, 132px\);/,
    'collapsed Display must retain its standalone launcher sizing',
  );
});

test('expanded left panels integrate their headers with the container shell', () => {
  const css = readSource('../style.css', import.meta.url);

  assert.match(
    css,
    /#left-panel-stack > \[data-panel-id\]:not\(\.collapsed\) \.panel-header\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?background:\s*transparent;/,
  );
  assert.match(
    css,
    /#left-panel-stack > \[data-panel-id\]:not\(\.collapsed\) \.panel-divider\s*\{[\s\S]*?linear-gradient\(90deg, rgb\(0 212 255 \/ 28%\), rgba\(0, 212, 255, 0\.18\) 58%, transparent\)[\s\S]*?box-shadow:\s*0 0 7px rgba\(0, 212, 255, 0\.22\);/,
  );
});

test('Map Source uses four compact tiles in the bottom Visual Presets tray', () => {
  const html = readSource('../index.html', import.meta.url);
  const css = readSource('../style.css', import.meta.url);

  assert.doesNotMatch(html, /id="stack-panel"/);
  assert.match(html, /id="control-panel"[\s\S]*?class="map-source-section"[\s\S]*?id="map-stack-chips"/);
  assert.match(
    css,
    /\.map-stack-chip-row\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/,
    'the desktop source selector keeps all four tiles on one row',
  );
});

test('expanded right panels highlight the title divider without changing collapsed launchers', () => {
  const html = readSource('../index.html', import.meta.url);
  const css = readSource('../style.css', import.meta.url);

  assert.match(
    html,
    /class="compact pp-header-row"[\s\S]*?class="pp-header-label">DISPLAY<\/span>[\s\S]*?class="panel-divider"/,
  );
  assert.match(
    css,
    /#right-context-rail \[data-panel-id\]:not\(\.collapsed\) \.panel-divider\s*\{[\s\S]*?linear-gradient\(90deg, rgb\(0 212 255 \/ 28%\), rgba\(0, 212, 255, 0\.18\) 58%, transparent\)[\s\S]*?box-shadow:\s*0 0 7px rgba\(0, 212, 255, 0\.22\);/,
  );
  assert.match(
    css,
    /#param-slider-panel:not\(\.collapsed\) \.param-panel-divider\s*\{[\s\S]*?linear-gradient\(90deg, rgb\(0 212 255 \/ 28%\), rgba\(0, 212, 255, 0\.18\) 58%, transparent\);/,
  );
});
