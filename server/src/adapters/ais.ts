import WebSocket from 'ws';
import type { RuntimeConfig } from '../config.js';
import type { Ais, AisSnapshot } from './contracts.js';

const POSITION_RETENTION_MS = 30 * 60_000;
const TRACK_SAMPLES = 64;
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000] as const;
const AUTH_RETRY_MS = 3_600_000;
const RECOGNIZED_TYPES = new Set([
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
  'StaticDataReport',
]);

interface AisSocket {
  on(event: 'open' | 'close' | 'error' | 'message' | 'unexpected-response', listener: (...args: any[]) => void): unknown;
  send(data: string): unknown;
  terminate(): unknown;
}

interface AisServiceOptions {
  readonly createSocket?: ((url: string) => AisSocket) | undefined;
  readonly now?: (() => number) | undefined;
  readonly automaticWatchdog?: boolean | undefined;
}

interface VesselRow {
  lat: number;
  lon: number;
  name: string;
  mmsi: string;
  imo: string | null;
  type: string | null;
  destination: string | null;
  speed: number | null;
  course: number | null;
  heading: number | null;
  last_position_UTC: string;
  last_position_epoch: number;
  _updatedAt: number;
}

interface TrackSample {
  readonly lat: number;
  readonly lon: number;
  readonly t: number;
}

interface StaticData {
  readonly name?: string | undefined;
  readonly type?: string | undefined;
  readonly destination?: string | undefined;
  readonly imo?: string | undefined;
}

function text(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function number(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function frameText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return String(data ?? '');
}

export class AisStreamService implements Ais {
  private readonly createSocket: (url: string) => AisSocket;
  private readonly now: () => number;
  private readonly automaticWatchdog: boolean;
  private readonly vessels = new Map<string, VesselRow>();
  private readonly staticData = new Map<string, StaticData>();
  private readonly tracks = new Map<string, TrackSample[]>();
  private socket: AisSocket | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private generation = 0;
  private stopped = false;
  private state = 'idle';
  private error: string | null = null;
  private lastMessageAt: number | null = null;
  private connectionStartedAt: number | null = null;
  private reconnectAttempt = 0;
  private nextAttemptAt: number | null = null;

  constructor(
    private readonly config: RuntimeConfig,
    options: AisServiceOptions = {},
  ) {
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.now = options.now ?? Date.now;
    this.automaticWatchdog = options.automaticWatchdog ?? true;
  }

  start(): void {
    if (this.stopped) return;
    if (!this.config.aisStreamApiKey) {
      this.state = 'missing-key';
      this.error = 'AISSTREAM_API_KEY is not set';
      return;
    }
    if (!this.socket && !this.reconnectTimer) this.connect();
    if (this.automaticWatchdog && !this.watchdogTimer) {
      this.watchdogTimer = setInterval(() => this.tick(), 15_000);
      this.watchdogTimer.unref();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.watchdogTimer = null;
    this.reconnectTimer = null;
    this.nextAttemptAt = null;
    this.terminateOwnedSocket();
    this.state = 'stopped';
  }

  tick(): void {
    if (this.stopped || !this.config.aisStreamApiKey) return;
    if (!this.socket && !this.reconnectTimer) {
      this.scheduleReconnect();
      return;
    }
    const silenceStart = this.lastMessageAt ?? this.connectionStartedAt;
    if (silenceStart === null) return;
    const silentFor = this.now() - silenceStart;
    if (silentFor >= this.config.aisStreamStaleMs) {
      this.state = 'stale';
      this.error = `AISStream has been silent for ${silentFor}ms`;
    }
    if (silentFor >= this.config.aisStreamRecycleMs && this.socket) {
      this.terminateOwnedSocket();
      this.scheduleReconnect();
    }
  }

  snapshot(maxRows: number): AisSnapshot {
    this.tick();
    this.prune();
    const rows = [...this.vessels.values()]
      .sort((a, b) => b._updatedAt - a._updatedAt)
      .slice(0, Math.max(1, Math.min(maxRows, this.config.aisStreamCacheMax)))
      .map(({ _updatedAt: _ignored, ...row }) => row);
    return {
      rows,
      source: 'AISStream',
      provenance: 'Best-effort AISStream positions accumulated by this server; not authoritative navigation data.',
      status: this.state,
      error: this.error,
      refreshing: this.state !== 'live',
      newestPositionAt: rows[0]?.last_position_UTC ?? null,
      lastMessageAt: this.lastMessageAt,
      silentForMs: (this.lastMessageAt ?? this.connectionStartedAt) === null
        ? null
        : Math.max(0, this.now() - (this.lastMessageAt ?? this.connectionStartedAt)!),
      reconnectAttempt: this.reconnectAttempt,
      nextAttemptAt: this.nextAttemptAt,
      staleAfterMs: this.config.aisStreamStaleMs,
      watchdog: this.watchdogTimer || !this.automaticWatchdog ? 'armed' : 'idle',
    };
  }

  track(mmsi: string): readonly TrackSample[] {
    return [...(this.tracks.get(mmsi) ?? [])];
  }

  private connect(): void {
    if (this.stopped || !this.config.aisStreamApiKey) return;
    const generation = ++this.generation;
    this.state = 'connecting';
    this.connectionStartedAt = this.now();
    this.error = null;
    this.nextAttemptAt = null;
    let socket: AisSocket;
    try {
      socket = this.createSocket(this.config.aisStreamUrl);
    } catch {
      this.state = 'down';
      this.error = 'AISStream websocket connection failed';
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    const owns = () => this.socket === socket && this.generation === generation;
    socket.on('open', () => {
      if (!owns()) return;
      socket.send(JSON.stringify({
        APIKey: this.config.aisStreamApiKey,
        BoundingBoxes: this.config.aisStreamBoundingBoxes,
        FilterMessageTypes: this.config.aisStreamMessageTypes,
      }));
    });
    socket.on('message', (data: unknown) => {
      if (!owns()) return;
      this.onMessage(frameText(data));
    });
    socket.on('unexpected-response', (_request: unknown, response: { statusCode?: number }) => {
      if (!owns()) return;
      const status = Number(response?.statusCode);
      this.fail(status === 401 || status === 403 ? 'auth' : 'transport', status);
    });
    socket.on('error', () => {
      if (owns()) this.error = 'AISStream websocket error';
    });
    socket.on('close', () => {
      if (!owns()) return;
      this.socket = null;
      if (this.state !== 'auth-failed') {
        this.state = 'down';
        this.error ??= 'AISStream websocket closed';
        this.scheduleReconnect();
      }
    });
  }

  private onMessage(raw: string): void {
    if (Buffer.byteLength(raw) > 1_000_000) {
      this.fail('transport');
      return;
    }
    let envelope: Record<string, any>;
    try {
      envelope = JSON.parse(raw) as Record<string, any>;
    } catch {
      return;
    }
    if (envelope.error) {
      const isAuth = /auth|api.?key|unauthor|forbidden/i.test(String(envelope.error));
      this.fail(isAuth ? 'auth' : 'transport');
      return;
    }
    const messageType = text(envelope.MessageType);
    const body = messageType ? envelope.Message?.[messageType] : null;
    const metadata = envelope.MetaData ?? envelope.Metadata ?? {};
    const mmsi = text(metadata.MMSI ?? body?.UserID ?? body?.UserId ?? body?.Mmsi);
    if (!messageType || !RECOGNIZED_TYPES.has(messageType) || !body || !mmsi) return;

    this.lastMessageAt = this.now();
    this.reconnectAttempt = 0;
    this.state = 'live';
    this.error = null;
    if (messageType === 'ShipStaticData' || messageType === 'StaticDataReport') {
      const values = {
        name: text(metadata.ShipName ?? body.Name ?? body.ShipName) ?? undefined,
        type: text(body.Type ?? body.ShipType) ?? undefined,
        destination: text(body.Destination) ?? undefined,
        imo: text(body.ImoNumber ?? body.IMO) ?? undefined,
      };
      this.staticData.set(mmsi, values);
    }
    const lat = number(metadata.latitude ?? metadata.Latitude ?? body.Latitude);
    const lon = number(metadata.longitude ?? metadata.Longitude ?? body.Longitude);
    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return;
    const known = this.staticData.get(mmsi) ?? {};
    const timestamp = text(metadata.time_utc ?? metadata.TimeUtc) ?? new Date(this.now()).toISOString();
    const epoch = Math.floor((Date.parse(timestamp) || this.now()) / 1000);
    this.vessels.set(mmsi, {
      lat,
      lon,
      name: text(metadata.ShipName ?? body.Name ?? body.ShipName ?? known.name) ?? `MMSI ${mmsi}`,
      mmsi,
      imo: text(body.ImoNumber ?? body.IMO ?? known.imo),
      type: text(body.Type ?? body.ShipType ?? known.type),
      destination: text(body.Destination ?? known.destination),
      speed: number(body.Sog ?? body.SOG),
      course: number(body.Cog ?? body.COG),
      heading: number(body.TrueHeading ?? body.Heading),
      last_position_UTC: timestamp,
      last_position_epoch: epoch,
      _updatedAt: this.now(),
    });
    const track = this.tracks.get(mmsi) ?? [];
    const previous = track.at(-1);
    if (!previous || epoch - previous.t >= 30) {
      track.push({ lat, lon, t: epoch });
      if (track.length > TRACK_SAMPLES) track.shift();
      this.tracks.set(mmsi, track);
    }
    this.prune();
  }

  private fail(kind: 'auth' | 'transport', status?: number): void {
    this.state = kind === 'auth' ? 'auth-failed' : 'down';
    this.error = kind === 'auth'
      ? `AISStream rejected the configured credential${status ? ` (HTTP ${status})` : ''}`
      : 'AISStream transport failed';
    this.terminateOwnedSocket();
    this.scheduleReconnect(kind === 'auth' ? AUTH_RETRY_MS : undefined);
  }

  private terminateOwnedSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.terminate();
      } catch {
        // The socket is already unusable.
      }
    }
  }

  private scheduleReconnect(delay?: number): void {
    if (this.stopped || this.reconnectTimer || !this.config.aisStreamApiKey) return;
    const wait = delay ?? BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)]!;
    this.reconnectAttempt += 1;
    this.nextAttemptAt = this.now() + wait;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.nextAttemptAt = null;
      this.connect();
    }, wait);
    this.reconnectTimer.unref();
  }

  private prune(): void {
    const cutoff = this.now() - POSITION_RETENTION_MS;
    for (const [mmsi, row] of this.vessels) {
      if (row._updatedAt < cutoff) {
        this.vessels.delete(mmsi);
        this.tracks.delete(mmsi);
      }
    }
    if (this.vessels.size <= this.config.aisStreamCacheMax) return;
    const oldest = [...this.vessels.entries()].sort((a, b) => a[1]._updatedAt - b[1]._updatedAt);
    for (const [mmsi] of oldest.slice(0, this.vessels.size - this.config.aisStreamCacheMax)) {
      this.vessels.delete(mmsi);
      this.tracks.delete(mmsi);
    }
  }
}
