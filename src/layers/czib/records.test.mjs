import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CZIB_LIST_URL,
  czibAreaName,
  czibEffectiveStatus,
  czibLink,
  czibValidThroughMs,
  decodeEntities,
  isCzibInForce,
  isPartialArea,
  normalizeCzibEntry,
  normalizeCzibExport,
  parseCzibDay,
  parseCzibFeed,
  parseCzibStamp,
  sanitizeCzibBulletins,
} from './records.js';

// Shapes copied from the live EASA export and feed (2026-09-29).
const MALI = {
  Nid: '20585',
  issued_date: '2017-03-31T00:00:00+0300',
  valid_until_date: '31/10/2026',
  field_easa_valid_until_descr: '<p>31/10/2026, unless reviewed earlier.</p>\n',
  name: 'Airspace of Mali',
  status: 'Active',
  country: 'Mali',
  coordinates: '12.60503275, -7.9865136734394',
  updated:
    '<time datetime="2026-09-10T10:39:53+03:00">2026-09-10T10:39:53+0300</time>\n',
};
const GULF = {
  Nid: '143899',
  issued_date: '2026-07-14T00:00:00+0300',
  valid_until_date: '30/09/2026',
  field_easa_valid_until_descr:
    '<p>30/09/2026, unless reviewed earlier.&nbsp;</p>\n',
  name: 'Airspace of the Persian Gulf and Gulf of Oman',
  status: 'Active',
  country: 'Bahrain, Kuwait, Qatar, Oman, United Arab Emirates',
  coordinates: '',
  updated:
    '<time datetime="2026-08-31T14:31:02+03:00">2026-08-31T14:31:02+0300</time>\n',
};
const YEMEN = {
  Nid: '20590',
  issued_date: '2017-03-31T00:00:00+0300',
  valid_until_date: '31/10/2026',
  field_easa_valid_until_descr: '<p>31/10/2026</p>',
  name: 'Airspace of Yemen – Sana&#039;a Flight Information Region',
  status: 'Active',
  country: 'Yemen',
  updated: '<time datetime="2026-07-01T09:00:00+03:00">x</time>',
};
const KOREA = {
  Nid: '20591',
  issued_date: '2017-04-01T00:00:00+0300',
  valid_until_date: '',
  name: 'Airspace of North Korea – Pyongyang Flight Information Region',
  status: 'Withdrawn',
  country: 'Democratic People&#039;s Republic of Korea',
  updated: '',
};

const FEED = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Conflict Zones Advisories</title>
<item>
  <title>Airspace of the Persian Gulf and Gulf of Oman</title>
  <link>https://www.easa.europa.eu/domains/air-operations/czibs/czib-2026-07r2</link>
  <guid isPermaLink="false">143899 on Tue, 14 Jul 2026 00:00:00 +0300</guid>
</item>
<item>
  <title>Airspace of Mali</title>
  <link>https://www.easa.europa.eu/en/domains/air-operations/czibs/czib-2017-01r20</link>
  <guid isPermaLink="false">20585 on Fri, 31 Mar 2017 00:00:00 +0300</guid>
</item>
<item>
  <title>Airspace of Eastern Ukraine</title>
  <link>https://www.easa.europa.eu/domains/air-operations/czibs/sib-2014-21r1</link>
  <guid isPermaLink="false">900 on Tue, 01 Jul 2014 00:00:00 +0300</guid>
</item>
<item>
  <title>Elsewhere</title>
  <link>https://evil.example/domains/air-operations/czibs/czib-2026-01</link>
  <guid isPermaLink="false">901 on Tue, 01 Jul 2014 00:00:00 +0300</guid>
</item>
</channel></rss>`;

test('EASA stamps and validity days parse to UTC milliseconds', () => {
  assert.equal(
    parseCzibStamp('2017-03-31T00:00:00+0300'),
    Date.UTC(2017, 2, 30, 21),
  );
  assert.equal(
    parseCzibStamp('2026-09-10T10:39:53+03:00'),
    Date.UTC(2026, 8, 10, 7, 39, 53),
  );
  assert.equal(parseCzibStamp('2026-09-10'), null);
  assert.equal(parseCzibStamp(42), null);
  assert.equal(parseCzibDay('31/10/2026'), Date.UTC(2026, 9, 31));
  assert.equal(parseCzibDay('31/02/2026'), null, 'no rollover into March');
  assert.equal(parseCzibDay(''), null);
  assert.equal(parseCzibDay('2026-10-31'), null);
});

test('entities, area names and partial areas are read from the title', () => {
  assert.equal(
    decodeEntities('People&#039;s &amp; &#x41;&nbsp;&bogus;'),
    "People's & A &bogus;",
  );
  assert.equal(decodeEntities('&#0;&#x110000;'), '');
  assert.equal(
    czibAreaName('Airspace of the Russian Federation'),
    'Russian Federation',
  );
  assert.equal(
    czibAreaName('Iran and neighbouring airspace'),
    'Iran and neighbouring airspace',
  );
  assert.equal(
    isPartialArea('Pakistan – Baluchistan and Khyber Pakhtunkhwa provinces'),
    true,
  );
  assert.equal(isPartialArea('Egypt, North Sinai Governorate'), true);
  assert.equal(
    isPartialArea('Middle East (Iran, Iraq, Israel, Jordan and Lebanon)'),
    false,
  );
  assert.equal(isPartialArea('Persian Gulf and Gulf of Oman'), false);
});

test('feed links yield the bulletin number and a canonical EASA page, nothing else', () => {
  assert.deepEqual(
    czibLink(
      'https://www.easa.europa.eu/domains/air-operations/czibs/czib-2026-08-r1',
    ),
    { url: `${CZIB_LIST_URL}/czib-2026-08-r1`, number: 'CZIB-2026-08R1' },
  );
  assert.deepEqual(
    czibLink(
      'https://www.easa.europa.eu/domains/air-operations/czibs/czib-2025-03',
    ),
    { url: `${CZIB_LIST_URL}/czib-2025-03`, number: 'CZIB-2025-03' },
  );
  assert.equal(
    czibLink(
      'https://www.easa.europa.eu/domains/air-operations/czibs/other-page',
    ).number,
    '',
  );
  for (const bad of [
    'https://evil.example/domains/air-operations/czibs/czib-2026-01',
    'http://www.easa.europa.eu/domains/air-operations/czibs/czib-2026-01',
    'https://www.easa.europa.eu/domains/air-operations/czibs/czib-2026-01?x=1',
    'https://www.easa.europa.eu/domains/other/czib-2026-01',
    'javascript:alert(1)',
    'not a url',
  ])
    assert.equal(czibLink(bad), null, bad);
});

test('the RSS feed maps node ids to links and rejects non-RSS text', () => {
  const links = parseCzibFeed(FEED);
  assert.deepEqual([...links.keys()], ['143899', '20585', '900']);
  assert.equal(links.get('20585').number, 'CZIB-2017-01R20');
  assert.equal(links.get('900').number, 'SIB-2014-21R1');
  assert.equal(parseCzibFeed('<html></html>'), null);
  assert.equal(parseCzibFeed(null), null);
});

test('export entries normalize with countries, dates, validity and links', () => {
  const links = parseCzibFeed(FEED);
  assert.deepEqual(normalizeCzibEntry(GULF, links), {
    id: '143899',
    number: 'CZIB-2026-07R2',
    title: 'Airspace of the Persian Gulf and Gulf of Oman',
    area: 'Persian Gulf and Gulf of Oman',
    partial: false,
    status: 'active',
    countries: ['Bahrain', 'Kuwait', 'Qatar', 'Oman', 'United Arab Emirates'],
    issuedMs: Date.UTC(2026, 6, 13, 21),
    revisedMs: Date.UTC(2026, 7, 31, 11, 31, 2),
    validUntilMs: Date.UTC(2026, 8, 30),
    validity: '30/09/2026, unless reviewed earlier.',
    url: `${CZIB_LIST_URL}/czib-2026-07r2`,
  });
  const yemen = normalizeCzibEntry(YEMEN);
  assert.equal(
    yemen.title,
    "Airspace of Yemen – Sana'a Flight Information Region",
  );
  assert.equal(yemen.partial, true);
  assert.equal(yemen.number, '');
  assert.equal(yemen.url, null);
  const korea = normalizeCzibEntry(KOREA);
  assert.equal(korea.status, 'withdrawn');
  assert.deepEqual(korea.countries, ["Democratic People's Republic of Korea"]);
  assert.equal(korea.validUntilMs, null);
  assert.equal(korea.revisedMs, null);
  for (const bad of [
    null,
    { ...MALI, Nid: 'x' },
    { ...MALI, status: 'Draft' },
    { ...MALI, name: '<b></b>' },
  ])
    assert.equal(normalizeCzibEntry(bad), null);
});

test('the export sorts newest revision first, drops duplicates and rejects other shapes', () => {
  const bulletins = normalizeCzibExport(
    { conflict_zones: [MALI, GULF, YEMEN, KOREA, { ...MALI }, 'junk'] },
    parseCzibFeed(FEED),
  );
  assert.deepEqual(
    bulletins.map(({ id }) => id),
    ['20585', '143899', '20590', '20591'],
  );
  assert.equal(normalizeCzibExport({ conflict_zones: 'no' }), null);
  assert.equal(normalizeCzibExport([]), null);
});

test('records crossing the proxy are re-validated field by field', () => {
  const [record] = normalizeCzibExport(
    { conflict_zones: [MALI] },
    parseCzibFeed(FEED),
  );
  assert.deepEqual(sanitizeCzibBulletins([record]), [record]);
  const [hostile] = sanitizeCzibBulletins([
    {
      ...record,
      number: '<script>',
      title: '<img src=x onerror=1>Airspace of Mali',
      countries: ['Mali', 'Mali', 42, '<b>Niger</b>'],
      issuedMs: 'soon',
      url: 'https://evil.example/czib',
      extra: 'dropped',
    },
  ]);
  assert.deepEqual(hostile, {
    ...record,
    number: '',
    title: 'Airspace of Mali',
    countries: ['Mali', 'Niger'],
    issuedMs: null,
    url: null,
  });
  assert.equal(
    sanitizeCzibBulletins([
      { ...record, url: `${CZIB_LIST_URL}/../../evil` },
    ])[0].url,
    null,
  );
  assert.deepEqual(
    sanitizeCzibBulletins([
      record,
      { ...record },
      { ...record, id: '1', status: 'draft' },
      { ...record, id: '2', title: '' },
      null,
    ]).map(({ id }) => id),
    ['20585'],
  );
  assert.equal(sanitizeCzibBulletins('no'), null);
});

test('the effective status applies the published end date as a hard expiry', () => {
  const lastDay = Date.UTC(2026, 8, 30);
  const record = { status: 'active', validUntilMs: lastDay };
  // The last valid day is valid through its end, UTC.
  assert.equal(czibValidThroughMs(record), Date.UTC(2026, 9, 1));
  assert.equal(czibEffectiveStatus(record, lastDay - 1), 'active');
  assert.equal(
    czibEffectiveStatus(record, Date.UTC(2026, 8, 30, 23, 59)),
    'active',
  );
  assert.equal(czibEffectiveStatus(record, Date.UTC(2026, 9, 1)), 'expired');
  assert.equal(isCzibInForce(record, Date.UTC(2026, 8, 30, 12)), true);
  assert.equal(isCzibInForce(record, Date.UTC(2026, 9, 1)), false);
  // No published end date: kept, with the uncertainty named.
  const open = { status: 'active', validUntilMs: null };
  assert.equal(czibValidThroughMs(open), null);
  assert.equal(czibEffectiveStatus(open, Date.UTC(2099, 0, 1)), 'unverified');
  assert.equal(isCzibInForce(open, Date.UTC(2099, 0, 1)), true);
  // Withdrawn stays withdrawn, whatever its dates.
  for (const withdrawn of [
    { status: 'withdrawn', validUntilMs: Date.UTC(2099, 0, 1) },
    { status: 'withdrawn', validUntilMs: null },
    null,
  ]) {
    assert.equal(czibEffectiveStatus(withdrawn, lastDay), 'withdrawn');
    assert.equal(isCzibInForce(withdrawn, lastDay), false);
  }
});
