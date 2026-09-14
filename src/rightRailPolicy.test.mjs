import { readSource } from './testSupport/readSource.js';
import assert from 'node:assert/strict';

import test from 'node:test';
import {
  shouldExpandGlobalContextPanel,
  shouldHideCollapsedLanePanels,
} from './rightRailPolicy.js';

test('Tactical HUD hides collapsed lane siblings while one panel is expanded', () => {
  assert.equal(shouldHideCollapsedLanePanels({
    hudVariant: 'tactical',
    hasExpandedPanel: true,
  }), true);
});

test('collapsed launchers remain when Tactical has no expanded panel', () => {
  assert.equal(shouldHideCollapsedLanePanels({
    hudVariant: 'tactical',
    hasExpandedPanel: false,
  }), false);
});

test('other HUD layouts keep collapsed lane launchers visible', () => {
  assert.equal(shouldHideCollapsedLanePanels({
    hudVariant: 'minimal',
    hasExpandedPanel: true,
  }), false);
  assert.equal(shouldHideCollapsedLanePanels({
    hudVariant: 'full',
    hasExpandedPanel: true,
  }), false);
});

test('desktop Display participates in Tactical exclusivity without changing mobile Display behavior', () => {
  // Batch 5 seam 4: the adaptive layout pass lives in src/ui/panelAdaptiveLayout.js.
  const panelAdaptiveUi = readSource('./ui/panelAdaptiveLayout.js', import.meta.url);
  const css = readSource('../style.css', import.meta.url);
  assert.match(panelAdaptiveUi, /const isMobile = window\.matchMedia\('\(max-width: 720px\)'\)\.matches/);
  assert.match(
    panelAdaptiveUi,
    /!panel\.classList\.contains\('collapsed'\) && \(!isMobile \|\| panel\.id !== 'pp-toggles'\)/,
  );
  assert.doesNotMatch(
    panelAdaptiveUi,
    /panel\.id !== 'pp-toggles' && !panel\.classList\.contains\('collapsed'\)/,
  );
  assert.match(panelAdaptiveUi, /if \(exclusive && panel\.classList\.contains\('collapsed'\)\) panel\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(css, /#right-context-rail\.layout-exclusive > \[data-panel-id\]\.collapsed \{/);
  assert.match(css, /#left-panel-stack\.layout-exclusive > \[data-panel-id\]\.collapsed \{/);
});

test('both lanes restate Tactical exclusivity in the same pass that auto-collapses', () => {
  // Batch 5 seam 4: the adaptive layout pass lives in src/ui/panelAdaptiveLayout.js.
  const panelAdaptiveUi = readSource('./ui/panelAdaptiveLayout.js', import.meta.url);
  // Each lane engine's auto-collapse early return must commit the exclusive
  // class and aria-hidden itself: deferring to the rescheduled frame leaves
  // the freshly collapsed launcher visible and screen-reader reachable until
  // it lands (unbounded under a starved render loop).
  assert.equal(
    (panelAdaptiveUi.match(/collapsedExclusive = shouldHideCollapsedLanePanels/g) || []).length,
    2,
    'the left accordion and the right rail must both restate exclusivity on auto-collapse',
  );
});

test('explicit Contacts, Space Missions, and Cockpit actions expand Global Context after success', () => {
  for (const action of ['contacts', 'space-missions', 'cockpit']) {
    assert.equal(shouldExpandGlobalContextPanel({
      action,
      explicitUserAction: true,
      succeeded: true,
    }), true, `${action} should reveal its supporting context`);
  }
});

test('Cockpit expansion is independent of whether a track was already selected', () => {
  for (const selectedTrack of [null, 'UAL649']) {
    assert.equal(shouldExpandGlobalContextPanel({
      action: 'cockpit',
      explicitUserAction: true,
      succeeded: true,
      selectedTrack,
    }), true);
  }
});

test('restoration and programmatic replay preserve the saved Global Context collapse state', () => {
  assert.equal(shouldExpandGlobalContextPanel({
    action: 'contacts',
    explicitUserAction: false,
    succeeded: true,
  }), false);
  assert.equal(shouldExpandGlobalContextPanel({
    action: 'space-missions',
    explicitUserAction: true,
    succeeded: true,
    restoring: true,
  }), false);
});

test('failed or unrelated actions never expand Global Context', () => {
  assert.equal(shouldExpandGlobalContextPanel({
    action: 'contacts',
    explicitUserAction: true,
    succeeded: false,
  }), false, 'a failed transition must preserve the prior panel state for rollback');
  assert.equal(shouldExpandGlobalContextPanel({
    action: 'search-nearby',
    explicitUserAction: true,
    succeeded: true,
  }), false);
});
