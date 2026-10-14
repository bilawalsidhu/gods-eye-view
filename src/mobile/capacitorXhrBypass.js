/**
 * Same-origin XHR bypass for the Capacitor native bridge.
 *
 * Background: when `CapacitorHttp` is enabled, the injected native bridge
 * replaces `window.XMLHttpRequest` with a constructor whose instances use
 * `CapacitorWebXMLHttpRequest.prototype` — whose patched `open` rewrites
 * absolute `http(s)` URLs through the native interceptor
 * (`/_capacitor_http_interceptor_?u=...`). Unlike the bridge's fetch patch,
 * the XHR patch has no same-origin bypass: it only skips relative URLs.
 * Cesium loads its bundled static assets (SkyBox textures, terrain-height
 * data, IAU tables) over XHR with absolute same-origin URLs, so on-device
 * they are proxied to a real TLS connection against `localhost:443`, fail
 * with `CONNECTION_REFUSED`, and surface as `RequestErrorEvent` plain
 * objects (`{statusCode, response, responseHeaders}`) that stop Cesium's
 * render loop.
 *
 * Fix: rewrite absolute same-origin XHR URLs to relative paths before the
 * bridge patch sees them. Relative URLs take the real (local-server) path.
 *
 * Lifecycle hazard (observed on-device): the bridge (re)applies its XHR
 * patch after app modules evaluate, silently discarding a one-shot wrapper
 * — the wrapper is gone but no error surfaces. So instead of assigning a
 * wrapper once, this installs an ACCESSOR for `open` on the live prototype:
 * every future reassignment of `open` (including the bridge's own
 * re-patches) flows through the setter and gets wrapped on the spot, with
 * zero timing dependence. A bounded poll
 * (`installSameOriginXhrBypassWhenReady`) covers the remaining cases: the
 * bridge object appearing late, or the holder object itself being replaced.
 *
 * Install once, at boot, on native shells only; web is untouched.
 *
 * @module mobile/capacitorXhrBypass
 */

const INSTALLED = Symbol.for('gev.sameOriginXhrBypassInstalled');

/** Live prototype each globalRef was last installed on (identity tracking). */
const wrappedProtos = new WeakMap();

/**
 * Resolve the native shell's server origin (`https://localhost`).
 * @param {object} globalRef Window-like global.
 * @returns {string} Origin without trailing slash, or '' when unknown.
 */
function resolveServerOrigin(globalRef) {
  try {
    const fromCapacitor =
      typeof globalRef?.Capacitor?.getServerUrl === 'function'
        ? globalRef.Capacitor.getServerUrl()
        : '';
    const origin = String(fromCapacitor || globalRef?.location?.origin || '');
    return origin.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * Find the XHR prototype whose `open` the bridge patched: instances created
 * via the replaced `window.XMLHttpRequest` use
 * `CapacitorWebXMLHttpRequest.prototype` — NEVER `window.XMLHttpRequest.prototype`,
 * which the bridge leaves as an unused default object. There is intentionally
 * no fallback: wrapping the pre-bridge native prototype would succeed
 * silently and then be orphaned when the bridge replaces the constructor.
 * @param {object} globalRef Window-like global.
 * @returns {object|null} The bridged prototype, or null when the bridge
 *   patch is not in place yet.
 */
function findPatchedXhrPrototype(globalRef) {
  const bridged = globalRef?.CapacitorWebXMLHttpRequest?.prototype;
  if (bridged && typeof bridged.open === 'function') return bridged;
  return null;
}

/**
 * Wrap a bridge `open` so absolute same-origin URLs become relative.
 * Idempotent: an already-wrapped function is returned as-is.
 * @param {Function} rawOpen Bridge (or previously wrapped) open.
 * @param {string} serverOrigin Origin prefix, no trailing slash.
 * @returns {Function} Wrapped open, marked with INSTALLED.
 */
function wrapOpen(rawOpen, serverOrigin) {
  if (typeof rawOpen === 'function' && rawOpen[INSTALLED] === true) {
    return rawOpen;
  }
  const prefix = `${serverOrigin}/`;
  const wrapped = function (method, url, ...rest) {
    if (typeof url === 'string' && url.startsWith(prefix)) {
      url = url.slice(serverOrigin.length) || '/';
    }
    return rawOpen.call(this, method, url, ...rest);
  };
  wrapped[INSTALLED] = true;
  return wrapped;
}

/**
 * Install the same-origin XHR bypass.
 * @param {{ globalRef?: object }} options Global to patch (test seam).
 * @returns {boolean} True when protection is active now.
 */
export function installSameOriginXhrBypass({ globalRef = globalThis } = {}) {
  const proto = findPatchedXhrPrototype(globalRef);
  if (!proto) return false;
  const serverOrigin = resolveServerOrigin(globalRef);
  if (!serverOrigin) return false;
  let currentRaw;
  try {
    currentRaw = proto.open;
  } catch {
    return false;
  }
  if (typeof currentRaw !== 'function') return false;
  // Already ours (accessor in place from a previous install): no-op. A
  // bridge re-patch flows through the setter below, so no reinstall is
  // ever needed for the same prototype object.
  try {
    const existing = Object.getOwnPropertyDescriptor(proto, 'open');
    if (proto[INSTALLED] && existing && typeof existing.get === 'function') {
      wrappedProtos.set(globalRef, proto);
      return false;
    }
  } catch {
    return false;
  }
  let cached = null;
  let cachedRaw = null;
  const getWrapped = () => {
    if (!cached || cachedRaw !== currentRaw) {
      cached = wrapOpen(currentRaw, serverOrigin);
      cachedRaw = currentRaw;
    }
    return cached;
  };
  try {
    Object.defineProperty(proto, 'open', {
      configurable: true,
      enumerable: true,
      get: getWrapped,
      set(newRaw) {
        currentRaw = newRaw;
      },
    });
  } catch {
    return false;
  }
  wrappedProtos.set(globalRef, proto);
  proto[INSTALLED] = true;
  return getWrapped() !== null;
}

/**
 * Install the bypass as soon as the bridge's XHR patch exists — the
 * accessor installed by `installSameOriginXhrBypass` then self-heals
 * across later re-patches, so this poll only needs to cover the bridge
 * object appearing late (or being replaced). Nativeness is evaluated late
 * (at attempt time), never at module-eval time.
 * @param {{ globalRef?: object, intervalMs?: number, timeoutMs?: number }} options Global, poll cadence, give-up time.
 * @returns {Promise<boolean>} True when protection is active.
 */
export function installSameOriginXhrBypassWhenReady({
  globalRef = globalThis,
  intervalMs = 25,
  timeoutMs = 8000,
} = {}) {
  const installedHere = () =>
    wrappedProtos.get(globalRef) ===
      globalRef?.CapacitorWebXMLHttpRequest?.prototype &&
    !!globalRef?.CapacitorWebXMLHttpRequest?.prototype?.[INSTALLED];
  const attempt = () => {
    const cap = globalRef?.Capacitor;
    if (!cap) return false;
    let native = false;
    try {
      native =
        cap.isNativePlatform?.() === true || cap.getPlatform?.() === 'android';
    } catch {
      native = false;
    }
    if (!native) return false;
    return installSameOriginXhrBypass({ globalRef });
  };
  if (attempt() && installedHere()) return Promise.resolve(true);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const done = attempt() || installedHere();
      if (done || Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve(installedHere());
      }
    }, intervalMs);
  });
}
