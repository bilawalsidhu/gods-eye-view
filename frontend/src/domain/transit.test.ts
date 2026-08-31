/**
 * The composite identity, and the separator that makes it safe.
 *
 * This is the whole of `domain/transit.ts`, so the tests are short. They are here rather than
 * folded into the socket's suite because the function is now shared: the layer draws slots under
 * this key and the socket removes them under it, and a test that lived in one of those two would
 * read as a fact about that consumer rather than about the key.
 */

import { describe, expect, it } from 'vitest';

import { transitKey } from './transit';

describe('transitKey', () => {
  it('joins the feed to the entity', () => {
    expect(transitKey({ feed_id: 'mta-nyct', entity_id: 'MTA NYCT_1234' })).toBe(
      'mta-nyct\tMTA NYCT_1234',
    );
  });

  it('separates on a tab, so ids containing a colon cannot collide', () => {
    // The mistake this exists to prevent. Under a colon separator these two distinct vehicles
    // both render as `a:b:c`, one silently replaces the other on the globe, and every removal
    // for the loser misses its slot for the life of the tab with nothing erroring.
    const first = transitKey({ feed_id: 'a', entity_id: 'b:c' });
    const second = transitKey({ feed_id: 'a:b', entity_id: 'c' });

    expect(first).not.toBe(second);
  });

  it('keys off the two fields alone, so a bare pair is enough to remove a vehicle', () => {
    // `Pick` rather than the whole record on purpose: a removal arriving as two strings must be
    // keyable without inventing the rest of a vehicle to hold them.
    expect(transitKey({ feed_id: 'x', entity_id: 'y' })).toBe('x\ty');
  });

  it('does not fold an empty field away', () => {
    // A feed with no id and an entity called `a` is not the same thing as a feed `a` with no
    // entity id, and a separator that vanished would make them one key.
    expect(transitKey({ feed_id: '', entity_id: 'a' })).not.toBe(
      transitKey({ feed_id: 'a', entity_id: '' }),
    );
  });
});
