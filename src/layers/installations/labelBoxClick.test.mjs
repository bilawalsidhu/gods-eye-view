// src/layers/installations/labelBoxClick.test.mjs — a click on a mapped
// installation's label box finds the site only where that label is the one
// painted on top: another layer's label over it keeps the click.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createControls } from './controls.js';
import { LAYER_ID } from './policy.js';

const RECORD = Object.freeze({
  id: 'base',
  kind: 'installation',
  name: 'Base',
  class: 'base',
  latitude: 10,
  longitude: 20,
});

/** The installations controls over a fake overlay whose hit rects are given. */
function controlsWith(rects) {
  const overlayHost = {
    // As the world overlay does: the last painted rect under the point wins,
    // filtered to a source when one is asked for.
    hitTest(x, y, options = {}) {
      for (let i = rects.length - 1; i >= 0; i--) {
        const rect = rects[i];
        if (options.sourceId && rect.sourceId !== options.sourceId) continue;
        if (
          x < rect.x ||
          x > rect.x + rect.w ||
          y < rect.y ||
          y > rect.y + rect.h
        )
          continue;
        return { sourceId: rect.sourceId, entryId: rect.entryId };
      }
      return null;
    },
  };
  const controls = createControls({
    state: {
      enabled: true,
      records: [RECORD],
      recordById: new Map([[RECORD.id, RECORD]]),
    },
    services: {},
    parts: { rendering: { installationSurfaceHeightM: () => 0 } },
    source: {},
    overlayHost,
  });
  return controls.methods;
}

const OWN = {
  sourceId: LAYER_ID,
  entryId: 'base',
  x: 100,
  y: 100,
  w: 80,
  h: 20,
};

test("a click on the site's own label box finds the site", () => {
  const methods = controlsWith([OWN]);
  assert.equal(methods.findAt({ x: 120, y: 110 })?.id, 'base');
  assert.equal(methods.findAt({ x: 10, y: 10 }), null, 'outside every box');
  assert.equal(methods.findAt(null), null);
});

test("another layer's label painted over the site's keeps the click", () => {
  const methods = controlsWith([
    OWN,
    { sourceId: 'flights', entryId: 'abc123', x: 110, y: 105, w: 40, h: 12 },
  ]);
  assert.equal(
    methods.findAt({ x: 120, y: 110 }),
    null,
    'the flight is on top',
  );
  assert.equal(
    methods.findAt({ x: 170, y: 110 })?.id,
    'base',
    'where the site is on top, it is found',
  );
});
