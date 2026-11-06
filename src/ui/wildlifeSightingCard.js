import { h, nextTick, shallowRef } from 'vue';
import WildlifeSightingCard from './views/panels/WildlifeSightingCard.vue';
import {
  panWildlifeSighting,
  placeWildlifeSightingCard,
  projectWildlifeSighting,
  readWildlifeCardSafeArea,
  WILDLIFE_SELECTED_CARD_WIDTH,
  WILDLIFE_CARD_CHROME_SELECTORS,
} from './wildlifeSightingPlacement.js';

/** Anchor the selected sighting's photo and source link clear of map chrome. */
export function createWildlifeSightingCard({
  layer,
  ui,
  viewer = null,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  now = () => Date.now(),
  project = projectWildlifeSighting,
  pan = panWildlifeSighting,
}) {
  const selected = shallowRef(null);
  const host = documentRef.createElement('div');
  host.dataset.wildlifeSightingCardHost = '';
  Object.assign(host.style, {
    position: 'fixed',
    zIndex: '89',
    display: 'none',
    width: `${WILDLIFE_SELECTED_CARD_WIDTH}px`,
  });
  documentRef.body.append(host);
  let destroyed = false;
  let moving = false;
  let removeFrame = null;
  let returnFocus = null;
  let panForId = null;
  const removers = [];
  const observed = new Set();
  const resizeObserver = windowRef?.ResizeObserver
    ? new windowRef.ResizeObserver(() => position())
    : null;
  const mutationObserver = windowRef?.MutationObserver
    ? new windowRef.MutationObserver(() => position())
    : null;

  const chromeSelector = WILDLIFE_CARD_CHROME_SELECTORS.join(',');
  const structureObserver = windowRef?.MutationObserver
    ? new windowRef.MutationObserver((records) => {
        if (destroyed || !selected.value) return;
        const hasChromeChange = records.some((record) =>
          [...record.addedNodes, ...record.removedNodes].some(
            (node) =>
              node.nodeType === 1 &&
              !host.contains(node) &&
              (node.matches(chromeSelector) ||
                node.querySelector(chromeSelector)),
          ),
        );
        if (!hasChromeChange) return;
        // Newly mounted chrome can cover a previously clear anchor.
        panForId = null;
        position({ allowPan: true });
      })
    : null;

  function observeLayout(elements) {
    const next = new Set(
      [host.firstElementChild, viewer?.scene?.canvas, ...elements].filter(
        Boolean,
      ),
    );
    let changed = false;
    for (const element of observed) {
      if (next.has(element)) continue;
      resizeObserver?.unobserve(element);
      observed.delete(element);
      changed = true;
    }
    for (const element of next) {
      if (observed.has(element)) continue;
      observed.add(element);
      resizeObserver?.observe(element);
      changed = true;
    }
    if (!changed) return;
    mutationObserver?.disconnect();
    for (const element of observed) {
      // Ignore HUD clock/text changes and the card's own positioning styles.
      if (!host.contains(element))
        mutationObserver?.observe(element, {
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden'],
        });
    }
  }

  function position({ allowPan = false } = {}) {
    if (destroyed || !selected.value || !host.firstElementChild) return;
    const point = project(viewer, selected.value, layer);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      host.style.display = 'none';
      return;
    }
    const safe = readWildlifeCardSafeArea({ documentRef, viewer, windowRef });
    observeLayout(safe.elements);
    host.style.width = `${Math.min(WILDLIFE_SELECTED_CARD_WIDTH, safe.bounds.width)}px`;
    host.style.maxHeight = `${safe.bounds.height}px`;
    host.style.display = 'block';
    const rect = host.firstElementChild.getBoundingClientRect();
    const result = placeWildlifeSightingCard(
      point,
      {
        width:
          rect.width ||
          Math.min(WILDLIFE_SELECTED_CARD_WIDTH, safe.bounds.width),
        height:
          rect.height ||
          (selected.value.photo &&
          !selected.value.obscured &&
          selected.value.origin !== 'acartia'
            ? 300
            : 132),
      },
      safe,
    );
    if (!result) {
      host.style.display = 'none';
      return;
    }
    if (
      (result.pan.x || result.pan.y) &&
      allowPan &&
      panForId !== selected.value.stableId
    ) {
      panForId = selected.value.stableId;
      const reduced =
        windowRef?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ===
        true;
      pan(viewer, point, result.anchor, reduced);
    }
    host.style.left = `${result.left}px`;
    host.style.top = `${result.top}px`;
    host.dataset.placement = result.placement;
  }

  const unmount = ui.mount(
    {
      setup: () => () =>
        selected.value
          ? h(WildlifeSightingCard, {
              sighting: selected.value,
              nowMs: now(),
              taxa: layer.getParams?.()?.taxa,
              onClose: () => {
                if (!destroyed) layer.clearSightingSelection();
              },
              onResize: () => position(),
            })
          : null,
    },
    host,
  );

  function restoreFocus() {
    if (returnFocus?.isConnected) returnFocus.focus?.({ preventScroll: true });
    returnFocus = null;
  }
  const unsubscribe = layer.subscribeSelection((row, metadata) => {
    if (destroyed) return;
    const fresh = row?.stableId !== selected.value?.stableId;
    if (row && !selected.value) {
      returnFocus = documentRef.activeElement;
      structureObserver?.observe(documentRef.body, {
        childList: true,
        subtree: true,
      });
    }
    selected.value = row;
    if (!row) {
      host.style.display = 'none';
      panForId = null;
      removeFrame?.();
      removeFrame = null;
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      structureObserver?.disconnect();
      observed.clear();
      restoreFocus();
      return;
    }
    if (fresh) panForId = null;
    nextTick(() => {
      if (destroyed || !selected.value) return;
      position({ allowPan: fresh || metadata?.explicitSelection === true });
      if (moving) startFrameUpdates();
      // Focus the container so keyboard navigation starts inside the card.
      if (fresh)
        host
          .querySelector('[data-wildlife-sighting-card]')
          ?.focus?.({ preventScroll: true });
    });
  });

  const keydown = (event) => {
    if (!selected.value || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    layer.clearSightingSelection();
  };
  const outside = (event) => {
    if (!selected.value || host.contains(event.target)) return;
    // The layer selects on pointer-up; its following click must keep the card open.
    const canvas = viewer?.scene?.canvas;
    if (canvas && (event.target === canvas || canvas.contains?.(event.target)))
      return;
    layer.clearSightingSelection();
  };
  documentRef.addEventListener('keydown', keydown, true);
  documentRef.addEventListener('click', outside, true);
  const onResize = () => position();
  windowRef?.addEventListener('resize', onResize);

  function listen(event, callback) {
    const remove = event?.addEventListener?.(callback);
    if (typeof remove === 'function') removers.push(remove);
    else if (event?.removeEventListener)
      removers.push(() => event.removeEventListener(callback));
  }
  function startFrameUpdates() {
    if (!selected.value || removeFrame) return;
    // Installed only for camera motion; an idle card has zero per-frame work.
    removeFrame =
      viewer?.scene?.preRender?.addEventListener?.(() => position()) || null;
  }
  listen(viewer?.camera?.moveStart, () => {
    moving = true;
    startFrameUpdates();
  });
  listen(viewer?.camera?.moveEnd, () => {
    moving = false;
    removeFrame?.();
    removeFrame = null;
    position();
  });
  listen(viewer?.camera?.changed, () => {
    if (!moving) position();
  });

  return {
    /** Release the card, selection subscription and placement listeners. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe?.();
      for (const remove of removers) remove();
      removeFrame?.();
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      structureObserver?.disconnect();
      documentRef.removeEventListener('keydown', keydown, true);
      documentRef.removeEventListener('click', outside, true);
      windowRef?.removeEventListener('resize', onResize);
      unmount();
      host.remove();
      selected.value = null;
      restoreFocus();
    },
  };
}
