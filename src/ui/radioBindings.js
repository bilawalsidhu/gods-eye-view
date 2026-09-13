import {
  radioTunerSlot,
  radioTunerCommitSlot,
  radioTunerPointerPosition,
  buildRadioTunerTicks,
} from './radioTunerModel.js';

/** Bind Radio input using a RadioControls receiver and supplied actions. */
export function bindRadioControls() {
  if (!this._radioPanel) return;
  const tunerListenerOptions = {};
  const setRadioDisclosure = (expanded, { returnFocus = false } = {}) => {
    if (this.destroyed) return;
    const open = Boolean(expanded);
    this._contextRadioDock?.classList.toggle('disclosure-open', open);
    if (this._contextRadioMini) this._contextRadioMini.hidden = !open;
    this._syncContextRadioLauncherState();
    if (!open && returnFocus)
      this._contextRadioToggleBtn?.focus({ preventScroll: true });
  };
  this._setRadioDisclosure = setRadioDisclosure;
  const setCockpitDisclosure = (
    kind,
    expanded,
    { returnFocus = false } = {},
  ) => {
    if (this.destroyed) return;
    const displayOpen = kind === 'display' && Boolean(expanded);
    const radioOpen = kind === 'radio' && Boolean(expanded);
    if (displayOpen || radioOpen) this.actions.setSignalCollapsed(true);
    if (this._cockpitDisplayPanel)
      this._cockpitDisplayPanel.hidden = !displayOpen;
    if (this._cockpitRadioPanel) this._cockpitRadioPanel.hidden = !radioOpen;
    this._cockpitDisplayToggleBtn
      ?.closest('.cockpit-utility-control')
      ?.classList.toggle('is-expanded', displayOpen);
    this._cockpitRadioToggleBtn
      ?.closest('.cockpit-utility-control')
      ?.classList.toggle('is-expanded', radioOpen);
    this._cockpitDisplayToggleBtn?.setAttribute(
      'aria-expanded',
      String(displayOpen),
    );
    this._cockpitRadioToggleBtn?.setAttribute(
      'aria-expanded',
      String(radioOpen),
    );
    if (displayOpen) this.actions.revealStyleParameters();
    if (this._cockpitDisplayToggleBtn) {
      const action = displayOpen ? 'Collapse' : 'Expand';
      this._cockpitDisplayToggleBtn.textContent = displayOpen ? '▶' : '◀';
      this._cockpitDisplayToggleBtn.setAttribute(
        'aria-label',
        `${action} Cockpit display options`,
      );
      this._cockpitDisplayToggleBtn.title = `${action} Cockpit display options`;
    }
    if (this._cockpitRadioToggleBtn) {
      const action = radioOpen ? 'Collapse' : 'Expand';
      this._cockpitRadioToggleBtn.textContent = radioOpen ? '▶' : '◀';
      this._cockpitRadioToggleBtn.setAttribute(
        'aria-label',
        `${action} Cockpit Radio controls`,
      );
      this._cockpitRadioToggleBtn.title = `${action} Cockpit Radio controls`;
    }
    if (!expanded && returnFocus) {
      (kind === 'display'
        ? this._cockpitDisplayToggleBtn
        : this._cockpitRadioToggleBtn
      )?.focus({ preventScroll: true });
    }
    if (
      !displayOpen &&
      !radioOpen &&
      this.actions.isCockpitActive() &&
      !this.actions.signalUserCollapsed()
    ) {
      this.actions.setSignalCollapsed(false);
    }
    this.actions.layoutCockpit();
  };
  this._setCockpitDisclosure = setCockpitDisclosure;
  const syncTunerTape = (coordinate) => {
    const scale = this._radioTuner?.querySelector('.radio-tuner-scale');
    const dial = this._radioTuner?.querySelector('.radio-tuner-dial');
    if (!scale || !dial) return null;
    const model = buildRadioTunerTicks(
      coordinate,
      this._radioTunerStations.length,
      dial.getBoundingClientRect().width,
    );
    while (scale.children.length < model.ticks.length) {
      const tick = document.createElement('span');
      tick.className = 'radio-tuner-tick';
      scale.append(tick);
    }
    while (scale.children.length > model.ticks.length)
      scale.lastElementChild?.remove();
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
  const tunerPreview = ({
    coordinate = this._radioTunerCoordinate,
    syncStatic = true,
    rotate = true,
  } = {}) => {
    const slot = radioTunerSlot(
      this._radioTunerSlider?.value,
      this._radioTunerStations.length,
    );
    const station = slot.locked
      ? this._radioTunerStations[slot.stationIndex] || null
      : null;
    const resolvedCoordinate =
      this._radioTunerStations.length <= 1
        ? 0
        : Math.min(
            this._radioTunerStations.length - 1,
            Math.max(0, Number(coordinate) || 0),
          );
    const ratio =
      this._radioTunerStations.length === 1
        ? 0.5
        : resolvedCoordinate / Math.max(1, this._radioTunerStations.length - 1);
    this._radioTunerCoordinate = resolvedCoordinate;
    this._radioTuner?.style.setProperty('--radio-tuner-ratio', String(ratio));
    this._radioTuner?.classList.toggle(
      'is-static',
      syncStatic ? false : Boolean(this._radioState?.tuningStatic),
    );
    syncTunerTape(resolvedCoordinate);
    if (this._radioTunerValue) {
      this._radioTunerValue.textContent = station
        ? `CH ${String(slot.stationIndex + 1).padStart(2, '0')} / ${String(this._radioTunerStations.length).padStart(2, '0')}`
        : 'NO STATIONS';
    }
    if (this._radioTunerStation)
      this._radioTunerStation.textContent =
        station?.name || 'NO STATION AVAILABLE';
    if (this._radioTunerSlider) {
      this._radioTunerSlider.setAttribute(
        'aria-valuetext',
        station
          ? `${station.name}, station ${slot.stationIndex + 1} of ${this._radioTunerStations.length}`
          : 'No station available',
      );
    }
    if (syncStatic)
      this.radio.previewTuningStation(station?.id || null, { rotate });
    return station;
  };
  const setTunerDirectory = (pool) => {
    this._radioTunerPool = [...pool];
    this._radioTunerStations = [...pool];
    this._radioTunerBandSignature = this._radioTunerStations
      .map((station) => station.id)
      .join('|');
    if (this._radioTunerSlider) {
      this._radioTunerSlider.min = '0';
      this._radioTunerSlider.max = String(
        Math.max(0, this._radioTunerStations.length - 1),
      );
      this._radioTunerSlider.step = '1';
    }
  };
  const refreshTunerBand = ({ force = false } = {}) => {
    if (
      this._radioTunerDragging ||
      this._radioTuner?.hidden ||
      this._radioTunerSlider?.disabled
    )
      return false;
    const selectedId = this._radioState?.selected?.id || null;
    const pool = this.radio.getTunerStations(750);
    const poolSignature = pool.map((station) => station.id).join('|');
    const currentPoolSignature = this._radioTunerPool
      .map((station) => station.id)
      .join('|');
    if (
      !force &&
      poolSignature === currentPoolSignature &&
      selectedId === this._radioTunerSelectedId
    )
      return false;
    setTunerDirectory(pool);
    this._radioTunerSelectedId = selectedId;
    const selectedPoolIndex = pool.findIndex(
      (station) => station.id === selectedId,
    );
    const slot = radioTunerSlot(
      selectedPoolIndex >= 0 ? selectedPoolIndex : 0,
      this._radioTunerStations.length,
    );
    this._radioTunerSlider.value = String(slot.slot);
    this._radioTunerCoordinate = slot.stationIndex >= 0 ? slot.stationIndex : 0;
    tunerPreview({ coordinate: this._radioTunerCoordinate, syncStatic: false });
    return true;
  };
  this._refreshRadioTunerBand = refreshTunerBand;
  const beginTuner = () => {
    if (this._radioTunerDragging || this._radioTunerSlider?.disabled)
      return false;
    refreshTunerBand();
    if (!this._radioTunerStations.length || !this.radio.beginTuning())
      return false;
    // A tuner-owned camera preview must never replace the frozen directory.
    // Only an explicit globe pointer/wheel gesture releases camera pinning.
    this._radioTunerBandPinnedForNavigation = true;
    this._radioTunerDragging = true;
    this._radioTuner?.classList.add('is-dragging');
    const selectedIndex = this._radioTunerStations.findIndex(
      (station) => station.id === this._radioState?.selected?.id,
    );
    const slot = radioTunerSlot(
      selectedIndex >= 0 ? selectedIndex : 0,
      this._radioTunerStations.length,
    );
    this._radioTunerSlider.value = String(slot.slot);
    this._radioTunerCoordinate = slot.stationIndex >= 0 ? slot.stationIndex : 0;
    this._radioTunerDragStartSlot = slot.slot;
    this._radioTunerDragSnapshot = {
      stations: [...this._radioTunerStations],
      bandSignature: this._radioTunerBandSignature,
      selectedId: this._radioTunerSelectedId,
      slot: slot.slot,
      coordinate: this._radioTunerCoordinate,
    };
    this._radioTunerLastSlot = slot.slot;
    this._radioTunerDragDirection = 0;
    tunerPreview({ coordinate: this._radioTunerCoordinate });
    return true;
  };
  const finishTuner = (commit) => {
    if (!this._radioTunerDragging) return;
    const dragSnapshot = this._radioTunerDragSnapshot;
    if (!commit && dragSnapshot) {
      this._radioTunerStations = [...dragSnapshot.stations];
      this._radioTunerPool = [...dragSnapshot.stations];
      this._radioTunerBandSignature = dragSnapshot.bandSignature;
      this._radioTunerSelectedId = dragSnapshot.selectedId;
      if (this._radioTunerSlider) {
        const startSlot = radioTunerSlot(
          dragSnapshot.slot,
          this._radioTunerStations.length,
        );
        this._radioTunerSlider.max = String(startSlot.max);
        this._radioTunerSlider.value = String(startSlot.slot);
      }
      this._radioTunerCoordinate = Number.isFinite(dragSnapshot.coordinate)
        ? dragSnapshot.coordinate
        : dragSnapshot.slot;
    } else if (!commit && this._radioTunerSlider) {
      this._radioTunerSlider.value = String(this._radioTunerDragStartSlot);
      this._radioTunerCoordinate = this._radioTunerDragStartSlot;
    }
    let station = tunerPreview({
      coordinate: this._radioTunerCoordinate,
      rotate: commit,
    });
    if (commit && !station && this._radioTunerSlider) {
      const snapped = radioTunerCommitSlot(
        this._radioTunerSlider.value,
        this._radioTunerStations.length,
      );
      this._radioTunerSlider.value = String(snapped.slot);
      this._radioTunerCoordinate = snapped.stationIndex;
      station = tunerPreview({ coordinate: this._radioTunerCoordinate });
    }
    let result = null;
    if (commit && station) {
      // Keep the exact band used by the drag so the selected channel cannot
      // jump to a refreshed catalog slot while its camera flight settles.
      this._radioTunerBandPinnedForNavigation = true;
      result = this.radio.commitTuningStation(station.id, { origin: 'user' });
    } else if (!commit) {
      this.radio.cancelTuning();
    } else {
      this.radio.endTuning();
    }
    // Radio emits selection/tuning state synchronously. Keep both the logical
    // drag and the no-transition class active until that state has settled,
    // then restore the exact selected slot before permitting CSS motion.
    this._radioTunerDragging = false;
    this._radioTunerPointerId = null;
    this._radioTunerKeyboardKey = null;
    if (commit && (!result || result.ok)) refreshTunerBand();
    this._radioTunerDragSnapshot = null;
    // Flush the snapped position while transitions are still disabled so
    // removing the drag class cannot interpolate from the released gap.
    void this._radioTunerNeedle?.offsetLeft;
    this._radioTuner?.classList.remove('is-dragging');
    if (result && !result.ok) {
      this._radioTunerBandPinnedForNavigation = false;
      if (result.reason === 'station-unavailable') {
        if (this._radioTunerValue)
          this._radioTunerValue.textContent = 'OFF AIR';
        if (this._radioTunerStation)
          this._radioTunerStation.textContent = 'STATION UNAVAILABLE';
        this._radioTunerSlider?.setAttribute(
          'aria-valuetext',
          'Station unavailable after directory refresh',
        );
      }
    }
  };
  const cycleRadio = (direction, { rotate = true } = {}) => {
    this._radioTunerBandPinnedForNavigation = true;
    const pool = this._radioTunerPool.length
      ? this._radioTunerPool
      : this._radioTunerStations;
    const cycled = this.radio.cycleStation(direction, {
      rotate,
      stationIds: pool.map((station) => station.id),
      origin: 'user',
    });
    if (!cycled) {
      this._radioTunerBandPinnedForNavigation = false;
      return;
    }
  };
  const toggleRadio = async (trigger) => {
    if (!this.actions.isRegistered()) return;
    if (trigger.getAttribute('aria-busy') === 'true') return;
    const enabling = !this.actions.isEnabled();
    const revealAfterEnable = enabling && trigger === this._radioEnableBtn;
    trigger.setAttribute('aria-disabled', 'true');
    trigger.setAttribute('aria-busy', 'true');
    try {
      const toggled = await this.actions.runUserAction(
        (notificationToken) =>
          this.actions.setEnabled(enabling, {
            origin: 'user',
            notificationToken,
          }),
        `Radio could not ${enabling ? 'start' : 'stop'} cleanly`,
      );
      if (this.destroyed || toggled === false) return;
      if (
        enabling &&
        trigger === this._radioEnableBtn &&
        !document
          .getElementById('global-context-panel')
          ?.classList.contains('collapsed')
      ) {
        this.actions.setPanelCollapsed('radio-panel', false, {
          explicit: true,
        });
      }
      if (revealAfterEnable)
        await this._revealRadioControlsAfterExplicitEnable(trigger);
    } finally {
      if (!this.destroyed) {
        trigger.setAttribute('aria-disabled', 'false');
        trigger.setAttribute('aria-busy', 'false');
        if (revealAfterEnable && trigger.isConnected)
          trigger.focus({ preventScroll: true });
      }
    }
  };
  this.listen(
    this._radioEnableBtn,
    'click',
    () => void toggleRadio(this._radioEnableBtn),
  );
  this.listen(
    this._contextRadioMiniEnableBtn,
    'click',
    () => void toggleRadio(this._contextRadioMiniEnableBtn),
  );
  this.listen(
    this._cockpitRadioEnableBtn,
    'click',
    () => void toggleRadio(this._cockpitRadioEnableBtn),
  );
  this.listen(this._contextRadioToggleBtn, 'click', () => {
    const contextPanel = document.getElementById('global-context-panel');
    if (contextPanel && !contextPanel.classList.contains('collapsed')) {
      setRadioDisclosure(false);
      this.actions.setPanelCollapsed('radio-panel', false, { explicit: true });
      void this._revealRadioPanelInsideContext({
        focusTarget: this._radioPanel?.querySelector(
          '[data-collapse-target="radio-panel"]',
        ),
      });
      return;
    }
    setRadioDisclosure(
      !this._contextRadioDock?.classList.contains('disclosure-open'),
    );
  });
  this.listen(this._contextRadioMiniCloseBtn, 'click', () => {
    setRadioDisclosure(false, { returnFocus: true });
  });
  this.listen(this._contextRadioDetailsBtn, 'click', () => {
    if (!this.actions.isCockpitActive())
      this.actions.setPanelCollapsed('global-context-panel', false, {
        explicit: true,
      });
    this.actions.setPanelCollapsed('radio-panel', false, { explicit: true });
    setRadioDisclosure(false);
    this._radioEnableBtn?.focus({ preventScroll: true });
  });
  this.listen(this._cockpitRadioToggleBtn, 'click', () => {
    const open =
      this._cockpitRadioToggleBtn.getAttribute('aria-expanded') === 'true';
    setCockpitDisclosure('radio', !open);
  });
  this.listen(
    document,
    'pointerdown',
    (event) => {
      if (!this._contextRadioDock?.classList.contains('disclosure-open'))
        return;
      if (event.target?.closest?.('#context-radio-dock')) return;
      setRadioDisclosure(false);
    },
    tunerListenerOptions,
  );
  this.listen(
    document,
    'pointerdown',
    (event) => {
      if (
        !this._cockpitUtilityControls ||
        event.target?.closest?.('#cockpit-utility-controls')
      )
        return;
      if (event.target?.closest?.('.cockpit-vision-controls')) return;
      if (event.target?.closest?.('#left-panel-stack, #cockpit-context'))
        return;
      setCockpitDisclosure('display', false);
      setCockpitDisclosure('radio', false);
    },
    tunerListenerOptions,
  );
  this.listen(
    document,
    'keydown',
    (event) => {
      if (
        event.key !== 'Escape' ||
        !this._contextRadioDock?.classList.contains('disclosure-open')
      )
        return;
      event.preventDefault();
      // Immediate: a plain stopPropagation() still lets every LATER listener on
      // this same document run, so closing the disclosure ALSO dismissed the
      // first-run launcher — one key, two actions. Matches the cockpit
      // disclosure handler directly below.
      event.stopImmediatePropagation();
      const escapedFromDisclosure =
        event.target === this._contextRadioToggleBtn ||
        this._contextRadioToggleBtn?.contains?.(event.target);
      setRadioDisclosure(false, { returnFocus: !escapedFromDisclosure });
      if (escapedFromDisclosure) this._contextRadioToggleBtn?.blur?.();
    },
    { capture: true },
  );
  this.listen(
    document,
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      const displayOpen =
        this._cockpitDisplayToggleBtn?.getAttribute('aria-expanded') === 'true';
      const radioOpen =
        this._cockpitRadioToggleBtn?.getAttribute('aria-expanded') === 'true';
      if (!displayOpen && !radioOpen) return;
      const nestedPanel = event.target?.closest?.(
        '.panel-collapsible:not(.collapsed), #param-slider-panel:not(.collapsed)',
      );
      if (nestedPanel) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const kind = displayOpen ? 'display' : 'radio';
      const disclosure = displayOpen
        ? this._cockpitDisplayToggleBtn
        : this._cockpitRadioToggleBtn;
      const escapedFromDisclosure =
        event.target === disclosure || disclosure?.contains?.(event.target);
      setCockpitDisclosure(kind, false, {
        returnFocus: !escapedFromDisclosure,
      });
      if (escapedFromDisclosure) disclosure?.blur?.();
    },
    { capture: true },
  );
  this.listen(
    window,
    'gev:cockpit-mode-changed',
    (event) => {
      if (event?.detail?.active) return;
      setCockpitDisclosure('display', false);
      setCockpitDisclosure('radio', false);
    },
    tunerListenerOptions,
  );
  this.listen(
    window,
    'gev:cockpit-signal-expanded',
    () => {
      setCockpitDisclosure('display', false);
    },
    tunerListenerOptions,
  );
  this.listen(
    window,
    'gev:cockpit-context-expanded',
    () => {
      this.actions.setPanelCollapsed('data-panel', true);
    },
    tunerListenerOptions,
  );
  this.listen(this._radioFilter, 'change', () => {
    const presentation = this.radio.getUIState();
    if (!presentation.presentationActive) {
      this._radioFilter.value = presentation.filter;
      return;
    }
    if (this._radioTunerDragging) finishTuner(false);
    if (
      !this.actions.setParams(
        {
          filter: this._radioFilter.value,
        },
        { origin: 'user' },
      )
    ) {
      this._radioFilter.value = this.radio.getUIState().filter;
      return;
    }
    this._radioTunerBandPinnedForNavigation = false;
    this._radioTunerPool = [];
    refreshTunerBand({ force: true });
  });
  this.listen(this._radioPrevBtn, 'click', () => cycleRadio(-1));
  this.listen(this._radioNextBtn, 'click', () => cycleRadio(1));
  this.listen(
    this._radioPlayBtn,
    'click',
    () => void this.radio.togglePlayback({ origin: 'user' }),
  );
  this.listen(this._radioStopBtn, 'click', () =>
    this.radio.stopPlayback({ origin: 'user' }),
  );
  this.listen(this._radioVolume, 'input', () => {
    const value = Number(this._radioVolume.value);
    if (this._radioVolumeValue)
      this._radioVolumeValue.textContent = `${value}%`;
    this.actions.setParams({ volume: value / 100 }, { origin: 'user' });
  });
  this.listen(this._contextRadioMiniPrevBtn, 'click', () => cycleRadio(-1));
  this.listen(this._contextRadioMiniNextBtn, 'click', () => cycleRadio(1));
  this.listen(
    this._contextRadioMiniPlayBtn,
    'click',
    () => void this.radio.togglePlayback({ origin: 'user' }),
  );
  // Cockpit owns the Cesium camera even though it intentionally clears
  // viewer.trackedEntity. Station changes must never start the map-view
  // rotation/fallback flights that would compete with its preUpdate pose.
  this.listen(this._cockpitRadioPrevBtn, 'click', () =>
    cycleRadio(-1, { rotate: false }),
  );
  this.listen(this._cockpitRadioNextBtn, 'click', () =>
    cycleRadio(1, { rotate: false }),
  );
  this.listen(
    this._cockpitRadioPlayBtn,
    'click',
    () => void this.radio.togglePlayback({ origin: 'user' }),
  );
  this.listen(this._contextRadioMiniVolume, 'input', () => {
    const value = Number(this._contextRadioMiniVolume.value);
    if (this._contextRadioMiniVolumeValue)
      this._contextRadioMiniVolumeValue.textContent = `${value}%`;
    this.actions.setParams({ volume: value / 100 }, { origin: 'user' });
  });
  this.listen(this._cockpitRadioVolume, 'input', () => {
    const value = Number(this._cockpitRadioVolume.value);
    if (this._cockpitRadioVolumeValue)
      this._cockpitRadioVolumeValue.textContent = `${value}%`;
    this.actions.setParams({ volume: value / 100 }, { origin: 'user' });
  });
  const updateTunerFromPointer = (event) => {
    const rect = this._radioTunerSlider?.getBoundingClientRect();
    if (!rect || !this._radioTunerStations.length) return false;
    const position = radioTunerPointerPosition(
      event.clientX,
      rect.left,
      rect.width,
      this._radioTunerStations.length,
    );
    if (position.stationIndex > this._radioTunerLastSlot)
      this._radioTunerDragDirection = 1;
    else if (position.stationIndex < this._radioTunerLastSlot)
      this._radioTunerDragDirection = -1;
    this._radioTunerLastSlot = position.stationIndex;
    this._radioTunerCoordinate = position.coordinate;
    this._radioTunerSlider.value = String(position.stationIndex);
    tunerPreview({ coordinate: position.coordinate });
    return true;
  };
  this.listen(
    this._radioTunerSlider,
    'pointerdown',
    (event) => {
      if (!beginTuner()) return;
      this._radioTunerPointerId = event.pointerId;
      this._radioTunerSlider.focus({ preventScroll: true });
      try {
        this._radioTunerSlider.setPointerCapture(event.pointerId);
      } catch {
        /* capture is best effort */
      }
      updateTunerFromPointer(event);
      event.preventDefault();
    },
    tunerListenerOptions,
  );
  this.listen(
    this._radioTunerSlider,
    'pointermove',
    (event) => {
      if (
        !this._radioTunerDragging ||
        this._radioTunerPointerId !== event.pointerId
      )
        return;
      updateTunerFromPointer(event);
      event.preventDefault();
    },
    tunerListenerOptions,
  );
  this.listen(
    this._radioTunerSlider,
    'input',
    () => {
      if (this._radioTunerPointerId !== null || this._radioTunerKeyboardKey)
        return;
      if (!this._radioTunerDragging && !beginTuner()) return;
      const inputSlot = radioTunerSlot(
        this._radioTunerSlider.value,
        this._radioTunerStations.length,
      );
      if (inputSlot.slot > this._radioTunerLastSlot)
        this._radioTunerDragDirection = 1;
      else if (inputSlot.slot < this._radioTunerLastSlot)
        this._radioTunerDragDirection = -1;
      this._radioTunerLastSlot = inputSlot.slot;
      this._radioTunerCoordinate = inputSlot.stationIndex;
      tunerPreview({ coordinate: this._radioTunerCoordinate });
    },
    tunerListenerOptions,
  );
  this.listen(
    this._radioTunerSlider,
    'change',
    () => {
      if (this._radioTunerPointerId === null && !this._radioTunerKeyboardKey)
        finishTuner(true);
    },
    tunerListenerOptions,
  );
  this.listen(
    this._radioTunerSlider,
    'pointerup',
    (event) => {
      if (this._radioTunerPointerId !== event.pointerId) return;
      updateTunerFromPointer(event);
      finishTuner(true);
      try {
        this._radioTunerSlider.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      event.preventDefault();
    },
    tunerListenerOptions,
  );
  this.listen(
    this._radioTunerSlider,
    'pointercancel',
    (event) => {
      if (
        this._radioTunerPointerId !== null &&
        this._radioTunerPointerId !== event.pointerId
      )
        return;
      try {
        this._radioTunerSlider.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      finishTuner(false);
    },
    tunerListenerOptions,
  );
  this.listen(
    this._radioTunerSlider,
    'lostpointercapture',
    (event) => {
      if (
        this._radioTunerDragging &&
        this._radioTunerPointerId === event.pointerId
      )
        finishTuner(false);
    },
    tunerListenerOptions,
  );
  this.listen(
    this._radioTunerSlider,
    'keydown',
    (event) => {
      if (event.key === 'Escape' && this._radioTunerDragging) {
        event.preventDefault();
        finishTuner(false);
        return;
      }
      if (
        ![
          'ArrowLeft',
          'ArrowRight',
          'Home',
          'End',
          'PageUp',
          'PageDown',
        ].includes(event.key)
      )
        return;
      if (!this._radioTunerDragging && !beginTuner()) return;
      event.preventDefault();
      this._radioTunerKeyboardKey = event.key;
      const max = Math.max(0, this._radioTunerStations.length - 1);
      const current = radioTunerSlot(
        this._radioTunerSlider.value,
        this._radioTunerStations.length,
      ).slot;
      const page = Math.max(1, Math.round(max / 10));
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? max
            : event.key === 'PageUp'
              ? current + page
              : event.key === 'PageDown'
                ? current - page
                : current + (event.key === 'ArrowRight' ? 1 : -1);
      const slot = radioTunerSlot(next, this._radioTunerStations.length);
      if (slot.slot > this._radioTunerLastSlot)
        this._radioTunerDragDirection = 1;
      else if (slot.slot < this._radioTunerLastSlot)
        this._radioTunerDragDirection = -1;
      this._radioTunerLastSlot = slot.slot;
      this._radioTunerCoordinate = slot.stationIndex;
      this._radioTunerSlider.value = String(slot.slot);
      tunerPreview({ coordinate: this._radioTunerCoordinate });
    },
    tunerListenerOptions,
  );
  this.listen(
    this._radioTunerSlider,
    'keyup',
    (event) => {
      if (
        !this._radioTunerKeyboardKey ||
        event.key !== this._radioTunerKeyboardKey
      )
        return;
      event.preventDefault();
      finishTuner(true);
    },
    tunerListenerOptions,
  );
  this.listen(
    this._radioTunerSlider,
    'blur',
    () => finishTuner(true),
    tunerListenerOptions,
  );
  const releaseNavigationBand = () => {
    this._radioTunerBandPinnedForNavigation = false;
  };
  this.listen(
    this.canvas,
    'pointerdown',
    releaseNavigationBand,
    tunerListenerOptions,
  );
  this.listen(
    this.canvas,
    'wheel',
    releaseNavigationBand,
    tunerListenerOptions,
  );
  // The directory order is catalog/filter authority, not camera authority.
  // Globe motion therefore never rebuilds or re-ranks the frequency band.
  this._radioSelectedHandler = () =>
    this.actions.setPanelCollapsed('radio-panel', false);
  this.listen(document, 'gev:radio-selected', this._radioSelectedHandler);
}
