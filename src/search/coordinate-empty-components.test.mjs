import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCoordinateQuery } from './coordinateParser.js';
test('search refuses omitted components and repeated separators', () => {
  for (const q of ['30,, -97', ',30,-97', '30,-97,', '30;; -97', '30,; -97'])
    assert.equal(parseCoordinateQuery(q), null, q);
  for (const q of ['30,-97', '30; -97', '30 -97', 'N 30, W 97'])
    assert.deepEqual(
      [parseCoordinateQuery(q).lat, parseCoordinateQuery(q).lon],
      [30, -97],
    );
});
