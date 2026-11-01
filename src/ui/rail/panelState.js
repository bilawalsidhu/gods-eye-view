import { watch } from 'vue';
import { usePanelChromeStore } from '../stores/panelChrome.js';

/** The classes a panel's state draws on its root. */
const CLASSES = Object.freeze({
  collapsed: (state) => state.collapsed,
  'dock-pinned': (state) => state.pinned,
  'dock-pinned-top': (state) => state.pinnedTop,
  'layout-auto-collapsed': (state) => state.auto === 'layout',
  'accordion-collapsed': (state) => state.auto === 'accordion',
});

/**
 * Draw `state` on a panel's root with `classList`, leaving other classes.
 * @param {Element} el
 * @param {import('../stores/panelChrome.js').PanelState} state
 */
export function applyPanelState(el, state) {
  for (const [name, on] of Object.entries(CLASSES))
    if (el.classList.contains(name) !== on(state))
      el.classList.toggle(name, on(state));
}

/**
 * Keep `el` drawing the state `store` holds for `panelId`, synchronously:
 * the panel layouts measure a panel in the same task that opens or closes
 * it. Until the panel is presented its markup's classes stand.
 * @returns {() => void} Stops following the store.
 */
export function followPanelState(store, panelId, el) {
  return watch(
    () => store.panels[panelId],
    (state) => state && applyPanelState(el, state),
    { flush: 'sync', immediate: true },
  );
}

/**
 * `v-panel-state="'data-panel'"`: the panel root draws its open, pinned and
 * layout-collapsed state from the panel chrome store.
 */
export const vPanelState = {
  mounted(el, binding) {
    const store = usePanelChromeStore(binding.instance.$pinia);
    el._panelStateStore = store;
    el._stopPanelState = followPanelState(store, binding.value, el);
  },
  // A re-render that rewrites the root's class (its class binding changed)
  // would restore the markup's state; draw the presented state again.
  updated(el, binding) {
    const state = el._panelStateStore?.panels[binding.value];
    if (state) applyPanelState(el, state);
  },
  beforeUnmount(el) {
    el._stopPanelState?.();
  },
};

/**
 * Whether the person keeps a panel closed, as share links record it: a
 * collapse a layout applied only for space still counts as open.
 * @param {import('../stores/panelChrome.js').PanelState} state
 */
export function prefersCollapsed(state) {
  return state.collapsed && !state.auto;
}

/**
 * A panel's state as its classes draw it: the markup's state, before its
 * owner first presents the panel.
 * @param {Element} el
 * @returns {import('../stores/panelChrome.js').PanelState}
 */
export function readPanelState(el) {
  const has = (name) => el.classList.contains(name);
  return {
    collapsed: has('collapsed'),
    pinned: has('dock-pinned'),
    pinnedTop: has('dock-pinned-top'),
    auto: has('layout-auto-collapsed')
      ? 'layout'
      : has('accordion-collapsed')
        ? 'accordion'
        : null,
  };
}
