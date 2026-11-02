import test from 'node:test';
import assert from 'node:assert/strict';
import { createRadioSource, createRadioLayer } from './index.js';

const id = '00000000-0000-4000-8000-000000000001';

test('radio source confines directory and click requests to their existing routes', async () => {
  const calls = [];
  const body = { stations: [], stale: false };
  const source = createRadioSource({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return new Response(JSON.stringify(body));
    },
  });
  const controller = new AbortController();
  assert.deepEqual(
    await source.getDirectory({ signal: controller.signal }),
    body,
  );
  await source.recordClick(id, { signal: controller.signal });
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/radio/stations', `/api/radio/click/${id}`],
  );
  assert.equal(calls[1].options.method, 'POST');
  assert.ok(calls.every((call) => call.options.signal === controller.signal));
  for (const invalid of [
    '../stations',
    'https://example.com',
    '',
    null,
    `${id}?x=1`,
  ])
    await assert.rejects(
      source.recordClick(invalid),
      /Invalid radio station id/,
    );
  assert.equal(calls.length, 2);
});

test('radio source propagates denial and cancels completed body parsing', async () => {
  const denied = createRadioSource({
    fetchImpl: async () => new Response('', { status: 403 }),
  });
  await assert.rejects(denied.getDirectory(), /403/);
  await assert.rejects(denied.recordClick(id), /403/);
  const controller = new AbortController();
  const source = createRadioSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return { stations: [] };
      },
    }),
  });
  await assert.rejects(source.getDirectory({ signal: controller.signal }), {
    name: 'AbortError',
  });
  let called = false;
  const idle = createRadioSource({
    fetchImpl: async () => {
      called = true;
    },
  });
  await assert.rejects(idle.recordClick(id, { signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(called, false);
});

test('radio factories keep settings and subscriptions independent without fetching or audio startup', () => {
  let requested = false;
  const source = {
    getDirectory() {
      requested = true;
    },
    recordClick() {
      requested = true;
    },
  };
  const services = {
    ground: {},
    picking: { unregisterPickOwner() {} },
    globe: {},
    render: { governorRequestRender() {} },
    overlays: {
      clearOverlaySource() {},
      setOverlaySourceVisible() {},
      setOverlayEntries() {},
    },
  };
  const first = createRadioLayer({ source, services });
  const second = createRadioLayer({ source, services });
  let changes = 0;
  const off = second.subscribeToRadio(() => changes++);
  const initialChanges = changes;
  first.setRadioParams({ volume: 0.3 });
  assert.equal(first.getRadioParams().volume, 0.3);
  assert.equal(second.getRadioParams().volume, 0.8);
  assert.equal(changes, initialChanges);
  assert.equal(requested, false);
  off();
  first.destroy();
  assert.equal(second.getRadioParams().volume, 0.8);
  second.destroy();
});
