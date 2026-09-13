// Keyless national CCTV packs: Finland (Digitraffic), Ontario 511, DriveBC.
//
// These pin the UPSTREAM FIELD CONTRACT for each source, verified live on
// 2026-09-14. A rename upstream must fail loudly here rather than quietly
// yielding an empty pack — the failure mode that hid every mapped-installation
// way and relation until it was traced by hand.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  digitrafficPresetToSource,
  driveBcCameraToSource,
  headingFromDirectionText,
  nswCameraToSource,
  ontario511ViewToSource,
  wsdotCameraToSource,
} from '../../vite.config.js';

// ---------------------------------------------------------------------------
// Finland — Fintraffic Digitraffic
// ---------------------------------------------------------------------------

/** A station feature shaped exactly like the live /weathercam/v1/stations reply. */
const FI_STATION = {
  type: 'Feature',
  id: 'C01503',
  geometry: { type: 'Point', coordinates: [23.99616, 60.05374, 0] },
  properties: {
    id: 'C01503',
    name: 'kt51_Inkoo',
    municipality: 'Inkoo',
    collectionStatus: 'GATHERING',
    names: { fi: 'Tie 51 Inkoo', en: 'Road 51 Inkoo' },
    presets: [{ id: 'C0150301', inCollection: true }],
  },
};

test('a Digitraffic preset becomes a placeable camera with the documented image URL', () => {
  const source = digitrafficPresetToSource(FI_STATION, FI_STATION.properties.presets[0]);
  assert.ok(source);
  assert.equal(source.id, 'fi-C0150301');
  // GeoJSON is [lon, lat] — swapping these would put Finland in the Indian Ocean.
  assert.equal(source.lat, 60.05374);
  assert.equal(source.lon, 23.99616);
  assert.equal(source.snapshotUrl, 'https://weathercam.digitraffic.fi/C0150301.jpg');
  assert.equal(source.sourceKind, 'digitraffic');
  assert.match(source.license, /CC BY 4\.0/);
});

test('Digitraffic presets that are not collecting are dropped', () => {
  assert.equal(digitrafficPresetToSource(FI_STATION, { id: 'C0150301', inCollection: false }), null);
  const idle = { ...FI_STATION, properties: { ...FI_STATION.properties, collectionStatus: 'REMOVED_TEMPORARILY' } };
  assert.equal(digitrafficPresetToSource(idle, FI_STATION.properties.presets[0]), null, 'a station with no live frame must not render');
  assert.equal(digitrafficPresetToSource(FI_STATION, { id: '' }), null);
  assert.equal(digitrafficPresetToSource({ geometry: null }, { id: 'X1' }), null);
});

// ---------------------------------------------------------------------------
// Ontario 511
// ---------------------------------------------------------------------------

const ON_CAMERA = {
  Id: 1,
  Roadway: 'QEW',
  Direction: 'Unknown',
  Latitude: 42.9142736713825,
  Longitude: -78.9580061508579,
  Location: 'QEW West of Thompson Road',
  Views: [{ Id: 1, Url: 'https://511on.ca/map/Cctv/1', Status: 'Enabled', Description: 'Toronto Bound' }],
};

test('each Ontario 511 view becomes its own camera', () => {
  const source = ontario511ViewToSource(ON_CAMERA, ON_CAMERA.Views[0]);
  assert.ok(source);
  assert.equal(source.id, 'on511-1');
  assert.equal(source.lat, 42.9142736713825);
  assert.equal(source.snapshotUrl, 'https://511on.ca/map/Cctv/1');
  assert.equal(source.sourceKind, 'ontario-511');
});

test('a disabled Ontario view is dropped rather than rendered dead', () => {
  assert.equal(ontario511ViewToSource(ON_CAMERA, { ...ON_CAMERA.Views[0], Status: 'Disabled' }), null);
  assert.equal(ontario511ViewToSource(ON_CAMERA, { ...ON_CAMERA.Views[0], Url: 'http://insecure/x' }), null);
  assert.equal(ontario511ViewToSource({ ...ON_CAMERA, Latitude: undefined }, ON_CAMERA.Views[0]), null);
});

test('a travel direction is not promoted to a surveyed camera heading', () => {
  // "Toronto Bound" says where the ROAD goes, not where the camera looks.
  assert.ok(Number.isNaN(headingFromDirectionText('Toronto Bound')));
  assert.ok(Number.isNaN(headingFromDirectionText('Looking Down')));
  assert.ok(Number.isNaN(headingFromDirectionText('')));
  const source = ontario511ViewToSource(ON_CAMERA, ON_CAMERA.Views[0]);
  assert.equal(source.headingConfidence, 'low', 'an unrecognised direction must stay low confidence');
});

test('an explicit compass word does yield a heading', () => {
  assert.equal(headingFromDirectionText('northbound'), 0);
  assert.equal(headingFromDirectionText('Southbound'), 180);
  assert.equal(headingFromDirectionText('eastbound'), 90);
  // Longest-first matching: "northeast" must not degrade to "north".
  assert.equal(headingFromDirectionText('northeast'), 45);
  assert.equal(headingFromDirectionText('southwest'), 225);
  assert.equal(headingFromDirectionText('NW'), 315);
  const source = ontario511ViewToSource(ON_CAMERA, { ...ON_CAMERA.Views[0], Description: 'Northbound' });
  assert.equal(source.headingDeg, 0);
  assert.equal(source.headingConfidence, 'medium');
});

// ---------------------------------------------------------------------------
// DriveBC
// ---------------------------------------------------------------------------

const BC_CAM = {
  id: 569,
  name: 'Harrop Ferry Landing northbound',
  links: { imageDisplay: '/images/569.jpg?t=1789327878' },
  region_name: 'Southern Interior',
  location: { type: 'Point', coordinates: [-117.054139, 49.611264] },
  orientation: 'N',
  elevation: 534,
  marked_stale: false,
};

test('DriveBC contributes a real bearing and a real ground elevation', () => {
  const source = driveBcCameraToSource(BC_CAM);
  assert.ok(source);
  assert.equal(source.id, 'bc-569');
  assert.equal(source.lat, 49.611264);
  assert.equal(source.lon, -117.054139);
  // Published orientation and elevation, not this codebase's usual priors.
  assert.equal(source.headingDeg, 0, 'orientation N is 0 degrees');
  assert.equal(source.headingConfidence, 'medium');
  assert.equal(source.groundElevationM, 534);
  assert.equal(source.snapshotUrl, 'https://www.drivebc.ca/images/569.jpg?t=1789327878');
});

test('every DriveBC compass orientation maps to the right bearing', () => {
  const expected = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
  for (const [orientation, deg] of Object.entries(expected)) {
    assert.equal(driveBcCameraToSource({ ...BC_CAM, orientation }).headingDeg, deg, orientation);
  }
});

test('DriveBC cameras it flags as stale are dropped', () => {
  assert.equal(driveBcCameraToSource({ ...BC_CAM, marked_stale: true }), null);
  assert.equal(driveBcCameraToSource({ ...BC_CAM, location: null }), null);
  assert.equal(driveBcCameraToSource({ ...BC_CAM, links: {} }), null);
  assert.equal(driveBcCameraToSource(null), null);
});

test('an unknown DriveBC orientation degrades to a flagged fallback', () => {
  const source = driveBcCameraToSource({ ...BC_CAM, orientation: 'UP' });
  assert.ok(Number.isFinite(source.headingDeg));
  assert.equal(source.headingConfidence, 'low');
});

test('a zero elevation is kept, not replaced by the prior', () => {
  // `|| 100` would silently move a sea-level camera to 100 m.
  assert.equal(driveBcCameraToSource({ ...BC_CAM, elevation: 0 }).groundElevationM, 0);
});

// ---------------------------------------------------------------------------
// Washington — WSDOT
// ---------------------------------------------------------------------------

const WA_CAM = {
  CameraID: 9818,
  Title: 'Anacortes Fuel',
  Description: null,
  CameraLocation: { Direction: 'W', Latitude: 48.498333, Longitude: -122.6625, RoadName: 'Airports' },
  DisplayLatitude: 48.498333,
  DisplayLongitude: -122.6625,
  ImageURL: 'https://images.wsdot.wa.gov/airports/anafuel.jpg',
  IsActive: true,
  Region: 'Northwest',
};

test('a WSDOT camera maps with its cardinal direction as a bearing', () => {
  const source = wsdotCameraToSource(WA_CAM);
  assert.ok(source);
  assert.equal(source.id, 'wsdot-9818');
  assert.equal(source.lat, 48.498333);
  assert.equal(source.headingDeg, 270, 'W is 270 degrees');
  assert.equal(source.headingConfidence, 'medium');
  assert.equal(source.snapshotUrl, 'https://images.wsdot.wa.gov/airports/anafuel.jpg');
});

test('WSDOT "B" and "O" are not bearings and must not be pointed north', () => {
  // 1182 of 1705 live cameras are "B" (both directions) and 13 are "O".
  // Treating those as a compass code would aim most of Washington due north.
  for (const direction of ['B', 'O', '', null]) {
    const source = wsdotCameraToSource({ ...WA_CAM, CameraLocation: { ...WA_CAM.CameraLocation, Direction: direction } });
    assert.equal(source.headingConfidence, 'low', `direction ${direction} must be low confidence`);
    assert.ok(Number.isFinite(source.headingDeg));
  }
});

test('an inactive or unusable WSDOT camera is dropped', () => {
  assert.equal(wsdotCameraToSource({ ...WA_CAM, IsActive: false }), null);
  assert.equal(wsdotCameraToSource({ ...WA_CAM, ImageURL: 'http://images.wsdot.wa.gov/x.jpg' }), null);
  assert.equal(wsdotCameraToSource({ ...WA_CAM, DisplayLatitude: undefined, CameraLocation: { ...WA_CAM.CameraLocation, Latitude: undefined } }), null);
  assert.equal(wsdotCameraToSource(null), null);
});

test('WSDOT falls back to CameraLocation coordinates when Display ones are absent', () => {
  const source = wsdotCameraToSource({ ...WA_CAM, DisplayLatitude: undefined, DisplayLongitude: undefined });
  assert.equal(source.lat, 48.498333);
  assert.equal(source.lon, -122.6625);
});

// ---------------------------------------------------------------------------
// New South Wales — Live Traffic NSW
// ---------------------------------------------------------------------------

const NSW_FEATURE = {
  type: 'Feature',
  id: '023651ee-389c-4677-978e-d39b6c24c1e7',
  geometry: { type: 'Point', coordinates: [151.10533, -34.02977] },
  properties: {
    region: 'SYD_SOUTH',
    title: '5 Ways (Miranda)',
    view: '5 Ways at The Boulevarde looking west towards Sutherland.',
    direction: 'W',
    href: 'https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/5_ways_miranda.jpeg',
  },
};

test('an NSW camera maps with its bearing and a browser User-Agent', () => {
  const source = nswCameraToSource(NSW_FEATURE);
  assert.ok(source);
  assert.equal(source.id, 'nsw-023651ee-389c-4677-978e-d39b6c24c1e7');
  assert.equal(source.lat, -34.02977, 'southern hemisphere latitude must stay negative');
  assert.equal(source.lon, 151.10533);
  assert.equal(source.headingDeg, 270);
  assert.equal(source.headingConfidence, 'medium');
  // Without this the CDN answers 200 + HTML and every NSW camera silently
  // falls through to Street View.
  assert.match(source.imageUserAgent, /Mozilla\/5\.0/);
});

test('NSW hyphenated compass directions are de-hyphenated before lookup', () => {
  // The live feed uses "N-E"/"S-W", which the compass table has no key for.
  const cases = { 'N-E': 45, 'N-W': 315, 'S-E': 135, 'S-W': 225, N: 0, S: 180 };
  for (const [direction, deg] of Object.entries(cases)) {
    const source = nswCameraToSource({ ...NSW_FEATURE, properties: { ...NSW_FEATURE.properties, direction } });
    assert.equal(source.headingDeg, deg, direction);
    assert.equal(source.headingConfidence, 'medium', direction);
  }
});

test('an NSW feature without usable geometry or image is dropped', () => {
  assert.equal(nswCameraToSource({ ...NSW_FEATURE, geometry: null }), null);
  assert.equal(nswCameraToSource({ ...NSW_FEATURE, properties: { ...NSW_FEATURE.properties, href: '' } }), null);
  assert.equal(nswCameraToSource({ ...NSW_FEATURE, id: '' }), null);
});
