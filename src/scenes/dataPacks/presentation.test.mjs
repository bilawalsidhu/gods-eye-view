import test from 'node:test';
import assert from 'node:assert/strict';
import { createPackPresentations } from './presentation.js';

test('abort releases an in-flight image URL before the decoder settles or the viewer is destroyed', async () => {
  let settle;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  const priorImage = globalThis.Image;
  const priorRevoke = URL.revokeObjectURL;
  const revoked = [];
  globalThis.Image = class {
    decode() {
      return pending;
    }
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
    priorRevoke(url);
  };
  const viewer = {
    scene: { requestRender() {} },
    entities: {
      remove() {
        assert.fail('No entity should be acquired');
      },
    },
  };
  const signalOwner = new AbortController();
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const header = new DataView(bytes.buffer);
  header.setUint32(16, 8);
  header.setUint32(20, 8);
  try {
    const rendering = createPackPresentations(viewer).image({
      pack: {},
      asset: { bytes, mimeType: 'image/png' },
      signal: signalOwner.signal,
    });
    const rejected = assert.rejects(rendering, /abort/i);
    signalOwner.abort();
    assert.equal(
      revoked.length,
      1,
      'object URL must be released synchronously with cancellation',
    );
    settle();
    await rejected;
    assert.equal(revoked.length, 1, 'late decode cannot dispose twice');
  } finally {
    settle();
    globalThis.Image = priorImage;
    URL.revokeObjectURL = priorRevoke;
  }
});
