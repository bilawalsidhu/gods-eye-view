import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeHtmlEntities,
  fieldLabel,
  htmlToText,
  kmlColor,
  parseDescriptionFields,
  wrapCardText,
} from './records.js';

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
