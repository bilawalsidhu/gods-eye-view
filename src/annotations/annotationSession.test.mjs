import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnnotationEngine } from './annotationEngine.js';

const BUILDING = {
  lon: -97.74,
  lat: 30.27,
  ring: [
    [-97.741, 30.269],
    [-97.739, 30.269],
    [-97.739, 30.271],
    [-97.741, 30.269],
  ],
  footprintKind: 'building',
  label: 'Capitol',
};

function recordingRenderer(log, name) {
  return {
    add(anno) {
      log.push(`${name} add ${anno.label}`);
    },
    update() {},
    remove(anno) {
      log.push(`${name} remove ${anno.label}`);
    },
    sync() {},
    destroy() {
      log.push(`${name} destroy`);
    },
  };
}

function withAnimationFrames(t) {
  const saved = [
    globalThis.requestAnimationFrame,
    globalThis.cancelAnimationFrame,
  ];
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => {
    [globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = saved;
  });
}

test('the marks survive a globe leaving and are drawn again on the next one', async (t) => {
  withAnimationFrames(t);
  const log = [];
  const engine = createAnnotationEngine({
    globe: {},
    renderer: recordingRenderer(log, 'cesium'),
    resolveTarget: async () => ({ ...BUILDING }),
  });
  const result = await engine.annotate([
    { type: 'area', target: 'Capitol', label: 'Capitol' },
  ]);
  assert.equal(result.drawn, 1);
  assert.equal(engine.attached, true);

  engine.detachRenderer();
  assert.equal(engine.attached, false);
  assert.equal(engine.count(), 1, 'the board keeps its mark');
  assert.deepEqual(log.slice(-2), ['cesium remove Capitol', 'cesium destroy']);
  // No globe draws annotations here: a new one is refused, nothing is lost.
  const refused = await engine.annotate([{ type: 'pin', target: 'x' }]);
  assert.equal(refused.ok, false);
  assert.equal(engine.count(), 1);
  assert.equal(engine.frame(engine.list()[0].id), false);

  log.length = 0;
  engine.attachRenderer({
    engine: createFakeEngine(),
    renderer: recordingRenderer(log, 'next'),
  });
  assert.deepEqual(log, ['next add Capitol']);
  assert.equal(engine.attached, true);
  assert.equal(engine.count(), 1);
  engine.destroy();
  assert.ok(log.includes('next destroy'));
});

test('detaching twice and attaching over an attached globe release each drawing once', (t) => {
  withAnimationFrames(t);
  const log = [];
  const engine = createAnnotationEngine({
    globe: {},
    renderer: recordingRenderer(log, 'a'),
  });
  engine.detachRenderer();
  engine.detachRenderer();
  engine.attachRenderer({
    engine: createFakeEngine(),
    renderer: recordingRenderer(log, 'b'),
  });
  engine.attachRenderer({
    engine: createFakeEngine(),
    renderer: recordingRenderer(log, 'c'),
  });
  assert.deepEqual(log, ['a destroy', 'b destroy']);
  engine.destroy();
});
