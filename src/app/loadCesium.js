// The production build externalizes Cesium: every `cesium` import reads the
// global that /cesium/Cesium.js defines, and the page loads that script only
// when something needs it. The dev server and Node import Cesium's ES module
// package instead, so there the SDK is always there and only the widget
// styles load. A Navara page that never needs Cesium never loads either.
//
// - `viewer()`: a Cesium globe is about to start: the SDK and the widget
//   styles;
// - `sdk()`: a feature that still builds on Cesium's entity model (the Nepal
//   event and locator) is used on Navara: the SDK alone.
export function createCesiumLoader({
  document = globalThis.document,
  globals = globalThis,
  base = `${import.meta.env?.BASE_URL ?? '/'}cesium/`,
  script = import.meta.env?.PROD === true,
} = {}) {
  let sdkPending = null;
  let stylesPending = null;
  const root = () => {
    globals.CESIUM_BASE_URL ??= base;
    return globals.CESIUM_BASE_URL.replace(/\/?$/, '/');
  };
  // A failed load leaves no element behind and can be retried.
  const load = (tag, url) => {
    const element = document.createElement(tag);
    if (tag === 'script') element.src = url;
    else {
      element.rel = 'stylesheet';
      element.href = url;
    }
    return new Promise((resolve, reject) => {
      element.onload = () => {
        element.onload = element.onerror = null;
        resolve();
      };
      element.onerror = () => {
        element.onload = element.onerror = null;
        element.remove();
        reject(new Error(`Could not load ${url}`));
      };
      document.head.append(element);
    });
  };
  // Read without running a getter: a page may define the global as one.
  const ready = () =>
    !script ||
    Object.getOwnPropertyDescriptor(globals, 'Cesium')?.value != null;
  // A page whose markup ran Cesium.js before this loader also carries its
  // widget styles (the MCP panel build, which cannot load files by URL).
  const preloaded = script && ready();
  const sdk = () => {
    if (ready()) return Promise.resolve();
    sdkPending ??= load('script', `${root()}Cesium.js`).catch((error) => {
      sdkPending = null;
      throw error;
    });
    return sdkPending;
  };
  const styles = () => {
    if (preloaded) return Promise.resolve();
    stylesPending ??= load('link', `${root()}Widgets/widgets.css`).catch(
      (error) => {
        stylesPending = null;
        throw error;
      },
    );
    return stylesPending;
  };
  return {
    ready,
    sdk,
    viewer: () => Promise.all([styles(), sdk()]).then(() => undefined),
  };
}

let loader;
const shared = () => (loader ??= createCesiumLoader());

/** Before a Cesium globe starts: the SDK and its widget styles. */
export function loadCesium() {
  return shared().viewer();
}

/** Before a feature that still builds on Cesium's entity model runs on Navara. */
export function loadCesiumSdk() {
  return shared().sdk();
}

/** Whether `cesium` imports can be read now, without waiting. */
export function cesiumSdkReady() {
  return shared().ready();
}

/**
 * Run `start` now when the SDK is there, else once it has loaded (a promise,
 * nothing when `signal` aborted meanwhile): a layer enable that is
 * synchronous everywhere but on a Navara page without the SDK yet.
 */
export function whenCesiumSdk(start, signal) {
  if (cesiumSdkReady()) return start();
  return loadCesiumSdk().then(() => (signal?.aborted ? undefined : start()));
}

/**
 * Production page, once at boot: until Cesium.js has run, a read of the
 * `Cesium` global (what every `cesium` import reads in this build) logs where
 * it came from and starts loading the SDK. A path that still needs Cesium on
 * a Navara page then fails once, visibly, and works when it runs again,
 * instead of failing for the rest of the session. Cesium.js's own assignment
 * turns the global back into a plain value. A global the page already has
 * (the strict QA trap, a host's own SDK) is left alone.
 */
export function guardCesiumGlobal({
  globals = globalThis,
  script = import.meta.env?.PROD === true,
  report = (stack) =>
    console.error('[Cesium] read before the SDK loaded', stack),
  load = loadCesiumSdk,
} = {}) {
  if (!script || Object.getOwnPropertyDescriptor(globals, 'Cesium')) return;
  let reports = 0;
  Object.defineProperty(globals, 'Cesium', {
    configurable: true,
    get() {
      if (reports++ < 10) report(new Error('Cesium read').stack);
      load().catch(() => {});
      return undefined;
    },
    set(value) {
      Object.defineProperty(globals, 'Cesium', {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    },
  });
}
