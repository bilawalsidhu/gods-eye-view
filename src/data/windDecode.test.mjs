import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeWindGribMessage } from '../../server/providers/wind/decode.js';
test('decoder uses bounded virtual storage and releases both handle and message on errors', async () => {
  const writes = []; let deleted = false;
  const eccodesModule = { writeFile: (file, bytes) => writes.push(bytes.length), openGrib: () => ({ getLong: () => 1e9, delete: () => { deleted = true; } }) };
  await assert.rejects(decodeWindGribMessage(new Uint8Array(20), { eccodesModule }), /geometry/);
  assert.deepEqual(writes, [20,0]); assert.equal(deleted, true);
});
