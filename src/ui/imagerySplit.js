import { onLocaleChange } from '../i18n/index.js';
import { useImagerySplitStore } from './stores/imagerySplit.js';
import { applicationPinia } from './vueRuntime.js';

let splitCount = 0;
const HANDLE_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

function clampUnit(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function defaultViewportWidth() {
  return (
    Number(document.documentElement?.clientWidth) ||
    Number(globalThis.window?.innerWidth) ||
    0
  );
}

// A title or label given as a function is worded when published.
const worded = (text) => (typeof text === 'function' ? text() : text);

function defaultValueText(beforePercent, afterPercent) {
  return `A ${beforePercent} percent, B ${afterPercent} percent`;
}

/**
 * Split divider for before/after imagery comparison.
 *
 * Owns the divider's value, pointer capture, keyboard, ARIA, a CSS custom
 * property and scene.splitPosition, and publishes the line to the imagery
 * split store, where the ImagerySplitView renders it as a child of the body.
 * `setValue` is the owner's own write and never echoes through `onChange`;
 * `onChange` reports pointer and keyboard changes so the owner can mirror
 * them, and `requestRender` fires whenever the clamped value actually
 * changes. `destroy` is idempotent: it withdraws the line, clears the CSS
 * property and restores the scene split captured at creation once. The
 * titles and label may be functions, which are called again after a locale
 * change, like `formatValueText`.
 */
export function createImagerySplit({
  scene,
  initialValue = 0.5,
  id,
  handleClass,
  cssTarget = document.documentElement,
  cssProperty,
  beforeLabel = 'A',
  afterLabel = 'B',
  beforeTitle,
  afterTitle,
  ariaLabel,
  formatValueText = defaultValueText,
  getViewportWidth = defaultViewportWidth,
  onChange,
  requestRender,
  store = useImagerySplitStore(applicationPinia()),
} = {}) {
  const key = ++splitCount;
  const restoreValue = scene ? (scene.splitPosition ?? null) : null;
  let value = null;
  let cssValue = null;
  let hidden = false;
  let dragging = false;
  let pointerId = null;
  // The handle that holds the drag's pointer capture.
  let captor = null;
  let destroyed = false;

  function publish() {
    if (destroyed) return;
    const beforePercent = Math.round(value * 100);
    store.publish(
      key,
      {
        id: id ?? null,
        hidden,
        handleClass: handleClass ?? null,
        beforeLabel,
        afterLabel,
        beforeTitle: worded(beforeTitle) ?? null,
        afterTitle: worded(afterTitle) ?? null,
        ariaLabel: worded(ariaLabel) ?? null,
        valueNow: beforePercent,
        valueText: formatValueText(beforePercent, 100 - beforePercent),
      },
      controls,
    );
  }

  function apply(next, { notify = false, render = true } = {}) {
    const clamped = clampUnit(next);
    const changed = clamped !== value;
    value = clamped;
    if (scene && scene.splitPosition !== value) scene.splitPosition = value;
    const css = `${value * 100}%`;
    if (cssProperty && cssValue !== css) {
      cssTarget.style.setProperty(cssProperty, css);
      cssValue = css;
    }
    if (changed) publish();
    if (changed && render) requestRender?.();
    if (changed && notify) onChange?.(value);
    return changed;
  }

  function setFromClientX(clientX) {
    const viewportWidth = Number(getViewportWidth()) || 0;
    if (viewportWidth <= 0 || !Number.isFinite(Number(clientX))) return;
    apply(Number(clientX) / viewportWidth, { notify: true });
  }

  // The view's handle reports its input here.
  const controls = {
    pointerdown(event) {
      if (destroyed) return;
      if (event.button != null && event.button !== 0) return;
      event.preventDefault?.();
      dragging = true;
      pointerId = event.pointerId ?? null;
      captor = event.currentTarget ?? null;
      captor?.setPointerCapture?.(event.pointerId);
      setFromClientX(event.clientX);
    },
    pointermove(event) {
      if (!dragging) return;
      if (pointerId != null && event.pointerId !== pointerId) return;
      event.preventDefault?.();
      setFromClientX(event.clientX);
    },
    pointerup(event) {
      if (!dragging) return;
      if (pointerId != null && event.pointerId !== pointerId) return;
      captor?.releasePointerCapture?.(event.pointerId);
      dragging = false;
      pointerId = null;
      captor = null;
    },
    keydown(event) {
      if (destroyed || !HANDLE_KEYS.has(event.key)) return;
      event.preventDefault?.();
      const step = event.shiftKey ? 0.05 : 0.01;
      if (event.key === 'Home') apply(0, { notify: true });
      else if (event.key === 'End') apply(1, { notify: true });
      else
        apply(value + (event.key === 'ArrowRight' ? step : -step), {
          notify: true,
        });
    },
  };

  apply(initialValue, { render: false });
  const offLocale = onLocaleChange(publish);

  return {
    getValue() {
      return value;
    },
    setValue(next) {
      if (destroyed) return false;
      return apply(next);
    },
    setVisible(visible) {
      if (hidden === !visible) return;
      hidden = !visible;
      publish();
    },
    destroy() {
      if (destroyed) return;
      if (dragging && pointerId != null)
        captor?.releasePointerCapture?.(pointerId);
      dragging = false;
      pointerId = null;
      captor = null;
      destroyed = true;
      offLocale();
      store.withdraw(key);
      if (cssProperty) cssTarget.style.removeProperty(cssProperty);
      if (scene && restoreValue != null) scene.splitPosition = restoreValue;
    },
  };
}
