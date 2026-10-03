// Cross-feature voice contracts, driven through the real action runner:
// one result contract (engine fields → model payload → voice card), shared
// pointing for imagery, result-set ownership between OSM and the analyst,
// imagery panel ownership, conversation lifetime, and progress narration.
//
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPointerSnapshot } from './pointerContext.js';
import {
  initialVoiceCardState,
  reduceVoiceCard,
  voiceCardView,
} from './voiceCardPresentation.js';
import { createNarrationScheduler } from './narration.js';
import { createVoiceCommands } from './sessionCommands.js';
import { candidate } from '../layers/recentImagery/testDoubles.mjs';
import { harness, tick } from './voiceWorkflowHarness.mjs';
import { realtimeInstructions } from '../../server/providers/openai/instructions.js';
import {
  GEV_REALTIME_TOOLS,
  realtimeTools,
} from '../../server/providers/openai/tools.js';
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

test('combined Contacts aircraft use one semantic noun on the model and card surfaces', async () => {
  const { runner } = harness();
  const { result, view } = await throughCard(runner, 'analyst_query', {
    layers: ['flights', 'military'],
    scope: { kind: 'anywhere' },
  });
  assert.match(result.say, / aircraft /);
  assert.doesNotMatch(result.say, / results /);
  assert.ok(
    result.say.startsWith(`${view.title}.`),
    'speech starts with the exact card headline before its partial-status sentence',
  );
});

test('an ambiguous region keeps its candidates through the runner and asks on the card', async () => {
  const { runner } = harness();
  const area = await throughCard(runner, 'resolve_area', {
    query: 'Punjab',
    draw: true,
  });
  assert.equal(area.result.needsClarification, true);
  assert.equal(area.result.candidates.length, 2);
  assert.equal(area.view.title, 'Which Punjab?');
  assert.equal(
    area.steps.at(-1).status,
    'done',
    'a question is not a failed step',
  );
  assert.deepEqual(area.view.lines, [
    '1 · Punjab — state or province, India',
    '2 · Punjab — state or province, Pakistan',
  ]);
  const count = await throughCard(runner, 'analyst_query', {
    layers: ['flights'],
    scope: { kind: 'region', name: 'Punjab' },
  });
  assert.equal(count.result.ok, false);
  assert.equal(
    count.result.needsClarification,
    true,
    'the refusal projection keeps the clarification',
  );
  assert.equal(count.result.candidates.length, 2);
  assert.equal(count.view.title, 'Which Punjab?');
});

test('an area count carries its areaId; an approximate outline says so on the card', async () => {
  const { runner } = harness();
  const kathmandu = await throughCard(runner, 'resolve_area', {
    query: 'Kathmandu',
  });
  assert.equal(kathmandu.view.title, 'Kathmandu');
  assert.ok(kathmandu.view.notes.includes('Source: OpenStreetMap'));
  const inside = await runner('analyst_query', {
    layers: ['flights'],
    scope: { kind: 'area', areaId: kathmandu.result.areaId },
  });
  assert.equal(inside.areaId, kathmandu.result.areaId);
  const around = await throughCard(runner, 'resolve_area', {
    query: 'Ferry Building',
    around: true,
  });
  assert.equal(around.result.approximate, true);
  assert.ok(around.view.chips.includes('approximate'));
  assert.ok(around.view.lines.includes('250 m around the landmark'));
});

test('imagery shows the chosen day, the catalog window and its cap on the card', async () => {
  const h = harness();
  const pending = throughCard(h.runner, 'find_imagery', {});
  await tick();
  h.imagery.catalog.searches.at(-1).resolve({
    candidates: [
      candidate('S30', '2026-09-18', 3),
      candidate('L30', '2026-09-10', 60),
    ],
    truncated: true,
    errors: [],
  });
  const { result, view } = await pending;
  assert.equal(result.ok, true);
  assert.equal(view.title, 'Sentinel-2 · 2026-09-18');
  assert.ok(view.lines.includes('The catalog covers the last 30 days'));
  assert.ok(
    view.notes.some((note) => /Catalog truncated/.test(note)),
    'a capped catalog is not presented as complete',
  );
});

test('OSM places render as a card with numbered referents', async () => {
  const { runner } = harness();
  const { result, view } = await throughCard(runner, 'osm_query', {
    what: 'hospitals',
  });
  assert.equal(result.ok, true);
  assert.equal(view.title, '3 hospitals');
  assert.deepEqual(
    view.referents.map((r) => [r.n, r.label]),
    [
      [1, 'Bir Hospital'],
      [2, 'Military Hospital'],
      [3, 'unnamed hospital'],
    ],
  );
  assert.ok(view.notes.includes('Source: OpenStreetMap'));
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

// ── 2. Imagery pointing uses the turn snapshot ────────────────────────────

const groundAt = (lat, lon) =>
  buildPointerSnapshot({
    at: 'keydown',
    x: 100,
    y: 100,
    width: 800,
    height: 600,
    pick: { ground: { lat, lon } },
  });

test('imagery of "this spot" searches the turn snapshot, not the cursor now', async () => {
  const h = harness({ pointer: groundAt(10, 20) });
  const pending = h.runner('find_imagery', { area: 'pointer' });
  await tick();
  const box = h.imagery.layer.getSnapshot().box;
  assert.ok(
    Math.abs((box.west + box.east) / 2 - 20) < 0.01 &&
      Math.abs((box.south + box.north) / 2 - 10) < 0.01,
    `box centred on the snapshot (${JSON.stringify(box)})`,
  );
  h.imagery.catalog.resolveLast([candidate('S30', '2026-09-18', 3)]);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(result.resolvedFrom, { source: 'pointer', label: null });
});

test('imagery with no fresh pointer asks, and never searches the view instead', async () => {
  const h = harness({ pointer: null });
  const result = await h.runner('find_imagery', { area: 'pointer' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Nothing is under the pointer/);
  assert.equal(h.imagery.catalog.searches.length, 0);
  h.setPointer({ fresh: false, at: 'keydown' });
  const stale = await h.runner('find_imagery', { area: 'pointer' });
  assert.equal(stale.ok, false, 'a stale snapshot is not "here"');
});

// ── 3. Result-set ownership ───────────────────────────────────────────────

test('after a place search, "those" and "the second one" mean the places', async () => {
  const { runner, referents } = harness();
  await runner('analyst_query', {
    layers: ['flights'],
    scope: { kind: 'anywhere' },
  });
  assert.equal(referents.get(2).label, 'DAL2');
  await runner('osm_query', { what: 'hospitals' });
  assert.equal(
    referents.get(2).label,
    'Military Hospital',
    'the place list replaced the aircraft list',
  );
  const followUp = await runner('analyst_query', {
    layers: ['osm-places'],
    followUp: true,
    filters: [{ field: 'name', op: 'contains', value: 'Bir' }],
  });
  assert.equal(followUp.ok, true);
  assert.deepEqual(
    followUp.items.map((item) => item.name),
    ['Bir Hospital'],
    'the follow-up filtered the hospitals, not the old aircraft',
  );
  const fresh = await runner('analyst_query', {
    layers: ['osm-places'],
    scope: { kind: 'anywhere' },
  });
  assert.equal(fresh.count, 3, 'a fresh osm-places query reads the layer');
});

test('an empty place search clears the numbered list instead of keeping older rows', async () => {
  const h = harness({ osmHits: [] });
  await h.runner('analyst_query', {
    layers: ['flights'],
    scope: { kind: 'anywhere' },
  });
  assert.ok(h.referents.get(1));
  const none = await h.runner('osm_query', { what: 'hospitals' });
  assert.equal(none.count, 0);
  assert.equal(h.referents.get(1), null);
});

// ── 4. Imagery panel ownership ────────────────────────────────────────────

test('an operator pin chosen while the catalog loads is never overwritten', async () => {
  const h = harness();
  const { layer, catalog } = h.imagery;
  const pending = h.runner('find_imagery', {});
  await tick();
  const theirs = candidate('S30', '2026-09-19', 40);
  let taken = false;
  layer.subscribe((snap) => {
    if (taken || snap.searching || !snap.candidates.length) return;
    taken = true;
    layer.setAssignment('a', theirs.key); // same box, operator's pin
  });
  catalog.resolveLast([candidate('S30', '2026-09-20', 2), theirs]);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DISPLACED');
  assert.equal(layer.getSnapshot().pins.a.key, theirs.key, 'their pin stays');
});

test('a source or mode change by hand during the search also hands the panel back', async () => {
  for (const change of [
    (layer) => layer.setSources({ hls: true, viirs: true }),
    (layer) => layer.setMode('ab'),
  ]) {
    const h = harness();
    const pending = h.runner('find_imagery', {});
    await tick();
    change(h.imagery.layer);
    h.imagery.catalog.resolveLast([candidate('S30', '2026-09-20', 2)]);
    const result = await pending;
    assert.equal(result.code, 'DISPLACED');
    assert.equal(h.imagery.layer.getSnapshot().pins.a.key, null);
  }
});

// ── 5. Conversation lifetime ──────────────────────────────────────────────

test('a runner reset aborts its owned imagery search and a retry succeeds', async () => {
  const h = harness();
  const pending = h.runner('find_imagery', {});
  await tick();
  const firstSearch = h.imagery.catalog.searches.at(-1);
  assert.equal(firstSearch.request.signal.aborted, false);

  h.runner.resetConversation();
  const cancelled = await pending;
  assert.equal(firstSearch.request.signal.aborted, true);
  assert.equal(cancelled.code, 'CANCELLED');
  assert.equal(h.imagery.layer.getSnapshot().pins.a.key, null);

  const retry = h.runner('find_imagery', {});
  await tick();
  h.imagery.catalog.resolveLast([candidate('S30', '2026-09-20', 2)]);
  const recovered = await retry;
  assert.equal(recovered.ok, true);
  assert.equal(h.imagery.layer.getSnapshot().pins.a.key, 'S30:2026-09-20');
});

test('runner disposal aborts its owned OSM provider work without a late commit', async () => {
  let providerSignal;
  let resolveProvider;
  const h = harness({
    osmSearch: (_request, { signal }) => {
      providerSignal = signal;
      return new Promise((resolve) => {
        resolveProvider = resolve;
      });
    },
  });
  const pending = h.runner('osm_query', { what: 'hospitals' });
  await tick();
  assert.equal(providerSignal.aborted, false);

  h.runner.dispose();
  assert.equal(providerSignal.aborted, true);
  resolveProvider({
    ok: true,
    mode: 'features',
    features: [
      { id: 'node/late', lat: 27.7, lon: 85.31, tags: { name: 'Late' } },
    ],
    truncated: false,
  });
  const cancelled = await pending;
  assert.equal(cancelled.code, 'CANCELLED');
  assert.equal(h.referents.get(1), null);
});

test('a mic restart keeps area handles', async () => {
  const h = harness();
  const area = await h.runner('resolve_area', { query: 'Kathmandu' });
  // A place search in flight when the session ends must not seed the next.
  const late = h.runner('osm_query', { what: 'hospitals' });
  h.runner.resetConversation();
  await late;
  const followUp = await h.runner('analyst_query', {
    layers: ['osm-places'],
    followUp: true,
  });
  assert.equal(followUp.code, 'NO_RESULT_CONTEXT');
  const inside = await h.runner('analyst_query', {
    layers: ['flights'],
    scope: { kind: 'area', areaId: area.areaId },
  });
  assert.equal(inside.ok, true, 'the area handle outlives the mic session');
});

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

// ── 6. Progress narration through the scheduler ───────────────────────────

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

test('slow area, place and imagery calls narrate their real phase', async () => {
  assert.deepEqual(await narrated('resolve_area', { query: 'Kathmandu' }), [
    'Finding Kathmandu on the map.',
  ]);
  assert.deepEqual(
    await narrated('resolve_area', { query: 'Kathmandu', draw: true }),
    ['Outlining Kathmandu.'],
  );
  const places = ['flights', 'osm-places'];
  assert.deepEqual(
    await narrated('osm_query', { what: 'hospitals' }, undefined, places),
    ['Searching OpenStreetMap for hospitals.'],
  );
  assert.deepEqual(
    await narrated('find_imagery', {}, async (h) => {
      await tick();
      h.imagery.catalog.resolveLast([candidate('S30', '2026-09-18', 3)]);
    }),
    ['Loading the image.'],
  );
});

// ── 7. One statement per policy ───────────────────────────────────────────

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

test('boundaries route to resolve_area; annotate_map is for marks', () => {
  const lines = realtimeInstructions().split('\n');
  const areas = lines.filter((line) => line.startsWith('AREAS:'));
  assert.equal(areas.length, 1);
  assert.match(areas[0], /annotate_map is for marks, not boundaries/);
  const whiteboard = lines.find((line) => line.startsWith('WHITEBOARD'));
  assert.doesNotMatch(whiteboard, /boundar/);
  assert.doesNotMatch(
    GEV_REALTIME_TOOLS.find((tool) => tool.name === 'annotate_map').description,
    /boundar/,
  );
});

test('without an operator Overpass the prompt never offers place search', () => {
  const plain = realtimeInstructions();
  assert.doesNotMatch(plain, /osm_query/);
  assert.equal(
    realtimeTools().some((tool) => tool.name === 'osm_query'),
    false,
  );
  assert.match(
    realtimeInstructions(undefined, { overpass: true }),
    /osm_query/,
  );
  assert.ok(
    realtimeTools({ overpass: true }).some((t) => t.name === 'osm_query'),
  );
});

test('the Realtime prompt stays within its size budget', () => {
  // Instructions plus tool schemas, in characters. The voice-core base was
  // 46,747; voice geometry adds resolve_area, find_imagery and the analyst
  // area scopes (osm_query only with an operator Overpass).
  const size = (overpass) =>
    realtimeInstructions(undefined, { overpass }).length +
    JSON.stringify(realtimeTools({ overpass })).length;
  assert.ok(size(false) <= 50_000, `default prompt ${size(false)} chars`);
  assert.ok(size(true) <= 51_000, `with Overpass ${size(true)} chars`);
});
