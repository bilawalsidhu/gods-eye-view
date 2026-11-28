import test from 'node:test';
import assert from 'node:assert/strict';
import * as store from './ais-store.js';
import { aisLiveProxy } from './ais-live.js';

const {
  AISSTREAM_CACHE_MAX,
  AISSTREAM_STALE_MS,
  aisStreamRows,
  ingestAisStreamEnvelope,
  readAisTrack,
} = store;

// One clock for the whole file, only ever moved forward. The store is module
// state shared by every test here, so each test starts by stepping past the
// retention window: every vessel an earlier test left behind has expired.
// Static entries without a vessel row never expire, so a test that leaves
// many of them uses a store of its own.
let now = Date.parse('2030-01-01T00:00:00Z');
const useClock = (t) => {
  now += AISSTREAM_STALE_MS + 60_000;
  t.mock.method(Date, 'now', () => now);
};

/** Message helpers bound to one store module instance. */
const feed = (target) => {
  const position = (mmsi, lat = 53.4, extraMetaData = {}) =>
    target.ingestAisStreamEnvelope({
      MessageType: 'PositionReport',
      Message: { PositionReport: { UserID: Number(mmsi), Sog: 10, Cog: 90 } },
      MetaData: {
        MMSI: mmsi,
        latitude: lat,
        longitude: 6.2,
        time_utc: new Date(now).toISOString(),
        ...extraMetaData,
      },
    });
  // No position in the header, so this never creates a vessel row by itself.
  const staticData = (mmsi, body) =>
    target.ingestAisStreamEnvelope({
      MessageType: 'ShipStaticData',
      Message: { ShipStaticData: { UserID: Number(mmsi), ...body } },
      MetaData: { MMSI: mmsi },
    });
  const rows = () => target.aisStreamRows(AISSTREAM_CACHE_MAX);
  const rowFor = (mmsi) => rows().find((row) => row.mmsi === mmsi);
  return { position, staticData, rows, rowFor };
};

const { position, staticData, rows, rowFor } = feed(store);
const mmsiAt = (index) => String(300000000 + index);

/** Fill the store to exactly the cap with vessels 0..cap-1, oldest first. */
const fillToCap = () => {
  for (let index = 0; index < AISSTREAM_CACHE_MAX; index++) {
    now += 1;
    position(mmsiAt(index));
  }
};

test('ingest leaves expired vessels to the timed prune', (t) => {
  useClock(t);
  store.pruneAisStreamCache();
  position('210000001');
  now += AISSTREAM_STALE_MS + 1;
  position('210000002');
  assert.equal(store.aisStreamCacheStats().vessels, 2);
  store.pruneAisStreamCache();
  assert.equal(store.aisStreamCacheStats().vessels, 1);
});

test('readers never see an expired vessel between timed prunes', (t) => {
  useClock(t);
  const mmsi = '211000001';
  position(mmsi, 53.4);
  now += 60_000;
  position(mmsi, 53.5);
  assert.equal(rowFor(mmsi).mmsi, mmsi);
  assert.equal(store.readAisTrack(mmsi).length, 2);

  // No prune and no other message: the entry is still in the maps.
  now += AISSTREAM_STALE_MS + 1;
  assert.equal(rowFor(mmsi), undefined);
  assert.deepEqual(store.readAisTrack(mmsi), []);
});

test('a vessel heard again after the retention window starts afresh, prune or not', (t) => {
  useClock(t);
  const mmsi = '211000004';
  staticData(mmsi, { Type: 70, Destination: 'HAMBURG' });
  position(mmsi, 53.4);
  now += 60_000;
  position(mmsi, 53.5);

  // Back before any prune ran: no old destination, no track across the gap.
  now += AISSTREAM_STALE_MS + 5_000;
  position(mmsi, 53.6);
  assert.equal(rowFor(mmsi).destination, '');
  assert.deepEqual(store.readAisTrack(mmsi), []);

  // A fresh static report reaching the expired row outlives the prune.
  now += AISSTREAM_STALE_MS + 5_000;
  staticData(mmsi, { Type: 70, Destination: 'NEWDEST' });
  store.pruneAisStreamCache();
  position(mmsi, 53.7);
  assert.equal(rowFor(mmsi).destination, 'NEWDEST');
});

test('a first fix older than the retention window never seeds a track', (t) => {
  useClock(t);
  const mmsi = '211000002';
  const old = new Date(now - AISSTREAM_STALE_MS - 60_000).toISOString();
  position(mmsi, 53.4, { time_utc: old });
  now += 60_000;
  position(mmsi, 53.5);
  assert.deepEqual(store.readAisTrack(mmsi), []);
});

test('past the cap the least recently updated vessel is evicted and its static entry kept', (t) => {
  useClock(t);
  store.pruneAisStreamCache();
  staticData(mmsiAt(0), { Type: 70, Destination: 'HAMBURG' });
  fillToCap();
  // Vessel 1 reports again, so it is no longer among the oldest.
  now += 1;
  position(mmsiAt(1));
  for (let index = 0; index < 3; index++) {
    now += 1;
    position(mmsiAt(AISSTREAM_CACHE_MAX + index));
    assert.equal(store.aisStreamCacheStats().vessels, AISSTREAM_CACHE_MAX);
  }

  const kept = new Set(rows().map((row) => row.mmsi));
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((index) => kept.has(mmsiAt(index))),
    [false, true, false, false, true],
  );
  for (let index = 0; index < 3; index++)
    assert.ok(kept.has(mmsiAt(AISSTREAM_CACHE_MAX + index)));

  // The evicted vessel's static entry waits for its next position.
  now += 1;
  position(mmsiAt(0));
  assert.equal(rowFor(mmsiAt(0)).type, '70');
  assert.equal(rowFor(mmsiAt(0)).destination, 'HAMBURG');
});

test('the timed prune drops expired vessels and their static entries', (t) => {
  useClock(t);
  store.pruneAisStreamCache();
  assert.deepEqual(store.aisStreamCacheStats(), {
    vessels: 0,
    statics: 0,
    tracks: 0,
    pendingTracks: 0,
  });

  const mmsi = '211000003';
  // Static data ahead of the first position must still reach the row, and
  // must survive a prune while it waits.
  staticData(mmsi, { Type: 70, Destination: 'HAMBURG' });
  store.pruneAisStreamCache();
  position(mmsi, 53.4);
  now += 60_000;
  position(mmsi, 53.5);
  assert.equal(rowFor(mmsi).type, '70');
  assert.equal(rowFor(mmsi).destination, 'HAMBURG');
  const live = store.aisStreamCacheStats();
  assert.deepEqual([live.vessels, live.statics, live.tracks], [1, 1, 1]);

  now += AISSTREAM_STALE_MS + 1;
  store.pruneAisStreamCache();
  const pruned = store.aisStreamCacheStats();
  assert.deepEqual(
    [pruned.vessels, pruned.statics, pruned.tracks, pruned.pendingTracks],
    [0, 0, 0, 0],
  );
  position(mmsi, 53.6);
  assert.equal(rowFor(mmsi).type, '');
});

test('the AIS watchdog tick prunes a silent cache and stops once the server closes', (t) => {
  useClock(t);
  store.pruneAisStreamCache();
  // Without a key the tick opens no socket.
  const key = process.env.AISSTREAM_API_KEY;
  delete process.env.AISSTREAM_API_KEY;
  t.after(() => {
    if (key !== undefined) process.env.AISSTREAM_API_KEY = key;
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const plugin = aisLiveProxy();
  t.after(() => plugin.closeBundle());
  plugin.configureServer({ middlewares: { use() {} } });

  position('211000005');
  now += AISSTREAM_STALE_MS + 1;
  t.mock.timers.tick(15_000);
  assert.equal(store.aisStreamCacheStats().vessels, 0);

  plugin.closeBundle();
  position('211000006');
  now += AISSTREAM_STALE_MS + 1;
  t.mock.timers.tick(30_000);
  assert.equal(store.aisStreamCacheStats().vessels, 1);
});

test('static entries that never get a position are capped in order of first arrival', async (t) => {
  useClock(t);
  const own = await import('./ais-store.js?static-cap');
  const { position, staticData, rowFor } = feed(own);
  for (let index = 0; index < AISSTREAM_CACHE_MAX + 5; index++)
    staticData(mmsiAt(index), { Type: 70 });
  // A vessel with a row keeps its static entry however old that entry is.
  position(mmsiAt(0));
  assert.equal(own.aisStreamCacheStats().statics, AISSTREAM_CACHE_MAX + 5);

  own.pruneAisStreamCache();
  assert.equal(own.aisStreamCacheStats().statics, AISSTREAM_CACHE_MAX);
  now += 1;
  position(mmsiAt(0));
  position(mmsiAt(3));
  position(mmsiAt(AISSTREAM_CACHE_MAX));
  assert.equal(rowFor(mmsiAt(0)).type, '70');
  assert.equal(rowFor(mmsiAt(3)).type, '');
  assert.equal(rowFor(mmsiAt(AISSTREAM_CACHE_MAX)).type, '70');
});

// ITU-R M.1371 encodes speed over ground in 0.1-knot units and course over
// ground in 0.1-degree units, reserving the top code of each field for "not
// available": SOG 1023 arrives as 102.3 knots and COG 3600 as 360 degrees.
// Both are finite numbers, so they reach consumers as ordinary readings unless
// the store rejects them here.
const positionReport = (mmsi, body) => ({
  MessageType: 'PositionReport',
  Message: { PositionReport: { UserID: Number(mmsi), ...body } },
  MetaData: {
    MMSI: mmsi,
    latitude: 53.40879,
    longitude: 6.19741,
    time_utc: '2026-09-17 20:00:00.000000000 +0000 UTC',
  },
});

test('speed over ground reported as unavailable is unknown, not 102.3 knots', () => {
  assert.equal(
    ingestAisStreamEnvelope(positionReport('244060365', { Sog: 102.3 })),
    true,
  );
  assert.equal(rowFor('244060365').speed, null);
});

test('course over ground reported as unavailable is unknown, not 360 degrees', () => {
  assert.equal(
    ingestAisStreamEnvelope(positionReport('245382000', { Cog: 360 })),
    true,
  );
  assert.equal(rowFor('245382000').course, null);
});

test('genuine speed and course readings survive the unavailable check', () => {
  ingestAisStreamEnvelope(
    positionReport('341260000', { Sog: 12.9, Cog: 74.6 }),
  );
  const row = rowFor('341260000');
  assert.equal(row.speed, 12.9);
  assert.equal(row.course, 74.6);
});

test('a stopped vessel keeps its zero speed and zero course', () => {
  ingestAisStreamEnvelope(positionReport('244374235', { Sog: 0, Cog: 0 }));
  const row = rowFor('244374235');
  assert.equal(row.speed, 0);
  assert.equal(row.course, 0);
});

test('the fastest encodable reading below the unavailable code is kept', () => {
  ingestAisStreamEnvelope(
    positionReport('244060366', { Sog: 102.2, Cog: 359.9 }),
  );
  const row = rowFor('244060366');
  assert.equal(row.speed, 102.2);
  assert.equal(row.course, 359.9);
});

test('a static data report keeps the motion and fix time of a tracked vessel', () => {
  ingestAisStreamEnvelope(
    positionReport('244690000', { Sog: 12.4, Cog: 86.7, TrueHeading: 87 }),
  );
  // AISStream's MetaData carries the last known position on every message,
  // static data included.
  assert.equal(
    ingestAisStreamEnvelope({
      MessageType: 'ShipStaticData',
      Message: {
        ShipStaticData: {
          UserID: 244690000,
          Name: 'EXAMPLE VESSEL',
          Type: 70,
          Destination: 'ROTTERDAM',
          ImoNumber: 9876543,
        },
      },
      MetaData: {
        MMSI: '244690000',
        latitude: 53.40879,
        longitude: 6.19741,
        time_utc: '2026-09-17 20:05:00.000000000 +0000 UTC',
      },
    }),
    true,
  );
  const row = rowFor('244690000');
  assert.equal(row.speed, 12.4);
  assert.equal(row.course, 86.7);
  assert.equal(row.heading, 87);
  assert.equal(row.last_position_UTC, '2026-09-17T20:00:00.000Z');
  assert.equal(row.destination, 'ROTTERDAM');
  assert.equal(row.imo, '9876543');
});

// AISStream carries both Class B parts; the unused part has Valid: false.
const classBStatic = (part, value) => ({
  MessageID: 24,
  RepeatIndicator: 0,
  Valid: true,
  Reserved: 0,
  PartNumber: part === 'B',
  ReportA: { Valid: part === 'A', Name: part === 'A' ? value : '' },
  ReportB: {
    Valid: part === 'B',
    ShipType: part === 'B' ? value : 0,
    VendorIDName: '',
    VenderIDModel: 0,
    VenderIDSerial: 0,
    CallSign: '',
    Dimension: { A: 0, B: 0, C: 0, D: 0 },
    FixType: 0,
    Spare: 0,
  },
});

for (const [index, scenario] of [
  {
    type: 'ShipStaticData',
    initial: [
      {
        Name: 'OLD VESSEL',
        Type: 70,
        Destination: 'ROTTERDAM',
        ImoNumber: 9876543,
      },
    ],
    updates: [
      {
        Name: 'NEW VESSEL',
        Type: 80,
        Destination: 'HAMBURG',
        ImoNumber: 9876544,
      },
    ],
    empty: { Name: ' ', Type: 0, Destination: '', ImoNumber: 0 },
    expected: {
      name: 'NEW VESSEL',
      type: '80',
      destination: 'HAMBURG',
      imo: '9876544',
    },
  },
  {
    type: 'StaticDataReport',
    initial: [classBStatic('A', 'OLD VESSEL'), classBStatic('B', 36)],
    updates: [classBStatic('A', 'NEW VESSEL'), classBStatic('B', 37)],
    empty: classBStatic('A', ''),
    expected: { name: 'NEW VESSEL', type: '37', destination: '', imo: '' },
  },
].entries()) {
  test(`${scenario.type} replaces static fields without inventing a position fix`, (t) => {
    const mmsi = String(244690100 + index);
    const start = Date.parse('2026-09-17T20:00:00Z');
    let now = start;
    t.mock.method(Date, 'now', () => now);
    const position = (
      lat,
      body = { Sog: 12.4, Cog: 86.7, TrueHeading: 87 },
    ) => {
      const envelope = positionReport(mmsi, body);
      Object.assign(envelope.MetaData, {
        latitude: lat,
        time_utc: new Date(now).toISOString(),
      });
      return ingestAisStreamEnvelope(envelope);
    };
    const sendStatic = (body) =>
      ingestAisStreamEnvelope({
        MessageType: scenario.type,
        Message: { [scenario.type]: { UserID: Number(mmsi), ...body } },
        MetaData: {
          MMSI: mmsi,
          ShipName: 'STALE HEADER',
          latitude: 54,
          longitude: 7,
          time_utc: new Date(now).toISOString(),
        },
      });
    position(53.40879);
    for (const body of scenario.initial) assert.equal(sendStatic(body), true);
    now += 60_000;
    position(53.41879);
    const before = rowFor(mmsi);
    const track = readAisTrack(mmsi);
    assert.equal(track.length, 2);

    now += 5 * 60_000;
    for (const body of scenario.updates) assert.equal(sendStatic(body), true);
    assert.deepEqual(rowFor(mmsi), { ...before, ...scenario.expected });
    assert.deepEqual(readAisTrack(mmsi), track);

    // Empty or omitted static fields must not erase known metadata, including
    // the cached values used when the next actual position arrives.
    assert.equal(sendStatic(scenario.empty), true);
    assert.deepEqual(rowFor(mmsi), { ...before, ...scenario.expected });
    assert.deepEqual(readAisTrack(mmsi), track);
    if (scenario.type === 'StaticDataReport') {
      sendStatic({
        ...classBStatic('A', ''),
        ReportA: { Valid: false, Name: 'INVALID NAME' },
        ReportB: { ...classBStatic('B', 99).ReportB, Valid: false },
      });
      assert.deepEqual(rowFor(mmsi), { ...before, ...scenario.expected });
    }
    now = start + 60_000 + AISSTREAM_STALE_MS + 1;
    assert.equal(
      rowFor(mmsi),
      undefined,
      'static traffic must not renew position freshness',
    );
    // Heard again after the retention window, the vessel starts afresh: its
    // static values and its track went with the expired row.
    position(53.42879, { Sog: 0, Cog: 0, TrueHeading: 0 });
    const next = rowFor(mmsi);
    assert.equal(next.name, `MMSI ${mmsi}`);
    assert.equal(next.type, '');
    assert.equal(next.destination, '');
    assert.equal(next.imo, '');
    assert.equal(next.speed, 0);
    assert.equal(next.course, 0);
    assert.equal(next.heading, 0);
    assert.equal(next.last_position_epoch, Math.floor(now / 1000));
    assert.deepEqual(readAisTrack(mmsi), []);
  });
}

test('partial static data keeps newer live metadata ahead of the old static cache', () => {
  const mmsi = '244690200';
  const staticReport = (body) => ({
    MessageType: 'ShipStaticData',
    Message: { ShipStaticData: { UserID: Number(mmsi), ...body } },
    MetaData: { MMSI: mmsi },
  });
  ingestAisStreamEnvelope(staticReport({ Name: 'OLD VESSEL', Type: 70 }));
  const extended = positionReport(mmsi, {});
  extended.MessageType = 'ExtendedClassBPositionReport';
  extended.Message = {
    ExtendedClassBPositionReport: {
      UserID: Number(mmsi),
      Type: 80,
      Sog: 12,
      Cog: 86,
    },
  };
  extended.MetaData.ShipName = 'NEW VESSEL';
  ingestAisStreamEnvelope(extended);
  const before = rowFor(mmsi);
  ingestAisStreamEnvelope(staticReport({ Destination: 'HAMBURG' }));
  assert.deepEqual(rowFor(mmsi), { ...before, destination: 'HAMBURG' });
  ingestAisStreamEnvelope(positionReport(mmsi, { Sog: 12, Cog: 86 }));
  assert.equal(rowFor(mmsi).name, 'NEW VESSEL');
  assert.equal(rowFor(mmsi).type, '80');
  assert.equal(rowFor(mmsi).destination, 'HAMBURG');
});

// A static report's dimensions are the antenna's distances to bow (A), stern
// (B), port (C) and starboard (D): length A+B, beam C+D. Zero is AIS's "not
// available", so a vessel reporting none has no size, not a size of zero.
test('a static report gives a vessel its hull length and beam', () => {
  ingestAisStreamEnvelope(positionReport('636019825', { Sog: 14 }));
  ingestAisStreamEnvelope({
    MessageType: 'ShipStaticData',
    Message: {
      ShipStaticData: {
        UserID: 636019825,
        Name: 'EVER GIVEN',
        Type: 70,
        Dimension: { A: 330, B: 70, C: 30, D: 29 },
      },
    },
    MetaData: { MMSI: '636019825' },
  });
  const row = rowFor('636019825');
  assert.equal(row.length, 400);
  assert.equal(row.beam, 59);

  ingestAisStreamEnvelope(positionReport('636019826', { Sog: 3 }));
  ingestAisStreamEnvelope({
    MessageType: 'ShipStaticData',
    Message: {
      ShipStaticData: {
        UserID: 636019826,
        Type: 52,
        Dimension: { A: 0, B: 0, C: 0, D: 0 },
      },
    },
    MetaData: { MMSI: '636019826' },
  });
  assert.equal(rowFor('636019826').length, null);
  assert.equal(rowFor('636019826').beam, null);
});

test('a Class B report carries its dimensions in part B', () => {
  ingestAisStreamEnvelope(positionReport('244000777', { Sog: 6 }));
  ingestAisStreamEnvelope({
    MessageType: 'StaticDataReport',
    Message: {
      StaticDataReport: {
        UserID: 244000777,
        ReportB: {
          Valid: true,
          ShipType: 37,
          Dimension: { A: 8, B: 4, C: 2, D: 2 },
        },
      },
    },
    MetaData: { MMSI: '244000777' },
  });
  const row = rowFor('244000777');
  assert.equal(row.length, 12);
  assert.equal(row.beam, 4);
});

test('an aid-to-navigation report is a row named by its kind of aid, not a ship type', () => {
  assert.equal(
    ingestAisStreamEnvelope({
      MessageType: 'AidsToNavigationReport',
      Message: {
        AidsToNavigationReport: {
          UserID: 993672001,
          Type: 20,
          Name: 'SF APPROACH N',
        },
      },
      MetaData: {
        MMSI: '993672001',
        latitude: 37.79,
        longitude: -122.52,
        time_utc: '2026-09-17 20:00:00.000000000 +0000 UTC',
      },
    }),
    true,
  );
  const row = rowFor('993672001');
  assert.equal(row.type, 'Cardinal Mark N');
  assert.equal(row.name, 'SF APPROACH N');
  assert.equal(row.speed, null);
});

test("an aid's name runs on into its name extension", () => {
  ingestAisStreamEnvelope({
    MessageType: 'AidsToNavigationReport',
    Message: {
      AidsToNavigationReport: {
        UserID: 993672002,
        Type: 13,
        Name: 'SAN FRANCISCO MAIN S',
        NameExtension: 'HIP CHANNEL 2',
      },
    },
    MetaData: {
      MMSI: '993672002',
      ShipName: 'SAN FRANCISCO MAIN S',
      latitude: 37.79,
      longitude: -122.52,
      time_utc: '2026-09-17 20:00:00.000000000 +0000 UTC',
    },
  });
  assert.equal(rowFor('993672002').name, 'SAN FRANCISCO MAIN SHIP CHANNEL 2');
});

test('a capped row request keeps every vessel ahead of aids to navigation', () => {
  // The aid reports last, so it is the newest row.
  ingestAisStreamEnvelope(positionReport('244060901', { Sog: 3 }));
  ingestAisStreamEnvelope({
    MessageType: 'AidsToNavigationReport',
    Message: { AidsToNavigationReport: { UserID: 993672003, Type: 24 } },
    MetaData: {
      MMSI: '993672003',
      latitude: 37.79,
      longitude: -122.52,
      time_utc: '2026-09-17 20:00:00.000000000 +0000 UTC',
    },
  });
  const rows = aisStreamRows(50000);
  const firstAid = rows.findIndex((row) => row.mmsi.startsWith('99'));
  const lastVessel = rows.findLastIndex((row) => !row.mmsi.startsWith('99'));
  assert.ok(firstAid > lastVessel, `${firstAid} > ${lastVessel}`);
  const vesselCount =
    rows.length - rows.filter((row) => row.mmsi.startsWith('99')).length;
  assert.ok(
    aisStreamRows(vesselCount).every((row) => !row.mmsi.startsWith('99')),
  );
});

test('a virtual aid to navigation is marked virtual; a real one carries no flag', () => {
  const aidReport = (mmsi, VirtualAtoN) => ({
    MessageType: 'AidsToNavigationReport',
    Message: {
      AidsToNavigationReport: { UserID: Number(mmsi), Type: 28, VirtualAtoN },
    },
    MetaData: {
      MMSI: mmsi,
      latitude: 37.79,
      longitude: -122.52,
      time_utc: '2026-09-17 20:00:00.000000000 +0000 UTC',
    },
  });
  ingestAisStreamEnvelope(aidReport('993672004', true));
  ingestAisStreamEnvelope(aidReport('993672005', false));
  assert.equal(rowFor('993672004').virtual, true);
  assert.equal('virtual' in rowFor('993672005'), false);
  // A later real report of the same aid drops the flag.
  ingestAisStreamEnvelope(aidReport('993672004', false));
  assert.equal('virtual' in rowFor('993672004'), false);
});
