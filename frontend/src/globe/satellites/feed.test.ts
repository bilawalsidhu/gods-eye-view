/**
 * Tests for the main-thread side of the propagation worker, against a fake port.
 *
 * No `Worker` and no Cesium: the point of the port interface is that all of this runs in the
 * node test runner. The fake propagates nothing, it just records what was asked for and lets
 * a test hand back a reply, which is what makes the backpressure and the stale-reply guard
 * assertable rather than assumed.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  SATELLITE_ELEMENT_RELOAD_MS,
  SatelliteFeed,
  feedReason,
  satelliteNotices,
  withDrawnSatelliteCount,
} from './feed';
import type { EnginePort } from './feed';
import type { EngineReply, EngineRequest, OrbitTrack } from './orbit';
import { emptyChanges } from '../../net/ws';
import { makeSatellite } from '../../testing/satellite';
import type { FeedHealth, Satellite } from '../../types/entities';

/** A port that records requests and replies only when a test says so. */
function fakePort() {
  const sent: EngineRequest[] = [];
  let listener: ((event: MessageEvent<EngineReply>) => void) | null = null;
  let terminated = false;
  const port: EnginePort = {
    postMessage: (message) => {
      sent.push(message);
    },
    addEventListener: (_type, next) => {
      listener = next;
    },
    terminate: () => {
      terminated = true;
    },
  };
  return {
    port,
    sent,
    get terminated() {
      return terminated;
    },
    reply(message: EngineReply) {
      if (listener === null) {
        throw new Error('the feed never subscribed to the port');
      }
      listener({ data: message } as MessageEvent<EngineReply>);
    },
  };
}

function changes() {
  return emptyChanges<Satellite>();
}

function positions(ids: number[], extra: { dropped?: number; stale?: number } = {}): EngineReply {
  return {
    type: 'positions',
    atMs: 0,
    ids: new Int32Array(ids),
    lonLatAlt: new Float64Array(ids.length * 3),
    dropped: extra.dropped ?? 0,
    stale: extra.stale ?? 0,
  };
}

function build() {
  const fake = fakePort();
  const onPositions = vi.fn<(ids: Int32Array, lonLatAlt: Float64Array) => void>();
  const onOrbit =
    vi.fn<
      (noradCatId: number | null, lonLatAlt: Float64Array | null, track: OrbitTrack | null) => void
    >();
  const onState = vi.fn();
  const feed = new SatelliteFeed({ port: fake.port, onPositions, onOrbit, onState });
  return { feed, fake, onPositions, onOrbit, onState };
}

describe('loading elements', () => {
  it('hands the worker the element sets and publishes what it accepted', () => {
    const { feed, fake, onState } = build();

    feed.load([makeSatellite()]);
    expect(fake.sent[0]).toMatchObject({ type: 'elements' });

    fake.reply({ type: 'elements', accepted: 1, rejected: 0 });

    expect(feed.state).toMatchObject({ elements: 1, rejected: 0, reason: null });
    expect(onState).toHaveBeenCalledTimes(1);
  });

  it('says so when element sets would not load', () => {
    const { feed, fake } = build();

    feed.load([makeSatellite()]);
    fake.reply({ type: 'elements', accepted: 40, rejected: 2 });

    expect(feed.state.reason).toBe('2 element sets would not load.');
  });
});

describe('asking for positions', () => {
  it('does not ask until it has elements, so an empty layer costs nothing', () => {
    const { feed, fake } = build();

    feed.tick(1000);

    expect(fake.sent).toHaveLength(0);
  });

  it('keeps exactly one request in flight', () => {
    // A frame that arrives while the worker is still propagating the last one is skipped, not
    // queued. A queue lets the worker fall behind the clock and then draw a position from
    // several frames ago, which reads as stutter and is a lie about where the object is.
    const { feed, fake, onPositions } = build();
    feed.load([makeSatellite()]);
    fake.reply({ type: 'elements', accepted: 1, rejected: 0 });
    const before = fake.sent.length;

    feed.tick(1000);
    feed.tick(1016);
    feed.tick(1032);
    expect(fake.sent).toHaveLength(before + 1);
    expect(fake.sent.at(-1)).toEqual({ type: 'positions', atMs: 1000 });

    fake.reply(positions([25_544]));
    feed.tick(1048);

    expect(fake.sent).toHaveLength(before + 2);
    expect(fake.sent.at(-1)).toEqual({ type: 'positions', atMs: 1048 });
    expect(onPositions).toHaveBeenCalledTimes(1);
  });

  it('passes the worker arrays straight to the layer', () => {
    const { feed, fake, onPositions } = build();
    feed.load([makeSatellite()]);
    fake.reply({ type: 'elements', accepted: 2, rejected: 0 });
    feed.tick(1000);

    const reply = positions([25_544, 20_580]);
    fake.reply(reply);

    expect(onPositions).toHaveBeenCalledWith(
      (reply as Extract<EngineReply, { type: 'positions' }>).ids,
      (reply as Extract<EngineReply, { type: 'positions' }>).lonLatAlt,
    );
    expect(feed.state.rendered).toBe(2);
  });

  it('reports the drop and the staleness the worker counted', () => {
    const { feed, fake } = build();
    feed.load([makeSatellite()]);
    fake.reply({ type: 'elements', accepted: 10, rejected: 0 });
    feed.tick(1000);

    fake.reply(positions([25_544], { dropped: 3, stale: 6 }));

    expect(feed.state).toMatchObject({ elements: 10, rendered: 1, dropped: 3, stale: 6 });
    expect(feed.state.reason).toBe(
      '6 element sets more than 3.5 days old, not drawn. · 3 objects dropped: would not propagate.',
    );
  });
});

describe('the orbit trail', () => {
  it('asks for one trail for the selection and clears it on deselection', () => {
    const { feed, fake, onOrbit } = build();

    feed.setSelected(25_544, 5000);
    expect(fake.sent).toEqual([{ type: 'orbit', noradCatId: 25_544, atMs: 5000 }]);

    const lonLatAlt = new Float64Array([0, 0, 400_000, 1, 1, 400_000]);
    const track = { lonLatAlt, nowIndex: 0, epochMs: 0, spanMs: 5_574_000 };
    fake.reply({ type: 'orbit', noradCatId: 25_544, track });
    // The flat array and the track both, so a renderer drawing one undifferentiated line
    // needs no knowledge of the track contract and one drawing the half ahead differently
    // has the split index to do it with.
    expect(onOrbit).toHaveBeenCalledWith(25_544, lonLatAlt, track);

    feed.setSelected(null);
    expect(onOrbit).toHaveBeenLastCalledWith(null, null, null);
    // Deselecting asks the worker for nothing.
    expect(fake.sent).toHaveLength(1);
  });

  it('asks once for a selection that has not changed', () => {
    const { feed, fake } = build();

    feed.setSelected(25_544, 5000);
    feed.setSelected(25_544, 6000);

    expect(fake.sent).toHaveLength(1);
  });

  it('drops a trail whose selection has already moved on', () => {
    const { feed, fake, onOrbit } = build();
    feed.setSelected(25_544, 5000);
    feed.setSelected(20_580, 5001);

    fake.reply({
      type: 'orbit',
      noradCatId: 25_544,
      track: { lonLatAlt: new Float64Array([0, 0, 0]), nowIndex: 0, epochMs: 0, spanMs: 1 },
    });

    expect(onOrbit).not.toHaveBeenCalledWith(25_544, expect.anything(), expect.anything());
  });
});

describe('stopping', () => {
  it('terminates the worker and stops asking it for anything', () => {
    const { feed, fake } = build();
    feed.load([makeSatellite()]);
    fake.reply({ type: 'elements', accepted: 1, rejected: 0 });

    feed.stop();
    feed.tick(1000);
    feed.load([makeSatellite()]);

    expect(fake.terminated).toBe(true);
    expect(fake.sent.filter((message) => message.type === 'positions')).toHaveLength(0);
    expect(fake.sent.filter((message) => message.type === 'elements')).toHaveLength(1);
  });
});

describe('feedReason', () => {
  const base = { elements: 0, rejected: 0, rendered: 0, dropped: 0, stale: 0 };

  it('says there is nothing to draw when no elements are cached', () => {
    // Which is what the browser sees while CelesTrak is unreachable and the backend has
    // nothing cached. The reason the server gives for the layer being unavailable comes from
    // /api/capabilities and sits alongside this, rather than being invented here.
    expect(feedReason(base)).toBe('No orbital elements cached, so no satellite can be drawn.');
  });

  it('says nothing at all when everything loaded is drawn', () => {
    expect(feedReason({ ...base, elements: 40, rendered: 40 })).toBeNull();
  });

  it('will not let stale elements pass as live', () => {
    // The important one. While CelesTrak is down the backend keeps serving the elements it
    // last fetched, and an element set propagated days past its epoch still returns a clean
    // error code and a plausible altitude. Silence here would be the layer presenting stale
    // elements as live.
    expect(feedReason({ ...base, elements: 40, rendered: 0, stale: 40 })).toBe(
      'Every element set is more than 3.5 days old, so nothing is drawn: CelesTrak has not answered since.',
    );
    expect(feedReason({ ...base, elements: 40, rendered: 35, stale: 5 })).toBe(
      '5 element sets more than 3.5 days old, not drawn.',
    );
  });

  it('names a propagation failure separately from staleness', () => {
    expect(feedReason({ ...base, elements: 40, rendered: 39, dropped: 1 })).toBe(
      '1 object dropped: would not propagate.',
    );
  });
});

function health(layer: FeedHealth['layer'], count: number): FeedHealth {
  return {
    source: layer === 'satellites' ? 'celestrak' : 'adsb.lol',
    layer,
    healthy: true,
    entity_count: count,
    poll_interval_seconds: 60,
    consecutive_failures: 0,
  };
}

describe('withDrawnSatelliteCount', () => {
  it('replaces the satellite count with what the browser is drawing', () => {
    // The server counts element sets it holds. A decayed object and an element set older than
    // 3.5 days are both held and neither is drawn, so the number next to the layer has to be
    // the browser's.
    const rewritten = withDrawnSatelliteCount(
      [health('satellites', 9000), health('aircraft', 400)],
      42,
    );

    expect(rewritten[0]?.entity_count).toBe(42);
    expect(rewritten[1]?.entity_count).toBe(400);
  });

  it('leaves everything else alone, including when there is no satellite feed', () => {
    const feeds = [health('aircraft', 400)];

    expect(withDrawnSatelliteCount(feeds, 42)).toEqual(feeds);
  });
});

describe('the element reload cadence', () => {
  it('re-reads our own cache often enough to matter and never touches CelesTrak', () => {
    // Half an hour: short enough that a tab left open overnight is propagating what the
    // server holds, and it reads the server's cache, so CelesTrak's own once-per-group per
    // two hours is untouched by it.
    expect(SATELLITE_ELEMENT_RELOAD_MS).toBe(30 * 60 * 1000);
    expect(SATELLITE_ELEMENT_RELOAD_MS).toBeLessThan(2 * 60 * 60 * 1000);
  });
});

/**
 * The socket path for the satellite layer.
 *
 * A satellite record is an orbital element set with no position on it, so a satellite frame
 * off the socket is a change to what the worker propagates from rather than to anything on
 * screen. Sending one to a position layer was what threw.
 */
describe('SatelliteFeed.apply', () => {
  it('replaces the element cache from a snapshot', () => {
    const { feed, fake } = build();
    const frame = changes();
    frame.snapshots.set('satellites', [makeSatellite({ norad_cat_id: 25_544 })]);

    feed.apply(frame);

    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ type: 'elements' });
    const sent = fake.sent[0] as { type: 'elements'; satellites: Satellite[] };
    expect(sent.satellites.map((record) => record.norad_cat_id)).toEqual([25_544]);
  });

  it('merges an upsert into what it already holds rather than replacing it', () => {
    const { feed, fake } = build();
    feed.load([makeSatellite({ norad_cat_id: 1 })]);
    const frame = changes();
    frame.upserts.set('2', { entity: makeSatellite({ norad_cat_id: 2 }), layer: 'satellites' });

    feed.apply(frame);

    // The worker takes a replacement, so the whole set goes over. A delta applied as a
    // replacement would leave the layer drawing one satellite out of eleven thousand.
    const sent = fake.sent.at(-1) as { satellites: Satellite[] };
    expect(sent.satellites.map((record) => record.norad_cat_id)).toEqual([1, 2]);
  });

  it('drops a decayed object the server has removed, keyed as the string the wire sends', () => {
    const { feed, fake } = build();
    feed.load([makeSatellite({ norad_cat_id: 1 }), makeSatellite({ norad_cat_id: 2 })]);
    const frame = changes();
    frame.removals.set('1', 'satellites');

    feed.apply(frame);

    const sent = fake.sent.at(-1) as { satellites: Satellite[] };
    expect(sent.satellites.map((record) => record.norad_cat_id)).toEqual([2]);
  });

  it('says nothing to the worker when the frame changed nothing', () => {
    const { feed, fake } = build();
    feed.load([makeSatellite({ norad_cat_id: 1 })]);
    const before = fake.sent.length;
    const frame = changes();
    frame.removals.set('99999', 'satellites');

    feed.apply(frame);

    // Every element message re-initialises SGP4 per object. A frame that removed something
    // we never held must not pay for that.
    expect(fake.sent).toHaveLength(before);
  });

  it('goes quiet once stopped, like every other path into the worker', () => {
    const { feed, fake } = build();
    feed.stop();
    const before = fake.sent.length;
    const frame = changes();
    frame.snapshots.set('satellites', [makeSatellite()]);

    feed.apply(frame);

    expect(fake.sent).toHaveLength(before);
  });
});

/**
 * The read accessor the satellite card opens on.
 *
 * The card needs the element set for the object that was picked, and this map is the only
 * place the socket's snapshots, upserts and removals are reconciled into the whole set. What
 * these tests are really asserting is that a caller reading through here cannot go stale,
 * because there is no second copy for it to read.
 */
describe('SatelliteFeed.elementsFor', () => {
  it('answers the element set it was loaded with', () => {
    const { feed } = build();
    feed.load([makeSatellite({ norad_cat_id: 25_544, object_name: 'ISS (ZARYA)' })]);

    expect(feed.elementsFor(25_544)?.object_name).toBe('ISS (ZARYA)');
  });

  it('answers null for a catalogue number it holds nothing for', () => {
    const { feed } = build();
    feed.load([makeSatellite({ norad_cat_id: 1 })]);

    // Null rather than undefined, so the caller has one absent value to test.
    expect(feed.elementsFor(99_999)).toBeNull();
  });

  it('answers null before anything has been loaded at all', () => {
    const { feed } = build();

    expect(feed.elementsFor(25_544)).toBeNull();
  });

  it('follows a socket upsert, so an open card is never a stale copy', () => {
    const { feed } = build();
    feed.load([makeSatellite({ norad_cat_id: 25_544, group: 'stations' })]);
    const frame = changes();
    frame.upserts.set('25544', {
      entity: makeSatellite({ norad_cat_id: 25_544, group: 'active' }),
      layer: 'satellites',
    });

    feed.apply(frame);

    expect(feed.elementsFor(25_544)?.group).toBe('active');
  });

  it('follows a socket removal, so a decayed object stops answering', () => {
    const { feed } = build();
    feed.load([makeSatellite({ norad_cat_id: 1 }), makeSatellite({ norad_cat_id: 2 })]);
    const frame = changes();
    frame.removals.set('1', 'satellites');

    feed.apply(frame);

    expect(feed.elementsFor(1)).toBeNull();
    expect(feed.elementsFor(2)).not.toBeNull();
  });

  it('follows a snapshot, which replaces rather than merges', () => {
    const { feed } = build();
    feed.load([makeSatellite({ norad_cat_id: 1 })]);
    const frame = changes();
    frame.snapshots.set('satellites', [makeSatellite({ norad_cat_id: 2 })]);

    feed.apply(frame);

    expect(feed.elementsFor(1)).toBeNull();
    expect(feed.elementsFor(2)).not.toBeNull();
  });

  it('follows a reload, which is what the half-hourly refetch is', () => {
    const { feed } = build();
    feed.load([makeSatellite({ norad_cat_id: 1 })]);
    feed.load([makeSatellite({ norad_cat_id: 2 })]);

    expect(feed.elementsFor(1)).toBeNull();
    expect(feed.elementsFor(2)).not.toBeNull();
  });

  it('hands back one record and never the container it came from', () => {
    // The element cache is mutable and the card layer has no business writing to it, so what
    // crosses the boundary is a record. Asserted on the shape rather than described: a
    // `Satellite` has a catalogue number on it and no `set`, `delete` or `clear`.
    const { feed } = build();
    feed.load([makeSatellite({ norad_cat_id: 25_544 })]);
    const held = feed.elementsFor(25_544);

    expect(held?.norad_cat_id).toBe(25_544);
    expect(held).not.toBeInstanceOf(Map);
  });
});

describe('satelliteNotices', () => {
  it('hands the rail the notice keyed by layer, so the row can show it', () => {
    const { feed, fake } = build();
    feed.load([makeSatellite()]);
    fake.reply({ type: 'elements', accepted: 40, rejected: 2 });

    // This is the fix for a notice that was computed every tick and thrown away: the rail
    // now has the one thing only the browser knows about the satellite layer.
    expect(satelliteNotices(feed.state).get('satellites')).toBe('2 element sets would not load.');
  });

  it('is empty when the layer is drawing everything it holds', () => {
    const { feed, fake } = build();
    feed.load([makeSatellite()]);
    fake.reply({ type: 'elements', accepted: 1, rejected: 0 });

    expect(satelliteNotices(feed.state).size).toBe(0);
  });
});
