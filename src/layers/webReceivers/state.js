import { DEFAULT_FILTER } from './policy.js';

/** Everything the layer owns lives on this instance; nothing is module-global. */
export function createState() {
  return {
    _viewer: null,
    _dataSource: null,
    _removeClusterListener: null,
    _clickHandler: null,
    _enabled: false,
    _managerPresentation: null,
    _loading: false,
    _error: null,
    _stale: false,
    _degraded: false,
    _updatedAt: null,
    _sources: null,
    _receivers: Object.freeze([]),
    _byId: new Map(),
    _renderById: new Map(),
    _selectedId: null,
    _selectedEntity: null,
    _highlightIds: new Set(),
    _filter: DEFAULT_FILTER,
    _lastTune: null,
    _lastSearch: null,
    _abort: null,
    _requestGeneration: 0,
    _sessionGeneration: 0,
    _loadPromise: null,
    _listeners: new Set(),
  };
}
