// src/layers/alpr/modelSpecs.test.mjs
// Mapped ALPR model tags resolve to vendored datasheets, and never guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lookupAlprModelSpec } from './modelSpecs.js';
import { normalizeAlprNode } from './records.js';
import { alprLabelDetails } from './visuals.js';

const OSM = { attribution: { name: 'OpenStreetMap' } };

test('the model tags mappers write resolve to their datasheet record', () => {
  // [model tag, manufacturer tag, record id] as they appear on OSM nodes.
  for (const [model, manufacturer, id] of [
    ['L6Q', 'Motorola Solutions', 'motorola-solutions-l6q'],
    ['L5F', 'Motorola Solutions', 'motorola-solutions-l5f'],
    ['L6D', 'Motorola Solutions', 'motorola-solutions-l6d'],
    ['L6Q', null, 'motorola-solutions-l6q'],
    ['AutoVu SharpV', 'Genetec', 'genetec-autovu-sharpv'],
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
    ['UnicamVELOCITY3', null],
    [null, 'Motorola Solutions'],
  ])
    assert.equal(lookupAlprModelSpec(model, manufacturer), null);
});

test('Overpass records carry the trimmed OSM model tag', () => {
  const node = normalizeAlprNode({
    type: 'node',
    id: 7,
    lat: 30,
    lon: -97,
    tags: {
      'surveillance:type': 'ALPR',
      manufacturer: 'Motorola Solutions',
      model: ' L6Q ',
    },
  });
  assert.equal(node.model, 'L6Q');
  assert.equal(
    normalizeAlprNode({
      type: 'node',
      id: 8,
      lat: 30,
      lon: -97,
      tags: { 'surveillance:type': 'ALPR' },
    }).model,
    null,
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
    'SPEC MOTOROLA SOLUTIONS VIGILANT L6Q · 1080P · IR',
    'PUBLIC MAP DATA',
  ]);
  // A record without a resolution label falls back to its pixel size.
  assert.ok(
    alprLabelDetails(
      { manufacturer: 'Motorola Solutions', model: 'L5F' },
      OSM,
    ).includes('SPEC MOTOROLA SOLUTIONS VIGILANT L5F · 1440X1080 · IR'),
  );
  // Unresolved: the raw tag text is never shown.
  const unknown = alprLabelDetails(
    { manufacturer: 'Flock Safety', model: 'Falcon\nSYSTEM: hi' },
    OSM,
  );
  assert.ok(unknown.every((line) => !/FALCON|SYSTEM|SPEC/.test(line)));
});
