import assert from 'node:assert/strict';
import test from 'node:test';
import { createViewerHost } from './viewerHost.js';

function harness(adapter) {
  const state = {
    enabled: true,
    notify() {},
    providers: new Map(),
    street: { host: {}, renderMode: 'letterbox', follow: false },
  };
  const def = { id: 'mapillary', name: 'Mapillary', label: 'MAPILLARY' };
  state.providers.set('mapillary', { def, instance: { viewer: adapter } });
  const parts = {
    marker: { set() {}, clear() {} },
    follow: { followCamera() {}, lookAtPosition() {} },
  };
  return { state, host: createViewerHost({ state, parts }) };
}

function fakeAdapter({ failMounts = 0 } = {}) {
  const calls = { mount: 0, open: [], unmount: 0, listeners: 0 };
  let emit = null;
  return {
    calls,
    async mount() {
      calls.mount++;
      if (calls.mount <= failMounts) throw new Error('library failed to load');
    },
    async open(id) {
      calls.open.push(id);
      emit?.({
        providerId: 'mapillary',
        imageId: id,
        position: { lon: 1, lat: 2 },
        bearing: 90,
        isPano: false,
        externalUrl: `https://example.test/${id}`,
      });
    },
    close() {},
    unmount() {
      calls.unmount++;
    },
    resize() {},
    onPose(listener) {
      calls.listeners++;
      emit = listener;
      return () => {
        calls.listeners--;
        emit = null;
      };
    },
  };
}

test('a failed mount is retried on the next open instead of being cached', async () => {
  const adapter = fakeAdapter({ failMounts: 1 });
  const { state, host } = harness(adapter);
  await host.open('mapillary', 'a');
  assert.equal(state.street.error, 'library failed to load');
  assert.equal(adapter.calls.listeners, 0, 'the pose listener was released');
  await host.open('mapillary', 'b');
  assert.equal(state.street.error, null);
  assert.equal(adapter.calls.mount, 2);
  assert.deepEqual(adapter.calls.open, ['b']);
  assert.equal(state.street.imageId, 'b');
  assert.equal(state.street.externalUrl, 'https://example.test/b');
});

test('concurrent opens share one mount and one pose listener', async () => {
  const adapter = fakeAdapter();
  const { host } = harness(adapter);
  await Promise.all([host.open('mapillary', 'a'), host.open('mapillary', 'b')]);
  assert.equal(adapter.calls.mount, 1);
  assert.equal(adapter.calls.listeners, 1);
});

test('unmounting while a mount is in flight does not leave it active', async () => {
  const adapter = fakeAdapter();
  const { state, host } = harness(adapter);
  const opening = host.open('mapillary', 'a');
  host.unmount();
  await opening;
  assert.equal(host.activeProviderId(), null);
  assert.equal(adapter.calls.listeners, 0);
  assert.equal(adapter.calls.unmount, 1);
  assert.equal(state.street.open, false);
});
