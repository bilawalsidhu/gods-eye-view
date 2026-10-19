import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import {
  MICTRONICS_DB_URL,
  REFRESH_MS,
  RETRY_MS,
  MAX_IDS,
  aircraftTypesProxy,
  buildTypeIndex,
  createAircraftTypeDatabase,
  parseTypeDatabase,
  readableTypeName,
} from './types.js';

const AIRCRAFTS = {
  A835AF: ['N628TS', 'GLF6', '00'],
  '3C6444': ['D-AIBD', 'A319', '00'],
  '406A93': ['G-EZWS', 'A320', '00'],
  '00900B': ['ZS-GBI', 'GLID', '00', 'Jonker Sailplanes'],
  ABCDEF: ['N1', '', '00'], // no type designator: left out
  '4B1': ['HB-X', 'A320', '00'], // not a 24-bit address: left out
  AE0001: ['', 'C17', '10'], // no registration
};
const TYPES = {
  GLF6: ['GULFSTREAM AEROSPACE G-650', 'L2J', 'M'],
  A319: ['AIRBUS A-319', 'L2J', 'M'],
  A320: ['AIRBUS A-320', 'L2J', 'M'],
};

/** A zip of deflated entries, as the Mictronics export is published. */
function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, eocd]));
}

const EXPORT = zipOf({
  'dbversion.json': '{"version":527}',
  'aircrafts.json': JSON.stringify(AIRCRAFTS),
  'types.json': JSON.stringify(TYPES),
});

/** An in-memory stand-in for node:fs/promises. */
function memoryFs(files = {}) {
  const store = new Map(Object.entries(files));
  return {
    store,
    async mkdir() {},
    async writeFile(path, bytes) {
      store.set(path, { bytes: Buffer.from(bytes), mtimeMs: 0 });
    },
    async readFile(path) {
      if (!store.has(path))
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return store.get(path).bytes;
    },
    async stat(path) {
      if (!store.has(path))
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { mtimeMs: store.get(path).mtimeMs };
    },
  };
}

function fetchReturning(...responses) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

const ok = () => new Response(EXPORT, { status: 200 });

/** Let background work run until `check` holds (bounded). */
async function waitFor(check) {
  for (let i = 0; i < 200 && !check(); i += 1)
    await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check(), 'background work did not finish');
}

test('the index answers type, name and registration by address, any case', () => {
  const index = buildTypeIndex(AIRCRAFTS, TYPES);
  assert.equal(index.size, 5);
  assert.deepEqual(index.lookup('a835af'), {
    typeCode: 'GLF6',
    typeName: 'Gulfstream Aerospace G-650',
    registration: 'N628TS',
  });
  assert.deepEqual(index.lookup('3C6444'), {
    typeCode: 'A319',
    typeName: 'Airbus A-319',
    registration: 'D-AIBD',
  });
  // First and last rows in sorted order, a type with no name, no registration.
  assert.equal(index.lookup('00900b').registration, 'ZS-GBI');
  assert.equal(index.lookup('00900b').typeName, null);
  assert.deepEqual(index.lookup('ae0001'), {
    typeCode: 'C17',
    typeName: null,
    registration: null,
  });
  assert.equal(index.lookup('abcdef'), null, 'no type designator');
  assert.equal(index.lookup('123456'), null, 'unknown address');
  assert.equal(index.lookup('zzzzzz'), null, 'not hex');
  assert.equal(index.lookup(undefined), null);
});

test('type names read as names, abbreviations kept', () => {
  const cases = {
    'BOEING 737-800': 'Boeing 737-800',
    'BOEING 737 MAX 8': 'Boeing 737 MAX 8',
    'DE HAVILLAND DHC-8-400 Dash 8': 'de Havilland DHC-8-400 Dash 8',
    'MCDONNELL-DOUGLAS MD-11': 'McDonnell-Douglas MD-11',
    'ANTONOV An-124 Ruslan': 'Antonov An-124 Ruslan',
    'ATR-72-600': 'ATR-72-600',
    'AIR TRACTOR AT-802': 'Air Tractor AT-802',
    'IAI Westwind': 'IAI Westwind',
    ' EMBRAER ERJ-170-200 (long wing) ': 'Embraer ERJ-170-200 (long wing)',
  };
  for (const [raw, readable] of Object.entries(cases))
    assert.equal(readableTypeName(raw), readable, raw);
});

test('the export is read from its zip, and an empty one is refused', async () => {
  const index = await parseTypeDatabase(EXPORT);
  assert.equal(index.lookup('406a93').typeCode, 'A320');
  await assert.rejects(
    parseTypeDatabase(zipOf({ 'aircrafts.json': '{}', 'types.json': '{}' })),
    /no entries/,
  );
});

test('a first start answers at once, then downloads once and keeps it on disk', async () => {
  const fs = memoryFs();
  const { calls, fetchImpl } = fetchReturning(ok());
  const database = createAircraftTypeDatabase({
    fetchImpl,
    fs,
    cachePath: '/cache/db.zip',
    now: () => 1_000,
  });
  assert.equal(database.current(), null, 'nothing waits for the download');
  const index = await database.loaded();
  assert.equal(index.lookup('a835af').typeCode, 'GLF6');
  assert.equal(database.current(), index);
  assert.deepEqual(calls, [MICTRONICS_DB_URL]);
  assert.ok(fs.store.has('/cache/db.zip'));
  database.current();
  await database.loaded();
  assert.equal(calls.length, 1, 'a fresh copy is not downloaded again');
});

test('a fresh disk copy is used without downloading', async () => {
  const fs = memoryFs({
    '/cache/db.zip': { bytes: Buffer.from(EXPORT), mtimeMs: 5_000 },
  });
  const { calls, fetchImpl } = fetchReturning();
  const database = createAircraftTypeDatabase({
    fetchImpl,
    fs,
    cachePath: '/cache/db.zip',
    now: () => 5_000 + REFRESH_MS - 1,
  });
  assert.equal((await database.loaded()).lookup('3c6444').typeCode, 'A319');
  assert.deepEqual(calls, []);
});

test('a week-old copy is served while the refresh runs, then replaced', async () => {
  const oldExport = zipOf({
    'aircrafts.json': JSON.stringify({ A835AF: ['N628TS', 'GLF5', '00'] }),
    'types.json': '{}',
  });
  const fs = memoryFs({
    '/cache/db.zip': { bytes: Buffer.from(oldExport), mtimeMs: 0 },
  });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const calls = [];
  const database = createAircraftTypeDatabase({
    fetchImpl: async (url) => {
      calls.push(url);
      await gate;
      return ok();
    },
    fs,
    cachePath: '/cache/db.zip',
    now: () => REFRESH_MS + 1,
  });
  const done = database.loaded();
  await waitFor(() => calls.length === 1);
  assert.equal(database.current().lookup('a835af').typeCode, 'GLF5');
  release();
  assert.equal((await done).lookup('a835af').typeCode, 'GLF6');
  assert.equal(calls.length, 1, 'one download');
});

test('a failed refresh keeps the current copy and waits before retrying', async () => {
  const fs = memoryFs({
    '/cache/db.zip': { bytes: Buffer.from(EXPORT), mtimeMs: 0 },
  });
  let clock = REFRESH_MS + 1;
  const { calls, fetchImpl } = fetchReturning(
    new Response('', { status: 503 }),
    ok(),
  );
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    const database = createAircraftTypeDatabase({
      fetchImpl,
      fs,
      cachePath: '/cache/db.zip',
      now: () => clock,
    });
    assert.equal((await database.loaded()).lookup('a835af').typeCode, 'GLF6');
    assert.equal(calls.length, 1);
    assert.match(warnings[0], /keeping the current copy: .*HTTP 503/);
    assert.equal(database.retryInMs(), RETRY_MS);
    database.current();
    await database.loaded();
    assert.equal(calls.length, 1, 'no retry inside the retry window');
    clock += RETRY_MS;
    database.current();
    await database.loaded();
    assert.equal(calls.length, 2);
  } finally {
    console.warn = warn;
  }
});

test('with no copy and no download, the database has nothing to serve', async () => {
  const { calls, fetchImpl } = fetchReturning(new Error('offline'));
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    const database = createAircraftTypeDatabase({
      fetchImpl,
      fs: memoryFs(),
      cachePath: '/cache/db.zip',
      now: () => 1,
    });
    assert.equal(await database.loaded(), null);
    assert.match(warnings[0], /download failed: offline/);
    assert.equal(database.current(), null);
    await database.loaded();
    assert.equal(calls.length, 1, 'the retry waits for the retry window');
  } finally {
    console.warn = warn;
  }
});

test('an unreadable disk copy is replaced by a download', async () => {
  const fs = memoryFs({
    '/cache/db.zip': { bytes: Buffer.from('not a zip'), mtimeMs: 1 },
  });
  const { calls, fetchImpl } = fetchReturning(ok());
  const warn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    const database = createAircraftTypeDatabase({
      fetchImpl,
      fs,
      cachePath: '/cache/db.zip',
      now: () => 2,
    });
    assert.equal((await database.loaded()).lookup('a835af').typeCode, 'GLF6');
    assert.equal(calls.length, 1);
    assert.match(warnings[0], /unreadable disk copy; downloading: not a zip/);
  } finally {
    console.warn = warn;
  }
});

/** Drive the plugin's middleware with a JSON body. */
async function call(plugin, { method = 'POST', body } = {}) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(path, fn) {
        assert.equal(path, '/api/aircraft-types');
        handler = fn;
      },
    },
  });
  const req = Readable.from(body == null ? [] : [Buffer.from(body)]);
  req.method = method;
  const res = {
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(text) {
      this.body = text ? JSON.parse(text) : null;
    },
  };
  await handler(req, res);
  return res;
}

/** A proxy over a database that has finished loading the export. */
async function proxyWithExport() {
  const database = createAircraftTypeDatabase({
    fetchImpl: async () => ok(),
    fs: memoryFs(),
    cachePath: '/cache/db.zip',
  });
  await database.loaded();
  return aircraftTypesProxy({ database });
}

test('the route answers known addresses with their type names', async () => {
  const res = await call(await proxyWithExport(), {
    body: JSON.stringify({ ids: ['A835AF', '3c6444', 'ae0001', '123456'] }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    aircraft: {
      a835af: ['GLF6', 'N628TS'],
      '3c6444': ['A319', 'D-AIBD'],
      ae0001: ['C17', null],
    },
    typeNames: {
      GLF6: 'Gulfstream Aerospace G-650',
      A319: 'Airbus A-319',
    },
  });
});

test('the route refuses other methods, malformed bodies and too many ids', async () => {
  const proxy = await proxyWithExport();
  const get = await call(proxy, { method: 'GET' });
  assert.equal(get.status, 405);
  assert.equal(get.headers.Allow, 'POST');
  assert.equal((await call(proxy, { body: 'not json' })).status, 400);
  assert.equal(
    (await call(proxy, { body: JSON.stringify({ ids: [1, 2] }) })).status,
    400,
  );
  const many = Array.from({ length: MAX_IDS + 1 }, () => 'a835af');
  assert.equal(
    (await call(proxy, { body: JSON.stringify({ ids: many }) })).status,
    400,
  );
  const huge = await call(proxy, {
    body: JSON.stringify({ ids: ['x'.repeat(MAX_IDS * 13)] }),
  });
  assert.equal(huge.status, 413);
});

test('the route never waits for loading: 503 loading, then answers', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const database = createAircraftTypeDatabase({
    fetchImpl: async () => {
      await gate;
      return ok();
    },
    fs: memoryFs(),
    cachePath: '/cache/db.zip',
  });
  const proxy = aircraftTypesProxy({ database });
  const body = JSON.stringify({ ids: ['a835af'] });
  const loading = await call(proxy, { body });
  assert.equal(loading.status, 503);
  assert.deepEqual(loading.body, { error: 'aircraft_types_loading' });
  assert.equal(loading.headers['Retry-After'], '5');
  release();
  await database.loaded();
  const answered = await call(proxy, { body });
  assert.deepEqual(answered.body.aircraft, { a835af: ['GLF6', 'N628TS'] });
});

test('after a failed download the route says unavailable until the retry', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const database = createAircraftTypeDatabase({
      fetchImpl: async () => new Response('', { status: 500 }),
      fs: memoryFs(),
      cachePath: '/cache/db.zip',
    });
    await database.loaded();
    const res = await call(aircraftTypesProxy({ database }), {
      body: JSON.stringify({ ids: ['a835af'] }),
    });
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: 'aircraft_types_unavailable' });
    assert.equal(res.headers['Retry-After'], String(RETRY_MS / 1000));
  } finally {
    console.warn = warn;
  }
});
