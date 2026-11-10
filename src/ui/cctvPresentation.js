import { getLocale, keepCodesWithValues, msg, t, tn } from '../i18n/index.js';
import { cctvSourceLabelText, cctvSourceMessageText } from './cctvFrames.js';

import { createCctvVideoSurface } from './cctvVideo.js';
import { presentCctvCalibration } from './cctvCalibration.js';
import { roundHeadingDegrees } from '../data/headingDegrees.js';
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

/** A picker option for a camera. */
function pickerOption(camera, id = camera.id) {
  return { value: id, label: `${camera.city} · ${camera.name}` };
}

/** The picker's closing line for the cameras the view leaves out. */
function outsideNoteText(count) {
  return tn(
    count,
    '{count} more camera outside this view · pan or zoom out',
    '{count} more cameras outside this view · pan or zoom out',
  );
}

/**
 * The panel's buttons, CAL chip and meta line for a camera state, as the CCTV
 * panel view renders them. Pure: the picker, frame, source badge, calibration
 * readout and summary stay with the controls.
 * @param {object|null} state Camera layer UI state.
 * @param {boolean} enabled Whether the layer is on.
 */
export function presentCctvPanel(state, enabled) {
  const cameras = state?.cameraIndex || state?.cameras || [];
  const catalogCount = Number.isFinite(state?.count)
    ? state.count
    : cameras.length;
  const activeId = state?.activeCameraId || '';
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
  return {
    enabled,
    navDisabled: !enabled || catalogCount === 0,
    focusDisabled: !enabled || catalogCount === 0 || !activeId,
    toggleDisabled: !enabled,
    coverage: {
      active: coverage !== 'off',
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
    },
    projection: {
      active: showProjection,
      text: showProjection ? t('PROJECTION ON') : t('PROJECTION OFF'),
    },
    quality: {
      label: dirty
        ? t('CAL · EDITED (UNSAVED)')
        : t('CAL · {badge}', { badge: _calBadgeLabel(badge) }),
      calBadge: dirty ? 'edited' : badge || '',
    },
    meta: metaText(state, enabled, activeCamera, catalogCount),
    calibration: presentCctvCalibration(state, enabled),
  };
}

function metaText(state, enabled, activeCamera, catalogCount) {
  if (activeCamera) {
    const provider = cctvSourceLabelText(
      activeCamera.sourceLabel || activeCamera.provider || 'Configured Source',
    );
    const statusMsg = activeCamera.sourceMessage
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
  // The light index, not `state.cameras`: reading that builds every camera's
  // full state, which a large catalog cannot afford on each notification.
  const cameras = state?.cameraIndex || state?.cameras || [];
  // The picker lists what is in view; the catalog is every camera.
  const catalogCount = Number.isFinite(state?.count)
    ? state.count
    : cameras.length;
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
  const isQuebecCamera =
    enabled && activeCamera?.sourceKind?.startsWith('quebec-');
  this._quebecCctvOverlay?.setCamera(isQuebecCamera ? activeCamera : null, {
    reselected,
  });
  if (this._cctvFrameWrap) this._cctvFrameWrap.hidden = Boolean(isQuebecCamera);

  // Auto-expand the panel when the active camera CHANGES to a new non-null
  // id while the layer is enabled. Covers click-on-globe, panel controls,
  // and voice (selectCamera/cycleCamera/focusNearest all notify through
  // this subscription). The last-seen guard keeps routine notifications
  // from re-expanding a panel the user deliberately collapsed, and timed
  // auto-hop transitions only expand on the first activation so the panel
  // does not pop open on every hop.
  const effectiveActiveId = enabled ? activeId || null : null;
  const isFirstActivation = this._lastSeenCctvActiveId === null;
  if (
    effectiveActiveId &&
    effectiveActiveId !== this._lastSeenCctvActiveId &&
    (!state?.autoHop || isFirstActivation)
  ) {
    this.actions.setPanelCollapsed('cctv-panel', false, {
      explicit: Boolean(state?.explicitSelection),
    });
  }
  this._lastSeenCctvActiveId = effectiveActiveId;

  this._updateCctvSyncChip(state?.loading, enabled);

  if (this._cctvSelect) {
    // A focused picker keeps the options it shows; blur re-renders it. One
    // about to be disabled cannot hold focus, so it does not count.
    const disabled = !enabled || cameras.length === 0;
    const picking = document.activeElement === this._cctvSelect && !disabled;
    // Cameras the view leaves out get one closing line, so a short list
    // does not read as the whole catalog. A disabled layer has no view.
    const outside = enabled ? Math.max(0, catalogCount - cameras.length) : 0;
    let picker = this._picker;
    // The index keeps its identity until the view or the active camera
    // changes, so an unchanged list keeps its options; a new locale words
    // the closing line again.
    if (
      !picking &&
      (picker?.source !== cameras ||
        picker.outside !== outside ||
        picker.locale !== getLocale())
    )
      picker = {
        source: cameras,
        outside,
        locale: getLocale(),
        options: cameras.map((camera) => pickerOption(camera)),
        note: outside ? outsideNoteText(outside) : '',
      };
    else if (
      picking &&
      activeId &&
      activeCamera &&
      !picker?.options.some((option) => option.value === activeId)
    ) {
      // A deferred rebuild can miss a camera activated meanwhile (auto-hop,
      // voice); add it so the picker does not go blank. It is one fewer
      // outside the view.
      const options = [
        pickerOption(activeCamera, activeId),
        ...(picker?.options || []),
      ];
      const left = Math.max(0, catalogCount - options.length);
      picker = {
        ...picker,
        options,
        note: picker?.note && left ? outsideNoteText(left) : '',
      };
    }
    this._picker = picker;
    this.store.setPicker({
      options: picker?.options || [],
      note: picker?.note || '',
      disabled,
      // The active camera is always one of the listed records. With nothing
      // active the closed picker shows the note when nothing is in view; a
      // focused picker keeps its old options, so it only clears.
      selection:
        activeId && activeCamera
          ? { value: activeId }
          : !activeId
            ? { index: !picking && cameras.length === 0 && outside ? 0 : -1 }
            : null,
    });
  }

  this.store.publish(presentCctvPanel(state, enabled));

  const liveIntent =
    enabled && !!activeCamera?.isVideo && !activeCamera?.browserMediaUrl;
  this.store.setLive(liveIntent);
  if (this._cctvVideo) {
    const visible =
      liveIntent &&
      !document.hidden &&
      !this._cctvPanel?.classList.contains('collapsed');
    if (!visible || this._cctvVideoCameraId !== activeId) {
      this._cctvVideoSurface?.stop();
      this._cctvVideoSurface = null;
    }
    this._cctvVideoCameraId = activeId;
    if (visible && !this._cctvVideoSurface) {
      this._cctvVideoSurface = createCctvVideoSurface(this._cctvVideo, () =>
        this.cctv.getActiveVideoElement?.(),
      );
    }
  }

  if (this._cctvFrame && !liveIntent) {
    const nextSrc = enabled && !isQuebecCamera ? activeCamera?.frameUrl : null;
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
      (cameraChanged || (!frameLoading && this._frame.currentSrc !== nextSrc))
    ) {
      this._queueCctvFrame(nextSrc, nextCameraId, cameraChanged);
    }
    if (!nextSrc) {
      this._clearCctvFrame();
    }
  } else if (liveIntent) {
    this._clearCctvFrame();
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
