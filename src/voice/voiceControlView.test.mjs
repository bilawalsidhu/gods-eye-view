// src/voice/voiceControlView.test.mjs — the voice control renders the card's
// lists and the waveform from its presenter, over happy-dom.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestVoiceUi } from '../testSupport/voiceUi.mjs';
import { mountVoiceView } from '../testSupport/voiceView.mjs';
import { useVoiceStore } from '../ui/stores/voice.js';
import { createManualVoicePanel } from './panel/manualPanel.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

test('the card renders its plan, chips, lines, referents and notes', async (t) => {
  const { pinia, settle } = mountVoiceView(t);
  const ui = createTestVoiceUi({ pinia });
  ui.replace('card', {
    ...ui.state.card,
    visible: true,
    busy: true,
    phase: 'WORKING',
    steps: [
      {
        key: 'a',
        label: 'Fly to Austin',
        status: 'done',
        statusText: 'done',
        detail: '',
      },
      {
        key: 'b',
        label: 'Show traffic',
        status: 'running',
        statusText: '',
        detail: 'Loading',
      },
    ],
    result: {
      visible: true,
      title: 'Austin',
      chips: ['live'],
      lines: ['Line one', 'Line two'],
      referents: [{ n: 3, label: 'Tower' }],
      notes: ['Source: Example'],
    },
    announce: 'Austin',
  });
  await settle();
  assert.equal($('#gev-voice-card').hidden, false);
  assert.equal($('#gev-voice-card').dataset.busy, 'true');
  assert.equal($('#gev-voice-card-phase').textContent, 'WORKING');
  const steps = $$('#gev-voice-card-plan .gev-voice-card-step');
  assert.deepEqual(
    steps.map((step) => [step.dataset.status, step.textContent]),
    [
      ['done', 'Fly to Austin, done'],
      ['running', 'Show trafficLoading'],
    ],
  );
  assert.equal($('#gev-voice-card-plan').hidden, false);
  const chip = $('#gev-voice-card-chips .gev-voice-card-chip');
  assert.equal(chip.dataset.tone, 'live');
  assert.equal(chip.textContent, 'live');
  assert.deepEqual(
    $$('#gev-voice-card-lines li').map((li) => li.textContent),
    ['Line one', 'Line two'],
  );
  const referent = $('#gev-voice-card-referents li');
  assert.equal(referent.value, 3);
  assert.equal(referent.textContent, 'Tower');
  assert.equal($('#gev-voice-card-notes').hidden, false);
  assert.equal($('#gev-voice-card-live').textContent, 'Austin');

  ui.replace('card', {
    ...ui.state.card,
    steps: [],
    result: { ...ui.state.card.result, chips: [], referents: [], notes: [] },
  });
  await settle();
  assert.equal($('#gev-voice-card-plan').hidden, true);
  assert.equal($('#gev-voice-card-chips').hidden, true);
  assert.equal($('#gev-voice-card-referents').hidden, true);
  assert.equal($('#gev-voice-card-notes').hidden, true);
});

test('the waveform shows bars as they change and rests to the CSS baseline', async (t) => {
  const { pinia, settle } = mountVoiceView(t);
  const ui = createTestVoiceUi({ pinia });
  await settle();
  const bars = () => $$('.gev-voice-visualizer span');
  assert.equal(bars().length, 15);
  assert.equal(bars()[4].style.getPropertyValue('--bar'), '4');
  assert.equal(bars()[4].style.getPropertyValue('--audio-level'), '');
  const frame = Array.from({ length: 15 }, (_, i) => ({
    level: `${5 + i}px`,
    opacity: '0.80',
  }));
  ui.setBars(frame);
  await settle();
  assert.equal(bars()[4].style.getPropertyValue('--audio-level'), '9px');
  assert.equal(bars()[4].style.getPropertyValue('--audio-opacity'), '0.80');
  // An identical frame publishes nothing, and bars never replace the
  // control's view, so the rest of the dock does not re-render for them.
  const store = useVoiceStore(pinia);
  const view = store.view;
  const published = store.bars;
  ui.setBars(frame.map((bar) => ({ ...bar })));
  assert.equal(store.bars === published, true);
  assert.equal(store.view === view, true);
  ui.setBars(null);
  await settle();
  assert.equal(bars()[4].style.getPropertyValue('--audio-level'), '');
  assert.equal(bars()[4].style.getPropertyValue('--bar'), '4');
});

test('Preview is not reported visible while the error tray replaces the card', async (t) => {
  const { pinia, settle } = mountVoiceView(t);
  const ui = createTestVoiceUi({ panel: true, pinia });
  ui.replace('card', { ...ui.state.card, visible: true });
  const panel = createManualVoicePanel({
    ui,
    card: { setPresented() {} },
    getPreviewEnabled: () => true,
    copy: { previewEmpty: 'Empty', previewDisabled: 'Off' },
  });
  t.after(() => panel.destroy());
  panel.select('preview');
  await settle();
  assert.equal(panel.snapshot().previewVisible, true);
  ui.update('root', { status: 'error' });
  assert.equal(panel.snapshot().previewVisible, false);
});
