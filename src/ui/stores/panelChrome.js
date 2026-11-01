import { defineStore } from 'pinia';
import { shallowRef } from 'vue';

/**
 * @typedef {object} PanelChromeHandlers
 * @property {(panelId: string) => void} toggle A collapse button's click.
 * @property {(panelId: string) => void} pin A dock pin button's click.
 */

/**
 * @typedef {object} PanelState
 * @property {boolean} collapsed Whether the panel is closed, by the person or
 *   by its layout.
 * @property {boolean} pinned A dock tray kept open (`dock-pinned`).
 * @property {boolean} pinnedTop The pinned tray drawn on top.
 * @property {?('layout'|'accordion')} auto Why a layout closed the panel
 *   (`layout-auto-collapsed`, `accordion-collapsed`), or null when the
 *   person's own choice stands.
 */

/** A panel's state before its owner has said otherwise. */
const BLANK = Object.freeze({
  collapsed: false,
  pinned: false,
  pinnedTop: false,
  auto: null,
});

/**
 * Each panel's disclosure state, which its root (`vPanelState`) and its
 * collapse, dock and pin buttons render. PanelChrome owns the panels: it and
 * the layouts it runs publish here whenever a panel opens, closes or is
 * pinned, and it connects the buttons' clicks; the views only render and
 * forward clicks.
 */
export const usePanelChromeStore = defineStore('gev-panel-chrome', () => {
  /**
   * `{[panelId]: PanelState}`, frozen; a panel is absent until its owner
   * first presents it, and it keeps its markup's classes until then.
   */
  const panels = shallowRef(Object.freeze({}));
  /** @type {{handlers: PanelChromeHandlers}|null} */
  let owner = null;

  /**
   * Present the panels for an owner, replacing any earlier owner. The
   * buttons start from the new owner's states, not the last owner's.
   * @param {PanelChromeHandlers} handlers
   * @returns {object} Token for publish() and detach().
   */
  function connect(handlers) {
    owner = { handlers };
    panels.value = Object.freeze({});
    return owner;
  }

  /** @returns {boolean} Whether `token` is the owner presenting now. */
  function owns(token) {
    return !!token && token === owner;
  }

  /**
   * Merge `patch` into a panel's state for the owner holding `token`; an
   * unchanged state is not republished.
   * @param {object} token
   * @param {string} panelId
   * @param {Partial<PanelState>} patch
   */
  function publish(token, panelId, patch) {
    if (!owns(token) || !panelId) return;
    const prior = panels.value[panelId];
    const next = { ...BLANK, ...prior, ...patch };
    if (prior && Object.keys(BLANK).every((key) => prior[key] === next[key]))
      return;
    panels.value = Object.freeze({
      ...panels.value,
      [panelId]: Object.freeze(next),
    });
  }

  /**
   * Stop forwarding clicks for the owner holding `token`; the buttons keep
   * the last state it presented. A later owner is left alone.
   */
  function detach(token) {
    if (token === owner) owner = null;
  }

  /**
   * Forward a button's click to the owner, if one is connected.
   * @param {keyof PanelChromeHandlers} name
   * @param {string} panelId
   */
  function act(name, panelId) {
    owner?.handlers[name]?.(panelId);
  }

  return { panels, connect, owns, publish, detach, act };
});
