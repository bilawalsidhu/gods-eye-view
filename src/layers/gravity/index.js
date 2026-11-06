import * as Cesium from 'cesium';
import { isPointerFree } from '../../data/inputOwnership.js';
import { createGravityRendering, GRAVITY_COLORS } from './rendering.js';
import { landMaskAt } from './landMask.js';
import { formatGravityCm, gravityMonthLabel } from './display.js';

export { formatGravityCm, gravityMonthLabel };
import { msg, t } from '../../i18n/index.js';

export const GRAVITY_LAYER_ID = 'gravity';
const SOURCE = 'CSR GRACE/GRACE-FO · MONTHLY';
const ALPHA = Object.freeze({ light: 0.55, strong: 0.85 });
const AREAS = Object.freeze(['land', 'all']);
const UNAVAILABLE = msg('Gravity record unavailable');
const PREPARING = msg('Preparing the gravity record');
const HISTORY_UNAVAILABLE = msg('History unavailable');
const MASK_UNAVAILABLE = msg('Land mask unavailable · showing every cell');
/** Fields kept in memory: 36 months is about 4.7 MB and covers a replay. */
const FIELD_CACHE = 36;
/** Playback: one solution per step, never faster than its field arrives. */
export const GRAVITY_PLAY_STEP_MS = 600;

/** Grid cell index for a position, or -1 off the globe. */
export function gravityCellIndex(index, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90)
    return -1;
  const { nx, ny } = index.grid;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  const row = Math.min(ny - 1, Math.floor(90 - lat));
  const col = Math.min(nx - 1, Math.floor(wrapped + 180));
  return row * nx + col;
}

/** Value in cm at a position on the one-degree grid, or null. */
export function gravityValueAt(field, index, lat, lon) {
  const cell = field ? gravityCellIndex(index, lat, lon) : -1;
  if (cell < 0) return null;
  const count = field[cell];
  return count === index.noData ? null : count * index.scaleCm;
}

/**
 * Monthly change in mass at the surface from the GRACE and GRACE-FO gravity
 * missions, as centimetres of equivalent water against the 2004-2009 mean.
 * Mostly groundwater, ice and large lakes; resolution is about 300 km.
 */
export function createGravityLayer({
  feed,
  cesium = Cesium,
  createRendering = createGravityRendering,
  eventTarget = globalThis.window,
  setTimeout: setTimeoutImpl = globalThis.setTimeout,
  clearTimeout: clearTimeoutImpl = globalThis.clearTimeout,
} = {}) {
  if (
    typeof feed?.getIndex !== 'function' ||
    typeof feed?.getField !== 'function'
  )
    throw new TypeError('Gravity requires an index and field source');
  let viewer = null;
  let rendering = null;
  let imageryHost = null;
  let enabled = false;
  let listener = null;
  let clickHandler = null;
  let index = null;
  let field = null;
  let shownId = null;
  let month = null;
  let opacity = 'strong';
  let area = 'land';
  let probe = null;
  let probeRequest = null;
  let loading = false;
  let error = null;
  let request = null;
  let playing = false;
  let playTimer = null;
  /** CSR's 0.25° land mask, fetched the first time land only is shown. */
  let landMask = null;
  let maskRequest = null;
  let maskError = null;
  /** Least recently used first. */
  const fields = new Map();
  const notify = () => listener?.();

  const solutions = () => index?.solutions || [];
  const wantedId = () => {
    const list = solutions();
    if (!list.length) return null;
    return list.some(({ id }) => id === month) ? month : list.at(-1).id;
  };
  const getHost = () =>
    imageryHost?.() ?? {
      collection: viewer?.imageryLayers ?? viewer?.scene?.imageryLayers,
      kind: 'globe',
    };
  const onMapStackChanged = () => rendering?.rehome();
  // Land only draws nothing until the mask arrives, rather than flashing the
  // oceans first; without a mask it falls back to every cell.
  const waitingForMask = () => area === 'land' && !landMask && !maskError;

  /** What is on the globe now, so an unchanged redraw is skipped. */
  let drawn = { field: null, mask: null };
  function draw() {
    if (!field || !index || waitingForMask()) return;
    const mask = area === 'land' ? landMask : null;
    if (drawn.field === field && drawn.mask === mask) return;
    drawn = { field, mask };
    rendering?.setField(
      field,
      { ...index.grid, scaleCm: index.scaleCm, noData: index.noData },
      mask,
    );
  }

  function ensureLandMask() {
    if (area !== 'land' || landMask || maskRequest || maskError) return;
    if (typeof feed.getLandMask !== 'function') {
      maskError = MASK_UNAVAILABLE;
      draw();
      return;
    }
    const controller = new AbortController();
    maskRequest = controller;
    feed
      .getLandMask({ signal: controller.signal })
      .then((mask) => {
        if (maskRequest !== controller) return;
        landMask = mask;
        if (probe) probe.land = landMaskAt(landMask, probe.lat, probe.lon);
      })
      .catch(() => {
        if (maskRequest !== controller) return;
        maskError = MASK_UNAVAILABLE;
      })
      .finally(() => {
        if (maskRequest !== controller) return;
        maskRequest = null;
        if (enabled) draw();
        notify();
      });
  }

  async function fieldFor(id, signal) {
    const cached = fields.get(id);
    if (cached) {
      fields.delete(id);
      fields.set(id, cached);
      return cached;
    }
    const next = await feed.getField(id, { signal });
    fields.set(id, next);
    while (fields.size > FIELD_CACHE) fields.delete(fields.keys().next().value);
    return next;
  }

  /** Fetch whatever is missing for the wanted month and draw it. */
  async function load({ signal, refreshIndex = false } = {}) {
    request?.abort();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    request = controller;
    loading = true;
    notify();
    try {
      if (!index || refreshIndex) {
        const next = await feed.getIndex({ signal: controller.signal });
        // A new release can revise earlier solutions, not only add one.
        if (index && next.generatedAt !== index.generatedAt) {
          fields.clear();
          shownId = null;
          if (probe) probe.history = null;
        }
        index = next;
      }
      ensureLandMask();
      const id = wantedId();
      if (id && id !== shownId) {
        const next = await fieldFor(id, controller.signal);
        if (!enabled || request !== controller) return false;
        field = next;
        shownId = id;
        draw();
        if (probe)
          probe.cm = gravityValueAt(field, index, probe.lat, probe.lon);
      }
      if (probe && !probe.history && !probeRequest) void loadHistory();
      error = null;
      return true;
    } catch (cause) {
      if (controller.signal.aborted || request !== controller) return false;
      error =
        cause?.code === 'GRAVITY_LOADING'
          ? PREPARING
          : cause?.message || UNAVAILABLE;
      return true;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (request === controller) {
        request = null;
        loading = false;
        notify();
      }
    }
  }

  /** The probed cell's value in every solution, for the card's chart. */
  async function loadHistory() {
    if (!probe || typeof feed.getCell !== 'function') return;
    probeRequest?.abort();
    const controller = new AbortController();
    probeRequest = controller;
    const target = probe;
    try {
      const cell = await feed.getCell(target.lat, target.lon, {
        signal: controller.signal,
      });
      if (probe !== target || probeRequest !== controller) return;
      target.history =
        cell.values.length === solutions().length ? cell.values : null;
      target.historyError = target.history ? null : HISTORY_UNAVAILABLE;
    } catch {
      if (probe !== target || probeRequest !== controller) return;
      target.historyError = HISTORY_UNAVAILABLE;
    } finally {
      if (probeRequest === controller) probeRequest = null;
      notify();
    }
  }

  function stopPlaying() {
    playing = false;
    if (playTimer !== null) clearTimeoutImpl(playTimer);
    playTimer = null;
  }
  /** Advance one solution once the current one is drawn; stop at the latest. */
  function scheduleStep() {
    if (playTimer !== null || typeof setTimeoutImpl !== 'function') return;
    playTimer = setTimeoutImpl(async () => {
      playTimer = null;
      if (!playing || !enabled) return;
      const list = solutions();
      const position = list.findIndex(({ id }) => id === shownId);
      if (position < 0 || position >= list.length - 1) {
        stopPlaying();
        notify();
        return;
      }
      month = list[position + 1].id;
      await load();
      if (playing) scheduleStep();
    }, GRAVITY_PLAY_STEP_MS);
  }

  function setProbe(lat, lon) {
    probeRequest?.abort();
    probeRequest = null;
    probe = {
      lat,
      lon,
      cm: gravityValueAt(field, index, lat, lon),
      land: landMaskAt(landMask, lat, lon),
      history: null,
      historyError: null,
    };
    void loadHistory();
    notify();
  }

  // A click on open ground reads the shown month at that spot. Clicks on
  // anything with an id belong to that thing's own layer.
  function installProbe() {
    if (
      clickHandler ||
      !viewer?.scene?.canvas ||
      typeof cesium.ScreenSpaceEventHandler !== 'function'
    )
      return;
    clickHandler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    clickHandler.setInputAction((click) => {
      if (!enabled || !field || !isPointerFree() || !click?.position) return;
      const picked = viewer.scene.pick?.(click.position);
      if (picked?.id !== undefined) return;
      const hit = viewer.camera?.pickEllipsoid?.(click.position);
      if (!hit) return;
      const place = cesium.Cartographic.fromCartesian(hit);
      setProbe(
        cesium.Math.toDegrees(place.latitude),
        cesium.Math.toDegrees(place.longitude),
      );
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
  }
  function removeProbe() {
    if (clickHandler && !clickHandler.isDestroyed?.()) clickHandler.destroy();
    clickHandler = null;
    probeRequest?.abort();
    probeRequest = null;
    probe = null;
  }

  function status() {
    if (loading && !playing) return t('Loading');
    if (error) return t(error);
    const drawn = rendering?.getDiagnostics?.().error;
    if (drawn) return t(drawn);
    if (area === 'land' && maskError) return t(maskError);
    return null;
  }

  const layer = {
    id: GRAVITY_LAYER_ID,
    name: 'Mass change (GRACE)',
    icon: '◍',
    source: SOURCE,
    // CSR publishes about monthly; the server checks daily.
    updateInterval: 6 * 3600_000,
    init(nextViewer) {
      viewer = nextViewer;
      rendering = createRendering({ viewer, cesium, getHost });
      eventTarget?.addEventListener?.(
        'gev:map-stack-changed',
        onMapStackChanged,
      );
    },
    attachShellServices(services) {
      imageryHost =
        typeof services?.imageryHost === 'function'
          ? services.imageryHost
          : null;
      rendering?.rehome();
    },
    enable() {
      enabled = true;
      installProbe();
    },
    disable() {
      enabled = false;
      stopPlaying();
      request?.abort();
      request = null;
      removeProbe();
      field = null;
      shownId = null;
      fields.clear();
      maskRequest?.abort();
      maskRequest = null;
      loading = false;
      error = null;
      rendering?.clear();
      drawn = { field: null, mask: null };
      notify();
    },
    async update(_viewer, { signal } = {}) {
      if (!enabled) return false;
      // A mask that failed gets another try on each scheduled refresh.
      maskError = null;
      return load({ signal, refreshIndex: true });
    },
    setParams(params = {}) {
      if (Object.hasOwn(params, 'month')) {
        const next =
          typeof params.month === 'string' && params.month
            ? params.month
            : null;
        // Choosing a month by hand ends a replay.
        if (!params.fromPlayback) stopPlaying();
        if (next !== month) {
          month = next;
          if (enabled && index) void load();
        }
      }
      if (Number.isInteger(params.step) && index) {
        stopPlaying();
        const list = solutions();
        const position = list.findIndex(({ id }) => id === shownId);
        const target = list[position + params.step];
        if (position >= 0 && target) {
          month = target.id === list.at(-1).id ? null : target.id;
          if (enabled) void load();
        }
      }
      if (params.playing === true && enabled && index && !playing) {
        // Replaying from the latest starts over from the first solution.
        const list = solutions();
        if (shownId === list.at(-1)?.id) {
          month = list[0].id;
          void load();
        }
        playing = true;
        scheduleStep();
      } else if (params.playing === false) stopPlaying();
      if (AREAS.includes(params.area) && params.area !== area) {
        area = params.area;
        ensureLandMask();
        draw();
      }
      if (Object.hasOwn(ALPHA, params.opacity)) {
        opacity = params.opacity;
        rendering?.setAlpha(ALPHA[opacity]);
      }
      if (params.clearProbe) {
        probeRequest?.abort();
        probeRequest = null;
        probe = null;
      }
      notify();
    },
    getParams() {
      return { month, opacity, area };
    },
    /** Everything the Mass change rail card draws. */
    getCardState() {
      const list = solutions();
      return {
        enabled,
        solutions: list,
        shownIndex: list.findIndex(({ id }) => id === shownId),
        latest: shownId !== null && shownId === list.at(-1)?.id,
        playing,
        area,
        opacity,
        probe: probe && { ...probe },
        status: status(),
      };
    },
    getRowControls() {
      const shown = solutions().find(({ id }) => id === shownId);
      const chips = [
        ...AREAS.map((value) => ({
          id: `area-${value}`,
          label: value === 'land' ? t('Land') : t('Land + ocean'),
          active: area === value,
          params: { area: value },
          title:
            value === 'land'
              ? t('Hide ocean cells, where the signal is mostly sea level')
              : t('Show every cell, oceans included'),
        })),
        ...['light', 'strong'].map((value) => ({
          id: `opacity-${value}`,
          label: value === 'light' ? t('Soft') : t('Vivid'),
          active: opacity === value,
          params: { opacity: value },
          title: t('Display opacity only'),
        })),
      ];
      const current = status();
      return {
        card: layer.getCardState(),
        chips,
        legend: GRAVITY_COLORS.filter(([value]) => value !== 0).map(
          ([value, color]) => ({
            label: value > 0 ? `+${value}` : `${value}`,
            color: `rgba(${color.slice(0, 3).join(',')},${(color[3] / 255).toFixed(2)})`,
            blurb: t('cm of equivalent water vs the 2004–2009 mean'),
          }),
        ),
        info:
          `${shown ? gravityMonthLabel(shown.id) : t('No month loaded')}` +
          (current ? `\n${current}` : '') +
          `\n${t('Months, playback and point history on the Mass change card')}`,
        infoTitle: t(
          'Change in mass from the GRACE and GRACE-FO satellites, in centimetres of equivalent water against the 2004–2009 mean. Red is loss, blue is gain. Each solution is published about five weeks after its month ends; there is no data from July 2017 to May 2018 between the two missions.',
        ),
      };
    },
    setRowControlsListener(value) {
      listener = typeof value === 'function' ? value : null;
    },
    getStats() {
      return {
        count: field ? 360 * 180 : 0,
        countLabel: field ? t('360×180 grid cells') : '',
        lastUpdate: index?.generatedAt ?? null,
        loading,
        error,
        stale: false,
        source: SOURCE,
        validTime: shownId,
      };
    },
    getDiagnostics() {
      return {
        month: shownId,
        solutions: solutions().length,
        cachedFields: fields.size,
        playing,
        area,
        landMask: Boolean(landMask),
        maskError,
        probe,
        ...rendering?.getDiagnostics?.(),
      };
    },
    destroy() {
      layer.disable();
      eventTarget?.removeEventListener?.(
        'gev:map-stack-changed',
        onMapStackChanged,
      );
      rendering?.destroy();
      rendering = null;
      viewer = null;
      listener = null;
      index = null;
    },
  };
  return layer;
}
