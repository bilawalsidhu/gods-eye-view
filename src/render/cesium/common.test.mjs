import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
  BLOB_URL_FRAMES,
  BLOB_URL_IDLE_MS,
  blobUrl,
  blobUrlFrameDrawn,
} from './common.js';

test('a blob’s object URL is kept while it is drawn and revoked once idle', () => {
  const made = [];
  const revoked = [];
  const create = mock.method(URL, 'createObjectURL', () => {
    made.push(`blob:test/${made.length}`);
    return made.at(-1);
  });
  const revoke = mock.method(URL, 'revokeObjectURL', (url) =>
    revoked.push(url),
  );
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const blob = new Blob(['a']);
    const url = blobUrl(blob);
    assert.equal(blobUrl(blob), url, 'one URL a blob');
    // Asked for again within the idle time: kept.
    mock.timers.tick(BLOB_URL_IDLE_MS / 2);
    assert.equal(blobUrl(blob), url);
    for (let i = 0; i < BLOB_URL_FRAMES; i++) blobUrlFrameDrawn();
    mock.timers.tick(BLOB_URL_IDLE_MS / 2 + 1);
    assert.deepEqual(revoked, [], 'asked for within the idle time');
    // Asked for, then idle, but no frame drawn since (a material loads in
    // the next frame): kept.
    assert.equal(blobUrl(blob), url);
    mock.timers.tick(3 * BLOB_URL_IDLE_MS);
    assert.deepEqual(revoked, [], 'no frame drawn since it was asked for');
    for (let i = 0; i < BLOB_URL_FRAMES; i++) blobUrlFrameDrawn();
    mock.timers.tick(BLOB_URL_IDLE_MS);
    assert.deepEqual(revoked, [url], 'idle, frames drawn: revoked');
    // Drawn again later: a new URL.
    const again = blobUrl(blob);
    assert.notEqual(again, url);
    assert.equal(made.length, 2);
  } finally {
    mock.timers.reset();
    create.mock.restore();
    revoke.mock.restore();
  }
});
