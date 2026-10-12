import { createCctvVideoSurface } from './cctvVideo.js';
import { t } from '../i18n/index.js';
export function _calBadgeLabel(badge) {
  switch (badge) {
    case 'calibrated':
      return t('cctv.badge.calibrated');
    case 'curated':
      return t('cctv.badge.curated');
    case 'raw-prior':
      return t('cctv.badge.rawPrior');
    default:
      return t('cctv.badge.none');
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
  const cameras = state?.cameras || [];
  const enabled = !!state?.enabled && !!this.actions.isEnabled();
  const activeId = state?.activeCameraId || '';
  const activeCamera = state?.activeCamera || null;

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

  if (this._cctvEnableBtn) {
    this._cctvEnableBtn.classList.toggle('active', enabled);
    this._cctvEnableBtn.textContent = enabled
      ? t('cctv.toggle.on')
      : t('cctv.toggle.off');
  }

  if (this._cctvSelect) {
    const shouldRebuild =
      this._cctvSelect.options.length !== cameras.length ||
      cameras.some(
        (cam, idx) => this._cctvSelect.options[idx]?.value !== cam.id,
      );
    if (shouldRebuild) {
      this._cctvSelect.innerHTML = '';
      for (const camera of cameras) {
        const option = document.createElement('option');
        option.value = camera.id;
        option.textContent = `${camera.city} · ${camera.name}`;
        this._cctvSelect.appendChild(option);
      }
    }
    this._cctvSelect.disabled = !enabled || cameras.length === 0;
    if (
      activeId &&
      Array.from(this._cctvSelect.options).some((opt) => opt.value === activeId)
    ) {
      this._cctvSelect.value = activeId;
    } else if (!activeId) {
      this._cctvSelect.selectedIndex = -1;
    }
  }

  for (const btn of [
    this._cctvNearestBtn,
    this._cctvPrevBtn,
    this._cctvNextBtn,
  ]) {
    if (!btn) continue;
    btn.disabled = !enabled || cameras.length === 0;
  }
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
        ? t('cctv.coverage.viewshed')
        : mode === 'on'
          ? t('cctv.coverage.on')
          : t('cctv.coverage.off');
    this._cctvCoverageBtn.disabled = !enabled;
  }

  if (this._cctvAutoHopBtn) {
    const autoHop = !!state?.autoHop;
    this._cctvAutoHopBtn.classList.toggle('active', autoHop);
    this._cctvAutoHopBtn.textContent = autoHop
      ? t('cctv.autoHop.on')
      : t('cctv.autoHop.off');
    this._cctvAutoHopBtn.disabled = !enabled;
  }

  if (this._cctvProjectionBtn) {
    const showProjection = state?.showProjection !== false;
    this._cctvProjectionBtn.classList.toggle('active', showProjection);
    this._cctvProjectionBtn.textContent = showProjection
      ? t('cctv.projection.on')
      : t('cctv.projection.off');
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
      ? t('cctv.cal.edited')
      : t('cctv.cal.chip', { badge: this._calBadgeLabel(badge) });
    this._cctvQualityChip.dataset.calBadge = dirty ? 'edited' : badge || '';
  }

  this._syncCctvCalReadout(enabled, activeCamera);

  if (this._cctvMeta) {
    if (activeCamera) {
      const provider =
        activeCamera.sourceLabel ||
        activeCamera.provider ||
        t('cctv.meta.configuredSource');
      const statusMsg = activeCamera.sourceMessage
        ? ` · ${activeCamera.sourceMessage}`
        : '';
      // A partner-supplied feed inside a pack names its owner here.
      const credit = activeCamera.credit ? ` · ${activeCamera.credit}` : '';
      const calBadge = activeCamera.calBadge
        ? this._calBadgeLabel(activeCamera.calBadge)
        : '';
      const projLabel =
        state?.showProjection !== false
          ? t('cctv.meta.monitor')
          : t('cctv.meta.off');
      this._cctvMeta.textContent = `${activeCamera.city} · HDG ${Math.round(activeCamera.headingDeg)}° · FOV ${Math.round(activeCamera.fovDeg)}° · RANGE ${Math.round(activeCamera.rangeM)}m · ${projLabel}${calBadge ? ` · ${calBadge}` : ''} · ${provider}${credit}${statusMsg}`;
    } else if (cameras.length > 0) {
      this._cctvMeta.textContent = enabled
        ? t('cctv.meta.loadedClick', { n: cameras.length })
        : t('cctv.meta.loadedEnable', { n: cameras.length });
    } else {
      this._cctvMeta.textContent = t('cctv.meta.idle');
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
  this._typeCctvSummary(state?.summary || t('cctv.summary.idle'));
}

export function _typeCctvSummary(text) {
  if (this.destroyed || !this._cctvSummary) return;
  const nextText = String(text || '').trim() || t('cctv.summary.empty');
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
  // The chip mode (loading / ready) is what lets a locale switch re-translate
  // the visible label (repaintCctvSyncChipLabel). It is ONLY reassigned when
  // the chip actually transitions below — in particular the no-op tick while
  // the completion dwell timer runs must keep the ready mode, because the
  // real locale subscription renders state BEFORE repainting the label.
  const total = Number(loading?.total) || 0;
  const loaded = Math.max(0, Math.min(Number(loading?.loaded) || 0, total));
  const busy = !!enabled && !!loading?.active && total > 0;

  if (busy) {
    clearTimeout(this._cctvChipHideTimer);
    this._cctvChipHideTimer = null;
    this._cctvChipWasBusy = true;
    this.actions.setSplitFlapText(
      this._cctvSyncLabel,
      t('chrome.chips.cctvSync'),
    );
    // The counter is left plain on purpose: it ticks every few frames
    // during a grid load, and flapping it would read as a slot machine.
    this._cctvSyncProgress.textContent = `${loaded}/${total}`;
    this._cctvSyncChip.classList.add('visible');
    this._cctvChipMode = 'loading';
    return;
  }

  if (this._cctvChipWasBusy && enabled && total > 0) {
    // Load just completed — flash the final count, then auto-hide.
    this._cctvChipWasBusy = false;
    this.actions.setSplitFlapText(
      this._cctvSyncLabel,
      t('cctv.sync.gridReady'),
    );
    this._cctvSyncProgress.textContent = `${total}/${total}`;
    this._cctvSyncChip.classList.add('visible');
    this._cctvChipMode = 'ready';
    clearTimeout(this._cctvChipHideTimer);
    this._cctvChipHideTimer = window.setTimeout(() => {
      if (this.destroyed) return;
      this._cctvChipHideTimer = null;
      this._cctvChipMode = null;
      this._cctvSyncChip.classList.remove('visible');
    }, 1500);
    return;
  }

  if (!this._cctvChipHideTimer) {
    this._cctvChipWasBusy = false;
    this._cctvChipMode = null;
    this._cctvSyncChip.classList.remove('visible');
  }
}

/**
 * Re-translate the visible sync-chip label for the active locale. Owners call
 * this from their locale subscription: it only rewrites the TEXT of whatever
 * state the chip is in (loading / grid-ready) and never changes visibility or
 * the completion dwell timer, so a mid-dwell switch keeps the completion
 * semantics instead of flashing the loading copy.
 */
export function repaintCctvSyncChipLabel() {
  if (this.destroyed || !this._cctvSyncLabel || !this._cctvChipMode) return;
  const key =
    this._cctvChipMode === 'ready'
      ? 'cctv.sync.gridReady'
      : 'chrome.chips.cctvSync';
  this.actions.setSplitFlapText(this._cctvSyncLabel, t(key), {
    immediate: true,
  });
}
