/**
 * The live WebSocket client.
 *
 * Two jobs, kept separable so both are testable without a socket: coalescing incoming
 * messages into one application per animation frame, and reconnecting without hammering
 * the server.
 *
 * The envelope types are written here rather than generated. `openapi.json` describes the
 * REST surface only, so the WebSocket contract is expressed in terms of the generated
 * entity schemas: `Aircraft`, `Vessel`, `Satellite` and `FeedHealth` all come from the
 * backend contract, and a change to any of them is a compile error here.
 *
 * **One socket carries every layer, so this is where they are separated.** The hub
 * subscribes a new connection to every layer it holds, and the backend entity union is
 * discriminated on `kind`. Each frame is routed by its layer name to the change set for
 * that kind, and an entity whose `kind` does not match the layer it arrived on is dropped.
 * A layer this build has no renderer for is counted and ignored: never thrown, because a
 * newer server adding a layer must not break an older tab, and never rendered, because a
 * vessel keyed as an aircraft is a garbage pin and a satellite carries no position at all.
 */

import { transitKey } from '../domain/transit';
import type {
  Aircraft,
  FeedHealth,
  LayerName,
  Satellite,
  TransitVehicle,
  Vessel,
} from '../types/entities';

/** The entity union, exactly as `contracts/messages.py` declares it. */
export type Entity = Aircraft | Vessel | Satellite | TransitVehicle;

export interface SnapshotMessage {
  type: 'snapshot';
  layer: LayerName;
  entities: Entity[];
  server_time: string;
}

export interface UpsertMessage {
  type: 'upsert';
  layer: LayerName;
  entities: Entity[];
  server_time: string;
}

export interface RemoveMessage {
  type: 'remove';
  layer: LayerName;
  ids: string[];
  server_time: string;
}

export interface FeedStatusMessage {
  type: 'feed_status';
  feeds: FeedHealth[];
  server_time: string;
}

export type ServerMessage = SnapshotMessage | UpsertMessage | RemoveMessage | FeedStatusMessage;

/** The three frame types that carry entities, as opposed to feed health. */
type EntityMessage = SnapshotMessage | UpsertMessage | RemoveMessage;

/** One frame's worth of changes for one kind of entity, reduced to the latest per key. */
export interface Changes<T> {
  /** A full layer state, which replaces whatever that layer held. */
  snapshots: Map<LayerName, T[]>;
  upserts: Map<string, { entity: T; layer: LayerName }>;
  removals: Map<string, LayerName>;
}

/**
 * One frame's worth of changes, split by the kind of thing that changed.
 *
 * Split rather than merged because the three kinds share no identity and no renderer: an
 * aircraft is keyed on its ICAO address, a vessel on its MMSI, and a satellite carries
 * orbital elements and no position whatsoever.
 */
export interface Batch {
  aircraft: Changes<Aircraft>;
  vessels: Changes<Vessel>;
  satellites: Changes<Satellite>;
  /**
   * Transit vehicles, keyed on feed and entity together rather than on one identifier.
   *
   * Every other layer here has a global identity to key on: an ICAO address, an MMSI, a NORAD
   * catalogue number. A GTFS-realtime entity id is unique only inside its own feed, so two
   * agencies can both run a vehicle "1", and keying on the id alone would have one operator's
   * bus overwrite another's. `transitKey` in `domain/transit.ts` is the composite and the wire id
   * is that same composite.
   */
  transit: Changes<TransitVehicle>;
  feeds: FeedHealth[] | null;
  /**
   * Frames and entities this build could not route, counted rather than dropped silently.
   *
   * Two causes, both meaning the browser was sent something it cannot draw: a frame for a
   * layer with no renderer here, and an entity whose `kind` is not the one its layer
   * carries. Counted so a mismatch between server and browser is visible instead of
   * looking like a quiet layer.
   */
  ignored: number;
}

export function emptyChanges<T>(): Changes<T> {
  return { snapshots: new Map(), upserts: new Map(), removals: new Map() };
}

export function emptyBatch(): Batch {
  return {
    aircraft: emptyChanges(),
    vessels: emptyChanges(),
    satellites: emptyChanges(),
    transit: emptyChanges(),
    feeds: null,
    ignored: 0,
  };
}

function changesEmpty<T>(changes: Changes<T>): boolean {
  return changes.snapshots.size === 0 && changes.upserts.size === 0 && changes.removals.size === 0;
}

function isEmpty(batch: Batch): boolean {
  return (
    changesEmpty(batch.aircraft) &&
    changesEmpty(batch.vessels) &&
    changesEmpty(batch.satellites) &&
    changesEmpty(batch.transit) &&
    batch.feeds === null &&
    batch.ignored === 0
  );
}

function isAircraft(entity: Entity): entity is Aircraft {
  return entity.kind === 'aircraft';
}

function isVessel(entity: Entity): entity is Vessel {
  return entity.kind === 'vessel';
}

function isSatellite(entity: Entity): entity is Satellite {
  return entity.kind === 'satellite';
}

function isTransit(entity: Entity): entity is TransitVehicle {
  return entity.kind === 'transit';
}

/** Schedules the flush. Swapped in tests so no test has to wait for a real frame. */
export type FlushScheduler = (flush: () => void) => void;

const nextFrame: FlushScheduler = (flush) => {
  requestAnimationFrame(flush);
};

/**
 * Collects messages and applies them once per animation frame.
 *
 * A busy viewport produces hundreds of position changes a second and the server already
 * batches on its own interval, but a snapshot of several thousand aircraft still arrives
 * as one message while deltas arrive as many. Applying each one as it lands means
 * touching Cesium several times between frames for no visible benefit, which is where
 * the jank comes from. Only the last value for an entity in a frame is ever drawn.
 */
export class MessageBatcher {
  private batch = emptyBatch();
  private scheduled = false;
  private readonly apply: (batch: Batch) => void;
  private readonly schedule: FlushScheduler;

  constructor(apply: (batch: Batch) => void, schedule: FlushScheduler = nextFrame) {
    this.apply = apply;
    this.schedule = schedule;
  }

  push(message: ServerMessage): void {
    if (message.type === 'feed_status') {
      this.batch.feeds = message.feeds;
    } else {
      this.route(message);
    }
    this.request();
  }

  /**
   * Send one frame to the change set for its layer.
   *
   * By layer, not by the kind of the entities in it, because an empty snapshot has no
   * entities to read a kind off and still has to clear its layer: after a reconnect an
   * empty vessel snapshot is the only thing that takes yesterday's ships off the globe.
   */
  private route(message: EntityMessage): void {
    switch (message.layer) {
      case 'aircraft':
      case 'military': {
        this.fold(this.batch.aircraft, message, isAircraft, (record) => record.icao24);
        break;
      }
      case 'vessels': {
        this.fold(this.batch.vessels, message, isVessel, (record) => record.mmsi);
        break;
      }
      case 'satellites': {
        this.fold(this.batch.satellites, message, isSatellite, (record) =>
          String(record.norad_cat_id),
        );
        break;
      }
      case 'transit': {
        // Feed and entity together, because a GTFS-realtime entity id is unique only inside its
        // own feed. One function in `domain/transit.ts`, shared with the layer, so a removal off
        // the wire and a slot on the globe cannot disagree about what they are naming.
        this.fold(this.batch.transit, message, isTransit, transitKey);
        break;
      }
      default: {
        // `events` and `cameras` are on the contract and have no renderer in this build.
        this.batch.ignored += 1;
      }
    }
  }

  private fold<T extends Entity>(
    changes: Changes<T>,
    message: EntityMessage,
    belongs: (entity: Entity) => entity is T,
    key: (record: T) => string,
  ): void {
    if (message.type === 'remove') {
      for (const id of message.ids) {
        changes.removals.set(id, message.layer);
        if (changes.upserts.get(id)?.layer === message.layer) {
          changes.upserts.delete(id);
        }
      }
      return;
    }
    const wanted = message.entities.filter((entity) => belongs(entity));
    this.batch.ignored += message.entities.length - wanted.length;
    if (message.type === 'snapshot') {
      changes.snapshots.set(message.layer, wanted);
      // A snapshot supersedes anything still pending for that layer.
      for (const [id, pending] of changes.upserts) {
        if (pending.layer === message.layer) {
          changes.upserts.delete(id);
        }
      }
      for (const [id, layer] of changes.removals) {
        if (layer === message.layer) {
          changes.removals.delete(id);
        }
      }
      return;
    }
    for (const entity of wanted) {
      changes.upserts.set(key(entity), { entity, layer: message.layer });
      changes.removals.delete(key(entity));
    }
  }

  private request(): void {
    if (this.scheduled) {
      return;
    }
    this.scheduled = true;
    this.schedule(() => {
      this.flush();
    });
  }

  /** Apply whatever has accumulated. A no-op when nothing has. */
  flush(): void {
    this.scheduled = false;
    if (isEmpty(this.batch)) {
      return;
    }
    const ready = this.batch;
    this.batch = emptyBatch();
    this.apply(ready);
  }
}

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_CAP_MS = 30_000;

/**
 * Delay before reconnect attempt `attempt`, counting from zero.
 *
 * Exponential so a server that is down is not hammered, capped so a client that has been
 * disconnected for an hour still comes back promptly, and jittered so every browser
 * watching does not reconnect in the same instant and knock the server over again.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt);
  const jitter = 0.5 + random() * 0.5;
  return Math.round(exponential * jitter);
}

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'closed';

export interface LiveFeedOptions {
  url: string;
  apply: (batch: Batch) => void;
  onState: (state: ConnectionState, retryInMs: number | null) => void;
}

/** The URL of the live socket on whichever origin served the page. */
export function liveFeedUrl(location: Location = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/ws`;
}

/**
 * A socket that stays connected.
 *
 * The connection state is reported rather than logged: a frozen globe with no explanation
 * is the worst outcome available, so the UI always says whether it is live.
 */
export class LiveFeed {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;
  private readonly batcher: MessageBatcher;
  private readonly options: LiveFeedOptions;

  constructor(options: LiveFeedOptions) {
    this.options = options;
    this.batcher = new MessageBatcher(options.apply);
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.options.onState('closed', null);
  }

  private open(): void {
    this.options.onState(this.attempt === 0 ? 'connecting' : 'reconnecting', null);
    const socket = new WebSocket(this.options.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.options.onState('live', null);
    });
    socket.addEventListener('message', (event: MessageEvent<unknown>) => {
      // A WebSocket can deliver a Blob or an ArrayBuffer as easily as text. The server
      // only ever sends JSON strings, so anything else is a frame we do not understand
      // and is dropped exactly like an unrecognised message type.
      if (typeof event.data !== 'string') {
        return;
      }
      const message = parseServerMessage(event.data);
      if (message !== null) {
        this.batcher.push(message);
      }
    });
    socket.addEventListener('close', () => {
      this.socket = null;
      this.retry();
    });
    socket.addEventListener('error', () => {
      // A socket error is always followed by a close, which is where the retry happens.
      socket.close();
    });
  }

  private retry(): void {
    if (this.stopped) {
      return;
    }
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.options.onState('reconnecting', delay);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.open();
    }, delay);
  }
}

/**
 * Typed to the union, so a message type renamed on the contract fails to compile here
 * rather than being silently dropped by a client that no longer recognises it.
 */
const KNOWN_MESSAGE_TYPES: ReadonlySet<string> = new Set<ServerMessage['type']>([
  'snapshot',
  'upsert',
  'remove',
  'feed_status',
]);

/**
 * Parse one frame off the socket.
 *
 * Anything unrecognised is dropped rather than thrown: a newer server adding a message
 * type must not break an older tab, and this is a trust boundary in the sense that
 * nothing downstream should ever see a shape it cannot handle.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const type: unknown = (parsed as { type?: unknown }).type;
  if (typeof type === 'string' && KNOWN_MESSAGE_TYPES.has(type)) {
    return parsed as ServerMessage;
  }
  return null;
}
