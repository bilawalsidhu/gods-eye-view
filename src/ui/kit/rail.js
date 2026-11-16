/**
 * @typedef {object} UiRailItem
 * @property {string} id Item identity, emitted on selection.
 * @property {string} label Translated name, shown as the tooltip and accessible name.
 * @property {string} icon Material Symbols glyph.
 * @property {boolean} [disabled] Shown but not selectable.
 * @property {boolean} [separatorBefore] Draw a divider above this item.
 * @property {string|number} [badge] Small count or marker on the icon.
 */

/** How long the pointer rests on an item before its tip shows over an open panel. */
export const RAIL_PANEL_OPEN_TOOLTIP_DELAY_MS = 400;
