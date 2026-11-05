import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { msg } from '../../i18n/marker.js';
import {
  normalizeSondeFrame,
  trackPoint,
  SONDE_SERIAL_RE,
  SONDE_MAX_SERIALS,
} from './records.js';
const MAX_BYTES = 2 * 1024 * 1024;
const STATES = new Set([
  'live',
  'connecting',
  'closed',
  'degraded',
  'unavailable',
]);
const malformed = () => new Error(msg('Malformed weather balloon snapshot'));
function envelope(value, nowMs) {
  if (
    !value ||
    !Array.isArray(value.frames) ||
    value.frames.length > SONDE_MAX_SERIALS ||
    !STATES.has(value.upstream) ||
    typeof value.stale !== 'boolean' ||
    (value.partial !== undefined && typeof value.partial !== 'boolean') ||
    (value.lastFrameMs !== null && !Number.isFinite(value.lastFrameMs)) ||
    (value.fetchedAt !== null && !Number.isFinite(value.fetchedAt))
  )
    throw malformed();
  const frames = value.frames
    .map((f) => normalizeSondeFrame(f, nowMs))
    .filter(Boolean);
  if (value.frames.length && !frames.length) throw malformed();
  return {
    frames,
    upstream: value.upstream,
    lastFrameMs: value.lastFrameMs,
    stale: value.stale,
    partial: value.partial === true,
    fetchedAt: value.fetchedAt,
  };
}
function trackEnvelope(value, serial, nowMs) {
  if (
    !value ||
    value.serial !== serial ||
    !Array.isArray(value.track) ||
    value.track.length > 2000 ||
    typeof value.stale !== 'boolean' ||
    (value.fetchedAt !== null && !Number.isFinite(value.fetchedAt))
  )
    throw malformed();
  const track = value.track.map((p) =>
    normalizeSondeFrame({ ...p, serial }, nowMs, { history: true }),
  );
  if (track.some((p) => !p)) throw malformed();
  return {
    serial,
    track: track.map(trackPoint),
    stale: value.stale,
    fetchedAt: value.fetchedAt,
  };
}
/** Acquire bounded, privacy-projected snapshots, selected tracks and SSE events. */
export function createRadiosondeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  EventSourceImpl = globalThis.EventSource,
  now = Date.now,
} = {}) {
  async function read(route, { signal, serial } = {}) {
    signal?.throwIfAborted();
    if (route !== 'snapshot' && !SONDE_SERIAL_RE.test(serial || ''))
      throw malformed();
    const response = await fetchImpl(
      `/api/radiosondes/${route}${serial ? `?serial=${encodeURIComponent(serial)}` : ''}`,
      { signal },
    );
    signal?.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`SondeHub HTTP ${response.status}`);
    }
    const value = await readResponseJsonCapped(response, MAX_BYTES, signal);
    signal?.throwIfAborted();
    if (response.status === 202 && route === 'snapshot') {
      if (value?.status !== 'building') throw malformed();
      const retryAfterSec = Number(response.headers.get('retry-after'));
      return {
        status: 'building',
        retryAfterSec:
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? retryAfterSec
            : null,
      };
    }
    return route === 'snapshot'
      ? envelope(value, now())
      : trackEnvelope(value, serial, now());
  }
  return {
    getSnapshot: (options) => read('snapshot', options),
    getTrack: (options) => read('track', options),
    getHistory: (options) => read('history', options),
    subscribe(onEvent, onState = () => {}) {
      // An unavailable transport is polling-only; 'closed' instead means an
      // existing stream was interrupted and should still report reconnecting.
      let events;
      try {
        events = new EventSourceImpl('/api/radiosondes/stream');
      } catch {
        onState('unavailable');
        return () => {};
      }
      let closed = false;
      const report = () => {
        if (!closed)
          onState(
            ['connecting', 'open', 'closed'][events.readyState] ?? 'connecting',
          );
      };
      events.onopen = events.onerror = report;
      const listeners = new Map();
      for (const type of ['snapshot', 'frames', 'status']) {
        const listener = (event) => {
          if (
            closed ||
            typeof event.data !== 'string' ||
            event.data.length > MAX_BYTES
          )
            return;
          let value;
          try {
            value = JSON.parse(event.data);
            if (type === 'status') {
              if (
                !STATES.has(value?.upstream) ||
                (value.lastFrameMs !== null &&
                  !Number.isFinite(value.lastFrameMs))
              )
                return;
              value = {
                upstream: value.upstream,
                lastFrameMs: value.lastFrameMs,
              };
            } else value = envelope(value, now());
          } catch {
            return;
          }
          onEvent({ type, ...value });
        };
        listeners.set(type, listener);
        events.addEventListener(type, listener);
      }
      report();
      return () => {
        closed = true;
        for (const [type, listener] of listeners)
          events.removeEventListener(type, listener);
        events.onopen = events.onerror = null;
        events.close();
      };
    },
  };
}
