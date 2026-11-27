import { keepCodesWithValues, msg, t, tn } from '../i18n/index.js';
import {
  cctvSourceLabelText,
  cctvSourceMessageText,
  isCctvLiveFrameFallback,
} from './cctvFrames.js';

import { createCctvVideoSurface } from './cctvVideo.js';
import { CCTV_SELECTED_EVENT } from './cctvEvents.js';
import { presentCctvCalibration } from './cctvCalibration.js';
import { CAL_STATUS_WORDS } from '../data/cctvCalibrationWords.js';
import { roundHeadingDegrees } from '../data/headingDegrees.js';
import {
  MOBILE_SHELL_CLASS,
  MOBILE_SHEET_ATTR,
  sheetForPanelId,
} from './mobileSheets.js';

// The camera tools and the camera card both sit in Context.
const CONTEXT_SHEET = sheetForPanelId('global-context-panel');

export function _calBadgeLabel(badge) {
  switch (badge) {
    case 'calibrated':
      return t('CALIBRATED');
    case 'curated':
      return t('CURATED');
    case 'raw-prior':
      return t('RAW PRIOR');
    default:
      return '--';
  }
}

/**
 * The camera tools' buttons, CAL chip and meta line for a camera state, as
 * Context's Camera settings tab renders them. Pure: the frame, source badge,
 * calibration readout and summary stay with the controls.
 * @param {object|null} state Camera layer UI state.
 * @param {boolean} enabled Whether the layer is on.
 */
export function presentCctvPanel(state, enabled) {
  const catalogCount = Number.isFinite(state?.count)
    ? state.count
    : (state?.cameraIndex?.length ?? state?.cameras?.length ?? 0);
  const activeCamera = state?.activeCamera || null;
  // Tri-state (viewshed design §3b): off → on (wireframes) → viewshed
  // (color-coded volumes). The click handler cycles; this renders.
  const coverage = state?.coverageMode || (state?.showCoverage ? 'on' : 'off');
  const autoHop = !!state?.autoHop;
  const showProjection = state?.showProjection !== false;
  // CAL badge (cctv-v2 design §3b, amended by LOCKED §9.2 — panel-only, no
  // in-world tint): three states from cctv.js's deriveCalBadge. Unsaved live
  // edits show EDITED over the persisted state (viewshed design §3e): SAVE
  // CAL promotes to CALIBRATED, RESET CAL clears.
  const badge = activeCamera?.calBadge || null;
  const dirty = !!activeCamera?.calDirty;
  const calBadge = dirty ? 'edited' : badge || '';
  const status = CAL_STATUS_WORDS[calBadge];
  return {
    enabled,
    hasLiveSnapshot: Boolean(activeCamera?.liveSnapshotUrl),
    activeCredit: (enabled && activeCamera?.credit) || '',
    framePose:
      enabled && activeCamera
        ? {
            heading: roundHeadingDegrees(activeCamera.headingDeg),
            estimated: Boolean(activeCamera.headingEstimated),
            fov: activeCamera.fovDeg,
            range: activeCamera.rangeM,
          }
        : null,
    stillSuppressed:
      enabled && Boolean(activeCamera?.sourceKind?.startsWith('quebec-')),
    // Which camera the tools and the live video belong to.
    activeCameraId: state?.activeCameraId || '',
    activeCameraLabel: [activeCamera?.city, activeCamera?.name]
      .filter(Boolean)
      .join(' · '),
    // Who publishes the active camera, and the owner a partner-supplied feed
    // names: the camera card shows both.
    source: activeCamera
      ? {
          provider: cctvSourceLabelText(
            activeCamera.sourceLabel || activeCamera.provider || '',
          ),
          credit: String(activeCamera.credit || ''),
        }
      : null,
    toggleDisabled: !enabled,
    coverage: {
      active: coverage !== 'off',
      mode: coverage,
      text:
        coverage === 'viewshed'
          ? t('VIEWSHED ON')
          : coverage === 'on'
            ? t('COVERAGE ON')
            : t('COVERAGE OFF'),
    },
    autoHop: {
      active: autoHop,
      text: autoHop ? t('AUTO HOP ON') : t('AUTO HOP OFF'),
      // Seconds on each camera before the next.
      sec: Number.isFinite(state?.autoHopSec) ? state.autoHopSec : null,
    },
    projection: {
      active: showProjection,
      text: showProjection ? t('PROJECTION ON') : t('PROJECTION OFF'),
    },
    quality: {
      label: dirty
        ? t('CAL · EDITED (UNSAVED)')
        : t('CAL · {badge}', { badge: _calBadgeLabel(badge) }),
      calBadge,
      // The same, as a sentence for the camera tools.
      status: status ? t(status) : '',
    },
    // The scene summary as labelled lines (layers/cctv/presentation.js).
    summaryLines: Array.isArray(state?.summaryLines) ? state.summaryLines : [],
    meta: metaText(state, enabled, activeCamera, catalogCount),
    calibration: presentCctvCalibration(state, enabled),
  };
}

function metaText(state, enabled, activeCamera, catalogCount) {
  // The layer keeps its active camera while off: a disabled panel must not
  // describe a feed it no longer shows.
  if (enabled && activeCamera) {
    const provider = cctvSourceLabelText(
      activeCamera.sourceLabel || activeCamera.provider || 'Configured Source',
    );
    const statusMsg =
      activeCamera.sourceMessage && !isCctvLiveFrameFallback(activeCamera)
        ? ` · ${cctvSourceMessageText(activeCamera.sourceMessage)}`
        : '';
    // A partner-supplied feed inside a pack names its owner here.
    const credit = activeCamera.credit ? ` · ${activeCamera.credit}` : '';
    const calBadge = activeCamera.calBadge
      ? _calBadgeLabel(activeCamera.calBadge)
      : '';
    const projLabel = state?.showProjection !== false ? t('MONITOR') : t('OFF');
    return keepCodesWithValues(
      t(
        '{city} · HDG {heading} · FOV {fov} · RANGE {range}m · {projection}{calBadge} · {provider}{status}',
        {
          city: activeCamera.city,
          heading: `${roundHeadingDegrees(Number(activeCamera.headingDeg)) ?? 0}°`,
          fov: `${Math.round(activeCamera.fovDeg)}°`,
          range: Math.round(activeCamera.rangeM),
          projection: projLabel,
          calBadge: calBadge ? ` · ${calBadge}` : '',
          provider,
          status: `${credit}${statusMsg}`,
        },
      ),
    );
  }
  if (catalogCount > 0)
    return enabled
      ? tn(
          catalogCount,
          '{count} camera loaded · click a camera to activate',
          '{count} cameras loaded · click a camera to activate',
        )
      : tn(
          catalogCount,
          '{count} camera loaded · enable CCTV to activate',
          '{count} cameras loaded · enable CCTV to activate',
        );
  return t('Enable CCTV to load camera intersections');
}

export function _renderCctvState(state) {
  if (this.destroyed) return;
  if (
    !state?.enabled ||
    !this.actions.isEnabled() ||
    state?.activeCameraId !== this._cctvState?.activeCameraId
  ) {
    this._calibrationEdit?.(false);
  }
  this._cctvState = state || null;
  const enabled = !!state?.enabled && !!this.actions.isEnabled();
  const activeId = state?.activeCameraId || '';
  const activeCamera = state?.activeCamera || null;
  const selectionRevision = Number(state?.activeCameraReselection);
  const reselected =
    this._lastQuebecSelectionRevision !== null &&
    Number.isFinite(selectionRevision) &&
    selectionRevision !== this._lastQuebecSelectionRevision;
  this._lastQuebecSelectionRevision = Number.isFinite(selectionRevision)
    ? selectionRevision
    : null;
  const view = presentCctvPanel(state, enabled);
  const isQuebecCamera = view.stillSuppressed;
  view.hasQuebecPlayer = isQuebecCamera && Boolean(this._quebecCctvOverlay);
  this._quebecCctvOverlay?.setCamera(isQuebecCamera ? activeCamera : null, {
    reselected,
  });
  if (this._cctvFrameWrap) this._cctvFrameWrap.hidden = Boolean(isQuebecCamera);

  // A camera someone picks (a click on the globe, next/previous, voice or
  // Context's own lists) opens its card in Context, even right after an
  // empty-ground deselect left no camera active. The layer's own opening
  // camera, the first enable render and an Auto-hop timer step stay quiet.
  // A manual or voice step with Auto-hop on still opens its card.
  const effectiveActiveId = enabled ? activeId || null : null;
  if (
    effectiveActiveId &&
    this._lastSeenCctvEnabled &&
    effectiveActiveId !== this._lastSeenCctvActiveId &&
    !state?.openingCamera
  ) {
    globalThis.document?.dispatchEvent?.(
      new CustomEvent(CCTV_SELECTED_EVENT, {
        detail: { cameraId: effectiveActiveId },
      }),
    );
  }
  this._lastSeenCctvActiveId = effectiveActiveId;
  this._lastSeenCctvEnabled = enabled;
  this._updateCctvSyncChip(state?.loading, enabled);

  this.store.publish(view);

  const liveIntent =
    enabled && !!activeCamera?.isVideo && !activeCamera?.browserMediaUrl;
  if (this.store.live !== liveIntent) this._clearCctvFrame();
  this.store.setLive(liveIntent);
  // A background tab or a closed phone sheet shows
  // no picture; the observers and visibilitychange render again on showing.
  const body = globalThis.document?.body;
  const phone = body?.classList.contains(MOBILE_SHELL_CLASS);
  const sheet = body?.getAttribute(MOBILE_SHEET_ATTR);
  const tabShown = !!body && !document.hidden;
  // A Context preview can outlive CCTV's selection when the feed changes.
  const cardShown =
    tabShown &&
    this.store.previewCards.includes(activeId) &&
    (!phone || sheet === CONTEXT_SHEET);
  // Its bigger view is a popup over the map, shown on any phone sheet.
  const popupShown = tabShown && this.store.previewPopups.includes(activeId);
  const previewShown = cardShown || popupShown;
  const holdingSettings =
    tabShown &&
    this.store.settingsVisible &&
    this.store.settingsCameraId === activeId;
  this.cctv.setPreviewedCamera?.(
    enabled && (previewShown || holdingSettings) ? activeId : null,
  );
  if (this._cctvVideo) {
    // A live video plays only while its canvas sits in a camera card's top
    // image: the card moves it there from its hidden home. (The dock paints
    // its own canvas from the same decoder.) On a phone the card shows only
    // on Context's sheet, or in its bigger view over the map.
    const visible =
      liveIntent &&
      previewShown &&
      Boolean(this._cctvVideo.closest?.('.cctv-preview'));
    this.cctv.setVideoConsumer?.('card', visible ? activeId : null);
    if (!visible || this._cctvVideoCameraId !== activeId) {
      this._cctvVideoSurface?.stop();
      this._cctvVideoSurface = null;
      this.store.setLiveState('');
    }
    this._cctvVideoCameraId = activeId;
    if (visible && !this._cctvVideoSurface) {
      // The card says what it shows: no LIVE · OK over a canvas that has
      // not drawn a frame yet, or one whose stream stopped.
      const surface = createCctvVideoSurface(
        this._cctvVideo,
        () => this.cctv.getActiveVideoElement?.(),
        {
          onState: (next) => {
            if (this.destroyed || this._cctvVideoSurface !== surface) return;
            this.store.setLiveState(next);
            this._syncCctvSourceBadge(
              this._cctvState?.activeCamera,
              !!this._cctvState?.enabled && !!this.actions.isEnabled(),
            );
          },
        },
      );
      this._cctvVideoSurface = surface;
      this.store.setLiveState('waiting');
    }
  } else {
    this.store.setLiveState('');
  }

  if (this._cctvFrame) {
    const nextSrc = liveIntent
      ? previewShown && activeCamera.liveSnapshotUrl
      : enabled && !isQuebecCamera && activeCamera?.frameUrl;
    const nextCameraId =
      enabled && !isQuebecCamera ? activeCamera?.id || '' : '';
    const cameraChanged = this._frame.cameraId !== nextCameraId;
    const frameLoading = this._frame.loading;
    // A same-camera refresh waits for the current image to settle. Replacing
    // src every 10 seconds can cancel a slow but healthy decode forever and
    // leave SNAPSHOT · OK beside a blank/loading preview. Camera changes are
    // immediate so navigation never waits on the prior camera's request.
    if (
      nextSrc &&
      previewShown &&
      (cameraChanged || (!frameLoading && this._frame.currentSrc !== nextSrc))
    ) {
      this._queueCctvFrame(nextSrc, nextCameraId, cameraChanged, {
        readTime: activeCamera?.framesCarryTime === true,
      });
    } else if (!nextSrc || (cameraChanged && this._frame.cameraId)) {
      this._clearCctvFrame();
    }
  }

  this._syncCctvSourceBadge(activeCamera, enabled);
  this._typeCctvSummary(
    state?.summary ||
      t('Enable CCTV to start camera-linked intelligence summaries.'),
  );
}

export function _typeCctvSummary(text) {
  if (this.destroyed || !this._cctvSummary) return;
  const nextText = String(text || '').trim() || t('No summary available.');
  if (nextText === this._lastCctvSummaryText) return;
  this._lastCctvSummaryText = nextText;

  clearInterval(this._cctvSummaryTypingTimer);
  this.store.setSummary('');
  let idx = 0;
  this._cctvSummaryTypingTimer = setInterval(() => {
    if (this.destroyed) return;
    idx += 3;
    if (idx >= nextText.length) {
      this.store.setSummary(nextText);
      clearInterval(this._cctvSummaryTypingTimer);
      this._cctvSummaryTypingTimer = null;
      return;
    }
    this.store.setSummary(nextText.slice(0, idx));
  }, 20);
}

/** Publish a change to the camera grid chip; its label stays while hidden. */
export function _publishCctvChip(patch) {
  const current = this._cctvChip ?? {
    visible: false,
    labelKey: msg('loading frames'),
    immediate: false,
    progress: '0/0',
    stopped: false,
  };
  // The chip keeps its English key, so a new locale shows it again; the
  // view gets the label alone.
  const next = { ...current, ...patch };
  next.label = t(next.labelKey);
  if (
    this._cctvChip &&
    Object.keys(next).every((key) => next[key] === current[key])
  )
    return;
  this._cctvChip = next;
  const { labelKey, ...chip } = next;
  this.statusStore.publishCctv(chip);
}

export function _updateCctvSyncChip(loading, enabled) {
  if (this.destroyed) return;
  const total = Number(loading?.total) || 0;
  const loaded = Math.max(0, Math.min(Number(loading?.loaded) || 0, total));
  const busy = !!enabled && !!loading?.active && total > 0;

  if (busy) {
    clearTimeout(this._cctvChipHideTimer);
    this._cctvChipHideTimer = null;
    this._cctvChipWasBusy = true;
    // The counter is left plain on purpose: it ticks every few frames
    // during a grid load, and flapping it would read as a slot machine.
    this._publishCctvChip({
      visible: true,
      labelKey: msg('loading frames'),
      progress: `${loaded}/${total}`,
    });
    return;
  }

  if (this._cctvChipWasBusy && enabled && total > 0) {
    // Load just completed — flash the final count, then auto-hide.
    this._cctvChipWasBusy = false;
    this._publishCctvChip({
      visible: true,
      labelKey: msg('camera grid ready'),
      progress: `${total}/${total}`,
    });
    clearTimeout(this._cctvChipHideTimer);
    this._cctvChipHideTimer = window.setTimeout(() => {
      if (this.destroyed) return;
      this._cctvChipHideTimer = null;
      this._publishCctvChip({ visible: false });
    }, 1500);
    return;
  }

  if (!this._cctvChipHideTimer) {
    this._cctvChipWasBusy = false;
    this._publishCctvChip({ visible: false });
  }
}
