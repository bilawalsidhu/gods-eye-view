import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTrain,
  getRailFeed,
  getRegisteredRailFeed,
  publicRailCatalog,
  railFeedHasTripUpdates,
  railFeedPositions,
} from './railFeeds.js';
import {
  buildRailSnapshot,
  railMaxBodyBytes,
  railUpstreamHeaders,
} from './railProxy.js';

const irish = getRegisteredRailFeed('irish-rail');

test('Irish Rail keeps its XML positions and gains a timetable', () => {
  assert.equal(irish.format, 'irish-rail-xml');
  assert.equal(irish.positions, 'event');
  assert.ok(getRailFeed('irish-rail'));
  assert.match(irish.staticGtfsUrl, /\/transitData\/Data\/GTFS_Realtime\.zip$/);
  assert.deepEqual(irish.staticRouteTypes, [2]);
  assert.equal(irish.positionsByTrainNumber, true);
  assert.equal(irish.routesFrom, 'schedule');
  // The XML's own headers and cap.
  assert.match(railUpstreamHeaders(irish).Accept, /xml/);
  assert.equal(railMaxBodyBytes(irish), 1024 * 1024);
  // The positions publish no licence; the NTA timetable is CC BY 4.0.
  assert.equal(
    irish.license,
    'No licence published (positions); CC BY 4.0 (NTA timetable)',
  );
  assert.equal(
    irish.attribution,
    'Iarnród Éireann / Irish Rail; timetable: National Transport Authority, provided as is',
  );
});

test('Irish Rail is placed by its XML events and serves no trip updates', () => {
  assert.equal(railFeedPositions(irish), 'event');
  assert.equal(irish.tripUpdatesUrl, undefined);
  assert.equal(railFeedHasTripUpdates(irish), false);
  // Listed without a timetable pack: the XML's train codes classify alone.
  const entry = publicRailCatalog({ schedulePackBuilt: () => false }).find(
    (feed) => feed.id === 'irish-rail',
  );
  assert.equal(entry.positions, 'event');
  assert.equal(entry.tripUpdates, false);
});

test('Irish Rail pack routes: the code letter and the provinces of the ends', () => {
  const rename = (code, from, to, countries = ['IE']) =>
    irish.staticTripRename({ trip_short_name: code }, 'R-1', {
      ends: {
        from: { name: from, country: countries[0] },
        to: { name: to, country: countries.at(-1) },
        countries,
      },
    });
  assert.equal(
    rename('A100', 'Dublin Connolly', 'Belfast', ['IE', 'GB']),
    'A~B~R-1',
  );
  assert.equal(rename('A203', 'Cork (Kent)', 'Dublin Heuston'), 'A~X~R-1');
  assert.equal(rename('A301', 'Mallow', 'Tralee (Casement)'), 'A~S~R-1');
  assert.equal(rename('P501', 'Mallow', 'Cobh'), 'P~S~R-1');
  assert.equal(rename('E206', 'Bray (Daly)', 'Howth'), 'E~X~R-1');
  assert.equal(rename('195.MF-BH.93-GRN-y11', 'a', 'b'), null, 'no train code');
  const kind = (route) => classifyTrain(irish, route, { tripId: '6024_1' });
  assert.equal(
    kind('A~B~DUB-BFT-O').category,
    'international',
    'the Enterprise',
  );
  assert.equal(kind('A~X~DUB-CORK-O').category, 'national');
  assert.equal(kind('A~S~DUB-TRALEE-O').category, 'regional');
  assert.equal(kind('E~X~BRAY-HOWTH-I').category, 'local', 'DART');
  assert.equal(kind('P~S~MAL-COBH-O').category, 'local', 'commuter');
  assert.equal(kind('D~S~MAL-COBH-O').category, 'local');
  // The XML's own records still classify by their code and ends.
  assert.equal(
    classifyTrain(irish, 'Dublin Connolly - Belfast', { tripId: 'A100' })
      .category,
    'international',
  );
  assert.equal(
    classifyTrain(irish, 'Bray - Howth', { tripId: 'E206' }).category,
    'local',
  );
});

test('an Irish Rail train code takes the timetable run it is on now', () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<ArrayOfObjTrainPositions xmlns="http://api.irishrail.ie/realtime/">
  <objTrainPositions>
    <TrainStatus>R</TrainStatus><TrainLatitude>53.1442</TrainLatitude>
    <TrainLongitude>-6.06085</TrainLongitude><TrainCode>A610</TrainCode>
    <TrainDate>09 Nov 2026</TrainDate>
    <PublicMessage>A610\\n18:37 - Dublin Connolly to Rosslare Europort (3 mins late)\\nDeparted Greystones next stop Kilcoole</PublicMessage>
    <Direction>Southbound</Direction>
  </objTrainPositions>
  <objTrainPositions>
    <TrainStatus>R</TrainStatus><TrainLatitude>53.35</TrainLatitude>
    <TrainLongitude>-6.25</TrainLongitude><TrainCode>E999</TrainCode>
    <TrainDate>09 Nov 2026</TrainDate>
    <PublicMessage>E999\\n19:00 - Bray to Howth (0 mins late)\\nDeparted Connolly next stop Clontarf Road</PublicMessage>
    <Direction>Northbound</Direction>
  </objTrainPositions>
</ArrayOfObjTrainPositions>`;
  const pack = { '6024_8435': 'A~X~DUB-EUROPORT-I' };
  const snapshot = buildRailSnapshot(
    irish,
    new TextEncoder().encode(xml),
    1_794_251_747_000,
    {
      routeFor: (tripId) => pack[tripId] ?? null,
      tripFor: (code) => (code === 'A610' ? '6024_8435' : null),
    },
  );
  const byCode = Object.fromEntries(
    snapshot.trains.map((train) => [train.trainNumber ?? train.tripId, train]),
  );
  assert.equal(byCode.A610.tripId, '6024_8435');
  assert.equal(byCode.A610.routeId, 'A~X~DUB-EUROPORT-I');
  assert.equal(byCode.A610.category, 'national');
  assert.equal(byCode.A610.positionSource, 'event');
  assert.equal(byCode.A610.id, 'A610', 'the vehicle keeps its code');
  // Not in the timetable: its own code and ends, as before.
  assert.equal(byCode.E999.tripId, 'E999');
  assert.equal(byCode.E999.trainNumber, undefined);
  assert.equal(byCode.E999.category, 'local');
});
