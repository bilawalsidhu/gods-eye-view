import { defineStore } from 'pinia';
import { reactive } from 'vue';

/**
 * @typedef {object} RailPanel
 * @property {string} id Panel element id.
 * @property {string} title The panel's translated title.
 * @property {boolean} open Whether the panel is expanded.
 * @property {boolean} available Whether the panel is offered (not `hidden`).
 */

const samePanels = (a, b) =>
  a.length === b.length &&
  a.every(
    (panel, index) =>
      panel.id === b[index].id &&
      panel.title === b[index].title &&
      panel.open === b[index].open &&
      panel.available === b[index].available,
  );

/**
 * The desktop side panels as the rails present them. Panel disclosure stays
 * with PanelChrome; this store publishes each side's panels in order.
 */
export const usePanelStore = defineStore('gev-panels', () => {
  /** @type {{left: RailPanel[], right: RailPanel[]}} */
  const sides = reactive({ left: [], right: [] });

  /**
   * Replace one side's panels, keeping the array when nothing changed.
   * @param {'left'|'right'} side Sidebar.
   * @param {RailPanel[]} panels Panels in display order.
   */
  function setSide(side, panels) {
    if (!samePanels(sides[side], panels)) sides[side] = panels;
  }

  /**
   * @param {'left'|'right'} side Sidebar.
   * @returns {string|null} The open panel's id.
   */
  function openPanelId(side) {
    return (
      sides[side].find((panel) => panel.open && panel.available)?.id ?? null
    );
  }

  /** @param {string} id Panel id. */
  function isOpen(id) {
    return [...sides.left, ...sides.right].some(
      (panel) => panel.id === id && panel.open,
    );
  }

  return { sides, setSide, openPanelId, isOpen };
});
