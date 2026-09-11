import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeDigitrafficCameras,
  normalizeDriveBcCameras,
  normalizeHongKongCameras,
  normalizeIteris511Cameras,
  normalizeNztaCameras,
  normalizeWindyWebcams,
  xmlBlocks,
  xmlText,
} from '../../vite.config.js';

const HK_XML = `<?xml version="1.0"?><images>
<image><key>H429F</key><region>Hong Kong Island</region><district>Southern</district><description>Aberdeen Praya Road near Fish Market [H429F]</description><latitude>22.24845</latitude><longitude>114.1505</longitude><url>https://tdcctv.data.one.gov.hk/H429F.JPG</url></image>
<image><key>K101F</key><region>Kowloon</region><district>Yau Tsim Mong</district><description>Nathan Road &amp; Argyle Street [K101F]</description><latitude>22.3190</latitude><longitude>114.1700</longitude><url>https://tdcctv.data.one.gov.hk/K101F.JPG</url></image>
<image><key>BAD1</key><region>x</region><district>x</district><description>Off-host</description><latitude>22.3</latitude><longitude>114.1</longitude><url>https://evil.example/BAD1.JPG</url></image>
<image><key>NOPOS</key><region>x</region><district>x</district><description>No position</description><latitude></latitude><longitude></longitude><url>https://tdcctv.data.one.gov.hk/NOPOS.JPG</url></image>
</images>`;

const DRIVEBC_JSON = {
  webcams: [
    { id: 2, camName: 'Coquihalla Great Bear Snowshed - N', caption: 'Highway 5 at the Great Bear Snowshed, looking north.', isOn: true, shouldAppear: true, orientation: 'N',
      location: { latitude: 49.596374, longitude: -121.159832, elevation: 980 }, highway: { locationDescription: 'Coquihalla' },
      links: { imageDisplay: 'https://images.drivebc.ca/bchighwaycam/pub/cameras/2.jpg' } },
    { id: 3, camName: 'Off camera', isOn: false, shouldAppear: true, orientation: 'E', location: { latitude: 49.1, longitude: -122.1 }, links: { imageDisplay: 'https://images.drivebc.ca/bchighwaycam/pub/cameras/3.jpg' } },
    { id: 4, camName: 'Hidden', isOn: true, shouldAppear: false, orientation: 'E', location: { latitude: 49.1, longitude: -122.1 }, links: { imageDisplay: 'https://images.drivebc.ca/bchighwaycam/pub/cameras/4.jpg' } },
    { id: 5, camName: 'Off host', isOn: true, shouldAppear: true, orientation: 'SW', location: { latitude: 49.1, longitude: -122.1 }, links: { imageDisplay: 'https://cdn.example/5.jpg' } },
  ],
};

const ONTARIO_ROWS = [
  { Id: 1, Source: 'RWIS (MTO)', Roadway: 'QEW', Direction: 'Unknown', Latitude: 42.9142, Longitude: -78.958, Location: 'QEW West of Thompson Road',
    Views: [
      { Id: 1, Url: 'https://511on.ca/map/Cctv/1', Status: 'Enabled', Description: 'Looking East' },
      { Id: 2, Url: 'https://511on.ca/map/Cctv/2', Status: 'Enabled', Description: 'Looking Down' },
      { Id: 3, Url: 'https://511on.ca/map/Cctv/3', Status: 'Disabled', Description: 'Looking West' },
      { Id: 4, Url: 'https://cdn.example/4.jpg', Status: 'Enabled', Description: 'Looking North' },
    ] },
  { Id: 9, Latitude: 'nope', Longitude: -79, Location: 'Broken', Views: [{ Id: 1, Url: 'https://511on.ca/map/Cctv/9', Status: 'Enabled', Description: 'Looking South' }] },
];
const ONTARIO_FEED = { id: 'on', label: 'Ontario 511', imageOrigin: 'https://511on.ca/', provider: 'Ontario 511', regionLabel: 'Ontario', license: 'OGL-ON' };

const DIGITRAFFIC_GEOJSON = {
  features: [
    { geometry: { type: 'Point', coordinates: [23.99616, 60.05374, 0] }, properties: { id: 'C01503', name: 'kt51_Inkoo', collectionStatus: 'GATHERING', presets: [{ id: 'C0150301', inCollection: false }, { id: 'C0150302', inCollection: true }] } },
    { geometry: { type: 'Point', coordinates: [25.0, 60.2, 0] }, properties: { id: 'C01599', name: 'vt1_Espoo', collectionStatus: 'REMOVED_TEMPORARILY', presets: [{ id: 'C0159901', inCollection: true }] } },
    { geometry: { type: 'Point', coordinates: [25.5, 60.3, 0] }, properties: { id: 'C01600', name: 'vt4_Lahti', collectionStatus: 'GATHERING', presets: [] } },
  ],
};

const NZTA_XML = `<?xml version="1.0"?><response>
<camera><description>South along Hinds Highway from Lagmhor Rd</description><direction>Southbound</direction><highway>SH1</highway><id>714</id><imageUrl>/camera/714.jpg</imageUrl>
<journey><id>86</id><name>SH1</name><startLatitude>-41.95</startLatitude><startLongitude>174.06</startLongitude></journey>
<journeyLeg><name>Ashburton to Rangitata</name></journeyLeg>
<latitude>-43.919632</latitude><longitude>171.721055</longitude><name>SH1 Tinwald</name><offline>false</offline><region>Canterbury</region><underMaintenance>false</underMaintenance></camera>
<camera><description>Dead camera</description><direction>Northbound</direction><id>715</id><imageUrl>/camera/715.jpg</imageUrl><latitude>-43.9</latitude><longitude>171.7</longitude><name>X</name><offline>true</offline><region>Canterbury</region></camera>
<camera><description>Escaped path</description><direction>Eastbound</direction><id>716</id><imageUrl>/camera/../secret.jpg</imageUrl><latitude>-43.9</latitude><longitude>171.7</longitude><name>Y</name><offline>false</offline></camera>
</response>`;

const WINDY_JSON = {
  total: 3,
  webcams: [
    { webcamId: 1234567890, status: 'active', title: 'Zürich: Bahnhofstrasse', location: { city: 'Zürich', country: 'Switzerland', latitude: 47.3769, longitude: 8.5417 },
      images: { current: { preview: 'https://images-webcams.windy.com/90/1234567890/current/preview/1234567890.jpg?token=abc' } }, urls: { detail: 'https://windy.com/webcams/1234567890' } },
    { webcamId: 22, status: 'inactive', title: 'Old', location: { latitude: 1, longitude: 1 }, images: { current: { preview: 'https://images-webcams.windy.com/x.jpg' } } },
    { webcamId: 33, status: 'active', title: 'Foreign host', location: { latitude: 1, longitude: 1 }, images: { current: { preview: 'https://cdn.example/x.jpg' } } },
  ],
};

test('xml helpers read flat feeds and decode entities', () => {
  assert.equal(xmlBlocks(HK_XML, 'image').length, 4);
  assert.equal(xmlText(xmlBlocks(HK_XML, 'image')[1], 'description'), 'Nathan Road & Argyle Street [K101F]');
  assert.equal(xmlText('<a><b>x</b></a>', 'c'), '');
});

test('Hong Kong cameras are pinned to the official host and lose their key suffix', () => {
  const cameras = normalizeHongKongCameras(HK_XML);
  assert.deepEqual(cameras.map((c) => c.id), ['hk-h429f', 'hk-k101f']);
  assert.equal(cameras[0].name, 'Aberdeen Praya Road near Fish Market');
  assert.equal(cameras[0].city, 'Southern, Hong Kong');
  assert.equal(cameras[0].snapshotUrl, 'https://tdcctv.data.one.gov.hk/H429F.JPG');
  assert.equal(cameras[0].headingConfidence, 'low');
  assert.equal(cameras[0].feedType, 'image');
  assert.equal(cameras[0].sourceKind, 'hk-td-open-data');
});

test('DriveBC keeps on-air visible cameras and reads the published orientation', () => {
  const cameras = normalizeDriveBcCameras(DRIVEBC_JSON);
  assert.deepEqual(cameras.map((c) => c.id), ['bc-2']);
  assert.equal(cameras[0].headingDeg, 0);
  assert.equal(cameras[0].headingConfidence, 'high');
  assert.equal(cameras[0].groundElevationM, 980);
  assert.equal(cameras[0].city, 'Coquihalla, British Columbia');
  assert.equal(cameras[0].license, 'Open Government Licence – British Columbia');
});

test('511-platform rows fan out into enabled views with headings from the view description', () => {
  const cameras = normalizeIteris511Cameras(ONTARIO_ROWS, ONTARIO_FEED);
  assert.deepEqual(cameras.map((c) => c.id), ['on-1-1', 'on-1-2']);
  assert.equal(cameras[0].name, 'QEW West of Thompson Road — Looking East');
  assert.equal(cameras[0].headingDeg, 90);
  assert.equal(cameras[0].headingConfidence, 'high');
  assert.equal(cameras[1].name, 'QEW West of Thompson Road', 'a "Looking Down" view carries no direction in its name');
  assert.equal(cameras[1].headingConfidence, 'low');
  assert.equal(cameras[0].sourceKind, 'iteris511-on');
  assert.equal(cameras[0].cityId, 'on');
});

test('Digitraffic uses one in-collection preset per gathering station', () => {
  const cameras = normalizeDigitrafficCameras(DIGITRAFFIC_GEOJSON);
  assert.deepEqual(cameras.map((c) => c.id), ['fi-c0150302']);
  assert.equal(cameras[0].snapshotUrl, 'https://weathercam.digitraffic.fi/C0150302.jpg');
  assert.equal(cameras[0].name, 'KT51 Inkoo');
  assert.equal(cameras[0].lat, 60.05374);
  assert.equal(cameras[0].lon, 23.99616);
  assert.match(cameras[0].license, /CC BY 4\.0/);
});

test('NZTA cameras ignore nested journey names, offline units and odd image paths', () => {
  const cameras = normalizeNztaCameras(NZTA_XML);
  assert.deepEqual(cameras.map((c) => c.id), ['nz-714']);
  assert.equal(cameras[0].name, 'South along Hinds Highway from Lagmhor Rd');
  assert.equal(cameras[0].snapshotUrl, 'https://trafficnz.info/camera/714.jpg');
  assert.equal(cameras[0].headingDeg, 180);
  assert.equal(cameras[0].city, 'Canterbury, New Zealand');
  assert.equal(cameras[0].lat, -43.919632);
});

test('Windy webcams keep only active cameras on Windy image hosts and carry the link-back', () => {
  const cameras = normalizeWindyWebcams(WINDY_JSON);
  assert.deepEqual(cameras.map((c) => c.id), ['windy-1234567890']);
  assert.equal(cameras[0].windyId, '1234567890');
  assert.equal(cameras[0].detailUrl, 'https://windy.com/webcams/1234567890');
  assert.equal(cameras[0].city, 'Zürich, Switzerland');
  assert.equal(cameras[0].license, 'Webcams provided by Windy.com');
  assert.equal(cameras[0].sourceKind, 'windy');
});
