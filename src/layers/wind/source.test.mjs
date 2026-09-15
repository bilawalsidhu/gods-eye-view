import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindSource } from './source.js';

const manifest = { grid: { nx: 2, ny: 1 }, gridUrl: '/grid.bin', unavailable: false };
const response = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, arrayBuffer: async () => body });

test('wind source loads and splits a grid', async () => {
  const buffer = Float32Array.from([1, 2, 3, 4]).buffer;
  const source = createWindSource({ fetchImpl: async (url) => url.includes('manifest') ? response(manifest) : response(buffer) });
  const result = await source.getSnapshot();
  assert.deepEqual([...result.u], [1, 2]);
  assert.deepEqual([...result.v], [3, 4]);
});

test('wind source handles unavailable and malformed responses', async () => {
  let calls = 0;
  const unavailable = { ...manifest, unavailable: true };
  const source = createWindSource({ fetchImpl: async () => { calls++; return response(unavailable); } });
  assert.equal((await source.getSnapshot()).unavailable, true);
  assert.equal(calls, 1);
  await assert.rejects(() => createWindSource({ fetchImpl: async () => response({}, false, 503) }).getSnapshot(), /Wind HTTP 503/);
  await assert.rejects(() => createWindSource({ fetchImpl: async () => response(manifest) }).getSnapshot(), /Malformed wind grid/);
});
