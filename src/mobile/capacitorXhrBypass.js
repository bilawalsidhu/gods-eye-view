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
 * Fix: rewrite absolute same-origin XHR URLs to relative paths on
 * `CapacitorWebXMLHttpRequest.prototype` (the prototype the bridge's
 * instances actually use — NOT `window.XMLHttpRequest.prototype`, which the
 * bridge leaves as an unused default object) before the bridge patch sees
 * them. Relative URLs take the real (local-server) path. Install once, at
 * boot, on native shells only; web is untouched.
 *
 * @module mobile/capacitorXhrBypass
 */

const INSTALLED = Symbol.for('gev.sameOriginXhrBypassInstalled');

/** Live prototype each globalRef was last wrapped on (identity tracking). */
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
 * Install the same-origin XHR bypass.
 * @param {{ globalRef?: object }} options Global to patch (test seam).
 * @returns {boolean} True when installed, false when already installed or impossible.
 */
export function installSameOriginXhrBypass({ globalRef = globalThis } = {}) {
  const proto = findPatchedXhrPrototype(globalRef);
  if (!proto) return false;
  // Guard on the wrapper marker on `open` itself, not just the proto: if the
  // bridge re-applied its patch, `open` is fresh again and must be rewrapped
  // even though a previous install already tagged the prototype object.
  try {
    if (proto.open?.[INSTALLED] === true) return false;
  } catch {
    return false;
  }
  const serverOrigin = resolveServerOrigin(globalRef);
  if (!serverOrigin) return false;
  const prefix = `${serverOrigin}/`;
  const patchedOpen = proto.open;
  proto.open = function (method, url, ...rest) {
    if (typeof url === 'string' && url.startsWith(prefix)) {
      url = url.slice(serverOrigin.length) || '/';
    }
    return patchedOpen.call(this, method, url, ...rest);
  };
  proto.open[INSTALLED] = true;
  proto[INSTALLED] = true;
  wrappedProtos.set(globalRef, proto);
  return true;
}

/**
 * Install the bypass as soon as the bridge's XHR patch is ready — and keep
 * it installed. The native bridge may (re)apply its XHR patch after app
 * modules evaluate, which silently discards a one-shot install, so this
 * polls for a bounded window, reinstalling whenever the live prototype
 * loses the bypass, and settles once the bypass survives consecutive
 * checks. Nativeness is evaluated late (at attempt time), never at
 * module-eval time.
 * @param {{ globalRef?: object, intervalMs?: number, timeoutMs?: number, settleChecks?: number }} options Global, poll cadence, give-up time, consecutive verifications to settle early.
 * @returns {Promise<boolean>} True when protection is active at settle time.
 */
export function installSameOriginXhrBypassWhenReady({
  globalRef = globalThis,
  intervalMs = 25,
  timeoutMs = 8000,
  settleChecks = 3,
} = {}) {
  const liveProto = () =>
    globalRef?.CapacitorWebXMLHttpRequest?.prototype ?? null;
  const isActive = () => {
    const proto = liveProto();
    if (!proto || wrappedProtos.get(globalRef) !== proto) return false;
    try {
      return proto.open?.[INSTALLED] === true;
    } catch {
      return false;
    }
  };
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
    return installSameOriginXhrBypass({ globalRef }) || isActive();
  };
  if (attempt() && isActive()) return Promise.resolve(true);
  const startedAt = Date.now();
  let consecutive = 0;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (isActive()) {
        consecutive += 1;
      } else {
        consecutive = 0;
        attempt();
      }
      if (consecutive >= settleChecks || Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve(isActive());
      }
    }, intervalMs);
  });
}
