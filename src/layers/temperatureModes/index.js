import { msg, t } from '../../i18n/index.js';

/** Display modes, in panel order; each names the controller that draws it. */
export const TEMPERATURE_MODES = Object.freeze([
  Object.freeze({ id: 'land', owner: 'land', label: msg('Land surface') }),
  Object.freeze({ id: 'sst', owner: 'ocean', label: msg('Sea surface') }),
  Object.freeze({ id: 'anomaly', owner: 'ocean', label: msg('Sea anomaly') }),
  Object.freeze({ id: 'air', owner: 'air', label: msg('Air (2 m)') }),
]);
const MODE_IDS = TEMPERATURE_MODES.map(({ id }) => id);
const OCEAN_PARAMS = ['date', 'step', 'latest', 'showNino34'];
const POINTER_PARAMS = ['inspect', 'pick', 'point'];

/**
 * The land controller (#875's monthly playback) drives its own on-map timeline
 * and has no layer-row card, so the card shows its status under the picker.
 */
function landControls(land) {
  const stats = land.getStats();
  return {
    chips: [],
    summary: {
      label: t('Land surface temperature · monthly mean'),
      coverage: stats.coverage ? t(stats.coverage) : undefined,
      status: stats.statusMessage ? t(stats.statusMessage) : null,
      settings: [],
    },
  };
}

/**
 * One Temperature layer over the land (MODIS), ocean (MUR25) and air (GFS)
 * controllers. Exactly one controller is enabled at a time; the others stay
 * initialised but idle, so switching modes never stacks two colour fields.
 */
export function createTemperatureLayer({ land, air, ocean } = {}) {
  if (!land || !air || !ocean)
    throw new TypeError('Temperature requires land, air and ocean controllers');
  const children = { land, air, ocean };
  let mode = 'land';
  let enabled = false;
  let viewer = null;
  let listener = null;
  const notify = () => listener?.();
  const ownerOf = (id) => TEMPERATURE_MODES.find((m) => m.id === id).owner;
  const active = () => children[ownerOf(mode)];
  const pick = (params, keys) =>
    Object.fromEntries(
      keys.filter((k) => k in params).map((k) => [k, params[k]]),
    );

  function setMode(next) {
    if (!MODE_IDS.includes(next) || next === mode) return;
    const before = ownerOf(mode);
    const after = ownerOf(next);
    mode = next;
    if (after === 'ocean') ocean.setParams({ mode: next });
    if (before === after) return;
    if (enabled) {
      children[before].disable();
      children[after].enable();
      void children[after].update(viewer);
    }
  }

  function modeChips() {
    return TEMPERATURE_MODES.map(({ id, label }) => ({
      id: `mode-${id}`,
      label: t(label),
      active: id === mode,
      params: { mode: id },
    }));
  }

  /** The active controller's card, under one title with the mode picker first. */
  function panelControls() {
    const controls =
      ownerOf(mode) === 'land'
        ? landControls(land)
        : active().getPanelControls();
    const chips = modeChips();
    const own = new Set(['anomaly', 'sst']);
    const summary = controls.summary ?? {};
    return {
      ...controls,
      chips: [
        ...chips,
        ...(controls.chips ?? []).filter(({ id }) => !own.has(id)),
      ],
      summary: {
        ...summary,
        label: t('Temperature'),
        settings: [
          { id: 'mode', label: t('SHOW'), chips },
          ...(summary.settings ?? []).filter(({ id }) => id !== 'mode'),
        ],
      },
    };
  }

  const layer = {
    id: 'temperature',
    name: 'Temperature',
    icon: '◐',
    source: 'NASA GIBS · NOAA GFS',
    statsRefreshInterval: 2000,
    updateInterval: 3600_000,
    init(nextViewer) {
      viewer = nextViewer;
      land.init(nextViewer);
      air.init(nextViewer);
      ocean.init(nextViewer);
    },
    attachShellServices(services) {
      air.attachShellServices?.(services);
      ocean.attachShellServices?.(services);
    },
    enable() {
      enabled = true;
      active().enable();
    },
    disable() {
      enabled = false;
      land.disable();
      air.disable();
      ocean.disable();
      notify();
    },
    update(nextViewer, options) {
      if (nextViewer) viewer = nextViewer;
      return active().update(nextViewer, options);
    },
    setParams(params = {}) {
      setMode(params.mode);
      if (['°C', '°F'].includes(params.units))
        air.setParams({ units: params.units });
      const forOcean = pick(params, OCEAN_PARAMS);
      if (Object.keys(forOcean).length) ocean.setParams(forOcean);
      const forPointer = pick(params, POINTER_PARAMS);
      if (Object.keys(forPointer).length) active().setParams?.(forPointer);
      notify();
    },
    getParams() {
      const { date, showNino34 } = ocean.getParams();
      return { mode, units: air.getParams().units, date, showNino34 };
    },
    getPanelControls: panelControls,
    getRowControls: panelControls,
    setRowControlsListener(next) {
      listener = typeof next === 'function' ? next : null;
      air.setRowControlsListener(listener);
      ocean.setRowControlsListener(listener);
    },
    getStats() {
      return active().getStats();
    },
    getDiagnostics() {
      return active().getDiagnostics?.() ?? {};
    },
    destroy() {
      layer.disable();
      land.destroy(viewer);
      air.destroy();
      ocean.destroy();
      viewer = listener = null;
    },
  };
  return layer;
}
