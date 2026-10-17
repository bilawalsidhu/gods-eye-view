import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOM_FTP_HOST,
  createBomFtp,
} from '../../server/providers/bomRadar/ftp.js';

function fakeClient(log, behaviour = {}) {
  const id = log.clients.length + 1;
  const client = {
    id,
    closed: false,
    active: 0,
    async access(options) {
      log.access.push({ id, ...options });
      if (behaviour.access) await behaviour.access(id);
    },
    async list(directory) {
      log.events.push(`list:${id}`);
      client.active++;
      log.maxActive = Math.max(log.maxActive, client.active);
      try {
        if (behaviour.list) return await behaviour.list(directory, id);
        return [
          { name: 'IDR643.T.202610121609.png', isFile: true },
          { name: 'subdir', isFile: false, type: 2 },
          { name: 'IDR643.T.202610121614.png', type: 1 },
        ];
      } finally {
        client.active--;
      }
    },
    async downloadTo(sink, remotePath) {
      log.events.push(`download:${id}`);
      if (behaviour.download) return behaviour.download(sink, remotePath, id);
      await new Promise((resolve, reject) =>
        sink.write(Buffer.from('abcdef'), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    },
    close() {
      client.closed = true;
      log.closed.push(id);
    },
  };
  log.clients.push(client);
  return client;
}
const newLog = () => ({
  clients: [],
  access: [],
  events: [],
  closed: [],
  maxActive: 0,
});

test('connects anonymously to the fixed host, without TLS, and lists files only', async () => {
  const log = newLog();
  const ftp = createBomFtp({ clientFactory: async () => fakeClient(log) });
  assert.equal(BOM_FTP_HOST, 'ftp.bom.gov.au');
  const names = await ftp.list('/anon/gen/radar/');
  assert.deepEqual(names, [
    'IDR643.T.202610121609.png',
    'IDR643.T.202610121614.png',
  ]);
  assert.deepEqual(log.access, [
    {
      id: 1,
      host: 'ftp.bom.gov.au',
      user: 'anonymous',
      password: 'guest',
      secure: false,
    },
  ]);
  ftp.close();
});

test('operations share one connection and run strictly one at a time', async () => {
  const log = newLog();
  const ftp = createBomFtp({
    clientFactory: async () =>
      fakeClient(log, {
        list: () => new Promise((resolve) => setTimeout(() => resolve([]), 5)),
      }),
  });
  await Promise.all([ftp.list('/a'), ftp.list('/b'), ftp.list('/c')]);
  assert.equal(log.clients.length, 1);
  assert.equal(log.maxActive, 1, 'basic-ftp clients are not concurrent');
  assert.equal(ftp.stats().connected, true);
  ftp.close();
  assert.equal(ftp.stats().connected, false);
});

test('downloads are collected in memory and capped as they stream', async () => {
  const log = newLog();
  const ftp = createBomFtp({ clientFactory: async () => fakeClient(log) });
  const bytes = await ftp.download('/anon/gen/radar/x.png', 100);
  assert.equal(bytes.toString(), 'abcdef');
  await assert.rejects(ftp.download('/anon/gen/radar/x.png', 5), /too_large/);
  ftp.close();
});

test('an error drops the connection and the next operation reconnects', async () => {
  const log = newLog();
  let failures = 1;
  const ftp = createBomFtp({
    clientFactory: async () =>
      fakeClient(log, {
        list: () => {
          if (log.clients.length === 1 && failures-- > 0)
            throw new Error('425 cannot open data connection');
          return [{ name: 'IDR643.T.202610121609.png', isFile: true }];
        },
      }),
  });
  // A first-use failure is reported (nothing was reused), not retried silently.
  await assert.rejects(ftp.list('/a'), /425/);
  assert.deepEqual(log.closed, [1]);
  assert.equal(ftp.stats().connected, false);
  assert.deepEqual(await ftp.list('/a'), ['IDR643.T.202610121609.png']);
  assert.equal(log.clients.length, 2);
  ftp.close();
});

test('a reused connection that the server closed is replaced and the call retried once', async () => {
  const log = newLog();
  const ftp = createBomFtp({
    clientFactory: async () =>
      fakeClient(log, {
        list: (_directory, id) => {
          if (id === 1 && log.events.filter((e) => e === 'list:1').length > 1)
            throw new Error('Client is closed');
          return [{ name: 'IDR644.T.202610121609.png', isFile: true }];
        },
      }),
  });
  await ftp.list('/a');
  assert.deepEqual(await ftp.list('/a'), ['IDR644.T.202610121609.png']);
  assert.equal(log.clients.length, 2);
  assert.deepEqual(log.closed, [1]);
  ftp.close();
});

test('an operation that never returns times out and the connection is discarded', async () => {
  const log = newLog();
  const ftp = createBomFtp({
    timeoutMs: 20,
    clientFactory: async () =>
      fakeClient(log, { list: () => new Promise(() => {}) }),
  });
  await assert.rejects(ftp.list('/a'), /ftp_timeout/);
  assert.deepEqual(log.closed, [1]);
  assert.equal(ftp.stats().connected, false);
});

test('a login that never completes is abandoned and its client closed', async () => {
  const log = newLog();
  const ftp = createBomFtp({
    timeoutMs: 20,
    clientFactory: async () =>
      fakeClient(log, { access: () => new Promise(() => {}) }),
  });
  await assert.rejects(ftp.list('/a'), /ftp_timeout/);
  assert.deepEqual(log.closed, [1]);
});

test('the connection closes after the idle period, and not while work is queued', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const log = newLog();
  const ftp = createBomFtp({
    idleMs: 60_000,
    clientFactory: async () => fakeClient(log),
  });
  await ftp.list('/a');
  t.mock.timers.tick(59_000);
  assert.equal(ftp.stats().connected, true);
  await ftp.list('/a');
  t.mock.timers.tick(59_000);
  assert.equal(ftp.stats().connected, true, 'activity restarts the countdown');
  t.mock.timers.tick(2_000);
  assert.equal(ftp.stats().connected, false);
  assert.deepEqual(log.closed, [1]);
  await ftp.list('/a');
  assert.equal(log.clients.length, 2, 'a later call reconnects');
  ftp.close();
});

test('the queue is bounded', async () => {
  const log = newLog();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ftp = createBomFtp({
    maxQueued: 2,
    clientFactory: async () =>
      fakeClient(log, { list: async () => (await gate, []) }),
  });
  const first = ftp.list('/a');
  const second = ftp.list('/b');
  await assert.rejects(ftp.list('/c'), { message: 'busy', status: 429 });
  release();
  await Promise.all([first, second]);
  assert.deepEqual(await ftp.list('/d'), []);
  ftp.close();
});

/** Replace the global timers with a registry so a test can see what is still pending. */
function trackTimers() {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const timers = new Set();
  globalThis.setTimeout = (callback, ms, ...args) => {
    const timer = {
      ms,
      unref() {
        return timer;
      },
    };
    timer.handle = realSet(() => {
      timers.delete(timer);
      callback(...args);
    }, ms);
    timers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer && typeof timer === 'object' && timers.delete(timer))
      realClear(timer.handle);
    else realClear(timer);
  };
  return {
    pending: () => [...timers],
    restore() {
      for (const timer of timers) realClear(timer.handle);
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    },
  };
}

test('shutdown closes the connection, clears the idle timer and refuses later operations', async () => {
  const timers = trackTimers();
  try {
    const log = newLog();
    const ftp = createBomFtp({
      idleMs: 60_000,
      clientFactory: async () => fakeClient(log),
    });
    await ftp.list('/a');
    assert.equal(ftp.stats().connected, true);
    assert.ok(
      timers.pending().some(({ ms }) => ms === 60_000),
      'the idle countdown is armed after the work',
    );
    ftp.shutdown();
    assert.deepEqual(log.closed, [1]);
    assert.equal(ftp.stats().connected, false);
    assert.equal(ftp.stats().closed, true);
    assert.deepEqual(timers.pending(), [], 'no timer outlives the session');
    await assert.rejects(ftp.list('/a'), /ftp_closed/);
    await assert.rejects(ftp.download('/a', 10), /ftp_closed/);
    assert.equal(
      log.clients.length,
      1,
      'no new client is built after shutdown',
    );
    assert.deepEqual(timers.pending(), []);
  } finally {
    timers.restore();
  }
});

test('shutdown abandons a login in progress and closes its client', async () => {
  const log = newLog();
  const ftp = createBomFtp({
    clientFactory: async () =>
      fakeClient(log, { access: () => new Promise(() => {}) }),
  });
  const pending = ftp.list('/a');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(log.access.length, 1);
  ftp.shutdown();
  await assert.rejects(pending, /ftp_closed/);
  assert.deepEqual(log.closed, [1]);
});

test('shutdown while a client is still being built discards it', async () => {
  const log = newLog();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ftp = createBomFtp({
    clientFactory: async () => {
      await gate;
      return fakeClient(log);
    },
  });
  const pending = ftp.list('/a');
  await new Promise((resolve) => setTimeout(resolve, 5));
  ftp.shutdown();
  release();
  await assert.rejects(pending, /ftp_closed/);
  assert.deepEqual(log.access, [], 'the late client never logs in');
  assert.deepEqual(log.closed, [1]);
});

test('operations queued behind a running one fail at shutdown instead of reconnecting', async () => {
  const log = newLog();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const ftp = createBomFtp({
    clientFactory: async () =>
      fakeClient(log, { list: async () => (await gate, []) }),
  });
  const first = ftp.list('/a');
  const second = ftp.list('/b');
  const third = ftp.download('/c', 10);
  await new Promise((resolve) => setTimeout(resolve, 5));
  ftp.shutdown();
  release();
  await assert.rejects(first, /ftp_closed/);
  await assert.rejects(second, /ftp_closed/);
  await assert.rejects(third, /ftp_closed/);
  assert.equal(log.clients.length, 1);
  assert.equal(
    log.events.filter((event) => event.startsWith('list')).length,
    1,
    'the queued list never ran',
  );
  assert.deepEqual(
    log.events.filter((event) => event.startsWith('download')),
    [],
  );
});
