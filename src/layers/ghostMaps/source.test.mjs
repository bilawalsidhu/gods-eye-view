import test from 'node:test';
import assert from 'node:assert/strict';
import { createGhostMapsSource } from './source.js';

test('a server with GhostMaps switched off explains why', async () => {
  const message =
    'S2 GhostMaps is off by default (CC BY-NC-SA). Set GEV_ENABLE_GHOSTMAPS=1 to enable.';
  const source = createGhostMapsSource({
    fetchImpl: async () =>
      Response.json({ error: 'ghostmaps_disabled', message }, { status: 503 }),
  });
  await assert.rejects(source.getCatalog(), { message });
});

test('other catalog failures keep the HTTP status', async () => {
  const source = createGhostMapsSource({
    fetchImpl: async () => new Response('busy', { status: 503 }),
  });
  await assert.rejects(source.getCatalog(), {
    message: 'GhostMaps catalog unavailable (HTTP 503)',
  });
});
