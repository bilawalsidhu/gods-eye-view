// engine.remove(ids): take specific marks off the board without clearing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnnotationEngine } from './annotationEngine.js';
import {
  getRenderGovernorDiagnostics,
  _resetRenderGovernorForTest,
} from '../renderGovernor.js';

function harness(t) {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  _resetRenderGovernorForTest();
  const removed = [];
  let syncs = 0;
  const renderer = {
    add() {},
    update() {},
    remove(anno) {
      removed.push(anno.id);
    },
    sync() {
      syncs += 1;
    },
    destroy() {},
  };
  const engine = createAnnotationEngine({ viewer: {}, renderer });
  t.after(() => {
    engine.destroy();
    _resetRenderGovernorForTest();
    if (originalRequest === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequest;
    if (originalCancel === undefined) delete globalThis.cancelAnimationFrame;
    else globalThis.cancelAnimationFrame = originalCancel;
  });
  return { engine, removed, syncCount: () => syncs };
}

const line = (offset, label) => ({
  type: 'route',
  manual: true,
  path: [
    [offset, 10],
    [offset + 0.1, 10.1],
  ],
  label,
});

const holdsAnnotations = () =>
  getRenderGovernorDiagnostics().holds.includes('annotations');

test('remove takes the named marks and leaves the others on the board', async (t) => {
  const { engine, removed } = harness(t);
  const { ids } = await engine.annotate([
    line(1, 'A'),
    line(2, 'B'),
    line(3, 'C'),
  ]);
  assert.equal(ids.length, 3);

  assert.equal(engine.remove([ids[0], ids[2]]), 2);
  assert.deepEqual(removed, [ids[0], ids[2]]);
  assert.deepEqual(
    engine.list().map((anno) => anno.id),
    [ids[1]],
  );
});

test('a single id is accepted, and unknown or repeated ids are ignored', async (t) => {
  const { engine, syncCount } = harness(t);
  const { ids } = await engine.annotate([line(1, 'A')]);

  const before = syncCount();
  assert.equal(engine.remove('anno-does-not-exist'), 0);
  assert.equal(engine.remove([]), 0);
  assert.equal(
    syncCount(),
    before,
    'removing nothing does not touch the renderer',
  );

  assert.equal(engine.remove(ids[0]), 1);
  assert.equal(engine.remove([ids[0], ids[0]]), 0);
  assert.equal(engine.count(), 0);
});

test('removing the last mark releases the continuous-render hold', async (t) => {
  const { engine } = harness(t);
  const { ids } = await engine.annotate([line(1, 'A'), line(2, 'B')]);
  assert.ok(holdsAnnotations(), 'marks on the board hold the render loop');

  engine.remove(ids[0]);
  assert.ok(holdsAnnotations(), 'one mark left still holds it');
  engine.remove(ids[1]);
  assert.ok(!holdsAnnotations(), 'an empty board lets the scene idle');
});

test('remove does not supersede an annotate that is still resolving', async (t) => {
  const { engine } = harness(t);
  const { ids } = await engine.annotate([line(1, 'A')]);

  const pending = engine.annotate([line(5, 'Late')]);
  engine.remove(ids[0]);
  const result = await pending;

  assert.equal(
    result.drawn,
    1,
    'unlike clear(), remove() leaves other work alone',
  );
  assert.deepEqual(
    engine.list().map((anno) => anno.label.split(' — ')[0]),
    ['Late'],
  );
});

test('a removed mark can be put back', async (t) => {
  const { engine } = harness(t);
  const first = await engine.annotate([line(1, 'A')]);
  engine.remove(first.ids);
  const second = await engine.annotate([line(1, 'A')]);
  assert.equal(second.drawn, 1);
  assert.equal(engine.count(), 1);
  assert.notEqual(second.ids[0], first.ids[0]);
});

test('remove after destroy is a no-op', async (t) => {
  const { engine } = harness(t);
  const { ids } = await engine.annotate([line(1, 'A')]);
  engine.destroy();
  assert.equal(engine.remove(ids), 0);
});
