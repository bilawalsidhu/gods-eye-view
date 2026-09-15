import * as Cesium from 'cesium';
import { t } from '../../i18n/index.js';
import {
  MISSION_CLOSE_VIEW_RANGE_M,
  MISSION_GLOBE_VIEW_RANGE_M,
} from './policy.js';

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

  /**
   * Bind native keyboard focus events for one rendered roster row.
   * @param {Element} button Mission roster button.
   * @param {number} index Source-array mission index.
   * @param {{pointerEnter: (index: number) => void, pointerLeave: () => void,
   *   focus: (index: number) => void, blur: (nextIndex?: number|null) => void}} ownership
   * @param {Element} roster Roster root used to reject focus targets outside the list.
   */

  function bindMissionRosterItemKeyboardPreview(
    button,
    index,
    ownership,
    roster,
  ) {
    button.addEventListener('mouseenter', () => ownership.pointerEnter(index));
    button.addEventListener('mouseleave', () => ownership.pointerLeave());
    button.addEventListener('focus', () => ownership.focus(index));
    button.addEventListener('blur', (event) => {
      const nextButton = event.relatedTarget?.closest?.(
        '[data-mission-roster-index]',
      );
      const nextIndex =
        nextButton && roster.contains(nextButton)
          ? Number(nextButton.dataset.missionRosterIndex)
          : null;
      ownership.blur(nextIndex);
    });
  }

  /** Capture the exact mission identity owned by keyboard focus before a refresh. */

  function captureMissionRosterFocus(
    list,
    activeElement = globalThis.document?.activeElement,
  ) {
    const button = activeElement?.closest?.('[data-mission-roster-id]');
    if (!button || !list?.contains(button)) return null;
    const launchId = button.dataset.missionRosterId;
    return launchId ? { launchId } : null;
  }

  /** Restore focus by mission identity, or continue after the list if it departed. */

  function restoreMissionRosterFocus(list, snapshot, continuation) {
    if (!snapshot?.launchId) return 'none';
    const button = Array.from(
      list?.querySelectorAll?.('[data-mission-roster-id]') || [],
    ).find(
      (candidate) => candidate.dataset.missionRosterId === snapshot.launchId,
    );
    if (button) {
      button.focus({ preventScroll: true });
      return 'restored';
    }
    if (continuation?.focus) {
      continuation.focus({ preventScroll: true });
      return 'continued';
    }
    return 'none';
  }

  /** Resolve a pending preview against the current refresh, never a stale object. */

  function resolveMissionRosterPreviewLaunch(launches, launchId) {
    return (
      (launches || []).find((candidate) => candidate.id === launchId) || null
    );
  }

  function missionTableRows(items, columns, emptyText) {
    if (!items.length)
      return `<tr><td colspan="${columns}" class="mission-table-empty">${emptyText}</td></tr>`;
    return items.map((item) => item).join('');
  }

  function setMissionPanelField(selector, value, title = '') {
    const output = layerState._missionPanel?.querySelector(selector);
    if (!output) return;
    const row = output.closest('[data-mission-field]');
    const available =
      value !== null && value !== undefined && String(value).trim() !== '';
    if (row) row.hidden = !available;
    if (!available) {
      output.textContent = '';
      output.removeAttribute('title');
      return;
    }
    output.textContent = value;
    if (title) output.title = title;
    else output.removeAttribute('title');
  }

  function renderMissionPanel() {
    if (!layerState._missionPanel) return;
    const launch = layerState._launches.find(
      (item) => item.id === layerState._selectedLaunchId,
    );
    const index = launch ? layerState._launches.indexOf(launch) : -1;
    layerState._missionPanel.hidden = !launch;
    if (!launch) return;
    layerState._missionPanel.querySelector('[data-mission-title]').textContent =
      parts.overlays.shortMissionLabel(launch.name, 32).toUpperCase();
    setMissionPanelField('[data-mission-provider]', launch.provider);
    setMissionPanelField('[data-mission-status]', launch.status);
    setMissionPanelField(
      '[data-mission-site]',
      launch.launchSite && launch.launchSite !== 'Unknown launch site'
        ? launch.launchSite
        : null,
    );
    setMissionPanelField('[data-mission-time]', launch.launchTime);
    const pathPresentation = parts.policyHelpers.missionPathPresentation(
      launch,
      layerState._replayTracks.has(launch.id),
    );
    setMissionPanelField('[data-mission-orbit]', pathPresentation.orbit);
    layerState._missionPanel.querySelector(
      '[data-mission-ascent-source]',
    ).textContent = pathPresentation.ascent;
    const payloadRows = launch.payloads.length
      ? launch.payloads.slice(0, 5).map((payload) => {
          const detail = [
            payload.manufacturer,
            payload.operator && payload.operator !== payload.manufacturer
              ? payload.operator
              : null,
            Number.isFinite(payload.massKg)
              ? `${payload.massKg.toLocaleString()} KG`
              : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return `<tr><td>${escapeMissionText(payload.name)}${payload.amount > 1 ? ` ×${payload.amount}` : ''}${detail ? `<small>${escapeMissionText(detail)}</small>` : ''}</td><td>${escapeMissionText(payload.type || t('layers.missions.rows.unspecified'))}</td><td>${escapeMissionText(payload.destination || launch.orbit?.name || t('layers.missions.rows.unavailable'))}</td></tr>`;
        })
      : [];
    if (launch.payloads.length > 5) {
      payloadRows.push(
        `<tr><td colspan="3" class="mission-table-empty">${t('layers.missions.rows.additionalPayloads', { count: launch.payloads.length - 5 })}</td></tr>`,
      );
    }
    layerState._missionPanel.querySelector(
      '[data-mission-payloads]',
    ).innerHTML = missionTableRows(
      payloadRows,
      3,
      t('layers.missions.rows.classified'),
    );
    const stageRows = launch.recoveryStages.map((stage) => {
      const endpoint = stage.endpoint;
      const destination =
        stage.destination ||
        (endpoint?.accuracy === 'PAD / RTLS'
          ? launch.launchSite
          : t('layers.missions.rows.unavailable'));
      const position = endpoint
        ? `${endpoint.lat.toFixed(2)}, ${endpoint.lon.toFixed(2)} · ${endpoint.accuracy}`
        : stage.downrangeKm > 0
          ? t('layers.missions.rows.kmDownrange', {
              value: stage.downrangeKm.toLocaleString(),
            })
          : t('layers.missions.rows.positionUnavailable');
      const stageDetail = [
        Number.isFinite(stage.flightNumber)
          ? t('layers.missions.rows.flightNumber', {
              count: stage.flightNumber,
            })
          : null,
        stage.reused ? t('layers.missions.rows.reused') : null,
        stage.recoveryType,
      ]
        .filter(Boolean)
        .join(' · ');
      return `<tr><td>${escapeMissionText(stage.name)}${stageDetail ? `<small>${escapeMissionText(stageDetail)}</small>` : ''}</td><td>${escapeMissionText(stage.status)}</td><td>${escapeMissionText(destination)}<small>${escapeMissionText(position)}</small></td></tr>`;
    });
    layerState._missionPanel.querySelector('[data-mission-stages]').innerHTML =
      missionTableRows(stageRows, 3, t('layers.missions.rows.noStageData'));
    const stageSection = layerState._missionPanel.querySelector(
      '[data-mission-stages-section]',
    );
    if (stageSection) stageSection.hidden = stageRows.length === 0;
    updateMissionTelemetry(true);
    layerState._missionPanel.querySelector('[data-mission-index]').textContent =
      `${index + 1} / ${layerState._launches.length}`;
    layerState._missionPanel.querySelector('[data-mission-prev]').disabled =
      index <= 0;
    layerState._missionPanel.querySelector('[data-mission-next]').disabled =
      index < 0 || index >= layerState._launches.length - 1;
    parts.replay.syncReplayButton();
    const panelScroller = layerState._missionPanel.closest(
      '.global-context-panel-inner',
    );
    if (panelScroller) panelScroller.scrollTop = 0;
  }

  function renderMissionRoster() {
    if (!layerState._missionRoster) return;
    const list = layerState._missionRoster.querySelector(
      '[data-mission-roster-list]',
    );
    const count = layerState._missionRoster.querySelector(
      '[data-mission-roster-count]',
    );
    if (count)
      count.textContent = t('layers.missions.roster.count', {
        count: layerState._launches.length,
      });
    if (!list) return;
    const focusSnapshot = captureMissionRosterFocus(list);
    layerState._missionRosterPreviewOwnership?.reset();
    const entries = parts.policyHelpers.missionRosterEntries(
      layerState._launches,
    );
    if (!entries.length) {
      list.innerHTML = `<div class="space-mission-roster-empty">${t('layers.missions.roster.empty')}</div>`;
      restoreMissionRosterFocus(
        list,
        focusSnapshot,
        layerState._missionRoster.querySelector(
          '[data-mission-roster-focus-continuation]',
        ),
      );
      return;
    }
    list.innerHTML = entries
      .map(({ launch, index }) => {
        const color = parts.model.missionMarkerColor(launch).toCssColorString();
        const date =
          launch.launchTime?.slice(0, 10) ||
          t('layers.missions.roster.dateUnavailable');
        const provider =
          launch.provider || t('layers.missions.roster.unspecifiedOperator');
        const label = parts.overlays
          .shortMissionLabel(launch.name, 27)
          .toUpperCase();
        return `<button type="button" class="space-mission-roster-item" data-mission-roster-index="${index}" data-mission-roster-id="${escapeMissionText(launch.id)}" aria-label="${escapeMissionText(t('layers.missions.roster.selectAria', { mission: label }))}"><span class="space-mission-roster-marker" style="--mission-roster-color:${color}" aria-hidden="true"></span><span class="space-mission-roster-copy"><strong>${escapeMissionText(label)}</strong><small>${escapeMissionText(provider)} · ${escapeMissionText(date)}</small></span><span class="space-mission-roster-chevron" aria-hidden="true">›</span></button>`;
      })
      .join('');
    list.querySelectorAll('[data-mission-roster-index]').forEach((button) => {
      const index = Number(button.dataset.missionRosterIndex);
      bindMissionRosterItemKeyboardPreview(
        button,
        index,
        layerState._missionRosterPreviewOwnership,
        layerState._missionRoster,
      );
    });
    restoreMissionRosterFocus(
      list,
      focusSnapshot,
      layerState._missionRoster.querySelector(
        '[data-mission-roster-focus-continuation]',
      ),
    );
  }

  function escapeMissionText(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character],
    );
  }

  function updateMissionTelemetry(force = false) {
    if (
      !layerState._missionPanel ||
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
    setMissionPanelField(
      '[data-mission-distance]',
      Number.isFinite(altitudeM)
        ? t('layers.missions.telemetry.km', {
            value: Math.max(0, altitudeM / 1000).toLocaleString(undefined, {
              maximumFractionDigits: 0,
            }),
          })
        : null,
    );
    const speedMps = layerState._satelliteTelemetry.get(
      layerState._selectedLaunchId,
    )?.speedMps;
    setMissionPanelField(
      '[data-mission-speed]',
      Number.isFinite(speedMps)
        ? t('layers.missions.telemetry.kmPerSecond', {
            value: (speedMps / 1000).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }),
          })
        : null,
      Number.isFinite(speedMps)
        ? `${(speedMps * 3.6).toLocaleString(undefined, { maximumFractionDigits: 0 })} km/h`
        : '',
    );
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

  function createMissionPanel() {
    if (layerState._missionPanel || typeof document === 'undefined') return;
    const host =
      document.getElementById('space-mission-panel-host') ||
      document.getElementById('right-context-rail');
    if (!host) return;
    layerState._missionRoster = document.getElementById('space-mission-roster');
    if (layerState._missionRoster) {
      layerState._missionRosterPreviewOwnership =
        createMissionRosterPreviewOwnership({
          preview: scheduleMissionRosterPreview,
          clear: clearMissionRosterPreviewState,
        });
      layerState._missionRoster.onclick = (event) => {
        const button =
          event.target instanceof Element
            ? event.target.closest('[data-mission-roster-index]')
            : null;
        if (!button) return;
        selectMissionAt(Number(button.dataset.missionRosterIndex));
      };
    }
    layerState._missionPanel = document.createElement('aside');
    layerState._missionPanel.id = 'space-mission-panel';
    layerState._missionPanel.className = 'context-space-mission-detail';
    layerState._missionPanel.setAttribute(
      'aria-label',
      t('layers.missions.panel.selectedHeader'),
    );
    layerState._missionPanel.innerHTML = `<div class="space-mission-view-header"><span>${t('layers.missions.panel.selectedHeader')}</span><button type="button" data-mission-close title="${t('layers.missions.panel.showAllTitle')}" aria-label="${t('layers.missions.panel.deselectAria')}">×</button></div><div class="space-mission-detail"><strong data-mission-title>${t('layers.missions.panel.mission')}</strong><span data-mission-field data-mission-provider></span><span data-mission-field>${t('layers.missions.panel.status')}<b data-mission-status></b></span><span data-mission-field>${t('layers.missions.panel.launchSite')}<b data-mission-site></b></span><span data-mission-field>${t('layers.missions.panel.launchTime')}<b data-mission-time></b></span><span data-mission-field>${t('layers.missions.panel.orbit')}<b data-mission-orbit></b></span><span>${t('layers.missions.panel.ascentPath')}<b data-mission-ascent-source></b></span><span data-mission-field>${t('layers.missions.panel.distance')}<b data-mission-distance></b></span><span data-mission-field>${t('layers.missions.panel.speed')}<b data-mission-speed></b></span></div><section class="mission-data-section"><h4>${t('layers.missions.panel.payload')}</h4><div class="mission-table-scroll"><table class="mission-data-table"><thead><tr><th>${t('layers.missions.panel.colName')}</th><th>${t('layers.missions.panel.colType')}</th><th>${t('layers.missions.panel.colDestination')}</th></tr></thead><tbody data-mission-payloads></tbody></table></div></section><section class="mission-data-section" data-mission-stages-section><h4>${t('layers.missions.panel.stagesSection')}</h4><div class="mission-table-scroll"><table class="mission-data-table"><thead><tr><th>${t('layers.missions.panel.colStage')}</th><th>${t('layers.missions.panel.colStatus')}</th><th>${t('layers.missions.panel.colFinalPosition')}</th></tr></thead><tbody data-mission-stages></tbody></table></div></section><div class="mission-replay-speed-control"><div class="mission-replay-speed-header"><label for="space-mission-replay-speed">${t('layers.missions.replay.speedLabel')}</label><output class="gev-slider-value" for="space-mission-replay-speed" data-mission-replay-speed-output>1×</output></div><input id="space-mission-replay-speed" class="gev-quantitative-slider" type="range" min="0.25" max="4" step="0.25" value="1" data-mission-replay-speed aria-label="${t('layers.missions.replay.speedAria')}"><div class="mission-replay-speed-scale" aria-hidden="true"><span>0.25×</span><span>1×</span><span>4×</span></div></div><div class="mission-action-row"><button type="button" class="mission-focus-button" data-mission-focus>${t('layers.missions.panel.focus')}</button><button type="button" class="mission-replay-button" data-mission-replay aria-pressed="false">${t('layers.missions.replay.start')}</button></div><div class="space-mission-nav"><button type="button" class="mission-nav-button" data-mission-prev title="${t('layers.missions.panel.prevTitle')}"><span aria-hidden="true">‹</span> ${t('layers.missions.panel.prev')}</button><span class="mission-nav-index" data-mission-index>—</span><button type="button" class="mission-nav-button" data-mission-next title="${t('layers.missions.panel.nextTitle')}">${t('layers.missions.panel.next')} <span aria-hidden="true">›</span></button></div><button type="button" class="panel-layer-toggle" data-mission-show-all>${t('layers.missions.panel.showAll')}</button>`;
    layerState._missionPanel
      .querySelector('.mission-action-row')
      .insertAdjacentHTML(
        'beforeend',
        `<div class="mission-replay-transport" data-mission-replay-transport hidden>
      <button type="button" data-mission-replay-toggle title="${t('layers.missions.replay.pause')}" aria-label="${t('layers.missions.replay.pause')}">Ⅱ</button>
      <button type="button" class="cancel" data-mission-replay-cancel title="${t('layers.missions.replay.cancel')}" aria-label="${t('layers.missions.replay.cancel')}"><span aria-hidden="true">×</span></button>
    </div>`,
      );
    host.appendChild(layerState._missionPanel);
    layerState._missionPanel
      .querySelector('[data-mission-prev]')
      .addEventListener('click', () =>
        selectMissionAt(
          layerState._launches.findIndex(
            (item) => item.id === layerState._selectedLaunchId,
          ) - 1,
        ),
      );
    layerState._missionPanel
      .querySelector('[data-mission-next]')
      .addEventListener('click', () =>
        selectMissionAt(
          layerState._launches.findIndex(
            (item) => item.id === layerState._selectedLaunchId,
          ) + 1,
        ),
      );
    layerState._missionPanel
      .querySelector('[data-mission-close]')
      .addEventListener('click', () =>
        parts.selection.setSelectedMission(null),
      );
    layerState._missionPanel
      .querySelector('[data-mission-show-all]')
      .addEventListener('click', () =>
        parts.selection.setSelectedMission(null),
      );
    layerState._missionPanel
      .querySelector('[data-mission-focus]')
      .addEventListener('click', () => {
        const launch = layerState._launches.find(
          (item) => item.id === layerState._selectedLaunchId,
        );
        if (launch) parts.selection.focusLaunchSite(launch);
      });
    layerState._missionPanel
      .querySelector('[data-mission-replay]')
      .addEventListener('click', () => {
        if (layerState._selectedLaunchId)
          parts.replay.startMissionReplay(layerState._selectedLaunchId);
      });
    layerState._missionPanel
      .querySelector('[data-mission-replay-toggle]')
      .addEventListener('click', () => {
        if (layerState._replayPaused) parts.replay.resumeMissionReplay();
        else parts.replay.pauseMissionReplay();
      });
    layerState._missionPanel
      .querySelector('[data-mission-replay-cancel]')
      .addEventListener('click', parts.replay.stopMissionReplay);
    layerState._missionPanel
      .querySelector('[data-mission-replay-speed]')
      .addEventListener('input', (event) => {
        parts.replay.setReplaySpeed(event.currentTarget.value);
      });
    parts.replay.syncReplaySpeedControl();
  }
  return {
    missionHoverPreviewRange,
    createMissionRosterPreviewOwnership,
    bindMissionRosterItemKeyboardPreview,
    captureMissionRosterFocus,
    restoreMissionRosterFocus,
    resolveMissionRosterPreviewLaunch,
    missionTableRows,
    setMissionPanelField,
    renderMissionPanel,
    renderMissionRoster,
    escapeMissionText,
    updateMissionTelemetry,
    selectMissionAt,
    clearMissionRosterPreviewState,
    clearMissionRosterHover,
    scheduleMissionRosterPreview,
    createMissionPanel,
  };
}
