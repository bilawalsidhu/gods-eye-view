import { greatCircleKm } from '../geoDistance.js';

const SETTLE_MS = 400;
const RETRY_MS = 60_000;
const REFRESH_MS = 11 * 60_000;
const ZONE_KEEP_KM = 300;

// Match the proxy's 0.1 degree cells after rounding the request coordinates.
const coordinate = (value) => Math.round(Number(value.toFixed(5)) * 10);

export function weatherCell(center) {
  return Number.isFinite(center?.lat) && Number.isFinite(center?.lon)
    ? `${coordinate(center.lat)},${coordinate(center.lon)}`
    : '';
}

function freshnessOf(reading, brief, now) {
  const observed = Date.parse(reading.observedAt);
  if (Number.isFinite(observed)) return observed;
  const retrieved = Date.parse(brief.retrievedAt);
  return Number.isFinite(retrieved) ? retrieved : now();
}

function listenForPageVisibility(callback) {
  const document = globalThis.document;
  document?.addEventListener('visibilitychange', callback);
  return () => document?.removeEventListener('visibilitychange', callback);
}

/** Own the Inspector observation and its scheduler for one Context bridge. */
export function createViewWeather({
  read,
  publish,
  readCurrentInput,
  setTimeout: scheduleTimeout = (...args) => globalThis.setTimeout(...args),
  clearTimeout: cancelTimeout = (...args) => globalThis.clearTimeout(...args),
  nowMonotonic = () => performance.now(),
  now = Date.now,
  isPageVisible = () => globalThis.document?.visibilityState !== 'hidden',
  onPageVisibility = listenForPageVisibility,
}) {
  let cell = '';
  let mountId = null;
  let deadline = null;
  let zoneMount = null;
  let shown = false;
  let active = null;
  let stopped = false;
  let elapsed = 0;
  let visibleSince = null;
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

  function syncClock(eligible) {
    const moment = nowMonotonic();
    if (visibleSince !== null) elapsed += moment - visibleSince;
    visibleSince = eligible && isPageVisible() ? moment : null;
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
      isPageVisible() &&
      !input.moving &&
      input.mountId === target.mountId &&
      weatherCell(input.center) === target.cell
    );
  }

  function currentInputFor(request) {
    if (stopped || active !== request) return null;
    // Live inputs can change before the bridge's batched update.
    const input = readCurrentInput();
    if (matches(input, request)) return input;
    if (!input.shown) syncClock(false);
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
      brief = await read(center.lat, center.lon, { signal });
    } catch {
      // An error from the current request has the same result as no reading.
    }
    if (!currentInputFor(request)) return;

    active = null;
    syncClock(shown);
    const reading = brief?.weather ?? null;
    let { zone } = state;
    if (reading) {
      const { latitude, longitude } = brief.coordinates ?? {};
      // A shared cache cell can return a reading taken across a border.
      const observationCenter =
        Number.isFinite(latitude) &&
        Math.abs(latitude) <= 90 &&
        Number.isFinite(longitude) &&
        Math.abs(longitude) <= 180
          ? { lat: latitude, lon: longitude }
          : center;
      zone = {
        cell: request.cell,
        center: observationCenter,
        timeZone: reading.timeZone,
        utcOffsetSeconds: reading.utcOffsetSeconds,
      };
      zoneMount = request.mountId;
    } else if (zone?.cell !== request.cell) {
      zone = null;
    }
    deadline = elapsed + (reading ? REFRESH_MS : RETRY_MS);
    setState({
      reading,
      failed: !Number.isFinite(reading?.temperatureC),
      zone,
      freshnessAt: reading ? freshnessOf(reading, brief, now) : null,
      pending: false,
    });
  }

  function schedule(input) {
    if (
      stopped ||
      active ||
      !cell ||
      mountId === null ||
      !shown ||
      !matches(input, { cell, mountId }) ||
      deadline !== null
    )
      return;
    const request = {
      cell,
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
    syncClock(shown);
    mountId = input.mountId;
    const nextCell = weatherCell(input.center);
    let { zone } = state;
    if (
      !nextCell ||
      (zone &&
        zone.cell !== nextCell &&
        (zoneMount !== mountId ||
          greatCircleKm(zone.center, input.center) > ZONE_KEEP_KM))
    )
      zone = null;

    if (active && !matches(input, active)) retire();
    if (cell !== nextCell) {
      cell = nextCell;
      deadline = null;
      setState({
        reading: null,
        failed: false,
        zone,
        freshnessAt: null,
        pending: false,
      });
    } else {
      setState({ zone, pending: !!active && state.pending });
    }
    schedule(input);
  }

  function pulse() {
    if (stopped) return;
    const input = readCurrentInput();
    syncClock(input.shown);
    if (!input.shown || !isPageVisible()) return;
    // Only a visible pulse makes a completed reading eligible for renewal.
    // Once due, work stays eligible if a move or hide cancels the request.
    if (deadline !== null && elapsed >= deadline) deadline = null;
    schedule(input);
  }

  const offPageVisibility = onPageVisibility(() => {
    if (!stopped) syncClock(readCurrentInput().shown);
  });

  function stop() {
    if (stopped) return;
    stopped = true;
    offPageVisibility?.();
    retire();
  }

  return { update, pulse, stop };
}
