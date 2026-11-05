import {
  OPACITY_DEFAULT,
  normalizeOpacity,
  readLayerOpacityFromUrl,
  writeLayerOpacityToUrl,
} from '../data/layerOpacity.js';

/** How long a change waits before the address is rewritten. */
const ADDRESS_DELAY_MS = 250;

/**
 * Own the opacity of the data layers that can be dimmed.
 *
 * A layer opts in by implementing `setOpacity(fraction)`: it applies the
 * fraction to what it draws and keeps it until told another, including while
 * it is off or not yet initialized, so a value restored from the address
 * before the layer starts is honoured when it does. Layers without the hook
 * have no opacity control and are never written to the address.
 *
 * The owner holds the values, calls the hook, keeps `?lop=` in step with them
 * (see src/data/layerOpacity.js) and tells subscribers, which repaint. It
 * imports neither Vue nor Cesium.
 */
export class LayerOpacity {
  /**
   * @param {{layers: Map<string, {module?: object}>}} manager The layer manager.
   * @param {object} [options]
   * @param {Location|null} [options.locationRef] The page address to read and keep.
   * @param {History|null} [options.historyRef] Where the address is rewritten.
   * @param {() => void} [options.requestRender] Ask the scene to draw again.
   * @param {number} [options.addressDelayMs] Wait before the address is rewritten.
   */
  constructor(
    manager,
    {
      locationRef = globalThis.location ?? null,
      historyRef = globalThis.history ?? null,
      requestRender = () => {},
      addressDelayMs = ADDRESS_DELAY_MS,
    } = {},
  ) {
    this._manager = manager;
    this._location = locationRef;
    this._history = historyRef;
    this._requestRender = requestRender;
    this._addressDelayMs = addressDelayMs;
    /** @type {Map<string, number>} only layers off the default */
    this._values = new Map();
    this._listeners = new Set();
    this._addressTimer = null;
    this._destroyed = false;
  }

  /** Whether the layer has an opacity control. */
  supports(id) {
    return (
      !this._destroyed &&
      typeof this._manager.layers.get(id)?.module?.setOpacity === 'function'
    );
  }

  /** The layer's opacity as a fraction; 1 unless it was changed. */
  get(id) {
    return this._values.get(id) ?? OPACITY_DEFAULT;
  }

  /**
   * Change a layer's opacity.
   * @param {string} id
   * @param {number} fraction 0 to 1; rounded to a whole percent.
   * @returns {boolean} Whether the value changed.
   */
  set(id, fraction) {
    if (!this.supports(id)) return false;
    const next = normalizeOpacity(fraction);
    if (next === this.get(id)) return false;
    if (next === OPACITY_DEFAULT) this._values.delete(id);
    else this._values.set(id, next);
    this._apply(id, next);
    this._scheduleAddress();
    for (const listener of [...this._listeners]) {
      try {
        listener(id, next);
      } catch {
        console.warn('[Opacity] listener error');
      }
    }
    return true;
  }

  /** Return a layer to the default of 100 %. */
  reset(id) {
    return this.set(id, OPACITY_DEFAULT);
  }

  /**
   * Take the opacity the page address carries. Entries for unknown layers, or
   * layers without the hook, are ignored.
   */
  restore() {
    if (this._destroyed || !this._location) return;
    const carried = readLayerOpacityFromUrl(this._location.href, (id) =>
      this.supports(id),
    );
    for (const [id, value] of carried) this.set(id, value);
  }

  /**
   * Observe changes.
   * @param {(id: string, fraction: number) => void} listener
   * @returns {() => void} Stop observing.
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _apply(id, fraction) {
    try {
      this._manager.layers.get(id)?.module?.setOpacity?.(fraction);
    } catch {
      console.warn('[Opacity] setOpacity error');
    }
    this._requestRender();
  }

  // The address is a convenience; a slow drag or a browser that limits
  // history writes must not cost the slider anything.
  _scheduleAddress() {
    if (!this._location || !this._history?.replaceState) return;
    clearTimeout(this._addressTimer);
    this._addressTimer = setTimeout(
      () => this._writeAddress(),
      this._addressDelayMs,
    );
  }

  _writeAddress() {
    this._addressTimer = null;
    if (this._destroyed) return;
    try {
      const next = writeLayerOpacityToUrl(this._location.href, this._values);
      if (next !== this._location.href)
        this._history.replaceState(this._history.state, '', next);
    } catch {
      console.warn('[Opacity] address update failed');
    }
  }

  /** Stop timers and listeners. The layers keep the opacity they were given. */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    clearTimeout(this._addressTimer);
    this._addressTimer = null;
    this._listeners.clear();
    this._values.clear();
  }
}
