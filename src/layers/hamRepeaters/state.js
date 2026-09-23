import {
  HEIGHT_GATE_M,
  normalizeRepeaterFilter,
} from '../../sources/hamRepeaters.js';

export const INITIAL_GATE = Object.freeze({
  heightM: null,
  withinGate: false,
  gateM: HEIGHT_GATE_M,
});

/** Everything the layer owns lives on this instance; nothing is module-global. */
export function createState() {
  return {
    _viewer: null,
    _dataSource: null,
    _removeClusterListener: null,
    _clickHandler: null,
    _removeMoveEnd: null,
    _debounceTimer: null,
    _enabled: false,
    _managerPresentation: null,
    _loading: false,
    _error: null,
    _stale: false,
    _partial: false,
    _errors: Object.freeze({}),
    _sources: Object.freeze([]),
    _updatedAt: null,
    _repeaters: Object.freeze([]),
    _byId: new Map(),
    _renderById: new Map(),
    _area: null,
    _gate: INITIAL_GATE,
    _lastLoad: null,
    _selectedId: null,
    _selectedEntity: null,
    _hoverId: null,
    _hoverEntity: null,
    _lastHoverPick: 0,
    _filter: normalizeRepeaterFilter(),
    _abort: null,
    _requestGeneration: 0,
    _sessionGeneration: 0,
    _listeners: new Set(),
    _rowControlsListener: null,
  };
}
