import { createImageryStack } from './imagery.js';
import { createMapStackTarget } from './target.js';
import { isNoKeyError } from './model.js';
import {
  DEFAULT_REFRESH_CHOICE,
  FALLBACK_REFRESH_MS,
  FIELD,
  LAYER_ID,
  LAYER_NAME,
  LAYER_TICK_MS,
  WEATHER_LAYER_SPECS,
  REFRESH_CHOICES,
  drapedSelection,
  codesToIds,
  defaultActiveIds,
  idsToCodes,
} from './policy.js';

export * from './model.js';
export * from './policy.js';
export { createWeatherSource } from './source.js';

/** Own one weather display and its frame lifecycle. */
export function createWeatherLayer({
  source,
  specs = WEATHER_LAYER_SPECS,
  services: {
    mapStack = createMapStackTarget(),
    render: { governorRequestRender = null } = {},
  } = {},
} = {}) {
  if (typeof source?.getFrame !== 'function')
    throw new TypeError('Weather requires a frame source');

  const stack = createImageryStack();
  const frames = new Map();
  const polledAt = new Map();
  /** Freshness floor each drawn spec was last built with. */
  const floors = new Map();
  let _viewer = null;
  let _enabled = false;
  let _request = null;
  let _unsubscribe = null;
  let _lastUpdate = null;
  let _lastError = null;
  // Distinct from _lastError on purpose: "the server has no credential" is a
  // standing state an operator can fix, while "the probe failed" may be a
  // passing fault. They read identically from outside and must not be merged.
  let _noKey = false;
  /**
   * The specs actually drawn. Everything else in the table is dormant: never
   * polled, never drawn, costing nothing. Enabling a layer is what spends the
   * quota, because each one multiplies every camera move.
   */
  let _active = new Set(defaultActiveIds());
  /** Auto-refresh is off until asked for; the button is the normal way. */
  let _auto = false;
  let _everyCode = DEFAULT_REFRESH_CHOICE;
  /** Set by the panel's refresh button, cleared the moment it is honoured. */
  let _refreshNow = false;
  // When new data was last asked for, manually or by the timer. Sticky: a tile
  // cached before this moment stays stale until it is refetched, so a redraw
  // after a refresh cannot quietly reinstate the pre-refresh picture.
  let _freshAt = 0;

  const isActiveSpec = (spec) => _active.has(spec.id);
  const activeSpecs = () => specs.filter(isActiveSpec);
  const refreshChoiceMs = () =>
    REFRESH_CHOICES.find((choice) => choice.code === _everyCode)?.ms ??
    FALLBACK_REFRESH_MS;

  /**
   * Wake the scene after touching an imagery collection.
   *
   * A tileset bumps a counter when its imagery changes but never asks for a
   * frame, and neither does draped imagery finishing its load. Under
   * `requestRenderMode` that would leave a change invisible until something
   * else happened to wake the scene.
   */
  const requestRender = () => {
    if (governorRequestRender) governorRequestRender('weather-imagery');
    else _viewer?.scene?.requestRender?.();
  };

  /**
   * Drop what was read, not just what was drawn.
   *
   * Only teardown does this. A photoreal stack hides the globe and takes the
   * imagery with it, but the frames stay valid for as long as their cadence
   * says — so flipping to Google 3D and back redraws from what is already
   * held instead of re-polling every service on each round trip.
   */
  const forget = () => {
    frames.clear();
    polledAt.clear();
    floors.clear();
  };

  /**
   * The boolean this returns is the lifecycle, not the weather.
   *
   * The manager turns a `false` from the first update into a failed enable, so
   * it must mean "this call could not be honoured" — torn down, no viewer, or
   * superseded — and never "enabled, but with nothing to draw just now". This
   * layer has such states by design: there is no keyless mode, and the drape
   * budget can hold a selected layer back. Both belong on the row, and the row
   * only exists while the layer is on. Health is `getStats()`.
   */
  const runUpdate = async (viewer) => {
    if (!_enabled || !viewer) return false;
    // Resolved once per pass: every draw below goes to the collection being
    // rendered now, and a switch arriving mid-pass supersedes this one.
    const target = mapStack.resolve(viewer);
    if (!target?.imageryLayers) return true;
    _request?.abort();
    const request = new AbortController();
    _request = request;
    const settled = () =>
      request.signal.aborted || _request !== request || !_enabled;
    try {
      const now = Date.now();
      // What this regime can actually draw. The globe takes everything; a
      // tileset takes the drape budget, highest rung first.
      const drawable = drapedSelection(activeSpecs(), target.regime);
      const drawableIds = new Set(drawable.map((spec) => spec.id));
      let withdrawn = 0;

      // Anything switched off since the last tick stops drawing immediately,
      // and stops being polled with it. A layer that is still selected but not
      // drawable here only loses its imagery — its frame stays held, so coming
      // back costs no read and nothing billed.
      for (const specId of stack.ownedIds()) {
        if (_active.has(specId)) {
          if (drawableIds.has(specId)) continue;
          if (stack.remove(specId)) withdrawn += 1;
          continue;
        }
        if (stack.remove(specId)) withdrawn += 1;
        frames.delete(specId);
        polledAt.delete(specId);
        floors.delete(specId);
      }

      const forced = _refreshNow;
      _refreshNow = false;
      // Asking for new data is what moves the freshness floor. Enabling a
      // layer does not: its first draw is allowed to come from cache, so
      // switching something on to look at it costs nothing.
      if (forced) _freshAt = now;

      const due = [];
      let redrawn = 0;
      for (const spec of drawable) {
        const held = frames.get(spec.id);
        // A layer just switched on has nothing to draw, so it fetches once
        // whatever the refresh settings say — otherwise enabling a layer would
        // appear to do nothing until the next interval.
        if (!held) {
          due.push(spec);
          continue;
        }
        if (forced) {
          due.push(spec);
          continue;
        }
        // With auto-refresh off, a held frame is never replaced on a timer.
        // Spending happens when asked for, not on the clock.
        if (_auto) {
          const cadence = Math.max(
            refreshChoiceMs(),
            // The server also has an opinion, set against the same quota; take
            // whichever is slower so the panel can never out-spend it.
            frames.get(spec.id)?.refreshMs ?? 0,
          );
          if (now - (polledAt.get(spec.id) ?? -Infinity) >= cadence) {
            // The timer firing is a request for new data too, so it moves the
            // floor as a button press would. Without this an interval shorter
            // than the proxy's cache would redraw the same pixels forever.
            _freshAt = now;
            due.push(spec);
            continue;
          }
        }
        // Held, not due — but it may not be drawn where the scene is looking,
        // because the rendered collection changed under it.
        if (stack.isDrawnIn(target.imageryLayers, spec.id)) continue;
        stack.apply(target.imageryLayers, spec, {
          notBefore: _freshAt,
          regime: target.regime,
        });
        floors.set(spec.id, _freshAt);
        redrawn += 1;
      }

      // One request per distinct read, all in flight at once, settling
      // independently so one dead source cannot stop the others drawing.
      const reads = new Map();
      for (const spec of due)
        if (!reads.has(spec.capsKey)) reads.set(spec.capsKey, spec);
      const keys = [...reads.keys()];
      const settlements = await Promise.allSettled(
        keys.map((key) =>
          source.getFrame(reads.get(key), { signal: request.signal }),
        ),
      );
      // A late body must never publish into a layer that moved on.
      if (settled()) return false;

      const read = new Map();
      let failure = null;
      settlements.forEach((settlement, index) => {
        if (settlement.status === 'fulfilled')
          read.set(keys[index], settlement.value);
        else failure ??= settlement.reason;
      });

      let refreshed = 0;
      for (const spec of due) {
        const frame = read.get(spec.capsKey);
        // This source is down. The spec keeps whatever it is already drawing
        // and will be due again on the next tick.
        if (!frame) continue;
        polledAt.set(spec.id, now);
        // Rebuild when what this spec draws should change: a new frame, or
        // a new freshness floor. The floor has to count on its own — the
        // source is entitled to hand back the same key, and a refresh that
        // skipped the rebuild would leave the pre-refresh URL in place and so
        // keep serving the pre-refresh pixels.
        if (
          !stack.isDrawnIn(target.imageryLayers, spec.id) ||
          frames.get(spec.id)?.key !== frame.key ||
          floors.get(spec.id) !== _freshAt
        ) {
          // Add before removing so a live spec never blinks through the base map.
          stack.apply(target.imageryLayers, spec, {
            notBefore: _freshAt,
            regime: target.regime,
          });
          floors.set(spec.id, _freshAt);
          frames.set(spec.id, frame);
        }
        refreshed += 1;
      }

      if (refreshed || redrawn) _lastUpdate = Date.now();
      if (refreshed || redrawn || withdrawn) requestRender();
      // Nothing active is a deliberate state, not a broken one.
      if (!activeSpecs().length) _lastError = null;
      // A missing key is latched separately, and only cleared by a read that
      // succeeds — otherwise the row would flicker between "add a key" and a
      // generic error as ticks failed for different reasons.
      if (refreshed) _noKey = false;
      else if (failure && isNoKeyError(failure)) _noKey = true;
      // An outage only reaches the row when nothing is drawn at all; what it
      // always shows is age, since lastUpdate stops advancing.
      else _lastError = stack.size ? null : failure?.message || _lastError;
      // The pass completed and the row now reflects it, whether that is
      // imagery or `ADD XWEATHER KEY`. A source that is down must not take the
      // layer off with it — an absent row says nothing at all, where an
      // unavailable one says what is wrong.
      return true;
    } catch (error) {
      if (settled()) return false;
      _lastError = error?.message || 'Weather source unavailable';
      return true;
    } finally {
      if (_request === request) _request = null;
    }
  };

  /**
   * The rendered collection may have moved; re-run and let the per-spec draw
   * check re-home whatever is in the wrong one.
   *
   * No cached regime to compare against: the port already filters out the
   * `switching` emission, and an event that changed nothing costs one identity
   * comparison per drawn spec. A cache here would only add a way for this
   * layer's idea of the scene to drift from the scene.
   */
  const onMapStackChanged = () => {
    if (!_enabled || !_viewer) return;
    void runUpdate(_viewer);
  };

  const layer = {
    id: LAYER_ID,
    name: LAYER_NAME,
    icon: '🌧',
    source: 'Vaisala Xweather',
    // Tick at the floor, not the refresh cadence: the cadence is a server
    // setting that can change without a rebuild, and the gating above decides
    // whether a tick does any work. A tick with nothing due is a comparison.
    updateInterval: LAYER_TICK_MS,

    init(viewer) {
      if (_viewer) throw new Error('Weather layer is already initialized');
      _viewer = viewer;
      _enabled = false;
      _lastUpdate = null;
      _freshAt = 0;
      _lastError = null;
      _noKey = false;
      console.log('[Data:Weather] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      _viewer = viewer || _viewer;
      // No continuous-render hold: imagery tiles drive their own redraws, so
      // the layer has no per-frame animator to keep the render loop alive for.
      _unsubscribe ??= mapStack.subscribe(onMapStackChanged);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      _unsubscribe?.();
      _unsubscribe = null;
      stack.clear();
      requestRender();
      forget();
      _lastError = null;
      _noKey = false;
    },

    async update(viewer) {
      return runUpdate(viewer || _viewer);
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      _unsubscribe?.();
      _unsubscribe = null;
      stack.clear();
      requestRender();
      forget();
      mapStack.attach?.(null);
      _viewer = null;
      _lastUpdate = null;
      _freshAt = 0;
      _lastError = null;
      _noKey = false;
    },

    /**
     * Runtime parameters, driven by the Weather panel.
     *
     * The manager refuses `setLayerParams` outright for a module without this,
     * so it is also what makes the selection shareable: the same values round
     * trip through the layer-state registry.
     */
    /**
     * Receive the map controller once the scene owns one.
     *
     * The layer catalogue is built before the scene exists, so this cannot be
     * constructor injection; `createApplicationData` hands every layer the
     * controller through this hook.
     *
     * @param {object|null} controller The map stack controller.
     */
    attachMapStackController(controller) {
      mapStack.attach?.(controller);
      if (_enabled && _viewer) void runUpdate(_viewer);
    },

    setParams(params = {}) {
      if (typeof params.layers === 'string') {
        const resolved = codesToIds(params.layers).filter((id) =>
          specs.some((spec) => spec.id === id),
        );
        // At most one continuous field. They are opaque edge to edge, so a
        // second would hide the first while billing for both; the layer
        // enforces it so a hand-written link cannot smuggle two in.
        const fields = resolved.filter(
          (id) => specs.find((spec) => spec.id === id)?.group === FIELD,
        );
        const dropped = new Set(fields.slice(0, -1));
        _active = new Set(resolved.filter((id) => !dropped.has(id)));
      }
      if (typeof params.auto === 'boolean') _auto = params.auto;
      if (typeof params.every === 'string') {
        if (REFRESH_CHOICES.some((choice) => choice.code === params.every))
          _everyCode = params.every;
      }
      // Transient, and deliberately not part of the persisted option bag: a
      // share link should never arrive asking to spend.
      if (params.refreshNow === true) _refreshNow = true;
      return true;
    },

    getParams() {
      return {
        layers: idsToCodes([..._active]),
        auto: _auto,
        every: _everyCode,
      };
    },

    getStats() {
      // There is no keyless mode. Without a credential the layer cannot draw
      // at all, so it says so plainly rather than sitting on an empty globe
      // looking healthy — 'unavailable' is what turns the row red.
      if (_noKey)
        return {
          count: 0,
          lastUpdate: _lastUpdate,
          status: 'unavailable',
          error: 'ADD XWEATHER KEY',
        };
      const drawn = stack.size;
      if (!drawn)
        return {
          count: 0,
          countLabel: _active.size ? null : 'NONE',
          lastUpdate: _lastUpdate,
          // Choosing to draw nothing is a state, not a fault.
          error: _active.size ? _lastError : null,
          status: _active.size ? undefined : 'idle',
          statusMessage: _active.size ? undefined : 'no layers selected',
        };
      return {
        count: 0,
        // An imagery layer counts nothing and an observation has no forecast
        // lead, so the slot carries how much is switched on — which is also
        // what governs the bill. Drawn against selected, because the drape
        // budget can hold layers back in 3D and a bare count would then be a
        // lie about what is on screen.
        countLabel:
          drawn === _active.size
            ? `${drawn} ON`
            : `${drawn} OF ${_active.size} ON`,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
