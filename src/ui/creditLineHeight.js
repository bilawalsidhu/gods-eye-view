/**
 * @module ui/creditLineHeight
 * @description Keeps `--credit-line-height` on the page's root at the
 * height of the attribution line at the bottom of the screen, so what sits
 * above it (the HUD's bottom corners) clears it when it wraps onto more
 * lines. The line is the application's own (`#gev-credits`) or the one a
 * renderer draws inside `#cesium-credits`.
 */

const LINES = ['#gev-credits', '#cesium-credits .cesium-widget-credits'];

/**
 * Follow the attribution line's height in `--credit-line-height`.
 * @param {Document} [doc]
 * @returns {() => void} Stops following it and clears the property.
 */
export function trackCreditLineHeight(doc = globalThis.document) {
  const Observer = doc?.defaultView?.ResizeObserver;
  if (!doc?.documentElement || typeof Observer !== 'function') return () => {};
  const root = doc.documentElement;
  const lines = LINES.map((selector) => doc.querySelector(selector)).filter(
    Boolean,
  );
  if (!lines.length) return () => {};
  const update = () => {
    const height = Math.max(
      0,
      ...lines.map((line) => line.getBoundingClientRect().height),
    );
    if (height > 0)
      root.style.setProperty('--credit-line-height', `${Math.ceil(height)}px`);
    else root.style.removeProperty('--credit-line-height');
  };
  const observer = new Observer(update);
  for (const line of lines) observer.observe(line);
  update();
  return () => {
    observer.disconnect();
    root.style.removeProperty('--credit-line-height');
  };
}
