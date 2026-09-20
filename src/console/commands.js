/**
 * The command registry behind the console palette.
 *
 * Commands are built from live application state on every open, so the list
 * can never offer a layer the catalog has dropped or claim a panel exists
 * that the document does not carry. Each command delegates to the owner of
 * the behaviour — nothing here changes the scene directly.
 */

import { titleizeIdentifier } from './format.js';

/** Visual presets, in the order the dock presents them. */
export const VISUAL_PRESETS = Object.freeze([
  { id: 'normal', label: 'Normal', hint: '1' },
  { id: 'retro', label: 'CRT', hint: '2' },
  { id: 'surveillance', label: 'Night Vision', hint: '3' },
  { id: 'thermal', label: 'Thermal', hint: '4' },
  { id: 'anime', label: 'Anime', hint: '5' },
  { id: 'noir', label: 'Noir', hint: '6' },
  { id: 'snow', label: 'Snow', hint: '7' },
]);

/** Panels the module rail exposes, with the label the rail shows. */
export const CONSOLE_MODULES = Object.freeze([
  { panelId: 'data-panel', label: 'Data Layers' },
  { panelId: 'pp-toggles', label: 'Display Controls' },
  { panelId: 'control-panel', label: 'Visual Presets' },
  { panelId: 'location-bar', label: 'Location' },
  { panelId: 'cctv-panel', label: 'Cameras' },
  { panelId: 'radio-panel', label: 'Radio' },
  { panelId: 'scene-panel', label: 'Scenes' },
  { panelId: 'global-context-panel', label: 'Context' },
]);

const SECTION_ORDER = Object.freeze([
  'NAVIGATE',
  'FEEDS',
  'VISUAL',
  'MODULES',
  'CONSOLE',
]);

function sectionRank(section) {
  const index = SECTION_ORDER.indexOf(section);
  return index === -1 ? SECTION_ORDER.length : index;
}

/**
 * Build the palette's command list from current state.
 *
 * @param {object} context
 * @param {Array<object>} [context.layers] Normalized layer roster.
 * @param {Array<object>} [context.places] `{ id, name }` camera presets.
 * @param {string} [context.activeStyle] Visual preset currently applied.
 * @param {(panelId:string)=>boolean} [context.isPanelOpen]
 * @param {object} context.actions Handlers the console owns.
 * @returns {Array<object>} Command descriptors in section order.
 */
export function buildCommands({
  layers = [],
  places = [],
  activeStyle = 'normal',
  isPanelOpen = () => false,
  actions = {},
} = {}) {
  const commands = [];

  for (const place of places) {
    if (!place?.id) continue;
    commands.push({
      id: `place:${place.id}`,
      section: 'NAVIGATE',
      title: place.name || titleizeIdentifier(place.id),
      subtitle: 'Fly the camera to this location',
      keywords: ['fly', 'go', 'goto', 'city', place.id],
      run: () => actions.flyToPlace?.(place.id),
    });
  }

  for (const layer of layers) {
    if (!layer?.id) continue;
    const on = Boolean(layer.enabled);
    commands.push({
      id: `layer:${layer.id}`,
      section: 'FEEDS',
      title: `${on ? 'Disable' : 'Enable'} ${layer.name}`,
      subtitle: layer.keyRequired
        ? 'Needs a provider key before it can load'
        : on
          ? 'Currently streaming'
          : 'Currently off',
      state: on ? 'ON' : 'OFF',
      disabled: layer.keyRequired && !on,
      keywords: ['layer', 'feed', 'toggle', layer.id],
      run: () => actions.setLayerEnabled?.(layer.id, !on),
    });
  }

  for (const preset of VISUAL_PRESETS) {
    commands.push({
      id: `style:${preset.id}`,
      section: 'VISUAL',
      title: `Visual preset — ${preset.label}`,
      subtitle: preset.id === activeStyle ? 'Applied' : 'Apply this treatment',
      state: preset.id === activeStyle ? 'ACTIVE' : '',
      hint: preset.hint,
      keywords: ['style', 'preset', 'visual', 'filter', preset.id],
      run: () => actions.applyStyle?.(preset.id),
    });
  }

  for (const module of CONSOLE_MODULES) {
    const open = isPanelOpen(module.panelId);
    commands.push({
      id: `panel:${module.panelId}`,
      section: 'MODULES',
      title: `${open ? 'Close' : 'Open'} ${module.label}`,
      subtitle: 'Module panel',
      state: open ? 'OPEN' : '',
      keywords: ['panel', 'module', 'open', 'close', module.panelId],
      run: () => actions.togglePanel?.(module.panelId),
    });
  }

  const systemCommands = [
    {
      id: 'system:globe',
      title: 'Reset to full globe view',
      keywords: ['globe', 'home', 'reset', 'zoom out'],
      run: () => actions.resetGlobe?.(),
    },
    {
      id: 'system:north',
      title: 'Point the camera north up',
      keywords: ['north', 'bearing', 'compass', 'orient'],
      run: () => actions.northUp?.(),
    },
    {
      id: 'system:tilt',
      title: 'Toggle the oblique camera tilt',
      keywords: ['tilt', 'oblique', 'pitch', 'top down'],
      run: () => actions.toggleTilt?.(),
    },
    {
      id: 'system:clear',
      title: 'Turn off every selected data layer',
      keywords: ['clear', 'reset', 'layers', 'off'],
      run: () => actions.clearLayers?.(),
    },
    {
      id: 'system:share',
      title: 'Copy a share link for this view',
      keywords: ['share', 'link', 'copy', 'url'],
      run: () => actions.share?.(),
    },
    {
      id: 'system:dossier',
      title: 'Open the intelligence dossier',
      keywords: ['dossier', 'analyst', 'ai', 'feeds', 'log'],
      run: () => actions.openDossier?.(),
    },
    {
      id: 'system:classic',
      title: 'Stand down the console (classic interface)',
      keywords: ['classic', 'exit', 'console', 'hide', 'off'],
      run: () => actions.standDown?.(),
    },
  ];
  for (const command of systemCommands) {
    commands.push({ section: 'CONSOLE', subtitle: 'Console', ...command });
  }

  return commands;
}

/** Lowercase a command into one searchable haystack. */
function haystack(command) {
  return [command.title, command.subtitle, ...(command.keywords || [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Score a query against a haystack.
 *
 * Three tiers, highest first: the words start with the query, the haystack
 * contains it, or its letters appear in order. An unmatched query scores 0 so
 * the caller can drop it without a second pass.
 * @returns {number} 0 when the query does not match at all.
 */
export function scoreMatch(text, query) {
  if (!query) return 1;
  const target = String(text || '');
  const needle = query.toLowerCase().trim();
  if (!needle) return 1;
  const index = target.indexOf(needle);
  if (index === 0) return 1000;
  if (index > 0) {
    const wordStart = index > 0 && /[\s\-_/]/.test(target[index - 1]);
    return wordStart ? 800 - index : 500 - index;
  }
  let cursor = 0;
  let spread = 0;
  for (const character of needle) {
    const found = target.indexOf(character, cursor);
    if (found === -1) return 0;
    spread += found - cursor;
    cursor = found + 1;
  }
  return Math.max(1, 200 - spread);
}

/**
 * Rank commands for a query.
 * Stable: equal scores keep registry order, so an empty query renders the
 * sections in the order they were built.
 * @param {Array<object>} commands
 * @param {string} query
 * @param {number} [limit] Maximum rows to return.
 * @returns {Array<object>} Matching commands, best first.
 */
export function filterCommands(commands, query, limit = 40) {
  const entries = [];
  const trimmed = String(query || '').trim();
  for (const [index, command] of (commands || []).entries()) {
    const score = scoreMatch(haystack(command), trimmed);
    if (!score) continue;
    entries.push({ command, index, score });
  }
  entries.sort((a, b) => {
    if (!trimmed) {
      const section =
        sectionRank(a.command.section) - sectionRank(b.command.section);
      if (section) return section;
    } else if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });
  return entries.slice(0, limit).map((entry) => entry.command);
}
