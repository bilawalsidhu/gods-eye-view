import { CCTV_AMBIENT_CARD_MAX } from '../../data/cctvLod.js';
import { formatNumber, isolate, msg, t, tn } from '../../i18n/index.js';
import { ACTIVE_FRAME_REFRESH_MS, IDLE_FRAME_REFRESH_MS } from './policy.js';
import { CAL_STATUS_WORDS } from '../../data/cctvCalibrationWords.js';
import { headingHudToken, isHeadingEstimated } from './headingConfidence.js';
import {
  specSummary,
  specFovCapabilityToken,
  isDatasheetFov,
} from './modelSpecs.js';

// The summary line names the CAL badge, the source kind and the view band in
// the page language; the codes underneath stay English.
const CAL_BADGE_LABELS = Object.freeze({
  calibrated: msg('CALIBRATED'),
  curated: msg('CURATED'),
  'raw-prior': msg('RAW PRIOR'),
});

// The same source-kind words as the CCTV panel (src/ui/cctvFrames.js).
const SOURCE_KIND_LABELS = Object.freeze({
  snapshot: msg('SNAPSHOT'),
  live: msg('LIVE'),
  fallback: msg('FALLBACK'),
  upstream: msg('UPSTREAM'),
  synthetic: msg('SYNTHETIC'),
  configured: msg('CONFIGURED'),
  seed: msg('SEED'),
  image: msg('IMAGE'),
  unknown: msg('UNKNOWN'),
});

/** CAL badge id ('raw-prior') as the summary shows it; unknown ids stay codes. */
export function summaryCalLabel(badge) {
  const key = String(badge || '');
  return CAL_BADGE_LABELS[key]
    ? t(CAL_BADGE_LABELS[key])
    : key.replace('-', ' ').toUpperCase();
}

// Source kinds as named in the camera scene summary.
const SOURCE_KIND_WORDS = Object.freeze({
  snapshot: msg('Snapshot'),
  live: msg('Live video'),
  fallback: msg('Fallback image'),
  upstream: msg('Upstream image'),
  synthetic: msg('Synthetic'),
  configured: msg('Configured'),
  seed: msg('Seed'),
  image: msg('Image'),
  unknown: msg('Unknown'),
});

/** Source kind ('image', 'snapshot') for the summary; HLS, MJPEG… stay codes. */
export function summarySourceLabel(kind) {
  const key = String(kind || 'image').toLowerCase();
  return SOURCE_KIND_LABELS[key]
    ? t(SOURCE_KIND_LABELS[key])
    : key.toUpperCase();
}

/** View band id ('street', 'city'…) as the HUD names it. */
export function summaryViewBandLabel(band) {
  switch (band) {
    case 'street':
      return t('STREET', { context: 'view band' });
    case 'city':
      return t('CITY', { context: 'view band' });
    case 'regional':
      return t('REGIONAL', { context: 'view band' });
    case 'global':
      return t('GLOBAL', { context: 'view band' });
    default:
      return String(band || '').toUpperCase();
  }
}

const coverageAreaText = (area) =>
  formatNumber(area, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function createPresentation({
  state: layerState,
  services,
  parts,
  source,
}) {
  function summaryFacts(active) {
    if (!active) return null;
    const { camera } = active;
    return {
      area: coverageAreaText(
        parts.model.sectorAreaKm2(camera.rangeM, camera.fovDeg),
      ),
      overlap: parts.geometry.coverageNeighborCount(active),
      badge: parts.calibration.deriveCalBadge(camera),
      kind:
        layerState._healthById.get(camera.id)?.sourceKind ||
        camera.feedType ||
        'image',
    };
  }

  /**
   * Builds a single-line summary string for the active camera, including city,
   * heading, FOV, coverage area, overlap count, projection mode, alignment
   * confidence, source type, and view context.
   * @returns {string} Summary text separated by mid-dots.
   */

  function buildSummaryText(
    active = parts.selection.getActiveRecord(),
    facts = summaryFacts(active),
  ) {
    if (!active) {
      return layerState._records.length
        ? t(
            '{count} CAMERAS STANDING BY · NO CAMERA SELECTED · CLICK A CAMERA TO ACTIVATE',
            {
              count: layerState._records.length,
            },
          )
        : t('No cameras available in catalog.');
    }

    const { area, overlap, badge, kind } = facts;
    const viewKey = parts.model.currentViewContext();
    const viewBand = viewKey.split(':')[0] || 'global';

    // Each part is isolated: in right-to-left text a code keeps its own value
    // (FOV 44°) instead of trading it with its neighbour.
    return [
      t('{city} CCTV', {
        city: active.camera.city.toUpperCase(),
      }),
      `${active.camera.name.toUpperCase()}`,
      // A synthetic bearing (headingConfidence 'low', no human calibration)
      // is tagged so a hashed guess never reads as a surveyed facing (#639).
      headingHudToken(active.camera),
      // Identified hardware labels its FOV as datasheet-sourced (catalog.js)
      // only while no manual calibration offset has moved it.
      isDatasheetFov(active.camera)
        ? t('FOV {value}° (DATASHEET)', {
            value: Math.round(active.camera.fovDeg),
          })
        : t('FOV {value}°', {
            value: Math.round(active.camera.fovDeg),
          }),
      // A PTZ/varifocal datasheet range is what the lens can do, not its
      // current zoom, so it is shown beside the estimate, never as it.
      specFovCapabilityToken(active.camera, (span) =>
        t('SPEC FOV {span}° (CAPABILITY)', { span }),
      ),
      t('COVERAGE {value}km²', { value: area }),
      overlap > 0
        ? t('OVERLAP {count} cams', { count: overlap })
        : t('ISOLATED VIEW'),
      layerState._showProjection ? t('PROJ MONITOR') : t('PROJ OFF'),
      layerState._coverageMode === 'viewshed' ? t('VIEWSHED') : null,
      t('CAL {value}', { value: summaryCalLabel(badge) }),
      t('SRC {value}', {
        value: summarySourceLabel(kind),
      }),
      t('{value} CONTEXT', { value: summaryViewBandLabel(viewBand) }),
      // Identified hardware: append the model's datasheet specs + attribution.
      active.camera.spec
        ? t('{spec} · SPECS: CCTV-DATABASE.COM', {
            spec: specSummary(active.camera.spec).toUpperCase(),
          })
        : null,
    ]
      .filter(Boolean)
      .map(isolate)
      .join(' · ');
  }

  /**
   * The scene summary as labelled lines for the camera tools: what the
   * active camera covers, how many others overlap it, whether its picture
   * is projected, its calibration and its source. Empty with no camera.
   * @returns {Array<{label: string, value: string}>}
   */
  function buildSummaryLines(facts) {
    if (!facts) return [];
    const { area, overlap, badge, kind } = facts;
    return [
      {
        label: t('Coverage'),
        value: isolate(t('{value} km²', { value: area })),
      },
      {
        label: t('Overlap'),
        value:
          overlap > 0
            ? tn(overlap, '{count} camera', '{count} cameras')
            : t('No other camera'),
      },
      {
        label: t('Projection'),
        value: layerState._showProjection ? t('On') : t('Off'),
      },
      {
        label: t('Calibration'),
        value: CAL_STATUS_WORDS[badge] ? t(CAL_STATUS_WORDS[badge]) : badge,
      },
      {
        label: t('Source'),
        value: SOURCE_KIND_WORDS[kind] ? t(SOURCE_KIND_WORDS[kind]) : kind,
      },
    ];
  }

  /**
   * Builds a public-facing camera state object for UI consumption.
   * Includes all pose, calibration, CAL badge, projection, and feed metadata.
   * @param {Object} record - Camera record.
   * @param {string|null} [activeId=null] - Active camera ID for the `active` flag.
   * @returns {Object} Public camera state.
   */

  function getPublicCameraState(record, activeId = null) {
    const resolvedActiveId =
      activeId || parts.selection.getActiveRecord()?.camera.id || null;
    const camera = record.camera;
    const health = layerState._healthById.get(camera.id) || null;
    const isActive = camera.id === resolvedActiveId;
    const defaultRefreshMs = isActive
      ? ACTIVE_FRAME_REFRESH_MS
      : IDLE_FRAME_REFRESH_MS;
    const sourceRefreshMs = Number(camera.frameRefreshMs);
    const refreshMs =
      Number.isFinite(sourceRefreshMs) && sourceRefreshMs > 0
        ? Math.max(defaultRefreshMs, sourceRefreshMs)
        : defaultRefreshMs;
    const isVideo =
      parts.model.isVideoFeedCamera(camera) &&
      record.projection?.mode !== 'image';
    return {
      id: camera.id,
      name: camera.name,
      city: camera.city,
      provider: camera.provider,
      lat: camera.lat,
      lon: camera.lon,
      headingDeg: camera.headingDeg,
      // Bearing provenance (#639): the pack's confidence flag plus the derived
      // "is this a synthetic guess" bit (calibration-aware), so UI consumers
      // never have to re-derive it.
      headingConfidence: camera.headingConfidence || null,
      headingEstimated: isHeadingEstimated(camera),
      pitchDeg: camera.pitchDeg,
      fovDeg: camera.fovDeg,
      // Identified-hardware enrichment passthrough (catalog.js / modelSpecs.js).
      fovSource: isDatasheetFov(camera)
        ? 'datasheet'
        : camera.fovSource === 'datasheet'
          ? 'calibrated'
          : camera.fovSource || 'estimated',
      specFovMinDeg: camera.specFovMinDeg ?? null,
      specFovMaxDeg: camera.specFovMaxDeg ?? null,
      spec: camera.spec || null,
      rangeM: camera.rangeM,
      elevationM: camera.absoluteHeightM,
      mountHeightM: camera.mountHeightM,
      active: isActive,
      feedType: camera.feedType,
      sourceUrl: camera.sourceUrl || '',
      browserMediaUrl: camera.browserMediaUrl || '',
      accuracyM: Number.isFinite(camera.accuracyM) ? camera.accuracyM : null,
      positionSource: camera.positionSource || '',
      isVideo,
      liveSnapshotUrl:
        isVideo && camera.hasSnapshot
          ? parts.frames.frameUrlFor(camera, refreshMs, { snapshotOnly: true })
          : '',
      sourceKind: camera.sourceKind?.startsWith('quebec-')
        ? camera.sourceKind
        : health?.sourceKind ||
          camera.sourceKind ||
          (camera.feedConfigured ? 'configured' : 'seed'),
      sourceStatus: health?.status || 'unknown',
      sourceMessage: health?.message || '',
      sourceLabel: health?.label || camera.provider || '',
      credit: camera.credit || '',
      calibration: {
        ...parts.calibration.normalizeCalibration(camera.calibration),
      },
      // Save-gated persistence (design §3e): true while the live pose carries
      // edits that have not been SAVEd (or RESET). Drives the CAL · EDITED chip.
      calDirty: !!record.calDirty,
      // Deterministic QA seam: counts commit-grade anchor resolutions (E/N drag
      // release, numeric E/N edit, or reset), never transient gizmo moves.
      groundResolveCount: record.calibrationGroundResolveCount || 0,
      // Per-record QA seam for proving transient gizmo moves never enter the
      // shared mesh-floor sampler while unrelated catalog cells finish.
      groundMeshSampleRequestCount: record.groundMeshSampleRequestCount || 0,
      // Datum QA seam: expose the immutable Re:Earth ellipsoidal prior
      // separately from the currently applied frustum ground. Google-3D may
      // legitimately refine the latter to the rendered mesh, so callers must
      // not infer the prior by subtracting mount height from live geometry.
      // A height read from drawn terrain is unavailable as a Re:Earth prior.
      groundPriorM:
        Number.isFinite(record.groundPrior?.ellipsoid) &&
        record.groundPrior.source !== 'drawn-terrain'
          ? record.groundPrior.ellipsoid
          : null,
      intrinsics: camera.intrinsics ? { ...camera.intrinsics } : null,
      extrinsics: camera.extrinsics ? { ...camera.extrinsics } : null,
      anchor: camera.anchor ? { ...camera.anchor } : null,
      // Panel-only trust signal (design §3b, amended by LOCKED §9.2/§9.3): no
      // in-world rendering reads this, no score-based quality math backs it.
      calBadge: parts.calibration.deriveCalBadge(camera),
      poseSource: camera.poseSource || null,
      basePose: camera.basePose ? { ...camera.basePose } : null,
      frameUrl: parts.frames.frameUrlFor(camera, refreshMs),
      mediaUrl: parts.frames.mediaUrlFor(camera),
    };
  }

  /**
   * Assembles the full UI state payload containing layer toggles, camera list,
   * active camera details, summary text, and error state.
   * @returns {Object} Complete UI state for subscribers.
   */

  function uiState() {
    const active = parts.selection.getActiveRecord();
    const activeId = active?.camera.id || null;
    const facts = summaryFacts(active);
    const payload = {
      enabled: layerState._enabled,
      // Compat boolean + the full tri-state (viewshed design §3b).
      showCoverage: layerState._coverageMode !== 'off',
      coverageMode: layerState._coverageMode,
      showProjection: layerState._showProjection,
      calibrationMode: layerState._calibrationMode,
      autoHop: layerState._autoHop,
      autoHopSuspended: layerState._autoHopSuspended,
      autoHopSec: layerState._autoHopSec,
      summaryLines: buildSummaryLines(facts),
      count: layerState._count,
      lastUpdate: layerState._lastUpdate,
      error: layerState._lastError,
      loading: {
        active: layerState._geoLoading,
        loaded: Math.min(layerState._geoLoadDone, layerState._geoLoadTotal),
        total: layerState._geoLoadTotal,
      },
      // Ambient card tier telemetry (QA harnesses assert the fetch pacing —
      // minFrameFetchSpacingMs reads together with fetchMode: cold-fill bursts
      // legitimately reach ~250 ms, steady state stays >=1000 ms).
      ambientCards: {
        count: layerState._cardIds.size,
        limit: CCTV_AMBIENT_CARD_MAX,
        frameFetches: layerState._cardFetchCount,
        minFrameFetchSpacingMs: layerState._cardMinFetchSpacingMs,
        fetchMode: layerState._cardFetchMode,
        fetchesInFlight: layerState._cardFetchInFlightCount,
        // Item B QA seam: the hover-summoned pinned card, if any.
        hoverId: layerState._hoverCardId,
      },
      activeCameraId: activeId,
      // Layer-owned opening, restored and timed steps leave Context on its
      // current card. A manual or voice step is a pick even with Auto-hop on.
      openingCamera: Boolean(
        activeId &&
        (layerState._openingCameraProvisional || layerState._quietActivation),
      ),
      activeCameraReselection: layerState._activeCameraReselection,
      activeCamera: active ? getPublicCameraState(active, activeId) : null,
      summary: buildSummaryText(active, facts),
    };
    // The full per-camera state is built only when a subscriber reads it: a
    // catalog of tens of thousands would otherwise be rebuilt on every
    // progress tick for listeners that only want the active camera. It reads
    // the records live at that moment, and spreading or serializing the
    // payload builds it, so callers that want a count use `count`.
    let cameras = null;
    Object.defineProperty(payload, 'cameras', {
      enumerable: true,
      get() {
        cameras ??= layerState._records.map((record) =>
          getPublicCameraState(record, activeId),
        );
        return cameras;
      },
    });
    return payload;
  }

  /** Dispatches the current UI state to all registered subscriber callbacks. */

  function notifyListeners() {
    const payload = uiState();
    for (const callback of layerState._listeners) {
      try {
        callback(payload);
      } catch (error) {
        console.warn('[Data:CCTV] listener error:', error);
      }
    }
  }

  /**
   * Throttled notifyListeners for transient (mid-drag) calibration patches —
   * the panel re-render is DOM-heavy, so live gizmo drags publish state at
   * ≤10 Hz while the in-world geometry still tracks every processed move.
   */

  function notifyListenersThrottled() {
    const now = Date.now();
    if (now - layerState._lastTransientNotifyAt < 100) return;
    layerState._lastTransientNotifyAt = now;
    notifyListeners();
  }
  return {
    buildSummaryText,
    getPublicCameraState,
    uiState,
    notifyListeners,
    notifyListenersThrottled,
  };
}
