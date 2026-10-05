import test from 'node:test';
import assert from 'node:assert/strict';
import { createMilitaryRegistry } from './classification.js';

test('classification instances have independent identities, listeners and active states', () => {
  let requests = 0;
  const source = {
    getSnapshot() {
      requests++;
    },
  };
  const first = createMilitaryRegistry({ source });
  const second = createMilitaryRegistry({ source });
  let firstEvents = 0;
  let secondEvents = 0;
  first.onMilitaryLayerActiveChange(() => firstEvents++);
  second.onMilitaryLayerActiveChange(() => secondEvents++);
  first.registerMilitaryIcaos([' ABC123 ']);
  first.setMilitaryLayerActive(true);
  assert.equal(first.isMilitaryIcao('abc123'), true);
  assert.equal(second.isMilitaryIcao('abc123'), false);
  assert.equal(firstEvents, 1);
  assert.equal(secondEvents, 0);
  assert.equal(second.isMilitaryLayerActive(), false);
  assert.equal(requests, 0);
  first.dispose();
  second.dispose();
});

test('classification uses normalized identities and respects its polling interval and active layer', async () => {
  let time = 120000;
  let calls = 0;
  const registry = createMilitaryRegistry({
    now: () => time,
    source: {
      async getSnapshot() {
        calls++;
        return { records: [{ id: 'abc123' }] };
      },
    },
  });
  await registry.refreshMilitaryRegistryIfStale();
  await registry.refreshMilitaryRegistryIfStale();
  assert.equal(calls, 1);
  assert.equal(registry.isMilitaryIcao('abc123'), true);
  time += 60000;
  registry.setMilitaryLayerActive(true);
  await registry.refreshMilitaryRegistryIfStale();
  assert.equal(calls, 1);
  registry.setMilitaryLayerActive(false);
  await registry.refreshMilitaryRegistryIfStale();
  assert.equal(calls, 2);
  registry.dispose();
});

test('source replacement rejects an old response and disposal cancels the current request', async () => {
  let resolveOld;
  let resolveNew;
  let oldSignal;
  let newSignal;
  const registry = createMilitaryRegistry({
    source: {
      getSnapshot(query, { signal }) {
        oldSignal = signal;
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      },
    },
  });
  const old = registry.refreshMilitaryRegistryIfStale();
  const application = new AbortController();
  registry.configureSource(
    {
      getSnapshot(query, { signal }) {
        newSignal = signal;
        return new Promise((resolve) => {
          resolveNew = resolve;
        });
      },
    },
    { signal: application.signal },
  );
  const current = registry.refreshMilitaryRegistryIfStale();
  resolveOld({ records: [{ id: 'abc123' }] });
  await old;
  application.abort();
  resolveNew({ records: [{ id: 'def456' }] });
  await current;
  assert.equal(oldSignal.aborted, true);
  assert.equal(newSignal.aborted, true);
  assert.equal(registry.isMilitaryIcao('abc123'), false);
  assert.equal(registry.isMilitaryIcao('def456'), false);
  registry.dispose();
});

test('a failed classification source preserves known identities and makes no fallback request', async () => {
  let time = 120000;
  let calls = 0;
  const registry = createMilitaryRegistry({
    now: () => time,
    source: {
      async getSnapshot() {
        calls++;
        throw new Error('fixture source unavailable');
      },
    },
  });
  registry.registerMilitaryIcaos(['abc123']);
  time += 60000;
  await assert.doesNotReject(registry.refreshMilitaryRegistryIfStale());
  assert.equal(calls, 1);
  assert.equal(registry.isMilitaryIcao('abc123'), true);
  registry.dispose();
  assert.equal(registry.isMilitaryIcao('abc123'), false);
});

test('disposing a registry fed directly by its layer also clears classification', () => {
  const registry = createMilitaryRegistry();
  registry.registerMilitaryIcaos(['abc123']);
  registry.dispose();
  assert.equal(registry.isMilitaryIcao('abc123'), false);
});

test('classification prefers an explicit identity capability over positioned observations', async () => {
  const registry = createMilitaryRegistry({
    source: {
      getSnapshot() {
        assert.fail(
          'position snapshots must not replace an available identity capability',
        );
      },
      async getIdentities() {
        return ['abc123'];
      },
    },
  });
  await registry.refreshMilitaryRegistryIfStale();
  assert.equal(registry.isMilitaryIcao('abc123'), true);
  registry.dispose();
});
