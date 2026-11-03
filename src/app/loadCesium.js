// The production build externalizes Cesium; the dev server imports its ESM
// package. Both load widget CSS only when a native viewer is requested.
export function createCesiumLoader({
  document = globalThis.document,
  globals = globalThis,
  base = `${import.meta.env?.BASE_URL ?? '/'}cesium/`,
  script = import.meta.env?.PROD === true,
} = {}) {
  let pending;
  return () => {
    if (pending) return pending;
    globals.CESIUM_BASE_URL ??= base;
    const root = globals.CESIUM_BASE_URL.replace(/\/?$/, '/');
    const elements = [];
    const load = (tag, url) =>
      new Promise((resolve, reject) => {
        const element = document.createElement(tag);
        elements.push(element);
        if (tag === 'script') element.src = url;
        else {
          element.rel = 'stylesheet';
          element.href = url;
        }
        element.onload = () => {
          element.onload = element.onerror = null;
          resolve();
        };
        element.onerror = () => reject(new Error(`Could not load ${url}`));
        document.head.append(element);
      });
    pending = Promise.all([
      load('link', `${root}Widgets/widgets.css`),
      ...(script && !globals.Cesium
        ? [load('script', `${root}Cesium.js`)]
        : []),
    ]).catch((error) => {
      for (const element of elements) {
        element.onload = element.onerror = null;
        element.remove();
      }
      pending = null;
      throw error;
    });
    return pending;
  };
}

let load;
export function loadCesium() {
  load ??= createCesiumLoader();
  return load();
}
