import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBundledCableSource,
  telegeographyEnabled,
} from './bundledSource.js';

test('TeleGeography is off by default and requests nothing', async () => {
  delete process.env.GEV_ENABLE_TELEGEOGRAPHY;
  assert.equal(telegeographyEnabled(), false);
  let requests = 0;
  const source = createBundledCableSource({
    fetchImpl: async () => {
      requests++;
      return { ok: true, json: async () => ({ features: [] }) };
    },
  });
  assert.equal(source.available, false);
  await assert.rejects(source.fetch(), /GEV_ENABLE_TELEGEOGRAPHY=1/);
  assert.equal(requests, 0);
});

test('GEV_ENABLE_TELEGEOGRAPHY turns the bundled dataset on', () => {
  for (const [value, expected] of [
    ['1', true],
    ['On', true],
    ['0', false],
    ['', false],
  ]) {
    process.env.GEV_ENABLE_TELEGEOGRAPHY = value;
    assert.equal(telegeographyEnabled(), expected, value);
    assert.equal(createBundledCableSource().available, expected, value);
  }
  delete process.env.GEV_ENABLE_TELEGEOGRAPHY;
});

test('a failed bundled response releases its body', async () => {
  let released = 0;
  const source = createBundledCableSource({
    enabled: true,
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      body: {
        cancel: async () => {
          released++;
        },
      },
    }),
  });
  await assert.rejects(source.fetch(), /HTTP 503/);
  assert.equal(released, 2);
});

test('cancellation during JSON parsing cannot return a late snapshot', async () => {
  const controller = new AbortController();
  const source = createBundledCableSource({
    enabled: true,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        controller.abort();
        return { type: 'FeatureCollection', features: [] };
      },
    }),
  });
  await assert.rejects(source.fetch(controller.signal), { name: 'AbortError' });
});
