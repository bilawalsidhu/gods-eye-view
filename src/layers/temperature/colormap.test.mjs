import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatStop,
  kelvinToCelsius,
  lookupStop,
  parseColormap,
} from './colormap.js';

// Shaped exactly like the published document, including its catch-all ends.
const XML = `<ColorMap units="K">
  <ColorMapEntry rgb="64,64,64" transparent="true" label="Fill" />
  <ColorMapEntry rgb="201,0,255" value="[0.02,200.00)" label="&lt;= 200.0 K" />
  <ColorMapEntry rgb="0,179,255" value="[249.80,250.40)" label="249.8 - 250.4 K" />
  <ColorMapEntry rgb="91,255,43" value="[273.20,273.80)" label="273.2 - 273.8 K" />
  <ColorMapEntry rgb="255,1,0" value="[350.02,652.00)" label="&gt;= 350.0 K" />
</ColorMap>`;

test('the fill entry is not a value and never becomes a stop', () => {
  const stops = parseColormap(XML);
  assert.equal(stops.length, 4);
  assert.ok(!stops.some((s) => s.r === 64 && s.g === 64 && s.b === 64));
});

test('the catch-all ends are flagged rather than treated as ranges', () => {
  // The document gives them [0.02,200) and [350.02,652), which are "everything
  // colder" and "everything hotter", not measurements.
  const stops = parseColormap(XML);
  assert.equal(stops[0].clampLow, true);
  assert.equal(stops[0].clampHigh, false);
  assert.equal(stops.at(-1).clampHigh, true);
  assert.equal(stops[1].clampLow, false);
  assert.equal(stops[1].clampHigh, false);
});

test('a bounded pixel reports the range it was quantised into', () => {
  const stops = parseColormap(XML);
  const hit = lookupStop(stops, { r: 0, g: 179, b: 255, a: 255 });
  assert.equal(hit.colorDistance, 0);
  // 250.40 - 273.15 is -22.749999... in floating point, so the upper bound
  // renders -22.7. Either way it is inside the product's own 0.6 K bucket.
  assert.equal(formatStop(hit), '-23.3 to -22.7 °C');
});

test('a clamped pixel reads as a bound, never as absolute zero', () => {
  // Regression: the first bucket starts at 0.02 K, so a naive range render
  // reported the Antarctic plateau as "-273.1 to -73.1 C".
  const stops = parseColormap(XML);
  assert.equal(formatStop(lookupStop(stops, { r: 201, g: 0, b: 255, a: 255 })), '≤ -73.1 °C');
  assert.equal(formatStop(lookupStop(stops, { r: 255, g: 1, b: 0, a: 255 })), '≥ 76.9 °C');
});

test('a transparent pixel has no temperature at all', () => {
  // Cloud, water and outside-retrieval all arrive as alpha 0. Matching the
  // nearest colour there would invent a reading.
  const stops = parseColormap(XML);
  assert.equal(lookupStop(stops, { r: 64, g: 64, b: 64, a: 0 }), null);
  assert.equal(lookupStop(stops, { r: 0, g: 179, b: 255, a: 0 }), null);
  assert.equal(formatStop(null), 'No clear-sky value');
});

test('lookup survives an unparsed or empty colour map', () => {
  assert.deepEqual(parseColormap(''), []);
  assert.deepEqual(parseColormap(null), []);
  assert.equal(lookupStop([], { r: 1, g: 2, b: 3, a: 255 }), null);
  assert.equal(lookupStop(null, { r: 1, g: 2, b: 3, a: 255 }), null);
});

test('PNG quantisation is tolerated by nearest match, and reported', () => {
  const stops = parseColormap(XML);
  const hit = lookupStop(stops, { r: 2, g: 177, b: 253, a: 255 });
  assert.equal(hit.lowK, 249.8);
  assert.ok(hit.colorDistance > 0 && hit.colorDistance < 5);
});

test('Kelvin converts exactly', () => {
  assert.equal(kelvinToCelsius(273.15), 0);
  assert.equal(Math.round(kelvinToCelsius(200)), -73);
});
