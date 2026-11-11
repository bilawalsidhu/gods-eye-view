import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGhostMapsCatalog,
  ghostMapsFileTitle,
  ghostMapsRawUrl,
  parseGhostMapsEdition,
  parseGitRefAdvertisement,
} from './catalog.js';

const ARCGIS = 'ArcGIS Data for ATAK (KMZs)/';
const INCIDENTS = 'Incident Response Products for ATAK (KMZs and Documents)/';
let n = 0;
const blob = (path, size = 1000) => ({
  path,
  type: 'blob',
  size,
  sha: (++n).toString(16).padStart(40, '0'),
});

test('editions read the date and export/version number written in the name', () => {
  assert.deepEqual(
    parseGhostMapsEdition(
      'S2Underground_Common_Intelligence_Picture_October_16_2026_Export_1.kmz',
    ),
    { dateMs: Date.UTC(2026, 9, 16), edition: 1 },
  );
  assert.deepEqual(
    parseGhostMapsEdition(
      'S2Underground_Border_Crisis_Map_September_21_2026_Export_v2.kmz',
    ),
    { dateMs: Date.UTC(2026, 8, 21), edition: 2 },
  );
  assert.deepEqual(
    parseGhostMapsEdition('Reno Wildfires August 24, 2026.kmz'),
    {
      dateMs: Date.UTC(2026, 7, 24),
      edition: 0,
    },
  );
  assert.deepEqual(
    parseGhostMapsEdition('Venezuelan_Crisis_Sep_5_2025_v2.kmz'),
    {
      dateMs: Date.UTC(2025, 8, 5),
      edition: 2,
    },
  );
  assert.deepEqual(
    parseGhostMapsEdition('Kinetic_Activities_Last_30_Days.kmz'),
    {
      dateMs: null,
      edition: 0,
    },
  );
  // An impossible date is not a date.
  assert.equal(parseGhostMapsEdition('X_September_31_2026.kmz').dateMs, null);
});

test('each product keeps its newest edition by date, then edition number', () => {
  const master = `${ARCGIS}Common Intelligence Picture/Master Database/`;
  const tree = [
    blob(
      `${master}S2Underground_Common_Intelligence_Picture_October_9_2026_Export_1.kmz`,
    ),
    blob(
      `${master}S2Underground_Common_Intelligence_Picture_October_16_2026_Export_1.kmz`,
    ),
    blob(
      `${master}S2Underground_Common_Intelligence_Picture_October_1_2026_Export_1.kmz`,
    ),
    blob(
      `${master}S2Underground_Common_Intelligence_Picture_September_30_2026_Export_2.kmz`,
    ),
    blob(
      `${ARCGIS}Common Intelligence Picture/30-Day Pulls/Kinetic_Activities_Last_30_Days.kmz`,
    ),
    blob(
      `${ARCGIS}Border Crisis Map/S2Underground_Border_Crisis_Map_September_21_2026_Export_v1.kmz`,
    ),
    blob(
      `${ARCGIS}Border Crisis Map/S2Underground_Border_Crisis_Map_September_21_2026_Export_v2.kmz`,
    ),
    // A European-only subset in a subfolder is not the border map.
    blob(
      `${ARCGIS}Border Crisis Map/European Layers Only/Europe_Migration_Crisis_June_02_2026_v1.kmz`,
    ),
    blob(`${INCIDENTS}Yemen 2026/Yemen FLOT.kmz`),
    blob(`${INCIDENTS}Yemen 2026/Yemen FLOT_October_10_2026.kmz`),
    { path: `${INCIDENTS}Yemen 2026`, type: 'tree', sha: 'f'.repeat(40) },
  ];
  const rows = buildGhostMapsCatalog(tree);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.deepEqual(
    rows.map(({ id }) => id),
    ['cip', 'kinetic-30d', 'border-crisis', 'yemen-flot'],
  );
  assert.match(byId.cip.fileName, /October_16_2026/);
  assert.equal(byId.cip.defaultOn, true);
  assert.equal(byId['kinetic-30d'].defaultOn, true);
  assert.match(byId['border-crisis'].fileName, /Export_v2/);
  assert.equal(byId['yemen-flot'].fileName, 'Yemen FLOT_October_10_2026.kmz');
  assert.equal(byId.cip.version, tree[1].sha);
  assert.equal(
    byId.cip.fileTitle,
    'Common Intelligence Picture October 16 2026 Export 1',
  );
});

test('latest drop is the newest dated incident file outside curated, archived and base data', () => {
  const rows = buildGhostMapsCatalog([
    blob(`${INCIDENTS}Reno Wildfires August 24, 2026.kmz`),
    blob(
      `${INCIDENTS}Spokane Fire Disaster - August, 2026/SpokaneDisasterAid_August_8_2026.kmz`,
    ),
    blob(
      `${INCIDENTS}0_Archive/Texas Floods/TexasFloods_December_1_2026_v1.kmz`,
    ),
    blob(`${INCIDENTS}Iran 2026/Basedata/Pipelines_December_1_2026.kmz`),
    blob(
      `${INCIDENTS}Iran 2026/Iran Kinetic Events/Iran_Kinetic_Events_December_2_2026_v1.kmz`,
    ),
    blob(`${INCIDENTS}Undated Product.kmz`),
  ]);
  const drop = rows.find(({ id }) => id === 'latest-drop');
  assert.equal(drop.fileName, 'Reno Wildfires August 24, 2026.kmz');
  assert.ok(rows.some(({ id }) => id === 'iran-kinetic'));
});

test('oversized, empty, non-KMZ and malformed entries are skipped', () => {
  const path = `${ARCGIS}Common Intelligence Picture/Master Database/S2Underground_Common_Intelligence_Picture_October_16_2026_Export_1.kmz`;
  assert.deepEqual(
    buildGhostMapsCatalog([
      { ...blob(path), size: 51 * 1024 * 1024 },
      { ...blob(path), size: 0 },
      { ...blob(path), sha: 'not-a-sha' },
      blob(path.replace(/\.kmz$/, '.zip')),
      null,
    ]),
    [],
  );
  assert.deepEqual(buildGhostMapsCatalog(undefined), []);
});

test('raw URLs are pinned to the commit and encode every path segment', () => {
  assert.equal(
    ghostMapsRawUrl('a'.repeat(40), 'Folder (KMZs)/Yemen FLOT.kmz'),
    `https://raw.githubusercontent.com/s2underground/GhostMaps/${'a'.repeat(40)}/Folder%20(KMZs)/Yemen%20FLOT.kmz`,
  );
  assert.equal(ghostMapsFileTitle('S2Underground_A__B.kmz'), 'A B');
});

test('the branch head comes from the smart-HTTP ref advertisement', () => {
  const head = '142d7630bc8f1f2c4b96e16ee865ca50d1ab578d';
  const other = 'b'.repeat(40);
  const text = [
    '001e# service=git-upload-pack',
    `0159${head} HEAD\0multi_ack symref=HEAD:refs/heads/main`,
    `003f${other} refs/heads/main-old`,
    `003d${head} refs/heads/main`,
    '0000',
  ].join('\n');
  assert.equal(parseGitRefAdvertisement(text), head);
  assert.equal(parseGitRefAdvertisement(text, 'dev'), null);
  assert.equal(parseGitRefAdvertisement(''), null);
});
