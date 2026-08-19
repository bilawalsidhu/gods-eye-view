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
    expect(applied[0]?.upserts.size).toBe(1);
    expect(applied[0]?.upserts.get('4ca7b5')?.aircraft.point.lon).toBe(99);
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

    expect([...(applied[0]?.upserts.keys() ?? [])]).toEqual(['aaaaaa', 'bbbbbb']);
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

    expect(applied[0]?.upserts.size).toBe(0);
    expect(applied[0]?.removals.get('aaaaaa')).toBe('aircraft');
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

    expect(applied[0]?.removals.size).toBe(0);
    expect(applied[0]?.upserts.has('aaaaaa')).toBe(true);
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

    expect(applied[0]?.snapshots.get('aircraft')).toHaveLength(1);
    // The military delta is untouched: a snapshot of one layer says nothing about another.
    expect([...(applied[0]?.upserts.keys() ?? [])]).toEqual(['cccccc']);
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
