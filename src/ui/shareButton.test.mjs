// The share button copies by default; a host's `services.shareLink` shares the
// link its own way and reports how it went.
import test from 'node:test';
import assert from 'node:assert/strict';
import { StyleManager } from './applicationShell.js';
import { ShareLinkManager } from '../sharelink.js';
import { parseSharePath } from '../share/shareLinkPath.js';
import { decodeShareView } from '../share/viewCodec.js';
import { applicationPinia } from './vueRuntime.js';
import { useGlobeActionsStore } from './stores/globeActions.js';

/** The decoded view of a `/share/<code>` link. */
const sharedState = (href) =>
  decodeShareView(parseSharePath(new URL(href).pathname).code).state;
const SHARE_LINK = /^https:\/\/gev\.example\/share\/[A-Za-z0-9_-]+$/;

function makeManager(href, { positioned = true } = {}) {
  globalThis.window = { location: { href, hash: new URL(href).hash } };
  globalThis.history = { replaceState() {} };
  const viewer = {
    camera: {
      changed: { addEventListener() {} },
      positionCartographic: positioned
        ? { latitude: 0, longitude: 0, height: 1000 }
        : undefined,
      heading: 0,
      pitch: -Math.PI / 2,
      roll: 0,
    },
  };
  return new ShareLinkManager(viewer);
}

function installClipboard(writeText) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText } },
  });
}

/** The real share action on a minimal shell; return a click. */
function shell({ manager, services = {} }) {
  const toasts = [];
  const owner = {
    services,
    shareLinkManager: manager,
    _disposed: false,
    _showToast: (message) => toasts.push(message),
  };
  return {
    toasts,
    click: () => StyleManager.prototype._share.call(owner),
  };
}

test('buildLink is a /share link stamped with its creation time, without ?lang', () => {
  const manager = makeManager('https://gev.example/?lang=ru#v=2&lat=10&lon=20');
  const href = manager.buildLink({ nowMs: 5_000_000 });
  assert.match(href, SHARE_LINK);
  const link = new URL(href);
  assert.equal(link.searchParams.get('lang'), null);
  assert.equal(link.hash, '');
  assert.equal(sharedState(href).sharedAtMs, 5_000_000);
  // The camera is the live one, not the address bar's.
  assert.equal(sharedState(href).lat, 0);
  assert.equal(
    makeManager('https://gev.example/', { positioned: false }).buildLink(),
    null,
  );
});

test('copyLink copies exactly what buildLink builds', async () => {
  let copied = null;
  installClipboard(async (url) => {
    copied = url;
  });
  const manager = makeManager('https://gev.example/#v=2');
  assert.equal(await manager.copyLink({ nowMs: 7_000_000 }), true);
  assert.equal(copied, manager.buildLink({ nowMs: 7_000_000 }));
});

test('without a host hook the button copies the link', async () => {
  let copied = null;
  installClipboard(async (url) => {
    copied = url;
  });
  const { toasts, click } = shell({
    manager: makeManager('https://gev.example/#v=2'),
  });
  await click();
  assert.match(copied, SHARE_LINK);
  assert.deepEqual(toasts, ['Link copied!']);

  installClipboard(async () => {
    throw new Error('denied');
  });
  await click();
  assert.deepEqual(toasts, ['Link copied!', 'Copy failed']);
});

test('a host hook receives the link and its result picks the toast', async () => {
  installClipboard(async () => assert.fail('the host shares instead'));
  const shared = [];
  const results = ['shared', 'copied', 'cancelled', false];
  const { toasts, click } = shell({
    manager: makeManager('https://gev.example/#v=2'),
    services: {
      shareLink: async (url) => {
        shared.push(url);
        return results.shift();
      },
    },
  });
  for (let i = 0; i < 4; i++) await click();
  assert.equal(shared.length, 4);
  assert.match(shared[0], SHARE_LINK);
  // 'cancelled' (the user closed the sheet) shows nothing.
  assert.deepEqual(toasts, ['Link shared', 'Link copied!', 'Copy failed']);
});

test('a failing host hook, or no camera position, reports a failure', async () => {
  const failing = shell({
    manager: makeManager('https://gev.example/#v=2'),
    services: { shareLink: async () => Promise.reject(new Error('no sheet')) },
  });
  await failing.click();
  assert.deepEqual(failing.toasts, ['Copy failed']);

  let called = false;
  const unpositioned = shell({
    manager: makeManager('https://gev.example/', { positioned: false }),
    services: {
      shareLink: async () => {
        called = true;
        return 'shared';
      },
    },
  });
  await unpositioned.click();
  assert.equal(called, false);
  assert.deepEqual(unpositioned.toasts, ['Copy failed']);
});

test('a host hook that answers without a promise, or throws, still gets a toast', async () => {
  for (const [shareLink, toast] of [
    [() => 'shared', 'Link shared'],
    [
      () => {
        throw new Error('no sheet');
      },
      'Copy failed',
    ],
  ]) {
    const { toasts, click } = shell({
      manager: makeManager('https://gev.example/#v=2'),
      services: { shareLink },
    });
    await click();
    assert.deepEqual(toasts, [toast]);
  }
});

test('the shell answers the globe bar until it is disposed', async () => {
  const calls = [];
  const owner = {
    _disposed: false,
    _share: () => calls.push('share'),
    clearSelectedLayers: async () => calls.push('clear'),
  };
  StyleManager.prototype._initShareButton.call(owner);
  StyleManager.prototype._initClearSelectedLayersButton.call(owner);
  const store = useGlobeActionsStore(applicationPinia());
  store.act('share');
  store.act('clear');
  assert.deepEqual(calls, ['share', 'clear']);
  // A newer shell answers, and owns the busy state, until it goes.
  const newer = { _disposed: false, clearSelectedLayers: async () => {} };
  StyleManager.prototype._initClearSelectedLayersButton.call(newer);
  assert.equal(store.owns(owner._clearLayersToken, 'clear'), false);
  store.detach(newer._clearLayersToken);
  assert.equal(store.owns(owner._clearLayersToken, 'clear'), true);
  store.detach(owner._shareToken);
  store.detach(owner._clearLayersToken);
  store.act('share');
  store.act('clear');
  assert.deepEqual(calls, ['share', 'clear']);
});

test('the shell’s camera controls answer tilt and north-up and publish their state', () => {
  const store = useGlobeActionsStore(applicationPinia());
  const navigations = [];
  const owner = {
    viewer: { camera: { heading: 0 } },
    _navigation: {
      runOrientation: (noun, navigate) => {
        navigations.push(noun);
        return navigate();
      },
    },
    _showToast() {},
  };
  StyleManager.prototype._initCameraOrientationControls.call(owner);
  assert.deepEqual(store.camera, { tilted: false, heading: 0 });
  store.act('tilt');
  store.act('northUp');
  assert.deepEqual(navigations, ['camera', 'camera']);

  // Initialised again, the shell replaces its own owner.
  const first = owner._orientationToken;
  StyleManager.prototype._initCameraOrientationControls.call(owner);
  assert.notEqual(owner._orientationToken, first);
  assert.equal(store.owns(first, 'tilt'), false);
  assert.equal(store.owns(owner._orientationToken, 'tilt'), true);

  // A newer shell owns what the buttons show.
  const newer = store.connect({ tilt() {} });
  owner.viewer.camera.heading = Math.PI / 2;
  owner._cameraOrientationControls.sync();
  assert.deepEqual(store.camera, { tilted: false, heading: 0 });
  store.detach(newer);
  owner.viewer.camera.heading = Math.PI;
  owner._cameraOrientationControls.sync();
  assert.deepEqual(store.camera, { tilted: false, heading: 180 });
  owner._cameraOrientationControls.destroy();
  store.detach(owner._orientationToken);
});

test('a shell that goes after a newer one leaves the newer one’s bar state', () => {
  const store = useGlobeActionsStore(applicationPinia());
  const shellWith = () => {
    const owner = {
      _disposed: false,
      viewer: { camera: { heading: 0 } },
      _navigation: { runOrientation: (_noun, navigate) => navigate() },
      _showToast() {},
      clearSelectedLayers: async () => {},
    };
    StyleManager.prototype._initClearSelectedLayersButton.call(owner);
    StyleManager.prototype._initCameraOrientationControls.call(owner);
    return owner;
  };
  const older = shellWith();
  const newer = shellWith();
  newer.viewer.camera.heading = Math.PI / 2;
  newer._cameraOrientationControls.sync();
  StyleManager.prototype._publishClearBusy.call(newer, true);
  StyleManager.prototype._publishClearBusy.call(older, false);
  assert.equal(store.clearBusy, true);

  older._cameraOrientationControls.destroy();
  StyleManager.prototype._releaseGlobeActions.call(older);
  assert.equal(store.clearBusy, true);
  assert.deepEqual(store.camera, { tilted: false, heading: 90 });

  // The shell that answers resets its state as it goes.
  newer._cameraOrientationControls.destroy();
  StyleManager.prototype._releaseGlobeActions.call(newer);
  assert.equal(store.clearBusy, null);
  assert.equal(store.camera, null);
  // Its clear finishing after it went changes nothing.
  newer._disposed = true;
  StyleManager.prototype._publishClearBusy.call(newer, false);
  assert.equal(store.clearBusy, null);
});

test('an older shell that answers again shows its clear and its unchanged camera', () => {
  const store = useGlobeActionsStore(applicationPinia());
  const shellWith = (heading) => {
    const owner = {
      _disposed: false,
      viewer: { camera: { heading } },
      _navigation: { runOrientation: (_noun, navigate) => navigate() },
      _showToast() {},
      clearSelectedLayers: async () => {},
    };
    StyleManager.prototype._initClearSelectedLayersButton.call(owner);
    StyleManager.prototype._initCameraOrientationControls.call(owner);
    return owner;
  };
  const older = shellWith(Math.PI / 2);
  StyleManager.prototype._publishClearBusy.call(older, true);
  const newer = shellWith(0);
  // The newer shell's bar does not show the older one's clear.
  assert.equal(store.clearBusy, null);
  older._cameraOrientationControls.sync();
  assert.deepEqual(store.camera, { tilted: false, heading: 0 });
  // Initialised again mid-clear, a shell keeps its clear on the button.
  StyleManager.prototype._publishClearBusy.call(newer, true);
  StyleManager.prototype._initClearSelectedLayersButton.call(newer);
  assert.equal(store.clearBusy, true);
  StyleManager.prototype._publishClearBusy.call(newer, false);
  newer._cameraOrientationControls.destroy();
  StyleManager.prototype._releaseGlobeActions.call(newer);
  assert.equal(store.camera, null);
  // The older shell's clear is the button's again, and the next frame it
  // draws puts its heading back.
  assert.equal(store.clearBusy, true);
  older._cameraOrientationControls.sync();
  assert.deepEqual(store.camera, { tilted: false, heading: 90 });
  older._cameraOrientationControls.destroy();
  StyleManager.prototype._releaseGlobeActions.call(older);
});

test('the location controls answer both reset buttons until they go', () => {
  const store = useGlobeActionsStore(applicationPinia());
  const calls = [];
  const owner = { _disposed: false };
  const controls = { reset: () => calls.push('reset') };
  StyleManager.prototype._connectGlobeReset.call(owner, controls);
  store.act('reset');
  StyleManager.prototype._publishGlobeResetting.call(owner, true);
  assert.equal(store.resetBusy, true);
  // Controls replaced mid-reset keep the reset on the buttons.
  StyleManager.prototype._connectGlobeReset.call(owner, controls);
  assert.equal(store.resetBusy, true);
  StyleManager.prototype._publishGlobeResetting.call(owner, false);
  assert.equal(store.resetBusy, false);
  StyleManager.prototype._connectGlobeReset.call(owner, null);
  store.act('reset');
  assert.deepEqual(calls, ['reset']);
  assert.equal(store.resetBusy, null);
  // A reset finishing after the controls went changes nothing.
  StyleManager.prototype._publishGlobeResetting.call(owner, false);
  assert.equal(store.resetBusy, null);
});
