import test from 'node:test';
import assert from 'node:assert/strict';
import { containsOmiPoint, parseOmiQuotation } from './italianHousing.js';

const ring = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];
test('OMI zone assignment respects polygon holes and multipart zones', () => {
  const hole = [
    [4, 4],
    [6, 4],
    [6, 6],
    [4, 6],
    [4, 4],
  ];
  assert.equal(
    containsOmiPoint(
      { type: 'Polygon', coordinates: [ring, hole] },
      { lat: 2, lon: 2 },
    ),
    true,
  );
  assert.equal(
    containsOmiPoint(
      { type: 'Polygon', coordinates: [ring, hole] },
      { lat: 5, lon: 5 },
    ),
    false,
  );
  assert.equal(
    containsOmiPoint(
      { type: 'MultiPolygon', coordinates: [[ring]] },
      { lat: 2, lon: 2 },
    ),
    true,
  );
  assert.equal(
    containsOmiPoint(
      { type: 'Polygon', coordinates: [ring] },
      { lat: 11, lon: 2 },
    ),
    false,
  );
});
const row = (type, condition, low, high) =>
  `<tr><td>${type}&nbsp;</td><td>${condition}&nbsp;</td><td headers='vm vmmin'>${low}</td><td headers='vm vmmax'>${high}</td><td>L</td><td>10</td><td>20</td><td>L</td></tr>`;
test('OMI uses a declared residential range, not garages, rents or premium-type averages', () => {
  const quote = parseOmiQuotation(
    row('Box', 'NORMALE', 5000, 6900) +
      row('Abitazioni signorili', 'NORMALE', 8300, 11000) +
      row('Abitazioni civili', 'NORMALE', 7400, 9700),
  );
  assert.equal(quote.minimum, 7400);
  assert.equal(quote.maximum, 9700);
  assert.equal(quote.value, 8550);
  assert.equal(quote.propertyType, 'Standard apartments');
  assert.equal(quote.surface, 'gross floor area');
  assert.equal(parseOmiQuotation(row('Box', 'NORMALE', 5000, 6900)), null);
  assert.equal(
    parseOmiQuotation(row('Abitazioni civili', 'SCADENTE', 7400, 9700)),
    null,
  );
  assert.equal(
    parseOmiQuotation(row('Abitazioni civili', 'NORMALE', 9700, 7400)),
    null,
  );
  assert.equal(
    parseOmiQuotation(
      'captcha' + row('Abitazioni civili', 'NORMALE', 7400, 9700),
    ),
    null,
  );
});
