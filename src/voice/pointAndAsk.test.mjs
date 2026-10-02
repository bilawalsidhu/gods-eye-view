import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { GevRealtimeController } from './realtimeController.js';
import {
  POINTER_OPEN_MIC_RECENT_MS,
  buildPointerSnapshot,
} from './pointerContext.js';
import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';
import { realtimeInstructions } from '../../server/providers/openai/instructions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';

const aircraftSnapshot = buildPointerSnapshot({
  at: 'speech_start',
  x: 600,
  y: 200,
  width: 1000,
  height: 500,
  pick: {
    entity: {
      layerId: 'flights',
      id: 'a1b2c3',
      label: 'UPS793',
      kind: 'aircraft',
      lat: 30.2,
      lon: -97.7,
    },
    ground: { lat: 30.19, lon: -97.71 },
  },
});

function fakePointer(snapshots, { held = false } = {}) {
  const calls = [];
  let active = null;
  const pointer = {
    calls,
    held,
    beginTurn(at, options) {
      calls.push([at, options?.recentMs ?? null]);
      const snapshot = snapshots.shift() ?? { fresh: false, at };
      active = snapshot.fresh ? snapshot : null;
      return snapshot;
    },
    activeSnapshot: () => active,
    isHeld: () => pointer.held,
    hold: () => null,
    releaseHold() {
      pointer.held = false;
    },
    clear(options) {
      calls.push(['clear', options]);
      active = null;
    },
  };
  return pointer;
}

function controllerFixture(pointer, { pushToTalk = false } = {}) {
  const sent = [];
  const events = [];
  const controller = new GevRealtimeController({
    ui: {
      root: {
        dataset: {},
        classList: { remove() {} },
        querySelectorAll: () => [],
      },
      status: { textContent: '' },
      detail: { textContent: '', title: '' },
      errorDetail: { textContent: '' },
    },
    runner: async () => ({ ok: true }),
    debugSink: null,
    pointer,
    onSessionEvent: (event) => events.push(event),
  });
  controller.dc = {
    readyState: 'open',
    send: (body) => sent.push(JSON.parse(body)),
    close() {},
  };
  controller._input.pushToTalkMode = pushToTalk;
  const event = (payload) =>
    controller.handleRealtimeEvent({ data: JSON.stringify(payload) });
  const items = () =>
    sent
      .filter(
        (m) =>
          m.type === 'conversation.item.create' && m.item.role === 'system',
      )
      .map((m) => JSON.parse(m.item.content[0].text));
  return { controller, sent, events, event, items };
}

test('push-to-talk: the held gesture sends the target once, with the chip after the card resets', async () => {
  const pointer = fakePointer([aircraftSnapshot, aircraftSnapshot], {
    held: true,
  });
  const { controller, sent, events, event, items } = controllerFixture(
    pointer,
    { pushToTalk: true },
  );
  controller.beginPointerTurn('keydown');
  await event({ type: 'input_audio_buffer.speech_started' });
  assert.deepEqual(
    pointer.calls.map(([at]) => at),
    ['keydown', 'speech_start'],
  );
  assert.equal(
    pointer.calls[0][1],
    null,
    'a gesture uses the normal freshness window',
  );
  assert.equal(items().length, 1, 'keydown and speech start share one item');
  assert.deepEqual(items()[0].target, {
    kind: 'aircraft',
    layer: 'flights',
    label: 'UPS793',
  });
  assert.equal(
    sent.some((m) => m.type === 'response.create'),
    false,
    'context never asks for a reply',
  );
  const order = events.map((e) => e.type);
  assert.ok(
    order.lastIndexOf('interruption') < order.lastIndexOf('pointer'),
    'the chip lands after the card resets',
  );
  assert.deepEqual(events.filter((e) => e.type === 'pointer').at(-1).pointer, {
    kind: 'this',
    label: 'UPS793',
    screenPx: { x: 600, y: 200 },
  });
});

test('push-to-talk: a speech start after the release keeps the gesture referent', async () => {
  const pointer = fakePointer([aircraftSnapshot], { held: true });
  const { controller, items, event } = controllerFixture(pointer, {
    pushToTalk: true,
  });
  controller.beginPointerTurn('keydown');
  pointer.releaseHold();
  await event({ type: 'input_audio_buffer.speech_started' });
  assert.equal(
    pointer.calls.length,
    1,
    'no new pointer read after the gesture ended',
  );
  assert.equal(pointer.activeSnapshot(), aircraftSnapshot);
  assert.equal(items().length, 1);
});

test('open mic: only a recent pointer counts, and the model learns only that one exists', async () => {
  const pointer = fakePointer([aircraftSnapshot]);
  const { events, event, items } = controllerFixture(pointer);
  await event({ type: 'input_audio_buffer.speech_started' });
  assert.equal(
    pointer.calls[0][1],
    POINTER_OPEN_MIC_RECENT_MS,
    'open mic asks for a recent pointer',
  );
  assert.deepEqual(
    items(),
    [{ type: 'pointer_context', at: 'speech_start', pointing: 'aircraft' }],
    'no label or coordinates',
  );
  assert.equal(
    events.filter((e) => e.type === 'pointer').at(-1).pointer,
    null,
    'no reticle or chip until a tool uses it',
  );
});

test('open mic: the chip and reticle appear when a tool resolves the pointer, once', async () => {
  const pointer = fakePointer([aircraftSnapshot]);
  const { controller, events, event } = controllerFixture(pointer);
  await event({ type: 'input_audio_buffer.speech_started' });
  assert.equal(controller.announcePointer(), true);
  assert.equal(controller.announcePointer(), false);
  assert.equal(
    events.filter((e) => e.type === 'pointer').at(-1).pointer.label,
    'UPS793',
  );
});

test('losing the pointer tells the model once, then a new pointer is sent again', async () => {
  const pointer = fakePointer(
    [aircraftSnapshot, { fresh: false }, { fresh: false }, aircraftSnapshot],
    { held: true },
  );
  const { controller, events, items } = controllerFixture(pointer, {
    pushToTalk: true,
  });
  controller.beginPointerTurn('keydown');
  controller.beginPointerTurn('keydown');
  controller.beginPointerTurn('keydown');
  controller.beginPointerTurn('keydown');
  assert.deepEqual(
    items().map((item) => item.target?.label || item.target),
    ['UPS793', 'none', 'UPS793'],
    'one clearing item, and the dedupe resets after it',
  );
  assert.equal(events.filter((e) => e.type === 'pointer')[1].pointer, null);
});

test('an unchanged pointer is not re-sent on the next utterance', async () => {
  const again = { ...aircraftSnapshot };
  const moved = { ...aircraftSnapshot, lat: 30.3, lon: -97.6 };
  const pointer = fakePointer([aircraftSnapshot, again, moved], { held: true });
  const { controller, events, items } = controllerFixture(pointer, {
    pushToTalk: true,
  });
  controller.beginPointerTurn('keydown');
  controller.beginPointerTurn('keydown');
  assert.equal(items().length, 1);
  assert.equal(
    events.filter((e) => e.type === 'pointer' && e.pointer).length,
    2,
    'the chip still shows every turn',
  );
  controller.beginPointerTurn('keydown');
  assert.equal(items().length, 2, 'a moved pointer is sent');
});

test('typed turns read the pointer themselves, before the text; stop clears it but keeps a starting hold', () => {
  const pointer = fakePointer([aircraftSnapshot], { held: true });
  const { controller, sent } = controllerFixture(pointer, { pushToTalk: true });
  controller.sendTextCommand('tell me about this');
  assert.deepEqual(pointer.calls[0], ['text', POINTER_OPEN_MIC_RECENT_MS]);
  const created = sent.filter((m) => m.type === 'conversation.item.create');
  assert.equal(created[0].item.role, 'system');
  assert.equal(created[1].item.role, 'user');
  controller._input.pushToTalkKeyHeld = true;
  controller.stop({ preserveStatus: true });
  assert.deepEqual(pointer.calls.at(-1), ['clear', { keepHold: true }]);
});

test('a claimed Space release or blur ends the pointer gesture', () => {
  const pointer = fakePointer([], { held: true });
  const { controller } = controllerFixture(pointer, { pushToTalk: true });
  controller._input.pushToTalkKeyHeld = true;
  controller._input.releasePushToTalkKey();
  assert.equal(pointer.held, false, 'released with the key');
  pointer.held = true;
  controller._input.releasePushToTalkKey();
  assert.equal(
    pointer.held,
    false,
    'blur takes the same path even when unclaimed',
  );
});

test('card: the chip says what "this" or "here" resolved to and resets per turn', () => {
  let state = [
    { type: 'interruption' },
    {
      type: 'pointer',
      pointer: { kind: 'this', label: 'UPS793', screenPx: { x: 1, y: 1 } },
    },
  ].reduce(reduceVoiceCard, initialVoiceCardState());
  let view = voiceCardView(state);
  assert.equal(view.visible, true);
  assert.deepEqual(view.pointer, {
    visible: true,
    kind: 'THIS',
    text: 'UPS793',
  });
  assert.equal(
    view.announce,
    'This: UPS793',
    'the live region says what "this" meant',
  );
  state = reduceVoiceCard(state, {
    type: 'pointer',
    pointer: { kind: 'here', label: '30.27, -97.74' },
  });
  assert.deepEqual(voiceCardView(state).pointer, {
    visible: true,
    kind: 'HERE',
    text: '30.27, -97.74',
  });
  assert.equal(
    voiceCardView(state).announce,
    'Here: 30.27, -97.74',
    'a changed target is announced',
  );
  state = reduceVoiceCard(state, { type: 'interruption' });
  assert.equal(
    voiceCardView(state).pointer.visible,
    false,
    'a new turn starts without a referent',
  );
  const unchanged = reduceVoiceCard(state, { type: 'pointer', pointer: null });
  assert.equal(unchanged, state, 'a stale pointer on an empty chip is a no-op');
});

test('markup: the chip sits under the user caption with a screen-reader separator', () => {
  const control = readFileSync(
    new URL('./control.js', import.meta.url),
    'utf8',
  );
  const user = control.indexOf('id="gev-voice-card-user"');
  const chip = control.indexOf('id="gev-voice-card-pointer"');
  const assistant = control.indexOf('id="gev-voice-card-assistant"');
  assert.ok(user < chip && chip < assistant);
  assert.match(
    control,
    /id="gev-voice-card-pointer" class="gev-voice-card-pointer" hidden/,
  );
  assert.match(control, /<span class="gev-voice-card-sr">: <\/span>/);
});

test('deixis prompt lint: one short rule, and every sentinel it names exists in the schema', () => {
  const instructions = realtimeInstructions();
  const rules = instructions
    .split('\n')
    .filter((line) => line.startsWith('POINTING:'));
  assert.equal(rules.length, 1, 'one deixis rule');
  assert.ok(
    rules[0].length <= 470,
    `deixis rule stays short (${rules[0].length} chars)`,
  );
  const tool = (name) =>
    GEV_REALTIME_TOOLS.find((t) => t.name === name).parameters.properties;
  assert.ok(tool('get_entity_context').scope.enum.includes('pointer'));
  assert.ok(
    tool('analyst_query').scope.properties.kind.enum.includes('pointer'),
  );
  for (const name of ['track_entity', 'fly_to_location', 'get_entity_context'])
    assert.equal(
      tool(name).referent.type,
      'integer',
      `${name} accepts referent:n`,
    );
  assert.match(tool('track_entity').query.description, /"pointer"/);
  assert.match(tool('fly_to_location').query.description, /"pointer"/);
  assert.match(
    tool('annotate_map').annotations.items.properties.target.description,
    /"pointer"/,
  );
  // Budget: the whole Realtime prompt (instructions + tools), measured in
  // characters. It was 56,308 after the area/imagery/OSM merge; stating each
  // policy once (WHERE precedence, AREAS routing, AFTER TOOLS speech) brought
  // it to 51,646. A new tool or rule has to fit under this ceiling.
  const size = instructions.length + JSON.stringify(GEV_REALTIME_TOOLS).length;
  assert.ok(size <= 52000, `prompt size ${size}`);
});
