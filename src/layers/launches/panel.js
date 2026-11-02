import * as Cesium from 'cesium';
import { formatNumber, isolate, onLocaleChange, t } from '../../i18n/index.js';
import {
  MISSION_CLOSE_VIEW_RANGE_M,
  MISSION_GLOBE_VIEW_RANGE_M,
} from './policy.js';
import { UNKNOWN_LAUNCH_STATUS } from './model.js';

// Landing endpoints carry an English accuracy code (the panel and the map
// entity compare it); only the text shown in the stage table is translated.
// The downrange estimate arrives already translated.
function accuracyLabel(accuracy) {
  if (accuracy === 'CONFIRMED') return t('CONFIRMED');
  if (accuracy === 'PAD / RTLS') return t('PAD / RTLS');
  return accuracy;
}

export function createPanel({ state: layerState, services, parts, source }) {
  /**
   * Preserve the user's globe scale for roster previews while avoiding an
   * accidental surface-level fly-to when the list is opened from a close view.
   * @param {number} cameraHeight Current camera height above the ellipsoid.
   * @returns {number} Preview range in metres.
   */

  function missionHoverPreviewRange(cameraHeight) {
    const height = Number(cameraHeight);
    return Math.max(
      MISSION_CLOSE_VIEW_RANGE_M,
      Number.isFinite(height) ? height : MISSION_GLOBE_VIEW_RANGE_M,
    );
  }

  /**
   * Coordinate pointer and keyboard ownership of the temporary roster preview.
   * The most recent input owns the preview until it leaves, then any remaining
   * input resumes ownership. This lets keyboard focus take over from a pointer
   * resting on another row without losing that pointer preview on blur.
   * @param {{preview: (index: number) => void, clear: () => void}} handlers
   * @returns {{pointerEnter: (index: number) => void, pointerLeave: () => void,
   *   focus: (index: number) => void, blur: (nextIndex?: number|null) => void,
   *   reset: () => void}}
   */

  function createMissionRosterPreviewOwnership({ preview, clear }) {
    let pointerIndex = null;
    let focusIndex = null;
    let latestOwner = null;
    let activeIndex = null;

    const sync = () => {
      const nextIndex =
        latestOwner === 'pointer'
          ? (pointerIndex ?? focusIndex)
          : (focusIndex ?? pointerIndex);
      if (nextIndex === activeIndex) return;
      activeIndex = nextIndex;
      if (Number.isInteger(nextIndex)) preview(nextIndex);
      else clear();
    };

    return {
      pointerEnter(index) {
        pointerIndex = index;
        latestOwner = 'pointer';
        sync();
      },
      pointerLeave() {
        pointerIndex = null;
        if (latestOwner === 'pointer')
          latestOwner = focusIndex === null ? null : 'focus';
        sync();
      },
      focus(index) {
        focusIndex = index;
        latestOwner = 'focus';
        sync();
      },
      blur(nextIndex = null) {
        focusIndex = Number.isInteger(nextIndex) ? nextIndex : null;
        if (latestOwner === 'focus')
          latestOwner =
            focusIndex === null
              ? pointerIndex === null
                ? null
                : 'pointer'
              : 'focus';
        sync();
      },
      reset() {
        pointerIndex = null;
        focusIndex = null;
        latestOwner = null;
        activeIndex = null;
        clear();
      },
    };
  }

  /** Resolve a pending preview against the current refresh, never a stale object. */

  function resolveMissionRosterPreviewLaunch(launches, launchId) {
    return (
      (launches || []).find((candidate) => candidate.id === launchId) || null
    );
  }

  /**
   * Publish a fresh view unless it is the one already shown. The roster
   * carries its own signature, so a telemetry update compares the mission.
   */
  function publish(view) {
    const signature = `${layerState._missionRosterSignature}|${JSON.stringify(view.mission)}`;
    if (layerState._missionPanelSignature === signature) return;
    layerState._missionPanelSignature = signature;
    layerState._missionPanelView = view;
    for (const listener of [...layerState._missionPanelListeners])
      listener(view);
  }

  /**
   * Receive every published view, starting with the current one.
   * @param {(view: {roster: ?object, mission: ?object}) => void} listener
   * @returns {() => void} Unsubscribe.
   */
  function subscribePanel(listener) {
    layerState._missionPanelListeners.add(listener);
    if (layerState._missionPanelView) listener(layerState._missionPanelView);
    return () => layerState._missionPanelListeners.delete(listener);
  }

  /** Publish the roster and the selected mission as they stand. */
  function publishPanel() {
    if (!layerState._missionPanelReady) return;
    publish({
      roster: layerState._missionRosterView,
      mission: presentMission(),
    });
  }

  /** A detail value, or null when the panel hides its row. */
  function presentField(value) {
    return value !== null && value !== undefined && String(value).trim() !== ''
      ? String(value)
      : null;
  }

  function presentPayload(payload, launch) {
    const detail = [
      payload.manufacturer,
      payload.operator && payload.operator !== payload.manufacturer
        ? payload.operator
        : null,
      Number.isFinite(payload.massKg)
        ? `${formatNumber(payload.massKg)} KG`
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      name: `${payload.name ?? ''}${payload.amount > 1 ? ` ×${payload.amount}` : ''}`,
      detail,
      type: payload.type || t('UNSPECIFIED'),
      destination:
        payload.destination || launch.orbit?.name || t('UNAVAILABLE'),
    };
  }

  function presentStage(stage, launch) {
    const endpoint = stage.endpoint;
    const destination =
      stage.destination ||
      (endpoint?.accuracy === 'PAD / RTLS'
        ? launch.launchSite
        : t('UNAVAILABLE'));
    const position = endpoint
      ? `${isolate(`${endpoint.lat.toFixed(2)}, ${endpoint.lon.toFixed(2)}`)} · ${accuracyLabel(endpoint.accuracy)}`
      : stage.downrangeKm > 0
        ? t('{value} KM DOWNRANGE', {
            value: formatNumber(stage.downrangeKm),
          })
        : t('POSITION UNAVAILABLE');
    const detail = [
      Number.isFinite(stage.flightNumber)
        ? t('FLIGHT {count}', {
            count: stage.flightNumber,
          })
        : null,
      stage.reused ? t('REUSED') : null,
      stage.recoveryType,
    ]
      .filter(Boolean)
      .join(' · ');
    return {
      name: String(stage.name ?? ''),
      detail,
      status: String(stage.status ?? ''),
      destination: String(destination ?? ''),
      position,
    };
  }

  /**
   * The selected mission as the panel shows it, or null when none is
   * selected and the panel hides. Text arrives in the UI language.
   */
  function presentMission() {
    const launch = layerState._launches.find(
      (item) => item.id === layerState._selectedLaunchId,
    );
    if (!launch) return null;
    const index = layerState._launches.indexOf(launch);
    const pathPresentation = parts.policyHelpers.missionPathPresentation(
      launch,
      layerState._replayTracks.has(launch.id),
    );
    const telemetry = layerState._missionTelemetry;
    return {
      scrollRequest: layerState._missionPanelScrollRequest,
      title: parts.overlays.shortMissionLabel(launch.name, 32).toUpperCase(),
      provider: presentField(launch.provider),
      // Launch Library status names are provider data, shown as sent; only
      // the fallback for a launch without one is ours to translate.
      status: presentField(
        launch.status === UNKNOWN_LAUNCH_STATUS
          ? t(UNKNOWN_LAUNCH_STATUS)
          : launch.status,
      ),
      site: presentField(
        launch.launchSite && launch.launchSite !== 'Unknown launch site'
          ? launch.launchSite
          : null,
      ),
      time: presentField(launch.launchTime),
      orbit: presentField(pathPresentation.orbit),
      ascent: pathPresentation.ascent ?? '',
      distance: telemetry?.distance ?? null,
      speed: telemetry?.speed ?? null,
      speedTitle: telemetry?.speedTitle ?? null,
      payloads: launch.payloads
        .slice(0, 5)
        .map((payload) => presentPayload(payload, launch)),
      payloadsMore:
        launch.payloads.length > 5
          ? t('+{count} additional payload records', {
              count: launch.payloads.length - 5,
            })
          : null,
      stages: launch.recoveryStages.map((stage) => presentStage(stage, launch)),
      index: `${index + 1} / ${layerState._launches.length}`,
      previousDisabled: index <= 0,
      nextDisabled: index < 0 || index >= layerState._launches.length - 1,
      replay: parts.replay.presentReplay(),
    };
  }

  /** Present the newly selected mission and return its panel to the top. */
  function renderMissionPanel() {
    if (!layerState._missionPanelReady) return;
    layerState._missionTelemetry = null;
    updateMissionTelemetry(true, false);
    layerState._missionPanelScrollRequest++;
    publishPanel();
  }

  /** The roster entries as the list shows them. */
  function presentRoster() {
    const entries = parts.policyHelpers
      .missionRosterEntries(layerState._launches)
      .map(({ launch, index }) => {
        const label = parts.overlays
          .shortMissionLabel(launch.name, 27)
          .toUpperCase();
        return {
          index,
          id: String(launch.id ?? ''),
          color: parts.model.missionMarkerColor(launch).toCssColorString(),
          label,
          ariaLabel: t('Select {mission}', { mission: label }),
          provider: launch.provider || t('UNSPECIFIED OPERATOR'),
          date: launch.launchTime?.slice(0, 10) || t('DATE UNAVAILABLE'),
        };
      });
    return {
      count: t('{count} / 30D', { count: layerState._launches.length }),
      entries,
      empty: t('NO MISSIONS AVAILABLE IN THE CURRENT 30-DAY WINDOW'),
    };
  }

  /**
   * Present the roster. A changed roster drops the hover and keyboard
   * preview; the list restores keyboard focus by mission identity, which
   * resumes the preview.
   */
  function renderMissionRoster() {
    if (!layerState._missionPanelReady) return;
    const roster = presentRoster();
    const signature = JSON.stringify(roster);
    if (signature !== layerState._missionRosterSignature) {
      layerState._missionRosterSignature = signature;
      layerState._missionRosterView = roster;
      layerState._missionRosterPreviewOwnership?.reset();
    }
    publishPanel();
  }

  /**
   * Read the selected mission's altitude and speed, at most four times a
   * second unless forced, and republish when they change.
   */
  function updateMissionTelemetry(force = false, republish = true) {
    if (
      !layerState._missionPanelReady ||
      !layerState._selectedLaunchId ||
      !layerState._dataSource
    )
      return;
    const now = performance.now();
    if (!force && now - layerState._lastPanelTelemetryMs < 250) return;
    layerState._lastPanelTelemetryMs = now;
    const satellite = layerState._dataSource.entities.getById(
      `rocket-satellite:${layerState._selectedLaunchId}`,
    );
    const position = satellite?.position?.getValue(
      Cesium.JulianDate.now(layerState._declutterTime),
    );
    const altitudeM = position
      ? Cesium.Cartographic.fromCartesian(position)?.height
      : null;
    const speedMps = layerState._satelliteTelemetry.get(
      layerState._selectedLaunchId,
    )?.speedMps;
    layerState._missionTelemetry = {
      distance: Number.isFinite(altitudeM)
        ? t('{value} KM', {
            value: formatNumber(Math.max(0, altitudeM / 1000), {
              maximumFractionDigits: 0,
            }),
          })
        : null,
      speed: Number.isFinite(speedMps)
        ? t('{value} KM/S', {
            value: formatNumber(speedMps / 1000, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }),
          })
        : null,
      speedTitle: Number.isFinite(speedMps)
        ? `${formatNumber(speedMps * 3.6, { maximumFractionDigits: 0 })} km/h`
        : null,
    };
    if (republish) publishPanel();
  }

  function selectMissionAt(index) {
    const launch = layerState._launches[index];
    if (!launch) return;
    parts.selection.setSelectedMission(launch.id, true);
    parts.selection.focusMission(launch);
  }

  function clearMissionRosterPreviewState() {
    if (layerState._missionRosterHoverTimer)
      clearTimeout(layerState._missionRosterHoverTimer);
    layerState._missionRosterHoverTimer = null;
    const changed = layerState._hoveredRosterLaunchId !== null;
    layerState._hoveredRosterLaunchId = null;
    if (changed) parts.overlays.syncMissionOverlayEntries();
  }

  function clearMissionRosterHover() {
    if (layerState._missionRosterPreviewOwnership)
      layerState._missionRosterPreviewOwnership.reset();
    else clearMissionRosterPreviewState();
  }

  function scheduleMissionRosterPreview(index) {
    const launch = layerState._launches[index];
    if (!launch || layerState._selectedLaunchId) return;
    if (layerState._missionRosterHoverTimer)
      clearTimeout(layerState._missionRosterHoverTimer);
    layerState._hoveredRosterLaunchId = launch.id;
    parts.overlays.syncMissionOverlayEntries();
    layerState._missionRosterHoverTimer = setTimeout(() => {
      layerState._missionRosterHoverTimer = null;
      if (layerState._hoveredRosterLaunchId !== launch.id) return;
      const currentLaunch = resolveMissionRosterPreviewLaunch(
        layerState._launches,
        launch.id,
      );
      if (currentLaunch)
        parts.policyHelpers.previewMissionFromRoster(currentLaunch);
    }, 140);
  }

  /** Select the mission before or after the selected one. */
  function selectAdjacentMission(step) {
    selectMissionAt(
      layerState._launches.findIndex(
        (item) => item.id === layerState._selectedLaunchId,
      ) + step,
    );
  }

  /** The panel's commands, called by Core's mission components. */
  const commands = {
    selectMissionAt,
    selectPreviousMission: () => selectAdjacentMission(-1),
    selectNextMission: () => selectAdjacentMission(1),
    deselectMission: () => parts.selection.setSelectedMission(null),
    focusSelectedLaunchSite() {
      const launch = layerState._launches.find(
        (item) => item.id === layerState._selectedLaunchId,
      );
      if (launch) parts.selection.focusLaunchSite(launch);
    },
    startSelectedReplay() {
      if (layerState._selectedLaunchId)
        parts.replay.startMissionReplay(layerState._selectedLaunchId);
    },
    toggleReplayPause() {
      if (layerState._replayPaused) parts.replay.resumeMissionReplay();
      else parts.replay.pauseMissionReplay();
    },
    cancelReplay: () => parts.replay.stopMissionReplay(),
    setReplaySpeed: (value) => parts.replay.setReplaySpeed(value),
    rosterPointerEnter: (index) =>
      layerState._missionRosterPreviewOwnership?.pointerEnter(index),
    rosterPointerLeave: () =>
      layerState._missionRosterPreviewOwnership?.pointerLeave(),
    rosterFocus: (index) =>
      layerState._missionRosterPreviewOwnership?.focus(index),
    rosterBlur: (nextIndex) =>
      layerState._missionRosterPreviewOwnership?.blur(nextIndex),
  };

  /** Start presenting the roster and the selected mission. */
  function createMissionPanel() {
    if (layerState._missionPanelReady) return;
    layerState._missionPanelReady = true;
    layerState._missionRosterPreviewOwnership =
      createMissionRosterPreviewOwnership({
        preview: scheduleMissionRosterPreview,
        clear: clearMissionRosterPreviewState,
      });
    // The roster and mission are worded again in a new locale.
    layerState._offMissionLocale = onLocaleChange(() => {
      renderMissionRoster();
      updateMissionTelemetry(true, false);
      publishPanel();
    });
    publishPanel();
  }

  /** Stop presenting; the components return to their initial markup. */
  function clearMissionPanel() {
    layerState._missionPanelReady = false;
    layerState._offMissionLocale?.();
    layerState._offMissionLocale = null;
    layerState._missionRosterPreviewOwnership = null;
    layerState._missionRosterView = null;
    layerState._missionRosterSignature = null;
    layerState._missionTelemetry = null;
    layerState._replayTransportLabel = null;
    publish({ roster: null, mission: null });
  }

  return {
    missionHoverPreviewRange,
    createMissionRosterPreviewOwnership,
    resolveMissionRosterPreviewLaunch,
    subscribePanel,
    publishPanel,
    presentMission,
    renderMissionPanel,
    renderMissionRoster,
    updateMissionTelemetry,
    selectMissionAt,
    clearMissionRosterPreviewState,
    clearMissionRosterHover,
    scheduleMissionRosterPreview,
    createMissionPanel,
    clearMissionPanel,
    commands,
  };
}
