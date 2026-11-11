import { msg } from '../i18n/index.js';

/** Class of the element each side stack hosts its rail in. */
export const PANEL_RAIL_HOST_CLASS = 'gev-panel-rail';

/** Glyph for a panel without a catalog entry, such as one a host adds. */
export const PANEL_RAIL_FALLBACK_ICON = 'more_horiz';

/**
 * How each side panel appears on its rail. Labels are the panels' own titles.
 * `shownBy` names a class the panel needs to be shown at all (`f` toggles
 * Data Layers' `active`).
 */
export const PANEL_RAIL_ITEMS = Object.freeze({
  'data-panel': {
    icon: 'layers',
    label: msg('DATA LAYERS'),
    shownBy: 'active',
  },
  'utilities-panel': { icon: 'handyman', label: msg('UTILITIES') },
  'scene-panel': { icon: 'movie', label: msg('AUTHORING') },
  'pp-toggles': { icon: 'tune', label: msg('DISPLAY') },
  'cctv-panel': { icon: 'videocam', label: msg('CCTV') },
  'weather-panel': { icon: 'partly_cloudy_day', label: msg('WEATHER') },
  'news-panel': { icon: 'public', label: msg('NEWS') },
  'recent-imagery-panel': {
    icon: 'satellite_alt',
    label: msg('RECENT IMAGERY'),
  },
  'street-level-panel': { icon: 'streetview', label: msg('STREET LEVEL') },
  'global-context-panel': { icon: 'radar', label: msg('CONTEXT') },
});

/**
 * Whether a mutation happened inside a panel rail, which no stack layout or
 * panel state depends on.
 * @param {MutationRecord} record Observed mutation.
 */
export function isPanelRailMutation(record) {
  const target =
    record.target.nodeType === 1 ? record.target : record.target.parentElement;
  return Boolean(target?.closest?.(`.${PANEL_RAIL_HOST_CLASS}`));
}
