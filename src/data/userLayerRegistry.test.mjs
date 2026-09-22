import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerUserLayers,
  userLayerEntries,
  userLayerIds,
  isUserLayerId,
  resetUserLayersForTest,
  MAX_USER_LAYERS,
} from './layerState.js';

const layer = (id, extra = {}) => ({
  id,
  createLayer: () => ({ id }),
  ...extra,
});

beforeEach(() => resetUserLayersForTest());

test('registers layers and exposes them id-sorted', () => {
  // Deliberately out of order: discovery order must not leak into the encoded
  // link, or the same selection would produce different share URLs.
  registerUserLayers([layer('zulu'), layer('alpha'), layer('mike')]);
  assert.deepEqual(userLayerIds(), ['alpha', 'mike', 'zulu']);
});

test('defaults the label to the id but keeps an explicit one', () => {
  registerUserLayers([layer('plain'), layer('named', { label: 'Nice Name' })]);
  const byId = Object.fromEntries(
    userLayerEntries().map((e) => [e.id, e.label]),
  );
  assert.equal(byId.plain, 'plain');
  assert.equal(byId.named, 'Nice Name');
});

test('rejects ids that break the registry grammar', () => {
  for (const bad of ['Has Caps', 'under_score', 'sp ace', '', 'dots.here']) {
    assert.throws(
      () => registerUserLayers([layer(bad)]),
      /Invalid user-layer id/,
    );
  }
});

test('rejects an id that collides with a built-in layer', () => {
  // The whole point of the separate namespace is that a user layer can never
  // shadow a shipped one.
  assert.throws(
    () => registerUserLayers([layer('cctv')]),
    /collides with a built-in layer/,
  );
});

test('rejects duplicate ids within one registration', () => {
  assert.throws(
    () => registerUserLayers([layer('twice'), layer('twice')]),
    /Duplicate user-layer id/,
  );
});

test('requires a createLayer factory', () => {
  assert.throws(
    () => registerUserLayers([{ id: 'no-factory' }]),
    /must supply a createLayer function/,
  );
});

test('caps the number of user layers', () => {
  const many = Array.from({ length: MAX_USER_LAYERS + 1 }, (_, i) =>
    layer(`l${i}`),
  );
  assert.throws(() => registerUserLayers(many), /Too many user layers/);
});

test('registration replaces the previous set rather than appending', () => {
  registerUserLayers([layer('first')]);
  registerUserLayers([layer('second')]);
  assert.deepEqual(userLayerIds(), ['second']);
});

test('treats a missing or empty list as no user layers', () => {
  assert.deepEqual(registerUserLayers(undefined), []);
  assert.deepEqual(userLayerIds(), []);
  assert.equal(isUserLayerId('anything'), false);
});

test('isUserLayerId reflects what is registered', () => {
  registerUserLayers([layer('mine')]);
  assert.equal(isUserLayerId('mine'), true);
  assert.equal(isUserLayerId('not-mine'), false);
});
