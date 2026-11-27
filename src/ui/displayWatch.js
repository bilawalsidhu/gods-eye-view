/**
 * Follow whether an element is displayed: whether it has a layout box, which
 * it lacks inside a collapsed or hidden panel (`display: none`). A surface
 * that repaints on every change can skip painting while its element is not
 * displayed and paint once when it is displayed again.
 *
 * The element counts as displayed until its first size report, and always
 * where ResizeObserver is unavailable, so nothing is ever left unpainted on
 * a guess. A ResizeObserver reports before the browser paints, so `onShown`
 * runs before the element is seen again.
 * @param {Element | null | undefined} element
 * @param {() => void} onShown Called each time the element is displayed again.
 *
 * `assumeShown()` counts the element displayed now, for a surface that has
 * just painted because its panel is being shown, and asks the observer for a
 * fresh report, so the next one corrects it if the element is not displayed
 * after all.
 * @returns {{ shown: () => boolean, assumeShown: () => void, disconnect: () => void }}
 */
export function watchDisplayed(element, onShown) {
  const Observer = globalThis.ResizeObserver;
  if (!element || typeof Observer !== 'function')
    return { shown: () => true, assumeShown() {}, disconnect() {} };
  let shown = true;
  let connected = true;
  const observer = new Observer((entries) => {
    if (!connected) return;
    const entry = entries.at(-1);
    if (!entry) return;
    const { width, height } = entry.contentRect;
    const next = width > 0 || height > 0;
    if (next === shown) return;
    shown = next;
    if (shown) onShown();
  });
  observer.observe(element);
  return {
    shown: () => shown,
    assumeShown() {
      if (!connected) return;
      shown = true;
      // Observing anew reports the element's size again, whatever it is.
      observer.unobserve(element);
      observer.observe(element);
    },
    disconnect() {
      connected = false;
      observer.disconnect();
    },
  };
}
