import { readResponseJsonCapped } from '../../sources/httpBody.js';

const FRAME_NAME = /^\d{14}_rad_128\.png$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function malformed() {
  return new Error('Malformed HKO radar manifest');
}

/** Validate a same-origin HKO radar frame path built by the local proxy. */
export function hkoRadarFrameUrl(name) {
  if (typeof name !== 'string' || !FRAME_NAME.test(name))
    throw new Error('Invalid HKO radar frame');
  return `/api/hko-radar/frame?name=${encodeURIComponent(name)}`;
}

/** Only bounded, pinned proxy frames may become imagery requests. */
export function validateHkoRadarSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || value.product !== 'radar-128')
    throw malformed();
  if (value.unavailable) return value;
  const { extent, frames } = value;
  if (
    !extent ||
    !['west', 'south', 'east', 'north'].every((key) =>
      Number.isFinite(extent[key]),
    ) ||
    extent.west < -180 ||
    extent.east > 180 ||
    extent.south < -90 ||
    extent.north > 90 ||
    extent.west >= extent.east ||
    extent.south >= extent.north ||
    !Array.isArray(frames) ||
    frames.length < 1 ||
    frames.length > 32 ||
    frames.some((frame, i) => {
      if (
        !frame ||
        typeof frame.time !== 'string' ||
        !TIME.test(frame.time) ||
        !Number.isFinite(Date.parse(frame.time)) ||
        new Date(frame.time).toISOString() !== frame.time ||
        typeof frame.href !== 'string' ||
        !FRAME_NAME.test(frame.href) ||
        typeof frame.url !== 'string' ||
        frame.url !== hkoRadarFrameUrl(frame.href) ||
        (i > 0 && frame.time <= frames[i - 1].time)
      )
        return true;
      return false;
    }) ||
    value.latest !== frames.at(-1).time ||
    typeof value.attribution !== 'string' ||
    !value.attribution.trim()
  )
    throw malformed();
  return value;
}

/** Acquisition is lazy and shares the application's existing source contract. */
export function createHkoRadarSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('HKO radar request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl('/api/hko-radar', {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('HKO radar unavailable');
        }
        const payload = await readResponseJsonCapped(
          response,
          256 * 1024,
          controller.signal,
        );
        return validateHkoRadarSnapshot(payload);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
