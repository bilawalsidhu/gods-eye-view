/**
 * Subscribe to the remote-control stream and apply each view.
 * The page session comes from `?remote=<session>`; `?remote=off` does not connect.
 */

import {
  applyRemotePlan,
  parseRemoteEvent,
  remoteSessionFromSearch,
} from './protocol.js';

const STREAM_PATH = '/api/remote/stream';
const STATUS_LABEL = Object.freeze({
  connecting: 'Remote · connecting',
  live: 'Remote · live',
  applying: 'Remote · applying',
  reconnecting: 'Remote · reconnecting',
});
const STATUS_STYLE = [
  'position:fixed',
  'left:12px',
  'bottom:12px',
  'z-index:30',
  'font:12px/1.2 ui-sans-serif,system-ui,sans-serif',
  'color:#d7e0ea',
  'background:rgba(8,12,18,.72)',
  'border:1px solid rgba(255,255,255,.16)',
  'border-radius:999px',
  'padding:4px 8px',
  'pointer-events:none',
].join(';');

export { applyRemotePlan, parseRemoteEvent, remoteSessionFromSearch };

/** A console line safe to print: no bearer and no query secret. */
function reportRemoteError(error) {
  const message = String(error?.message || error || 'unknown')
    .replace(/bearer\s+\S+/gi, 'bearer [redacted]')
    .replace(/([?&](?:access_token|token|key)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 300);
  console.warn(`[gev-remote] ${message}`);
}

/**
 * Open the stream and publish `{ status, lastApplied }` on `windowRef.__gevRemote`.
 * Returns a disposer. `apply` receives a normalized view.
 */
export function createRemoteControl({
  search = '',
  EventSource,
  apply,
  windowRef = globalThis,
  documentRef = null,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  streamPath = STREAM_PATH,
  now = () => Date.now(),
} = {}) {
  const sessionChoice = remoteSessionFromSearch(search);
  const state = { status: 'off', lastApplied: null };
  windowRef.__gevRemote = state;
  let stopped = false;
  let source = null;
  let retry = null;
  let delayMs = 1000;
  let attempt = 0;
  let queue = Promise.resolve();
  let indicator = null;

  const paint = () => {
    if (!indicator) return;
    indicator.textContent = STATUS_LABEL[state.status] || 'Remote';
    indicator.dataset.state = state.status;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (retry != null) clearTimer(retry);
    source?.close?.();
    indicator?.remove?.();
    if (windowRef.__gevRemote === state) delete windowRef.__gevRemote;
  };

  if (!sessionChoice.enabled || typeof EventSource !== 'function') {
    state.status = 'off';
    return stop;
  }
  if (typeof apply !== 'function')
    throw new TypeError('remote control needs an apply function');

  if (documentRef?.body && typeof documentRef.createElement === 'function') {
    indicator = documentRef.createElement('div');
    indicator.id = 'gev-remote-status';
    indicator.setAttribute('aria-live', 'polite');
    indicator.style.cssText = STATUS_STYLE;
    documentRef.body.appendChild(indicator);
  }

  const url = `${streamPath}?session=${encodeURIComponent(sessionChoice.session)}`;
  const connect = () => {
    if (stopped) return;
    attempt += 1;
    state.status = attempt > 1 ? 'reconnecting' : 'connecting';
    paint();
    const current = new EventSource(url);
    source = current;
    current.onopen = () => {
      if (stopped || source !== current) return;
      delayMs = 1000;
      state.status = 'live';
      paint();
    };
    current.onerror = () => {
      if (stopped || source !== current) return;
      current.onerror = null;
      current.close?.();
      state.status = 'reconnecting';
      paint();
      retry = setTimer(() => {
        retry = null;
        connect();
      }, delayMs);
      delayMs = Math.min(delayMs * 2, 15_000);
    };
    current.onmessage = (event) => {
      if (stopped || source !== current) return;
      const parsed = parseRemoteEvent(event?.data);
      if (!parsed.ok) {
        reportRemoteError(`ignored event: ${parsed.error}`);
        return;
      }
      queue = queue
        .then(async () => {
          if (stopped) return;
          state.status = 'applying';
          paint();
          const applied = await apply(parsed.view);
          if (stopped) return;
          state.lastApplied = { view: parsed.view, applied, at: now() };
          state.status = 'live';
          paint();
        })
        .catch((error) => {
          if (stopped) return;
          reportRemoteError(`apply failed: ${error?.message || error}`);
          state.status = 'live';
          paint();
        });
    };
  };
  connect();
  return stop;
}
