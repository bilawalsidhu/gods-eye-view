import { fireDetectionKey } from '../../data/firmsLabels.js';
import {
  FIRMS_CONFIDENCE_MODES,
  FRP_SLIDER_TICKS,
  firePassesFilter,
  frpForSliderPosition,
  normalizeFireFilter,
  rampTrackGradient,
  sliderPositionForFrp,
} from '../../data/firmsIntensity.js';
import { formatNumber, t } from '../../i18n/index.js';
import { LOD_LEVELS, REFRESH_INTERVAL_MS } from './policy.js';

/** Slider resolution: whole-percent positions along the log axis. */
const SLIDER_STEPS = 1000;

export function createQueries({
  layerState,
  services,
  components,
  config,
  feed,
}) {
  const { id, name, icon, source } = config;

  /** Whole-megawatt label for a slider value or tick ("0", "20", "1 000"). */
  function frpLabel(frp) {
    return formatNumber(frp, { maximumFractionDigits: 0 });
  }

  const confidenceLabels = () => ({
    all: t('All', { context: 'fire confidence filter' }),
    nominal: t('Nominal+', { context: 'fire confidence filter' }),
    high: t('High', { context: 'fire confidence filter' }),
  });

  const confidenceTitles = () => ({
    all: t(
      'Every detection — many of the strongest fires are rated low confidence',
    ),
    nominal: t('Nominal and high confidence detections'),
    high: t('High confidence detections only'),
  });

  const methods = {
    /** Return the selected detection as a plain record for application consumers. */
    getSelectedInfo() {
      const fire = layerState._selectedFire;
      if (!fire) return null;
      return {
        id: fireDetectionKey(fire),
        // i18n-ignore: English entity label; the voice card translates it (shownEntityLabel)
        label: `Fire · FRP ${components.model.formatFrp(fire.frp)} MW`,
        latitude: fire.lat,
        longitude: fire.lon,
        frp: fire.frp,
        confidencePct: Number.isFinite(fire.confidence)
          ? fire.confidence * 100
          : null,
        observedAt:
          Number.isFinite(fire.acqMs) && fire.acqMs > 0 ? fire.acqMs : null,
        source: fire.sensor || fire.satellite || null,
      };
    },

    id,

    name,

    icon,

    source,

    // The one data-layer control a provider key gates: the proxy answers
    // 503 {error:'no_key'} without a FIRMS key. Declared as a key-registry id
    // rather than an env-var string, so the panel can name the key from the
    // one place that owns what each key is called.
    requiresKeyId: 'firms',

    // Live layer: the manager calls update() every 10 minutes while enabled,
    // which refetches through the /api/firms proxy (the proxy's 30 min TTL —
    // not this interval — is what protects the upstream FIRMS quota).
    updateInterval: REFRESH_INTERVAL_MS,

    /**
     * The intensity filter as layer options (share token `w`, owner
     * `local-firms` in layerState.js).
     * @returns {{minFrp: number, confidence: string}}
     */
    getParams() {
      return { ...layerState._filter };
    },

    /**
     * Apply a (partial) intensity filter. Invalid fields keep their current
     * value. The filter runs in one place (ingestion.applyFilter) and the LOD
     * rebuild re-derives markers, cells, cards and context registrations from
     * the shown set; a selected fire that no longer passes is deselected.
     * @param {{minFrp?: number, confidence?: string}} params
     * @returns {boolean} True — the request is always accepted.
     */
    setParams(params = {}) {
      const next = normalizeFireFilter(params, layerState._filter);
      if (
        next.minFrp === layerState._filter.minFrp &&
        next.confidence === layerState._filter.confidence
      )
        return true;
      layerState._filter = next;
      if (!layerState._allFires.length) return true;
      components.ingestion.applyFilter();
      if (
        layerState._selectedFire &&
        !firePassesFilter(layerState._selectedFire, next)
      ) {
        components.selection.clearFireSelection();
      }
      if (layerState._enabled) components.rendering.renderCurrentLod(true);
      layerState._rowControlsListener?.();
      return true;
    },

    /**
     * Row controls under the Active Fires row: the log-scale minimum-FRP
     * slider whose track is painted with the intensity ramp (so it doubles as
     * the legend), the All / Nominal+ / High confidence switch, and the
     * "N of M shown" counter.
     */
    getRowControls() {
      const { minFrp, confidence } = layerState._filter;
      const labels = confidenceLabels();
      const titles = confidenceTitles();
      const shown = layerState._count;
      const total = layerState._totalCount;
      return {
        slider: {
          id: 'min-frp',
          label: t('Fire intensity (FRP)'),
          ariaLabel: t('Minimum fire radiative power, megawatts'),
          valueText:
            minFrp > 0
              ? t('≥ {value} MW', { value: frpLabel(minFrp) })
              : t('All', { context: 'fire intensity filter' }),
          min: 0,
          max: SLIDER_STEPS,
          step: 1,
          value: Math.round(sliderPositionForFrp(minFrp) * SLIDER_STEPS),
          track: rampTrackGradient(),
          ticks: FRP_SLIDER_TICKS.map((frp) => ({
            at: sliderPositionForFrp(frp),
            label: frpLabel(frp),
          })),
          params: (value) => ({
            minFrp: frpForSliderPosition(Number(value) / SLIDER_STEPS),
          }),
        },
        segmented: {
          id: 'confidence',
          label: t('Confidence'),
          ariaLabel: t('Detection confidence'),
          options: FIRMS_CONFIDENCE_MODES.map((mode) => ({
            id: `confidence-${mode}`,
            label: labels[mode],
            title: titles[mode],
            active: mode === confidence,
            params: { confidence: mode },
          })),
        },
        info: total
          ? t('{shown} of {total} shown', {
              shown: formatNumber(shown),
              total: formatNumber(total),
            })
          : '',
      };
    },

    /**
     * Install the panel's "row controls changed" callback: a load or a filter
     * change moves the counter, and nothing else repaints the row before the
     * next scheduled refresh.
     * @param {(() => void)|null} listener
     */
    setRowControlsListener(listener) {
      layerState._rowControlsListener =
        typeof listener === 'function' ? listener : null;
    },

    /**
     * Layer stats for the data panel. Degraded feed states surface through
     * `error` (established qa-failstate pattern: a dead feed must never look
     * like a healthy empty layer) with a matching human `loadingLabel`:
     * 'LIVE · updated Xm ago' fresh, 'STALE · cached Xh' when the proxy
     * served past-TTL cache, 'KEY REQUIRED' keyless.
     */
    getStats() {
      const now = Date.now();
      const staleText = layerState._lastUpdate
        ? t('STALE · cached {age}', {
            age:
              components.model.formatAgeLabel(now - layerState._lastUpdate) ||
              t('<1h', { context: 'age' }),
          })
        : t('STALE');
      let loadingLabel = '';
      if (layerState._loading) {
        loadingLabel = layerState._fires.length
          ? t('refreshing...')
          : t('loading...');
      } else if (layerState._keyRequired) {
        loadingLabel = t('KEY REQUIRED');
      } else if (layerState._stale) {
        loadingLabel = staleText;
      } else if (layerState._error) {
        loadingLabel = layerState._error;
      } else if (layerState._lastUpdate) {
        loadingLabel = t('LIVE · updated {age}', {
          age: components.model.formatAgoMinutes(now - layerState._lastUpdate),
        });
      }
      return {
        // Shown (filtered) detections; `total` is the loaded payload.
        count: layerState._count,
        total: layerState._totalCount,
        cells: layerState._cellCount,
        lastUpdate: layerState._lastUpdate,
        loading: layerState._loading,
        stale: layerState._stale,
        // The machine-readable half of the keyless state, ahead of the human
        // strings below: without it "no key configured" is indistinguishable
        // from a broken feed, and the row reads as a fault instead of a step
        // the operator can take.
        keyRequired: layerState._keyRequired,
        error: layerState._keyRequired
          ? t('KEY REQUIRED')
          : layerState._stale
            ? staleText
            : layerState._error,
        loadingLabel,
      };
    },

    /**
     * Strongest currently-loaded detection (by FRP) for voice targeting
     * ("take me to the biggest fire").
     * @returns {{latitude: number, longitude: number, frp: number, label: string}|null}
     */
    getStrongestFire() {
      const strongest = layerState._firesByFrp.length
        ? layerState._firesByFrp[0]
        : null;
      if (!strongest) return null;
      return {
        latitude: strongest.lat,
        longitude: strongest.lon,
        frp: strongest.frp,
        // i18n-ignore: English entity label; the voice card translates it (shownEntityLabel)
        label: `Fire · FRP ${components.model.formatFrp(strongest.frp)} MW`,
      };
    },

    /**
     * Detection-overlay seam, shaped like the other layers' detectable
     * objects (traffic/flights). NOT yet registered in initDetection's layer
     * list — wiring fires through the detection/label-arbiter pipeline is a
     * deliberate post-PR#1 task; when that happens the arbiter replaces this
     * layer's greedy declutter as the SELECTOR and the shared overlay remains
     * the renderer. Walks the FRP-sorted index so the strongest fires come first.
     * @param {{maxCount?: number}} [options]
     * @returns {Array<{position: Cesium.Cartesian3, id: string, type: string}>}
     */
    getDetectableObjects(options = {}) {
      if (!layerState._enabled || !layerState._firesByFrp.length) return [];
      const maxCount = Number.isFinite(options.maxCount)
        ? Math.max(1, Math.floor(options.maxCount))
        : 250;
      const result = [];
      for (const fire of layerState._firesByFrp) {
        result.push({
          position: components.model.firePosition(fire),
          id: `FIRE-${String(fire.index).padStart(5, '0')}`,
          type: 'FIRE',
        });
        if (result.length >= maxCount) break;
      }
      return result;
    },

    /**
     * Snapshot the layer's in-memory fire records as plain JSON-safe
     * objects for the analyst query engine. Walks the FRP-sorted index so
     * truncation keeps the STRONGEST fires (200k+ detections can be live —
     * the cap is load-bearing, not cosmetic). On-demand only (called at
     * most once per spoken query) — zero per-frame cost, no listeners, no
     * caching. Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!layerState._enabled || !layerState._firesByFrp.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const fire of layerState._firesByFrp) {
        result.push(components.model.mapAnalystRecord(fire));
        if (result.length >= limit) break;
      }
      return result;
    },

    /** Test seam: render one named LOD band against a near-global view. */
    _renderLodForTest(lodId) {
      const lod = LOD_LEVELS.find((level) => level.id === lodId);
      if (lod.mode === 'detections')
        components.rendering.renderDetections(lod, null);
      else components.rendering.renderHeat(lod, null);
    },

    /** Test seam: entities drawn by the layer's data source. */
    _entityCountForTest() {
      return layerState._dataSource?.entities?.values?.length ?? 0;
    },

    /** Test seam that binds the production click path and indexes. */
    _bindInteractionForTest(viewer, fires = []) {
      layerState._viewer = viewer;
      layerState._enabled = true;
      layerState._allFires = fires;
      layerState._allFiresByFrp = [...fires];
      layerState._fires = fires;
      layerState._firesByFrp = [...fires];
      layerState._count = fires.length;
      layerState._totalCount = fires.length;
      layerState._pickIndexById.clear();
      layerState._labelLodDistance = 1e7;
      layerState._labelCandidates = fires.map((fire) => {
        layerState._pickIndexById.set(`firms-${fire.index}`, fire);
        return { fire, position: components.model.firePosition(fire) };
      });
      components.cards.rebuildAmbientLabels();
      components.selection.installClickHandler();
      return layerState._clickHandler;
    },
  };

  return { methods };
}
