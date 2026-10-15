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

function defaultValueText(beforePercent, afterPercent) {
  return `A ${beforePercent} percent, B ${afterPercent} percent`;
}

/**
 * Split divider for before/after imagery comparison.
 *
 * Owns the DOM line + handle, pointer capture, keyboard, ARIA, a CSS custom
 * property and scene.splitPosition. `setValue` is the owner's own write and
 * never echoes through `onChange`; `onChange` reports pointer and keyboard
 * changes so the owner can mirror them, and `requestRender` fires whenever
 * the clamped value actually changes. `destroy` is idempotent: it removes the
 * listeners and line, clears the CSS property and restores the scene split
 * captured at creation once.
 */
export function createImagerySplit({
  scene,
  parent = document.body,
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
} = {}) {
  const restoreValue = scene ? (scene.splitPosition ?? null) : null;
  const line = document.createElement('div');
  if (id) line.id = id;
  const before = document.createElement('span');
  const after = document.createElement('span');
  const handle = document.createElement('button');
  before.className = 'before';
  after.className = 'after';
  before.textContent = beforeLabel;
  if (beforeTitle != null) before.title = beforeTitle;
  after.textContent = afterLabel;
  if (afterTitle != null) after.title = afterTitle;
  handle.type = 'button';
  if (handleClass) handle.className = handleClass;
  handle.setAttribute('role', 'slider');
  if (ariaLabel != null) handle.setAttribute('aria-label', ariaLabel);
  handle.setAttribute('aria-valuemin', '0');
  handle.setAttribute('aria-valuemax', '100');
  handle.setAttribute('aria-orientation', 'horizontal');
  handle.textContent = '↔';

  let value = null;
  let cssValue = null;
  let dragging = false;
  let pointerId = null;
  let destroyed = false;

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
    const beforePercent = Math.round(value * 100);
    handle.setAttribute('aria-valuenow', String(beforePercent));
    handle.setAttribute(
      'aria-valuetext',
      formatValueText(beforePercent, 100 - beforePercent),
    );
    if (changed && render) requestRender?.();
    if (changed && notify) onChange?.(value);
    return changed;
  }

  function setFromClientX(clientX) {
    const viewportWidth = Number(getViewportWidth()) || 0;
    if (viewportWidth <= 0 || !Number.isFinite(Number(clientX))) return;
    apply(Number(clientX) / viewportWidth, { notify: true });
  }

  function handlePointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault?.();
    dragging = true;
    pointerId = event.pointerId ?? null;
    handle.setPointerCapture?.(event.pointerId);
    setFromClientX(event.clientX);
  }

  function handlePointerMove(event) {
    if (!dragging) return;
    if (pointerId != null && event.pointerId !== pointerId) return;
    event.preventDefault?.();
    setFromClientX(event.clientX);
  }

  function finishPointerDrag(event) {
    if (!dragging) return;
    if (pointerId != null && event.pointerId !== pointerId) return;
    handle.releasePointerCapture?.(event.pointerId);
    dragging = false;
    pointerId = null;
  }

  function handleKeyDown(event) {
    if (!HANDLE_KEYS.has(event.key)) return;
    event.preventDefault?.();
    const step = event.shiftKey ? 0.05 : 0.01;
    if (event.key === 'Home') apply(0, { notify: true });
    else if (event.key === 'End') apply(1, { notify: true });
    else
      apply(value + (event.key === 'ArrowRight' ? step : -step), {
        notify: true,
      });
  }

  const listeners = [
    ['pointerdown', handlePointerDown],
    ['pointermove', handlePointerMove],
    ['pointerup', finishPointerDrag],
    ['pointercancel', finishPointerDrag],
    ['keydown', handleKeyDown],
  ];
  for (const [type, listener] of listeners)
    handle.addEventListener(type, listener);
  line.append(before, handle, after);
  parent.appendChild(line);
  apply(initialValue, { render: false });

  return {
    getValue() {
      return value;
    },
    setValue(next) {
      if (destroyed) return false;
      return apply(next);
    },
    setVisible(visible) {
      line.hidden = !visible;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (dragging && pointerId != null)
        handle.releasePointerCapture?.(pointerId);
      dragging = false;
      pointerId = null;
      for (const [type, listener] of listeners)
        handle.removeEventListener?.(type, listener);
      line.remove();
      if (cssProperty) cssTarget.style.removeProperty(cssProperty);
      if (scene && restoreValue != null) scene.splitPosition = restoreValue;
    },
  };
}
