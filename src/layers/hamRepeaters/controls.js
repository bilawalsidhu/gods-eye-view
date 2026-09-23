import { REPEATER_COLORS, formatAge } from '../../sources/hamRepeaters.js';
import {
  GATE_GUIDANCE,
  HAM_REPEATERS_LAYER_ID,
  REACHABILITY_NOTE,
} from './policy.js';

export function createControls({ state: layerState, parts }) {
  function kindChip(id, label) {
    return {
      id: `kind-${id}`,
      label,
      title: `Show ${id === 'all' ? 'FM and D-STAR' : id} repeaters`,
      active: layerState._filter.kind === id,
      disabled: !layerState._enabled,
      onClick: () => parts.queries.setFilter({ kind: id }),
    };
  }

  function statusLine() {
    const parts_ = [];
    if (layerState._area) {
      const label = parts.presentation.getUIState().areaLabel;
      if (label) parts_.push(label);
    }
    if (layerState._lastLoad?.at && layerState._lastLoad.count !== undefined)
      parts_.push(
        `${layerState._lastLoad.count} loaded ${formatAge(layerState._lastLoad.at)} ago`,
      );
    if (layerState._enabled && !layerState._gate.withinGate)
      parts_.push(
        Number.isFinite(layerState._gate.heightM)
          ? `auto-load below ${Math.round(layerState._gate.gateM / 1000)} km (now ${Math.round(layerState._gate.heightM / 1000)} km)`
          : GATE_GUIDANCE,
      );
    if (layerState._partial) {
      const failed = Object.keys(layerState._errors).join(', ');
      parts_.push(`${failed || 'one feed'} did not answer`);
    }
    if (layerState._stale) parts_.push('cached answer');
    if (layerState._error) parts_.push(layerState._error);
    return parts_.join(' · ');
  }

  const methods = {
    id: HAM_REPEATERS_LAYER_ID,

    name: 'Repeaters',

    icon: '📻',

    source: 'HamRig repeater tables',

    /** A view-driven layer: the manager owns the first fetch, the camera the rest. */
    updateInterval: 0,

    statsRefreshInterval: 1000,

    /** Apply the manager-owned lifecycle gate to visible and pickable state. */
    setLifecyclePresentation({
      lifecycleState = null,
      enabled = false,
      uncertain = false,
    } = {}) {
      const settled = enabled ? 'enabled' : 'disabled';
      layerState._managerPresentation = {
        lifecycleState: [
          'enabling',
          'enabled',
          'disabling',
          'disabled',
        ].includes(lifecycleState)
          ? lifecycleState
          : settled,
        enabled: Boolean(enabled),
        uncertain: Boolean(uncertain),
      };
      parts.interaction.syncPresentation();
      parts.presentation.emitState();
    },

    getStats() {
      const visible = parts.queries.visibleRepeaters().length;
      const aboveGate =
        layerState._enabled &&
        !layerState._gate.withinGate &&
        !layerState._loading &&
        !layerState._area;
      return {
        count: layerState._repeaters.length,
        countLabel: layerState._enabled ? `${visible} in view area` : '',
        filtered: visible,
        selected: layerState._selectedId,
        withinGate: layerState._gate.withinGate,
        area: layerState._area
          ? {
              lat: layerState._area.lat,
              lon: layerState._area.lon,
              radiusKm: layerState._area.radiusKm,
            }
          : null,
        stale: layerState._stale,
        partial: layerState._partial,
        loading: layerState._loading,
        loadingLabel: layerState._loading
          ? 'loading repeaters around the view'
          : '',
        error: layerState._error,
        status: aboveGate ? 'zoom-in' : layerState._error ? 'error' : undefined,
        statusMessage: aboveGate ? GATE_GUIDANCE : '',
        sources: [...layerState._sources],
        lastUpdate: layerState._updatedAt
          ? Date.parse(layerState._updatedAt)
          : null,
      };
    },

    /** Kind chips, LOAD HERE, a colour legend and the area/provenance line. */
    getRowControls() {
      const visible = parts.queries.visibleRepeaters();
      const count = (kind) => visible.filter((row) => row.kind === kind).length;
      return {
        chips: [
          kindChip('all', 'ALL'),
          kindChip('FM', 'FM'),
          kindChip('D-STAR', 'D-STAR'),
          {
            id: 'load-here',
            label: 'LOAD HERE',
            title:
              'Load repeaters around the centre of the current view, whatever the height',
            disabled: !layerState._enabled || layerState._loading,
            onClick: () => void parts.camera.loadHere({ origin: 'user' }),
          },
        ],
        legend: [
          {
            label: 'FM',
            color: REPEATER_COLORS.FM,
            count: count('FM'),
            blurb: 'FM repeaters; a dim marker was listed as off-air or closed',
          },
          {
            label: 'D-STAR',
            color: REPEATER_COLORS['D-STAR'],
            count: count('D-STAR'),
            blurb: 'D-STAR repeaters, one marker per module',
          },
        ],
        info: statusLine(),
        infoTitle: `${REACHABILITY_NOTE}. Each marker names its source, confidence and record date.`,
      };
    },

    setRowControlsListener(listener) {
      layerState._rowControlsListener =
        typeof listener === 'function' ? listener : null;
    },

    subscribe: parts.presentation.subscribe,

    getUIState: parts.presentation.getUIState,

    getRepeaters: () => layerState._repeaters,

    getRepeater: parts.queries.getRepeater,

    ensureLoaded: parts.ingestion.ensureLoaded,

    loadAround: parts.ingestion.loadAround,

    loadHere: parts.camera.loadHere,

    setFilter: parts.queries.setFilter,

    select: parts.queries.select,

    resolve: parts.queries.resolve,

    nearest: parts.queries.nearest,

    frame: parts.rendering.frame,

    flyTo: parts.rendering.flyTo,
  };

  return { methods };
}
