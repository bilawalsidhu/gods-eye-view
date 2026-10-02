// The XML scanner behind GPX/KML import: what it reads, what it refuses, and
// the limits that keep an untrusted file from growing without bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PathImportError,
  childText,
  childrenNamed,
  decodeXmlText,
  descendantsNamed,
  firstChild,
  scanXml,
} from './pathXml.js';

const refusal = (code) => (error) =>
  error instanceof PathImportError && error.code === code;

test('elements, attributes and text come back as a plain tree', () => {
  const doc = scanXml(
    '<?xml version="1.0"?><gpx version="1.1"><wpt lat="1.5" lon=\'-2.5\'><name> Camp </name></wpt></gpx>',
  );
  const gpx = firstChild(doc, 'gpx');
  assert.equal(gpx.attrs.version, '1.1');
  const wpt = firstChild(gpx, 'wpt');
  assert.deepEqual(wpt.attrs, { lat: '1.5', lon: '-2.5' });
  assert.equal(childText(wpt, 'name'), 'Camp');
  assert.equal(childText(wpt, 'missing'), '');
});

test('names are lower-cased local names, so a namespace prefix does not matter', () => {
  const doc = scanXml(
    '<kml:kml><kml:Placemark><gx:Track><gx:coord>1 2 3</gx:coord></gx:Track></kml:Placemark></kml:kml>',
  );
  const tracks = descendantsNamed(doc, 'track');
  assert.equal(tracks.length, 1);
  assert.equal(childText(tracks[0], 'coord'), '1 2 3');
});

test('self-closing tags, comments, CDATA and a DOCTYPE are handled', () => {
  const doc = scanXml(
    [
      '<!DOCTYPE gpx [ <!ENTITY big "aaaa"> ]>',
      '<gpx><!-- a > b --><trkpt lat="1" lon="2"/>',
      '<name><![CDATA[Ridge <north> & back]]></name></gpx>',
    ].join('\n'),
  );
  const gpx = firstChild(doc, 'gpx');
  assert.equal(childrenNamed(gpx, 'trkpt').length, 1);
  assert.equal(childText(gpx, 'name'), 'Ridge <north> & back');
});

test('a ">" inside a quoted attribute does not end the tag', () => {
  const doc = scanXml('<a note="x > y" lat="4"><b/></a>');
  const a = firstChild(doc, 'a');
  assert.equal(a.attrs.note, 'x > y');
  assert.equal(a.attrs.lat, '4');
  assert.equal(a.children.length, 1);
});

test('predefined and numeric entities decode; declared entities are never expanded', () => {
  assert.equal(
    decodeXmlText('A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;'),
    'A & B <c> "d" \'e\'',
  );
  assert.equal(decodeXmlText('caf&#233; &#x1F600;'), 'café 😀');
  assert.equal(
    decodeXmlText('&big; &#0; &#xFFFFFFFF;'),
    '&big; &#0; &#xFFFFFFFF;',
  );
  const doc = scanXml(
    '<!DOCTYPE x [<!ENTITY big "&big;&big;&big;">]><x><name>&big;</name></x>',
  );
  assert.equal(childText(firstChild(doc, 'x'), 'name'), '&big;');
});

test('descendants are returned in document order', () => {
  const doc = scanXml('<r><f><p id="1"/><f><p id="2"/></f></f><p id="3"/></r>');
  assert.deepEqual(
    descendantsNamed(doc, 'p').map((node) => node.attrs.id),
    ['1', '2', '3'],
  );
});

test('a byte-order mark and surrounding whitespace are tolerated', () => {
  const doc = scanXml('﻿  \n<gpx></gpx>\n');
  assert.equal(doc.children.length, 1);
});

test('malformed documents are refused with a reason', () => {
  assert.throws(() => scanXml('<a><b></a>'), refusal('malformed-xml'));
  assert.throws(() => scanXml('<a>'), refusal('malformed-xml'));
  assert.throws(() => scanXml('</a>'), refusal('malformed-xml'));
  assert.throws(
    () => scanXml('<a><!-- never closed </a>'),
    refusal('malformed-xml'),
  );
  assert.throws(
    () => scanXml('<a><![CDATA[ never closed </a>'),
    refusal('malformed-xml'),
  );
  assert.throws(() => scanXml('<a lat="1'), refusal('malformed-xml'));
});

test('the node and depth ceilings are enforced', () => {
  assert.throws(
    () => scanXml(`<r>${'<p/>'.repeat(11)}</r>`, { maxNodes: 10 }),
    refusal('too-large'),
  );
  assert.doesNotThrow(() =>
    scanXml(`<r>${'<p/>'.repeat(9)}</r>`, { maxNodes: 10 }),
  );
  const deep = `${'<d>'.repeat(6)}${'</d>'.repeat(6)}`;
  assert.throws(() => scanXml(deep, { maxDepth: 5 }), refusal('too-deep'));
  assert.doesNotThrow(() => scanXml(deep, { maxDepth: 6 }));
});

test('a deeply nested file does not exhaust the stack when searched', () => {
  const depth = 60;
  const doc = scanXml(`${'<d>'.repeat(depth)}<leaf/>${'</d>'.repeat(depth)}`);
  assert.equal(descendantsNamed(doc, 'leaf').length, 1);
});

test('empty and non-string input scan to an empty document', () => {
  assert.equal(scanXml('').children.length, 0);
  assert.equal(scanXml(null).children.length, 0);
  assert.equal(scanXml('just text').children.length, 0);
});
