import { describe, expect, it } from 'vitest';

import {
  MessageBatcher,
  RECONNECT_BASE_MS,
  RECONNECT_CAP_MS,
  backoffDelay,
  parseServerMessage,
} from './ws';
import type { Batch } from './ws';
import { makeAircraft } from '../testing/aircraft';
import { makeSatellite } from '../testing/satellite';
import { makeVessel } from '../testing/vessel';

/** Collects batches and hands back a manual flush, so no test waits for a real frame. */
function harness() {
  const applied: Batch[] = [];
  const queued: (() => void)[] = [];
  const batcher = new MessageBatcher(
    (batch) => {
      applied.push(batch);
    },
    (flush) => {
      queued.push(flush);
    },
  );
  return { applied, queued, batcher };
}

describe('MessageBatcher', () => {
  it('applies a hundred updates for one aircraft once, with the last value', () => {
    const { applied, queued, batcher } = harness();

    for (let index = 0; index < 100; index += 1) {
      batcher.push({
        type: 'upsert',
        layer: 'aircraft',
        entities: [makeAircraft({ icao24: '4ca7b5', point: { lon: index, lat: 10 } })],
        server_time: '2026-08-19T12:00:00Z',
      });
    }

    // One frame requested, not one per message. This is what stops the jank.
    expect(queued).toHaveLength(1);
    expect(applied).toHaveLength(0);

    queued[0]?.();

    expect(applied).toHaveLength(1);
    expect(applied[0]?.aircraft.upserts.size).toBe(1);
    expect(applied[0]?.aircraft.upserts.get('4ca7b5')?.entity.point.lon).toBe(99);
  });

  it('keeps distinct aircraft distinct', () => {
    const { applied, queued, batcher } = harness();

    batcher.push({
      type: 'upsert',
      layer: 'aircraft',
      entities: [makeAircraft({ icao24: 'aaaaaa' }), makeAircraft({ icao24: 'bbbbbb' })],
      server_time: '2026-08-19T12:00:00Z',
    });
    queued[0]?.();

    expect([...(applied[0]?.aircraft.upserts.keys() ?? [])]).toEqual(['aaaaaa', 'bbbbbb']);
  });

  it('lets a removal win over an earlier update in the same frame', () => {
    const { applied, queued, batcher } = harness();

    batcher.push({
      type: 'upsert',
      layer: 'aircraft',
      entities: [makeAircraft({ icao24: 'aaaaaa' })],
      server_time: '2026-08-19T12:00:00Z',
    });
    batcher.push({
      type: 'remove',
      layer: 'aircraft',
      ids: ['aaaaaa'],
      server_time: '2026-08-19T12:00:01Z',
    });
    queued[0]?.();

    expect(applied[0]?.aircraft.upserts.size).toBe(0);
    expect(applied[0]?.aircraft.removals.get('aaaaaa')).toBe('aircraft');
  });

  it('lets an update win over an earlier removal in the same frame', () => {
    const { applied, queued, batcher } = harness();

    batcher.push({
      type: 'remove',
      layer: 'aircraft',
      ids: ['aaaaaa'],
      server_time: '2026-08-19T12:00:00Z',
    });
    batcher.push({
      type: 'upsert',
      layer: 'aircraft',
      entities: [makeAircraft({ icao24: 'aaaaaa' })],
      server_time: '2026-08-19T12:00:01Z',
    });
    queued[0]?.();

    expect(applied[0]?.aircraft.removals.size).toBe(0);
    expect(applied[0]?.aircraft.upserts.has('aaaaaa')).toBe(true);
  });

  it('drops deltas superseded by a snapshot of the same layer', () => {
    const { applied, queued, batcher } = harness();

    batcher.push({
      type: 'upsert',
      layer: 'aircraft',
      entities: [makeAircraft({ icao24: 'aaaaaa' })],
      server_time: '2026-08-19T12:00:00Z',
    });
    batcher.push({
      type: 'upsert',
      layer: 'military',
      entities: [makeAircraft({ icao24: 'cccccc' })],
      server_time: '2026-08-19T12:00:00Z',
    });
    batcher.push({
      type: 'snapshot',
      layer: 'aircraft',
      entities: [makeAircraft({ icao24: 'bbbbbb' })],
      server_time: '2026-08-19T12:00:01Z',
    });
    queued[0]?.();

    expect(applied[0]?.aircraft.snapshots.get('aircraft')).toHaveLength(1);
    // The military delta is untouched: a snapshot of one layer says nothing about another.
    expect([...(applied[0]?.aircraft.upserts.keys() ?? [])]).toEqual(['cccccc']);
  });

  it('keeps only the latest feed status', () => {
    const { applied, queued, batcher } = harness();
    const feed = {
      source: 'adsb.lol/point',
      layer: 'aircraft' as const,
      healthy: true,
      entity_count: 1,
      consecutive_failures: 0,
      poll_interval_seconds: 8,
    };

    batcher.push({ type: 'feed_status', feeds: [feed], server_time: '2026-08-19T12:00:00Z' });
    batcher.push({
      type: 'feed_status',
      feeds: [{ ...feed, entity_count: 412 }],
      server_time: '2026-08-19T12:00:01Z',
    });
    queued[0]?.();

    expect(applied[0]?.feeds).toEqual([{ ...feed, entity_count: 412 }]);
  });

  it('does nothing when a flush finds nothing waiting', () => {
    const { applied, batcher } = harness();

    batcher.flush();

    expect(applied).toHaveLength(0);
  });
});

/**
 * Routing, which is the whole reason this client is not typed to aircraft alone.
 *
 * The hub subscribes every new connection to every layer it holds, so a browser is sent
 * ships and satellites whether it asked for them or not. Before this, a vessel frame was
 * keyed on `entity.icao24`, which a vessel does not have, and a satellite frame reached the
 * aircraft layer, which read `record.point` off a record that carries orbital elements and
 * no position at all.
 */
describe('MessageBatcher routing', () => {
  const serverTime = '2026-08-19T12:00:00Z';

  it('keys a vessel on its MMSI and keeps it out of the aircraft change set', () => {
    const { applied, queued, batcher } = harness();

    batcher.push({
      type: 'upsert',
      layer: 'vessels',
      entities: [makeVessel({ mmsi: '230992610' })],
      server_time: serverTime,
    });
    queued[0]?.();

    expect([...(applied[0]?.vessels.upserts.keys() ?? [])]).toEqual(['230992610']);
    expect(applied[0]?.aircraft.upserts.size).toBe(0);
    expect(applied[0]?.ignored).toBe(0);
  });

  it('keys a satellite on its catalogue number and never sends it to a position layer', () => {
    const { applied, queued, batcher } = harness();

    batcher.push({
      type: 'snapshot',
      layer: 'satellites',
      entities: [makeSatellite({ norad_cat_id: 25_544 })],
      server_time: serverTime,
    });
    queued[0]?.();

    expect(applied[0]?.satellites.snapshots.get('satellites')).toHaveLength(1);
    expect(applied[0]?.aircraft.snapshots.size).toBe(0);
    expect(applied[0]?.vessels.snapshots.size).toBe(0);
  });

  it('carries all three kinds in one frame without any of them touching another', () => {
    const { applied, queued, batcher } = harness();

    batcher.push({
      type: 'snapshot',
      layer: 'aircraft',
      entities: [makeAircraft({ icao24: '4ca7b5' })],
      server_time: serverTime,
    });
    batcher.push({
      type: 'snapshot',
      layer: 'vessels',
      entities: [makeVessel({ mmsi: '230992610' })],
      server_time: serverTime,
    });
    batcher.push({
      type: 'snapshot',
      layer: 'satellites',
      entities: [makeSatellite()],
      server_time: serverTime,
    });
    queued[0]?.();

    // What a browser is actually sent on connect. One flush, three change sets, no
    // crossover: this is the shape the aircraft layer used to receive whole.
    expect(applied).toHaveLength(1);
    expect(applied[0]?.aircraft.snapshots.get('aircraft')).toHaveLength(1);
    expect(applied[0]?.vessels.snapshots.get('vessels')).toHaveLength(1);
    expect(applied[0]?.satellites.snapshots.get('satellites')).toHaveLength(1);
    expect(applied[0]?.ignored).toBe(0);
  });

  it('clears a layer on an empty snapshot rather than treating it as nothing to do', () => {
    const { applied, queued, batcher } = harness();

    batcher.push({ type: 'snapshot', layer: 'vessels', entities: [], server_time: serverTime });
    queued[0]?.();

    // Routed on the layer name, not on the kind of the entities in it: an empty snapshot
    // after a reconnect is the only thing that takes yesterday's ships off the globe, and
    // it carries no entity to read a kind off.
    expect(applied[0]?.vessels.snapshots.get('vessels')).toStrictEqual([]);
    expect(applied[0]?.ignored).toBe(0);
  });

  it('ignores and counts a frame for a layer this build cannot draw', () => {
    const { applied, queued, batcher } = harness();

    batcher.push({
      type: 'snapshot',
      layer: 'cameras',
      entities: [],
      server_time: serverTime,
    });
    batcher.push({ type: 'remove', layer: 'events', ids: ['1'], server_time: serverTime });
    queued[0]?.();

    // Counted, never thrown: a newer server adding a layer must not break an older tab.
    expect(applied[0]?.ignored).toBe(2);
    expect(applied[0]?.aircraft.snapshots.size).toBe(0);
    expect(applied[0]?.vessels.snapshots.size).toBe(0);
    expect(applied[0]?.satellites.snapshots.size).toBe(0);
  });

  it('drops an entity whose kind is not the one its layer carries, and counts it', () => {
    const { applied, queued, batcher } = harness();

    batcher.push({
      type: 'upsert',
      layer: 'vessels',
      entities: [makeVessel({ mmsi: '230992610' }), makeAircraft({ icao24: '4ca7b5' })],
      server_time: serverTime,
    });
    queued[0]?.();

    expect([...(applied[0]?.vessels.upserts.keys() ?? [])]).toEqual(['230992610']);
    expect(applied[0]?.aircraft.upserts.size).toBe(0);
    expect(applied[0]?.ignored).toBe(1);
  });

  it('resolves a removal against the layer that sent it, per kind', () => {
    const { applied, queued, batcher } = harness();

    batcher.push({
      type: 'upsert',
      layer: 'vessels',
      entities: [makeVessel({ mmsi: '230992610' })],
      server_time: serverTime,
    });
    batcher.push({
      type: 'remove',
      layer: 'vessels',
      ids: ['230992610'],
      server_time: serverTime,
    });
    queued[0]?.();

    expect(applied[0]?.vessels.upserts.size).toBe(0);
    expect(applied[0]?.vessels.removals.get('230992610')).toBe('vessels');
    expect(applied[0]?.aircraft.removals.size).toBe(0);
  });

  it('keys a satellite upsert on its catalogue number', () => {
    const { applied, queued, batcher } = harness();

    batcher.push({
      type: 'upsert',
      layer: 'satellites',
      entities: [makeSatellite({ norad_cat_id: 25_544 })],
      server_time: serverTime,
    });
    queued[0]?.();

    // A string on the wire, because every entity id is, and the catalogue number is what
    // the element cache is keyed on at both ends.
    expect([...(applied[0]?.satellites.upserts.keys() ?? [])]).toEqual(['25544']);
  });

  it('drops a pending removal when a snapshot of the same layer supersedes it', () => {
    const { applied, queued, batcher } = harness();

    batcher.push({
      type: 'remove',
      layer: 'vessels',
      ids: ['230992610'],
      server_time: serverTime,
    });
    batcher.push({
      type: 'snapshot',
      layer: 'vessels',
      entities: [makeVessel({ mmsi: '230992610' })],
      server_time: serverTime,
    });
    queued[0]?.();

    // The snapshot is the authoritative state of the layer, so a removal taken before it
    // is stale. Left in, it would take a ship the snapshot just delivered back off again.
    expect(applied[0]?.vessels.removals.size).toBe(0);
    expect(applied[0]?.vessels.snapshots.get('vessels')).toHaveLength(1);
  });

  it('flushes a frame that carried nothing but ignored layers', () => {
    const { applied, queued, batcher } = harness();

    batcher.push({ type: 'snapshot', layer: 'events', entities: [], server_time: serverTime });
    queued[0]?.();

    // The count is the only thing in the batch, and it has to reach a listener or the
    // mismatch between server and browser is invisible.
    expect(applied).toHaveLength(1);
    expect(applied[0]?.ignored).toBe(1);
  });
});

/** Jitter fixed so growth is what is being measured, not randomness. */
const fixed = () => 0.5;

describe('backoffDelay', () => {
  it('grows with each attempt and then stops growing at the cap', () => {
    const delays = Array.from({ length: 12 }, (_unused, attempt) => backoffDelay(attempt, fixed));

    const capped = RECONNECT_CAP_MS * 0.75;
    for (let index = 1; index < delays.length; index += 1) {
      const previous = delays[index - 1] ?? 0;
      const current = delays[index] ?? 0;
      expect(current).toBeGreaterThanOrEqual(previous);
      expect(current).toBeLessThanOrEqual(RECONNECT_CAP_MS);
    }
    expect(delays[0]).toBe(RECONNECT_BASE_MS * 0.75);
    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
    expect(delays.at(-1)).toBe(capped);
  });

  it('never exceeds the cap however long the outage', () => {
    for (const random of [() => 0, () => 0.999999]) {
      expect(backoffDelay(50, random)).toBeLessThanOrEqual(RECONNECT_CAP_MS);
    }
  });

  it('jitters, so every browser watching does not reconnect in the same instant', () => {
    expect(backoffDelay(4, () => 0)).toBeLessThan(backoffDelay(4, () => 1));
  });
});

describe('parseServerMessage', () => {
  it('reads a known message', () => {
    const parsed = parseServerMessage(
      '{"type":"remove","layer":"aircraft","ids":["aaaaaa"],"server_time":"2026-08-19T12:00:00Z"}',
    );

    expect(parsed?.type).toBe('remove');
  });

  it('drops anything it does not recognise rather than throwing', () => {
    expect(parseServerMessage('not json')).toBeNull();
    expect(parseServerMessage('null')).toBeNull();
    expect(parseServerMessage('{"type":"something_new"}')).toBeNull();
  });
});
