import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMotcCctvXml,
  parseLocationMileKm,
  pinTaiwanMediaUrl,
  taiwanFeedTypeForUrl,
  deriveRoadHeadings,
  motcRecordsToSources,
} from '../../server/providers/cctv/taiwan.js';
import { extractFirstMultipartJpeg } from '../../server/providers/cctv/media.js';

const FREEWAY_PIN = {
  allowHttp: false,
  hostSuffixes: ['.freeway.gov.tw', '.thb.gov.tw'],
};

const XML = `<CCTVList><CCTVs>
  <CCTV><CCTVID>CCTV-N1-S-0.000-M</CCTVID>
    <VideoStreamURL>https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=10000&amp;x=1</VideoStreamURL>
    <PositionLon>121.735695</PositionLon><PositionLat>25.1229931</PositionLat>
    <RoadID>000010</RoadID><RoadName>國道1號</RoadName><RoadDirection>S</RoadDirection>
    <RoadSection><Start>基隆端</Start><End>基隆交流道</End></RoadSection>
    <LocationMile>0K+000</LocationMile></CCTV>
</CCTVs></CCTVList>`;

test('MOTC CCTV XML parses into TDX-shaped records with entities decoded', () => {
  const [record] = parseMotcCctvXml(XML);
  assert.equal(record.CCTVID, 'CCTV-N1-S-0.000-M');
  assert.equal(
    record.VideoStreamURL,
    'https://cctvn.freeway.gov.tw/abs2mjpg/bmjpg?camera=10000&x=1',
  );
  assert.equal(record.RoadSection.Start, '基隆端');
  assert.equal(record.LocationMile, '0K+000');
});

test('location mileage reads kilometres', () => {
  assert.equal(parseLocationMileKm('12K+345'), 12.345);
  assert.equal(parseLocationMileKm('0K+000'), 0);
  assert.ok(Number.isNaN(parseLocationMileKm('')));
});

test('media URLs are pinned to public Taiwanese camera hosts', () => {
  assert.ok(pinTaiwanMediaUrl('https://cctvs.freeway.gov.tw/a?camera=1', FREEWAY_PIN));
  assert.equal(pinTaiwanMediaUrl('http://cctvs.freeway.gov.tw/a', FREEWAY_PIN), '');
  assert.equal(pinTaiwanMediaUrl('https://evil.example/a', FREEWAY_PIN), '');
  assert.equal(
    pinTaiwanMediaUrl('https://freeway.gov.tw.evil.example/a', FREEWAY_PIN),
    '',
  );
  const cityPin = { allowHttp: true, hostSuffixes: ['.tw'] };
  assert.equal(pinTaiwanMediaUrl('http://127.0.0.1/cam', cityPin), '');
  assert.equal(pinTaiwanMediaUrl('http://user:pw@cam.gov.tw/x', cityPin), '');
  assert.ok(pinTaiwanMediaUrl('http://cctv.ntpc.gov.tw/x', cityPin));
});

test('stream URLs classify by path', () => {
  assert.equal(taiwanFeedTypeForUrl('https://a.gov.tw/live.m3u8'), 'hls');
  assert.equal(taiwanFeedTypeForUrl('https://a.gov.tw/snap.jpg'), 'image');
  assert.equal(taiwanFeedTypeForUrl('https://a.gov.tw/bmjpg?camera=1'), 'mjpeg');
});

test('road headings follow the carriageway, and one misplaced camera cannot flip its axis', () => {
  // Southbound road running due south; the 2.5 km camera is misplaced 400 m
  // north of its mileage slot, like CCTV-N1-S-324.455-L in the live feed.
  const items = [0, 1, 2, 2.5, 3, 4, 5].map((km) => ({
    key: 'N1|S',
    direction: 'S',
    mileKm: km,
    lat: 25 - (km === 2.5 ? 2.1 : km) * 0.009,
    lon: 121.5,
  }));
  const headings = deriveRoadHeadings(items);
  for (const item of items) {
    const { headingDeg } = headings.get(item);
    const off = Math.min(Math.abs(headingDeg - 180), 360 - Math.abs(headingDeg - 180));
    assert.ok(off < 20, `km ${item.mileKm} heading ${headingDeg}`);
  }
});

test('records become live MJPEG sources with Chinese names', () => {
  const [source] = motcRecordsToSources(parseMotcCctvXml(XML), {
    idPrefix: 'tw-freeway',
    provider: 'Freeway Bureau',
    sourceKind: 'tw-freeway',
    license: 'open',
    pin: FREEWAY_PIN,
    cityFor: (record) => record.RoadName,
  });
  assert.equal(source.id, 'tw-freeway-CCTV-N1-S-0.000-M');
  assert.equal(source.feedType, 'mjpeg');
  assert.equal(source.name, '國道1號 0K+000 南向 (基隆端–基隆交流道)');
  assert.equal(source.headingDeg, 180);
  assert.equal(source.headingConfidence, 'low');
});

test('first JPEG is cut from a multipart prefix, CRLF-inclusive Content-Length or not', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
  const part = (length) =>
    Buffer.concat([
      Buffer.from(`--myboundary\r\nContent-Type: image/jpeg\r\nContent-Length: ${length}\r\n\r\n`),
      jpeg,
      Buffer.from('\r\n--myboundary\r\n'),
    ]);
  assert.deepEqual(extractFirstMultipartJpeg(part(jpeg.length)), jpeg);
  assert.deepEqual(extractFirstMultipartJpeg(part(jpeg.length + 2)), jpeg);
  assert.equal(extractFirstMultipartJpeg(part(jpeg.length).subarray(0, 60)), null);
});
