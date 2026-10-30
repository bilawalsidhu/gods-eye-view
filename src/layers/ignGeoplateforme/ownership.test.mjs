import assert from 'node:assert/strict';
import test from 'node:test';
import { createIgnGeoplateformeLayer } from './index.js';

function harness(descriptor) {
  const added = [];
  const viewer = {
    imageryLayers: {
      addImageryProvider(provider) {
        added.push(provider);
        return { show: true, provider };
      },
      remove(provider) {
        const index = added.indexOf(provider);
        if (index >= 0) added.splice(index, 1);
      },
    },
  };
  const layer = createIgnGeoplateformeLayer({
    source: {
      getDescriptor: (requested) =>
        requested
          ? {
              ...descriptor,
              layer: requested,
              url: '/api/ign-geoplateforme/tiles/' + requested + '/{z}/{x}/{y}.png',
            }
          : descriptor,
    },
  });
  layer.init(viewer);
  return { layer, viewer, added };
}

const descriptor = () => ({
  url: '/api/ign-geoplateforme/tiles/PLANIGNV2/{z}/{x}/{y}.png',
  layer: 'PLANIGNV2',
  tileMatrixSet: 'PM_0_19',
  maximumLevel: 19,
  credit: 'IGN',
});

test('the layer requires a descriptor source', () => {
  assert.throws(() => createIgnGeoplateformeLayer({}), /source/);
});

test('a layer cannot be initialized twice', () => {
  const { layer, viewer } = harness(descriptor());
  assert.throws(() => layer.init(viewer), /already/);
});

test('enabling adds the imagery layer through the local proxy template', () => {
  const { layer, viewer, added } = harness(descriptor());
  layer.enable(viewer);
  assert.equal(added.length, 1);
  // The provider exposes the template through its public `url` accessor.
  assert.ok(
    added[0].url.startsWith('/api/ign-geoplateforme/tiles/'),
    'the browser must not name an upstream URL',
  );
  assert.equal(layer.getStats().count, 1);
  layer.destroy(viewer);
});

test('the layer offers no vector cadastre, because the upstream is unreliable', () => {
  const { layer, viewer } = harness(descriptor());
  layer.enable(viewer);
  // The row is a chips row: the raster layers are the chips, and the
  // line under them says what the layer cannot offer.
  const controls = layer.getRowControls();
  assert.match(controls.info, /vector cadastre unavailable/i);
  const chipIds = controls.chips.map((chip) => chip.id);
  assert.deepEqual(chipIds, ['PLANIGNV2', 'PLANIGNV2.L93', 'ORTHOPHOTOS']);
  assert.ok(
    !chipIds.some((id) => id.includes('CADASTRAL')),
    'the vector cadastre is never offered as a chip',
  );
  layer.destroy(viewer);
});

test('the raster chips switch the basemap and the row stays a layer row', () => {
  const { layer, viewer, added } = harness(descriptor());
  layer.enable(viewer);
  const controls = layer.getRowControls();
  assert.equal(controls.readout, undefined, 'the row keeps its own line');
  const ortho = controls.chips.find((chip) => chip.id === 'ORTHOPHOTOS');
  assert.deepEqual(ortho.params, { raster: 'ORTHOPHOTOS' });
  assert.equal(layer.setParams({ raster: 'ORTHOPHOTOS' }), true);
  assert.equal(
    added.length,
    1,
    'the globe carries one basemap, so the old template is released',
  );
  assert.match(
    added[0].url,
    /ORTHOPHOTOS/,
    'the new template names the chosen raster',
  );
  assert.equal(layer.setParams({ raster: 'NOT-A-LAYER' }), false);
  layer.destroy(viewer);
});

test('destroy removes the imagery layer', () => {
  const { layer, viewer, added } = harness(descriptor());
  layer.enable(viewer);
  layer.destroy(viewer);
  assert.equal(added.length, 0);
  assert.equal(layer.getStats().count, 0);
});
