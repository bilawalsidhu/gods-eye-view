import { requestWithDeadline } from '../sources/requestDeadline.js';

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
  isPageVisible = () => globalThis.document?.visibilityState !== 'hidden',
  onPageVisibility = listenForPageVisibility,
}) {
  let point = '';
  let mountId = null;
  let deadline = null;

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
      weatherPoint(input.center) === target.point
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
    try {
      await requestWithDeadline(
        async (bounded) => {
          // Publish inside the operation: live camera eligibility can change before
          // the bridge delivers its next batched update.
          const timeout = () => {
            if (active !== request) return;
            request.controller.abort(bounded.reason);
            completeRead(request, null);
          };
          bounded.addEventListener('abort', timeout, { once: true });
          let brief = null;
          try {
            brief = await read(center.lat, center.lon, {
              signal,
              exactPoint: true,
            });
          } catch {
            // Failed reads use the same retry as missing observations.
          } finally {
            bounded.removeEventListener('abort', timeout);
          }
          completeRead(request, brief);
        },
        { signal, timeoutMs: READ_TIMEOUT_MS },
      );
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }

  function completeRead(request, brief) {
    if (!currentInputFor(request)) return;

    active = null;
    syncClock(shown);
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
    deadline = reading ? elapsed + REFRESH_MS : Date.now() + RETRY_MS;
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
    request.timer = scheduleTimeout(() => void settle(request), SETTLE_MS);
  }

  function update(input) {
    if (stopped) return;
    shown = input.shown;
    syncClock(shown);
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
    syncClock(input.shown);
    if (!input.shown || !isPageVisible()) return;
    // Only a visible pulse makes a completed reading eligible for renewal.
    // Once due, work stays eligible if a move or hide cancels the request.
    if (deadline !== null && (state.reading ? elapsed : Date.now()) >= deadline)
      deadline = null;
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
