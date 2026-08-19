/**
 * The live WebSocket client.
 *
 * Two jobs, kept separable so both are testable without a socket: coalescing incoming
 * messages into one application per animation frame, and reconnecting without hammering
 * the server.
 *
 * The envelope types are written here rather than generated. `openapi.json` describes the
 * REST surface only, so the WebSocket contract is expressed in terms of the generated
 * entity schemas: `Aircraft` and `FeedHealth` still come from the backend contract, and a
 * change to either is a compile error here.
 */

import type { Aircraft, FeedHealth, LayerName } from '../types/entities';

export interface SnapshotMessage {
  type: 'snapshot';
  layer: LayerName;
  entities: Aircraft[];
  server_time: string;
}

export interface UpsertMessage {
  type: 'upsert';
  layer: LayerName;
  entities: Aircraft[];
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

/** One frame's worth of changes, already reduced to the latest value per aircraft. */
export interface Batch {
  /** A full layer state, which replaces whatever that layer held. */
  snapshots: Map<LayerName, Aircraft[]>;
  upserts: Map<string, { aircraft: Aircraft; layer: LayerName }>;
  removals: Map<string, LayerName>;
  feeds: FeedHealth[] | null;
}

function emptyBatch(): Batch {
  return { snapshots: new Map(), upserts: new Map(), removals: new Map(), feeds: null };
}

function isEmpty(batch: Batch): boolean {
  return (
    batch.snapshots.size === 0 &&
    batch.upserts.size === 0 &&
    batch.removals.size === 0 &&
    batch.feeds === null
  );
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
 * the jank comes from. Only the last value for an aircraft in a frame is ever drawn.
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
    switch (message.type) {
      case 'snapshot': {
        this.batch.snapshots.set(message.layer, message.entities);
        // A snapshot supersedes anything still pending for that layer.
        for (const [id, pending] of this.batch.upserts) {
          if (pending.layer === message.layer) {
            this.batch.upserts.delete(id);
          }
        }
        for (const [id, layer] of this.batch.removals) {
          if (layer === message.layer) {
            this.batch.removals.delete(id);
          }
        }
        break;
      }
      case 'upsert': {
        for (const entity of message.entities) {
          this.batch.upserts.set(entity.icao24, { aircraft: entity, layer: message.layer });
          this.batch.removals.delete(entity.icao24);
        }
        break;
      }
      case 'remove': {
        for (const id of message.ids) {
          this.batch.removals.set(id, message.layer);
          if (this.batch.upserts.get(id)?.layer === message.layer) {
            this.batch.upserts.delete(id);
          }
        }
        break;
      }
      case 'feed_status': {
        this.batch.feeds = message.feeds;
        break;
      }
    }
    this.request();
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
