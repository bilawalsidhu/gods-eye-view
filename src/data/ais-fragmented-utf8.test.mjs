import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAisFrameSync, decodeAisFrame } from './aisStreamAdapter.js';
test('fragment boundaries do not corrupt multibyte AIS names', async () => {
  const text = JSON.stringify({ ShipName: '港船🚢' });
  const bytes = new TextEncoder().encode(text);
  for (let at = 1; at < bytes.length; at++) {
    const fragments = [bytes.subarray(0, at), bytes.subarray(at)];
    assert.equal(decodeAisFrameSync(fragments), text);
    assert.equal(await decodeAisFrame(fragments), text);
  }
  assert.equal(decodeAisFrameSync(['one', 'two']), 'onetwo');
  assert.equal(decodeAisFrameSync([bytes.buffer]), text);
});
