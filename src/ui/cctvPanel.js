/**
 * CCTV panel — camera grid, playback, and manual calibration controls,
 * extracted from src/ui.js (Batch 5 seam 3). StyleManager keeps the public
 * method surface (_initCctvPanel/_toggleCctvEnabled/_renderCctvState) as thin
 * delegates; this module owns the wiring and rendering, receiving the manager
 * as its first parameter. CCTV DATA, source fetching, and the enable
 * transition policy live in src/data/cctv.js + cctvFocusPolicy.js +
 * cctvSources.js; nothing here decides layer lifecycle.
 */

import { runCctvLayerEnableTransition } from '../cctvFocusPolicy.js';
import cctvLayer from '../data/cctv.js';

/** Shortest-wrap signed degrees, for heading offsets typed as absolute values. */
const signedNormalizeDeg = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;

/**
 * Field definitions for the CCTV click-to-edit pose readout. Chips DISPLAY the
 * camera's EFFECTIVE pose (not raw offsets — "HDG 135.0°" instead of the old
 * "HEADING 0°" nonsense); typed values convert back to calibration offsets
 * against the frozen basePose. ΔN/ΔE stay offset-denominated (absolute lat/lon
 * typing is user-hostile).
 */
const CCTV_CAL_FIELDS = {
  heading: {
    label: 'HDG', unit: '°', decimals: 1,
    get: (cam) => cam.headingDeg,
    toPatch: (value, base) => ({ headingDeg: signedNormalizeDeg(value - base.headingDeg) }),
  },
  pitch: {
    label: 'PITCH', unit: '°', decimals: 1,
    get: (cam) => cam.pitchDeg,
    toPatch: (value, base) => ({ pitchDeg: value - base.pitchDeg }),
  },
  fov: {
    label: 'FOV', unit: '°', decimals: 0,
    get: (cam) => cam.fovDeg,
    toPatch: (value, base) => ({ fovDeg: value - base.fovDeg }),
  },
  range: {
    label: 'RANGE', unit: 'm', decimals: 0,
    get: (cam) => cam.rangeM,
    toPatch: (value, base) => ({ rangeScale: base.rangeM > 0 ? value / base.rangeM : 1 }),
  },
  height: {
    label: 'HGT', unit: 'm', decimals: 0,
    get: (cam) => cam.mountHeightM,
    toPatch: (value, base) => ({ heightM: value - base.mountHeightM }),
  },
  north: {
    label: 'ΔN', unit: 'm', decimals: 1,
    get: (cam) => cam.calibration?.offsetNorthM || 0,
    toPatch: (value) => ({ offsetNorthM: value }),
  },
  east: {
    label: 'ΔE', unit: 'm', decimals: 1,
    get: (cam) => cam.calibration?.offsetEastM || 0,
    toPatch: (value) => ({ offsetEastM: value }),
  },
};

/**
 * Wires up all CCTV panel controls: enable/disable, nearest/prev/next camera,
 * camera select dropdown, focus, coverage, auto-hop, projection,
 * manual calibration sliders, and save/reset buttons.
 * @returns {void}
 */
export function initCctvPanel(mgr) {
    if (!mgr._cctvPanel) return;

    mgr._cctvEnableBtn?.addEventListener('click', async () => {
      await mgr._toggleCctvEnabled();
    });

    mgr._cctvNearestBtn?.addEventListener('click', async () => {
      if (!await mgr._toggleCctvEnabled(true)) return;
      mgr._runExplicitCctvFocus(
        () => cctvLayer.focusNearest({ focus: false }),
        (cameraId) => cctvLayer.focusCamera(cameraId, 1.8),
      );
    });

    mgr._cctvPrevBtn?.addEventListener('click', async () => {
      if (!await mgr._toggleCctvEnabled(true)) return;
      mgr._runExplicitCctvFocus(
        () => cctvLayer.cycleCamera(-1),
        (cameraId) => cctvLayer.focusCamera(cameraId, 1.4),
      );
    });

    mgr._cctvNextBtn?.addEventListener('click', async () => {
      if (!await mgr._toggleCctvEnabled(true)) return;
      mgr._runExplicitCctvFocus(
        () => cctvLayer.cycleCamera(1),
        (cameraId) => cctvLayer.focusCamera(cameraId, 1.4),
      );
    });

    mgr._cctvSelect?.addEventListener('change', async () => {
      const cameraId = mgr._cctvSelect.value;
      if (!cameraId) return;
      if (!await mgr._toggleCctvEnabled(true)) return;
      // Picking a camera from the dropdown flies to it. The catalog spans
      // three metros, so a bare selection used to leave the view in the old
      // city with a camera active thousands of km away.
      mgr._runExplicitCctvFocus(
        () => (cctvLayer.selectCamera(cameraId) ? cameraId : null),
        (selectedId) => cctvLayer.focusCamera(selectedId, 2.2),
      );
      mgr._dataManager?.setLayerParams('cctv', { selectedCameraId: cameraId }, { origin: 'user' });
    });

    mgr._cctvFocusBtn?.addEventListener('click', async () => {
      const selected = mgr._cctvState?.activeCameraId || mgr._cctvSelect?.value;
      if (!selected) return;
      if (!await mgr._toggleCctvEnabled(true)) return;
      mgr._runExplicitCctvFocus(
        () => selected,
        (cameraId) => cctvLayer.focusCamera(cameraId, 1.9),
      );
      mgr._dataManager?.setLayerParams('cctv', { selectedCameraId: selected }, { origin: 'user' });
    });

    mgr._cctvCoverageBtn?.addEventListener('click', () => {
      const current = mgr._cctvState?.coverageMode
        || (mgr._cctvState?.showCoverage ? 'on' : 'off');
      const next = current === 'off' ? 'on' : current === 'on' ? 'viewshed' : 'off';
      mgr._dataManager?.setLayerParams('cctv', { coverageMode: next }, { origin: 'user' });
    });

    mgr._cctvAutoHopBtn?.addEventListener('click', () => {
      const current = Boolean(mgr._cctvState?.autoHop);
      mgr._dataManager?.setLayerParams('cctv', { autoHop: !current }, { origin: 'user' });
    });

    mgr._cctvProjectionBtn?.addEventListener('click', () => {
      const current = mgr._cctvState?.showProjection !== false;
      mgr._dataManager?.setLayerParams('cctv', { showProjection: !current }, { origin: 'user' });
    });

    mgr._cctvAdjustBtn?.addEventListener('click', () => {
      const current = Boolean(mgr._cctvState?.calibrationMode);
      mgr._dataManager?.setLayerParams('cctv', { calibrationMode: !current }, { origin: 'user' });
    });

    // Click-to-edit pose readout: each chip swaps to a number input; Enter or
    // blur commits (converted to a calibration offset against basePose),
    // Escape cancels. Delegated so re-renders never re-bind.
    mgr._cctvCalReadout?.addEventListener('click', (event) => {
      const chip = event.target.closest?.('.cctv-cal-value');
      if (!chip || chip.disabled || chip.querySelector('input')) return;
      beginCctvCalValueEdit(mgr, chip);
    });

    mgr._cctvCalibSaveBtn?.addEventListener('click', () => {
      const cameraId = activeCctvCameraId(mgr);
      if (!cameraId || !mgr._dataManager) return;
      mgr._dataManager.setLayerParams('cctv', {
        selectedCameraId: cameraId,
        calibration: { cameraId, save: true },
      }, { origin: 'user' });
      mgr._showToast('CCTV calibration saved');
    });

    mgr._cctvCalibResetBtn?.addEventListener('click', () => {
      resetCctvCalibration(mgr);
    });

    renderCctvState(mgr, null);
    mgr._syncCctvPanelViewport();
}

/**
 * Returns the currently active CCTV camera ID from state or the select dropdown.
 * @returns {string} Camera ID, or empty string if none.
 */
function activeCctvCameraId(mgr) {
    return mgr._cctvState?.activeCameraId || mgr._cctvSelect?.value || '';
}

/**
 * Clears the preview and invalidates any in-flight preload.
 * @returns {void}
 */
function clearCctvFrame(mgr) {
    mgr._cctvFrameRequestToken += 1;
    mgr._cctvFramePreloader = null;
    if (mgr._cctvFrame) {
      mgr._cctvFrame.classList.remove('active');
      mgr._cctvFrame.removeAttribute('src');
      mgr._cctvFrame.dataset.cameraId = '';
      mgr._cctvFrame.dataset.currentSrc = '';
      mgr._cctvFrame.dataset.loading = '';
      mgr._cctvFrame.dataset.error = '';
    }
    mgr._cctvFrameWrap?.classList.remove('loading', 'has-frame');
}

/**
 * Fetches a replacement frame OFF-DOM and assigns it to the live element
 * only once it has decoded.
 *
 * The live <img> is never pointed at an unresolved URL. A completed
 * preload is already in the HTTP cache, so assigning `src` swaps in a
 * single paint — the browser's own atomic behavior. A slow or failed
 * fetch never reaches the element at all, so settled pixels survive.
 *
 * (A two-slot crossfade was tried and reverted: with no z-index the slots
 * paint in DOM order, so promotion was asymmetric and yanked the visible
 * layer once per refresh — a flicker on every feed cycle. Measured against
 * main, which never blanked on a successful refresh in the first place.)
 *
 * @param {object} mgr - StyleManager instance holding the live CCTV frame element, its wrap, and the preload request token.
 * @param {string} src
 * @param {string} cameraId
 * @param {boolean} cameraChanged
 * @returns {void}
 */
function queueCctvFrame(mgr, src, cameraId, cameraChanged) {
    if (!mgr._cctvFrame || !src) return;

    if (cameraChanged) {
      // A different camera gets an honest acquisition state. Never retain
      // the prior camera's pixels under the newly selected metadata.
      mgr._cctvFrame.classList.remove('active');
      mgr._cctvFrame.removeAttribute('src');
      mgr._cctvFrameWrap?.classList.remove('has-frame');
    }

    const token = ++mgr._cctvFrameRequestToken;
    mgr._cctvFrame.dataset.cameraId = cameraId;
    mgr._cctvFrame.dataset.currentSrc = src;
    mgr._cctvFrame.dataset.loading = 'true';
    mgr._cctvFrame.dataset.error = '';
    mgr._cctvFrameWrap?.classList.toggle(
      'loading',
      !mgr._cctvFrameWrap?.classList.contains('has-frame')
    );

    const preloader = new Image();
    mgr._cctvFramePreloader = preloader;
    preloader.addEventListener('load', () => settleCctvFrame(mgr, token, src, true));
    preloader.addEventListener('error', () => settleCctvFrame(mgr, token, src, false));
    preloader.src = src;
}

/**
 * Commits a decoded frame to the live element, or records the failure
 * without disturbing whatever is already on screen.
 * @param {object} mgr - StyleManager instance holding the live CCTV frame element whose request token the commit is validated against.
 * @param {number} token - Request token; a stale one is ignored.
 * @param {string} src
 * @param {boolean} ok
 * @returns {void}
 */
function settleCctvFrame(mgr, token, src, ok) {
    if (!mgr._cctvFrame || token !== mgr._cctvFrameRequestToken) return;
    mgr._cctvFramePreloader = null;
    mgr._cctvFrame.dataset.loading = '';
    mgr._cctvFrameWrap?.classList.remove('loading');

    const syncBadge = () => syncCctvSourceBadge(mgr, 
      mgr._cctvState?.activeCamera,
      Boolean(mgr._cctvState?.enabled) && Boolean(mgr._dataManager?.isEnabled('cctv'))
    );

    if (!ok) {
      // Leave the element untouched — a settled frame stays on screen.
      mgr._cctvFrame.dataset.error = 'true';
      syncBadge();
      return;
    }

    mgr._cctvFrame.dataset.error = '';
    mgr._cctvFrame.src = src;
    mgr._cctvFrame.classList.add('active');
    mgr._cctvFrameWrap?.classList.add('has-frame');
    syncBadge();
}

/**
 * Keeps the source badge truthful about the visible frame lifecycle. Health
 * may already be OK while the browser is still decoding the requested image.
 * @param {object} mgr - StyleManager instance holding the source badge that is written and the CCTV frame elements that are read.
 * @param {object|null} activeCamera
 * @param {boolean} enabled
 * @returns {void}
 */
function syncCctvSourceBadge(mgr, activeCamera, enabled) {
    if (!mgr._cctvSourceBadge) return;
    if (!enabled || !activeCamera) {
      mgr._cctvSourceBadge.textContent = 'SOURCE · UNKNOWN';
      mgr._cctvSourceBadge.dataset.frameState = 'idle';
      return;
    }
    const hasDisplayedFrame = mgr._cctvFrameWrap?.classList.contains('has-frame');
    if (mgr._cctvFrame?.dataset.loading === 'true' && !hasDisplayedFrame) {
      mgr._cctvSourceBadge.textContent = 'FRAME · LOADING';
      mgr._cctvSourceBadge.dataset.frameState = 'loading';
      return;
    }
    if (mgr._cctvFrame?.dataset.error === 'true' && !hasDisplayedFrame) {
      mgr._cctvSourceBadge.textContent = 'FRAME · UNAVAILABLE';
      mgr._cctvSourceBadge.dataset.frameState = 'error';
      return;
    }
    const kind = String(activeCamera.sourceKind || activeCamera.feedType || 'unknown').toUpperCase();
    const status = String(activeCamera.sourceStatus || 'unknown').toUpperCase();
    mgr._cctvSourceBadge.textContent = `${kind} · ${status}`;
    mgr._cctvSourceBadge.dataset.frameState = 'ready';
}

/**
 * Resets calibration for the active CCTV camera to its server defaults.
 * @returns {void}
 */
function resetCctvCalibration(mgr) {
    const cameraId = activeCctvCameraId(mgr);
    if (!cameraId || !mgr._dataManager) return;
    mgr._dataManager.setLayerParams('cctv', {
      selectedCameraId: cameraId,
      calibration: {
        cameraId,
        reset: true,
      },
    }, { origin: 'user' });
    mgr._showToast('CCTV calibration reset');
}

/**
 * Swaps a readout chip's text for an inline number input. Enter/blur commits
 * (converted to a calibration offset patch), Escape cancels. The next state
 * re-render restores the chip text either way.
 * @param {object} mgr - StyleManager instance supplying the active CCTV state and the layer params writer the calibration patch is committed through.
 * @param {HTMLButtonElement} chip - The clicked `.cctv-cal-value` element.
 * @returns {void}
 */
function beginCctvCalValueEdit(mgr, chip) {
    const field = CCTV_CAL_FIELDS[chip.dataset.calField];
    const activeCamera = mgr._cctvState?.activeCamera;
    if (!field || !activeCamera?.basePose) return;
    const startValue = field.get(activeCamera);
    const input = document.createElement('input');
    input.type = 'number';
    input.step = field.decimals > 0 ? '0.1' : '1';
    input.value = Number(startValue).toFixed(field.decimals);
    input.className = 'cctv-cal-input';
    chip.textContent = `${field.label} `;
    chip.appendChild(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = (commit) => {
      if (finished) return;
      finished = true;
      const typed = Number.parseFloat(input.value);
      input.remove();
      if (commit && Number.isFinite(typed)) {
        const cameraId = activeCctvCameraId(mgr);
        if (cameraId && mgr._dataManager) {
          mgr._dataManager.setLayerParams('cctv', {
            selectedCameraId: cameraId,
            calibration: { cameraId, patch: field.toPatch(typed, activeCamera.basePose) },
          }, { origin: 'user' });
          return; // re-render restores the chip text from fresh state
        }
      }
      syncCctvCalReadout(mgr, Boolean(mgr._cctvState?.enabled), mgr._cctvState?.activeCamera || null);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
      event.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (event) => event.stopPropagation());
}

/**
 * Synchronizes the pose readout chips, ADJUST button, and SAVE/RESET
 * disabled states with the active camera.
 * @param {object} mgr - StyleManager instance holding the calibration chips and the ADJUST/SAVE/RESET buttons that get synchronized.
 * @param {boolean} enabled - Whether the CCTV layer is currently enabled.
 * @param {object|null} activeCamera - The active camera data object (may be null).
 * @returns {void}
 */
function syncCctvCalReadout(mgr, enabled, activeCamera) {
    const canCalibrate = Boolean(enabled) && Boolean(activeCamera);
    if (mgr._cctvAdjustBtn) {
      const adjustOn = Boolean(mgr._cctvState?.calibrationMode);
      mgr._cctvAdjustBtn.classList.toggle('active', adjustOn && canCalibrate);
      mgr._cctvAdjustBtn.textContent = adjustOn ? 'ADJUST ON' : 'ADJUST';
      mgr._cctvAdjustBtn.disabled = !canCalibrate;
    }
    if (mgr._cctvCalReadout) {
      for (const chip of mgr._cctvCalReadout.querySelectorAll('.cctv-cal-value')) {
        if (chip.querySelector('input')) continue; // an edit is in flight — don't clobber
        const field = CCTV_CAL_FIELDS[chip.dataset.calField];
        if (!field) continue;
        const value = canCalibrate ? field.get(activeCamera) : null;
        chip.textContent = Number.isFinite(value)
          ? `${field.label} ${Number(value).toFixed(field.decimals)}${field.unit}`
          : `${field.label} --`;
        chip.disabled = !canCalibrate;
      }
    }
    for (const el of [mgr._cctvCalibSaveBtn, mgr._cctvCalibResetBtn]) {
      if (el) el.disabled = !canCalibrate;
    }
}

/**
 * Toggles the CCTV layer enabled state. When enabling and no camera is active,
 * auto-focuses on the nearest camera.
 * @param {object} mgr - StyleManager instance whose data manager, toast, cockpit view, and CCTV focus helper drive the toggle.
 * @param {boolean} [forceState] - Explicit on/off. Omit to toggle.
 * @returns {Promise<boolean>} True if the layer is now in the requested state.
 */
export async function toggleCctvEnabled(mgr, forceState) {
    if (!mgr._dataManager || !mgr._dataManager.layers?.has('cctv')) {
      mgr._showToast('CCTV layer unavailable');
      return false;
    }
    const enabled = mgr._dataManager.isEnabled('cctv');
    const target = typeof forceState === 'boolean' ? forceState : !enabled;
    if (target === enabled) return true;
    await runCctvLayerEnableTransition({
      target,
      setEnabled: (next) => mgr._dataManager.setEnabled('cctv', next, { origin: 'user' }),
      readOwnership: () => ({
        trackedEntity: mgr.viewer?.trackedEntity,
        // eslint-disable-next-line no-implicit-coercion -- source-contract test pins the !! form (cameraHandoff.test.mjs)
        cockpitActive: !!mgr.cockpitView?.active,
      }),
      shouldFocus: () => !mgr._cctvState?.activeCameraId,
      activate: () => cctvLayer.focusNearest({ focus: false }),
      fly: (cameraId) => mgr._runExplicitCctvFocus(
        () => cameraId,
        (selectedId) => cctvLayer.focusCamera(selectedId, 1.6),
      ),
    });
    return true;
}

/**
 * Maps a `deriveCalBadge` value (cctv.js) to its panel copy. Single source
 * of truth for CAL-badge casing — used by both the quality chip and the
 * meta line so the two never drift onto different label conventions.
 * @param {object} mgr - StyleManager instance; unused by this pure label mapper (kept for the module's manager-first helper signature).
 * @param {'calibrated'|'curated'|'raw-prior'|null} badge - Badge state from cctv.js.
 * @returns {string} Display label, or '--' when there is no active camera.
 */
function calBadgeLabel(mgr, badge) {
    switch (badge) {
      case 'calibrated': return 'CALIBRATED';
      case 'curated': return 'CURATED';
      case 'raw-prior': return 'RAW PRIOR';
      default: return '--';
    }
}

/**
 * Full re-render of the CCTV panel UI from a CCTV layer state snapshot.
 * Updates enable button, camera select dropdown, navigation buttons,
 * coverage/auto-hop/projection toggles, quality chip, source badge,
 * metadata line, frame image, calibration controls, and summary text.
 * @param {object} mgr - StyleManager instance holding the CCTV panel controls, cached state, and summary elements the render writes.
 * @param {object|null} state - CCTV layer UI state, or null to render empty.
 * @returns {void}
 */
export function renderCctvState(mgr, state) {
    mgr._cctvState = state || null;
    const cameras = state?.cameras || [];
    const enabled = Boolean(state?.enabled) && Boolean(mgr._dataManager?.isEnabled('cctv'));
    const activeId = state?.activeCameraId || '';
    const activeCamera = state?.activeCamera || null;

    // Auto-expand the panel when the active camera CHANGES to a new non-null
    // id while the layer is enabled. Covers click-on-globe, panel controls,
    // and voice (selectCamera/cycleCamera/focusNearest all notify through
    // this subscription). The last-seen guard keeps routine notifications
    // from re-expanding a panel the user deliberately collapsed, and timed
    // auto-hop transitions only expand on the first activation so the panel
    // does not pop open on every hop.
    const effectiveActiveId = enabled ? (activeId || null) : null;
    const isFirstActivation = mgr._lastSeenCctvActiveId === null;
    if (effectiveActiveId
      && effectiveActiveId !== mgr._lastSeenCctvActiveId
      && (!state?.autoHop || isFirstActivation)) {
      mgr.setPanelCollapsed('cctv-panel', false, { explicit: Boolean(state?.explicitSelection) });
    }
    mgr._lastSeenCctvActiveId = effectiveActiveId;

    mgr._updateCctvSyncChip(state?.loading, enabled);

    if (mgr._cctvEnableBtn) {
      mgr._cctvEnableBtn.classList.toggle('active', enabled);
      mgr._cctvEnableBtn.textContent = enabled ? 'CCTV ON' : 'CCTV OFF';
    }

    if (mgr._cctvSelect) {
      const shouldRebuild = mgr._cctvSelect.options.length !== cameras.length
        || cameras.some((cam, idx) => mgr._cctvSelect.options[idx]?.value !== cam.id);
      if (shouldRebuild) {
        mgr._cctvSelect.innerHTML = '';
        for (const camera of cameras) {
          const option = document.createElement('option');
          option.value = camera.id;
          option.textContent = `${camera.city} · ${camera.name}`;
          mgr._cctvSelect.appendChild(option);
        }
      }
      mgr._cctvSelect.disabled = !enabled || cameras.length === 0;
      if (activeId && Array.from(mgr._cctvSelect.options).some((opt) => opt.value === activeId)) {
        mgr._cctvSelect.value = activeId;
      } else if (!activeId) {
        mgr._cctvSelect.selectedIndex = -1;
      }
    }

    for (const btn of [mgr._cctvNearestBtn, mgr._cctvPrevBtn, mgr._cctvNextBtn]) {
      if (!btn) continue;
      btn.disabled = !enabled || cameras.length === 0;
    }
    if (mgr._cctvFocusBtn) {
      mgr._cctvFocusBtn.disabled = !enabled || cameras.length === 0 || !activeId;
    }

    if (mgr._cctvCoverageBtn) {
      // Tri-state (viewshed design §3b): off → on (wireframes) → viewshed
      // (color-coded volumes). The click handler cycles; this renders.
      const mode = state?.coverageMode || (state?.showCoverage ? 'on' : 'off');
      mgr._cctvCoverageBtn.classList.toggle('active', mode !== 'off');
      mgr._cctvCoverageBtn.textContent = mode === 'viewshed'
        ? 'VIEWSHED ON'
        : mode === 'on' ? 'COVERAGE ON' : 'COVERAGE OFF';
      mgr._cctvCoverageBtn.disabled = !enabled;
    }

    if (mgr._cctvAutoHopBtn) {
      const autoHop = Boolean(state?.autoHop);
      mgr._cctvAutoHopBtn.classList.toggle('active', autoHop);
      mgr._cctvAutoHopBtn.textContent = autoHop ? 'AUTO HOP ON' : 'AUTO HOP OFF';
      mgr._cctvAutoHopBtn.disabled = !enabled;
    }

    if (mgr._cctvProjectionBtn) {
      const showProjection = state?.showProjection !== false;
      mgr._cctvProjectionBtn.classList.toggle('active', showProjection);
      mgr._cctvProjectionBtn.textContent = showProjection ? 'PROJECTION ON' : 'PROJECTION OFF';
      mgr._cctvProjectionBtn.disabled = !enabled;
    }

    if (mgr._cctvQualityChip) {
      // CAL badge (cctv-v2 design §3b, amended by LOCKED §9.2 — panel-only,
      // no in-world tint): three states driven by cctv.js's deriveCalBadge,
      // no client-side scoring math. Casing is unified via _calBadgeLabel so
      // the chip and the meta line never drift onto different conventions.
      // Save-gated persistence (viewshed design §3e): unsaved live edits show
      // EDITED on top of whatever the persisted badge state is — SAVE CAL
      // promotes to CALIBRATED, RESET CAL clears.
      const badge = activeCamera?.calBadge || null;
      const dirty = Boolean(activeCamera?.calDirty);
      mgr._cctvQualityChip.textContent = dirty
        ? 'CAL · EDITED (UNSAVED)'
        : `CAL · ${calBadgeLabel(mgr, badge)}`;
      mgr._cctvQualityChip.dataset.calBadge = dirty ? 'edited' : (badge || '');
    }

    syncCctvCalReadout(mgr, enabled, activeCamera);

    if (mgr._cctvMeta) {
      if (activeCamera) {
        const provider = activeCamera.sourceLabel || activeCamera.provider || 'Configured Source';
        const statusMsg = activeCamera.sourceMessage ? ` · ${activeCamera.sourceMessage}` : '';
        const calBadge = activeCamera.calBadge ? calBadgeLabel(mgr, activeCamera.calBadge) : '';
        const projLabel = state?.showProjection !== false ? 'MONITOR' : 'OFF';
        mgr._cctvMeta.textContent = `${activeCamera.city} · HDG ${Math.round(activeCamera.headingDeg)}° · FOV ${Math.round(activeCamera.fovDeg)}° · RANGE ${Math.round(activeCamera.rangeM)}m · ${projLabel}${calBadge ? ` · ${calBadge}` : ''} · ${provider}${statusMsg}`;
      } else if (cameras.length > 0) {
        mgr._cctvMeta.textContent = enabled
          ? `${cameras.length} cameras loaded · click a camera to activate`
          : `${cameras.length} cameras loaded · enable CCTV to activate`;
      } else {
        mgr._cctvMeta.textContent = 'Enable CCTV to load camera intersections';
      }
    }

    if (mgr._cctvFrame) {
      const nextSrc = enabled ? activeCamera?.frameUrl : null;
      const nextCameraId = enabled ? (activeCamera?.id || '') : '';
      const cameraChanged = mgr._cctvFrame.dataset.cameraId !== nextCameraId;
      const frameLoading = mgr._cctvFrame.dataset.loading === 'true';
      // A same-camera refresh waits for the current image to settle. Replacing
      // src every 10 seconds can cancel a slow but healthy decode forever and
      // leave SNAPSHOT · OK beside a blank/loading preview. Camera changes are
      // immediate so navigation never waits on the prior camera's request.
      if (nextSrc && (cameraChanged || (!frameLoading && mgr._cctvFrame.dataset.currentSrc !== nextSrc))) {
        queueCctvFrame(mgr, nextSrc, nextCameraId, cameraChanged);
      }
      if (!nextSrc) {
        clearCctvFrame(mgr);
      }
    }

    syncCctvSourceBadge(mgr, activeCamera, enabled);
    typeCctvSummary(mgr, state?.summary || 'Enable CCTV to start camera-linked intelligence summaries.');
}

/**
 * Typewriter-animates CCTV summary text into the summary element.
 * Skips animation if the text hasn't changed since the last call.
 * Advances 3 characters per 20ms tick for a fast teletype effect.
 * @param {object} mgr - StyleManager instance holding the summary element and the typing timer state it advances.
 * @param {string} text - Summary text to display.
 * @returns {void}
 */
function typeCctvSummary(mgr, text) {
    if (!mgr._cctvSummary) return;
    const nextText = String(text || '').trim() || 'No summary available.';
    if (nextText === mgr._lastCctvSummaryText) return;
    mgr._lastCctvSummaryText = nextText;

    clearInterval(mgr._cctvSummaryTypingTimer);
    mgr._cctvSummary.textContent = '';
    let idx = 0;
    mgr._cctvSummaryTypingTimer = setInterval(() => {
      idx += 3;
      if (idx >= nextText.length) {
        mgr._cctvSummary.textContent = nextText;
        clearInterval(mgr._cctvSummaryTypingTimer);
        mgr._cctvSummaryTypingTimer = null;
        return;
      }
      mgr._cctvSummary.textContent = nextText.slice(0, idx);
    }, 20);
}

