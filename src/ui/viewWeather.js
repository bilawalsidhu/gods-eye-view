import { requestWithDeadline } from '../sources/requestDeadline.js';

const pageVisible = () => globalThis.document?.visibilityState !== 'hidden';
const SETTLE_MS = 400;
const READ_TIMEOUT_MS = 15_000;
const RETRY_MS = 60_000;
const REFRESH_MS = 11 * 60_000;
// The point-weather request sends coordinates to five decimal places.
export function weatherPoint(center) {
  return Number.isFinite(center?.lat) && Number.isFinite(center?.lon)
    ? `${Number(center.lat.toFixed(5))},${Number(center.lon.toFixed(5))}`
    : '';
}

function freshnessOf(reading, brief) {
  const observed = Date.parse(reading.observedAt);
  if (Number.isFinite(observed)) return observed;
  const retrieved = Date.parse(brief.retrievedAt);
  return Number.isFinite(retrieved) ? retrieved : Date.now();
}

/** Own the Inspector observation and its scheduler for one Context bridge. */
export function createViewWeather({ read, publish, readCurrentInput }) {
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
    if (request.timer !== null) clearTimeout(request.timer);
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
    let brief = null;
    try {
      brief = await requestWithDeadline(
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
        { signal, timeoutMs: READ_TIMEOUT_MS },
      );
    } catch {
      // Failed and timed-out reads use the same retry as missing observations.
    }
    completeRead(request, brief);
  }

  function completeRead(request, brief) {
    if (!currentInputFor(request)) return;

    active = null;
    const reading = Number.isFinite(brief?.weather?.temperatureC)
      ? brief.weather
      : null;
    // A host may share weather across a cell. Its zone belongs only to the
    // observation point. A host without coordinates serves the requested point.
    const observedPoint = brief?.coordinates
      ? weatherPoint({
          lat: brief.coordinates.latitude,
          lon: brief.coordinates.longitude,
        })
      : request.point;
    const zone =
      reading && observedPoint === request.point
        ? {
            point: request.point,
            timeZone: reading.timeZone,
            utcOffsetSeconds: reading.utcOffsetSeconds,
          }
        : null;
    deadline = Date.now() + (reading ? REFRESH_MS : RETRY_MS);
    setState({
      reading,
      failed: reading === null,
      zone,
      freshnessAt: reading ? freshnessOf(reading, brief) : null,
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
    request.timer = setTimeout(() => void settle(request), SETTLE_MS);
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
