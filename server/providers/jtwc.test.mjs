import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  wrapJtwcLongitude,
  JTWC_PRODUCTS_URL,
  JTWC_RSS_URL,
  jtwcStormId,
  kmlFromKmz,
  parseJtwcFeed,
  parseJtwcKml,
  parseJtwcWarning,
  readJtwcStorms,
  withJtwcDangerArea,
} from './jtwc.js';

// Tropical Cyclone 04P (Xavier), warning 15, as JTWC published it on
// 2026-11-21 (past fixes shortened).
const TCW = `WTPS51 PGTW 210300
WARNING    ATCG MIL 04P SWP 261121015248
2026112100 04P XAVIER     015  01 245 04 SATL 020
T000 115S 1642W 045 R034 075 NE QD 105 SE QD 090 SW QD 050 NW QD
T012 120S 1652W 045 R034 075 NE QD 105 SE QD 090 SW QD 035 NW QD
T024 125S 1665W 040 R034 070 NE QD 100 SE QD 070 SW QD 020 NW QD
T072 130S 1708W 030
AMP
    072HR DISSIPATED AS A SIGNIFICANT TROPICAL CYCLONE OVER WATER
SUBJ:  TROPICAL CYCLONE 04P (XAVIER) WARNING NR 015
1. TROPICAL CYCLONE 04P (XAVIER) WARNING NR 015
   01 ACTIVE TROPICAL CYCLONE IN SOUTHPAC
    ---
   WARNING POSITION:
   210000Z --- NEAR 11.5S 164.2W
   MAX SUSTAINED WINDS - 045 KT, GUSTS 055 KT
    ---
   FORECASTS:
   12 HRS, VALID AT:
   211200Z --- 12.0S 165.2W
   MAX SUSTAINED WINDS - 045 KT, GUSTS 055 KT
    ---
   24 HRS, VALID AT:
   220000Z --- 12.5S 166.5W
   MAX SUSTAINED WINDS - 040 KT, GUSTS 050 KT
    ---
   72 HRS, VALID AT:
   240000Z --- 13.0S 170.8W
   MAX SUSTAINED WINDS - 030 KT, GUSTS 040 KT
    ---
REMARKS:
210300Z POSITION NEAR 11.6S 164.5W.
21NOV26. TROPICAL CYCLONE 04P (XAVIER), LOCATED APPROXIMATELY 416
NM EAST-NORTHEAST OF PAGO PAGO, HAS TRACKED WEST-SOUTHWESTWARD AT
04 KNOTS OVER THE PAST SIX HOURS.
MINIMUM CENTRAL PRESSURE AT 210000Z IS 995 MB. MAXIMUM
SIGNIFICANT WAVE HEIGHT AT 210000Z IS 19 FEET. NEXT WARNINGS AT
210900Z, 211500Z, 212100Z AND 220300Z.
//
0426112018 113S1638W  55
0426112100 115S1642W  45
NNNN
`;

const item = (guid, body) =>
  `<item><title>${guid}</title><description><![CDATA[${body}]]></description><guid>${guid}</guid></item>`;
const NONE =
  "<ul><li><font color='red'>No Current Tropical Cyclone Warnings.</font></li></ul>";
function feed(prefixes = ['sh0427']) {
  const links = prefixes
    .map(
      (prefix) =>
        `<li><a href='${JTWC_PRODUCTS_URL}/${prefix}web.txt'>TC Warning Text</a></li><li><a href='${JTWC_PRODUCTS_URL}/${prefix}.tcw'>JMV 3.0 Data</a></li>`,
    )
    .join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel>${item('NWPAC-NIO-WARNINGS', NONE)}${item('EPAC-CPAC-WARNINGS', NONE)}${item('SH-WARNINGS', prefixes.length ? links : NONE)}${item('TROPICAL-ADVISORIES', `<a href="${JTWC_PRODUCTS_URL}/abpwweb.txt">ABPW10</a>`)}</channel></rss>`;
}

const SWATH = [
  [-164.02, -9.5],
  [-163.0, -12.0],
  [-171.0, -14.5],
  [-170.0, -11.0],
];
function kml(number = 15) {
  return `<kml><Document><Folder>
<Placemark><name>21/00Z (TROPICAL CYCLONE 04P (XAVIER) WARNING NR ${number}    - 45 knots)</name>
<Point><coordinates>-164.2,-11.5,0</coordinates></Point></Placemark>
<Placemark><name>RADIUS OF 34 KT WINDS</name><Polygon><outerBoundaryIs><LinearRing><coordinates>-164.2,-10.25,0 -163,-11,0 -164.2,-12.5,0 -164.2,-10.25,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
<Placemark><name>34 knot Danger Swath</name><Polygon><outerBoundaryIs><LinearRing><coordinates>
${SWATH.map(([lon, lat]) => `${lon},${lat},0`).join(' ')}
</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Folder></Document></kml>`;
}

/** A zip holding `files` ({name: text}), deflated. */
function zip(files) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const NOW = Date.UTC(2026, 10, 21, 3, 20);

test('the feed lists the storms of the warning items and refuses anything else', () => {
  assert.deepEqual(parseJtwcFeed(feed()), ['sh0427']);
  assert.deepEqual(parseJtwcFeed(feed([])), []);
  assert.deepEqual(parseJtwcFeed(feed(['wp3026', 'sh0427', 'wp3026'])), [
    'wp3026',
    'sh0427',
  ]);
  assert.throws(() => parseJtwcFeed('<html>blocked</html>'));
  assert.throws(() =>
    parseJtwcFeed(feed().replace('<guid>SH-WARNINGS', '<guid>OTHER')),
  );
  assert.throws(() => parseJtwcFeed(feed([]).replaceAll(NONE, '<ul></ul>')));
});

test('product prefixes are season-year ATCF ids', () => {
  assert.equal(jtwcStormId('sh0427'), 'sh042027');
  assert.equal(jtwcStormId('wp3026'), 'wp302026');
  assert.throws(() => jtwcStormId('al0126'));
});

test('a warning reads as a pending JTWC storm with its forecast', () => {
  const { storm, forecast } = parseJtwcWarning('sh0427', TCW);
  assert.deepEqual(
    { ...storm },
    {
      id: 'sh042027',
      agency: 'jtwc',
      name: 'Xavier',
      classification: 'TC',
      basin: 'SH',
      // Where the storm was at issuance, from the remarks.
      position: { longitude: -164.5, latitude: -11.6 },
      positionAt: '2026-11-21T03:00:00.000Z',
      advisoryNumber: '15',
      issuedAt: '2026-11-21T03:00:00.000Z',
      windKt: 45,
      pressureHpa: 995,
      movement: { directionDegrees: 245, speedKt: 4 },
      advisoryUrl: 'https://www.metoc.navy.mil/jtwc/products/sh0427web.txt',
      outlookUrl: 'https://www.metoc.navy.mil/jtwc/products/abpwweb.txt',
      geometryStatus: 'pending',
      geometryAdvisoryNumber: null,
      forecastPoints: [],
      track: null,
      cone: null,
      dangerArea: null,
    },
  );
  assert.deepEqual(
    forecast.map((point) => [point.tauHours, point.windKt, point.gustKt]),
    [
      [0, 45, 55],
      [12, 45, 55],
      [24, 40, 50],
      [72, 30, 40],
    ],
  );
  assert.deepEqual(forecast[0].position, { longitude: -164.2, latitude: -11.5 });
});

test('classes come from the subject; broken warnings throw', () => {
  const typhoon = TCW.replace(
    'SUBJ:  TROPICAL CYCLONE 04P',
    'SUBJ:  SUPER TYPHOON 04P',
  );
  assert.equal(parseJtwcWarning('sh0427', typhoon).storm.classification, 'STY');
  for (const broken of [
    '',
    '<html>Access Denied</html>',
    TCW.replace(/^T000.*$/m, ''),
    TCW.replace('SUBJ:', 'XXXX:'),
    TCW.replace('T000 115S', 'T000 115X'),
  ])
    assert.throws(() => parseJtwcWarning('sh0427', broken), /invalid_jtwc/);
});

test('the danger swath makes the geometry current only for its own warning', () => {
  const warning = parseJtwcWarning('sh0427', TCW);
  const overlay = parseJtwcKml(kml(15));
  assert.equal(overlay.advisoryNumber, '15');
  assert.deepEqual(overlay.dangerArea, {
    type: 'Polygon',
    coordinates: [[...SWATH, SWATH[0]]],
  });
  const storm = withJtwcDangerArea(warning, overlay);
  assert.equal(storm.geometryStatus, 'current');
  assert.equal(storm.geometryAdvisoryNumber, '15');
  assert.equal(storm.cone, null);
  assert.deepEqual(storm.track.coordinates[0], [-164.2, -11.5]);
  assert.equal(storm.forecastPoints.length, 4);
  assert.equal(
    withJtwcDangerArea(warning, parseJtwcKml(kml(14))).geometryStatus,
    'pending',
  );
  assert.equal(withJtwcDangerArea(warning, null).geometryStatus, 'pending');
  assert.throws(() => parseJtwcKml('<kml></kml>'));
});

test('the KML is read out of the KMZ', () => {
  assert.equal(
    kmlFromKmz(zip({ 'images/logo.png': 'png', 'doc.kml': kml() })),
    kml(),
  );
  assert.throws(() => kmlFromKmz(new Uint8Array([1, 2, 3])));
  assert.throws(() => kmlFromKmz(zip({ 'logo.png': 'png' })));
});

function reader(answers) {
  const calls = [];
  const read = async (url, kind) => {
    calls.push(url);
    const answer = answers[url];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) return null;
    return kind === 'bytes' ? answer : String(answer);
  };
  return { read, calls };
}

test('every listed storm is read with its overlay; an unreadable overlay leaves its geometry unavailable', async () => {
  const products = (prefix, kmz) => ({
    [`${JTWC_PRODUCTS_URL}/${prefix}.tcw`]: TCW,
    [`${JTWC_PRODUCTS_URL}/${prefix}.kmz`]: kmz,
  });
  const good = reader({
    [JTWC_RSS_URL]: feed(),
    ...products('sh0427', zip({ 'doc.kml': kml() })),
  });
  const [storm] = await readJtwcStorms(good.read, NOW);
  assert.equal(storm.geometryStatus, 'current');
  assert.deepEqual(good.calls.sort(), [
    `${JTWC_PRODUCTS_URL}/sh0427.kmz`,
    `${JTWC_PRODUCTS_URL}/sh0427.tcw`,
    JTWC_RSS_URL,
  ]);

  const notPosted = reader({
    [JTWC_RSS_URL]: feed(),
    ...products('sh0427', undefined),
  });
  assert.equal(
    (await readJtwcStorms(notPosted.read, NOW))[0].geometryStatus,
    'pending',
  );
  const broken = reader({
    [JTWC_RSS_URL]: feed(),
    ...products('sh0427', new Uint8Array([1, 2, 3])),
  });
  assert.equal(
    (await readJtwcStorms(broken.read, NOW))[0].geometryStatus,
    'unavailable',
  );

  // A warning past 13 hours is left out; with every listed warning missing,
  // the read fails.
  assert.deepEqual(
    await readJtwcStorms(good.read, NOW + 13 * 3600_000),
    [],
  );
  const missing = reader({ [JTWC_RSS_URL]: feed() });
  await assert.rejects(readJtwcStorms(missing.read, NOW), /invalid_jtwc/);
  const down = reader({ [JTWC_RSS_URL]: new Error('down') });
  await assert.rejects(readJtwcStorms(down.read, NOW), /down/);
});

test('one storm whose warning cannot be read or parsed never stops the others', async () => {
  const { read } = reader({
    [JTWC_RSS_URL]: feed(['wp3026', 'sh0427', 'io0126']),
    [`${JTWC_PRODUCTS_URL}/wp3026.tcw`]: new Error('HTTP 500'),
    [`${JTWC_PRODUCTS_URL}/io0126.tcw`]: '<html>Access Denied</html>',
    [`${JTWC_PRODUCTS_URL}/sh0427.tcw`]: TCW,
    [`${JTWC_PRODUCTS_URL}/sh0427.kmz`]: zip({ 'doc.kml': kml() }),
  });
  const storms = await readJtwcStorms(read, NOW);
  assert.deepEqual(
    storms.map((storm) => [storm.id, storm.geometryStatus]),
    [['sh042027', 'current']],
  );
});

test('a danger swath crossing the antimeridian is kept, its longitudes wrapped', () => {
  const crossing = kml().replace(
    /<coordinates>\n[^<]*<\/coordinates>/,
    '<coordinates>179.5,-15,0 181,-16,0 180.5,-18,0 179.5,-17,0</coordinates>',
  );
  assert.deepEqual(parseJtwcKml(crossing).dangerArea, {
    type: 'Polygon',
    coordinates: [
      [
        [179.5, -15],
        [-179, -16],
        [-179.5, -18],
        [179.5, -17],
        [179.5, -15],
      ],
    ],
  });
  assert.equal(wrapJtwcLongitude(-181.5), 178.5);
  assert.equal(wrapJtwcLongitude(180), 180);
  assert.equal(wrapJtwcLongitude(-164.2), -164.2);
});
