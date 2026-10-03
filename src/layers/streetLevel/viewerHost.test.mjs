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

test('a prewarmed viewer is released when the layer goes off, or at once if it went off mid-load', async () => {
  const adapter = fakeAdapter();
  let release = null;
  adapter.prewarm = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const { state, host } = harness(adapter);
  const entry = state.providers.get('mapillary');
  entry.on = true;

  // Warmed, then the layer is switched off: unmount releases the warm viewer.
  const warming = host.prewarm([entry]);
  release();
  await warming;
  assert.equal(adapter.calls.unmount, 0);
  host.unmount();
  assert.equal(adapter.calls.unmount, 1, 'the WebGL viewer is destroyed');

  // Switched off while the library was still loading: released on arrival.
  const late = host.prewarm([entry]);
  state.enabled = false;
  release();
  await late;
  assert.equal(adapter.calls.unmount, 2);
});

test('switching one provider off releases only its viewer', async () => {
  const adapter = fakeAdapter();
  adapter.prewarm = async () => {};
  const { state, host } = harness(adapter);
  const entry = state.providers.get('mapillary');
  entry.on = true;
  await host.prewarm([entry]);
  host.unmount('panoramax');
  assert.equal(adapter.calls.unmount, 0, 'another provider leaves it alone');
  host.unmount('mapillary');
  assert.equal(adapter.calls.unmount, 1);
});
