/**
 * AlphaEarth Change: where a place changed between two years, read from the
 * AlphaEarth Foundations annual satellite embeddings. The person draws a box,
 * the server diffs the two years' 64-dimension embeddings per pixel
 * (`1 − cosine`), and the layer drapes the grid as a heatmap. The threshold
 * is applied here, so moving it never costs another upstream read.
 */
import { NO_IMAGERY_HOST, resolveImageryHost } from '../../maps/imageryHost.js';
import {
  ALPHA_EARTH_ATTRIBUTION,
  ALPHA_EARTH_DEFAULT_THRESHOLD,
  ALPHA_EARTH_DETAILS,
  changedFraction,
  clampThreshold,
  decodeGrid,
  defaultYears,
  dequantizeBox,
  normalizeYears,
  quantizeBox,
  validateAlphaEarthBox,
} from './model.js';

export const ALPHA_EARTH_LAYER_ID = 'alpha-earth-change';
const DEFAULT_ALPHA = 0.85;

const toDegrees = (rad) => (rad * 180) / Math.PI;
const boxFromRectangle = (rectangle) => ({
  west: toDegrees(rectangle.west),
  south: toDegrees(rectangle.south),
  east: toDegrees(rectangle.east),
  north: toDegrees(rectangle.north),
});
const sameBox = (a, b) =>
  Boolean(a && b) &&
  ['west', 'south', 'east', 'north'].every((k) => a[k] === b[k]);

/**
 * Create the layer.
 * @param {{ source: { listYears: Function, fetchChange: Function }, renderer: object, host?: Function }} options
 */
export function createAlphaEarthLayer({
  source,
  renderer,
  host = resolveImageryHost,
} = {}) {
  let _viewer = null;
  let _tileset = null;
  let _dataManager = null;
  let _unsubscribeMap = null;
  let _enabled = false;
  let _destroyed = false;
  let _applyingParams = false;
  let _hostInfo = { collection: null, kind: 'none' };
  let _toolHandler = null;
  let _toolActive = false;

  let _years = [];
  let _yearsError = null;
  let _yearsLoading = null;
  let _box = null;
  let _boxError = null;
  /** Years and detail asked for, before the year list confirms them. */
  let _from = null;
  let _to = null;
  let _detail = 'standard';
  let _threshold = ALPHA_EARTH_DEFAULT_THRESHOLD;
  let _alpha = DEFAULT_ALPHA;

  let _status = 'idle';
  let _error = null;
  let _abort = null;
  /** The last comparison: server metadata plus the decoded grid. */
  let _result = null;
  let _lastUpdate = null;
  const _listeners = new Set();

  function notify() {
    for (const listener of [..._listeners]) {
      try {
        listener(layer.getSnapshot());
      } catch (error) {
        console.warn('[Data:AlphaEarth] listener failed:', error);
      }
    }
  }

  function publish(keys) {
    if (_applyingParams || _destroyed || !_dataManager?.adoptLayerParams)
      return;
    const params = layer.getParams();
    const picked = {};
    for (const key of keys) picked[key] = params[key];
    try {
      _dataManager.adoptLayerParams(layer.id, picked, { origin: 'user' });
    } catch (error) {
      console.warn('[Data:AlphaEarth] publish failed:', error);
    }
  }

  function syncHost() {
    const next = host({ viewer: _viewer, tileset: _tileset }) || {
      collection: null,
      kind: 'none',
    };
    const changed =
      next.collection !== _hostInfo.collection || next.kind !== _hostInfo.kind;
    _hostInfo = next;
    renderer.rebind(next);
    return changed;
  }

  function followMap() {
    if (_destroyed || !_enabled) return;
    if (syncHost()) notify();
  }

  function cancel() {
    _abort?.abort();
    _abort = null;
  }

  function loadYears() {
    if (_years.length || _yearsLoading) return _yearsLoading;
    _yearsError = null;
    _yearsLoading = Promise.resolve()
      .then(() => source.listYears())
      .then((years) => {
        _years = years;
        const pair =
          normalizeYears(_from, _to, years) || defaultYears(years) || null;
        _from = pair?.from ?? null;
        _to = pair?.to ?? null;
      })
      .catch((error) => {
        _yearsError = error?.message || 'Years unavailable';
      })
      .finally(() => {
        _yearsLoading = null;
        if (_destroyed) return;
        if (_enabled && _box && !_result && !_abort) void run();
        notify();
      });
    notify();
    return _yearsLoading;
  }

  function draw() {
    if (!_result || !_enabled) return;
    renderer.show({
      grid: _result.grid,
      width: _result.width,
      height: _result.height,
      box: _result.box,
      threshold: _threshold,
      alpha: _alpha,
    });
  }

  /** Compare the current box and years; a newer request supersedes this one. */
  async function run() {
    cancel();
    if (!_enabled || !_box || _from == null || _to == null) {
      notify();
      return false;
    }
    const controller = new AbortController();
    _abort = controller;
    const query = { box: _box, from: _from, to: _to, detail: _detail };
    _status = 'loading';
    _error = null;
    notify();
    try {
      const body = await source.fetchChange({
        ...query,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return false;
      const grid = decodeGrid(body.grid, body.width, body.height);
      if (!grid) throw new Error('The change grid did not decode');
      _result = {
        ...body,
        grid,
        box: {
          west: body.west,
          south: body.south,
          east: body.east,
          north: body.north,
        },
      };
      _status = 'ready';
      _lastUpdate = Date.now();
      syncHost();
      draw();
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      _status = 'error';
      _error = error?.message || 'Comparison failed';
      return false;
    } finally {
      if (_abort === controller) _abort = null;
      if (!_destroyed) notify();
    }
  }

  function clearResult() {
    cancel();
    _result = null;
    _status = 'idle';
    _error = null;
    renderer.hide();
  }

  function applyBox(box) {
    const result = validateAlphaEarthBox(box);
    if (!result.ok) {
      _boxError = result.message;
      notify();
      return false;
    }
    _boxError = null;
    if (sameBox(_box, result.box) && _result) return true;
    _box = result.box;
    clearResult();
    return true;
  }

  const layer = {
    id: ALPHA_EARTH_LAYER_ID,
    name: 'AlphaEarth Change',
    icon: '🧬',
    source: 'AlphaEarth Foundations · Source Cooperative',
    updateInterval: 0,

    init(viewer) {
      _viewer = viewer || null;
      return true;
    },

    enable(viewer) {
      if (_destroyed) return false;
      if (viewer) _viewer = viewer;
      _enabled = true;
      syncHost();
      void loadYears();
      // A first enable runs once the year list confirms the pair.
      if (_result) draw();
      else if (_box && _years.length) void run();
      notify();
      return true;
    },

    disable() {
      cancel();
      if (_status === 'loading') _status = _result ? 'ready' : 'idle';
      _toolHandler?.();
      _toolActive = false;
      _enabled = false;
      renderer.hide();
      notify();
      return true;
    },

    /** No polling: annual layers change with the box, not with the clock. */
    async update() {},

    destroy() {
      if (_destroyed) return;
      if (_enabled) this.disable();
      _unsubscribeMap?.();
      _unsubscribeMap = null;
      renderer.destroy();
      _listeners.clear();
      _toolHandler = null;
      _viewer = null;
      _tileset = null;
      _dataManager = null;
      _destroyed = true;
    },

    /** Hear every settled map-stack switch so the drape follows its host. */
    attachMapStackController(controller) {
      _unsubscribeMap?.();
      const off = controller?.subscribe?.(followMap);
      _unsubscribeMap = typeof off === 'function' ? off : null;
    },

    attachDataManager(manager) {
      _dataManager = manager || null;
    },

    /** The photoreal tileset, for draping while the globe is hidden. */
    attachTileset(tileset) {
      _tileset = tileset || null;
      if (_enabled && syncHost()) notify();
    },

    setToolHandler(handler) {
      _toolHandler = typeof handler === 'function' ? handler : null;
    },

    setToolActive(active) {
      if (Boolean(active) === _toolActive) return;
      _toolActive = Boolean(active);
      notify();
    },

    /** Select a box and compare it; a refusal stays until a box succeeds. */
    setBox(box) {
      if (!applyBox(box)) return false;
      publish(['west', 'south', 'east', 'north']);
      if (_enabled && !_result) void run();
      notify();
      return true;
    },

    reportBoxRefusal(message) {
      const text = typeof message === 'string' ? message.trim() : '';
      if (!text) return false;
      _boxError = text;
      notify();
      return true;
    },

    /** Use the camera's view as the box; a view over the cap is refused. */
    useCurrentView(viewer = _viewer) {
      const rectangle = viewer?.camera?.computeViewRectangle?.();
      if (!rectangle)
        return this.reportBoxRefusal(
          'Point the camera at the ground to use the view',
        );
      return this.setBox(boxFromRectangle(rectangle));
    },

    /** Compare two years; the order does not matter. */
    setYears(from, to) {
      const pair = normalizeYears(from, to, _years);
      if (!pair) return false;
      if (pair.from === _from && pair.to === _to) return true;
      _from = pair.from;
      _to = pair.to;
      publish(['from', 'to']);
      clearResult();
      if (_enabled && _box) void run();
      notify();
      return true;
    },

    setDetail(detail) {
      if (!ALPHA_EARTH_DETAILS.includes(detail) || detail === _detail)
        return false;
      _detail = detail;
      publish(['detail']);
      clearResult();
      if (_enabled && _box) void run();
      notify();
      return true;
    },

    /** Repaint at a new threshold; no request is made. */
    setThreshold(value) {
      const next = clampThreshold(value, _threshold);
      if (next === _threshold) return false;
      _threshold = next;
      publish(['threshold']);
      if (_enabled) renderer.setThreshold(_threshold);
      notify();
      return true;
    },

    setAlpha(value) {
      const alpha = Number(value);
      if (!Number.isFinite(alpha)) return false;
      _alpha = Math.max(0, Math.min(1, alpha));
      renderer.setAlpha(_alpha);
      notify();
      return true;
    },

    /** Re-run a failed comparison. */
    retry() {
      if (!_enabled || !_box) return false;
      if (!_years.length) void loadYears();
      else void run();
      return true;
    },

    clear() {
      _toolHandler?.();
      _box = null;
      _boxError = null;
      clearResult();
      publish(['west', 'south', 'east', 'north']);
      notify();
    },

    getSnapshot() {
      const stats = _result?.stats || null;
      return {
        id: layer.id,
        enabled: _enabled,
        status: _status,
        error: _error,
        boxError: _boxError,
        hostError:
          _enabled && _hostInfo.kind === 'none' ? NO_IMAGERY_HOST : null,
        years: [..._years],
        yearsError: _yearsError,
        yearsLoading: Boolean(_yearsLoading),
        from: _from,
        to: _to,
        detail: _detail,
        threshold: _threshold,
        alpha: _alpha,
        box: _box ? { ..._box } : null,
        toolActive: _toolActive,
        result: _result
          ? {
              from: _result.from,
              to: _result.to,
              box: { ..._result.box },
              width: _result.width,
              height: _result.height,
              pixelMeters: _result.pixelMeters,
              detail: _result.detail,
              computedAt: _result.computedAt,
              stats: stats ? { ...stats } : null,
              changedFraction: changedFraction(_result.grid, _threshold),
            }
          : null,
        attribution: ALPHA_EARTH_ATTRIBUTION,
      };
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      _listeners.add(listener);
      return () => _listeners.delete(listener);
    },

    setParams(params) {
      if (!params || typeof params !== 'object') return false;
      _applyingParams = true;
      try {
        const box = dequantizeBox(params);
        if (box && !sameBox(box, _box)) applyBox(box);
        if (params.from != null && params.to != null) {
          const pair = normalizeYears(params.from, params.to, _years);
          if (pair && (pair.from !== _from || pair.to !== _to)) {
            _from = pair.from;
            _to = pair.to;
            clearResult();
          }
        }
        if (
          ALPHA_EARTH_DETAILS.includes(params.detail) &&
          params.detail !== _detail
        ) {
          _detail = params.detail;
          clearResult();
        }
        if (params.threshold != null) {
          _threshold = clampThreshold(
            Number(params.threshold) / 100,
            _threshold,
          );
          if (_enabled) renderer.setThreshold(_threshold);
        }
        if (_enabled && _box && !_result && !_abort) void run();
        notify();
        return true;
      } finally {
        _applyingParams = false;
      }
    },

    getParams() {
      const quantized = quantizeBox(_box);
      return {
        west: quantized?.west ?? null,
        south: quantized?.south ?? null,
        east: quantized?.east ?? null,
        north: quantized?.north ?? null,
        from: _from,
        to: _to,
        threshold: Math.round(_threshold * 100),
        detail: _detail,
      };
    },

    getStats() {
      if (!_unsubscribeMap) followMap();
      return {
        count: _result ? 1 : 0,
        lastUpdate: _lastUpdate,
        error: _error || _yearsError || null,
      };
    },

    diagnostics() {
      return {
        host: _hostInfo.kind,
        owned: renderer.getOwned(),
        status: _status,
        loading: Boolean(_abort),
      };
    },
  };
  return layer;
}
