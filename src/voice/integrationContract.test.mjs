// Cross-feature voice contracts, driven through the real action runner:
// one result contract (engine fields → model payload → voice card), result-set
// ownership for follow-ups, conversation lifetime, and progress narration.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';
import { createNarrationScheduler } from './narration.js';
import { createVoiceCommands } from './sessionCommands.js';
import { harness, tick } from './voiceWorkflowHarness.mjs';
import { realtimeInstructions } from '../../server/providers/openai/instructions.js';
import { GEV_REALTIME_TOOLS } from '../../server/providers/openai/tools.js';
import { attachVoiceResult } from './speech.js';

/** Run one call and fold it through the real voice card. */
async function throughCard(runner, name, args, card = initialVoiceCardState()) {
  const callId = `call-${name}-${Math.random()}`;
  let state = reduceVoiceCard(card, { type: 'interruption' });
  state = reduceVoiceCard(state, {
    type: 'action-call',
    name,
    callId,
    arguments: args,
  });
  const result = await runner(name, args);
  state = reduceVoiceCard(state, {
    type: 'action-result',
    name,
    callId,
    result,
  });
  const shown = voiceCardView(state);
  return { result, view: shown.result, steps: shown.steps };
}

// ── 1. One result contract ────────────────────────────────────────────────

test('an analyst count reaches the model and the card with its scope and caveats', async () => {
  const { runner } = harness();
  const { result, view } = await throughCard(runner, 'analyst_query', {
    layers: ['flights'],
    scope: { kind: 'anywhere' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.complete, true, 'complete survives the projection');
  assert.equal(result.say, '3 aircraft anywhere in the loaded data.');
  assert.equal(view.visible, true, 'the card shows an analyst result');
  assert.equal(view.title, '3 aircraft anywhere in the loaded data');
  assert.ok(
    !view.lines.includes('anywhere in the loaded data'),
    'the scope is in the title, not repeated as a line',
  );
  assert.deepEqual(
    view.referents.map((r) => r.label),
    ['UAL1', 'DAL2', 'SWA3'],
  );
});

test('long analyst scope text is bounded identically for speech and card', () => {
  const result = attachVoiceResult('analyst_query', {
    ok: true,
    action: 'analyst_query',
    count: 12,
    complete: true,
    scopeLabel:
      'over the extraordinarily long alpine administrative research corridor with a deliberately verbose official name',
    coverage: { layersQueried: [{ layerKey: 'flights' }] },
  });
  const started = reduceVoiceCard(initialVoiceCardState(), {
    type: 'action-call',
    name: 'analyst_query',
    callId: 'long-scope',
    arguments: {},
  });
  const card = reduceVoiceCard(started, {
    type: 'action-result',
    name: 'analyst_query',
    callId: 'long-scope',
    result,
  });
  const title = voiceCardView(card).result.title;
  assert.equal(result.say, title);
  assert.ok(title.length <= 64);
  assert.match(title, /…$/);
});

test('a capped count is a floor everywhere: model, card and caveat', async () => {
  const rows = Array.from({ length: 250_001 }, (_, i) => ({
    id: `F${i}`,
    lat: 10,
    lon: 20,
  }));
  const flights = {
    getStats: () => ({ count: 400_000, lastUpdate: Date.now() }),
    getAnalystRecords: (max) => rows.slice(0, max),
  };
  const { runner } = harness({ flights });
  const { result, view } = await throughCard(runner, 'analyst_query', {
    layers: ['flights'],
    scope: { kind: 'anywhere' },
    limit: 1,
  });
  assert.equal(result.complete, false);
  assert.match(result.say, /^At least 250,000 aircraft/);
  assert.match(view.title, /^At least 250,000 aircraft/);
  assert.ok(
    view.notes.some((note) => /counted 250,000 of 400,000/.test(note)),
    'the cap is on screen',
  );
});

test('a partial answer names the layers it could not read', async () => {
  const { runner } = harness();
  const { result, view } = await throughCard(runner, 'analyst_query', {
    layers: ['flights', 'earthquakes'],
    scope: { kind: 'anywhere' },
  });
  assert.equal(result.partial, true);
  assert.match(result.say, /Partial; earthquakes not answered/);
  assert.deepEqual(result.unanswered, ['earthquakes']);
  assert.ok(view.chips.includes('partial'));
  assert.ok(view.notes.includes('Not answered: earthquakes'));
});

test('"the second one" is the second row the card lists', async () => {
  const { runner, referents } = harness();
  await runner('analyst_query', {
    layers: ['flights'],
    scope: { kind: 'anywhere' },
  });
  assert.equal(referents.get(2).label, 'DAL2');
  assert.equal(referents.get(-1).label, 'SWA3');
});

test('numbered and last referents are exactly the five rows the card displays', async () => {
  const flights = {
    getStats: () => ({ count: 6, lastUpdate: Date.now() }),
    getAnalystRecords: () =>
      Array.from({ length: 6 }, (_, index) => ({
        id: `F${index + 1}`,
        icao24: `f${index + 1}`,
        callsign: `CALL${index + 1}`,
        lat: 30,
        lon: -97,
      })),
  };
  const { runner, referents } = harness({ flights });
  const { view } = await throughCard(runner, 'analyst_query', {
    layers: ['flights'],
    scope: { kind: 'anywhere' },
    limit: 6,
  });
  assert.deepEqual(
    view.referents.map((entry) => entry.label),
    ['CALL1', 'CALL2', 'CALL3', 'CALL4', 'CALL5'],
  );
  assert.equal(referents.get(6), null);
  assert.equal(referents.get(-1)?.label, 'CALL5');
});

test('a follow-up naming other layers than the last answer is refused, not answered from it', async () => {
  const { runner } = harness();
  await runner('analyst_query', {
    layers: ['flights'],
    scope: { kind: 'anywhere' },
  });
  const mismatch = await runner('analyst_query', {
    layers: ['earthquakes'],
    followUp: true,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'FOLLOW_UP_MISMATCH');
  assert.match(mismatch.error, /flights, not earthquakes/);
});

// ── 2. Conversation lifetime ──────────────────────────────────────────────

test('a mic restart forgets the last answer and in-flight writes', async () => {
  const h = harness();
  await h.runner('analyst_query', {
    layers: ['flights'],
    scope: { kind: 'anywhere' },
  });
  // A query in flight when the session ends must not seed the new session.
  const late = h.runner('analyst_query', {
    layers: ['flights'],
    scope: { kind: 'anywhere' },
  });
  h.runner.resetConversation();
  await late;
  const followUp = await h.runner('analyst_query', {
    layers: ['flights'],
    followUp: true,
  });
  assert.equal(followUp.code, 'NO_RESULT_CONTEXT');
});

test('the voice controls reset the runner on stop and dispose it on removal', async () => {
  const previous = globalThis.window;
  globalThis.window = {};
  try {
    const h = harness();
    const button = new EventTarget();
    button.setAttribute = () => {};
    const ui = {
      button,
      root: { dataset: {}, remove() {} },
      status: {},
      detail: {},
    };
    const lifetime = new AbortController();
    let emitState;
    const controls = createVoiceCommands({
      runner: h.runner,
      signal: lifetime.signal,
      createControl: () => ui,
      createCard: () => null,
      createSession({ emit }) {
        emitState = (state) => emit({ type: 'state', state });
        return {
          async start() {
            emitState('listening');
          },
          stop() {
            emitState('idle');
          },
          sendText() {},
          sendMapEvent() {},
        };
      },
    });
    await controls.session.start();
    await h.runner('analyst_query', {
      layers: ['flights'],
      scope: { kind: 'anywhere' },
    });
    controls.session.stop();
    const after = await h.runner('analyst_query', {
      layers: ['flights'],
      followUp: true,
    });
    assert.equal(after.code, 'NO_RESULT_CONTEXT', 'stop cleared the memory');
    lifetime.abort();
    const removed = await h.runner('analyst_query', {
      layers: ['flights'],
      scope: { kind: 'anywhere' },
    });
    assert.equal(removed.cancelled, true, 'a disposed runner does nothing');
  } finally {
    globalThis.window = previous;
  }
});

// ── 3. Progress narration through the scheduler ───────────────────────────

function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    setTimer(fn, ms) {
      const timer = { fn, at: now + ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      if (timer) timer.done = true;
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = timers
          .filter((t) => !t.done && t.at <= until)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        next.done = true;
        next.fn();
      }
      now = until;
    },
  };
}

/**
 * Start one tool under the real scheduler, let its workflow report its
 * phases, and read what the scheduler says once the first line is due (the
 * tool is still counted as running, as a slow call would be).
 */
async function narrated(name, args, whileRunning = async () => {}, on) {
  const clock = fakeClock();
  const spoken = [];
  const scheduler = createNarrationScheduler({
    speak: (line) => spoken.push(line),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const h = harness(on ? { on } : {});
  scheduler.userTurnEnded();
  scheduler.toolStarted('c1', { name, label: 'x' });
  const pending = h.runner(name, args, {
    progress: (update) => scheduler.progress('c1', update),
  });
  await tick();
  await whileRunning(h);
  await pending;
  clock.advance(1600);
  scheduler.toolFinished('c1');
  return spoken;
}

test('a slow annotate_map call narrates its real phase', async () => {
  assert.deepEqual(
    await narrated('annotate_map', {
      annotations: [{ type: 'pin', target: 'Ferry Building' }],
    }),
    ['Finding Ferry Building on the map.'],
  );
});

// ── 4. One statement per policy ───────────────────────────────────────────

test('the cloud prompt states precedence and caveat speech once', () => {
  const lines = realtimeInstructions().split('\n');
  const starting = (prefix) => lines.filter((line) => line.startsWith(prefix));
  assert.equal(starting('WHERE,').length, 1, 'one precedence rule');
  const where = starting('WHERE,')[0];
  const order = [
    'a place the user names',
    'explicit pointing',
    'Contacts subject',
    'the current view',
  ];
  const at = order.map((phrase) => where.indexOf(phrase));
  assert.ok(
    at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1])),
    'named → pointing → Contacts/selection → view',
  );
  const tools = JSON.stringify(GEV_REALTIME_TOOLS);
  // Caveat speech is one policy: lower bounds and partial answers are spoken.
  const caveatRules = lines.filter((line) => /caveat/i.test(line));
  assert.equal(caveatRules.length, 1, caveatRules.join('\n'));
  assert.match(
    caveatRules[0],
    /speak a caveat only when it changes the answer/,
  );
  assert.match(caveatRules[0], /Lower bounds \("at least 500"\)/);
  assert.doesNotMatch(tools, /mention display\.caveat/);
  assert.doesNotMatch(
    realtimeInstructions(),
    /"approximately"\/"roughly" for a tool number/,
  );
});
