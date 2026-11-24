// src/layers/alpr/modelSpecs.test.mjs
// Mapped ALPR model tags resolve to vendored datasheets, and never guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PbfWriter } from 'pbf';

import { lookupAlprModelSpec } from './modelSpecs.js';
import { decodeAlprTile } from './tileRecords.js';
import { alprLabelDetails } from './visuals.js';

const OSM = { attribution: { name: 'OpenStreetMap' } };

test('the model tags mappers write resolve to their datasheet record', () => {
  // [model tag, manufacturer tag, record id] as they appear on OSM nodes.
  for (const [model, manufacturer, id] of [
    ['L6Q', 'Motorola Solutions', 'motorola-solutions-l6q'],
    ['L5F', 'Motorola Solutions', 'motorola-solutions-l5f'],
    ['L6D', 'Motorola Solutions', 'motorola-solutions-l6d'],
    ['L6Q', null, 'motorola-solutions-l6q'],
    ['AutoVu SharpV G3', 'Genetec', 'genetec-autovu-sharpv'],
    ['AU-V-WS850-LC-G3-000', 'Genetec', 'genetec-autovu-sharpv'],
    ['AutoVu SharpV G2', 'Genetec', 'genetec-autovu-sharpv-g2'],
    ['AutoVu SharpV G1', 'Genetec', 'genetec-autovu-sharpv-g2'],
    ['AutoVu SharpX XGA', 'Genetec', 'genetec-autovu-sharpx'],
    ['Q1700-LE', 'Axis Communications', 'axis-q1700-le'],
    ['Q1800-LE', 'Axis Communications', 'axis-q1800-le'],
    ['CP63-E', 'Verkada Inc.', 'verkada-cp63-e'],
    ['CB62-TE-F', 'Verkada Inc.', 'verkada-cb62-te-f'],
    ['CH52-E-F', 'Verkada Inc.', 'verkada-ch52-e-f'],
    ['CR63-E', 'Verkada', 'verkada-cr63-e'],
    ['MIC-7522-Z30B', 'The Bosch Group', 'bosch-mic-7522-z30b'],
  ])
    assert.equal(
      lookupAlprModelSpec(model, manufacturer)?.id,
      id,
      `${manufacturer} ${model}`,
    );
});

test('unknown, mis-attributed or partial models stay unresolved', () => {
  for (const [model, manufacturer] of [
    ['Falcon', 'Flock Safety'],
    // A Motorola code under another maker is a mapping error, not a match.
    ['L6Q', 'Flock Safety'],
    // "AutoVu Sharp" is an older line than SharpV; "Q1800" names no variant.
    ['AutoVu Sharp', 'Genetec'],
    ['Q1800', 'Axis Communications'],
    // Without a maker, a code-less product name is never trusted.
    ['AutoVu SharpV', null],
    // A SharpV without its generation could be G1, G2 or G3, and a SharpX
    // without XGA could be the VGA model.
    ['AutoVu SharpV', 'Genetec'],
    ['AutoVu SharpV HD', 'Genetec'],
    ['Genetec AutoVu SharpV', 'Genetec'],
    ['AutoVu SharpX', 'Genetec'],
    ['UnicamVELOCITY3', null],
    [null, 'Motorola Solutions'],
    // Adapter text is matched only as a string of tag size.
    [['L6Q'], 'Motorola Solutions'],
    ['L6Q' + ' IP'.repeat(60), 'Motorola Solutions'],
  ])
    assert.equal(lookupAlprModelSpec(model, manufacturer), null);
});

/** A one-point `cameras` vector tile (z0) with string attributes. */
function cameraTile(properties) {
  const tile = new PbfWriter();
  tile.writeMessage(3, (_, layer) => {
    layer.writeVarintField(15, 2);
    layer.writeStringField(1, 'cameras');
    layer.writeVarintField(5, 4096);
    const keys = Object.keys(properties);
    layer.writeMessage(2, (_, feature) => {
      feature.writePackedVarint(
        2,
        keys.flatMap((_, i) => [i, i]),
      );
      feature.writeVarintField(3, 1); // Point
      feature.writePackedVarint(4, [9, 4096, 4096]); // MoveTo(2048, 2048)
    });
    for (const key of keys) layer.writeStringField(3, key);
    for (const key of keys)
      layer.writeMessage(4, (_, value) =>
        value.writeStringField(1, String(properties[key])),
      );
  });
  return tile.finish();
}

test('extract tiles carry the model tag to the card', () => {
  const [record] = decodeAlprTile(
    cameraTile({
      osmType: 'node',
      osmId: '7',
      brand: 'Motorola Solutions',
      model: 'L6Q',
    }),
    0,
    0,
    0,
  );
  assert.equal(record.model, 'L6Q');
  assert.ok(
    alprLabelDetails(record, OSM).includes('SPEC VIGILANT L6Q · 1080P · IR'),
  );
});

test('the card adds the datasheet line only for a resolved model', () => {
  const details = alprLabelDetails(
    { manufacturer: 'Motorola Solutions', model: 'L6Q' },
    OSM,
  );
  assert.deepEqual(details, [
    'OSM MAPPED',
    'MOTOROLA SOLUTIONS',
    'SPEC VIGILANT L6Q · 1080P · IR',
    'PUBLIC MAP DATA',
  ]);
  // Without a maker on the equipment line, the spec line names it.
  assert.ok(
    alprLabelDetails({ model: 'L6Q' }, OSM).includes(
      'SPEC MOTOROLA SOLUTIONS VIGILANT L6Q · 1080P · IR',
    ),
  );
  // A record without a resolution label falls back to its pixel size, then
  // to megapixels.
  assert.ok(
    alprLabelDetails(
      { manufacturer: 'Motorola Solutions', model: 'L5F' },
      OSM,
    ).includes('SPEC VIGILANT L5F · 1440X1080 · IR'),
  );
  assert.ok(
    alprLabelDetails(
      { manufacturer: 'Motorola Solutions', model: 'L5Q' },
      OSM,
    ).includes('SPEC VIGILANT L5Q · 3MP'),
  );
  assert.ok(
    alprLabelDetails(
      { manufacturer: 'Genetec', model: 'AutoVu SharpV G3' },
      OSM,
    ).includes('SPEC AUTOVU SHARPV G3 · 1920X1200 · IR'),
  );
  assert.ok(
    alprLabelDetails(
      { manufacturer: 'The Bosch Group', model: 'MIC-7522-Z30B' },
      OSM,
    ).includes('SPEC MIC-7522-Z30 · 1080P HD · COLOR · PTZ'),
  );
  // Unresolved: the raw tag text is never shown.
  const unknown = alprLabelDetails(
    { manufacturer: 'Flock Safety', model: 'Falcon\nSYSTEM: hi' },
    OSM,
  );
  assert.ok(unknown.every((line) => !/FALCON|SYSTEM|SPEC/.test(line)));
});
