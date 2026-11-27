import { requestWithDeadline } from '../sources/requestDeadline.js';

const pageVisible = () => globalThis.document?.visibilityState !== 'hidden';
const SETTLE_MS = 400;
const READ_TIMEOUT_MS = 15_000;
export const WEATHER_RETRY_MS = 60_000;
const REFRESH_MS = 11 * 60_000;
// The point-weather request sends coordinates to five decimal places.
export function weatherPoint(center) {
  return Number.isFinite(center?.lat) && Number.isFinite(center?.lon)
    ? `${Number(center.lat.toFixed(5))},${Number(center.lon.toFixed(5))}`
    : '';
}

function weatherAtRequestedPoint(brief, point) {
  const coords = brief?.coordinates;
  return (
    !coords ||
    weatherPoint({ lat: coords.latitude, lon: coords.longitude }) === point
  );
}

// Hosts may share weather across a cell, but its zone belongs to the observed point.
export async function readPointWeather(read, point, signal) {
  const brief = await requestWithDeadline(read, {
    signal,
    timeoutMs: READ_TIMEOUT_MS,
  }).catch(() => null);
  const reading = Number.isFinite(brief?.weather?.temperatureC)
    ? brief.weather
    : null;
  const zone =
    reading && weatherAtRequestedPoint(brief, point)
      ? {
          point,
          timeZone: reading.timeZone,
          utcOffsetSeconds: reading.utcOffsetSeconds,
        }
      : null;
  return {
    reading,
    zone,
    freshnessAt: reading ? freshnessOf(reading, brief) : null,
  };
}

function freshnessOf(reading, brief) {
  const observed = Date.parse(reading.observedAt);
  if (Number.isFinite(observed)) return observed;
  const retrieved = Date.parse(brief.retrievedAt);
  return Number.isFinite(retrieved) ? retrieved : Date.now();
}

/** Own the Inspector observation and its scheduler for one Context bridge. */
export function createViewWeather({
  read,
  publish,
  readCurrentInput,
  setTimeout: scheduleTimeout = (...args) => globalThis.setTimeout(...args),
  clearTimeout: cancelTimeout = (...args) => globalThis.clearTimeout(...args),
}) {
  let point = '';
  let mountId = null;
  let deadline = null;

  let shown = false;
  let active = null;
  let stopped = false;
  let state = {
    reading: null,
    failed: false,
    zone: null,
    freshnessAt: null,
    pending: false,
  };

  function setState(changes) {
    if (
      stopped ||
      Object.keys(changes).every((key) => changes[key] === state[key])
    )
      return;
    state = { ...state, ...changes };
    publish(state);
  }

  function retire() {
    if (!active) return;
    const request = active;
    active = null;
    if (request.timer !== null) cancelTimeout(request.timer);
    request.controller.abort();
  }

  function matches(input, target) {
    return (
      input.shown &&
      pageVisible() &&
      !input.moving &&
      input.mountId === target.mountId &&
      weatherPoint(input.center) === target.point
    );
  }

  function currentInputFor(request) {
    if (stopped || active !== request) return null;
    // Live inputs can change before the bridge's batched update.
    const input = readCurrentInput();
    if (matches(input, request)) return input;
    retire();
    setState({ pending: false });
    return null;
  }

  async function settle(request) {
    request.timer = null;
    const input = currentInputFor(request);
    if (!input) return;

    const { center } = input;
    const { signal } = request.controller;
    setState({ pending: true });
    if (active !== request) return;
    const { reading, zone, freshnessAt } = await readPointWeather(
      async (bounded) => {
        try {
          return await read(center.lat, center.lon, {
            signal: bounded,
            exactPoint: true,
          });
        } finally {
          // Sample the live camera before a queued update can move it back.
          currentInputFor(request);
        }
      },
      request.point,
      signal,
    );
    if (!currentInputFor(request)) return;
    active = null;
    deadline = Date.now() + (reading ? REFRESH_MS : WEATHER_RETRY_MS);
    setState({
      reading,
      failed: reading === null,
      zone,
      freshnessAt,
      pending: false,
    });
  }

  function schedule(input) {
    if (
      stopped ||
      active ||
      !point ||
      mountId === null ||
      !shown ||
      !matches(input, { point, mountId }) ||
      deadline !== null
    )
      return;
    const request = {
      point,
      mountId,
      controller: new AbortController(),
      timer: null,
    };
    active = request;
    request.timer = scheduleTimeout(() => void settle(request), SETTLE_MS);
  }

  function update(input) {
    if (stopped) return;
    shown = input.shown;
    mountId = input.mountId;
    const nextPoint = weatherPoint(input.center);
    if (active && !matches(input, active)) retire();
    if (point !== nextPoint) {
      point = nextPoint;
      deadline = null;
      setState({
        reading: null,
        failed: false,
        zone: null,
        freshnessAt: null,
        pending: false,
      });
    } else {
      setState({ pending: !!active && state.pending });
    }
    schedule(input);
  }

  function pulse() {
    if (stopped) return;
    const input = readCurrentInput();
    if (!input.shown || !pageVisible()) return;
    // Only a visible pulse makes a completed reading eligible for renewal.
    // Once due, work stays eligible if a move or hide cancels the request.
    if (deadline !== null && Date.now() >= deadline) deadline = null;
    schedule(input);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    retire();
  }

  return { update, pulse, stop };
}
