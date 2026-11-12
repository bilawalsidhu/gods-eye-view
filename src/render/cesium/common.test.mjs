import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { blobUrl, createBlobUrls } from './common.js';

test('a blob keeps one object URL, revoked only once the blob is collected', () => {
  const made = [];
  const revoked = [];
  const create = mock.method(URL, 'createObjectURL', () => {
    made.push(`blob:test/${made.length}`);
    return made.at(-1);
  });
  const revoke = mock.method(URL, 'revokeObjectURL', (url) =>
    revoked.push(url),
  );
  try {
    let collect;
    const registered = [];
    class Registry {
      constructor(cleanup) {
        collect = cleanup;
      }
      register(blob, url) {
        registered.push([blob, url]);
      }
    }
    const urlOf = createBlobUrls(Registry);
    const a = new Blob(['a']);
    const b = new Blob(['b']);
    const url = urlOf(a);
    assert.equal(urlOf(a), url);
    assert.notEqual(urlOf(b), url);
    assert.equal(made.length, 2, 'one URL a blob');
    assert.deepEqual(registered, [
      [a, url],
      [b, made[1]],
    ]);
    assert.deepEqual(revoked, []);
    // The registry finds `a` collected: its URL goes.
    collect(url);
    assert.deepEqual(revoked, [url]);
  } finally {
    create.mock.restore();
    revoke.mock.restore();
  }
});

test('a blob’s URL is not revoked by time: one undrawn for an hour still loads', () => {
  const revoked = [];
  const revoke = mock.method(URL, 'revokeObjectURL', (url) =>
    revoked.push(url),
  );
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  try {
    const blob = new Blob(['icon']);
    const url = blobUrl(blob);
    mock.timers.tick(3600_000);
    assert.equal(blobUrl(blob), url, 'the same URL: the same atlas slot');
    mock.timers.tick(3600_000);
    assert.deepEqual(revoked, []);
  } finally {
    mock.timers.reset();
    revoke.mock.restore();
  }
});
