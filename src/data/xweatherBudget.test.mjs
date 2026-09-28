import test from 'node:test';
import assert from 'node:assert/strict';
import { createXweatherBudget } from '../../server/providers/xweather/budget.js';

function memoryFs(initial) {
  const files = new Map(initial ? [['/b.json', initial]] : []);
  return {
    files,
    readFile: async (p) => {
      if (!files.has(p))
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(p);
    },
    writeFile: async (p, text) => {
      files.set(p, text);
    },
    mkdir: async () => {},
  };
}
const response = (cost) => ({
  headers: new Headers(
    cost === undefined ? {} : { 'x-cost-tokens': String(cost) },
  ),
});
const SEPT = () => Date.UTC(2026, 8, 24);
const OCT = () => Date.UTC(2026, 9, 1);

// A mocked timer's callback runs synchronously inside tick(), but the
// callback here is an async function: tick() does not wait for its promise
// chain to settle. A real macrotask (setImmediate is not mocked) only fires
// once the microtask queue is fully drained, so this reliably waits out an
// arbitrarily deep await chain without guessing a tick count.
const drain = () => new Promise((resolve) => setImmediate(resolve));

test('counts x-cost-tokens, and one per fetch when the header is missing', async () => {
  const budget = createXweatherBudget({
    file: '/b.json',
    now: SEPT,
    fs: memoryFs(),
  });
  budget.record(response(1));
  budget.record(response(0));
  budget.record(response());
  budget.record(response('garbage'));
  assert.deepEqual(await budget.snapshot(), {
    month: '2026-09',
    used: 3,
    allowance: 15000,
    over: false,
  });
});

test('a corrupt or last-month file starts the month at zero', async () => {
  for (const text of [
    '{nope',
    JSON.stringify({ date: '2026-08', count: 14999 }),
  ]) {
    const budget = createXweatherBudget({
      file: '/b.json',
      now: SEPT,
      fs: memoryFs(text),
    });
    assert.equal((await budget.snapshot()).used, 0);
  }
});

test('past the free allowance it warns and keeps counting', async () => {
  const fs = memoryFs(JSON.stringify({ date: '2026-09', count: 15000 }));
  const budget = createXweatherBudget({ file: '/b.json', now: SEPT, fs });
  budget.record(response(1));
  const state = await budget.snapshot();
  assert.equal(state.over, true);
  assert.equal(state.used, 15001);
});

test('a flush persists the count after the debounce, and a later instance continues it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fs = memoryFs();
  const budget = createXweatherBudget({ file: '/b.json', now: SEPT, fs });
  budget.record(response(5));
  budget.record(response(2));
  // Nothing persisted yet: still within the debounce window.
  assert.equal(fs.files.has('/b.json'), false);
  t.mock.timers.tick(1000);
  await drain();
  assert.deepEqual(JSON.parse(fs.files.get('/b.json')), {
    date: '2026-09',
    count: 7,
  });

  const later = createXweatherBudget({ file: '/b.json', now: SEPT, fs });
  assert.equal((await later.snapshot()).used, 7);
});

test('a failing writeFile keeps counting in memory; the next flush retries with the full total', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fs = memoryFs();
  let fail = true;
  const realWrite = fs.writeFile;
  fs.writeFile = async (p, text) => {
    if (fail) throw new Error('disk full');
    return realWrite(p, text);
  };
  const budget = createXweatherBudget({ file: '/b.json', now: SEPT, fs });

  budget.record(response(4));
  t.mock.timers.tick(1000);
  await drain();
  // The write failed: nothing on disk, but memory kept the count.
  assert.equal(fs.files.has('/b.json'), false);
  assert.equal((await budget.snapshot()).used, 4);

  fail = false;
  budget.record(response(3));
  t.mock.timers.tick(1000);
  await drain();
  // The retried flush must carry the full total (4 + 3), not just the new pending (3).
  assert.deepEqual(JSON.parse(fs.files.get('/b.json')), {
    date: '2026-09',
    count: 7,
  });
  assert.equal((await budget.snapshot()).used, 7);
});

test('month rollover: September counts do not appear in an October snapshot', async () => {
  const fs = memoryFs();
  const sept = createXweatherBudget({ file: '/b.json', now: SEPT, fs });
  sept.record(response(9));
  assert.equal((await sept.snapshot()).used, 9);

  const oct = createXweatherBudget({ file: '/b.json', now: OCT, fs });
  assert.equal((await oct.snapshot()).used, 0);
});

test('flushes are serialized: a slower first write can never complete after, and clobber, a later one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const disk = { text: undefined };
  const writes = [];
  const fs = {
    readFile: async () => {
      if (disk.text === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return disk.text;
    },
    writeFile: async (p, text) => {
      const entry = { text };
      writes.push(entry);
      return new Promise((resolve) => {
        entry.resolve = () => {
          disk.text = entry.text;
          resolve();
        };
      });
    },
    mkdir: async () => {},
  };

  const budget = createXweatherBudget({ file: '/b.json', now: SEPT, fs });

  budget.record(response(5));
  t.mock.timers.tick(1000);
  await drain();
  assert.equal(writes.length, 1, 'first flush issued its write');

  // A second record arrives, and its debounced flush fires, while the
  // first write is still unresolved.
  budget.record(response(3));
  t.mock.timers.tick(1000);
  await drain();
  assert.equal(
    writes.length,
    1,
    'the second flush must wait for the first to settle, not race it',
  );

  // Let the (slower) first write resolve.
  writes[0].resolve();
  await drain();
  assert.equal(writes.length, 2, 'the second flush only now issues its write');

  writes[1].resolve();
  await drain();

  const finalCount = JSON.parse(disk.text).count;
  const snap = await budget.snapshot();
  assert.equal(finalCount, 8);
  assert.equal(snap.used, finalCount);
});

function raceReadFs() {
  const files = new Map();
  const reads = [];
  return {
    files,
    reads,
    readFile(p) {
      // Capture what the file looked like when the read was ISSUED, not
      // when it later resolves -- a real in-flight read is not retroactively
      // affected by a write that starts after it.
      const hadFile = files.has(p);
      const text = files.get(p);
      return new Promise((resolve, reject) => {
        reads.push({
          resolve: () => {
            if (hadFile) resolve(text);
            else reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
          },
        });
      });
    },
    writeFile: async (p, text) => {
      files.set(p, text);
    },
    mkdir: async () => {},
  };
}

test('a slower bootstrap read cannot resolve after a flush and clobber lastKnownFileCount', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fs = raceReadFs();
  const budget = createXweatherBudget({ file: '/b.json', now: SEPT, fs });

  budget.record(response(5));
  t.mock.timers.tick(1000);
  await drain();
  assert.equal(fs.reads.length, 1, 'the flush issued its read');

  // A concurrent snapshot() call, made while lastKnownFileCount is still
  // null -- exactly the window the race exploited.
  const snapshotPromise = budget.snapshot();
  await drain();

  // Resolve the flush's read first and let the flush run to completion,
  // including its write.
  fs.reads[0].resolve();
  await drain();

  // If snapshot() issued its own independent read, resolve it too -- once
  // resolved (with the file state from before the flush's write), it must
  // not be able to clobber what the flush already established.
  for (const read of fs.reads.slice(1)) read.resolve();
  await drain();

  const snap1 = await snapshotPromise;
  const snap2 = await budget.snapshot();
  assert.equal(snap1.used, 5);
  assert.equal(snap2.used, 5);
  assert.deepEqual(JSON.parse(fs.files.get('/b.json')), {
    date: '2026-09',
    count: 5,
  });
});

test('two instances sharing a file merge their flushed deltas instead of clobbering', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fs = memoryFs();
  const a = createXweatherBudget({ file: '/b.json', now: SEPT, fs });
  const b = createXweatherBudget({ file: '/b.json', now: SEPT, fs });

  a.record(response(3));
  t.mock.timers.tick(1000);
  await drain();

  b.record(response(3));
  t.mock.timers.tick(1000);
  await drain();

  assert.deepEqual(JSON.parse(fs.files.get('/b.json')), {
    date: '2026-09',
    count: 6,
  });

  // Each instance's own next flush re-reads the shared file, so its
  // subsequent snapshot reflects the other instance's units too.
  a.record(response(1));
  t.mock.timers.tick(1000);
  await drain();
  assert.ok((await a.snapshot()).used >= 6);

  b.record(response(1));
  t.mock.timers.tick(1000);
  await drain();
  assert.ok((await b.snapshot()).used >= 6);
});
