import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AISSTREAM_STALE_MS,
  aisStreamRows,
  ingestAisStreamEnvelope,
  readAisTrack,
} from '../../server/providers/vessels/ais-store.js';

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

const rowFor = (mmsi) => aisStreamRows(50000).find((row) => row.mmsi === mmsi);

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
    position(53.42879, { Sog: 0, Cog: 0, TrueHeading: 0 });
    const next = rowFor(mmsi);
    for (const [key, value] of Object.entries(scenario.expected))
      assert.equal(next[key], value, key);
    assert.equal(next.speed, 0);
    assert.equal(next.course, 0);
    assert.equal(next.heading, 0);
    assert.equal(next.last_position_epoch, Math.floor(now / 1000));
    assert.equal(readAisTrack(mmsi).length, 3);
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
