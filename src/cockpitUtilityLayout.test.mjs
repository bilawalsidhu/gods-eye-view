import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCockpitUtilityAnchor,
  resolveCockpitUtilityLayout,
} from './cockpitUtilityLayout.js';

// 1512x790, the height the strip used to collide with the briefing card at.
const desktop = { viewportHeight: 790, stripHeight: 107, collapsedHeight: 50 };

test('the strip hangs 12px under the REC readout when the briefing card leaves room', () => {
  const { top } = resolveCockpitUtilityAnchor({ ...desktop, recBottom: 148.1, signalTop: 420 });
  assert.equal(Number(top.toFixed(1)), 160.1);
});

test('a tall briefing card pulls the strip up instead of being overlapped', () => {
  const { top, maxHeight } = resolveCockpitUtilityAnchor({
    ...desktop,
    recBottom: 148.1,
    signalTop: 265.4,
  });
  assert.equal(Number(top.toFixed(1)), 150.4);
  assert.equal(Number((265.4 - (top + desktop.stripHeight)).toFixed(1)), 8);
  assert.equal(Number(maxHeight.toFixed(1)), 107);
});

test('the strip never climbs into the topline, whatever the briefing card does', () => {
  const { top } = resolveCockpitUtilityAnchor({
    ...desktop,
    viewportHeight: 1400,
    recBottom: 200,
    signalTop: 150,
  });
  // minTop = max(96, 1400 * 0.12) = 168.
  assert.equal(top, 168);
});

test('the corridor is measured from the resolved top and floors on a launcher, not 120', () => {
  const { top, maxHeight } = resolveCockpitUtilityAnchor({
    ...desktop,
    viewportHeight: 700,
    recBottom: 148.1,
    signalTop: 140,
  });
  assert.equal(top, 96);
  // 140 - 96 - 8 = 36px of real corridor: report the launcher floor, never a
  // 120px fiction that let the strip run straight through the card.
  assert.equal(maxHeight, 50);
});

test('a missing REC readout leaves the strip on the viewport ceiling', () => {
  const { top } = resolveCockpitUtilityAnchor({ ...desktop, recBottom: 0, signalTop: 600 });
  assert.equal(top, 96);
});

test('keeps the collapsed sibling visible when both Cockpit utilities fit', () => {
  assert.deepEqual(resolveCockpitUtilityLayout({
    availableHeight: 320,
    expandedHeight: 220,
    collapsedHeight: 50,
  }), {
    primaryOnly: false,
    expandedMaxHeight: 263,
  });
});

test('keeps the collapsed sibling at the exact corridor boundary', () => {
  assert.equal(resolveCockpitUtilityLayout({
    availableHeight: 277,
    expandedHeight: 220,
    collapsedHeight: 50,
  }).primaryOnly, false);
});

test('gives the expanded panel the full corridor when both controls do not fit', () => {
  assert.deepEqual(resolveCockpitUtilityLayout({
    availableHeight: 276,
    expandedHeight: 220,
    collapsedHeight: 50,
  }), {
    primaryOnly: true,
    expandedMaxHeight: 276,
  });
});

test('clamps malformed or short corridors to the minimum expanded height', () => {
  assert.deepEqual(resolveCockpitUtilityLayout({
    availableHeight: Number.NaN,
    expandedHeight: 180,
    collapsedHeight: 50,
  }), {
    primaryOnly: true,
    expandedMaxHeight: 120,
  });
});

// --- Branch coverage: every defensive coercion is a contract, not noise -----
// Each row pins one coercion branch so a refactor cannot silently change what
// malformed measurements resolve to.

test('anchor coercions: malformed measurements resolve, never throw', () => {
  const rows = [
    // [label, overrides, expected top]
    ['negative viewport floors at 0 (recBottom still anchors)', { viewportHeight: -100, recBottom: 300, signalTop: 800 }, 312],
    ['NaN viewport floors at 0 (recBottom still anchors)', { viewportHeight: Number.NaN, recBottom: 300, signalTop: 800 }, 312],
    ['negative recBottom coerces to 0', { recBottom: -50, signalTop: 800 }, 96],
    ['NaN stripHeight coerces to 0', { stripHeight: Number.NaN, recBottom: 200, signalTop: 600 }, 212],
    ['negative stripHeight coerces to 0', { stripHeight: -40, recBottom: 200, signalTop: 600 }, 212],
    ['Infinity stripHeight is finite math, not NaN top', { stripHeight: Number.POSITIVE_INFINITY, recBottom: 200, signalTop: 600 }, 96],
    ['non-numeric signalTop falls back to the viewport as the lower bound', { signalTop: 'none', recBottom: 200 }, 212],
    ['Infinity signalTop is finite → lower bound is the card', { signalTop: Number.POSITIVE_INFINITY, recBottom: 200 }, 212],
  ];
  for (const [label, overrides, expectedTop] of rows) {
    const { top } = resolveCockpitUtilityAnchor({ ...desktop, ...overrides });
    assert.equal(top, expectedTop, label);
  }
});

test('anchor knobs: gaps, floors and ratios are all honoured', () => {
  // recGap rides the anchored top: 148.1 + 20 = 168.1, above minTop.
  assert.equal(resolveCockpitUtilityAnchor(
    { ...desktop, recBottom: 148.1, signalTop: 600, recGap: 20 },
  ).top, 168.1);
  // signalGap widens the clearance above the briefing card.
  const widened = resolveCockpitUtilityAnchor(
    { ...desktop, recBottom: 148.1, signalTop: 265.4, signalGap: 20 },
  );
  assert.equal(Number(widened.top.toFixed(1)), 138.4, 'clearedTop = 265.4 - 20 - 107');
  // minTopRatio alone can set the ceiling on a tall viewport.
  assert.equal(resolveCockpitUtilityAnchor(
    { ...desktop, viewportHeight: 1000, recBottom: 0, signalTop: 900, minTopFloor: 10, minTopRatio: 0.3 },
  ).top, 300);
  // minTopFloor wins over the ratio when it is the larger of the two.
  assert.equal(resolveCockpitUtilityAnchor(
    { ...desktop, viewportHeight: 1000, recBottom: 0, signalTop: 900, minTopFloor: 400, minTopRatio: 0.3 },
  ).top, 400);
  // minTopFloor 0 still floors via the ratio term.
  assert.equal(resolveCockpitUtilityAnchor(
    { ...desktop, viewportHeight: 500, recBottom: 0, signalTop: 900, minTopFloor: 0, minTopRatio: 0.1 },
  ).top, 50);
});

test('anchor corridor: a zero collapsedHeight still reports the 50px launcher floor', () => {
  const { maxHeight } = resolveCockpitUtilityAnchor(
    { ...desktop, viewportHeight: 700, recBottom: 148.1, signalTop: 140, collapsedHeight: 0 },
  );
  assert.equal(maxHeight, 50, '0 is falsy by design — the launcher floor applies');
  const taller = resolveCockpitUtilityAnchor(
    { ...desktop, viewportHeight: 700, recBottom: 148.1, signalTop: 140, collapsedHeight: 64 },
  );
  assert.equal(taller.maxHeight, 64, 'a real collapsedHeight is honoured');
});

test('layout coercions: malformed panel sizes resolve to sane booleans', () => {
  // expandedHeight NaN → 0: the sibling always fits.
  assert.equal(resolveCockpitUtilityLayout({
    availableHeight: 320, expandedHeight: Number.NaN, collapsedHeight: 50,
  }).primaryOnly, false);
  // collapsedHeight NaN → 0: only the gap rides along.
  assert.equal(resolveCockpitUtilityLayout({
    availableHeight: 320, expandedHeight: 220, collapsedHeight: Number.NaN,
  }).primaryOnly, false, '220 + 7 + 0 ≤ 320');
  // gap 0 or negative → 0: bare heights compete.
  assert.equal(resolveCockpitUtilityLayout({
    availableHeight: 320, expandedHeight: 320, collapsedHeight: 50, gap: 0,
  }).primaryOnly, true, '320 > 320 minus nothing... the bare sum overflows');
  assert.equal(resolveCockpitUtilityLayout({
    availableHeight: 320, expandedHeight: 320, collapsedHeight: 50, gap: -5,
  }).primaryOnly, true, 'negative gap coerces to 0, bare 320+50 still overflows');
  // availableHeight 0 → the minimum-expanded clamp wins.
  assert.deepEqual(resolveCockpitUtilityLayout({
    availableHeight: 0, expandedHeight: 10, collapsedHeight: 10,
  }), { primaryOnly: false, expandedMaxHeight: 120 });
  // A custom minimum floors the panel, not 120.
  assert.equal(resolveCockpitUtilityLayout({
    availableHeight: 90, expandedHeight: 10, collapsedHeight: 10, minimumExpandedHeight: 80,
  }).expandedMaxHeight, 80);
});

