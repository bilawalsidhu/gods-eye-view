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
import type { Selection, TrackedAircraft } from './store';
import { makeAircraft } from '../testing/aircraft';
import { makeVessel } from '../testing/vessel';
import { emptyBatch } from '../net/ws';
import type { Batch } from '../net/ws';
import type { Aircraft, FeedHealth, LayerName, Vessel } from '../types/entities';

function upsertBatch(records: Aircraft[], layer: LayerName = 'aircraft'): Batch {
  const batch = emptyBatch();
  for (const record of records) {
    batch.aircraft.upserts.set(record.icao24, { entity: record, layer });
  }
  return batch;
}

function snapshotBatch(records: Aircraft[], layer: LayerName = 'aircraft'): Batch {
  const batch = emptyBatch();
  batch.aircraft.snapshots.set(layer, records);
  return batch;
}

function removalBatch(id: string, layer: LayerName = 'aircraft'): Batch {
  const batch = emptyBatch();
  batch.aircraft.removals.set(id, layer);
  return batch;
}

function vesselUpsertBatch(records: Vessel[]): Batch {
  const batch = emptyBatch();
  for (const record of records) {
    batch.vessels.upserts.set(record.mmsi, { entity: record, layer: 'vessels' });
  }
  return batch;
}

/** The selected aircraft, or null when nothing or a vessel is selected. */
function aircraftOf(selection: Selection | null): TrackedAircraft | null {
  return selection?.kind === 'aircraft' ? selection.aircraft : null;
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
function watchSelection(store: Store): (Selection | null)[] {
  const seen: (Selection | null)[] = [];
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

    store.applyBatch(snapshotBatch([makeAircraft({ icao24: 'ccc333' })]), 2000);

    // The military feed is a separate store server side; a viewport snapshot says nothing
    // about it.
    expect(store.size).toBe(2);
    expect(store.get('aaa111')).toBeUndefined();
    expect(store.get('mil001')).toBeDefined();
    expect(store.get('ccc333')).toBeDefined();
  });

  it('removes only when the removal comes from the layer that owns the aircraft', () => {
    const store = storeWith([makeAircraft({ icao24: 'mil001' })], 'military');

    store.applyBatch(removalBatch('mil001', 'aircraft'), 2000);
    expect(store.size).toBe(1);

    store.applyBatch(removalBatch('mil001', 'military'), 3000);
    expect(store.size).toBe(0);
  });

  it('ignores a removal for an aircraft it never held', () => {
    const store = storeWith();

    store.applyBatch(removalBatch('ghost1'), 1000);

    expect(store.size).toBe(0);
  });

  it('keeps the REST feed health when a batch carrying none arrives', () => {
    // The first paint reads /api/health, and the very next thing to happen is the REST
    // snapshot being applied as a batch with no feed status on it. Held here rather than
    // painted straight onto the panels, so that batch cannot blank every count on the rail.
    const store = storeWith();
    store.setFeeds([feedHealth({ entity_count: 11 })]);

    store.applyBatch(snapshotBatch([makeAircraft({ icao24: 'aaa111' })]), 1000);

    expect(store.feeds).toHaveLength(1);
    expect(store.feeds[0]?.entity_count).toBe(11);
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

    expect(aircraftOf(store.selected)?.aircraft.icao24).toBe('aaa111');
  });

  it('starts with nothing selected', () => {
    expect(twoAircraft().selected).toBeNull();
  });

  it('ignores a selection of something it does not hold', () => {
    const store = twoAircraft();
    store.select('aaa111');

    store.select('ghost1');

    // A click that missed should not close the card the user is reading.
    expect(aircraftOf(store.selected)?.aircraft.icao24).toBe('aaa111');
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

    expect(seen.map((entry) => aircraftOf(entry)?.aircraft.icao24 ?? null)).toEqual([
      'aaa111',
      'bbb222',
      null,
    ]);
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
    expect(aircraftOf(seen[0] ?? null)?.aircraft.callsign).toBe('BAW2');
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

    store.applyBatch(removalBatch('aaa111'), 2000);

    // Holding a card open over a position we no longer have is exactly the
    // frozen-but-looks-live display this app exists to avoid.
    expect(seen).toEqual([null]);
    expect(store.selected).toBeNull();
  });

  it('deselects when a snapshot drops the selected aircraft', () => {
    const store = oneSelected();
    const seen = watchSelection(store);

    store.applyBatch(snapshotBatch([makeAircraft({ icao24: 'bbb222' })]), 2000);

    expect(seen).toEqual([null]);
    expect(store.selected).toBeNull();
  });

  it('re-announces when a snapshot still carries the selected aircraft', () => {
    const store = oneSelected();
    const seen = watchSelection(store);

    store.applyBatch(snapshotBatch([makeAircraft({ icao24: 'aaa111', callsign: 'BAW3' })]), 2000);

    expect(seen).toHaveLength(1);
    expect(aircraftOf(seen[0] ?? null)?.aircraft.callsign).toBe('BAW3');
  });

  it('lets the selection be picked up again after the aircraft returns', () => {
    const store = oneSelected();
    store.applyBatch(removalBatch('aaa111'), 2000);

    store.applyBatch(upsertBatch([makeAircraft({ icao24: 'aaa111' })]), 3000);

    // Reappearing must not silently restore a selection the user did not make again.
    expect(store.selected).toBeNull();
    store.select('aaa111');
    expect(aircraftOf(store.selected)?.aircraft.icao24).toBe('aaa111');
  });
});

/**
 * Vessels, held beside aircraft rather than mixed in with them.
 *
 * The two share no identity: an aircraft is keyed on a six-hex ICAO address and a vessel on
 * a nine-digit MMSI. Keying both into one map is what put a vessel on the globe as an
 * aircraft with no position.
 */
describe('Store vessels', () => {
  it('holds a vessel snapshot keyed on MMSI, without touching the aircraft it holds', () => {
    const store = storeWith([makeAircraft({ icao24: 'aaa111' })]);

    store.applyVesselSnapshot([makeVessel({ mmsi: '230992610' })], 2000);

    expect(store.vesselCount).toBe(1);
    expect(store.vessel('230992610')?.vessel.name).toBe('FINNMAID');
    expect(store.vessel('230992610')?.receivedAtMs).toBe(2000);
    expect(store.size).toBe(1);
    expect(store.get('aaa111')).toBeDefined();
  });

  it('replaces the fleet on a snapshot, because a snapshot is the whole layer', () => {
    const store = storeWith();
    store.applyVesselSnapshot([makeVessel({ mmsi: '230992610' })], 1000);

    store.applyVesselSnapshot([makeVessel({ mmsi: '230123450' })], 2000);

    expect(store.vesselCount).toBe(1);
    expect(store.vessel('230992610')).toBeUndefined();
    expect(store.vessel('230123450')).toBeDefined();
  });

  it('applies a vessel upsert and a vessel removal', () => {
    const store = storeWith();

    store.applyBatch(vesselUpsertBatch([makeVessel({ mmsi: '230992610' })]), 1000);
    expect(store.vesselCount).toBe(1);

    const removal = emptyBatch();
    removal.vessels.removals.set('230992610', 'vessels');
    store.applyBatch(removal, 2000);

    expect(store.vesselCount).toBe(0);
  });

  it('leaves the vessels alone when an aircraft snapshot arrives, and the reverse', () => {
    const store = storeWith([makeAircraft({ icao24: 'aaa111' })]);
    store.applyVesselSnapshot([makeVessel({ mmsi: '230992610' })], 1000);

    store.applyBatch(snapshotBatch([makeAircraft({ icao24: 'bbb222' })]), 2000);

    expect(store.vesselCount).toBe(1);
    expect(store.size).toBe(1);
    expect(store.get('bbb222')).toBeDefined();
  });
});

describe('Store.select across kinds', () => {
  it('reports which kind is selected, so one click opens one card', () => {
    const store = storeWith([makeAircraft({ icao24: 'aaa111' })]);
    store.applyVesselSnapshot([makeVessel({ mmsi: '230992610' })], 1000);

    store.select('230992610');
    expect(store.selected?.kind).toBe('vessel');
    expect(store.selected?.id).toBe('230992610');

    store.select('aaa111');
    expect(store.selected?.kind).toBe('aircraft');
  });

  it('ignores a pick for an id neither map holds', () => {
    const store = storeWith([makeAircraft({ icao24: 'aaa111' })]);
    store.select('aaa111');

    store.select('999999999');

    expect(store.selected?.id).toBe('aaa111');
  });

  it('deselects when the selected vessel drops off the feed', () => {
    const store = storeWith();
    store.applyVesselSnapshot([makeVessel({ mmsi: '230992610' })], 1000);
    store.select('230992610');
    const seen = watchSelection(store);

    store.applyVesselSnapshot([], 2000);

    // Same rule as an aircraft: a card open over a position we no longer hold is the
    // frozen-but-looks-live display this app exists to avoid.
    expect(seen).toEqual([null]);
    expect(store.selected).toBeNull();
  });

  it('re-announces the selected vessel when a snapshot still carries her', () => {
    const store = storeWith();
    store.applyVesselSnapshot([makeVessel({ mmsi: '230992610' })], 1000);
    store.select('230992610');
    const seen = watchSelection(store);

    store.applyVesselSnapshot([makeVessel({ mmsi: '230992610', destination: 'FIHEL' })], 2000);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind === 'vessel' ? seen[0].vessel.vessel.destination : null).toBe('FIHEL');
  });

  it('re-announces the selected vessel when a fresh fix arrives for it', () => {
    const store = storeWith();
    store.applyVesselSnapshot([makeVessel({ mmsi: '230992610' })], 1000);
    store.select('230992610');
    const seen = watchSelection(store);

    store.applyBatch(
      vesselUpsertBatch([makeVessel({ mmsi: '230992610', speed_over_ground_mps: 4 })]),
      2000,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind === 'vessel' ? seen[0].vessel.vessel.speed_over_ground_mps : null).toBe(4);
  });
});
