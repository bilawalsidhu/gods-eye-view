import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeHtmlEntities,
  fieldLabel,
  htmlToText,
  kmlColor,
  parseDescriptionFields,
  wrapCardText,
  ghostMapsEventDate,
  isGhostMapsEventExpired,
  parseGhostMapsEventDate,
} from './records.js';

test('event dates parse ArcGIS calendar dates and timestamps consistently in UTC', () => {
  for (const [value, iso] of [
    ['10/28/2026', '2026-10-28T23:59:59.999Z'],
    ['10/28/2026 6:12:00 PM', '2026-10-28T18:12:00Z'],
    ['1/17/2026 9:46:41 AM', '2026-01-17T09:46:41Z'],
    ['10/28/2026 12:00 AM', '2026-10-28T00:00:00Z'],
    ['10/28/2026 12:00 PM', '2026-10-28T12:00:00Z'],
    ['2026-10-28', '2026-10-28T23:59:59.999Z'],
    ['2026-10-28T12:34:56', '2026-10-28T12:34:56Z'],
    ['2026-10-28T12:34:56.123-04:00', '2026-10-28T16:34:56.123Z'],
    ['2/29/2024', '2024-02-29T23:59:59.999Z'],
  ])
    assert.equal(parseGhostMapsEventDate(value), Date.parse(iso), value);
  for (const value of [
    '',
    '<Null>',
    'N/A',
    'unknown',
    '2/29/2026',
    '9/31/2026',
    '2026-02-30',
    '13/1/2026',
    '1/0/2026',
    '10/28/2026 13:00 PM',
    '2026-10-28T24:00:00Z',
    '2026-10-28T12:60:00Z',
  ]) {
    assert.equal(parseGhostMapsEventDate(value), null, value);
  }
});

test('event date fields take precedence over report dates and prose, even after long report tables', () => {
  const row = (label, value) => `<tr><td>${label}</td><td>${value}</td></tr>`;
  const html = `<table><tr><td><table>${
    row('Date Of Report', '11/2/2026') +
    row('Description', 'Incident mentioned on 11/1/2026') +
    Array.from({ length: 30 }, (_, i) => row(`Field${i}`, 'value')).join('') +
    row('Date', '10/30/2026') +
    row('Date of Event', '10/28/2026')
  }</table></td></tr></table>`;
  assert.equal(ghostMapsEventDate(html), Date.UTC(2026, 9, 29) - 1);
  assert.equal(
    ghostMapsEventDate(
      `<table>${row('Date', '&lt;Null&gt;')}${row('Date Of Report', '11/2/2026')}</table>`,
    ),
    null,
  );
  assert.equal(
    ghostMapsEventDate(`<table>${row('Date_Of_Event', '10/28/2026')}</table>`),
    Date.UTC(2026, 9, 29) - 1,
  );
  assert.equal(ghostMapsEventDate('Occurred 10/28/2026'), null);
  assert.equal(
    ghostMapsEventDate(
      `<script><table>${row('Date', '1/1/2020')}</table></script>`,
    ),
    null,
  );
});

test('seven-day expiry keeps the exact boundary, future dates and unknown dates', () => {
  const at = Date.UTC(2026, 10, 3, 12);
  assert.equal(isGhostMapsEventExpired(Date.UTC(2026, 9, 27, 12), at), false);
  assert.equal(
    isGhostMapsEventExpired(Date.UTC(2026, 9, 27, 12) - 1, at),
    true,
  );
  assert.equal(isGhostMapsEventExpired(Date.UTC(2026, 10, 4), at), false);
  for (const value of [null, undefined, NaN])
    assert.equal(isGhostMapsEventExpired(value, at), false);
});

// The shape ArcGIS Pro writes into every S2 placemark description.
const ARCGIS = `<html xmlns:fo="http://www.w3.org/1999/XSL/Format"><head>
<META http-equiv="Content-Type" content="text/html"></head>
<body style="margin:0px"><table style="font-family:Arial">
<tr style="text-align:center;font-weight:bold;background:#9CBCE2"><td>HistoricProtestSite</td></tr>
<tr><td><table style="font-family:Arial">
<tr><td>SHAPE</td><td>Point</td></tr>
<tr bgcolor="#D4E4F3"><td>InstallationType</td><td>HistoricProtestSite</td></tr>
<tr><td>OperationalStatus</td><td>ACTIVE</td></tr>
<tr bgcolor="#D4E4F3"><td>Affiliation</td><td>&lt;Null&gt;</td></tr>
<tr><td>Description</td><td>Locals gather here &amp; protest &#8212; weekly.</td></tr>
<tr><td>Research1</td><td><a target="_blank" href="https://x.com/a/status/1">https://x.com/a/status/1</a></td></tr>
<tr><td>Research2</td><td><a href="javascript:alert(1)">bad</a></td></tr>
<tr><td>Research3</td><td>&lt;Null&gt;</td></tr>
</table></td></tr></table></body><script type="text/javascript">
function changeImage(a, b) { document.getElementById('x').innerHTML = b; }
</script></html>`;

test('custom ages change the cutoff and all markers disables expiry', () => {
  const at = Date.UTC(2026, 10, 3, 12);
  const event = at - 10 * 86400_000;
  assert.equal(isGhostMapsEventExpired(event, at, 7), true);
  assert.equal(isGhostMapsEventExpired(event, at, 14), false);
  assert.equal(isGhostMapsEventExpired(event, at, null), false);
});

test('ArcGIS popup tables become plain label/value fields and http links', () => {
  const { fields, links } = parseDescriptionFields(ARCGIS);
  assert.deepEqual(fields, [
    { label: 'InstallationType', value: 'HistoricProtestSite' },
    { label: 'OperationalStatus', value: 'ACTIVE' },
    { label: 'Description', value: 'Locals gather here & protest — weekly.' },
    { label: 'Research2', value: 'bad' },
  ]);
  // javascript: and other schemes never become links.
  assert.deepEqual(links, ['https://x.com/a/status/1']);
});

test('free-form descriptions become one unlabelled field; scripts are dropped', () => {
  assert.deepEqual(
    parseDescriptionFields(
      '<p>Front line<br>as of 10 Oct</p><script>steal()</script><a href="https://s2.example/x">more</a>',
    ),
    {
      fields: [{ label: '', value: 'Front line as of 10 Oct more' }],
      links: ['https://s2.example/x'],
    },
  );
  assert.deepEqual(parseDescriptionFields(''), { fields: [], links: [] });
  assert.deepEqual(parseDescriptionFields(undefined), {
    fields: [],
    links: [],
  });
});

test('field values and counts are bounded', () => {
  const rows = Array.from(
    { length: 40 },
    (_, i) => `<tr><td>K${i}</td><td>${'x'.repeat(900)}</td></tr>`,
  ).join('');
  const { fields } = parseDescriptionFields(`<table>${rows}</table>`);
  assert.equal(fields.length, 24);
  assert.equal(fields[0].value.length, 600);
});

test('entities and tags decode to text', () => {
  assert.equal(
    decodeHtmlEntities('&lt;b&gt; &#x41;&#66; &nbsp;&bogus;'),
    '<b> AB  &bogus;',
  );
  assert.equal(decodeHtmlEntities('&#xD800;&#0;'), '');
  assert.equal(htmlToText('<style>a{}</style><b>One</b>\n two'), 'One two');
});

test('KML aabbggrr colors convert to rgba', () => {
  assert.deepEqual(kmlColor('ff0000ff'), [1, 0, 0, 1]);
  assert.deepEqual(kmlColor('8000ff00'), [0, 1, 0, 128 / 255]);
  assert.equal(kmlColor('red'), null);
  assert.equal(kmlColor(''), null);
});

test('card text wraps on words, cuts long words and marks truncation', () => {
  assert.deepEqual(wrapCardText('one two three four', 9, 4), [
    'one two',
    'three',
    'four',
  ]);
  assert.deepEqual(wrapCardText('abcdefghijkl', 5, 4), [
    'abcde',
    'fghij',
    'kl',
  ]);
  assert.deepEqual(wrapCardText('aa bb cc dd ee', 5, 2), ['aa bb', 'cc d…']);
  assert.deepEqual(wrapCardText('', 5, 2), []);
  for (const line of wrapCardText('word '.repeat(200), 20, 3))
    assert.ok(line.length <= 20);
});

test('CamelCase field labels read as words', () => {
  assert.equal(fieldLabel('OperationalStatus'), 'Operational Status');
  assert.equal(fieldLabel('Research1'), 'Research 1');
  assert.equal(fieldLabel('Kinetic_Activity'), 'Kinetic Activity');
});
