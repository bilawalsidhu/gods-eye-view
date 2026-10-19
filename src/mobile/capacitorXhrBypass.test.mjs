import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installSameOriginXhrBypass,
  installSameOriginXhrBypassWhenReady,
} from './capacitorXhrBypass.js';

/**
 * Fake the post-bridge shape: `window.XMLHttpRequest` is a fresh constructor
 * whose instances delegate to `CapacitorWebXMLHttpRequest.prototype` (where
 * the bridge's patched `open` lives). Patching the plain prototype must NOT
 * affect instances — the bypass has to target the bridged prototype.
 */
function fakeBridgedWindow() {
  const calls = [];
  const bridgedProto = {
    open(method, url, ...rest) {
      calls.push({ method, url, rest });
    },
  };
  function PlainXHR() {}
  PlainXHR.prototype.open = function (method, url, ...rest) {
    calls.push({ method, url, rest, plain: true });
  };
  return {
    calls,
    bridgedProto,
    XMLHttpRequest: PlainXHR,
    CapacitorWebXMLHttpRequest: { prototype: bridgedProto },
    Capacitor: { getServerUrl: () => 'https://localhost', isNativePlatform: () => true },
  };
}

test('patches the bridged prototype, not the plain one', () => {
  const win = fakeBridgedWindow();
  assert.equal(installSameOriginXhrBypass({ globalRef: win }), true);
  const xhr = new win.XMLHttpRequest();
  // Instances use the bridged prototype in the real bridge; emulate by
  // calling through it directly.
  win.bridgedProto.open.call(xhr, 'GET', 'https://localhost/cesium/a.json');
  assert.equal(win.calls[0].url, '/cesium/a.json');
  assert.equal(win.calls[0].plain, undefined);
});

test('plain-prototype opens are left alone', () => {
  const win = fakeBridgedWindow();
  installSameOriginXhrBypass({ globalRef: win });
  const xhr = new win.XMLHttpRequest();
  xhr.open('GET', 'https://localhost/cesium/a.json');
  assert.equal(win.calls[0].url, 'https://localhost/cesium/a.json');
  assert.equal(win.calls[0].plain, true);
});

test('keeps query strings when converting to relative', () => {
  const win = fakeBridgedWindow();
  installSameOriginXhrBypass({ globalRef: win });
  win.bridgedProto.open.call(
    {},
    'GET',
    'https://localhost/api/x?a=1&b=2',
  );
  assert.equal(win.calls[0].url, '/api/x?a=1&b=2');
});

test('leaves cross-origin absolute URLs untouched', () => {
  const win = fakeBridgedWindow();
  installSameOriginXhrBypass({ globalRef: win });
  win.bridgedProto.open.call({}, 'GET', 'https://example.com/t/0/0/0.png');
  assert.equal(win.calls[0].url, 'https://example.com/t/0/0/0.png');
});

test('leaves relative URLs untouched', () => {
  const win = fakeBridgedWindow();
  installSameOriginXhrBypass({ globalRef: win });
  win.bridgedProto.open.call({}, 'GET', '/cesium/Assets/sky.jpg');
  assert.equal(win.calls[0].url, '/cesium/Assets/sky.jpg');
});

test('passes non-string urls through without throwing', () => {
  const win = fakeBridgedWindow();
  installSameOriginXhrBypass({ globalRef: win });
  const url = { toString: () => 'https://localhost/x' };
  win.bridgedProto.open.call({}, 'GET', url);
  assert.equal(win.calls[0].url, url);
});

test('handles a trailing-slash server URL', () => {
  const win = fakeBridgedWindow();
  win.Capacitor.getServerUrl = () => 'https://localhost/';
  win.Capacitor.isNativePlatform = () => true;
  installSameOriginXhrBypass({ globalRef: win });
  win.bridgedProto.open.call({}, 'GET', 'https://localhost/cesium/a.json');
  assert.equal(win.calls[0].url, '/cesium/a.json');
});

test('second install is a no-op returning false', () => {
  const win = fakeBridgedWindow();
  assert.equal(installSameOriginXhrBypass({ globalRef: win }), true);
  assert.equal(installSameOriginXhrBypass({ globalRef: win }), false);
  win.bridgedProto.open.call({}, 'GET', 'https://localhost/a.json');
  assert.equal(win.calls.length, 1);
  assert.equal(win.calls[0].url, '/a.json');
});

test('returns false without a server URL source', () => {
  assert.equal(installSameOriginXhrBypass({ globalRef: {} }), false);
  assert.equal(
    installSameOriginXhrBypass({
      globalRef: { XMLHttpRequest: function () {} },
    }),
    false,
  );
});

test('ignores the plain prototype when no bridge object exists', () => {
  const calls = [];
  function FakeXHR() {}
  FakeXHR.prototype.open = function (method, url) {
    calls.push({ method, url });
  };
  const win = {
    XMLHttpRequest: FakeXHR,
    Capacitor: { getServerUrl: () => 'https://localhost', isNativePlatform: () => true },
  };
  // Wrapping pre-bridge native XHR would succeed silently and then be
  // orphaned when the bridge replaces the constructor — refuse instead.
  assert.equal(installSameOriginXhrBypass({ globalRef: win }), false);
  const xhr = new win.XMLHttpRequest();
  xhr.open('GET', 'https://localhost/a.json');
  assert.equal(calls[0].url, 'https://localhost/a.json');
});

test('whenReady resolves true immediately when the bridge is ready', async () => {
  const calls = [];
  const win = {
    CapacitorWebXMLHttpRequest: {
      prototype: {
        open(method, url) {
          this._url = url;
          calls.push(url);
        },
      },
    },
    Capacitor: { getServerUrl: () => 'https://localhost', isNativePlatform: () => true },
  };
  // Mark the open as bridge-patched (uses the _url bookkeeping marker).
  win.CapacitorWebXMLHttpRequest.prototype.open = function (method, url) {
    this._url = url;
    calls.push(url);
  };
  assert.equal(
    await installSameOriginXhrBypassWhenReady({ globalRef: win }),
    true,
  );
  win.CapacitorWebXMLHttpRequest.prototype.open.call(
    {},
    'GET',
    'https://localhost/a.json',
  );
  assert.equal(calls[0], '/a.json');
});

test('whenReady waits for a late bridge patch', async () => {
  const calls = [];
  const win = {
    Capacitor: {
      getServerUrl: () => 'https://localhost',
      isNativePlatform: () => true,
    },
  };
  const pending = installSameOriginXhrBypassWhenReady({
    globalRef: win,
    intervalMs: 5,
    timeoutMs: 500,
  });
  await new Promise((r) => setTimeout(r, 20));
  win.CapacitorWebXMLHttpRequest = {
    prototype: {
      open(method, url) {
        this._url = url;
        calls.push(url);
      },
    },
  };
  assert.equal(await pending, true);
  win.CapacitorWebXMLHttpRequest.prototype.open.call(
    {},
    'GET',
    'https://localhost/b.json',
  );
  assert.equal(calls[0], '/b.json');
});

test('whenReady resolves false without Capacitor and on timeout', async () => {
  assert.equal(await installSameOriginXhrBypassWhenReady({ globalRef: {} }), false);
  const win = {
    Capacitor: {
      getServerUrl: () => 'https://localhost',
      isNativePlatform: () => true,
    },
  };
  assert.equal(
    await installSameOriginXhrBypassWhenReady({
      globalRef: win,
      intervalMs: 5,
      timeoutMs: 20,
    }),
    false,
  );
});

test('whenReady waits for the Capacitor object itself to appear', async () => {
  const calls = [];
  const win = {};
  const pending = installSameOriginXhrBypassWhenReady({
    globalRef: win,
    intervalMs: 5,
    timeoutMs: 500,
  });
  await new Promise((r) => setTimeout(r, 20));
  win.Capacitor = {
    getServerUrl: () => 'https://localhost',
    isNativePlatform: () => true,
  };
  win.CapacitorWebXMLHttpRequest = {
    prototype: {
      open(method, url) {
        calls.push(url);
      },
    },
  };
  assert.equal(await pending, true);
  win.CapacitorWebXMLHttpRequest.prototype.open.call(
    {},
    'GET',
    'https://localhost/c.json',
  );
  assert.equal(calls[0], '/c.json');
});

test('whenReady resolves false for non-native Capacitor and never wraps', async () => {
  const calls = [];
  const win = {
    CapacitorWebXMLHttpRequest: {
      prototype: {
        open(method, url) {
          calls.push(url);
        },
      },
    },
    Capacitor: {
      getServerUrl: () => 'https://localhost',
      getPlatform: () => 'web',
    },
  };
  assert.equal(
    await installSameOriginXhrBypassWhenReady({
      globalRef: win,
      intervalMs: 5,
      timeoutMs: 50,
    }),
    false,
  );
  win.CapacitorWebXMLHttpRequest.prototype.open.call(
    {},
    'GET',
    'https://localhost/d.json',
  );
  assert.equal(calls[0], 'https://localhost/d.json');
});

test('whenReady reinstalls after the bridge re-patches open', async () => {
  const calls = [];
  const bridgeOpen = function (method, url) {
    this._url = url;
    calls.push({ bridged: true, url });
  };
  const win = {
    CapacitorWebXMLHttpRequest: { prototype: { open: bridgeOpen } },
    Capacitor: {
      getServerUrl: () => 'https://localhost',
      isNativePlatform: () => true,
    },
  };
  assert.equal(
    await installSameOriginXhrBypassWhenReady({
      globalRef: win,
      intervalMs: 5,
      timeoutMs: 200,
    }),
    true,
  );
  win.CapacitorWebXMLHttpRequest.prototype.open.call(
    {},
    'GET',
    'https://localhost/before.json',
  );
  assert.equal(calls[0].url, '/before.json');
  // Bridge re-applies its patch, discarding the wrapper.
  win.CapacitorWebXMLHttpRequest.prototype.open = function (method, url) {
    this._url = url;
    calls.push({ bridged: true, url });
  };
  assert.equal(
    await installSameOriginXhrBypassWhenReady({
      globalRef: win,
      intervalMs: 5,
      timeoutMs: 500,
    }),
    true,
  );
  win.CapacitorWebXMLHttpRequest.prototype.open.call(
    {},
    'GET',
    'https://localhost/after.json',
  );
  assert.equal(calls[calls.length - 1].url, '/after.json');
});

test('bridge re-patch after install stays bypassed via the setter', () => {
  const calls = [];
  const bridgeOpen = function (method, url) {
    this._url = url;
    calls.push({ bridged: true, url });
  };
  const win = {
    CapacitorWebXMLHttpRequest: { prototype: { open: bridgeOpen } },
    Capacitor: {
      getServerUrl: () => 'https://localhost',
      isNativePlatform: () => true,
    },
  };
  assert.equal(installSameOriginXhrBypass({ globalRef: win }), true);
  win.CapacitorWebXMLHttpRequest.prototype.open.call(
    {},
    'GET',
    'https://localhost/first.json',
  );
  assert.equal(calls[0].url, '/first.json');
  // Bridge re-applies its patch with plain assignment: the accessor setter
  // rewraps on the spot, no reinstall needed.
  win.CapacitorWebXMLHttpRequest.prototype.open = bridgeOpen;
  win.CapacitorWebXMLHttpRequest.prototype.open.call(
    {},
    'GET',
    'https://localhost/second.json',
  );
  assert.equal(calls[1].url, '/second.json');
  // A redundant install is a no-op while the accessor stands.
  assert.equal(installSameOriginXhrBypass({ globalRef: win }), false);
});
