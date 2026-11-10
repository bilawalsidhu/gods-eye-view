import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
// The ALPR paint lane must initialize in an insecure context (plain HTTP over
// the HOST=0.0.0.0 LAN opt-in), where crypto.randomUUID does not exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAlprOverlayCore } from './overlay.js';

test('ALPR overlay init works without crypto.randomUUID', (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const insecure = {
    getRandomValues: (a) => globalThis.crypto.getRandomValues(a),
  };
  const hadImage = 'Image' in globalThis;
  if (!hadImage)
    globalThis.Image = class {
      set src(_) {}
    };
  Object.defineProperty(globalThis, 'crypto', {
    value: insecure,
    configurable: true,
  });
  t.after(() => {
    Object.defineProperty(globalThis, 'crypto', descriptor);
    if (!hadImage) delete globalThis.Image;
  });
  let lane = null;
  const overlay = createAlprOverlayCore({
    state: { enabled: true },
    services: {
      overlays: {
        subscribeMapStack: () => () => {},
        registerPaintLane: (_name, _paint, options) => {
          lane = { options, requestPaint() {}, remove() {}, destroy() {} };
          return lane;
        },
      },
    },
    engine: createFakeEngine(),
    markers: new Map(),
    syncMarker() {},
    sampleHeight() {},
    terrainHeight() {},
  });
  assert.doesNotThrow(() => overlay.init());
  assert.match(lane?.options.id ?? '', /^alpr-/);
});
