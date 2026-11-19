import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IRISH_RAIL_MAX_TEXT_CHARS,
  IRISH_RAIL_MAX_TRAINS,
  IrishRailFormatError,
  decodeIrishRailTrains,
  decodeXmlText,
  parseIrishRailTrainsXml,
  parsePublicMessage,
} from './irishRail.js';

/** One `<objTrainPositions>` element, written by hand for these tests. */
function train({
  status = 'R',
  lat = '53.3531',
  lon = '-6.24591',
  code = 'A118',
  date = '06 Nov 2026',
  message = 'A118\\n14:50 - Dublin Connolly to Belfast (3 mins late)\\nDeparted Dundalk next stop Newry',
  direction = 'Northbound',
} = {}) {
  return `  <objTrainPositions>
    <TrainStatus>${status}</TrainStatus>
    <TrainLatitude>${lat}</TrainLatitude>
    <TrainLongitude>${lon}</TrainLongitude>
    <TrainCode>${code}</TrainCode>
    <TrainDate>${date}</TrainDate>
    <PublicMessage>${message}</PublicMessage>
    <Direction>${direction}</Direction>
  </objTrainPositions>`;
}

function document(...trains) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ArrayOfObjTrainPositions xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://api.irishrail.ie/realtime/">
${trains.join('\n')}
</ArrayOfObjTrainPositions>`;
}

const FETCHED_S = 1_794_000_000;

test('a running-trains document becomes GTFS-shaped train records', () => {
  const { vehicles, entityCount, truncated } = decodeIrishRailTrains(
    document(
      train(),
      train({
        code: 'E244',
        status: 'N',
        message: 'E244\\nHowth to Bray\\nExpected Departure 16:35',
        direction: 'Southbound',
      }),
      train({
        code: 'D825',
        message:
          'D825\\n16:40 - Dun Laoghaire to Dundalk (0 mins late)\\nArrived Dun Laoghaire next stop Blackrock',
      }),
    ),
    FETCHED_S,
  );
  assert.equal(entityCount, 3);
  assert.equal(truncated, false);
  assert.equal(vehicles.length, 3);
  const [enterprise, dart, commuter] = vehicles;
  assert.deepEqual(enterprise, {
    id: 'A118',
    lat: 53.3531,
    lon: -6.24591,
    bearing: null,
    speedMps: null,
    timestamp: FETCHED_S,
    timestampSource: 'fetch',
    routeId: 'Dublin Connolly - Belfast',
    tripId: 'A118',
    directionId: null,
    label: 'A118 Dublin Connolly to Belfast',
    stopId: null,
    status: 'IN_TRANSIT_TO',
    occupancy: null,
    delaySec: 180,
  });
  // The message's stops and the row's direction decide the status only.
  for (const field of ['serviceState', 'lastStop', 'nextStop', 'direction'])
    assert.equal(field in dart, false, field);
  assert.equal(dart.status, 'STOPPED_AT');
  assert.equal(dart.routeId, 'Howth - Bray');
  assert.equal(dart.delaySec, null);
  assert.equal(commuter.status, 'STOPPED_AT');
  assert.equal(commuter.delaySec, 0);
});

test('terminated, unplaced, malformed and repeated trains are dropped', () => {
  const { vehicles, entityCount } = decodeIrishRailTrains(
    document(
      train({
        code: 'A311',
        status: 'T',
        message:
          'A311\\n15:05 - Tralee to Mallow(-2 mins late)\\nTERMINATED Mallow at 16:34',
      }),
      train({ code: 'A1', lat: '0', lon: '0' }),
      train({ code: 'A2', lat: 'north', lon: '-6.2' }),
      train({ code: 'A3', status: 'X' }),
      train({ code: 'bad code!' }),
      train({ code: 'A4' }),
      train({ code: 'A4', lat: '53.0' }),
    ),
    FETCHED_S,
  );
  assert.equal(entityCount, 7);
  assert.deepEqual(
    vehicles.map((vehicle) => [vehicle.id, vehicle.lat]),
    [['A4', 53.3531]],
  );
});

test('public messages: the three line shapes, with and without spacing', () => {
  assert.deepEqual(
    parsePublicMessage(
      'A311\\n15:05 - Tralee to Mallow(-2 mins late)\\nTERMINATED Mallow at 16:34',
    ),
    {
      origin: 'Tralee',
      destination: 'Mallow',
      scheduledDeparture: '15:05',
      delaySec: -120,
      event: 'terminated',
      lastStop: 'Mallow',
      nextStop: null,
    },
  );
  const real = parsePublicMessage(
    'D319\n16:27 - Docklands to M3 Parkway (1 mins late)\nArrived Pelletstown next stop Ashtown',
  );
  assert.equal(real.destination, 'M3 Parkway');
  assert.equal(real.event, 'arrived');
  assert.equal(real.nextStop, 'Ashtown');
  assert.equal(parsePublicMessage('').origin, null);
  assert.equal(parsePublicMessage(null).event, null);
  assert.equal(parsePublicMessage('X1\\nno route here\\n?').origin, null);
});

test('entities are decoded and DTDs refused', () => {
  assert.equal(
    decodeXmlText('Tom &amp; Jerry &lt;&gt; &quot;&apos; &#65;&#x42; &bogus;'),
    'Tom & Jerry <> "\' AB &bogus;',
  );
  assert.equal(decodeXmlText('&#0; &#x110000;'), '&#0; &#x110000;');
  const { rows } = parseIrishRailTrainsXml(
    document(train({ direction: 'To Dun Laoghaire &amp; Bray' })),
  );
  assert.equal(rows[0].Direction, 'To Dun Laoghaire & Bray');
  assert.throws(
    () =>
      parseIrishRailTrainsXml(
        `<!DOCTYPE x [<!ENTITY a "aaaa">]>${document(train())}`,
      ),
    IrishRailFormatError,
  );
  assert.throws(
    () => parseIrishRailTrainsXml('<html>error</html>'),
    IrishRailFormatError,
  );
  assert.throws(() => parseIrishRailTrainsXml(42), IrishRailFormatError);
});

test('sizes are capped: document, train count and field length', () => {
  assert.throws(
    () =>
      parseIrishRailTrainsXml(
        document(train()) + ' '.repeat(IRISH_RAIL_MAX_TEXT_CHARS),
      ),
    /characters/,
  );
  const many = Array.from({ length: IRISH_RAIL_MAX_TRAINS + 3 }, (_, i) =>
    train({ code: `E${i}` }),
  );
  const capped = parseIrishRailTrainsXml(document(...many));
  assert.equal(capped.rows.length, IRISH_RAIL_MAX_TRAINS);
  assert.equal(capped.truncated, true);
  const { rows } = parseIrishRailTrainsXml(
    document(train({ message: 'm'.repeat(600) }), '<objTrainPositions>'),
  );
  assert.equal(rows.length, 1, 'an unclosed element is not a train');
  assert.equal(rows[0].PublicMessage, null, 'an over-long field is refused');
  const empty = parseIrishRailTrainsXml(
    document(
      '<objTrainPositions><TrainCode>E1</TrainCode><Direction /></objTrainPositions>',
    ),
  );
  assert.equal(empty.rows[0].Direction, '');
  assert.equal(empty.rows[0].TrainStatus, null);
});
