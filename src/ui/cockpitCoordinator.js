import { nextTick } from 'vue';
import { CockpitViewController, CockpitDisplayPortal } from './cockpit.js';
import {
  COCKPIT_AIRCRAFT_LAYER_IDS,
  bridgeEntryAllowed,
  cockpitEntryAllowed,
  orbitEntryAllowed,
} from '../contextModePolicy.js';
import { formatAwarenessLabel } from '../data/militaryAwarenessEngine.js';
import { enterCockpitWithTracking } from '../cockpitTracking.js';
import { cockpitVisionModeForStyle } from '../cockpitVisionPolicy.js';

/** Own Cockpit entry/rollback, readouts and the single Display portal. */
export class CockpitCoordinator {
  constructor({
    viewer,
    services,
    elements,
    operations,
    readDataManager,
    readContext,
    readActiveStyle,
    readUtilityDisclosureOpen,
    enterPanels,
    exitPanels,
  }) {
    Object.assign(
      this,
      {
        viewer,
        services,
        readDataManager,
        readContext,
        readActiveStyle,
        readUtilityDisclosureOpen,
        enterPanels,
        exitPanels,
      },
      elements,
      operations,
    );
    const {
      flightsLayer,
      militaryFlightsLayer,
      aisLiveVesselsLayer,
      satellitesLayer,
      militaryInstallationsLayer,
      isTr3b,
      toggleTr3b,
      militaryAwarenessLayer,
      cachedGroundFloor,
      cachedMeshFloor,
      GROUND_FLOOR_LIFT_M,
      meshFloorPreferred,
      warmGroundFloor,
      sampleMeshFloorCells,
      holdContinuousRender,
      releaseContinuousRender,
      fetchRegionalBrief,
      regionalDistanceM,
      weatherCodeLabel,
      acquireOrbitImagery,
    } = services;
    this._cockpitDisplayPortal = null;
    this.cockpitView = new CockpitViewController(viewer, {
      services: {
        flightsLayer,
        militaryFlightsLayer,
        aisLiveVesselsLayer,
        satellitesLayer,
        militaryInstallationsLayer,
        isTr3b,
        toggleTr3b,
        militaryAwarenessLayer,
        formatAwarenessLabel,
        cachedGroundFloor,
        cachedMeshFloor,
        GROUND_FLOOR_LIFT_M,
        meshFloorPreferred,
        warmGroundFloor,
        sampleMeshFloorCells,
        holdContinuousRender,
        releaseContinuousRender,
        fetchRegionalBrief,
        regionalDistanceM,
        weatherCodeLabel,
        acquireOrbitImagery,
        // The Contact card and Live Signals say which feeds are off.
        isLayerEnabled: (layerId) => this._isLayerEnabled(layerId),
      },
      onVisionChange: (mode, active, options) =>
        this._setCockpitVision(mode, active, options),
      getInitialVisionMode: () => cockpitVisionModeForStyle(this.activeStyle),
      onCameraTakeover: () =>
        this._stampNavigation({ cancelPendingSelection: false }),
      // Only the tracked aircraft's own layer gates entry (see the policy).
      isEntryAllowed: () => {
        const subjectLayerId =
          this.cockpitView?.readAircraftInfo?.()?.layerId ?? null;
        return cockpitEntryAllowed({
          subjectLayerId,
          subjectLayerEnabled: this._isLayerEnabled(subjectLayerId),
          contextModeChanging: this._contextModeChanging,
        });
      },
      isBridgeEntryAllowed: () =>
        bridgeEntryAllowed({
          vesselsEnabled: !!this._dataManager?.isEnabled('ais-live-vessels'),
          contextModeChanging: this._contextModeChanging,
        }),
      isOrbitEntryAllowed: () =>
        orbitEntryAllowed({
          satellitesEnabled: !!this._dataManager?.isEnabled('satellites'),
          contextModeChanging: this._contextModeChanging,
          // The layer says whether its class may be ridden.
          subjectEnterable:
            satellitesLayer?.getCockpitSubject?.()?.enterable !== false,
        }),
      publish: this.publishCockpit,
      isUtilityDisclosureOpen: () => !!this.readUtilityDisclosureOpen?.(),
      onEntered: () => this.enterPanels(),
      onExited: () => this.exitPanels(),
      onRide: (layerId) => this._adoptRiddenLayer(layerId),
      restoreTrackingFrame: (entity) => {
        const [layerId, ...idParts] = String(entity?.gevTrackedId || '').split(
          ':',
        );
        const trackedId = idParts.join(':');
        if (!trackedId) return false;
        if (layerId === 'flights')
          return flightsLayer.refocusTrackedById?.(trackedId) === true;
        if (layerId === 'military')
          return militaryFlightsLayer.refocusTrackedById?.(trackedId) === true;
        return false;
      },
    });
  }
  get _dataManager() {
    return this.readDataManager();
  }
  get _contextMode() {
    return this.readContext()?.mode ?? null;
  }
  get _contextModeChanging() {
    return !!this.readContext()?.changing;
  }
  get activeStyle() {
    return this.readActiveStyle();
  }
  /** Whether a data layer is enabled; false for no layer. */
  _isLayerEnabled(layerId) {
    return Boolean(layerId) && !!this._dataManager?.isEnabled(layerId);
  }
  /**
   * Make the ridden layer the user's own while Contacts is on. Contacts may
   * have turned that layer on (an aircraft layer, or Live AIS Vessels), and
   * it releases the layers it owns when it goes off; the Cockpit must outlive
   * Contacts, so riding an aircraft or a vessel adopts its layer as a direct
   * selection does. Contacts then stops owning it and the Context restore
   * keeps it (session `userAdded`).
   * @param {string|null} layerId The ridden aircraft's layer, or
   *   'ais-live-vessels' on a bridge.
   */
  _adoptRiddenLayer(layerId) {
    if (
      !COCKPIT_AIRCRAFT_LAYER_IDS.includes(layerId) &&
      layerId !== 'ais-live-vessels'
    )
      return;
    if (!this._isLayerEnabled('military-awareness')) return;
    this._dataManager?.adoptLayerVisibility?.(layerId, true, {
      origin: 'user',
      adoptedFromSelection: true,
    });
  }
  /** Whether either aircraft layer is on, so there is an aircraft to ride. */
  get _aircraftLayerEnabled() {
    return COCKPIT_AIRCRAFT_LAYER_IDS.some((layerId) =>
      this._isLayerEnabled(layerId),
    );
  }
  /**
   * Why voice entry must refuse before it touches tracking, or null. The
   * tracked aircraft's own layer is checked again by the entry itself.
   * @returns {string|null}
   */
  _cockpitEntryRefusal() {
    if (this._contextModeChanging)
      return 'Context is still changing — try Cockpit again in a moment';
    // Tracking an aircraft from the bridge ends the bridge and clears the
    // vessel selection before the entry can run, leaving neither.
    if (this.cockpitView?.active && this.cockpitView.subjectKind === 'vessel')
      return 'Cockpit is on a vessel bridge — exit the bridge first, then track an aircraft to enter Cockpit';
    // Likewise in orbit: the aircraft's tracking takes the satellite's.
    if (
      this.cockpitView?.active &&
      this.cockpitView.subjectKind === 'satellite'
    )
      return 'Cockpit is in an orbital view — exit it first, then track an aircraft to enter Cockpit';
    if (!this._aircraftLayerEnabled)
      return 'No aircraft layer is on — turn on Flights or Military Flights and track an aircraft to enter Cockpit';
    return null;
  }
  getCockpitState() {
    const { militaryAwarenessLayer } = this.services;
    const snapshot = militaryAwarenessLayer.getContextSnapshot?.();
    const info = this.cockpitView?.readAircraftInfo?.();
    const active = Boolean(this.cockpitView?.active);
    // Voice enters aircraft only; a bridge in use is still reported as it is.
    const vessel =
      active && this.cockpitView?.subjectKind === 'vessel'
        ? this.cockpitView.readVesselInfo?.()
        : null;
    // Likewise an orbital view in use: its satellite, never an aircraft.
    const satellite =
      active && this.cockpitView?.subjectKind === 'satellite'
        ? this.cockpitView.readSatelliteInfo?.()
        : null;
    const gateOpen = Boolean(this.cockpitView?.isEntryAllowed?.());
    // "Could Cockpit be ENTERED right now" — so it is false while already
    // inside, unconditionally. Cockpit takes the entity off
    // `viewer.trackedEntity` on entry and NEXT puts one back, which made this
    // flip true/false between calls while `active` stayed true; readers
    // (including the voice model) read that as a broken half-entered state.
    const entryAllowed =
      !active &&
      Boolean(gateOpen && info && this.viewer?.trackedEntity?.position);
    // Entry needs only the ridden aircraft's own layer: with one tracked,
    // that layer; with none, any aircraft layer to track one from.
    const subjectLayerOff = info
      ? !this._isLayerEnabled(info.layerId)
      : !this._aircraftLayerEnabled;
    return {
      active,
      entryAllowed,
      // Why entry is unavailable, so a refusal can be explained rather than
      // guessed at. Contacts is not required, so it is never the reason.
      entryBlockedReason:
        entryAllowed || active
          ? null
          : this._contextModeChanging
            ? 'contacts-starting'
            : subjectLayerOff
              ? 'subject-layer-off'
              : 'no-tracked-aircraft',
      visionMode: this.cockpitView?.visionMode || null,
      subject: satellite
        ? {
            kind: 'satellite',
            id: satellite.id,
            layerId: satellite.layerId,
            callsign: null,
            name: satellite.name,
          }
        : vessel
          ? {
              kind: 'vessel',
              id: vessel.id,
              layerId: vessel.layerId,
              callsign: null,
              name: vessel.name,
            }
          : info
            ? {
                kind: 'aircraft',
                id: info.icao24 || info.id || null,
                layerId: info.layerId || null,
                callsign: info.callsign || null,
              }
            : null,
      navigation: snapshot
        ? {
            canPrevious: Boolean(snapshot.navigation?.canPrevious),
            canNext: Boolean(snapshot.navigation?.canNext),
            canFocus: Boolean(snapshot.navigation?.canFocus),
          }
        : null,
      awareness: snapshot
        ? {
            radiusM: Number.isFinite(snapshot.radiusM)
              ? snapshot.radiusM
              : null,
            subject: snapshot.subject
              ? {
                  id: snapshot.subject.id || null,
                  layerId: snapshot.subject.layerId || null,
                }
              : null,
            cohorts: Array.isArray(snapshot.cohorts)
              ? snapshot.cohorts.map((cohort) => ({
                  id: cohort?.id || null,
                  source: cohort?.source || null,
                  count: Number.isFinite(cohort?.count) ? cohort.count : null,
                  relationship: cohort?.relationship || null,
                  reason: cohort?.reason || null,
                  coverage: cohort?.coverage || null,
                }))
              : [],
            navigation: snapshot.navigation
              ? {
                  canPrevious: Boolean(snapshot.navigation.canPrevious),
                  canNext: Boolean(snapshot.navigation.canNext),
                  canFocus: Boolean(snapshot.navigation.canFocus),
                }
              : null,
          }
        : null,
      activeTracked: this.cockpitView?.active
        ? Boolean(this.cockpitView?.trackedEntity)
        : false,
      activeMapView: !this.cockpitView?.active && entryAllowed,
    };
  }

  _retargetCockpitEntryLayer({
    targetLayer,
    aircraftClass,
    currentTarget,
    selectedTarget,
  }) {
    const { militaryAwarenessLayer } = this.services;
    if (!['flights', 'military'].includes(targetLayer)) {
      return {
        ok: false,
        error: `Cockpit flies aircraft only — ${targetLayer} contacts cannot be entered`,
      };
    }
    const activeLayer =
      selectedTarget?.layerId || currentTarget?.layerId || null;
    const alreadyOnLayer = activeLayer === targetLayer;
    if (alreadyOnLayer && !aircraftClass)
      return { ok: true, retargeted: false };
    const moved = militaryAwarenessLayer?.navigateNext
      ? !!militaryAwarenessLayer.navigateNext({
          targetLayer,
          aircraftClass,
          origin: 'voice',
        })
      : false;
    if (moved) return { ok: true, retargeted: true };
    // A filter that matched nothing still enters, as long as the layer is
    // already right — the operator asked for that layer and is on it.
    if (alreadyOnLayer) return { ok: true, retargeted: false };
    const label = targetLayer === 'military' ? 'military' : 'civilian';
    const filtered = aircraftClass ? `${aircraftClass} ` : '';
    return {
      ok: false,
      error: `No ${filtered}${label} contact is available to enter — track one first, or say "next ${label}"`,
    };
  }

  controlCockpit(
    action,
    {
      notificationToken = null,
      targetLayer = null,
      aircraftClass = null,
      selectedTarget = null,
      rollbackTarget = undefined,
    } = {},
  ) {
    const { flightsLayer, militaryFlightsLayer } = this.services;
    const normalized = String(action || '').toLowerCase();
    if (!this.cockpitView) {
      return {
        ok: false,
        action: 'control_cockpit',
        error: 'Cockpit controller unavailable',
        state: this.getCockpitState(),
      };
    }
    if (normalized === 'status') {
      return {
        ok: true,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        notificationToken: notificationToken || null,
      };
    }
    if (normalized === 'enter') {
      // Attempting entry while the gate is shut produced the half-entered look
      // the operator reported (a plane anchored under the camera with no
      // cockpit around it), so refuse with the reason instead of trying. The
      // aircraft may not be tracked yet (a selection or a requested layer is
      // adopted below), so this checks what can be known now; the entry
      // itself then applies the manual chip's gate to the aircraft it rides.
      const refusal = this._cockpitEntryRefusal();
      if (refusal) {
        return {
          ok: false,
          action: 'control_cockpit',
          error: refusal,
          state: this.getCockpitState(),
        };
      }
      let currentTarget = this.getAircraftTrackingTarget();
      const layerForTarget = (target) =>
        target?.layerId === 'military'
          ? militaryFlightsLayer
          : target?.layerId === 'flights'
            ? flightsLayer
            : null;
      // A requested layer retargets BEFORE entry, through the same filtered
      // navigation NEXT uses. Ignoring it entered on whatever was already
      // tracked and reported success, so "cockpit in that military helicopter"
      // silently put the operator in an airliner.
      if (targetLayer) {
        const requested = this._retargetCockpitEntryLayer({
          targetLayer,
          aircraftClass,
          currentTarget,
          selectedTarget,
        });
        if (!requested.ok) {
          return {
            ok: false,
            action: 'control_cockpit',
            error: requested.error,
            state: this.getCockpitState(),
          };
        }
        if (requested.retargeted) {
          // The retarget is now the authority; a selection sampled before it
          // would drag entry back to the wrong layer.
          selectedTarget = null;
          rollbackTarget =
            rollbackTarget === undefined ? currentTarget : rollbackTarget;
          currentTarget = this.getAircraftTrackingTarget();
        }
      }
      const selectedLayer =
        selectedTarget?.layerId === 'military'
          ? militaryFlightsLayer
          : selectedTarget?.layerId === 'flights'
            ? flightsLayer
            : null;
      const entry = enterCockpitWithTracking({
        cockpitView: this.cockpitView,
        selectedLayer,
        selectedTarget,
        currentLayer: layerForTarget(currentTarget),
        rollbackLayer: layerForTarget(
          rollbackTarget === undefined ? currentTarget : rollbackTarget,
        ),
        rollbackTarget,
        selectionOrigin: 'voice',
      });
      return {
        ok: entry.entered,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        error: entry.error,
      };
    }
    if (normalized === 'exit') {
      const exited = !!this.cockpitView.exit();
      return {
        ok: exited,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        error: exited ? null : 'Cockpit was already inactive',
      };
    }
    if (normalized === 'next' || normalized === 'previous') {
      const changed = this.cockpitView.navigateContext(
        normalized === 'next' ? 1 : -1,
        {
          targetLayer,
          aircraftClass,
          origin: 'voice',
        },
      );
      return {
        ok: changed,
        action: 'control_cockpit',
        state: this.getCockpitState(),
        error: changed ? null : 'No further context target was available',
      };
    }
    return {
      ok: false,
      action: 'control_cockpit',
      error: `Unknown cockpit action: ${action}`,
      state: this.getCockpitState(),
    };
  }

  _initCockpitDisplayPortal() {
    this._cockpitDisplayPortal?.destroy();
    this._cockpitDisplayPortal = new CockpitDisplayPortal({
      standardPanel: this._ppToggles,
      cockpitPanel: this._cockpitDisplayPanel,
      groups: [
        ['hud', this._hudBtn?.closest('.pp-toggle-group')],
        ['detection', this._detectionBtn?.closest('.pp-toggle-group')],
        ['parameters', this._sliderPanel],
        ['models3d', this._models3dBtn?.closest('.pp-toggle-group')],
      ],
      layout: () => {
        this._layoutRightPanels();
        this.cockpitView?.scheduleContextLayout();
      },
      publish: (slots) => this.publishCockpitPortal?.(slots),
      afterRender: (callback) => {
        void nextTick(callback);
      },
    });
  }

  _setCockpitDisplayPortalActive(active) {
    this._cockpitDisplayPortal?.setActive(active);
  }

  get _cockpitDisplayPortalActive() {
    return this._cockpitDisplayPortal?.active ?? false;
  }

  get _displayPortalScrollRestoreOwner() {
    return this._cockpitDisplayPortal?.restoreOwner ?? null;
  }

  get _standardDisplayScrollTop() {
    return this._cockpitDisplayPortal?.standardScrollTop ?? 0;
  }
  stop() {
    this.cockpitView?.stop();
    this._cockpitDisplayPortal?.stop();
  }
  destroy() {
    this.cockpitView?.dispose();
    this._cockpitDisplayPortal?.destroy();
    this._cockpitDisplayPortal = null;
  }
}
