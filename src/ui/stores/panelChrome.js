import { defineStore } from 'pinia';
import { shallowRef } from 'vue';

/**
 * @typedef {object} PanelChromeHandlers
 * @property {(panelId: string) => void} toggle A collapse button's click.
 * @property {(panelId: string) => void} pin A dock pin button's click.
 */

/**
 * Each panel's disclosure state as its collapse, dock and pin buttons render
 * it. PanelChrome owns the panels: it publishes here whenever a panel opens,
 * closes or is pinned, and connects the buttons' clicks; the views only render
 * and forward clicks.
 */
export const usePanelChromeStore = defineStore('gev-panel-chrome', () => {
  /**
   * `{[panelId]: {collapsed, pinned}}`, frozen; a panel is absent until its
   * owner first presents it, and its buttons keep their markup until then.
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
   * @param {{collapsed?: boolean, pinned?: boolean}} patch
   */
  function publish(token, panelId, patch) {
    if (!owns(token) || !panelId) return;
    const prior = panels.value[panelId];
    const next = { collapsed: false, pinned: false, ...prior, ...patch };
    if (
      prior &&
      prior.collapsed === next.collapsed &&
      prior.pinned === next.pinned
    )
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
