import test from 'node:test';
import assert from 'node:assert/strict';
import { startDefaultMapStack } from './mapStartup.js';

test('startup requests Azure Satellite and preserves the controller fallback result', async () => {
  const calls = [];
  const state = { activeId: 'azure-satellite' };
  const controller = {
    async setStack(id, options) {
      calls.push({ id, options });
      return state;
    },
  };
  assert.equal(await startDefaultMapStack(controller), state);
  assert.deepEqual(calls, [{
    id: 'azure-satellite',
    options: { silent: true },
  }]);
});

test('startup requires a map stack controller', async () => {
  await assert.rejects(startDefaultMapStack(null), /controller is required/);
});
