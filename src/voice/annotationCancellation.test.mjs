// Production controller -> action runner -> annotation engine cancellation.
// Only transport, audio, lookup and renderer are stand-ins; no provider/network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, tick, deferred } from './geminiNativeHarness.mjs';
import { createGevActionRunner } from './gevActions.js';
import { createAnnotationEngine } from '../annotations/annotationEngine.js';
import { GevRealtimeController } from './gevRealtime.js';

function fixture(t, { progressive = false } = {}) {
  const oldRaf = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const trace = { adds: 0, updates: 0, frames: 0, signals: [], results: [] };
  const entered = deferred();
  const released = deferred();
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    camera: {
      moveEnd: { addEventListener() {} },
      flyToBoundingSphere() {
        trace.frames++;
      },
    },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
  };
  const engine = createAnnotationEngine({
    viewer,
    renderer: {
      add() {
        trace.adds++;
      },
      update() {
        trace.updates++;
      },
      remove() {},
      sync() {},
      destroy() {},
    },
    async resolveTarget({ signal }) {
      trace.signals.push(signal);
      const anchor = { lon: 10, lat: 20, height: 0, source: 'test' };
      if (progressive)
        return {
          ...anchor,
          resolveOutline: () => {
            entered.resolve();
            return released.promise;
          },
        };
      entered.resolve();
      // Ignore abort deliberately: cancelled work must settle before this lookup.
      await released.promise;
      return anchor;
    },
  });
  const runner = createGevActionRunner({ viewer, annotations: engine });
  const h = harness({
    async runAction(name, args, options) {
      const result = await runner(name, args, options);
      trace.results.push(result);
      return result;
    },
  });
  t.after(() => {
    h.c.stop();
    runner.dispose();
    engine.destroy();
    if (oldRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = oldRaf;
    if (oldCancel === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = oldCancel;
  });
  return { h, runner, engine, trace, entered, released };
}
const mark = (ws, id = 'annotation') =>
  ws.message({
    toolCall: {
      functionCalls: [
        {
          id,
          name: 'annotate_map',
          args: {
            annotations: [{ type: 'area', target: 'Deferred Place' }],
            flyTo: true,
          },
        },
      ],
    },
  });

for (const cancellation of [
  'Stop',
  'native interruption',
  'call cancellation',
]) {
  test(`annotation ${cancellation} aborts the real pending consumer and rejects late writes`, async (t) => {
    const f = fixture(t);
    await f.h.c.start();
    const ws = f.h.sockets[0];
    mark(ws);
    await f.entered.promise;
    if (cancellation === 'Stop') f.h.c.stop();
    else if (cancellation === 'native interruption')
      ws.message({ serverContent: { interrupted: true } });
    else ws.message({ toolCallCancellation: { ids: ['annotation'] } });
    assert.equal(f.trace.signals[0].aborted, true);
    await tick();
    assert.equal(
      f.trace.results[0]?.cancelled,
      true,
      'runner settles without waiting for lookup',
    );
    assert.equal(f.trace.results[0].ok, false);
    assert.equal(f.trace.results[0].drawn, 0);
    f.released.resolve();
    await tick();
    assert.equal(f.engine.count(), 0);
    assert.equal(f.trace.adds, 0);
    assert.equal(f.trace.frames, 0);
    assert.equal(
      ws.sent.flatMap((frame) => frame.toolResponse?.functionResponses || [])
        .length,
      0,
    );
  });
}

test('runner conversation replacement aborts annotation resources and admits a new manual owner', async (t) => {
  const f = fixture(t);
  const pending = f.runner('annotate_map', {
    annotations: [{ target: 'Deferred Place' }],
    flyTo: true,
  });
  await f.entered.promise;
  f.runner.resetConversation();
  assert.equal(f.trace.signals[0].aborted, true);
  assert.equal((await pending).cancelled, true);
  const manual = await f.engine.annotate([
    { type: 'pin', manual: true, longitude: 4, latitude: 5, label: 'Manual' },
  ]);
  assert.equal(manual.ok, true);
  f.released.resolve();
  await tick();
  assert.equal(f.engine.count(), 1);
  assert.equal(f.engine.list()[0].label, 'Manual');
  assert.equal(f.trace.frames, 0);
});

for (const cancellation of ['Stop', 'native interruption']) {
  test(`annotation outline after returned anchor remains owned through ${cancellation}`, async (t) => {
    const f = fixture(t, { progressive: true });
    await f.h.c.start();
    const ws = f.h.sockets[0];
    mark(ws);
    await f.entered.promise;
    await f.h.c.toolQueue;
    assert.equal(f.engine.count(), 1);
    assert.equal(
      f.trace.results[0].ok,
      true,
      'committed anchor was a truthful success',
    );
    const frames = f.trace.frames;
    if (cancellation === 'Stop') f.h.c.stop();
    else ws.message({ serverContent: { interrupted: true } });
    assert.equal(
      f.trace.signals[0].aborted,
      true,
      'completed tool still owns its deferred outline',
    );
    await tick();
    assert.equal(f.engine.list()[0].pendingOutline, false);
    f.released.resolve({
      ring: [
        [10, 20],
        [11, 20],
        [10, 21],
      ],
      footprintKind: 'area',
    });
    await tick();
    assert.equal(f.engine.count(), 1, 'Stop preserves the committed point');
    assert.equal(f.engine.list()[0].ring, null);
    assert.equal(f.trace.updates, 0);
    assert.equal(f.trace.frames, frames);
  });
}

// OpenAI shares the runner. A returned anchor's outline must outlive the tool
// call itself, yet still stop at the next input or session boundary.
function openAiFixture(t) {
  const oldRaf = globalThis.requestAnimationFrame;
  const oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const trace = { updates: 0, outlineEvents: [] };
  const entered = deferred();
  const released = deferred();
  const viewer = {
    clock: { onTick: { addEventListener: () => () => {} } },
    camera: { moveEnd: { addEventListener() {} }, flyToBoundingSphere() {} },
    scene: { canvas: { addEventListener() {}, removeEventListener() {} } },
  };
  const engine = createAnnotationEngine({
    viewer,
    renderer: {
      add() {},
      update() {
        trace.updates++;
      },
      remove() {},
      sync() {},
      destroy() {},
    },
    async resolveTarget() {
      return {
        lon: 10,
        lat: 20,
        height: 0,
        source: 'test',
        resolveOutline: () => {
          entered.resolve();
          return released.promise;
        },
      };
    },
  });
  engine.onOutlineEvent((event) => trace.outlineEvents.push(event));
  const runner = createGevActionRunner({ viewer, annotations: engine });
  const controller = new GevRealtimeController({ ui: {}, runner });
  controller.dc = { readyState: 'open' };
  controller.sendRealtimeEvent = () => true;
  controller.debugLog = () => {};
  controller.cancelRadioHandoff = () => {};
  controller.setStatus = () => {};
  controller.setVoiceSpeaker = () => {};
  controller.recordUsage = () => {};
  controller.captureViewportScreenshot = async () => null;
  t.after(() => {
    runner.dispose();
    engine.destroy();
    if (oldRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = oldRaf;
    if (oldCancel === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = oldCancel;
  });
  return { controller, engine, trace, entered, released };
}
async function openAiMark(controller) {
  for (const payload of [
    { type: 'input_audio_buffer.speech_started', item_id: 'input-1' },
    {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'input-1',
      transcript: 'Outline Deferred Place',
    },
    { type: 'input_audio_buffer.committed', item_id: 'input-1' },
    { type: 'response.created', response: { id: 'resp_1' } },
    {
      type: 'response.function_call_arguments.done',
      response_id: 'resp_1',
      call_id: 'call_1',
      name: 'annotate_map',
      arguments: JSON.stringify({
        annotations: [{ type: 'area', target: 'Deferred Place' }],
      }),
    },
  ])
    await controller.handleRealtimeEvent({ data: JSON.stringify(payload) });
}
for (const boundary of [null, 'abortTools']) {
  test(`OpenAI outline after returned anchor ${boundary ? 'stops at the next input boundary' : 'applies when nothing cancels it'}`, async (t) => {
    const f = openAiFixture(t);
    await openAiMark(f.controller);
    assert.equal(f.engine.count(), 1, 'anchor committed');
    await f.entered.promise;
    assert.equal(
      f.engine.list()[0].pendingOutline,
      true,
      'outline outlives the tool call',
    );
    if (boundary) f.controller._turns.abortTools();
    f.released.resolve({
      ring: [
        [10, 20],
        [11, 20],
        [10, 21],
      ],
      footprintKind: 'area',
    });
    await tick();
    await tick();
    assert.equal(f.engine.count(), 1, 'the committed point survives');
    if (boundary) {
      assert.equal(f.engine.list()[0].ring, null);
      assert.equal(f.trace.updates, 0);
    } else {
      assert.ok(
        f.engine.list()[0].ring,
        'the outline upgrades the committed mark',
      );
      assert.equal(f.trace.outlineEvents.length, 1);
    }
  });
}
