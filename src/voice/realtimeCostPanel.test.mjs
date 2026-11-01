import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceControl } from './control.js';
import { RealtimeCost } from './realtimeCost.js';
import { createVoiceCostTracker, resolveVoiceModel } from './voiceCost.js';
import { installPanelDom } from './panel/testDom.mjs';

function harness(t) {
  installPanelDom(t);
  const ui = createVoiceControl({ panel: true });
  const stops = [];
  const statuses = [];
  const cost = new RealtimeCost({
    readUi: () => ui,
    readStatus: () => 'listening',
    operations: {
      isActive: () => true,
      stop: (options) => stops.push(options),
      setStatus: (...args) => statuses.push(args),
      debugLog() {},
    },
  });
  cost.cloudVoiceAuth = 'api-key';
  cost.costTracker = createVoiceCostTracker({
    tier: 'standard',
    limits: { warnUsd: 2, capUsd: 5 },
  });
  const recordThreeDollars = () => {
    const tokens = Math.ceil(
      (3 * 1_000_000) / resolveVoiceModel('standard').rates.textOutput,
    );
    const state = cost.costTracker.record({
      output_tokens: tokens,
      output_token_details: { text_tokens: tokens },
    });
    cost.applyCost(state);
  };
  t.mock.method(console, 'warn', () => {});
  return { cost, ui, stops, statuses, recordThreeDollars };
}

test('soft cost warning is visible outside closed Settings, while ordinary spend stays inside', (t) => {
  const { cost, ui, recordThreeDollars } = harness(t);
  cost.syncCostUi();
  assert.equal(ui.voicePanel.hidden, true);
  assert.equal(ui.costValue.checkVisibility(), false);
  assert.equal(ui.costWarning.hidden, true);
  assert.equal(ui.voicePanel.contains(ui.costWarning), false);
  assert.equal(ui.root.querySelectorAll('#gev-voice-cost-value').length, 1);

  recordThreeDollars();
  assert.equal(ui.costWarning.checkVisibility(), true);
  assert.equal(ui.costWarning.dataset.level, 'warn');
  assert.equal(ui.costWarning.textContent, ui.costValue.textContent);
  assert.equal(ui.costWarning.title, ui.costValue.title);
  assert.match(ui.costWarning.title, /Warns at/);
  assert.equal(
    ui.voicePanel.hidden,
    true,
    'warning never forces Settings open',
  );

  cost.prepareSession();
  cost.syncCostUi();
  assert.equal(
    ui.costWarning.hidden,
    true,
    'new session clears the old warning',
  );
  assert.equal(ui.costWarning.textContent, '');
});

test('closed Settings cannot hide the hard cap or suppress its ordinary stop and status', (t) => {
  const { ui, stops, statuses, recordThreeDollars } = harness(t);
  recordThreeDollars();
  assert.equal(stops.length, 0);
  recordThreeDollars();
  assert.equal(ui.costWarning.checkVisibility(), true);
  assert.equal(ui.costWarning.dataset.level, 'cap');
  assert.deepEqual(stops, [{ preserveStatus: true }]);
  assert.equal(statuses.at(-1)[0], 'idle');
  assert.match(statuses.at(-1)[1], /Session ended — cost cap/);
});

test('unknown OAuth cost remains visible outside Settings and clears on a fresh API meter', (t) => {
  const { cost, ui } = harness(t);
  cost.sessionCloudVoiceAuth = 'oauth';
  cost.syncCostUi();
  assert.equal(ui.costWarning.checkVisibility(), true);
  assert.equal(ui.costWarning.dataset.level, 'unknown');
  assert.equal(ui.costWarning.textContent, 'COST UNKNOWN');
  assert.match(
    ui.costWarning.title,
    /USD cost and the API spend cap are unavailable/,
  );
  assert.equal(ui.voicePanel.hidden, true);
  cost.sessionCloudVoiceAuth = 'api-key';
  cost.syncCostUi();
  assert.equal(ui.costWarning.hidden, true);
});
