import assert from 'node:assert/strict';
import test from 'node:test';
import { LocationSearch } from './locationSearch.js';

function fixture() {
  const calls = [];
  const requests = [];
  let authority = 0;
  const input = {
    classList: {
      add: (name) => calls.push(['add', name]),
      remove: (name) => calls.push(['remove', name]),
    },
    blur: () => calls.push(['blur']),
  };
  const search = new LocationSearch({
    input,
    begin: () => ++authority,
    isCurrent: (ticket) => ticket === authority,
    beforeFly: (ticket) => {
      calls.push(['fly', ticket]);
      return true;
    },
    search: (query, options) =>
      new Promise((resolve, reject) =>
        requests.push({ query, options, resolve, reject }),
      ),
    onStart: (ticket) => calls.push(['start', ticket]),
    onResult: (result, query) => calls.push(['result', result, query]),
    onMissing: () => calls.push(['missing']),
    onError: (error) => calls.push(['error', error.message]),
    onSettled: (ticket) => calls.push(['settled', ticket]),
  });
  return { search, requests, calls, takeCamera: () => ++authority };
}

test('a newer lookup aborts its predecessor and only its result is presented', async () => {
  const f = fixture();
  const first = f.search.run(' First ');
  const second = f.search.run('Second');
  assert.equal(f.requests[0].query, 'First');
  assert.equal(f.requests[0].options.signal.aborted, true);
  assert.equal(f.requests[0].options.beforeFly(), false);
  assert.equal(f.requests[1].options.beforeFly(), true);
  f.requests[1].resolve({ label: 'Second' });
  await second;
  f.requests[0].resolve({ label: 'First' });
  await first;
  assert.deepEqual(
    f.calls.filter((x) => x[0] === 'result'),
    [['result', { label: 'Second' }, 'Second']],
  );
  assert.equal(f.search.controller, null);
});
test('another camera action revokes a pending lookup without presenting an error', async () => {
  const f = fixture();
  const pending = f.search.run('Place');
  f.takeCamera();
  assert.equal(f.requests[0].options.beforeFly(), false);
  f.requests[0].reject(new Error('old failure'));
  await pending;
  assert.equal(
    f.calls.some((x) => x[0] === 'error' || x[0] === 'result'),
    false,
  );
});
test('missing and failed current lookups settle the exact owning generation', async () => {
  const f = fixture();
  let pending = f.search.run('Missing');
  f.requests[0].resolve(null);
  await pending;
  assert.ok(f.calls.some((x) => x[0] === 'missing'));
  pending = f.search.run('Failure');
  f.requests[1].reject(new Error('unavailable'));
  await pending;
  assert.deepEqual(
    f.calls.filter((x) => x[0] === 'error'),
    [['error', 'unavailable']],
  );
  assert.deepEqual(
    f.calls.filter((x) => x[0] === 'settled'),
    [
      ['settled', 1],
      ['settled', 2],
    ],
  );
});
test('destruction cancels work and rejects late presentation and future requests', async () => {
  const f = fixture();
  const pending = f.search.run('Place');
  f.search.destroy();
  f.search.destroy();
  assert.equal(f.requests[0].options.signal.aborted, true);
  f.requests[0].resolve({ label: 'Place' });
  await pending;
  await f.search.run('Later');
  assert.equal(f.requests.length, 1);
  assert.equal(
    f.calls.some((x) => x[0] === 'result' || x[0] === 'settled'),
    false,
  );
});
test('empty queries and refused navigation do not issue a lookup', async () => {
  const f = fixture();
  await f.search.run('   ');
  f.search.begin = () => false;
  await f.search.run('Place');
  assert.equal(f.requests.length, 0);
  assert.ok(f.calls.some((x) => x[0] === 'blur'));
});
