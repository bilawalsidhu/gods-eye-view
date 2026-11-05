import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  createNtsbStore,
  normalizeNtsbTables,
  parseNtsbFileListing,
  unzipMdbEntry,
} from '../../server/providers/airAccidentsNtsb.js';

/** A one-entry deflated zip, as the NTSB publishes. */
function zipOf(name, contents) {
  const data = zlib.deflateRawSync(Buffer.from(contents));
  const nameBytes = Buffer.from(name, 'latin1');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);
  const dirAt = local.length + nameBytes.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(dirAt, 16);
  return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
}

const listingRow = (name, date) =>
  `<tr><td id="fileName">${name}</td>\n<td id="fileDate">${date}</td><td id="fileSize">1</td></tr>`;

test('the download page lists the full database and the weekly files', () => {
  const files = parseNtsbFileListing(
    listingRow('avall.zip', '11/1/2026 6:49:00 AM') +
      listingRow('up01NOV.zip', '11/1/2026 3:01:28 AM') +
      listingRow('up08NOV.zip', '11/8/2026 3:00:00 PM') +
      listingRow('codman.pdf', '1/1/2020 1:00:00 AM'),
  );
  assert.deepEqual(files, [
    { name: 'avall.zip', date: Date.UTC(2026, 10, 1, 6, 49, 0) },
    { name: 'up01NOV.zip', date: Date.UTC(2026, 10, 1, 3, 1, 28) },
    { name: 'up08NOV.zip', date: Date.UTC(2026, 10, 8, 15, 0, 0) },
  ]);
});

test('the zip entry unpacks to disk within the size cap', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntsb-zip-'));
  try {
    await fsp.writeFile(
      path.join(dir, 'a.zip'),
      zipOf('avall.mdb', 'database bytes'),
    );
    await unzipMdbEntry(path.join(dir, 'a.zip'), path.join(dir, 'a.mdb'), 1024);
    assert.equal(
      await fsp.readFile(path.join(dir, 'a.mdb'), 'utf8'),
      'database bytes',
    );
    await assert.rejects(
      unzipMdbEntry(path.join(dir, 'a.zip'), path.join(dir, 'b.mdb'), 4),
      /ntsb_mdb_too_large/,
    );
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

const EVENT = {
  ev_id: '20260921203845',
  ntsb_no: 'WPR26FA346',
  ev_type: 'ACC',
  ev_date: new Date(Date.UTC(2026, 8, 20)),
  ev_time: 2056,
  ev_tmzn: 'UTC',
  ev_city: 'Yosemite Valley',
  ev_state: 'CA',
  ev_country: 'USA',
  dec_latitude: 37.608092,
  dec_longitude: -119.59123,
  inj_tot_f: 2,
  inj_tot_s: 1,
};

test('every US accident and incident with a position is kept, technical facts only', () => {
  const { records, seen } = normalizeNtsbTables({
    events: [
      EVENT,
      { ...EVENT, ev_id: 'b', inj_tot_f: 0 },
      { ...EVENT, ev_id: 'c', ev_country: 'BR' },
      { ...EVENT, ev_id: 'd', dec_latitude: null },
      { ...EVENT, ev_id: 'e', ev_type: 'INC', inj_tot_f: 0 },
      { ...EVENT, ev_id: 'f', ev_type: 'OCC' },
    ],
    aircraft: [
      {
        ev_id: EVENT.ev_id,
        Aircraft_Key: 1,
        regis_no: 'N332N',
        acft_make: 'AIRBUS',
        acft_model: 'AS332',
        acft_year: 1994,
        damage: 'DEST',
        far_part: 'PUBU',
        dprt_city: 'Oakhurst',
        oper_name: 'Some Person',
        // Columns the reader never asks for; even if present they stay out.
        owner_acft: 'Private Owner',
        owner_street: '1 Main St',
      },
    ],
  });
  assert.deepEqual(seen, [EVENT.ev_id, 'b', 'c', 'd', 'e', 'f']);
  // Accidents without deaths stay and incidents read as serious incidents;
  // foreign, unplaced and other rows go.
  assert.deepEqual(
    records.map((row) => [row.id, row.kind, row.fatalities]),
    [
      [`ntsb:${EVENT.ev_id}`, 'accident', 2],
      ['ntsb:b', 'accident', 0],
      ['ntsb:e', 'serious-incident', 0],
    ],
  );
  const [record] = records;
  assert.equal(record.id, 'ntsb:20260921203845');
  assert.equal(record.date, '2026-09-20');
  assert.equal(record.time, '20:56');
  assert.equal(record.timeZone, 'UTC');
  assert.equal(record.fatalities, 2);
  assert.equal(record.injuries, 1);
  assert.equal(record.report, 'WPR26FA346');
  assert.equal(record.origin, 'Oakhurst');
  assert.deepEqual(record.aircraft[0], {
    registration: 'N332N',
    category: null,
    maker: 'AIRBUS',
    model: 'AS332',
    icaoType: null,
    year: 1994,
    phase: null,
    operation: 'PUBU',
    damage: 'DEST',
  });
  // Operators are named only for airline (Part 121) flights.
  assert.equal(record.operator, null);
  const text = JSON.stringify(records);
  for (const value of ['Some Person', 'Private Owner', '1 Main St'])
    assert.equal(text.includes(value), false);
});

test('the store builds once from avall, then applies only newer weekly files', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ntsb-store-'));
  let listing =
    listingRow('avall.zip', '11/1/2026 6:00:00 AM') +
    listingRow('up01NOV.zip', '11/1/2026 3:00:00 AM') +
    listingRow('up08NOV.zip', '11/8/2026 3:00:00 AM');
  const downloads = [];
  const fetchImpl = async (url) => {
    if (url.endsWith('/FileDirectory')) return new Response(listing);
    const name = new URL(url).searchParams.get('fileID');
    downloads.push(name);
    return new Response(zipOf('x.mdb', name));
  };
  const record = (id, fatalities = 1) => ({
    id: `ntsb:${id}`,
    source: 'ntsb',
    fatalities,
  });
  // Each database "contains" its file name; the fake reader maps it to rows.
  const tables = {
    'avall.zip': { records: [record('a'), record('b')], seen: ['a', 'b'] },
    // Event b changes and no longer qualifies; c is new.
    'up08NOV.zip': { records: [record('c')], seen: ['b', 'c'] },
    'up15NOV.zip': { records: [record('d')], seen: ['d'] },
  };
  const readDatabase = async (mdbPath) =>
    tables[await fsp.readFile(mdbPath, 'utf8')];
  let built;
  const done = new Promise((resolve) => (built = resolve));
  const options = { fetchImpl, cacheDir: dir, readDatabase, onChange: built };
  try {
    const store = createNtsbStore(options);
    assert.equal(await store.records(), null, 'first build runs behind');
    await done;
    // up01NOV predates avall and is skipped; up08NOV is applied.
    assert.deepEqual(downloads, ['avall.zip', 'up08NOV.zip']);
    assert.deepEqual(
      (await store.records()).map((row) => row.id),
      ['ntsb:a', 'ntsb:c'],
    );
    // A restart reads the cache from disk and fetches only the new week.
    listing += listingRow('up15NOV.zip', '11/15/2026 3:00:00 AM');
    const restarted = createNtsbStore(options);
    assert.deepEqual(
      (await restarted.records()).map((row) => row.id),
      ['ntsb:a', 'ntsb:c', 'ntsb:d'],
    );
    assert.deepEqual(downloads, ['avall.zip', 'up08NOV.zip', 'up15NOV.zip']);
    const leftovers = (await fsp.readdir(dir)).filter(
      (name) => name !== 'ntsb.json',
    );
    assert.deepEqual(leftovers, [], 'temporary files are removed');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
