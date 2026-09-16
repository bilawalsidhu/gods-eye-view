import { CockpitViewController, CockpitDisplayPortal } from './cockpit.js';
import { STYLE_STATUS_LABELS } from './visualPresets.js';
import { cockpitEntryAllowed } from '../contextModePolicy.js';
import { formatAwarenessLabel } from '../data/militaryAwarenessEngine.js';
import { enterCockpitWithTracking } from '../cockpitTracking.js';

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
        enterPanels,
        exitPanels,
      },
      elements,
      operations,
    );
    const {
      flightsLayer,
      militaryFlightsLayer,
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
    } = services;
    this._cockpitDisplayPortal = null;
    this.cockpitView = new CockpitViewController(viewer, {
      services: {
        flightsLayer,
        militaryFlightsLayer,
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
      },
      onVisionChange: (mode, active, options) =>
        this._setCockpitVision(mode, active, options),
      onCameraTakeover: () =>
        this._stampNavigation({ cancelPendingSelection: false }),
      getInheritedVisionLabel: () =>
        STYLE_STATUS_LABELS[this.activeStyle] ||
        String(this.activeStyle || 'normal').toUpperCase(),
      isEntryAllowed: () =>
        cockpitEntryAllowed({
          contextMode: this._contextMode,
          contextModeChanging: this._contextModeChanging,
          flightsEnabled: !!this._dataManager?.isEnabled('flights'),
          militaryEnabled: !!this._dataManager?.isEnabled('military'),
        }),
      onEntered: () => this.enterPanels(),
      onExited: () => this.exitPanels(),
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
  getCockpitState() {
    const { militaryAwarenessLayer } = this.services;
    const snapshot = militaryAwarenessLayer.getContextSnapshot?.();
    const info = this.cockpitView?.readAircraftInfo?.();
    const active = Boolean(this.cockpitView?.active);
    const gateOpen = Boolean(this.cockpitView?.isEntryAllowed?.());
    // "Could Cockpit be ENTERED right now" — so it is false while already
    // inside, unconditionally. Cockpit takes the entity off
    // `viewer.trackedEntity` on entry and NEXT puts one back, which made this
    // flip true/false between calls while `active` stayed true; readers
    // (including the voice model) read that as a broken half-entered state.
    const entryAllowed =
      !active &&
      Boolean(gateOpen && info && this.viewer?.trackedEntity?.position);
    return {
      active,
      entryAllowed,
      // Why entry is unavailable, so a refusal can be explained rather than
      // guessed at.
      entryBlockedReason:
        entryAllowed || active
          ? null
          : !gateOpen
            ? this._contextModeChanging
              ? 'contacts-starting'
              : 'contacts-inactive'
            : 'no-tracked-aircraft',
      visionMode: this.cockpitView?.visionMode || null,
      subject: info
        ? {
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
      // Entry is gated exactly as the manual entry chip is. Attempting it while
      // the gate is shut produced the half-entered look the operator reported
      // (a plane anchored under the camera with no cockpit around it), so
      // refuse with the reason instead of trying.
      if (!this.cockpitView.isEntryAllowed?.()) {
        return {
          ok: false,
          action: 'control_cockpit',
          error: this._contextModeChanging
            ? 'Contacts is still starting up — try Cockpit again in a moment'
            : 'Contacts must be active to enter Cockpit — say "open contacts" first',
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
