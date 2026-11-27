import { computed, nextTick, onScopeDispose, watch } from 'vue';

function focusable(element) {
  if (
    !element?.isConnected ||
    typeof element.focus !== 'function' ||
    element.closest('[inert], [hidden], [aria-hidden="true"]')
  )
    return false;
  if (typeof element.checkVisibility === 'function')
    return element.checkVisibility({ visibilityProperty: true });
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  return element.getClientRects().length > 0 && style.visibility === 'visible';
}

/** Keep one Teleport mounted at home and restore focus only after a move. */
export function usePortalSource(portal, content, resolve, { fallback } = {}) {
  const destination = computed(resolve);
  const to = computed(() => destination.value?.el ?? 'body');
  const disabled = computed(() => !destination.value?.el);
  let pending = null;

  watch(destination, (next, previous) => {
    if (next?.el === previous?.el) return;
    const document = content.value?.ownerDocument;
    if (!document) return;
    const active = document.activeElement;
    const focused = content.value.contains(active)
      ? active
      : portal.takeDropped(previous?.name);
    if (!focused || pending) return;
    pending = { focused, name: previous?.name };
    nextTick(() => {
      const move = pending;
      pending = null;
      if (!move || document.activeElement !== document.body) return;
      for (const node of [move.focused, portal.fallbackOf(move.name), fallback?.()]) {
        if (!focusable(node)) continue;
        node.focus({ preventScroll: true });
        if (document.activeElement !== document.body) return;
      }
    });
  });
  onScopeDispose(() => {
    pending = null;
  });

  return { to, disabled };
}
