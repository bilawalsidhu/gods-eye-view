import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCockpitUtilityAnchor,
  resolveCockpitUtilityLayout,
  resolveCyberCockpitPanelLane,
} from './cockpitUtilityLayout.js';

// 1512x790, the height the strip used to collide with the briefing card at.
const desktop = { viewportHeight: 790, stripHeight: 107, collapsedHeight: 50 };

test('Cyber shared panel slot reserves both footer lanes above the decorative frame', () => {
  for (const viewportHeight of [600, 673, 713, 986, 1376]) {
    for (const signalHeight of [44, 76]) {
      for (const contactHeight of [44, 84, 120]) {
        const top = Math.max(164, Math.min(204, viewportHeight * 0.19));
        const lane = resolveCyberCockpitPanelLane({ viewportHeight, top, signalHeight, contactHeight });
        assert.ok(lane.panelHeight >= 120);
        assert.ok(top + lane.panelHeight + 8 + contactHeight <= viewportHeight * 0.82 + .01);
        assert.ok(lane.signalTop + signalHeight <= viewportHeight * 0.82 + .01);
        assert.equal(lane.signalTop, top + lane.utilityHeight + 8);
      }
    }
  }
});

test('Cyber keeps the Data Layers top while reserving briefing clearance', () => {
  for (const viewportHeight of [673, 713, 986, 1376]) {
    const leftTop = Math.max(164, Math.min(204, viewportHeight * 0.19));
    const collapsed = resolveCockpitUtilityAnchor({
      viewportHeight, stripHeight: 128, collapsedHeight: 60, recBottom: 0,
      signalTop: leftTop + 128 + 28, minTopFloor: leftTop, minTopRatio: 0,
    });
    assert.equal(collapsed.top, leftTop);
    assert.ok(collapsed.maxHeight >= 128);
    const expanded = resolveCockpitUtilityAnchor({
      viewportHeight, stripHeight: 700, collapsedHeight: 60, recBottom: 0,
      signalTop: 255, minTopFloor: leftTop, minTopRatio: 0,
      signalCollapsed: true, utilityExpanded: true, reserveViewportLane: true, signalHeight: 44,
    });
    assert.equal(expanded.top, leftTop);
    assert.equal(expanded.top + expanded.maxHeight + 8 + 44 + 80, viewportHeight);
  }
});

test('expanded utilities reserve the visible collapsed briefing header at every desktop height', () => {
  for (const viewportHeight of [640, 720, 987, 1376]) {
    for (const signalHeight of [48, 76, 100]) {
      const { top, maxHeight } = resolveCockpitUtilityAnchor({
        ...desktop, viewportHeight, recBottom: 0, signalTop: 255,
        signalCollapsed: true, utilityExpanded: true, signalHeight, reserveViewportLane: true,
      });
      assert.equal(top + maxHeight + 8, viewportHeight - 80 - signalHeight);
    }
  }
});

test('the strip hangs 12px under the REC readout when the briefing card leaves room', () => {
  const { top } = resolveCockpitUtilityAnchor({
    ...desktop,
    recBottom: 148.1,
    signalTop: 420,
  });
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
  const { top } = resolveCockpitUtilityAnchor({
    ...desktop,
    recBottom: 0,
    signalTop: 600,
  });
  assert.equal(top, 96);
});

test('an expanded utility claims the vertical lane released by a collapsed briefing', () => {
  const { top, maxHeight } = resolveCockpitUtilityAnchor({
    ...desktop,
    recBottom: 148.1,
    signalTop: 265.4,
    signalCollapsed: true,
    utilityExpanded: true,
    reserveViewportLane: true,
  });
  assert.equal(Number(top.toFixed(1)), 160.1);
  assert.equal(Number(maxHeight.toFixed(1)), 541.9);
});

test('non-relocating themes preserve the visible briefing boundary even when collapsed', () => {
  const { top, maxHeight } = resolveCockpitUtilityAnchor({
    ...desktop, recBottom: 148.1, signalTop: 265.4,
    signalCollapsed: true, utilityExpanded: true,
  });
  assert.equal(Number((top + maxHeight).toFixed(1)), 257.4);
});

test('a collapsed briefing still bounds the utility strip until a panel expands', () => {
  const { maxHeight } = resolveCockpitUtilityAnchor({
    ...desktop,
    recBottom: 148.1,
    signalTop: 265.4,
    signalCollapsed: true,
  });
  assert.equal(Number(maxHeight.toFixed(1)), 107);
});

test('keeps the collapsed sibling visible when both Cockpit utilities fit', () => {
  assert.deepEqual(
    resolveCockpitUtilityLayout({
      availableHeight: 320,
      expandedHeight: 220,
      collapsedHeight: 50,
    }),
    {
      primaryOnly: false,
      expandedMaxHeight: 263,
    },
  );
});

test('keeps the collapsed sibling at the exact corridor boundary', () => {
  assert.equal(
    resolveCockpitUtilityLayout({
      availableHeight: 277,
      expandedHeight: 220,
      collapsedHeight: 50,
    }).primaryOnly,
    false,
  );
});

test('gives the expanded panel the full corridor when both controls do not fit', () => {
  assert.deepEqual(
    resolveCockpitUtilityLayout({
      availableHeight: 276,
      expandedHeight: 220,
      collapsedHeight: 50,
    }),
    {
      primaryOnly: true,
      expandedMaxHeight: 276,
    },
  );
});

test('clamps malformed or short corridors to the minimum expanded height', () => {
  assert.deepEqual(
    resolveCockpitUtilityLayout({
      availableHeight: Number.NaN,
      expandedHeight: 180,
      collapsedHeight: 50,
    }),
    {
      primaryOnly: true,
      expandedMaxHeight: 120,
    },
  );
});
