import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AFFILIATION_COLOR, cotAffiliation, cotIsExpired } from './cotEvent.js';

test('cotAffiliation: decodes the 2nd hyphen-segment of an atom type', () => {
  assert.equal(cotAffiliation('a-f-G-U-C'), 'FRIENDLY');
  assert.equal(cotAffiliation('a-h-A-M-F'), 'HOSTILE');
  assert.equal(cotAffiliation('a-n-G'), 'NEUTRAL');
  assert.equal(cotAffiliation('a-u-G'), 'UNKNOWN');
});

test('cotAffiliation: non-atom types and unknown codes have no affiliation', () => {
  assert.equal(cotAffiliation('b-m-p-s-p-i'), null); // point of interest, not an atom
  assert.equal(cotAffiliation('a-z-G'), null); // unrecognized affiliation code
  assert.equal(cotAffiliation(null), null);
  assert.equal(cotAffiliation(undefined), null);
});

test('every AFFILIATION_COLOR key is a real cotAffiliation() output', () => {
  for (const key of Object.keys(AFFILIATION_COLOR)) {
    assert.equal(cotAffiliation(`a-${affiliationCodeFor(key)}-G`), key);
  }
});

function affiliationCodeFor(label) {
  const codes = { FRIENDLY: 'f', ASSUMED_FRIEND: 'a', HOSTILE: 'h', SUSPECT: 's', FAKER: 'k', NEUTRAL: 'n', UNKNOWN: 'u', PENDING: 'p', JOKER: 'j' };
  return codes[label];
}

test('cotIsExpired: compares against the event\'s own stale timestamp', () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z');
  assert.equal(cotIsExpired('2026-08-24T13:00:00.000Z', now), false);
  assert.equal(cotIsExpired('2026-08-24T11:59:59.000Z', now), true);
  assert.equal(cotIsExpired(null, now), false); // no stale time — never expires on this check
  assert.equal(cotIsExpired('not a date', now), false);
});
