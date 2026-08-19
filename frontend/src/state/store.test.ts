/**
 * Tests for the live state store.
 *
 * Pure logic over Maps, so nothing is mocked. Each test builds its own `Store` rather than
 * sharing the exported singleton, which would leak aircraft and a selection between tests.
 *
 * The behaviour worth guarding is mostly about not lying to the user: a card must not stay
 * open over an aircraft that has dropped off the feed, and a snapshot of one feed must not
 * wipe the other.
 */

import { describe, expect, it } from 'vitest';

import { Store } from './store';
import type { TrackedAircraft } from './store';
import { makeAircraft } from '../testing/aircraft';
import type { Batch } from '../net/ws';
import type { Aircraft, FeedHealth, LayerName } from '../types/entities';

function emptyBatch(): Batch {
  return { snapshots: new Map(), upserts: new Map(), removals: new Map(), feeds: null };
}

function upsertBatch(records: Aircraft[], layer: LayerName = 'aircraft'): Batch {
  return {
    ...emptyBatch(),
    upserts: new Map(records.map((record) => [record.icao24, { aircraft: record, layer }])),
  };
}

function feedHealth(overrides: Partial<FeedHealth> = {}): FeedHealth {
  return {
    source: 'adsb.lol',
    layer: 'aircraft',
    healthy: true,
    entity_count: 42,
    consecutive_failures: 0,
    poll_interval_seconds: 8,
    last_error: null,
    last_success_at: null,
    rate_limited_until: null,
    ...overrides,
  };
}

/** A store already holding these aircraft, so no test has to share one with another. */
function storeWith(records: Aircraft[] = [], layer: LayerName = 'aircraft'): Store {
  const store = new Store();
  if (records.length > 0) {
    store.applyBatch(upsertBatch(records, layer), 1000);
  }
  return store;
}

/** Two aircraft on the feed and nothing selected. */
function twoAircraft(): Store {
  return storeWith([makeAircraft({ icao24: 'aaa111' }), makeAircraft({ icao24: 'bbb222' })]);
}

/** One aircraft, already selected, which is the state the card is open in. */
function oneSelected(): Store {
  const store = storeWith([makeAircraft({ icao24: 'aaa111', callsign: 'BAW1' })]);
  store.select('aaa111');
  return store;
}

/** Records every selection announcement, in order. */
function watchSelection(store: Store): (TrackedAircraft | null)[] {
  const seen: (TrackedAircraft | null)[] = [];
  store.onSelectionChange((selected) => {
    seen.push(selected);
  });
  return seen;
}

describe('Store.applySnapshot', () => {
  it('holds what the REST snapshot delivered, keyed by ICAO address', () => {
    const store = storeWith();

    store.applySnapshot(
      'aircraft',
      [makeAircraft({ icao24: 'aaa111' }), makeAircraft({ icao24: 'bbb222' })],
      5000,
    );

    expect(store.size).toBe(2);
    expect(store.get('aaa111')?.aircraft.icao24).toBe('aaa111');
    expect(store.get('aaa111')?.layer).toBe('aircraft');
  });

  it('stamps the local arrival time, not the server clock', () => {
    const store = storeWith();

    store.applySnapshot(
      'aircraft',
      [makeAircraft({ icao24: 'aaa111', observed_at: '2001-01-01T00:00:00Z' })],
      7777,
    );

    // A browser clock minutes out from the server must not make every aircraft look stale.
    expect(store.get('aaa111')?.receivedAtMs).toBe(7777);
  });

  it('returns undefined for an aircraft it does not hold', () => {
    expect(storeWith().get('nothere')).toBeUndefined();
  });
});

describe('Store.applyBatch', () => {
  it('adds and updates on an upsert, keeping the newest fix', () => {
    const store = storeWith([makeAircraft({ icao24: 'aaa111', callsign: 'BAW1' })]);

    store.applyBatch(upsertBatch([makeAircraft({ icao24: 'aaa111', callsign: 'BAW2' })]), 2000);

    expect(store.size).toBe(1);
    expect(store.get('aaa111')?.aircraft.callsign).toBe('BAW2');
    expect(store.get('aaa111')?.receivedAtMs).toBe(2000);
  });

  it('lets a snapshot replace only its own layer', () => {
    const store = storeWith([makeAircraft({ icao24: 'aaa111' })]);
    store.applyBatch(upsertBatch([makeAircraft({ icao24: 'mil001' })], 'military'), 1000);

    store.applyBatch(
      { ...emptyBatch(), snapshots: new Map([['aircraft', [makeAircraft({ icao24: 'ccc333' })]]]) },
      2000,
    );

    // The military feed is a separate store server side; a viewport snapshot says nothing
    // about it.
    expect(store.size).toBe(2);
    expect(store.get('aaa111')).toBeUndefined();
    expect(store.get('mil001')).toBeDefined();
    expect(store.get('ccc333')).toBeDefined();
  });

  it('removes only when the removal comes from the layer that owns the aircraft', () => {
    const store = storeWith([makeAircraft({ icao24: 'mil001' })], 'military');

    store.applyBatch({ ...emptyBatch(), removals: new Map([['mil001', 'aircraft']]) }, 2000);
    expect(store.size).toBe(1);

    store.applyBatch({ ...emptyBatch(), removals: new Map([['mil001', 'military']]) }, 3000);
    expect(store.size).toBe(0);
  });

  it('ignores a removal for an aircraft it never held', () => {
    const store = storeWith();

    store.applyBatch({ ...emptyBatch(), removals: new Map([['ghost1', 'aircraft']]) }, 1000);

    expect(store.size).toBe(0);
  });

  it('keeps the last feed health it was given and ignores a batch that carries none', () => {
    const store = storeWith();
    expect(store.feeds).toEqual([]);

    store.applyBatch({ ...emptyBatch(), feeds: [feedHealth({ entity_count: 7 })] }, 1000);
    expect(store.feeds).toHaveLength(1);
    expect(store.feeds[0]?.entity_count).toBe(7);

    store.applyBatch(upsertBatch([makeAircraft({ icao24: 'aaa111' })]), 2000);
    // null means "no change", not "no feeds".
    expect(store.feeds[0]?.entity_count).toBe(7);
  });

  it('tells every change listener once per batch', () => {
    const store = storeWith();
    const seen: Batch[] = [];
    const alsoSeen: Batch[] = [];
    store.onChange((batch) => {
      seen.push(batch);
    });
    store.onChange((batch) => {
      alsoSeen.push(batch);
    });

    const batch = upsertBatch([
      makeAircraft({ icao24: 'aaa111' }),
      makeAircraft({ icao24: 'bbb222' }),
    ]);
    store.applyBatch(batch, 1000);

    // One call for the batch, not one per aircraft in it.
    expect(seen).toEqual([batch]);
    expect(alsoSeen).toEqual([batch]);
  });
});

describe('Store.select', () => {
  it('reports the selected record', () => {
    const store = twoAircraft();

    store.select('aaa111');

    expect(store.selected?.aircraft.icao24).toBe('aaa111');
  });

  it('starts with nothing selected', () => {
    expect(twoAircraft().selected).toBeNull();
  });

  it('ignores a selection of something it does not hold', () => {
    const store = twoAircraft();
    store.select('aaa111');

    store.select('ghost1');

    // A click that missed should not close the card the user is reading.
    expect(store.selected?.aircraft.icao24).toBe('aaa111');
  });

  it('deselects on null', () => {
    const store = twoAircraft();
    store.select('aaa111');

    store.select(null);

    expect(store.selected).toBeNull();
  });

  it('says nothing when the same aircraft is selected again', () => {
    const store = twoAircraft();
    const seen = watchSelection(store);
    store.select('aaa111');

    store.select('aaa111');

    expect(seen).toHaveLength(1);
  });

  it('announces each change to every selection listener', () => {
    const store = twoAircraft();
    const seen = watchSelection(store);
    const alsoSeen = watchSelection(store);

    store.select('aaa111');
    store.select('bbb222');
    store.select(null);

    expect(seen.map((entry) => entry?.aircraft.icao24 ?? null)).toEqual(['aaa111', 'bbb222', null]);
    expect(alsoSeen).toHaveLength(3);
  });
});

describe('Store selection under live traffic', () => {
  it('re-announces the selection when the selected aircraft gets a new fix', () => {
    const store = oneSelected();
    const seen = watchSelection(store);

    store.applyBatch(upsertBatch([makeAircraft({ icao24: 'aaa111', callsign: 'BAW2' })]), 2000);

    // The card shows a live record, so a new fix is a change as far as it is concerned.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aircraft.callsign).toBe('BAW2');
  });

  it('stays quiet when the batch does not touch the selected aircraft', () => {
    const store = oneSelected();
    const seen = watchSelection(store);

    store.applyBatch(upsertBatch([makeAircraft({ icao24: 'bbb222' })]), 2000);

    expect(seen).toHaveLength(0);
  });

  it('deselects when the selected aircraft is removed', () => {
    const store = oneSelected();
    const seen = watchSelection(store);

    store.applyBatch({ ...emptyBatch(), removals: new Map([['aaa111', 'aircraft']]) }, 2000);

    // Holding a card open over a position we no longer have is exactly the
    // frozen-but-looks-live display this app exists to avoid.
    expect(seen).toEqual([null]);
    expect(store.selected).toBeNull();
  });

  it('deselects when a snapshot drops the selected aircraft', () => {
    const store = oneSelected();
    const seen = watchSelection(store);

    store.applyBatch(
      { ...emptyBatch(), snapshots: new Map([['aircraft', [makeAircraft({ icao24: 'bbb222' })]]]) },
      2000,
    );

    expect(seen).toEqual([null]);
    expect(store.selected).toBeNull();
  });

  it('re-announces when a snapshot still carries the selected aircraft', () => {
    const store = oneSelected();
    const seen = watchSelection(store);

    store.applyBatch(
      {
        ...emptyBatch(),
        snapshots: new Map([['aircraft', [makeAircraft({ icao24: 'aaa111', callsign: 'BAW3' })]]]),
      },
      2000,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.aircraft.callsign).toBe('BAW3');
  });

  it('lets the selection be picked up again after the aircraft returns', () => {
    const store = oneSelected();
    store.applyBatch({ ...emptyBatch(), removals: new Map([['aaa111', 'aircraft']]) }, 2000);

    store.applyBatch(upsertBatch([makeAircraft({ icao24: 'aaa111' })]), 3000);

    // Reappearing must not silently restore a selection the user did not make again.
    expect(store.selected).toBeNull();
    store.select('aaa111');
    expect(store.selected?.aircraft.icao24).toBe('aaa111');
  });
});
