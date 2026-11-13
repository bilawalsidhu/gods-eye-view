import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { nextTick } from 'vue';
import { createTestVoiceUi } from '../testSupport/voiceUi.mjs';
import { mountVoiceView } from '../testSupport/voiceView.mjs';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';
import { VoiceCardControls } from './voiceCard.js';
import { getLocale, setLocale } from '../i18n/index.js';
import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';

const css = readStylesheet(new URL('../../style.css', import.meta.url));

function fold(events) {
  return events.reduce(reduceVoiceCard, initialVoiceCardState());
}

test('presentation: a slow annotate turn shows captions, plan steps and the result card', () => {
  const state = fold([
    { type: 'interruption' },
    {
      type: 'transcript',
      role: 'user',
      text: 'Annotate the Texas State Capitol',
      final: true,
    },
    {
      type: 'transcript',
      role: 'assistant',
      text: 'Finding the Capitol, ',
      responseId: 'r1',
    },
    {
      type: 'transcript',
      role: 'assistant',
      text: 'then outlining it.',
      responseId: 'r1',
    },
    {
      type: 'action-call',
      name: 'annotate_map',
      callId: 'call_a',
      arguments: { annotations: [{ target: 'Texas State Capitol' }] },
    },
    {
      type: 'progress',
      name: 'annotate_map',
      callId: 'call_a',
      step: 'resolve',
      label: 'Texas State Capitol',
    },
  ]);
  let view = voiceCardView(state);
  assert.equal(view.visible, true);
  assert.equal(view.busy, true);
  assert.equal(view.phase, 'WORKING');
  assert.equal(view.user.text, 'Annotate the Texas State Capitol');
  assert.equal(view.assistant.text, 'Finding the Capitol, then outlining it.');
  assert.deepEqual(
    view.steps.map(({ label, status, detail }) => ({ label, status, detail })),
    [
      {
        label: 'Mark Texas State Capitol',
        status: 'running',
        detail: 'Finding places: Texas State Capitol',
      },
    ],
  );
  const done = [
    {
      type: 'action-result',
      name: 'annotate_map',
      callId: 'call_a',
      result: {
        ok: true,
        outlinePending: true,
        items: [{ ok: true, id: 'anno-1', outlinePending: true }],
        display: {
          title: 'Marked 1 place',
          lines: ['Texas State Capitol'],
          notes: ['Tracing outlines'],
          sources: [{ label: 'OpenStreetMap' }],
        },
        referents: [{ n: 1, id: 'anno-1', label: 'Texas State Capitol' }],
      },
    },
    { type: 'outline', id: 'anno-1', status: 'resolved' },
  ].reduce(reduceVoiceCard, state);
  view = voiceCardView(done);
  assert.equal(view.phase, 'DONE');
  assert.equal(view.steps[0].detail, 'Outline traced');
  assert.equal(view.result.title, 'Marked 1 place');
  assert.deepEqual(view.result.referents, [
    { n: 1, label: 'Texas State Capitol' },
  ]);
  assert.deepEqual(view.result.notes, [
    'Tracing outlines',
    'Source: OpenStreetMap',
  ]);
  assert.equal(
    view.announce,
    'Marked 1 place',
    'the live region carries the result title',
  );
});

test('presentation: silent lookups, dismissal and session end', () => {
  const lookup = fold([
    { type: 'interruption' },
    { type: 'action-call', name: 'get_current_view_state', arguments: {} },
    {
      type: 'action-result',
      name: 'get_current_view_state',
      result: {
        ok: true,
        schedule: 'silent',
        display: { title: 'View state' },
      },
    },
  ]);
  assert.equal(
    voiceCardView(lookup).result.visible,
    false,
    'a silent lookup does not take the result card',
  );
  const dismissed = reduceVoiceCard(lookup, { type: 'dismiss' });
  assert.equal(voiceCardView(dismissed).visible, false);
  const stillDismissed = reduceVoiceCard(dismissed, {
    type: 'transcript',
    role: 'assistant',
    text: 'Hi',
    final: true,
  });
  assert.equal(
    voiceCardView(stillDismissed).visible,
    false,
    'dismissed until the next turn',
  );
  assert.equal(
    voiceCardView(reduceVoiceCard(stillDismissed, { type: 'interruption' }))
      .visible,
    true,
  );
  assert.deepEqual(
    reduceVoiceCard(lookup, { type: 'state', state: 'idle' }),
    initialVoiceCardState(),
  );
  assert.equal(
    reduceVoiceCard(lookup, { type: 'turn-metrics' }),
    lookup,
    'unrelated events are no-ops',
  );
});

test('markup: the card nests inside the voice control with every element and a polite live region', async (t) => {
  const { pinia } = mountVoiceView(t);
  for (const panel of [false, true]) {
    const ui = createTestVoiceUi({ panel, pinia });
    await nextTick();
    const card = document.getElementById('gev-voice-card');
    assert.equal(
      document.getElementById('gev-voice-control').contains(card),
      true,
      'the card is part of the voice control',
    );
    assert.equal(document.querySelectorAll('#gev-voice-card').length, 1);
    if (panel)
      assert.equal(card.parentElement.id, 'gev-voice-preview-panel');
    for (const id of [
      'gev-voice-card-phase',
      'gev-voice-card-dismiss',
      'gev-voice-card-user-text',
      'gev-voice-card-user-who',
      'gev-voice-card-assistant-text',
      'gev-voice-card-plan',
      'gev-voice-card-result-title',
      'gev-voice-card-chips',
      'gev-voice-card-lines',
      'gev-voice-card-referents',
      'gev-voice-card-note-list',
    ])
      assert.equal(card.contains(document.getElementById(id)), true, id);
    assert.equal(
      document.getElementById('gev-voice-card-live').getAttribute('aria-live'),
      'polite',
    );
    assert.equal(
      document
        .getElementById('gev-voice-card-dismiss')
        .getAttribute('aria-label'),
      'Dismiss voice card',
    );
    ui.remove();
  }
  assert.match(css, /#gev-voice-control \.gev-voice-card \{/);
  assert.match(
    css,
    /body\.recording-mode #gev-voice-control/,
    'recording mode hides the control, card included',
  );
  assert.match(
    css,
    /body\.ui-clean-view #command-dock/,
    'Clean-UI hides the dock, card included',
  );
});

// A real control whose listeners are counted, so a test sees teardown
// release them.
function countedUi(options) {
  const ui = createTestVoiceUi(options);
  const on = ui.on;
  const live = new Set();
  ui.on = (name, listener) => {
    const entry = { name };
    live.add(entry);
    const off = on(name, listener);
    return () => {
      live.delete(entry);
      off();
    };
  };
  return { ui, listenerCount: () => live.size };
}

test('controls: render, idle hide, dismiss and idempotent teardown', () => {
  const { ui, listenerCount } = countedUi();
  const shown = () => ui.state.card.visible;
  const timers = new Map();
  let nextId = 1;
  const card = new VoiceCardControls({
    ui,
    idleMs: 1000,
    setTimer: (fn) => {
      const id = nextId++;
      timers.set(id, () => {
        timers.delete(id);
        fn();
      });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  assert.equal(shown(), false, 'starts hidden');
  card.handle({ type: 'interruption' });
  card.handle({
    type: 'action-call',
    name: 'fly_to_location',
    arguments: { query: 'Tokyo' },
  });
  card.handle({
    type: 'action-result',
    name: 'fly_to_location',
    result: {
      ok: true,
      display: { title: 'Tokyo', lines: [], chips: [{ label: 'stale' }] },
    },
  });
  assert.equal(shown(), true);
  assert.equal(ui.state.card.result.title, 'Tokyo');
  assert.equal(ui.state.card.steps.length, 1);
  assert.equal(ui.state.card.result.chips[0], 'stale');
  assert.equal(timers.size, 1, 'one idle timer at a time');
  [...timers.values()][0]();
  assert.equal(shown(), false, 'hides when idle');
  card.handle({ type: 'interruption' });
  ui.emit('card-dismiss');
  assert.equal(shown(), false, 'dismiss hides it');
  card.destroy();
  card.destroy();
  assert.equal(timers.size, 0);
  assert.equal(listenerCount(), 0);
  card.handle({ type: 'interruption' });
  assert.equal(shown(), false, 'a destroyed card ignores late events');
});

test('controls: card controls without a voice control are inert', () => {
  const card = new VoiceCardControls({});
  assert.doesNotThrow(() => card.handle({ type: 'interruption' }));
  card.destroy();
});

test('presentation: concurrent calls of one tool update their own steps', () => {
  const state = fold([
    { type: 'interruption' },
    {
      type: 'action-call',
      name: 'fly_to_location',
      callId: 'c1',
      arguments: { query: 'Tokyo' },
    },
    {
      type: 'action-call',
      name: 'fly_to_location',
      callId: 'c2',
      arguments: { query: 'Paris' },
    },
    // Out of order: the first call finishes last.
    {
      type: 'action-result',
      name: 'fly_to_location',
      callId: 'c2',
      result: { ok: false, error: 'x' },
    },
    {
      type: 'progress',
      name: 'fly_to_location',
      callId: 'c1',
      step: 'search',
      label: 'Tokyo',
    },
  ]);
  const steps = voiceCardView(state).steps;
  assert.deepEqual(
    steps.map(({ label, status }) => [label, status]),
    [
      ['Fly to Tokyo', 'running'],
      ['Fly to Paris', 'failed'],
    ],
  );
  assert.equal(steps[0].detail, 'Looking up place: Tokyo');
});

test('presentation: stale and unmatched events never reopen the card', () => {
  const ended = fold([
    { type: 'interruption' },
    { type: 'action-call', name: 'annotate_map', callId: 'c1', arguments: {} },
    {
      type: 'action-result',
      name: 'annotate_map',
      callId: 'c1',
      result: {
        ok: true,
        outlinePending: true,
        items: [{ ok: true, id: 'anno-9', outlinePending: true }],
      },
    },
    { type: 'state', state: 'idle' },
  ]);
  for (const late of [
    { type: 'outline', id: 'anno-9', status: 'resolved' },
    { type: 'outline', status: 'resolved' },
    { type: 'progress', name: 'annotate_map', callId: 'c1', step: 'resolve' },
    {
      type: 'action-result',
      name: 'annotate_map',
      callId: 'c1',
      result: { ok: true, display: { title: 'Marked 1 place' } },
    },
  ]) {
    assert.equal(
      reduceVoiceCard(ended, late),
      ended,
      `${late.type} after stop is a no-op`,
    );
  }
  const live = fold([
    { type: 'interruption' },
    { type: 'action-call', name: 'annotate_map', callId: 'c1', arguments: {} },
    {
      type: 'action-result',
      name: 'annotate_map',
      callId: 'c1',
      result: {
        ok: true,
        outlinePending: true,
        items: [
          { ok: true, id: 'anno-1', outlinePending: true },
          { ok: true, id: 'anno-2', outlinePending: true },
        ],
      },
    },
    { type: 'dismiss' },
  ]);
  assert.equal(
    reduceVoiceCard(live, {
      type: 'outline',
      id: 'anno-7',
      status: 'resolved',
    }),
    live,
    'another mark is ignored',
  );
  const first = reduceVoiceCard(live, {
    type: 'outline',
    id: 'anno-1',
    status: 'resolved',
  });
  assert.equal(
    voiceCardView(first).steps[0].detail,
    'Tracing outline',
    'one of two outlines still pending',
  );
  assert.equal(
    voiceCardView(first).visible,
    false,
    'a dismissed card stays hidden',
  );
  const both = reduceVoiceCard(first, {
    type: 'outline',
    id: 'anno-2',
    status: 'failed',
  });
  assert.equal(voiceCardView(both).steps[0].detail, 'Outline unavailable');
});

test('presentation controls preserve real reducer content and the existing 14-second idle deadline', () => {
  const ui = createTestVoiceUi();
  const timers = new Map();
  let next = 0,
    renders = 0;
  const card = new VoiceCardControls({
    ui,
    setTimer(fn, ms) {
      const id = ++next;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    onRender() {
      renders++;
    },
  });
  card.handle({ type: 'interruption' });
  card.handle({
    type: 'transcript',
    role: 'assistant',
    text: 'A current answer',
    final: true,
    responseId: 'r1',
  });
  const content = card.state;
  const timer = [...timers.keys()][0];
  assert.equal(timers.get(timer).ms, 14000);
  card.setPresented(false);
  assert.equal(card.snapshot().visible, false);
  assert.equal(ui.state.card.announce, '');
  card.setPresented(true);
  assert.equal(card.snapshot().visible, true);
  assert.equal(card.snapshot().assistant.text, 'A current answer');
  assert.equal(
    card.snapshot().announce,
    '',
    'returning to a tab does not repeat an already presented announcement',
  );
  assert.equal(card.state, content);
  assert.equal(
    [...timers.keys()][0],
    timer,
    'presentation switches do not reset idle',
  );
  card.setEnabled(false);
  card.handle({
    type: 'transcript',
    role: 'assistant',
    text: 'A later answer',
    final: true,
    responseId: 'r2',
  });
  assert.equal(card.snapshot().visible, false);
  card.setEnabled(true);
  assert.equal(card.snapshot().assistant.text, 'A later answer');
  assert.equal(card.snapshot().announce, 'A later answer');
  assert.ok(renders > 4);
  const idle = [...timers.values()][0];
  idle.fn();
  assert.equal(
    card.snapshot().visible,
    false,
    'original idle still ends content presentation',
  );
  card.destroy();
  const lastRenders = renders;
  card.setPresented(false);
  card.setEnabled(false);
  assert.equal(renders, lastRenders);
});

test('a new hidden reply with identical words is still a fresh announcement', () => {
  const ui = createTestVoiceUi();
  const card = new VoiceCardControls({
    ui,
    setTimer: () => 1,
    clearTimer() {},
  });
  card.handle({ type: 'interruption' });
  card.handle({
    type: 'transcript',
    role: 'assistant',
    text: 'Same words',
    final: true,
    responseId: 'r1',
  });
  card.setPresented(false);
  card.handle({
    type: 'transcript',
    role: 'assistant',
    text: 'Same words',
    final: true,
    responseId: 'r2',
  });
  card.setPresented(true);
  assert.equal(card.snapshot().announce, 'Same words');
  card.destroy();
});

test('additive presentation gates retain the current localized reducer labels', () => {
  const previous = getLocale();
  try {
    setLocale('es');
    const ui = createTestVoiceUi();
    const card = new VoiceCardControls({
      ui,
      setTimer: () => 1,
      clearTimer() {},
    });
    card.handle({ type: 'interruption' });
    card.handle({
      type: 'action-call',
      name: 'annotate_map',
      callId: 'a',
      arguments: {},
    });
    assert.equal(card.snapshot().phase, 'EN CURSO');
    const steps = card.state.steps;
    const result = card.state.result;
    const who = () => ui.state.card.user.label;
    card.handle({ type: 'transcript', role: 'user', text: 'Same words', attribution: 'unverified' });
    assert.equal(card.state.userAttribution, 'unverified');
    assert.equal(card.snapshot().user.label, 'Habla reciente');
    assert.equal(who(), 'Habla reciente');
    card.handle({ type: 'transcript', role: 'user', text: 'Same words' });
    assert.equal(card.state.userAttribution, null);
    assert.equal(card.snapshot().user.label, 'TÚ');
    assert.equal(who(), 'TÚ');
    assert.equal(card.state.steps, steps);
    assert.equal(card.state.result, result);

    card.setPresented(false);
    card.setPresented(true);
    assert.equal(card.snapshot().phase, 'EN CURSO');
    card.setEnabled(false);
    card.setEnabled(true);
    assert.equal(card.snapshot().phase, 'EN CURSO');
    card.destroy();
  } finally {
    setLocale(previous);
  }
});

test('manual panel and preference compose with the actual card without changing voice content or enabling Preview', async () => {
  const { createManualVoicePanel } = await import('./panel/manualPanel.js');
  const { createVoicePreferences, bindPreferenceControls } =
    await import('./panel/preferences.js');
  const ui = createTestVoiceUi({ panel: true });
  let panel;
  const card = new VoiceCardControls({
    ui,
    setTimer: () => 1,
    clearTimer() {},
    onRender: () => panel?.sync(),
  });
  const preference = createVoicePreferences({ storage: null });
  const fields = bindPreferenceControls({
    ui,
    preferences: preference,
    copy: {
      previewNote: 'Mostrar respuestas.',
      timeoutNote: '',
      notSaved: 'No guardado.',
    },
    onChange: (state) => {
      card.setEnabled(state.previewEnabled);
      panel?.sync();
    },
  });
  card.setEnabled(preference.snapshot().previewEnabled);
  panel = createManualVoicePanel({
    ui,
    card,
    getPreviewEnabled: () => preference.snapshot().previewEnabled,
    copy: { previewEmpty: 'Sin respuesta.', previewDisabled: 'Desactivada.' },
  });
  card.handle({ type: 'interruption' });
  card.handle({
    type: 'transcript',
    role: 'assistant',
    text: 'Actual current answer',
    final: true,
  });
  const content = card.state;
  assert.equal(
    card.snapshot().visible,
    false,
    'manual panel stays closed despite content',
  );
  panel.select('preview');
  assert.equal(card.snapshot().assistant.text, 'Actual current answer');
  assert.equal(card.snapshot().visible, true);
  preference.setPreviewEnabled(false);
  assert.equal(card.snapshot().visible, false);
  assert.equal(ui.state.previewEmpty.text, 'Desactivada.');
  panel.select('settings');
  panel.select('preview');
  assert.equal(preference.snapshot().previewEnabled, false);
  assert.equal(card.snapshot().visible, false);
  assert.equal(card.state, content);
  fields.dispose();
  panel.destroy();
  card.destroy();
});
