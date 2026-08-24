/**
 * Main-thread side of the propagation worker.
 *
 * Three jobs, none of them maths: keep exactly one position request in flight, ask for an
 * orbit trail only for the current selection, and say plainly what the layer is not drawing
 * and why.
 *
 * The port is an interface rather than a `Worker` so the whole of this is tested in the node
 * runner. A real `Worker` satisfies it as it stands, with no adapter.
 */

import type { EngineReply, EngineRequest, Positions } from './orbit';
import type { Changes } from '../../net/ws';
import type { FeedHealth, Satellite } from '../../types/entities';

/**
 * How often the element cache is re-read from our own backend.
 *
 * Nothing upstream is touched: this reads the server's cache, and CelesTrak itself is
 * fetched at most once per group per two hours by the backend poller. Half an hour is short
 * enough that a browser left open overnight is propagating the elements the server holds
 * rather than the ones it held when the tab opened.
 */
export const SATELLITE_ELEMENT_RELOAD_MS = 30 * 60 * 1000;

/** Just enough of a `Worker` to drive it, so a test can supply a fake. */
export interface EnginePort {
  postMessage(message: EngineRequest): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<EngineReply>) => void): void;
  terminate(): void;
}

export interface SatelliteFeedState {
  /** Element sets the worker holds. */
  elements: number;
  /** Element sets the backend served that would not initialise. */
  rejected: number;
  /** Satellites currently drawn. */
  rendered: number;
  /** Refused by SGP4 on the last tick: decayed, or elements it cannot propagate. */
  dropped: number;
  /** Held back on the last tick because their elements are older than 3.5 days. */
  stale: number;
  /** What the layer is not showing and why, or null when it is showing everything. */
  reason: string | null;
}

const EMPTY_STATE: SatelliteFeedState = {
  elements: 0,
  rejected: 0,
  rendered: 0,
  dropped: 0,
  stale: 0,
  reason: null,
};

/** `1 object`, `3 objects`. A count next to a singular noun reads like a bug in the copy. */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Why the layer is drawing less than the whole catalogue.
 *
 * Written here rather than in the rail because these are facts only the browser knows: the
 * server can say CelesTrak is unreachable, but only the propagator knows how many element
 * sets it refused this tick. The two notices sit alongside each other and neither replaces
 * the other.
 *
 * The stale wording matters. While CelesTrak is down the backend keeps serving the elements
 * it last fetched, and an element set propagated days past its epoch returns a clean error
 * code and a plausible altitude, so silence here would be the layer presenting stale
 * elements as live.
 */
export function feedReason(state: Omit<SatelliteFeedState, 'reason'>): string | null {
  if (state.elements === 0) {
    return 'No orbital elements cached, so no satellite can be drawn.';
  }
  const notices: string[] = [];
  if (state.rendered === 0 && state.stale > 0) {
    notices.push(
      'Every element set is more than 3.5 days old, so nothing is drawn: CelesTrak has not answered since.',
    );
  } else if (state.stale > 0) {
    notices.push(`${plural(state.stale, 'element set')} more than 3.5 days old, not drawn.`);
  }
  if (state.dropped > 0) {
    notices.push(`${plural(state.dropped, 'object')} dropped: would not propagate.`);
  }
  if (state.rejected > 0) {
    notices.push(`${plural(state.rejected, 'element set')} would not load.`);
  }
  return notices.length === 0 ? null : notices.join(' · ');
}

export interface SatelliteFeedOptions {
  port: EnginePort;
  /** One tick of positions, straight off the worker in the form the layer draws. */
  onPositions: (ids: Int32Array, lonLatAlt: Float64Array) => void;
  /** One orbit trail, or null to clear it. */
  onOrbit: (noradCatId: number | null, lonLatAlt: Float64Array | null) => void;
  onState: (state: SatelliteFeedState) => void;
}

export class SatelliteFeed {
  private readonly options: SatelliteFeedOptions;
  /**
   * The element sets the worker was last given, keyed on catalogue number.
   *
   * Held here as well as in the worker because the socket delivers changes and the worker
   * takes replacements, so something on this side has to know the whole set.
   */
  private readonly held = new Map<number, Satellite>();
  private current: SatelliteFeedState = EMPTY_STATE;
  /**
   * True between asking for positions and getting them.
   *
   * The whole of the backpressure. A frame that arrives while the worker is still
   * propagating the last one is skipped rather than queued: a queue would let the worker
   * fall behind the clock and then draw a position from several frames ago, which looks like
   * stutter and is actually a lie about where the object is.
   */
  private awaitingPositions = false;
  private selected: number | null = null;
  private stopped = false;

  constructor(options: SatelliteFeedOptions) {
    this.options = options;
    options.port.addEventListener('message', (event) => {
      this.receive(event.data);
    });
  }

  get state(): SatelliteFeedState {
    return this.current;
  }

  /**
   * The element set held for one catalogue number, or null when nothing is held for it.
   *
   * A read accessor over `held` rather than a getter that hands the map out. The map is
   * mutable and the card layer has no business writing to the element cache, so what crosses
   * the boundary is one record and never the container.
   *
   * It lives here rather than in `main.ts` because this map is the only place the socket's
   * snapshots, upserts and removals are reconciled into the whole set. A second copy kept
   * beside it would be correct until the first frame of socket traffic and stale from then
   * on, and stale here means a card naming an object that CelesTrak has stopped serving.
   *
   * Null rather than undefined so the caller has one absent value to test, matching how
   * every other lookup in this app answers.
   */
  elementsFor(noradCatId: number): Satellite | null {
    return this.held.get(noradCatId) ?? null;
  }

  /** Hand the worker a fresh element cache. Replaces whatever it held. */
  load(records: readonly Satellite[]): void {
    this.held.clear();
    for (const record of records) {
      this.held.set(record.norad_cat_id, record);
    }
    this.send();
  }

  /**
   * Apply one frame of socket traffic for the satellite layer.
   *
   * The layer draws positions the worker propagates from element sets, so a satellite
   * frame is a change to the element cache rather than to anything on screen. Folded into
   * the cache here and posted as a whole, because the worker's element message is a
   * replacement: it re-initialises SGP4 per object, which is the work that must not be
   * repeated per record.
   *
   * Cheap by cadence rather than by cleverness. CelesTrak is fetched at most once per group
   * per two hours, so this runs about that often.
   */
  apply(changes: Changes<Satellite>): void {
    let changed = false;
    for (const entities of changes.snapshots.values()) {
      this.held.clear();
      for (const record of entities) {
        this.held.set(record.norad_cat_id, record);
      }
      changed = true;
    }
    for (const entry of changes.upserts.values()) {
      this.held.set(entry.entity.norad_cat_id, entry.entity);
      changed = true;
    }
    for (const id of changes.removals.keys()) {
      // Keyed as a string on the wire, as every entity id is, and numeric here because a
      // catalogue number is a number in the contract.
      changed = this.held.delete(Number(id)) || changed;
    }
    if (changed) {
      this.send();
    }
  }

  private send(): void {
    if (this.stopped) {
      return;
    }
    // Copied into a plain array because the request crosses a structured clone and a Map's
    // values iterator does not.
    // eslint-disable-next-line unicorn/prefer-iterator-to-array -- `Iterator#toArray` is not in the ES2023 lib this project targets, and the alternatives are the spread this line already is.
    const satellites = [...this.held.values()];
    this.options.port.postMessage({ type: 'elements', satellites });
  }

  /** Ask for positions at `nowMs`, unless the worker still owes us the last set. */
  tick(nowMs: number): void {
    if (this.stopped || this.awaitingPositions || this.current.elements === 0) {
      return;
    }
    this.awaitingPositions = true;
    this.options.port.postMessage({ type: 'positions', atMs: nowMs });
  }

  /**
   * Draw an orbit trail for one satellite, or none.
   *
   * One trail at a time, for the selection only. Trails for everything is the thing that
   * turns a globe into a ball of wool and costs more than the points do.
   */
  setSelected(noradCatId: number | null, nowMs: number = Date.now()): void {
    if (this.selected === noradCatId) {
      return;
    }
    this.selected = noradCatId;
    if (noradCatId === null) {
      this.options.onOrbit(null, null);
      return;
    }
    this.options.port.postMessage({ type: 'orbit', noradCatId, atMs: nowMs });
  }

  stop(): void {
    this.stopped = true;
    this.options.port.terminate();
  }

  private receive(reply: EngineReply): void {
    switch (reply.type) {
      case 'elements': {
        this.publish({ elements: reply.accepted, rejected: reply.rejected });
        break;
      }
      case 'positions': {
        this.awaitingPositions = false;
        this.options.onPositions(reply.ids, reply.lonLatAlt);
        this.publish(countsFrom(reply));
        break;
      }
      case 'orbit': {
        // A reply for a satellite that is no longer selected is dropped: the user has moved
        // on, and drawing it would put a trail under a point nobody clicked.
        if (reply.noradCatId === this.selected) {
          this.options.onOrbit(reply.noradCatId, reply.lonLatAlt);
        }
        break;
      }
    }
  }

  private publish(changed: Partial<Omit<SatelliteFeedState, 'reason'>>): void {
    const merged = { ...this.current, ...changed };
    const next: SatelliteFeedState = { ...merged, reason: feedReason(merged) };
    this.current = next;
    this.options.onState(next);
  }
}

function countsFrom(positions: Positions): Partial<SatelliteFeedState> {
  return {
    rendered: positions.ids.length,
    dropped: positions.dropped,
    stale: positions.stale,
  };
}

/**
 * The satellite layer's browser-side notice, keyed by layer for the rail.
 *
 * Built here rather than in the rail because these are facts only the browser knows, and
 * handed over as a map so the rail folds it into the satellites row alongside whatever the
 * server said. Empty when the layer is drawing everything it holds.
 */
export function satelliteNotices(state: SatelliteFeedState): ReadonlyMap<string, string> {
  return state.reason === null ? new Map() : new Map([['satellites', state.reason]]);
}

/**
 * Replace the satellites feed's server-side count with what the browser is drawing.
 *
 * The rail reads its counts off feed health, which for satellites is the number of element
 * sets the server holds. That is not the number on screen: a decayed object and an element
 * set older than 3.5 days are both held by the server and neither is drawn. The count a user
 * reads next to a layer has to be the count of that layer, so the drop is reflected here.
 */
export function withDrawnSatelliteCount(feeds: readonly FeedHealth[], drawn: number): FeedHealth[] {
  return feeds.map((feed) =>
    feed.layer === 'satellites' ? { ...feed, entity_count: drawn } : feed,
  );
}
