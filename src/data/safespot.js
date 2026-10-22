/**
 * @module data/safespot
 * @description Client-side data adapter and telemetry WebSocket bridge for SafeSpotSG
 * Evaluation Lab inside God's Eye View.
 *
 * Implements REST queries against local proxy endpoints and bidirectional
 * WebSocket streaming for Garmin fēnix 6 Pro Solar telemetry.
 */

export const DEFAULT_CORRIDOR_ID = 'novena-to-mbs';

export const DEFAULT_ROUTING_MODEL = 'calibrated';

export const SUPPORTED_ROUTING_MODELS = Object.freeze([
  'baseline',
  'calibrated',
  'speedband',
]);

export const ROUTING_MODELS = Object.freeze({
  BASELINE: 'baseline',
  CALIBRATED: 'calibrated',
  SPEEDBAND: 'speedband',
});

export const ROUTING_MODEL_METADATA = Object.freeze({
  baseline: {
    id: 'baseline',
    name: 'Baseline Heuristic (Phase 2)',
    shortLabel: 'Baseline',
    description: 'Phase 2 heuristics: 0.62 morning expressway factor, flat 9s signal wait, 68 km/h cap',
    badgeColor: '#94a3b8',
  },
  calibrated: {
    id: 'calibrated',
    name: 'Calibrated Parametric Optimizer',
    shortLabel: 'Calibrated',
    description: 'Jointly tuned class speeds, 1.25x night acceleration, decoupled signals/turns',
    badgeColor: '#10b981',
  },
  speedband: {
    id: 'speedband',
    name: 'LTA SpeedBand Hybrid',
    shortLabel: 'SpeedBand',
    description: '96-slot empirical link speed profiles with Empirical Bayes shrinkage and fallback',
    badgeColor: '#06b6d4',
  },
});

export const BENCHMARK_CORRIDOR_IDS = Object.freeze([
  'toa-payoh-to-raffles-place',
  'toa-payoh-to-changi-t3',
  'toa-payoh-to-jurong-east',
  'jurong-west-to-woodlands',
  'jurong-west-to-tampines',
  'jurong-west-to-sengkang',
  'pasir-ris-to-bedok',
  'ang-mo-kio-to-punggol',
  'clementi-to-harbourfront',
  'novena-to-mbs',
]);

/**
 * Determine default WebSocket URL from runtime location.
 * Uses browser globals safely.
 */
export function getDefaultTelemetryWsUrl() {
  if (typeof window !== 'undefined' && window.location) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:4173';
    return `${proto}//${host}/api/safespot/telemetry-ws`;
  }
  return 'ws://127.0.0.1:4173/api/safespot/telemetry-ws';
}

/**
 * Fetch the 10 fixed Singapore corridor benchmark pairs.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ corridors: Array<object>, pairs: Array<object>, total: number }>}
 */
export async function getShadowPairs({ signal } = {}) {
  signal?.throwIfAborted?.();
  const response = await fetch('/api/safespot/shadow-pairs', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch shadow pairs: HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Fetch dual route comparison, cross-track diff, and >35m divergence spans for a corridor across models.
 * @param {string} corridorId
 * @param {object} [options]
 * @param {string} [options.model='calibrated'] 'baseline' | 'calibrated' | 'speedband'
 * @param {number} [options.thresholdMeters=35.0]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>}
 */
export async function getCorridorDiff(
  corridorId,
  { model = DEFAULT_ROUTING_MODEL, thresholdMeters = 35.0, signal } = {}
) {
  if (!corridorId) {
    throw new TypeError('corridorId is required');
  }
  signal?.throwIfAborted?.();
  const query = new URLSearchParams({
    corridorId,
    model: String(model || DEFAULT_ROUTING_MODEL),
    thresholdMeters: String(thresholdMeters),
  });
  const response = await fetch(`/api/safespot/corridor-diff?${query.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch corridor diff for ${corridorId} (model: ${model}): HTTP ${response.status}`
    );
  }
  return response.json();
}

/**
 * Fetch offline routing training summary, 95% bootstrap confidence intervals, and slice metrics.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>}
 */
export async function getTrainingSummary({ signal } = {}) {
  signal?.throwIfAborted?.();
  const response = await fetch('/api/safespot/training-summary', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch training summary: HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Fetch or advance the Full-Singapore Autonomous Test Fleet (Cars & Buses)
 * and road network coverage simulation.
 *
 * The server owns the simulation clock: each call advances every vehicle by the
 * wall time since the previous call multiplied by `speedMultiplier`, and an edge
 * counts as covered only once a vehicle has driven it.
 * @param {object} [options]
 * @param {string} [options.model='calibrated']
 * @param {number} [options.speedMultiplier] Simulation speed (1..250); omit to keep the server's.
 * @param {boolean} [options.reset=false]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>}
 */
export async function getFleetSimulation({
  model = DEFAULT_ROUTING_MODEL,
  speedMultiplier,
  reset = false,
  signal,
} = {}) {
  signal?.throwIfAborted?.();
  const query = new URLSearchParams({
    model: String(model || DEFAULT_ROUTING_MODEL),
    reset: String(Boolean(reset)),
  });
  if (Number.isFinite(speedMultiplier)) query.set('speed', String(speedMultiplier));
  const response = await fetch(`/api/safespot/fleet-sim?${query.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch fleet simulation: HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Determine hex color for edge speed residual error (km/h).
 * @param {number} residualSpeedKmh Absolute difference between model and reference speed
 * @returns {string} Hex color
 */
export function getResidualSpeedColor(residualSpeedKmh) {
  if (typeof residualSpeedKmh !== 'number' || Number.isNaN(residualSpeedKmh)) {
    return '#10b981'; // Default green
  }
  const abs = Math.abs(residualSpeedKmh);
  if (abs < 5.0) return '#10b981'; // Green (<5 km/h: accurate)
  if (abs <= 15.0) return '#f59e0b'; // Amber (5-15 km/h: moderate)
  return '#ef4444'; // Crimson (>15 km/h: high discrepancy)
}

/**
 * Run senior pickup simulation with multi-criteria candidate ranking and rain adaptation.
 * @param {object} params
 * @param {{ lat: number, lng: number }} params.seniorLocation
 * @param {{ lat: number, lng: number }} [params.driverLocation]
 * @param {boolean} [params.isRaining=false]
 * @param {number} [params.radiusMeters=400]
 * @param {number} [params.maxCandidates=14]
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>}
 */
export async function simulatePickup(
  {
    seniorLocation,
    driverLocation = { lat: 1.3390, lng: 103.8420 },
    isRaining = false,
    radiusMeters = 400,
    maxCandidates = 14,
  } = {},
  { signal } = {},
) {
  if (!seniorLocation || typeof seniorLocation.lat !== 'number' || typeof seniorLocation.lng !== 'number') {
    throw new TypeError('Valid seniorLocation { lat, lng } is required');
  }
  signal?.throwIfAborted?.();
  const response = await fetch('/api/safespot/pickup-sim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      seniorLocation,
      driverLocation,
      isRaining: Boolean(isRaining),
      radiusMeters,
      maxCandidates,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to simulate senior pickup: HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Fetch current wearable status, multi-sensor location fusion, and barometer elevation.
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>}
 */
export async function getWearableStatus({ signal } = {}) {
  signal?.throwIfAborted?.();
  const response = await fetch('/api/safespot/wearable-status', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    const statusCode = response.status;
    // i18n-ignore
    throw new Error(`Failed to fetch wearable status (HTTP ${statusCode})`);
  }
  return response.json();
}

/**
 * Robust WebSocket client for Garmin fēnix 6 Pro Solar real-time telemetry streaming
 * with automatic reconnection, heartbeat tracking, and message subscriptions.
 */
export class SafeSpotTelemetryClient {
  constructor(options = {}) {
    this.wsUrl = options.wsUrl || getDefaultTelemetryWsUrl();
    this.deviceId = options.deviceId || 'fenix-6-solar-demo';
    this.autoReconnect = options.autoReconnect !== false;
    this.reconnectDelayMs = options.reconnectDelayMs || 1500;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs || 8000;

    this._ws = null;
    this._reconnectTimer = null;
    this._currentDelayMs = this.reconnectDelayMs;
    this._destroyed = false;
    this._explicitClose = false;
    this._listeners = new Map();

    this._lastTick = null;
    this._lastAlert = null;
    this._connected = false;
  }

  on(event, handler) {
    if (typeof handler !== 'function') return this;
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);
    return this;
  }

  off(event, handler) {
    const handlers = this._listeners.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this._listeners.delete(event);
      }
    }
    return this;
  }

  emit(event, data) {
    const handlers = this._listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        console.warn(`[SafeSpotClient] Listener error on event "${event}":`, err);
      }
    }
  }

  get isConnected() {
    return this._connected && this._ws?.readyState === 1;
  }

  get lastTick() {
    return this._lastTick;
  }

  get lastAlert() {
    return this._lastAlert;
  }

  connect() {
    if (this._destroyed) return;
    if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1)) {
      return;
    }
    this._explicitClose = false;

    try {
      const WebSocketClass = typeof window !== 'undefined' ? window.WebSocket : null;
      if (!WebSocketClass) {
        console.warn('[SafeSpotClient] WebSocket unavailable in current environment');
        return;
      }

      this._ws = new WebSocketClass(this.wsUrl);

      this._ws.onopen = () => {
        if (this._destroyed) {
          this._ws?.close();
          return;
        }
        this._connected = true;
        this._currentDelayMs = this.reconnectDelayMs;
        this.emit('connected', { url: this.wsUrl, deviceId: this.deviceId });
        this.subscribe(this.deviceId);
      };

      this._ws.onmessage = (event) => {
        if (this._destroyed) return;
        try {
          const raw = typeof event.data === 'string' ? event.data : event.data?.toString?.();
          if (!raw) return;
          const msg = JSON.parse(raw);

          if (msg.type === 'telemetry:tick') {
            this._lastTick = msg;
            this.emit('tick', msg);
            this.emit('telemetry', msg);
          } else if (msg.type === 'alert:broadcast') {
            this._lastAlert = msg;
            this.emit('alert', msg);
          } else if (msg.type === 'subscribed') {
            this.emit('subscribed', msg);
          }
          this.emit('message', msg);
        } catch {
          // Ignore parse errors on malformed frames
        }
      };

      this._ws.onerror = (err) => {
        this.emit('error', err);
      };

      this._ws.onclose = () => {
        this._connected = false;
        this._ws = null;
        this.emit('disconnected', { explicit: this._explicitClose });
        if (!this._explicitClose && !this._destroyed && this.autoReconnect) {
          this._scheduleReconnect();
        }
      };
    } catch (err) {
      this.emit('error', err);
      if (!this._explicitClose && !this._destroyed && this.autoReconnect) {
        this._scheduleReconnect();
      }
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._currentDelayMs = Math.min(this._currentDelayMs * 1.5, this.maxReconnectDelayMs);
      this.connect();
    }, this._currentDelayMs);
  }

  subscribe(deviceId = this.deviceId) {
    this.deviceId = deviceId;
    this.send({ type: 'subscribe', deviceId });
  }

  startSimulation(scenario = 'hdb_lift_ascent') {
    this.send({ type: 'sim:start', scenario });
  }

  stopSimulation() {
    this.send({ type: 'sim:stop' });
  }

  injectEvent(event) {
    this.send({ type: 'event:inject', event });
  }

  send(data) {
    if (this._ws && this._ws.readyState === 1) {
      try {
        this._ws.send(typeof data === 'string' ? data : JSON.stringify(data));
      } catch (err) {
        console.warn('[SafeSpotClient] Failed to send WS frame:', err);
      }
    }
  }

  disconnect() {
    this._explicitClose = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      try {
        this._ws.close();
      } catch {
        // ignore
      }
      this._ws = null;
    }
    this._connected = false;
  }

  destroy() {
    this._destroyed = true;
    this.disconnect();
    this._listeners.clear();
  }
}

/**
 * Format distance in meters to clean human-readable text.
 * @param {number} meters
 * @returns {string}
 */
export function formatDistance(meters) {
  if (typeof meters !== 'number' || Number.isNaN(meters)) return '—';
  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)} km`;
  }
  return `${Math.round(meters)} m`;
}

/**
 * Format duration in seconds to clean human-readable text.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || Number.isNaN(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m} min`;
  return `${m}m ${s}s`;
}
