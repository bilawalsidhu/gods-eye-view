import { t, msg } from '../i18n/index.js';
import {
  showRadioEnableBusy,
  showRadioTuner,
  showRadioVolume,
} from './radioPresentation.js';
import {
  radioTunerSlot,
  radioTunerCommitSlot,
  radioTunerPointerPosition,
} from './radioTunerModel.js';

/** Bind Radio input using a RadioControls receiver and supplied actions. */
export function bindRadioControls() {
  if (!this._radioPanel) return;
  const tunerListenerOptions = {};
  const setCockpitDisclosure = (
    kind,
    expanded,
    { returnFocus = false } = {},
  ) => {
    if (this.destroyed) return;
    const displayOpen = kind === 'display' && Boolean(expanded);
    const radioOpen = kind === 'radio' && Boolean(expanded);
    if (displayOpen || radioOpen) this.actions.setSignalCollapsed(true);
    this._cockpitDisclosure = { display: displayOpen, radio: radioOpen };
    this.store?.publishUtility({ ...this._cockpitDisclosure });
    if (displayOpen) this.actions.revealStyleParameters();
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
  /** @param {'display'|'radio'} kind @returns {boolean} Whether it is open. */
  this._cockpitDisclosureOpen = (kind) =>
    Boolean(this._cockpitDisclosure?.[kind]);
  const tunerPreview = ({
    coordinate = this._radioTunerCoordinate,
    syncStatic = true,
    rotate = true,
  } = {}) => {
    const slot = radioTunerSlot(
      this._radioTunerView.slot,
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
    showRadioTuner.call(this, {
      ratio,
      static: syncStatic ? false : Boolean(this._radioState?.tuningStatic),
      coordinate: resolvedCoordinate,
      count: this._radioTunerStations.length,
      value: station
        ? t('CH {index} / {total}', {
            index: String(slot.stationIndex + 1).padStart(2, '0'),
            total: String(this._radioTunerStations.length).padStart(2, '0'),
          })
        : t('NO STATIONS'),
      station: station?.name || t('NO STATION AVAILABLE'),
      valuetext: station
        ? t('{name}, station {index} of {total}', {
            name: station.name,
            index: slot.stationIndex + 1,
            total: this._radioTunerStations.length,
          })
        : t('No station available'),
    });
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
    showRadioTuner.call(this, {
      max: Math.max(0, this._radioTunerStations.length - 1),
    });
  };
  const refreshTunerBand = ({ force = false } = {}) => {
    if (this._radioTunerDragging || !this._radioTunerView.available)
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
    showRadioTuner.call(this, { slot: slot.slot });
    this._radioTunerCoordinate = slot.stationIndex >= 0 ? slot.stationIndex : 0;
    tunerPreview({ coordinate: this._radioTunerCoordinate, syncStatic: false });
    return true;
  };
  this._refreshRadioTunerBand = refreshTunerBand;
  this._refreshRadioTunerText = () =>
    tunerPreview({ coordinate: this._radioTunerCoordinate, syncStatic: false });
  const beginTuner = () => {
    if (this._radioTunerDragging || !this._radioTunerView.available)
      return false;
    refreshTunerBand();
    if (!this._radioTunerStations.length || !this.radio.beginTuning())
      return false;
    // A tuner-owned camera preview must never replace the frozen directory.
    // Only an explicit globe pointer/wheel gesture releases camera pinning.
    this._radioTunerBandPinnedForNavigation = true;
    this._radioTunerDragging = true;
    showRadioTuner.call(this, { dragging: true });
    const selectedIndex = this._radioTunerStations.findIndex(
      (station) => station.id === this._radioState?.selected?.id,
    );
    const slot = radioTunerSlot(
      selectedIndex >= 0 ? selectedIndex : 0,
      this._radioTunerStations.length,
    );
    showRadioTuner.call(this, { slot: slot.slot });
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
      const startSlot = radioTunerSlot(
        dragSnapshot.slot,
        this._radioTunerStations.length,
      );
      showRadioTuner.call(this, { max: startSlot.max, slot: startSlot.slot });
      this._radioTunerCoordinate = Number.isFinite(dragSnapshot.coordinate)
        ? dragSnapshot.coordinate
        : dragSnapshot.slot;
    } else if (!commit) {
      showRadioTuner.call(this, { slot: this._radioTunerDragStartSlot });
      this._radioTunerCoordinate = this._radioTunerDragStartSlot;
    }
    let station = tunerPreview({
      coordinate: this._radioTunerCoordinate,
      rotate: commit,
    });
    if (commit && !station) {
      const snapped = radioTunerCommitSlot(
        this._radioTunerView.slot,
        this._radioTunerStations.length,
      );
      showRadioTuner.call(this, { slot: snapped.slot });
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
    // The tuner lays out the snapped position while transitions are still
    // disabled before it drops the drag class, so the needle cannot
    // interpolate from the released gap.
    showRadioTuner.call(this, { dragging: false });
    if (result && !result.ok) {
      this._radioTunerBandPinnedForNavigation = false;
      if (result.reason === 'station-unavailable') {
        showRadioTuner.call(this, {
          value: t('OFF AIR'),
          station: t('STATION UNAVAILABLE'),
          valuetext: t('Station unavailable after directory refresh'),
        });
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
  // Both Enable buttons render from the Radio store; before its first render
  // there is nothing shown to mark, so the button is marked directly.
  const setTriggerBusy = (trigger, busy) => {
    const where =
      trigger === this._radioEnableBtn
        ? 'panel'
        : trigger === this._cockpitRadioEnableBtn
          ? 'cockpit'
          : null;
    if (where && showRadioEnableBusy.call(this, busy, where)) return;
    trigger.setAttribute('aria-disabled', String(busy));
    trigger.setAttribute('aria-busy', String(busy));
  };
  // The store patches aria-busy on the next render, so a second press before
  // it lands is turned away by this set.
  const busyTriggers = new Set();
  const toggleRadio = async (trigger) => {
    if (!this.actions.isRegistered()) return;
    if (busyTriggers.has(trigger)) return;
    if (trigger.getAttribute('aria-busy') === 'true') return;
    const enabling = !this.actions.isEnabled();
    const revealAfterEnable = enabling && trigger === this._radioEnableBtn;
    busyTriggers.add(trigger);
    setTriggerBusy(trigger, true);
    try {
      const toggled = await this.actions.runUserAction(
        (notificationToken) =>
          this.actions.setEnabled(enabling, {
            origin: 'user',
            notificationToken,
          }),
        // contextSessionOrdering.test.mjs pins this English argument; the
        // toast shows localizedMessage.
        `Radio could not ${enabling ? 'start' : 'stop'} cleanly`,
        {
          localizedMessage: t('Radio could not {action} cleanly', {
            action: enabling ? t('start') : t('stop'),
          }),
        },
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
      busyTriggers.delete(trigger);
      if (!this.destroyed) {
        setTriggerBusy(trigger, false);
        if (revealAfterEnable && trigger.isConnected)
          trigger.focus({ preventScroll: true });
      }
    }
  };
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
      if (event.key !== 'Escape') return;
      const displayOpen = this._cockpitDisclosureOpen('display');
      const radioOpen = this._cockpitDisclosureOpen('radio');
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
      // Contact takes the room the open left panel had.
      this.actions.setPanelCollapsed('data-panel', true);
      this.actions.setPanelCollapsed('utilities-panel', true);
    },
    tunerListenerOptions,
  );
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
    showRadioTuner.call(this, { slot: position.stationIndex });
    tunerPreview({ coordinate: position.coordinate });
    return true;
  };
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
  // The Radio panel's and Cockpit's controls, and the tuner slider's events,
  // call these through the store.
  // Cockpit owns the Cesium camera even though it intentionally clears
  // viewer.trackedEntity, so its station steps pass `rotate: false`: they
  // must never start the map-view rotation/fallback flights that would
  // compete with its preUpdate pose.
  this._storeToken = this.store?.connect?.({
    /** @param {'panel'|'cockpit'} where Which Enable button was pressed. */
    toggleRadio: (where) =>
      void toggleRadio(
        where === 'cockpit'
          ? this._cockpitRadioEnableBtn
          : this._radioEnableBtn,
      ),
    toggleCockpitRadio: () =>
      setCockpitDisclosure('radio', !this._cockpitDisclosureOpen('radio')),
    /**
     * @param {string} filter
     * @returns {string} The station tag the filter shows afterwards.
     */
    setRadioFilter: (filter) => {
      if (!this.radio.getUIState().presentationActive)
        return this.radio.getUIState().filter;
      if (this._radioTunerDragging) finishTuner(false);
      if (!this.actions.setParams({ filter }, { origin: 'user' }))
        return this.radio.getUIState().filter;
      this._radioTunerBandPinnedForNavigation = false;
      this._radioTunerPool = [];
      refreshTunerBand({ force: true });
      return filter;
    },
    cycleRadio,
    toggleRadioPlayback: () =>
      void this.radio.togglePlayback({ origin: 'user' }),
    stopRadio: () => this.radio.stopPlayback({ origin: 'user' }),
    setRadioVolume: (percent) => {
      const value = Number(percent);
      showRadioVolume.call(this, value);
      this.actions.setParams({ volume: value / 100 }, { origin: 'user' });
    },
    tunerPointerDown: (event) => {
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
    tunerPointerMove: (event) => {
      if (
        !this._radioTunerDragging ||
        this._radioTunerPointerId !== event.pointerId
      )
        return;
      updateTunerFromPointer(event);
      event.preventDefault();
    },
    tunerInput: () => {
      if (this._radioTunerPointerId !== null || this._radioTunerKeyboardKey)
        return;
      // A drag the input starts begins from the selected station's slot.
      if (this._radioTunerDragging)
        showRadioTuner.call(this, {
          slot: Number(this._radioTunerSlider.value),
        });
      else if (!beginTuner()) return;
      const inputSlot = radioTunerSlot(
        this._radioTunerView.slot,
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
    tunerChange: () => {
      if (this._radioTunerPointerId === null && !this._radioTunerKeyboardKey)
        finishTuner(true);
    },
    tunerPointerUp: (event) => {
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
    tunerPointerCancel: (event) => {
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
    tunerLostPointerCapture: (event) => {
      if (
        this._radioTunerDragging &&
        this._radioTunerPointerId === event.pointerId
      )
        finishTuner(false);
    },
    tunerKeyDown: (event) => {
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
        this._radioTunerView.slot,
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
      showRadioTuner.call(this, { slot: slot.slot });
      tunerPreview({ coordinate: this._radioTunerCoordinate });
    },
    tunerKeyUp: (event) => {
      if (
        !this._radioTunerKeyboardKey ||
        event.key !== this._radioTunerKeyboardKey
      )
        return;
      event.preventDefault();
      finishTuner(true);
    },
    tunerBlur: () => finishTuner(true),
  });
}
