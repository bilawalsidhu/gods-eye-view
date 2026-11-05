import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavaraPolygonDisplay } from './navaraPolygons.js';

function fakeView({ failOn = null } = {}) {
  const live = new Set();
  let added = 0;
  const handle = (kind, description) => {
    const item = {
      kind,
      description,
      delete: () => live.delete(item),
      update: () => assert.fail('the display never updates a layer in place'),
    };
    live.add(item);
    return item;
  };
  return {
    live,
    layers: () => [...live].filter((item) => item.kind === 'layer'),
    addSource: (description) => handle('source', description),
    addLayer: (description) => {
      if (++added === failOn) throw new Error('layer allocation failed');
      return handle('layer', description);
    },
  };
}

const engine = { render: { request() {} } };
const groups = (...colors) =>
  new Map(colors.map((css) => [css, [{ type: 'Feature', id: css }]]));

test('a hidden display holds no Navara layers, and showing it rebuilds them', () => {
  const view = fakeView();
  const display = createNavaraPolygonDisplay(engine, view, (color) => ({
    polygon: { color },
  }));
  display.replace(groups('#ff0000', '#00ff00'));
  assert.equal(view.live.size, 0, 'nothing is built while hidden');
  display.setVisible(true);
  assert.deepEqual(
    view.layers().map((layer) => layer.description.polygon.color),
    [0xff0000, 0x00ff00],
  );
  // Navara 0.2.1 may drop a show:false update on a new layer: hiding deletes.
  display.setVisible(false);
  assert.equal(view.live.size, 0);
  display.setVisible(true);
  assert.equal(view.layers().length, 2);
  display.destroy();
  assert.equal(view.live.size, 0);
});

test('a visible display swaps whole batches and keeps the last on a failure', () => {
  const view = fakeView({ failOn: 3 });
  const display = createNavaraPolygonDisplay(engine, view, (color) => ({
    polygon: { color },
  }));
  display.setVisible(true);
  display.replace(groups('#ff0000'));
  display.replace(groups('#0000ff'));
  assert.deepEqual(
    view.layers().map((layer) => layer.description.polygon.color),
    [0x0000ff],
  );
  assert.throws(
    () => display.replace(groups('#00ff00')),
    /layer allocation failed/,
  );
  assert.deepEqual(
    view.layers().map((layer) => layer.description.polygon.color),
    [0x0000ff],
  );
  assert.equal(view.live.size, 2, 'the failed batch released its source');
  // The failed rows were not adopted: hiding and showing redraws the last.
  display.setVisible(false);
  display.setVisible(true);
  assert.deepEqual(
    view.layers().map((layer) => layer.description.polygon.color),
    [0x0000ff],
  );
});
