// A failed draw-set write must leave the next read able to redraw every piece.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createFirePerimetersLayer } from './index.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { createStubRenderer } from '../../render/stub/index.js';

const HOUR = 3600000;
const AT = Date.UTC(2026, 7, 20, 12);
const square = (lon, lat, size = 0.01) => [
  [lon, lat],
  [lon + size, lat],
  [lon + size, lat + size],
  [lon, lat + size],
  [lon, lat],
];
const fire = {
  id: 'a',
  name: 'a',
  containedPct: 0,
  lastGrowthTime: null,
  anchor: { lon: -120, lat: 38 },
};
const piece = (id, lon = -120) => ({
  id,
  fireId: 'a',
  born: AT - HOUR,
  polygons: [[square(lon, 38)]],
  outline: [square(lon, 38)],
});
const snap = (pieces) => ({
  at: AT,
  fetchedAt: AT,
  stale: false,
  revision: pieces.map((p) => p.id).join('|'),
  note: null,
  fires: [fire],
  pieces,
});

function harness(read, { failOnce = null, extra = {} } = {}) {
  const renderer = createStubRenderer();
  const viewer = {};
  bindRenderer(viewer, renderer);
  let armed = failOnce;
  for (const kind of ['shapes', 'lines']) {
    const make = renderer.draw[kind].bind(renderer.draw);
    renderer.draw[kind] = (spec) => {
      const set = make(spec);
      for (const call of ['set', 'upsert']) {
        const write = set[call].bind(set);
        set[call] = (items) => {
          if (armed === kind) {
            armed = null;
            throw new Error('one-shot write failure');
          }
          return write(items);
        };
      }
      return set;
    };
  }
  const layer = createFirePerimetersLayer({
    source: { getSnapshot: async () => read() },
    ...extra,
  });
  layer.init(viewer);
  layer.enable(viewer);
  const count = (kind) => {
    let n = 0;
    for (const id of renderer.testing.sets())
      if (id.startsWith('fire-perimeters:') && id.endsWith(`:${kind}`))
        n += renderer.testing.setRecord(id).items.size;
    return n;
  };
  return {
    layer,
    count,
    arm: (kind) => {
      armed = kind;
    },
  };
}

for (const kind of ['shapes', 'lines'])
  test(`a retry after one failed ${kind} write draws the whole snapshot`, async () => {
    const h = harness(() => snap([piece('p1')]), { failOnce: kind });
    assert.equal(await h.layer.update(), false);
    assert.equal(await h.layer.update(), true);
    assert.equal(h.count('fills'), 1, 'the fill is drawn after the retry');
    assert.equal(h.count('lines'), 1, 'the fire line is drawn after the retry');
    h.layer.destroy();
  });

test('a read whose write throws part-way does not hide a piece from the next read', async () => {
  let pieces = [piece('ok')];
  const h = harness(() => snap(pieces));
  assert.equal(await h.layer.update(), true);
  pieces = [piece('ok'), piece('ok2', -119.9)];
  h.arm('shapes');
  assert.equal(await h.layer.update(), false);
  assert.equal(await h.layer.update(), true);
  assert.equal(h.count('fills'), 2, 'both pieces are drawn');
  assert.equal(h.count('lines'), 2);
  h.layer.destroy();
});
