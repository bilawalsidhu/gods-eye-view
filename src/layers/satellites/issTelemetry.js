/**
 * The ISS model's joints from NASA's public telemetry, when the server relays
 * it (`/api/iss-telemetry`, off unless the operator sets
 * `ISS_TELEMETRY_ENABLED=1`). Without it, or while the station has no signal,
 * the joints keep the computed rules in issArticulation.js.
 *
 * How each telemetry angle maps onto a model joint was fitted against a
 * recording of the feed, using the station's own attitude and position from
 * the same feed:
 * - the dish's two angles give a direction that stayed within 0.3° of a TDRS
 *   relay satellite across a hand-over between two of them;
 * - the alpha joints' sign and zero put the arrays' masts square to the Sun;
 * - each beta joint's sign is the one that turns its cell side toward the Sun
 *   (the other sign faces it about 45° away). The arrays then sat 5° to 9°
 *   off the Sun, which is where the real station held them.
 * The radiator joints did not move during the recording, so their sign is the
 * better of the two candidates on a parked joint, not a fit.
 */

/** The route the server relays the feed at. */
export const ISS_TELEMETRY_URL = '/api/iss-telemetry';

const DEG = Math.PI / 180;

/** Alpha joints (SARJ), in ISS_ALPHA_JOINTS order: port, starboard. */
export const ISS_TELEMETRY_ALPHA = Object.freeze([
  Object.freeze({ item: 'S0000004', sign: 1 }),
  Object.freeze({ item: 'S0000003', sign: -1 }),
]);

/**
 * Beta joints (BGA), in ISS_BETA_JOINTS order: 2A, 4A, 2B, 4B, 1A, 3A, 1B,
 * 3B. The model's angle is `sign × telemetry + 90°`: at 0° or 180° an array
 * stands square to the truss, which is the model's ±90°.
 */
export const ISS_TELEMETRY_BETA = Object.freeze([
  Object.freeze({ item: 'P4000007', sign: 1 }),
  Object.freeze({ item: 'P4000008', sign: -1 }),
  Object.freeze({ item: 'P6000008', sign: -1 }),
  Object.freeze({ item: 'P6000007', sign: 1 }),
  Object.freeze({ item: 'S4000007', sign: -1 }),
  Object.freeze({ item: 'S4000008', sign: 1 }),
  Object.freeze({ item: 'S6000008', sign: 1 }),
  Object.freeze({ item: 'S6000007', sign: -1 }),
]);

/** Radiator joints (TRRJ), in ISS_RADIATOR_JOINTS order: port, starboard. */
export const ISS_TELEMETRY_GAMMA = Object.freeze([
  Object.freeze({ item: 'S0000002', sign: 1 }),
  Object.freeze({ item: 'S0000001', sign: 1 }),
]);

/** The Ku-band dish: elevation and cross-elevation. */
export const ISS_TELEMETRY_DISH = Object.freeze({
  elevation: 'Z1000014',
  crossElevation: 'Z1000015',
});

/**
 * Where the dish points, on the model's axes (port, zenith, forward), from
 * its two gimbal angles: zenith at rest, cross-elevation leans it to port,
 * elevation then tips it aft.
 * @param {number} elevationDeg
 * @param {number} crossElevationDeg
 * @returns {number[]} Unit vector.
 */
export function issTelemetryDishDirection(elevationDeg, crossElevationDeg) {
  const el = elevationDeg * DEG;
  const xel = crossElevationDeg * DEG;
  return [
    Math.sin(xel),
    Math.cos(el) * Math.cos(xel),
    -Math.sin(el) * Math.cos(xel),
  ];
}

/**
 * The joint angles a telemetry snapshot gives, as the model turns them.
 * @param {Record<string, [number, number|null]>|null|undefined} items The
 *   relay's `items`: each item's value and the time it was true at.
 * @returns {{alpha: number[], beta: number[], gamma: number[],
 *   dish: number[]|null}|null} Radians, in the joint lists' order; null
 *   unless every array and radiator joint is present. `dish` is null when
 *   its angles are missing.
 */
export function issTelemetryPose(items) {
  if (!items) return null;
  const read = (item) => {
    const value = items[item]?.[0];
    return Number.isFinite(value) ? value : null;
  };
  const turn = (list, offsetDeg) =>
    list.map(({ item, sign }) => {
      const value = read(item);
      return value === null ? null : (sign * value + offsetDeg) * DEG;
    });
  const alpha = turn(ISS_TELEMETRY_ALPHA, 0);
  const beta = turn(ISS_TELEMETRY_BETA, 90);
  const gamma = turn(ISS_TELEMETRY_GAMMA, 0);
  if ([...alpha, ...beta, ...gamma].includes(null)) return null;
  const el = read(ISS_TELEMETRY_DISH.elevation);
  const xel = read(ISS_TELEMETRY_DISH.crossElevation);
  return {
    alpha,
    beta,
    gamma,
    dish:
      el === null || xel === null ? null : issTelemetryDishDirection(el, xel),
  };
}

/** How often the relay is asked while the model is on screen. */
export const ISS_TELEMETRY_POLL_MS = 5_000;
/** A snapshot older than this is not used: the joints go back to their rules. */
export const ISS_TELEMETRY_FRESH_MS = 20_000;

/**
 * The newest moment any of the relay's items was true at: when the feed
 * last had data, as far as this answer tells.
 * @param {Record<string, [number, number]>|null|undefined} items
 * @returns {number|null} Epoch ms, or null without a dated item.
 */
export function issTelemetryLatestEpoch(items) {
  let latest = null;
  for (const entry of Object.values(items ?? {})) {
    const epoch = Array.isArray(entry) ? Number(entry[1]) : NaN;
    // An item with no time has 0 there, which is no date.
    if (
      epoch > 0 &&
      Number.isFinite(epoch) &&
      (latest === null || epoch > latest)
    )
      latest = epoch;
  }
  return latest;
}
/** The feed stops asking this long after the model was last drawn. */
const WANTED_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5_000;
/** After a failed request the next one waits this long. */
const FAILURE_WAIT_MS = 30_000;

/**
 * Polls the relay while the model is drawn. `touch()` each frame the model
 * shows keeps it asking; it stops by itself when the touches stop, and for
 * good once the server says the relay is not switched on.
 * @param {{fetchImpl?: typeof fetch, now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (id: unknown) => void}} [options]
 */
export function createIssTelemetryFeed({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  /** False once the server answered that the relay is off. */
  let configured = null;
  let lastTouchAt = null;
  let timer = null;
  let requesting = false;
  /** Bumped by destroy, so a request in flight cannot write after it. */
  let generation = 0;
  let pose = null;
  let poseAt = null;
  /** What the relay last said and when, for the station panel's status line. */
  let relayStatus = null;
  let answeredAt = null;
  let failures = 0;
  /** When the relay last reported signal; the "no signal since" time. */
  let liveUntil = null;

  async function request() {
    const mine = generation;
    requesting = true;
    const controller = new AbortController();
    const deadline = setTimer(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let wait = ISS_TELEMETRY_POLL_MS;
    try {
      const response = await fetchImpl(ISS_TELEMETRY_URL, {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('unavailable');
      const body = await response.json();
      if (mine !== generation) return;
      if (body?.configured !== true) {
        configured = false;
        pose = null;
        return;
      }
      configured = true;
      answeredAt = now();
      failures = 0;
      relayStatus = typeof body.status === 'string' ? body.status : null;
      const next = body.status === 'live' ? issTelemetryPose(body.items) : null;
      pose = next;
      poseAt = next ? now() : null;
      if (next) liveUntil = poseAt;
      // A page that opens during a loss of signal still learns when the
      // feed last had data: the newest value the relay holds was true then.
      else if (body.status === 'no-signal' && liveUntil === null)
        liveUntil = issTelemetryLatestEpoch(body.items);
    } catch {
      if (mine !== generation) return;
      failures += 1;
      wait = FAILURE_WAIT_MS;
    } finally {
      clearTimer(deadline);
      if (mine === generation) {
        requesting = false;
        schedule(wait);
      }
    }
  }

  function wanted() {
    return (
      configured !== false &&
      lastTouchAt !== null &&
      now() - lastTouchAt < WANTED_MS
    );
  }

  function schedule(ms) {
    if (timer !== null || requesting || !wanted()) return;
    timer = setTimer(() => {
      timer = null;
      if (wanted()) request();
    }, ms);
  }

  return {
    /** The model is on screen: keep the feed asking. */
    touch() {
      lastTouchAt = now();
      schedule(0);
    },
    /**
     * The joint angles to use now, or null: no relay, no signal, or the last
     * answer is too old.
     * @returns {{alpha: number[], beta: number[], gamma: number[],
     *   dish: number[]|null}|null}
     */
    pose() {
      if (!pose || poseAt === null) return null;
      return now() - poseAt < ISS_TELEMETRY_FRESH_MS ? pose : null;
    },
    /** Whether the server relays the feed: null until it has answered. */
    configured() {
      return configured;
    },
    /**
     * Where the joints' angles stand, for the station panel: `live` with a
     * fresh pose; `no-signal` while the relay is up but the station is out
     * of contact; `unavailable` when the relay cannot be reached or is not
     * connected; `disabled` when this server does not relay the feed;
     * `pending` before the first answer. `poseAgeMs` is how old the last
     * pose is, `liveUntilMs` when signal was last had (epoch ms), both null
     * when there was none.
     * @returns {{state: 'live'|'no-signal'|'unavailable'|'disabled'|'pending',
     *   poseAgeMs: number|null, liveUntilMs: number|null}}
     */
    status() {
      const at = now();
      const poseAgeMs = poseAt === null ? null : at - poseAt;
      let state;
      if (configured === false) state = 'disabled';
      else if (configured === null) state = 'pending';
      else if (pose && poseAgeMs < ISS_TELEMETRY_FRESH_MS) state = 'live';
      else if (failures === 0 && relayStatus === 'no-signal')
        state = 'no-signal';
      else if (
        failures === 0 &&
        (relayStatus === 'connecting' || relayStatus === 'reconnecting') &&
        answeredAt !== null &&
        at - answeredAt < ISS_TELEMETRY_FRESH_MS
      )
        state = 'pending';
      else state = 'unavailable';
      return { state, poseAgeMs, liveUntilMs: liveUntil };
    },
    destroy() {
      generation += 1;
      if (timer !== null) clearTimer(timer);
      timer = null;
      requesting = false;
      lastTouchAt = null;
      pose = null;
      poseAt = null;
      configured = null;
      relayStatus = null;
      answeredAt = null;
      failures = 0;
      liveUntil = null;
    },
  };
}
