import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIRI_VM_MAX_ACTIVITIES,
  SiriVmFormatError,
  decodeSiriVehicleMonitoring,
  parseIsoDurationSec,
  parseSiriVmXml,
} from './railSiriVm.js';
import { buildRailSnapshot } from './railProxy.js';
import { getRegisteredRailFeed } from './railFeeds.js';

const NOW_S = Date.parse('2026-11-09T16:27:00Z') / 1000;

/** One `<VehicleActivity>`, shaped like Entur's SIRI Lite answer. */
function activity({
  recorded = '2026-11-09T17:26:17+01:00',
  validUntil = '2026-11-09T17:29:17+01:00',
  line = 'SJN:Line:25',
  lat = '63.42107333333333',
  lon = '10.377486666666666',
  delay = 'PT0S',
  journey = 'SJN:DatedServiceJourney:2388_ROS-HMR_26-11-09',
  vehicle = '957605930081',
  extra = '',
} = {}) {
  return `<VehicleActivity><RecordedAtTime>${recorded}</RecordedAtTime><ValidUntilTime>${validUntil}</ValidUntilTime><MonitoredVehicleJourney><LineRef>${line}</LineRef><DataSource>SJN</DataSource>${extra}<VehicleLocation><Longitude>${lon}</Longitude><Latitude>${lat}</Latitude></VehicleLocation><Delay>${delay}</Delay><VehicleJourneyRef>${journey}</VehicleJourneyRef><VehicleRef>${vehicle}</VehicleRef></MonitoredVehicleJourney></VehicleActivity>`;
}

function document(...activities) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Siri xmlns="http://www.siri.org.uk/siri" version="2.0"><ServiceDelivery><ResponseTimestamp>2026-11-09T17:26:46.11584667+01:00</ResponseTimestamp><ProducerRef>ENT</ProducerRef><VehicleMonitoringDelivery version="2.0"><ResponseTimestamp>2026-11-09T17:26:46.115848853+01:00</ResponseTimestamp>${activities.join('')}</VehicleMonitoringDelivery></ServiceDelivery></Siri>`;
}

test('SIRI delays are ISO 8601 durations', () => {
  assert.equal(parseIsoDurationSec('PT0S'), 0);
  assert.equal(parseIsoDurationSec('PT2M30S'), 150);
  assert.equal(parseIsoDurationSec('-PT45S'), -45);
  assert.equal(parseIsoDurationSec('PT1H'), 3600);
  assert.equal(parseIsoDurationSec('P1DT1M'), 86_460);
  assert.equal(parseIsoDurationSec('PT1.6S'), 2);
  assert.equal(parseIsoDurationSec('P'), null);
  assert.equal(parseIsoDurationSec('soon'), null);
  assert.equal(parseIsoDurationSec(null), null);
});

test('a vehicle activity becomes a train record with its own report time', () => {
  const decoded = decodeSiriVehicleMonitoring(
    document(activity({ delay: 'PT3M' })),
    NOW_S,
  );
  assert.equal(decoded.entityCount, 1);
  assert.equal(decoded.truncated, false);
  assert.equal(
    decoded.feedTimestamp,
    Math.floor(Date.parse('2026-11-09T16:26:46.115Z') / 1000),
  );
  assert.deepEqual(decoded.vehicles, [
    {
      id: '957605930081',
      lat: 63.421073,
      lon: 10.377487,
      bearing: null,
      speedMps: null,
      timestamp: Date.parse('2026-11-09T16:26:17Z') / 1000,
      timestampSource: 'vehicle',
      routeId: 'SJN:Line:25',
      tripId: 'SJN:DatedServiceJourney:2388_ROS-HMR_26-11-09',
      directionId: null,
      label: null,
      stopId: null,
      status: null,
      occupancy: null,
      delaySec: 180,
    },
  ]);
});

test('buses, expired reports, bad positions and duplicates are dropped', () => {
  const decoded = decodeSiriVehicleMonitoring(
    document(
      activity({ vehicle: 'bus', extra: '<VehicleMode>bus</VehicleMode>' }),
      activity({ vehicle: 'rail', extra: '<VehicleMode>rail</VehicleMode>' }),
      activity({ vehicle: 'old', validUntil: '2026-11-09T17:20:00+01:00' }),
      activity({ vehicle: 'nowhere', lat: '0', lon: '0' }),
      activity({ vehicle: 'twice', recorded: '2026-11-09T17:25:00+01:00' }),
      activity({ vehicle: 'twice', recorded: '2026-11-09T17:26:00+01:00' }),
      activity({ vehicle: 'bad id!' }),
    ),
    NOW_S,
  );
  assert.equal(decoded.entityCount, 7);
  assert.deepEqual(
    decoded.vehicles.map((v) => v.id),
    ['rail', 'twice'],
  );
  assert.equal(
    decoded.vehicles[1].timestamp,
    Date.parse('2026-11-09T16:26:00Z') / 1000,
    'the later of two reports',
  );
});

test('a report without a time takes the fetch time, labelled so', () => {
  const xml = document(activity()).replace(
    /<RecordedAtTime>[^<]*<\/RecordedAtTime>/,
    '',
  );
  const [train] = decodeSiriVehicleMonitoring(xml, NOW_S).vehicles;
  assert.equal(train.timestamp, NOW_S);
  assert.equal(train.timestampSource, 'fetch');
});

test('namespace prefixes, bearings and published line names are read', () => {
  const xml = document(
    activity({ extra: '<Bearing>91.5</Bearing>' }).replace(
      /<(\/?)(VehicleActivity|LineRef|Latitude|Longitude)>/g,
      '<$1siri:$2>',
    ),
  ).replace(
    '<VehicleJourneyRef>',
    '<PublishedLineName>F6</PublishedLineName><VehicleJourneyRef>',
  );
  const [train] = decodeSiriVehicleMonitoring(xml, NOW_S).vehicles;
  assert.equal(train.routeId, 'SJN:Line:25');
  assert.equal(train.bearing, 91.5);
  assert.equal(train.label, 'F6');
});

test('documents that are not vehicle monitoring, or declare a DTD, are refused', () => {
  assert.throws(() => parseSiriVmXml(42), SiriVmFormatError);
  assert.throws(
    () => parseSiriVmXml('<html><body>Bad gateway</body></html>'),
    SiriVmFormatError,
  );
  assert.throws(
    () =>
      parseSiriVmXml(`<!DOCTYPE x [<!ENTITY a "b">]>${document(activity())}`),
    SiriVmFormatError,
  );
  assert.equal(parseSiriVmXml(document()).rows.length, 0);
});

test('the activity count is capped', () => {
  const many = Array.from(
    { length: SIRI_VM_MAX_ACTIVITIES + 2 },
    (_, i) =>
      `<VehicleActivity><VehicleRef>v${i}</VehicleRef></VehicleActivity>`,
  );
  const parsed = parseSiriVmXml(document(...many));
  assert.equal(parsed.rows.length, SIRI_VM_MAX_ACTIVITIES);
  assert.equal(parsed.truncated, true);
});

test('the rail proxy reads SJ Nord from SIRI VM and classifies its lines', () => {
  const feed = getRegisteredRailFeed('entur-sj-nord');
  assert.equal(feed.format, 'siri-vm');
  const bytes = new TextEncoder().encode(
    document(
      activity({ vehicle: 'a', line: 'SJN:Line:25' }),
      activity({ vehicle: 'b', line: 'SJN:Line:26' }),
      activity({ vehicle: 'c', line: 'SJN:Line:72' }),
      activity({ vehicle: 'd', line: 'SJN:Line:999' }),
    ),
  );
  const snapshot = buildRailSnapshot(feed, bytes, NOW_S * 1000);
  assert.equal(snapshot.positions, 'gps');
  assert.equal(snapshot.entityCount, 4);
  assert.equal(snapshot.dropped, 1, 'an unknown line');
  assert.deepEqual(
    snapshot.trains.map((t) => [t.id, t.category, t.positionSource]),
    [
      ['a', 'national', 'gps'],
      ['b', 'regional', 'gps'],
      ['c', 'international', 'gps'],
    ],
  );
  assert.ok(Number.isFinite(snapshot.feedTimestamp));
  assert.throws(
    () => buildRailSnapshot(feed, new TextEncoder().encode('<html/>'), 0),
    (error) => error.code === 'UPSTREAM_UNREADABLE',
  );
});
