import '../testSupport/registerDom.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { attachNavaraAnnotations } from './navaraTools.js';

function fakeViews() {
  const meshes = [];
  class NavaraColor {
    setHex() {
      return this;
    }
    toArray() {
      return [1, 1, 1];
    }
    setRGBLinear() {
      return this;
    }
  }
  return {
    meshes,
    views: {
      view: {
        addMesh(config) {
          const mesh = { config, deleted: false };
          meshes.push(mesh);
          return {
            update() {},
            delete() {
              mesh.deleted = true;
            },
          };
        },
      },
      NavaraColor,
    },
  };
}

test('Navara attaches the page session board and its switch takes only the drawing', async () => {
  const lifetime = new AbortController();
  const layerSession = { lifetime };
  const engine = createFakeEngine({ kind: 'navara' });
  const { views, meshes } = fakeViews();
  const context = {
    layerSession,
    placeSearch: null,
    operations: { annotationResolver: null },
  };
  const attach = () => {
    const cleanups = [];
    const board = attachNavaraAnnotations({ engine, views }, context, {
      defer: (cleanup) => cleanups.push(cleanup),
    });
    return { board, detach: () => cleanups.reverse().forEach((c) => c()) };
  };
  const first = attach();
  assert.ok(first.board);
  assert.equal(first.board, layerSession.annotations);
  assert.equal(first.board.attached, true);
  assert.equal(window.__gevAnnotations, first.board);
  const result = await first.board.annotate(
    [
      {
        type: 'area',
        manual: true,
        ring: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      },
    ],
    { flyTo: false },
  );
  assert.equal(result.drawn, 1);
  assert.equal(meshes.filter((mesh) => !mesh.deleted).length, 2);
  first.detach();
  assert.equal(first.board.attached, false);
  assert.equal(first.board.count(), 1, 'the marks stay on the session board');
  assert.equal(meshes.filter((mesh) => !mesh.deleted).length, 0);
  const second = attach();
  assert.equal(second.board, first.board, 'one board for the page session');
  assert.equal(meshes.filter((mesh) => !mesh.deleted).length, 2);
  second.detach();
  lifetime.abort();
  assert.equal(window.__gevAnnotations, undefined);
  // Without the Navara view there is nothing to draw on.
  assert.equal(
    attachNavaraAnnotations({ engine, views: undefined }, context, {
      defer() {},
    }),
    null,
  );
});
