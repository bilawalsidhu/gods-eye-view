/**
 * Radio panel — the independent Radio companion controls, extracted from
 * src/ui.js (Batch 5 seam 2). StyleManager keeps the public method surface
 * (_initRadioPanel/_syncContextRadioLauncherState/_renderRadioState) as thin
 * delegates; this module owns the wiring and rendering, receiving the manager
 * as its first parameter. Radio DATA and tuning math live in src/data/radio.js;
 * nothing here decides layer lifecycle.
 */

import radioLayer, {
  buildRadioTunerTicks,
  radioTunerCommitSlot,
  radioTunerPointerPosition,
  radioTunerSlot,
} from '../data/radio.js';

/** Wire the independent Radio companion controls. */
export function initRadioPanel(mgr) {
    if (!mgr._radioPanel) return;
    mgr._radioTunerAbort?.abort();
    mgr._radioTunerAbort = new AbortController();
    const tunerListenerOptions = { signal: mgr._radioTunerAbort.signal };
    const setRadioDisclosure = (expanded, { returnFocus = false } = {}) => {
      const open = Boolean(expanded);
      mgr._contextRadioDock?.classList.toggle('disclosure-open', open);
      if (mgr._contextRadioMini) mgr._contextRadioMini.hidden = !open;
      syncContextRadioLauncherState(mgr);
      if (!open && returnFocus) mgr._contextRadioToggleBtn?.focus({ preventScroll: true });
    };
    mgr._setRadioDisclosure = setRadioDisclosure;
    const setCockpitDisclosure = (kind, expanded, { returnFocus = false } = {}) => {
      const displayOpen = kind === 'display' && Boolean(expanded);
      const radioOpen = kind === 'radio' && Boolean(expanded);
      // Idempotence: re-asserting an already-open disclosure must not re-run
      // the reveal flow — its deferred scrollIntoView would yank the panel
      // away from a position the user (or a portal restore) just set, and it
      // lands after the portal scroll guard clears, so it would also be
      // recorded as user intent.
      if (displayOpen && mgr._cockpitDisplayToggleBtn?.getAttribute('aria-expanded') === 'true') {
        return;
      }
      if (radioOpen && mgr._cockpitRadioToggleBtn?.getAttribute('aria-expanded') === 'true') {
        return;
      }
      if (displayOpen || radioOpen) mgr.cockpitView?.setSignalCollapsed(true);
      if (mgr._cockpitDisplayPanel) mgr._cockpitDisplayPanel.hidden = !displayOpen;
      if (mgr._cockpitRadioPanel) mgr._cockpitRadioPanel.hidden = !radioOpen;
      mgr._cockpitDisplayToggleBtn?.closest('.cockpit-utility-control')
        ?.classList.toggle('is-expanded', displayOpen);
      mgr._cockpitRadioToggleBtn?.closest('.cockpit-utility-control')
        ?.classList.toggle('is-expanded', radioOpen);
      mgr._cockpitDisplayToggleBtn?.setAttribute('aria-expanded', String(displayOpen));
      mgr._cockpitRadioToggleBtn?.setAttribute('aria-expanded', String(radioOpen));
      if (displayOpen) mgr._revealCockpitStyleParameters();
      if (mgr._cockpitDisplayToggleBtn) {
        const action = displayOpen ? 'Collapse' : 'Expand';
        mgr._cockpitDisplayToggleBtn.textContent = displayOpen ? '▶' : '◀';
        mgr._cockpitDisplayToggleBtn.setAttribute('aria-label', `${action} Cockpit display options`);
        mgr._cockpitDisplayToggleBtn.title = `${action} Cockpit display options`;
      }
      if (mgr._cockpitRadioToggleBtn) {
        const action = radioOpen ? 'Collapse' : 'Expand';
        mgr._cockpitRadioToggleBtn.textContent = radioOpen ? '▶' : '◀';
        mgr._cockpitRadioToggleBtn.setAttribute('aria-label', `${action} Cockpit Radio controls`);
        mgr._cockpitRadioToggleBtn.title = `${action} Cockpit Radio controls`;
      }
      if (!expanded && returnFocus) {
        (kind === 'display' ? mgr._cockpitDisplayToggleBtn : mgr._cockpitRadioToggleBtn)
          ?.focus({ preventScroll: true });
      }
      if (!displayOpen && !radioOpen
          && mgr.cockpitView?.active
          && !mgr.cockpitView.signalUserCollapsed) {
        mgr.cockpitView.setSignalCollapsed(false);
      }
      mgr.cockpitView?.scheduleContextLayout();
    };
    mgr._setCockpitDisclosure = setCockpitDisclosure;
    const syncTunerTape = (coordinate) => {
      const scale = mgr._radioTuner?.querySelector('.radio-tuner-scale');
      const dial = mgr._radioTuner?.querySelector('.radio-tuner-dial');
      if (!scale || !dial) return null;
      const model = buildRadioTunerTicks(
        coordinate,
        mgr._radioTunerStations.length,
        dial.getBoundingClientRect().width,
      );
      while (scale.children.length < model.ticks.length) {
        const tick = document.createElement('span');
        tick.className = 'radio-tuner-tick';
        scale.append(tick);
      }
      while (scale.children.length > model.ticks.length) scale.lastElementChild?.remove();
      model.ticks.forEach((entry, index) => {
        const tick = scale.children[index];
        tick.style.left = `${entry.xPx}px`;
        tick.textContent = entry.label;
        tick.dataset.stationIndex = String(entry.stationIndex);
        tick.classList.toggle('is-current', entry.current);
      });
      scale.style.setProperty('--radio-tuner-tick-pitch', `${model.pitchPx}px`);
      return model;
    };
    const tunerPreview = ({ coordinate = mgr._radioTunerCoordinate, syncStatic = true, rotate = true } = {}) => {
      const slot = radioTunerSlot(mgr._radioTunerSlider?.value, mgr._radioTunerStations.length);
      const station = slot.locked ? mgr._radioTunerStations[slot.stationIndex] || null : null;
      const resolvedCoordinate = mgr._radioTunerStations.length <= 1
        ? 0
        : Math.min(mgr._radioTunerStations.length - 1, Math.max(0, Number(coordinate) || 0));
      const ratio = mgr._radioTunerStations.length === 1
        ? 0.5
        : resolvedCoordinate / Math.max(1, mgr._radioTunerStations.length - 1);
      mgr._radioTunerCoordinate = resolvedCoordinate;
      mgr._radioTuner?.style.setProperty('--radio-tuner-ratio', String(ratio));
      mgr._radioTuner?.classList.toggle('is-static', syncStatic ? false : Boolean(mgr._radioState?.tuningStatic));
      syncTunerTape(resolvedCoordinate);
      if (mgr._radioTunerValue) {
        mgr._radioTunerValue.textContent = station
          ? `CH ${String(slot.stationIndex + 1).padStart(2, '0')} / ${String(mgr._radioTunerStations.length).padStart(2, '0')}`
          : 'NO STATIONS';
      }
      if (mgr._radioTunerStation) mgr._radioTunerStation.textContent = station?.name || 'NO STATION AVAILABLE';
      if (mgr._radioTunerSlider) {
        mgr._radioTunerSlider.setAttribute('aria-valuetext', station
          ? `${station.name}, station ${slot.stationIndex + 1} of ${mgr._radioTunerStations.length}`
          : 'No station available');
      }
      if (syncStatic) radioLayer.previewTuningStation(station?.id || null, { rotate });
      return station;
    };
    const setTunerDirectory = (pool) => {
      mgr._radioTunerPool = [...pool];
      mgr._radioTunerStations = [...pool];
      mgr._radioTunerBandSignature = mgr._radioTunerStations.map((station) => station.id).join('|');
      if (mgr._radioTunerSlider) {
        mgr._radioTunerSlider.min = '0';
        mgr._radioTunerSlider.max = String(Math.max(0, mgr._radioTunerStations.length - 1));
        mgr._radioTunerSlider.step = '1';
      }
    };
    const refreshTunerBand = ({ force = false } = {}) => {
      if (mgr._radioTunerDragging || mgr._radioTuner?.hidden || mgr._radioTunerSlider?.disabled) return false;
      const selectedId = mgr._radioState?.selected?.id || null;
      const pool = radioLayer.getTunerStations(750);
      const poolSignature = pool.map((station) => station.id).join('|');
      const currentPoolSignature = mgr._radioTunerPool.map((station) => station.id).join('|');
      if (!force && poolSignature === currentPoolSignature && selectedId === mgr._radioTunerSelectedId) return false;
      setTunerDirectory(pool);
      mgr._radioTunerSelectedId = selectedId;
      const selectedPoolIndex = pool.findIndex((station) => station.id === selectedId);
      const slot = radioTunerSlot(selectedPoolIndex >= 0 ? selectedPoolIndex : 0, mgr._radioTunerStations.length);
      mgr._radioTunerSlider.value = String(slot.slot);
      mgr._radioTunerCoordinate = slot.stationIndex >= 0 ? slot.stationIndex : 0;
      tunerPreview({ coordinate: mgr._radioTunerCoordinate, syncStatic: false });
      return true;
    };
    mgr._refreshRadioTunerBand = refreshTunerBand;
    const beginTuner = () => {
      if (mgr._radioTunerDragging || mgr._radioTunerSlider?.disabled) return false;
      refreshTunerBand();
      if (!mgr._radioTunerStations.length || !radioLayer.beginTuning()) return false;
      // A tuner-owned camera preview must never replace the frozen directory.
      // Only an explicit globe pointer/wheel gesture releases camera pinning.
      mgr._radioTunerBandPinnedForNavigation = true;
      mgr._radioTunerDragging = true;
      mgr._radioTuner?.classList.add('is-dragging');
      const selectedIndex = mgr._radioTunerStations.findIndex((station) => station.id === mgr._radioState?.selected?.id);
      const slot = radioTunerSlot(selectedIndex >= 0 ? selectedIndex : 0, mgr._radioTunerStations.length);
      mgr._radioTunerSlider.value = String(slot.slot);
      mgr._radioTunerCoordinate = slot.stationIndex >= 0 ? slot.stationIndex : 0;
      mgr._radioTunerDragStartSlot = slot.slot;
      mgr._radioTunerDragSnapshot = {
        stations: [...mgr._radioTunerStations],
        bandSignature: mgr._radioTunerBandSignature,
        selectedId: mgr._radioTunerSelectedId,
        slot: slot.slot,
        coordinate: mgr._radioTunerCoordinate,
      };
      mgr._radioTunerLastSlot = slot.slot;
      mgr._radioTunerDragDirection = 0;
      tunerPreview({ coordinate: mgr._radioTunerCoordinate });
      return true;
    };
    const finishTuner = (commit) => {
      if (!mgr._radioTunerDragging) return;
      const dragSnapshot = mgr._radioTunerDragSnapshot;
      if (!commit && dragSnapshot) {
        mgr._radioTunerStations = [...dragSnapshot.stations];
        mgr._radioTunerPool = [...dragSnapshot.stations];
        mgr._radioTunerBandSignature = dragSnapshot.bandSignature;
        mgr._radioTunerSelectedId = dragSnapshot.selectedId;
        if (mgr._radioTunerSlider) {
          const startSlot = radioTunerSlot(dragSnapshot.slot, mgr._radioTunerStations.length);
          mgr._radioTunerSlider.max = String(startSlot.max);
          mgr._radioTunerSlider.value = String(startSlot.slot);
        }
        mgr._radioTunerCoordinate = Number.isFinite(dragSnapshot.coordinate)
          ? dragSnapshot.coordinate
          : dragSnapshot.slot;
      } else if (!commit && mgr._radioTunerSlider) {
        mgr._radioTunerSlider.value = String(mgr._radioTunerDragStartSlot);
        mgr._radioTunerCoordinate = mgr._radioTunerDragStartSlot;
      }
      let station = tunerPreview({ coordinate: mgr._radioTunerCoordinate, rotate: commit });
      if (commit && !station && mgr._radioTunerSlider) {
        const snapped = radioTunerCommitSlot(
          mgr._radioTunerSlider.value,
          mgr._radioTunerStations.length,
        );
        mgr._radioTunerSlider.value = String(snapped.slot);
        mgr._radioTunerCoordinate = snapped.stationIndex;
        station = tunerPreview({ coordinate: mgr._radioTunerCoordinate });
      }
      let result = null;
      if (commit && station) {
        // Keep the exact band used by the drag so the selected channel cannot
        // jump to a refreshed catalog slot while its camera flight settles.
        mgr._radioTunerBandPinnedForNavigation = true;
        result = radioLayer.commitTuningStation(station.id, { origin: 'user' });
      } else if (!commit) {
        radioLayer.cancelTuning();
      } else {
        radioLayer.endTuning();
      }
      // Radio emits selection/tuning state synchronously. Keep both the logical
      // drag and the no-transition class active until that state has settled,
      // then restore the exact selected slot before permitting CSS motion.
      mgr._radioTunerDragging = false;
      mgr._radioTunerPointerId = null;
      mgr._radioTunerKeyboardKey = null;
      if (commit && (!result || result.ok)) refreshTunerBand();
      mgr._radioTunerDragSnapshot = null;
      // Flush the snapped position while transitions are still disabled so
      // removing the drag class cannot interpolate from the released gap.
      void mgr._radioTunerNeedle?.offsetLeft;
      mgr._radioTuner?.classList.remove('is-dragging');
      if (result && !result.ok) {
        mgr._radioTunerBandPinnedForNavigation = false;
        if (result.reason === 'station-unavailable') {
          if (mgr._radioTunerValue) mgr._radioTunerValue.textContent = 'OFF AIR';
          if (mgr._radioTunerStation) mgr._radioTunerStation.textContent = 'STATION UNAVAILABLE';
          mgr._radioTunerSlider?.setAttribute(
            'aria-valuetext',
            'Station unavailable after directory refresh',
          );
        }
      }
    };
    const cycleRadio = (direction, { rotate = true } = {}) => {
      mgr._radioTunerBandPinnedForNavigation = true;
      const pool = mgr._radioTunerPool.length ? mgr._radioTunerPool : mgr._radioTunerStations;
      const cycled = radioLayer.cycleStation(direction, {
        rotate,
        stationIds: pool.map((station) => station.id),
        origin: 'user',
      });
      if (!cycled) {
        mgr._radioTunerBandPinnedForNavigation = false;
        return;
      }
    };
    const toggleRadio = async (trigger) => {
      if (!mgr._dataManager?.layers?.has('radio')) return;
      const enabling = !mgr._dataManager.isEnabled('radio');
      const revealAfterEnable = enabling && trigger === mgr._radioEnableBtn;
      trigger.disabled = true;
      try {
        const toggled = await mgr._runUserFacingContextAction(
          (notificationToken) => mgr._dataManager.setEnabled('radio', enabling, {
            origin: 'user',
            notificationToken,
          }),
          `Radio could not ${enabling ? 'start' : 'stop'} cleanly`,
        );
        if (toggled === false) return;
        if (enabling && trigger === mgr._radioEnableBtn
            && !document.getElementById('global-context-panel')?.classList.contains('collapsed')) {
          mgr.setPanelCollapsed('radio-panel', false, { explicit: true });
        }
        if (revealAfterEnable) await revealRadioControlsAfterExplicitEnable(mgr, trigger);
      } finally {
        trigger.disabled = false;
        if (revealAfterEnable && trigger.isConnected) trigger.focus({ preventScroll: true });
      }
    };
    mgr._radioEnableBtn?.addEventListener('click', () => void toggleRadio(mgr._radioEnableBtn));
    mgr._contextRadioMiniEnableBtn?.addEventListener('click', () => void toggleRadio(mgr._contextRadioMiniEnableBtn));
    mgr._cockpitRadioEnableBtn?.addEventListener('click', () => void toggleRadio(mgr._cockpitRadioEnableBtn));
    mgr._contextRadioToggleBtn?.addEventListener('click', () => {
      const contextPanel = document.getElementById('global-context-panel');
      if (contextPanel && !contextPanel.classList.contains('collapsed')) {
        setRadioDisclosure(false);
        mgr.setPanelCollapsed('radio-panel', false, { explicit: true });
        void revealRadioPanelInsideContext(mgr, {
          focusTarget: mgr._radioPanel?.querySelector('[data-collapse-target="radio-panel"]'),
        });
        return;
      }
      setRadioDisclosure(!mgr._contextRadioDock?.classList.contains('disclosure-open'));
    });
    mgr._contextRadioMiniCloseBtn?.addEventListener('click', () => {
      setRadioDisclosure(false, { returnFocus: true });
    });
    mgr._contextRadioDetailsBtn?.addEventListener('click', () => {
      if (!mgr.cockpitView?.active) mgr.setPanelCollapsed('global-context-panel', false, { explicit: true });
      mgr.setPanelCollapsed('radio-panel', false, { explicit: true });
      setRadioDisclosure(false);
      mgr._radioEnableBtn?.focus({ preventScroll: true });
    });
    mgr._cockpitRadioToggleBtn?.addEventListener('click', () => {
      const open = mgr._cockpitRadioToggleBtn.getAttribute('aria-expanded') === 'true';
      setCockpitDisclosure('radio', !open);
    });
    document.addEventListener('pointerdown', (event) => {
      if (!mgr._contextRadioDock?.classList.contains('disclosure-open')) return;
      if (event.target?.closest?.('#context-radio-dock')) return;
      setRadioDisclosure(false);
    }, tunerListenerOptions);
    document.addEventListener('pointerdown', (event) => {
      if (!mgr._cockpitUtilityControls || event.target?.closest?.('#cockpit-utility-controls')) return;
      if (event.target?.closest?.('.cockpit-vision-controls')) return;
      if (event.target?.closest?.('#left-panel-stack, #cockpit-context')) return;
      setCockpitDisclosure('display', false);
      setCockpitDisclosure('radio', false);
    }, tunerListenerOptions);
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !mgr._contextRadioDock?.classList.contains('disclosure-open')) return;
      event.preventDefault();
      // Immediate: a plain stopPropagation() still lets every LATER listener on
      // this same document run, so closing the disclosure ALSO dismissed the
      // first-run launcher — one key, two actions. Matches the cockpit
      // disclosure handler directly below.
      event.stopImmediatePropagation();
      setRadioDisclosure(false, { returnFocus: true });
    }, { capture: true, signal: mgr._radioTunerAbort.signal });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const displayOpen = mgr._cockpitDisplayToggleBtn?.getAttribute('aria-expanded') === 'true';
      const radioOpen = mgr._cockpitRadioToggleBtn?.getAttribute('aria-expanded') === 'true';
      if (!displayOpen && !radioOpen) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setCockpitDisclosure(displayOpen ? 'display' : 'radio', false, { returnFocus: true });
    }, { capture: true, signal: mgr._radioTunerAbort.signal });
    window.addEventListener('gev:cockpit-mode-changed', (event) => {
      if (event?.detail?.active) return;
      setCockpitDisclosure('display', false);
      setCockpitDisclosure('radio', false);
    }, tunerListenerOptions);
    window.addEventListener('gev:cockpit-signal-expanded', () => {
      setCockpitDisclosure('display', false);
    }, tunerListenerOptions);
    window.addEventListener('gev:cockpit-context-expanded', () => {
      mgr.setPanelCollapsed('data-panel', true);
    }, tunerListenerOptions);
    mgr._radioFilter?.addEventListener('change', () => {
      const presentation = radioLayer.getUIState();
      if (!presentation.presentationActive) {
        mgr._radioFilter.value = presentation.filter;
        return;
      }
      if (mgr._radioTunerDragging) finishTuner(false);
      if (!mgr._dataManager?.setLayerParams('radio', {
        filter: mgr._radioFilter.value,
      }, { origin: 'user' })) {
        mgr._radioFilter.value = radioLayer.getUIState().filter;
        return;
      }
      mgr._radioTunerBandPinnedForNavigation = false;
      mgr._radioTunerPool = [];
      refreshTunerBand({ force: true });
    });
    mgr._radioPrevBtn?.addEventListener('click', () => cycleRadio(-1));
    mgr._radioNextBtn?.addEventListener('click', () => cycleRadio(1));
    mgr._radioPlayBtn?.addEventListener('click', () => void radioLayer.togglePlayback({ origin: 'user' }));
    mgr._radioStopBtn?.addEventListener('click', () => radioLayer.stopPlayback({ origin: 'user' }));
    mgr._radioVolume?.addEventListener('input', () => {
      const value = Number(mgr._radioVolume.value);
      if (mgr._radioVolumeValue) mgr._radioVolumeValue.textContent = `${value}%`;
      mgr._dataManager?.setLayerParams('radio', { volume: value / 100 }, { origin: 'user' });
    });
    mgr._contextRadioMiniPrevBtn?.addEventListener('click', () => cycleRadio(-1));
    mgr._contextRadioMiniNextBtn?.addEventListener('click', () => cycleRadio(1));
    mgr._contextRadioMiniPlayBtn?.addEventListener('click', () => void radioLayer.togglePlayback({ origin: 'user' }));
    // Cockpit owns the Cesium camera even though it intentionally clears
    // viewer.trackedEntity. Station changes must never start the map-view
    // rotation/fallback flights that would compete with its preUpdate pose.
    mgr._cockpitRadioPrevBtn?.addEventListener('click', () => cycleRadio(-1, { rotate: false }));
    mgr._cockpitRadioNextBtn?.addEventListener('click', () => cycleRadio(1, { rotate: false }));
    mgr._cockpitRadioPlayBtn?.addEventListener('click', () => void radioLayer.togglePlayback({ origin: 'user' }));
    mgr._contextRadioMiniVolume?.addEventListener('input', () => {
      const value = Number(mgr._contextRadioMiniVolume.value);
      if (mgr._contextRadioMiniVolumeValue) mgr._contextRadioMiniVolumeValue.textContent = `${value}%`;
      mgr._dataManager?.setLayerParams('radio', { volume: value / 100 }, { origin: 'user' });
    });
    mgr._cockpitRadioVolume?.addEventListener('input', () => {
      const value = Number(mgr._cockpitRadioVolume.value);
      if (mgr._cockpitRadioVolumeValue) mgr._cockpitRadioVolumeValue.textContent = `${value}%`;
      mgr._dataManager?.setLayerParams('radio', { volume: value / 100 }, { origin: 'user' });
    });
    const updateTunerFromPointer = (event) => {
      const rect = mgr._radioTunerSlider?.getBoundingClientRect();
      if (!rect || !mgr._radioTunerStations.length) return false;
      const position = radioTunerPointerPosition(
        event.clientX,
        rect.left,
        rect.width,
        mgr._radioTunerStations.length,
      );
      if (position.stationIndex > mgr._radioTunerLastSlot) mgr._radioTunerDragDirection = 1;
      else if (position.stationIndex < mgr._radioTunerLastSlot) mgr._radioTunerDragDirection = -1;
      mgr._radioTunerLastSlot = position.stationIndex;
      mgr._radioTunerCoordinate = position.coordinate;
      mgr._radioTunerSlider.value = String(position.stationIndex);
      tunerPreview({ coordinate: position.coordinate });
      return true;
    };
    mgr._radioTunerSlider?.addEventListener('pointerdown', (event) => {
      if (!beginTuner()) return;
      mgr._radioTunerPointerId = event.pointerId;
      mgr._radioTunerSlider.focus({ preventScroll: true });
      try { mgr._radioTunerSlider.setPointerCapture(event.pointerId); } catch { /* capture is best effort */ }
      updateTunerFromPointer(event);
      event.preventDefault();
    }, tunerListenerOptions);
    mgr._radioTunerSlider?.addEventListener('pointermove', (event) => {
      if (!mgr._radioTunerDragging || mgr._radioTunerPointerId !== event.pointerId) return;
      updateTunerFromPointer(event);
      event.preventDefault();
    }, tunerListenerOptions);
    mgr._radioTunerSlider?.addEventListener('input', () => {
      if (mgr._radioTunerPointerId !== null || mgr._radioTunerKeyboardKey) return;
      if (!mgr._radioTunerDragging && !beginTuner()) return;
      const inputSlot = radioTunerSlot(mgr._radioTunerSlider.value, mgr._radioTunerStations.length);
      if (inputSlot.slot > mgr._radioTunerLastSlot) mgr._radioTunerDragDirection = 1;
      else if (inputSlot.slot < mgr._radioTunerLastSlot) mgr._radioTunerDragDirection = -1;
      mgr._radioTunerLastSlot = inputSlot.slot;
      mgr._radioTunerCoordinate = inputSlot.stationIndex;
      tunerPreview({ coordinate: mgr._radioTunerCoordinate });
    }, tunerListenerOptions);
    mgr._radioTunerSlider?.addEventListener('change', () => {
      if (mgr._radioTunerPointerId === null && !mgr._radioTunerKeyboardKey) finishTuner(true);
    }, tunerListenerOptions);
    mgr._radioTunerSlider?.addEventListener('pointerup', (event) => {
      if (mgr._radioTunerPointerId !== event.pointerId) return;
      updateTunerFromPointer(event);
      finishTuner(true);
      try { mgr._radioTunerSlider.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      event.preventDefault();
    }, tunerListenerOptions);
    mgr._radioTunerSlider?.addEventListener('pointercancel', (event) => {
      if (mgr._radioTunerPointerId !== null && mgr._radioTunerPointerId !== event.pointerId) return;
      try { mgr._radioTunerSlider.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      finishTuner(false);
    }, tunerListenerOptions);
    mgr._radioTunerSlider?.addEventListener('lostpointercapture', (event) => {
      if (mgr._radioTunerDragging && mgr._radioTunerPointerId === event.pointerId) finishTuner(false);
    }, tunerListenerOptions);
    mgr._radioTunerSlider?.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && mgr._radioTunerDragging) {
        event.preventDefault();
        finishTuner(false);
        return;
      }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
      if (!mgr._radioTunerDragging && !beginTuner()) return;
      event.preventDefault();
      mgr._radioTunerKeyboardKey = event.key;
      const max = Math.max(0, mgr._radioTunerStations.length - 1);
      const current = radioTunerSlot(mgr._radioTunerSlider.value, mgr._radioTunerStations.length).slot;
      const page = Math.max(1, Math.round(max / 10));
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? max
          : event.key === 'PageUp' ? current + page
            : event.key === 'PageDown' ? current - page
              : current + (event.key === 'ArrowRight' ? 1 : -1);
      const slot = radioTunerSlot(next, mgr._radioTunerStations.length);
      if (slot.slot > mgr._radioTunerLastSlot) mgr._radioTunerDragDirection = 1;
      else if (slot.slot < mgr._radioTunerLastSlot) mgr._radioTunerDragDirection = -1;
      mgr._radioTunerLastSlot = slot.slot;
      mgr._radioTunerCoordinate = slot.stationIndex;
      mgr._radioTunerSlider.value = String(slot.slot);
      tunerPreview({ coordinate: mgr._radioTunerCoordinate });
    }, tunerListenerOptions);
    mgr._radioTunerSlider?.addEventListener('keyup', (event) => {
      if (!mgr._radioTunerKeyboardKey || event.key !== mgr._radioTunerKeyboardKey) return;
      event.preventDefault();
      finishTuner(true);
    }, tunerListenerOptions);
    mgr._radioTunerSlider?.addEventListener('blur', () => finishTuner(true), tunerListenerOptions);
    const releaseNavigationBand = () => {
      mgr._radioTunerBandPinnedForNavigation = false;
    };
    mgr.viewer?.canvas?.addEventListener('pointerdown', releaseNavigationBand, tunerListenerOptions);
    mgr.viewer?.canvas?.addEventListener('wheel', releaseNavigationBand, tunerListenerOptions);
    // The directory order is catalog/filter authority, not camera authority.
    // Globe motion therefore never rebuilds or re-ranks the frequency band.
    mgr._radioTunerCameraRemove?.();
    mgr._radioTunerCameraRemove = null;
    mgr._radioSelectedHandler = () => mgr.setPanelCollapsed('radio-panel', false);
    document.addEventListener('gev:radio-selected', mgr._radioSelectedHandler);
}

/**
 * Reveal the newly enabled directory and transport inside Context without
 * moving focus, the page, or the globe. Only the expanded Enable path calls
 * this helper.
 * @param {object} mgr - StyleManager instance holding the radio panel DOM and playback state that gate the scroll.
 * @param {HTMLElement} trigger Initiating Radio Enable button.
 * @returns {Promise<boolean>} Whether the internal scroller moved.
 */
async function revealRadioControlsAfterExplicitEnable(mgr, trigger) {
    const contextPanel = document.getElementById('global-context-panel');
    const scroller = contextPanel?.querySelector('.global-context-panel-inner');
    const directory = mgr._radioPanel?.querySelector('.radio-directory-row');
    const transport = mgr._radioPanel?.querySelector('.radio-transport');
    if (!contextPanel || contextPanel.classList.contains('collapsed')
        || !scroller || !directory || !transport || !mgr._radioState?.enabled) return false;

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!mgr._radioState?.enabled || !trigger?.isConnected) return false;

    const viewport = scroller.getBoundingClientRect();
    const directoryRect = directory.getBoundingClientRect();
    const transportRect = transport.getBoundingClientRect();
    const margin = 10;
    const minimum = scroller.scrollTop + transportRect.bottom - (viewport.bottom - margin);
    const maximum = scroller.scrollTop + directoryRect.top - (viewport.top + margin);
    const desired = minimum <= maximum
      ? Math.min(Math.max(scroller.scrollTop, minimum), maximum)
      : minimum;
    const next = Math.min(
      Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      Math.max(0, desired),
    );
    if (Math.abs(next - scroller.scrollTop) < 1) return false;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    scroller.scrollTo({ top: next, behavior: reducedMotion ? 'auto' : 'smooth' });
    return true;
}

/**
 * Bring the embedded Radio section into the expanded Context scroller.
 * This never changes Radio power, playback, selection, or Context mode.
 * @param {object} mgr - StyleManager instance holding the radio panel element whose position drives the scroll.
 * @param {{focusTarget?: HTMLElement|null}} [options]
 * @returns {Promise<boolean>} Whether the internal scroller moved.
 */
async function revealRadioPanelInsideContext(mgr, { focusTarget = null } = {}) {
    const contextPanel = document.getElementById('global-context-panel');
    const scroller = contextPanel?.querySelector('.global-context-panel-inner');
    if (!contextPanel || contextPanel.classList.contains('collapsed')
        || !scroller || !mgr._radioPanel || mgr._radioPanel.classList.contains('collapsed')) return false;

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (contextPanel.classList.contains('collapsed') || mgr._radioPanel.classList.contains('collapsed')) return false;

    const viewport = scroller.getBoundingClientRect();
    const radioRect = mgr._radioPanel.getBoundingClientRect();
    const desired = scroller.scrollTop + radioRect.top - viewport.top - 10;
    const next = Math.min(
      Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      Math.max(0, desired),
    );
    const moved = Math.abs(next - scroller.scrollTop) >= 1;
    if (moved) {
      const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      scroller.scrollTo({ top: next, behavior: reducedMotion ? 'auto' : 'smooth' });
    }
    focusTarget?.focus?.({ preventScroll: true });
    return moved;
}

/** Keep the Context header Radio shortcut truthful for its current route. */
export function syncContextRadioLauncherState(mgr) {
    if (!mgr._contextRadioToggleBtn) return;
    const contextPanel = document.getElementById('global-context-panel');
    const contextExpanded = Boolean(contextPanel && !contextPanel.classList.contains('collapsed'));
    if (contextExpanded) {
      const radioExpanded = Boolean(mgr._radioPanel && !mgr._radioPanel.classList.contains('collapsed'));
      mgr._contextRadioToggleBtn.setAttribute('aria-controls', 'radio-panel');
      mgr._contextRadioToggleBtn.setAttribute('aria-expanded', String(radioExpanded));
      const label = radioExpanded ? 'Go to expanded Radio section' : 'Expand Radio section in Context';
      mgr._contextRadioToggleBtn.setAttribute('aria-label', label);
      mgr._contextRadioToggleBtn.title = label;
      return;
    }
    const compactOpen = Boolean(mgr._contextRadioDock?.classList.contains('disclosure-open'));
    mgr._contextRadioToggleBtn.setAttribute('aria-controls', 'context-radio-mini');
    mgr._contextRadioToggleBtn.setAttribute('aria-expanded', String(compactOpen));
    const action = compactOpen ? 'Close' : 'Open';
    mgr._contextRadioToggleBtn.setAttribute('aria-label', `${action} compact Radio controls`);
    mgr._contextRadioToggleBtn.title = `${action} compact Radio controls`;
}

/** Render Radio state without making playback or Context decisions. */
export function renderRadioState(mgr, state) {
    if (!state || !mgr._radioPanel) return;
    const lifecycle = mgr._dataManager?.getLayerLifecycleState?.('radio') || null;
    const lifecycleState = lifecycle?.lifecycleState || (state.enabled ? 'enabled' : 'disabled');
    state = {
      ...state,
      enabled: lifecycle ? lifecycle.enabled : state.enabled,
      lifecycleState,
      lifecycleUncertain: lifecycle?.uncertain || false,
    };
    mgr._radioState = state;
    const enabled = Boolean(state.enabled);
    const transitioning = lifecycleState === 'enabling' || lifecycleState === 'disabling';
    const uncertain = Boolean(state.lifecycleUncertain);
    const interactive = enabled && !transitioning && !uncertain;
    const selected = state.selected || null;
    const hasStations = state.filteredCount > 0;
    const activePlayback = ['playing', 'buffering'].includes(state.audioState);
    document.getElementById('title-bar')?.classList.toggle('radio-broadcasting', state.audioState === 'playing');
    mgr._radioPanel.classList.toggle('radio-enabled', enabled);
    mgr._radioPanel.classList.toggle('lifecycle-uncertain', uncertain);
    mgr._contextRadioDock?.classList.toggle('active', enabled);
    if (mgr._contextRadioToggleBtn) {
      mgr._contextRadioToggleBtn.classList.toggle('active', enabled);
    }
    syncContextRadioLauncherState(mgr);
    mgr._radioLayerState?.classList.toggle('active', enabled);
    if (mgr._radioLayerState) {
      mgr._radioLayerState.textContent = transitioning
        ? lifecycleState.toUpperCase()
        : (uncertain ? 'UNCERTAIN' : (state.loading ? 'SYNC' : (enabled ? `${state.filteredCount}/${state.stationCount}` : 'OFF')));
    }
    if (mgr._radioEnableBtn) {
      mgr._radioEnableBtn.classList.toggle('active', enabled);
      mgr._radioEnableBtn.setAttribute('aria-pressed', String(enabled));
      mgr._radioEnableBtn.textContent = transitioning
        ? lifecycleState.toUpperCase()
        : (uncertain ? 'RECONCILE' : (enabled ? 'DISABLE' : 'ENABLE'));
      mgr._radioEnableBtn.setAttribute(
        'aria-label',
        uncertain ? 'Reconcile Radio — lifecycle uncertain' : `${enabled ? 'Disable' : 'Enable'} Radio`,
      );
      mgr._radioEnableBtn.disabled = transitioning;
    }
    if (mgr._contextRadioMiniEnableBtn) {
      mgr._contextRadioMiniEnableBtn.classList.toggle('active', enabled);
      mgr._contextRadioMiniEnableBtn.setAttribute('aria-pressed', String(enabled));
      mgr._contextRadioMiniEnableBtn.textContent = transitioning
        ? lifecycleState.toUpperCase()
        : (uncertain ? 'RECONCILE' : (enabled ? 'DISABLE' : 'ENABLE'));
      mgr._contextRadioMiniEnableBtn.setAttribute(
        'aria-label',
        uncertain ? 'Reconcile Radio — lifecycle uncertain' : `${enabled ? 'Disable' : 'Enable'} Radio`,
      );
      mgr._contextRadioMiniEnableBtn.disabled = transitioning;
    }
    if (mgr._cockpitRadioEnableBtn) {
      mgr._cockpitRadioEnableBtn.classList.toggle('active', enabled);
      mgr._cockpitRadioEnableBtn.setAttribute('aria-pressed', String(enabled));
      mgr._cockpitRadioEnableBtn.textContent = transitioning
        ? lifecycleState.toUpperCase()
        : (uncertain ? 'RECONCILE' : (enabled ? 'DISABLE' : 'ENABLE'));
      mgr._cockpitRadioEnableBtn.setAttribute(
        'aria-label',
        uncertain ? 'Reconcile Radio — lifecycle uncertain' : `${enabled ? 'Disable' : 'Enable'} Radio`,
      );
      mgr._cockpitRadioEnableBtn.disabled = transitioning;
    }

    if (mgr._radioFilter) {
      const prior = state.filter || 'all';
      const categorySignature = state.categories
        .map((category) => `${category.id}:${category.count}:${category.color}`)
        .join('|');
      if (categorySignature !== mgr._radioCategorySignature) {
        mgr._radioFilter.replaceChildren(...state.categories.map((category) => {
          const option = document.createElement('option');
          option.value = category.id;
          option.textContent = `● ${category.label} (${category.count})`;
          option.dataset.radioColor = category.color;
          option.style.color = category.color;
          option.setAttribute('aria-label', `${category.label} (${category.count})`);
          return option;
        }));
        mgr._radioCategorySignature = categorySignature;
      }
      mgr._radioFilter.value = prior;
      const activeCategory = state.categories.find((category) => category.id === prior);
      mgr._radioFilter.style.color = activeCategory?.color || '';
      mgr._radioFilter.disabled = !interactive || !state.stationCount;
    }

    const tunerAvailable = interactive && state.filteredCount > 0;
    if (mgr._radioTuner) mgr._radioTuner.hidden = !tunerAvailable;
    if (mgr._radioTunerSlider) mgr._radioTunerSlider.disabled = !tunerAvailable;
    if (mgr._radioTunerBandLabel) {
      const activeCategory = state.categories.find((category) => category.id === state.filter);
      mgr._radioTunerBandLabel.textContent = state.filter === 'all'
        ? 'DIRECTORY BAND'
        : `${String(activeCategory?.label || state.filter).toUpperCase()} BAND`;
    }
    mgr._radioTuner?.classList.toggle('is-static', Boolean(state.tuningStatic));
    if (tunerAvailable) mgr._refreshRadioTunerBand?.();
    if (!tunerAvailable && mgr._radioTunerDragging) {
      mgr._radioTunerDragging = false;
      mgr._radioTunerDragSnapshot = null;
      mgr._radioTunerStations = [];
      mgr._radioTuner?.classList.remove('is-static', 'is-dragging');
    }
    if (!tunerAvailable) {
      mgr._radioTunerStations = [];
      mgr._radioTunerPool = [];
      mgr._radioTunerBandSignature = '';
      mgr._radioTunerSelectedId = null;
    }

    if (mgr._radioStationName) mgr._radioStationName.textContent = selected?.name || 'NO STATION SELECTED';
    if (mgr._radioStationMeta) {
      const place = selected ? [selected.state, selected.countryCode].filter(Boolean).join(' · ') : '';
      const signal = selected ? [selected.codec, selected.bitrate ? `${selected.bitrate} kbps` : ''].filter(Boolean).join(' · ') : '';
      mgr._radioStationMeta.textContent = selected
        ? [place, signal].filter(Boolean).join('  /  ') || 'Directory metadata only'
        : (state.loading ? 'Loading station directory…' : 'Choose a globe marker or use next.');
    }
    if (mgr._radioStationTags) {
      const tags = Array.isArray(selected?.tags) ? selected.tags.slice(0, 8) : [];
      mgr._radioStationTags.textContent = tags.length ? `TAGS · ${tags.join(' · ')}` : '';
    }
    if (mgr._radioStationHomepage) {
      const homepage = selected?.homepage || '';
      mgr._radioStationHomepage.hidden = !homepage;
      if (homepage) mgr._radioStationHomepage.href = homepage;
      else mgr._radioStationHomepage.removeAttribute('href');
    }

    if (mgr._radioPrevBtn) mgr._radioPrevBtn.disabled = !interactive || !hasStations;
    if (mgr._radioNextBtn) mgr._radioNextBtn.disabled = !interactive || !hasStations;
    if (mgr._contextRadioMiniPrevBtn) mgr._contextRadioMiniPrevBtn.disabled = !interactive || !hasStations;
    if (mgr._contextRadioMiniNextBtn) mgr._contextRadioMiniNextBtn.disabled = !interactive || !hasStations;
    if (mgr._cockpitRadioPrevBtn) mgr._cockpitRadioPrevBtn.disabled = !interactive || !hasStations;
    if (mgr._cockpitRadioNextBtn) mgr._cockpitRadioNextBtn.disabled = !interactive || !hasStations;
    if (mgr._radioPlayBtn) {
      const action = activePlayback ? 'Pause' : (state.audioState === 'paused' ? 'Resume' : 'Play');
      mgr._radioPlayBtn.disabled = !interactive || !hasStations;
      mgr._radioPlayBtn.classList.toggle('active', activePlayback);
      mgr._radioPlayBtn.textContent = action.toUpperCase();
      mgr._radioPlayBtn.setAttribute('aria-label', `${action} ${selected ? 'selected' : 'nearest'} radio station`);
    }
    if (mgr._contextRadioMiniPlayBtn) {
      const action = activePlayback ? 'Pause' : (state.audioState === 'paused' ? 'Resume' : 'Play');
      mgr._contextRadioMiniPlayBtn.disabled = !interactive || !hasStations;
      mgr._contextRadioMiniPlayBtn.classList.toggle('active', activePlayback);
      mgr._contextRadioMiniPlayBtn.textContent = activePlayback ? 'Ⅱ' : '▶';
      mgr._contextRadioMiniPlayBtn.setAttribute('aria-label', `${action} ${selected ? 'selected' : 'nearest'} radio station`);
      mgr._contextRadioMiniPlayBtn.title = action;
    }
    if (mgr._cockpitRadioPlayBtn) {
      const action = activePlayback ? 'Pause' : (state.audioState === 'paused' ? 'Resume' : 'Play');
      mgr._cockpitRadioPlayBtn.disabled = !interactive || !hasStations;
      mgr._cockpitRadioPlayBtn.classList.toggle('active', activePlayback);
      mgr._cockpitRadioPlayBtn.textContent = activePlayback ? 'Ⅱ' : '▶';
      mgr._cockpitRadioPlayBtn.setAttribute('aria-label', `${action} ${selected ? 'selected' : 'nearest'} radio station`);
      mgr._cockpitRadioPlayBtn.title = action;
    }
    if (mgr._radioStopBtn) mgr._radioStopBtn.disabled = !interactive || state.audioState === 'stopped';
    if (mgr._radioVolume) mgr._radioVolume.disabled = !interactive;
    if (mgr._radioVolume && document.activeElement !== mgr._radioVolume) {
      mgr._radioVolume.value = String(Math.round(state.volume * 100));
      if (mgr._radioVolumeValue) mgr._radioVolumeValue.textContent = `${Math.round(state.volume * 100)}%`;
    }
    if (mgr._contextRadioMiniVolume && document.activeElement !== mgr._contextRadioMiniVolume) {
      mgr._contextRadioMiniVolume.value = String(Math.round(state.volume * 100));
    }
    if (mgr._contextRadioMiniVolume) mgr._contextRadioMiniVolume.disabled = !interactive;
    if (mgr._contextRadioMiniVolumeValue) {
      mgr._contextRadioMiniVolumeValue.textContent = `${Math.round(state.volume * 100)}%`;
    }
    if (mgr._cockpitRadioVolume && document.activeElement !== mgr._cockpitRadioVolume) {
      mgr._cockpitRadioVolume.value = String(Math.round(state.volume * 100));
    }
    if (mgr._cockpitRadioVolume) mgr._cockpitRadioVolume.disabled = !interactive;
    if (mgr._cockpitRadioVolumeValue) {
      mgr._cockpitRadioVolumeValue.textContent = `${Math.round(state.volume * 100)}%`;
    }
    if (mgr._contextRadioMiniStation) {
      mgr._contextRadioMiniStation.textContent = uncertain
        ? 'RADIO STATE UNCERTAIN'
        : (selected?.name || (state.loading ? 'SYNCING DIRECTORY' : 'RADIO READY'));
    }
    if (mgr._cockpitRadioStation) {
      mgr._cockpitRadioStation.textContent = uncertain
        ? 'UNCERTAIN'
        : (selected?.name || (state.loading ? 'SYNCING' : 'READY'));
    }
    if (mgr._radioPlaybackState) {
      const catalogSuffix = state.degraded
        ? (state.stale ? ' · stale/degraded directory' : ' · degraded directory')
        : (state.stale ? ' · stale directory' : '');
      const outsideFilter = selected && state.selectedIndex < 0 ? ' · outside current filter' : '';
      const messages = {
        stopped: enabled ? 'Ready — playback starts only from your action' : 'Radio off',
        loading: 'Connecting directly to broadcaster…',
        buffering: 'Buffering broadcaster stream…',
        playing: `Playing ${selected?.name || 'station'}`,
        paused: `Paused ${selected?.name || 'station'}`,
        error: state.audioError || 'Broadcaster stream unavailable',
      };
      const voiceSuffix = state.voiceDucked
        ? ' · muted during voice interaction'
        : (state.voiceRestoring ? ' · restoring volume after voice' : '');
      const tuningSuffix = state.tuningAwaitingStationId
        ? (state.audioState === 'error'
          ? ' · static indicates no broadcaster audio'
          : ' · tuning static until broadcaster starts')
        : '';
      const unavailable = state.tuningUnavailableStationId
        ? 'Station unavailable after directory refresh — choose another channel'
        : null;
      const lifecycleMessage = transitioning
        ? (lifecycleState === 'enabling' ? 'Radio is enabling…' : 'Radio is disabling…')
        : null;
      const uncertainMessage = uncertain
        ? 'Radio lifecycle is uncertain — use Enable or Disable to reconcile'
        : null;
      mgr._radioPlaybackState.textContent = `${uncertainMessage || unavailable || lifecycleMessage || state.error || messages[state.audioState] || 'Ready'}${tuningSuffix}${voiceSuffix}${catalogSuffix}${outsideFilter}`;
      mgr._radioPlaybackState.classList.toggle('error', Boolean(uncertainMessage || unavailable || state.error || state.audioState === 'error'));
    }
    if (
      !enabled
      && !transitioning
      && !mgr._preservePanelStateDuringLayerClear
      && !mgr._radioPanel.classList.contains('collapsed')
    ) {
      mgr.setPanelCollapsed('radio-panel', true);
    }
    mgr._scheduleRightPanelLayout();
}
