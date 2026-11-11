import { createFakeEngine } from '../globe/testing/fakeEngine.js';
// A file removed while its drawing on the next engine is still pending
// (icon decode) must not leave that drawing on the globe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeoFileImport } from './geoFileImport.js';
import { emptyRecords } from '../data/geoImportRecords.js';

const el = () => ({
  classList: { toggle() {} },
  addEventListener() {},
  removeEventListener() {},
});
const engine = () => createFakeEngine({ container: el(), canvas: el() });

test('removing a file during its redraw destroys the late drawing', async () => {
  const document = {
    ...el(),
    body: el(),
    getElementById: (id) => (id === 'geo-import-button' ? el() : null),
  };
  let actions = null;
  const live = new Set();
  let gate = null;
  const drawFile = async () => {
    if (gate) await gate.promise; // the icon decode of the redraw
    const drawing = {
      report: { drawn: 1, undrawn: 0 },
      setShow() {},
      refreshGround: async () => {},
      footprint: () => [],
      destroy: () => live.delete(drawing),
    };
    live.add(drawing);
    return drawing;
  };
  const tool = createGeoFileImport({
    document,
    drawFile,
    load: async (f) => ({
      records: emptyRecords(),
      name: f.name,
      format: 'kmz',
      entityCount: 1,
      removed: 0,
      revoke() {},
    }),
    flyToSource() {},
    connect: (next) => ((actions = next), () => {}),
  });
  tool.attachScene({ engine: engine() });
  await tool.importFiles([{ name: 'a.kmz', size: 1 }]);
  const [{ id }] = tool.list();
  assert.equal(live.size, 1);

  // Engine switch: the drawing leaves; the next engine draws the file again.
  tool.detachScene();
  assert.equal(live.size, 0);
  let release;
  gate = { promise: new Promise((r) => (release = r)) };
  tool.attachScene({ engine: engine() });
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  // The user removes the row while the icon still decodes.
  assert.equal(actions.removeGeoImport(id), true);
  assert.equal(tool.list().length, 0);
  release();
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(live.size, 0, 'the removed file left a drawing on the globe');
  tool.destroy();
  assert.equal(live.size, 0, 'and destroy() cannot release it either');
});
