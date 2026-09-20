/**
 * Own capture-phase Escape and Tab handling while a surface is active.
 * The caller owns visibility, content, initial focus and dismissal policy.
 * This does not make the surface modal or make the rest of the page inert.
 *
 * @param {object} options
 * @param {HTMLElement} options.root Surface containing the keyboard controls.
 * @param {Document} [options.documentRef] Document that dispatches keyboard input.
 * @param {() => boolean} options.isActive Whether this surface may handle input now.
 * @param {() => void} options.onEscape Caller-owned dismissal action.
 * @param {() => HTMLElement} [options.fallbackFocus] Return target if the opener is gone.
 * @returns {{activate: Function, deactivate: Function, destroy: Function}}
 */
export function createSurfaceKeyboard({
  root,
  documentRef = root.ownerDocument,
  isActive,
  onEscape,
  fallbackFocus,
}) {
  let active = false;
  let destroyed = false;
  let previouslyFocused = null;

  const onKeyDown = (event) => {
    // Visibility/arbitration belongs to the screen, including overlays that
    // cover a measurable box. Respect another handler's claim on the same key.
    if (!active || destroyed || !isActive() || event.defaultPrevented) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
      return;
    }
    if (event.key !== 'Tab') return;
    const order = [
      ...root.querySelectorAll(
        'button, input, [href], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter(
      (node) =>
        !node.hasAttribute('disabled') && node.getClientRects().length > 0,
    );
    if (!order.length) return;
    const first = order[0];
    const last = order[order.length - 1];
    const focused = documentRef.activeElement;
    // Allow native scrolling when cycling to an off-screen control in a short
    // surface. Initial focus and return focus use the caller's separate policy.
    if (!root.contains(focused)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && focused === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && focused === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const activate = () => {
    if (destroyed || active) return;
    active = true;
    previouslyFocused = documentRef.activeElement;
    documentRef.addEventListener('keydown', onKeyDown, true);
  };

  const deactivate = ({ restoreFocus = false } = {}) => {
    if (!active) return;
    active = false;
    documentRef.removeEventListener('keydown', onKeyDown, true);
    const target = previouslyFocused;
    previouslyFocused = null;
    if (!restoreFocus) return;
    if (typeof target?.focus === 'function' && target.isConnected) {
      target.focus({ preventScroll: true });
    } else {
      fallbackFocus?.()?.focus?.({ preventScroll: true });
    }
  };

  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    deactivate();
  };

  return { activate, deactivate, destroy };
}
