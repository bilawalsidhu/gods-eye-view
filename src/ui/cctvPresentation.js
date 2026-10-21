import { t, tn, formatNumber } from '../i18n/index.js';
import { cctvSourceLabelText, cctvSourceMessageText } from './cctvFrames.js';

import { createCctvVideoSurface } from './cctvVideo.js';
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
  const discovery = this.discoverCameras(state);
  const cameras = discovery.cameras;
  const localScope =
    !!this.actions.readMapView && this._cctvScope?.value !== 'all';
  const outsideView =
    localScope &&
    state?.activeCamera &&
    !discovery.localIds.has(state.activeCameraId);
  const enabled = !!state?.enabled && !!this.actions.isEnabled();
  const activeId = outsideView ? '' : state?.activeCameraId || '';
  const activeCamera = outsideView ? null : state?.activeCamera || null;

  if (this._cctvDiscoveryStatus) {
    this._cctvDiscoveryStatus.textContent = cameras.length
      ? localScope
        ? tn(
            cameras.length,
            '{count} camera in map view · nearest first',
            '{count} cameras in map view · nearest first',
          )
        : tn(
            cameras.length,
            '{count} camera worldwide · nearest first',
            '{count} cameras worldwide · nearest first',
          )
      : this._cctvSearch?.value?.trim()
        ? t('No matching cameras. Try another search or All cameras.')
        : localScope
          ? t('No cameras in map view. Move the map or choose All cameras.')
          : t('No cameras loaded.');
  }

  // Auto-expand the panel when the active camera CHANGES to a new non-null
  // id while the layer is enabled. Covers click-on-globe, panel controls,
  // and voice (selectCamera/cycleCamera/focusNearest all notify through
  // this subscription). The last-seen guard keeps routine notifications
  // from re-expanding a panel the user deliberately collapsed, and timed
  // auto-hop transitions only expand on the first activation so the panel
  // does not pop open on every hop.
  const effectiveActiveId = enabled ? state?.activeCameraId || null : null;
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

  if (this._cctvEnableBtn) {
    this._cctvEnableBtn.classList.toggle('active', enabled);
    this._cctvEnableBtn.textContent = enabled ? t('CCTV ON') : t('CCTV OFF');
  }

  const cameraLabel = (camera) => {
    const distance = Number.isFinite(camera.distanceKm)
      ? camera.distanceKm < 1
        ? t('<1 km')
        : t('{distance} km', {
            distance: formatNumber(Math.round(camera.distanceKm)),
          })
      : '';
    return `${camera.city} · ${camera.name}${distance ? ` · ${distance}` : ''}`;
  };
  if (this._cctvSelect) {
    // Keep option identity across map moves: distances update in place and
    // only membership/order changes touch the select's child list.
    const existing = new Map(
      Array.from(this._cctvSelect.options, (option) => [option.value, option]),
    );
    const wanted = new Set(cameras.map((camera) => camera.id));
    for (const [id, option] of existing) {
      if (!wanted.has(id)) option.remove();
    }
    cameras.forEach((camera, index) => {
      const option =
        existing.get(camera.id) || document.createElement('option');
      option.value = camera.id;
      const label = cameraLabel(camera);
      if (option.textContent !== label) option.textContent = label;
      if (this._cctvSelect.options[index] !== option) {
        this._cctvSelect.insertBefore(
          option,
          this._cctvSelect.options[index] || null,
        );
      }
    });
    this._cctvSelect.disabled = !enabled || cameras.length === 0;
    if (
      activeId &&
      Array.from(this._cctvSelect.options).some((opt) => opt.value === activeId)
    ) {
      this._cctvSelect.value = activeId;
    } else {
      this._cctvSelect.selectedIndex = -1;
    }
  }

  for (const btn of [this._cctvPrevBtn, this._cctvNextBtn]) {
    if (!btn) continue;
    btn.disabled = !enabled || cameras.length === 0;
  }
  if (this._cctvNearestBtn)
    this._cctvNearestBtn.disabled =
      !enabled ||
      (!cameras.length &&
        (discovery.localIds.size > 0 || !state?.cameras?.length));
  if (this._cctvFocusBtn) {
    this._cctvFocusBtn.disabled = !enabled || cameras.length === 0 || !activeId;
  }

  if (this._cctvCoverageBtn) {
    // Tri-state (viewshed design §3b): off → on (wireframes) → viewshed
    // (color-coded volumes). The click handler cycles; this renders.
    const mode = state?.coverageMode || (state?.showCoverage ? 'on' : 'off');
    this._cctvCoverageBtn.classList.toggle('active', mode !== 'off');
    this._cctvCoverageBtn.textContent =
      mode === 'viewshed'
        ? t('VIEWSHED ON')
        : mode === 'on'
          ? t('COVERAGE ON')
          : t('COVERAGE OFF');
    this._cctvCoverageBtn.disabled = !enabled;
  }

  if (this._cctvAutoHopBtn) {
    const autoHop = !!state?.autoHop;
    this._cctvAutoHopBtn.classList.toggle('active', autoHop);
    this._cctvAutoHopBtn.textContent = autoHop
      ? t('AUTO HOP ON')
      : t('AUTO HOP OFF');
    this._cctvAutoHopBtn.disabled = !enabled;
  }

  if (this._cctvProjectionBtn) {
    const showProjection = state?.showProjection !== false;
    this._cctvProjectionBtn.classList.toggle('active', showProjection);
    this._cctvProjectionBtn.textContent = showProjection
      ? t('PROJECTION ON')
      : t('PROJECTION OFF');
    this._cctvProjectionBtn.disabled = !enabled;
  }

  if (this._cctvQualityChip) {
    // CAL badge (cctv-v2 design §3b, amended by LOCKED §9.2 — panel-only,
    // no in-world tint): three states driven by cctv.js's deriveCalBadge,
    // no client-side scoring math. Casing is unified via _calBadgeLabel so
    // the chip and the meta line never drift onto different conventions.
    // Save-gated persistence (viewshed design §3e): unsaved live edits show
    // EDITED on top of whatever the persisted badge state is — SAVE CAL
    // promotes to CALIBRATED, RESET CAL clears.
    const badge = activeCamera?.calBadge || null;
    const dirty = !!activeCamera?.calDirty;
    this._cctvQualityChip.textContent = dirty
      ? t('CAL · EDITED (UNSAVED)')
      : t('CAL · {badge}', {
          badge: this._calBadgeLabel(badge),
        });
    this._cctvQualityChip.dataset.calBadge = dirty ? 'edited' : badge || '';
  }

  this._syncCctvCalReadout(enabled, activeCamera);

  if (this._cctvMeta) {
    if (activeCamera) {
      const provider = cctvSourceLabelText(
        activeCamera.sourceLabel ||
          activeCamera.provider ||
          'Configured Source',
      );
      const statusMsg = activeCamera.sourceMessage
        ? ` · ${cctvSourceMessageText(activeCamera.sourceMessage)}`
        : '';
      // A partner-supplied feed inside a pack names its owner here.
      const credit = activeCamera.credit ? ` · ${activeCamera.credit}` : '';
      const calBadge = activeCamera.calBadge
        ? this._calBadgeLabel(activeCamera.calBadge)
        : '';
      const projLabel =
        state?.showProjection !== false ? t('MONITOR') : t('OFF');
      this._cctvMeta.textContent = t(
        '{city} · HDG {heading} · FOV {fov} · RANGE {range}m · {projection}{calBadge} · {provider}{status}',
        {
          city: activeCamera.city,
          heading: `${Math.round(activeCamera.headingDeg)}°`,
          fov: `${Math.round(activeCamera.fovDeg)}°`,
          range: Math.round(activeCamera.rangeM),
          projection: projLabel,
          calBadge: calBadge ? ` · ${calBadge}` : '',
          provider,
          status: `${credit}${statusMsg}`,
        },
      );
    } else if (cameras.length > 0) {
      this._cctvMeta.textContent = enabled
        ? tn(
            cameras.length,
            '{count} camera loaded · click a camera to activate',
            '{count} cameras loaded · click a camera to activate',
          )
        : tn(
            cameras.length,
            '{count} camera loaded · enable CCTV to activate',
            '{count} cameras loaded · enable CCTV to activate',
          );
    } else {
      this._cctvMeta.textContent = enabled
        ? t('No camera selected in this area')
        : t('Enable CCTV to load cameras');
    }
  }

  const liveIntent = enabled && !!activeCamera?.isVideo;
  if (this._cctvVideo) {
    this._cctvVideo.hidden = !liveIntent;
    if (this._cctvFrame) this._cctvFrame.hidden = liveIntent;
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
    const nextSrc = enabled ? activeCamera?.frameUrl : null;
    const nextCameraId = enabled ? activeCamera?.id || '' : '';
    const cameraChanged = this._cctvFrame.dataset.cameraId !== nextCameraId;
    const frameLoading = this._cctvFrame.dataset.loading === 'true';
    // A same-camera refresh waits for the current image to settle. Replacing
    // src every 10 seconds can cancel a slow but healthy decode forever and
    // leave SNAPSHOT · OK beside a blank/loading preview. Camera changes are
    // immediate so navigation never waits on the prior camera's request.
    if (
      nextSrc &&
      (cameraChanged ||
        (!frameLoading && this._cctvFrame.dataset.currentSrc !== nextSrc))
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
    (outsideView
      ? t(
          'The selected camera is outside the map view. Choose a camera here, or switch to All cameras.',
        )
      : state?.summary) ||
      t('Enable CCTV to start camera-linked intelligence summaries.'),
  );
}

export function _typeCctvSummary(text) {
  if (this.destroyed || !this._cctvSummary) return;
  const nextText = String(text || '').trim() || t('No summary available.');
  if (nextText === this._lastCctvSummaryText) return;
  this._lastCctvSummaryText = nextText;

  clearInterval(this._cctvSummaryTypingTimer);
  this._cctvSummary.textContent = '';
  let idx = 0;
  this._cctvSummaryTypingTimer = setInterval(() => {
    if (this.destroyed) return;
    idx += 3;
    if (idx >= nextText.length) {
      this._cctvSummary.textContent = nextText;
      clearInterval(this._cctvSummaryTypingTimer);
      this._cctvSummaryTypingTimer = null;
      return;
    }
    this._cctvSummary.textContent = nextText.slice(0, idx);
  }, 20);
}

export function _updateCctvSyncChip(loading, enabled) {
  if (this.destroyed) return;
  if (!this._cctvSyncChip || !this._cctvSyncLabel || !this._cctvSyncProgress)
    return;
  const total = Number(loading?.total) || 0;
  const loaded = Math.max(0, Math.min(Number(loading?.loaded) || 0, total));
  const busy = !!enabled && !!loading?.active && total > 0;

  if (busy) {
    clearTimeout(this._cctvChipHideTimer);
    this._cctvChipHideTimer = null;
    this._cctvChipWasBusy = true;
    this.actions.setSplitFlapText(this._cctvSyncLabel, t('loading frames'));
    // The counter is left plain on purpose: it ticks every few frames
    // during a grid load, and flapping it would read as a slot machine.
    this._cctvSyncProgress.textContent = `${loaded}/${total}`;
    this._cctvSyncChip.classList.add('visible');
    return;
  }

  if (this._cctvChipWasBusy && enabled && total > 0) {
    // Load just completed — flash the final count, then auto-hide.
    this._cctvChipWasBusy = false;
    this.actions.setSplitFlapText(this._cctvSyncLabel, t('camera grid ready'));
    this._cctvSyncProgress.textContent = `${total}/${total}`;
    this._cctvSyncChip.classList.add('visible');
    clearTimeout(this._cctvChipHideTimer);
    this._cctvChipHideTimer = window.setTimeout(() => {
      if (this.destroyed) return;
      this._cctvChipHideTimer = null;
      this._cctvSyncChip.classList.remove('visible');
    }, 1500);
    return;
  }

  if (!this._cctvChipHideTimer) {
    this._cctvChipWasBusy = false;
    this._cctvSyncChip.classList.remove('visible');
  }
}
