import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IGN_MAX_ZOOM,
  IGN_TILE_MATRIX_SET,
  ignImageryDescriptor,
} from './model.js';

test('the imagery descriptor points at the LOCAL proxy, never upstream', () => {
  const descriptor = ignImageryDescriptor();
  assert.ok(
    descriptor.url.startsWith('/api/ign-geoplateforme/tiles/'),
    `the browser must not name an upstream URL: ${descriptor.url}`,
  );
  assert.ok(!descriptor.url.includes('geopf.fr'));
  assert.ok(descriptor.url.includes('{z}'));
  assert.ok(descriptor.url.includes('{x}'));
  assert.ok(descriptor.url.includes('{y}'));
});

test('the descriptor names the raster layer and the PM tile matrix set', () => {
  const descriptor = ignImageryDescriptor();
  assert.equal(descriptor.layer, 'PLANIGNV2');
  assert.equal(descriptor.tileMatrixSet, IGN_TILE_MATRIX_SET);
  assert.equal(IGN_TILE_MATRIX_SET, 'PM_0_19');
  assert.equal(descriptor.maximumLevel, IGN_MAX_ZOOM);
});

test('the layer can request another raster layer', () => {
  const descriptor = ignImageryDescriptor('ORTHOPHOTOS');
  assert.equal(descriptor.layer, 'ORTHOPHOTOS');
  assert.ok(descriptor.url.includes('/tiles/ORTHOPHOTOS/'));
});

test('an unknown layer name still yields a proxy-relative template', () => {
  const descriptor = ignImageryDescriptor('NOT-A-LAYER');
  assert.ok(descriptor.url.startsWith('/api/ign-geoplateforme/tiles/'));
});
