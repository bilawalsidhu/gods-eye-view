import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, h, nextTick } from 'vue';
import { createPinia } from 'pinia';
import { RealtimeCost } from './realtimeCost.js';
import { createVoiceCostTracker, resolveVoiceModel } from './voiceCost.js';
import { createTestVoiceUi } from '../testSupport/voiceUi.mjs';
import { useVoiceStore } from '../ui/stores/voice.js';
import VoiceControl from '../ui/views/panels/VoiceControl.vue';

const $ = (selector) => document.querySelector(selector);
// Shown unless it or an ancestor is hidden.
const visible = (selector) => {
  const node = $(selector);
  return Boolean(node) && !node.closest('[hidden]');
};

function harness(t) {
  document.body.replaceChildren();
  const pinia = createPinia();
  const ui = createTestVoiceUi({ panel: true, pinia });
  const store = useVoiceStore(pinia);
  // The dock renders the presented control; this renders only that.
  const app = createApp({
    render: () => store.view && h(VoiceControl, { view: store.view }),
  }).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
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

test('soft cost warning is visible outside closed Settings, while ordinary spend stays inside', async (t) => {
  const { cost, ui, recordThreeDollars } = harness(t);
  cost.syncCostUi();
  await nextTick();
  assert.equal(ui.state.voicePanel.hidden, true);
  assert.equal($('#gev-voice-panel').hidden, true);
  assert.equal(visible('#gev-voice-cost-value'), false);
  assert.equal($('#gev-voice-cost-warning').hidden, true);
  assert.equal(
    $('#gev-voice-panel').contains($('#gev-voice-cost-warning')),
    false,
  );
  assert.equal(
    $('#gev-voice-control').querySelectorAll('#gev-voice-cost-value').length,
    1,
  );

  recordThreeDollars();
  await nextTick();
  const warning = $('#gev-voice-cost-warning');
  const value = $('#gev-voice-cost-value');
  assert.equal(visible('#gev-voice-cost-warning'), true);
  assert.equal(warning.dataset.level, 'warn');
  assert.equal(warning.textContent, value.textContent);
  assert.equal(warning.title, value.title);
  assert.match(warning.title, /Warns at/);
  assert.equal(
    $('#gev-voice-panel').hidden,
    true,
    'warning never forces Settings open',
  );

  cost.prepareSession();
  cost.syncCostUi();
  await nextTick();
  assert.equal(
    $('#gev-voice-cost-warning').hidden,
    true,
    'new session clears the old warning',
  );
  assert.equal($('#gev-voice-cost-warning').textContent, '');
});

test('closed Settings cannot hide the hard cap or suppress its ordinary stop and status', async (t) => {
  const { stops, statuses, recordThreeDollars } = harness(t);
  recordThreeDollars();
  assert.equal(stops.length, 0);
  recordThreeDollars();
  await nextTick();
  assert.equal(visible('#gev-voice-cost-warning'), true);
  assert.equal($('#gev-voice-cost-warning').dataset.level, 'cap');
  assert.deepEqual(stops, [{ preserveStatus: true }]);
  assert.equal(statuses.at(-1)[0], 'idle');
  assert.match(statuses.at(-1)[1], /Session ended — cost cap/);
});

test('unknown OAuth cost remains visible outside Settings and clears on a fresh API meter', async (t) => {
  const { cost } = harness(t);
  cost.sessionCloudVoiceAuth = 'oauth';
  cost.syncCostUi();
  await nextTick();
  const warning = $('#gev-voice-cost-warning');
  assert.equal(visible('#gev-voice-cost-warning'), true);
  assert.equal(warning.dataset.level, 'unknown');
  assert.equal(warning.textContent, 'COST UNKNOWN');
  assert.match(warning.title, /USD cost and the API spend cap are unavailable/);
  assert.equal($('#gev-voice-panel').hidden, true);
  cost.sessionCloudVoiceAuth = 'api-key';
  cost.syncCostUi();
  await nextTick();
  assert.equal($('#gev-voice-cost-warning').hidden, true);
});
