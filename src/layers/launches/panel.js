import * as Cesium from 'cesium';
import { t, subscribeLocale } from '../../i18n/index.js';
import { applyStaticTranslations } from '../../ui/staticI18n.js';
import {
  MISSION_CLOSE_VIEW_RANGE_M,
  MISSION_GLOBE_VIEW_RANGE_M,
} from './policy.js';

// The stage/status values below arrive as stable English tokens from the
// normalization layer (launches/model.js); the panel is the presentation edge
// that translates the known ones. Unknown upstream values pass through.
const STAGE_STATUS_KEYS = {
  RECOVERED: 'space.stage.recovered',
  LOST: 'space.stage.lost',
  'RECOVERY ATTEMPT': 'space.stage.attempt',
  'NO RECOVERY DATA': 'space.stage.noData',
};

const ACCURACY_KEYS = {
  CONFIRMED: 'space.accuracy.confirmed',
  'PAD / RTLS': 'space.accuracy.padRtls',
  'EST. DOWNRANGE': 'space.accuracy.estDownrange',
};

// missionPathPresentation() (test-locked formatter) emits these stable
// English descriptors; resolve them through the pack at paint time.
const PATH_ASCENT_KEYS = {
  'SUPPLIED TRAJECTORY POINTS': 'space.path.suppliedPoints',
  'RECONSTRUCTED ESTIMATE': 'space.path.reconstructed',
  UNAVAILABLE: 'space.value.unavailable',
};

/** Translate a known launch-site fallback token; other names are verbatim data. */
function presentLaunchSite(site) {
  if (!site) return null;
  return site === 'Unknown launch site' ? t('space.value.unknownSite') : site;
}

/** Translate the known stage-recovery status tokens at the display edge. */
function presentStageStatus(status) {
  const key = STAGE_STATUS_KEYS[status];
  return key ? t(key) : status;
}

/** Translate the known landing-accuracy tokens at the display edge. */
function presentAccuracy(accuracy) {
  const key = ACCURACY_KEYS[accuracy];
  return key ? t(key) : accuracy;
}

/** Translate the known mission-path ascent descriptors at the display edge. */
function presentPathAscent(ascent) {
  const key = PATH_ASCENT_KEYS[ascent];
  return key ? t(key) : ascent;
}

/** Split a `PLANNED · {orbit}` descriptor into a translated presentation. */
function presentPathOrbit(orbit) {
  if (!orbit) return null;
  if (orbit.startsWith('PLANNED · '))
    return t('space.path.planned', { orbit: orbit.slice('PLANNED · '.length) });
  return orbit;
}

// Normalizer fallback identities (launches/model.js) are stable English data;
// translate the known patterns when they reach the panel.
const STAGE_NAME_KEYS = {
  'Launcher stage': 'space.value.launcherStage',
  'Spacecraft stage': 'space.value.spacecraftStage',
  Payload: 'space.value.payloadN',
};

/** Translate normalizer fallback names (launch/stage/payload) at paint time. */
function presentLaunchName(name) {
  return name === 'Unnamed launch' ? t('space.value.unnamedLaunch') : name;
}

function presentPayloadName(name) {
  return name === 'Unnamed payload' ? t('space.value.unnamedPayload') : name;
}

function presentStageName(name) {
  const match = /^(Launcher stage|Spacecraft stage|Payload) (\d+)$/.exec(
    String(name || ''),
  );
  if (!match) return name;
  return t(STAGE_NAME_KEYS[match[1]], { n: Number(match[2]) });
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
      parts.overlays
        .shortMissionLabel(presentLaunchName(launch.name), 32)
        .toUpperCase();
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
    setMissionPanelField(
      '[data-mission-orbit]',
      presentPathOrbit(pathPresentation.orbit),
    );
    layerState._missionPanel.querySelector(
      '[data-mission-ascent-source]',
    ).textContent = presentPathAscent(pathPresentation.ascent);
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
          return `<tr><td>${escapeMissionText(presentPayloadName(payload.name))}${payload.amount > 1 ? ` ×${payload.amount}` : ''}${detail ? `<small>${escapeMissionText(detail)}</small>` : ''}</td><td>${escapeMissionText(payload.type || t('space.value.unspecified'))}</td><td>${escapeMissionText(payload.destination || launch.orbit?.name || t('space.value.unavailable'))}</td></tr>`;
        })
      : [];
    if (launch.payloads.length > 5) {
      payloadRows.push(
        `<tr><td colspan="3" class="mission-table-empty">${escapeMissionText(t('space.payload.additional', { n: launch.payloads.length - 5 }))}</td></tr>`,
      );
    }
    layerState._missionPanel.querySelector(
      '[data-mission-payloads]',
    ).innerHTML = missionTableRows(
      payloadRows,
      3,
      escapeMissionText(t('space.payload.dataUnavailable')),
    );
    const stageRows = launch.recoveryStages.map((stage) => {
      const endpoint = stage.endpoint;
      const destination =
        stage.destination ||
        (endpoint?.accuracy === 'PAD / RTLS'
          ? presentLaunchSite(launch.launchSite)
          : t('space.value.unavailable'));
      const position = endpoint
        ? `${endpoint.lat.toFixed(2)}, ${endpoint.lon.toFixed(2)} · ${presentAccuracy(endpoint.accuracy)}`
        : stage.downrangeKm > 0
          ? t('space.value.kmDownrange', {
              km: stage.downrangeKm.toLocaleString(),
            })
          : t('space.value.positionUnavailable');
      const stageDetail = [
        Number.isFinite(stage.flightNumber)
          ? t('space.value.flight', { n: stage.flightNumber })
          : null,
        stage.reused ? t('space.value.reused') : null,
        stage.recoveryType,
      ]
        .filter(Boolean)
        .join(' · ');
      return `<tr><td>${escapeMissionText(presentStageName(stage.name))}${stageDetail ? `<small>${escapeMissionText(stageDetail)}</small>` : ''}</td><td>${escapeMissionText(presentStageStatus(stage.status))}</td><td>${escapeMissionText(destination)}<small>${escapeMissionText(position)}</small></td></tr>`;
    });
    layerState._missionPanel.querySelector('[data-mission-stages]').innerHTML =
      missionTableRows(
        stageRows,
        3,
        escapeMissionText(t('space.stage.noRecoveryData')),
      );
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
      ":root[data-ui-theme='cyber'] .cyber-panel-body, .global-context-panel-inner",
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
      count.textContent = t('space.roster.count', {
        n: layerState._launches.length,
      });
    if (!list) return;
    const focusSnapshot = captureMissionRosterFocus(list);
    layerState._missionRosterPreviewOwnership?.reset();
    const entries = parts.policyHelpers.missionRosterEntries(
      layerState._launches,
    );
    if (!entries.length) {
      list.innerHTML = `<div class="space-mission-roster-empty">${escapeMissionText(t('space.roster.empty'))}</div>`;
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
          launch.launchTime?.slice(0, 10) || t('space.roster.dateUnavailable');
        const provider =
          launch.provider || t('space.roster.unspecifiedOperator');
        const label = parts.overlays
          .shortMissionLabel(presentLaunchName(launch.name), 27)
          .toUpperCase();
        return `<button type="button" class="space-mission-roster-item" data-mission-roster-index="${index}" data-mission-roster-id="${escapeMissionText(launch.id)}" aria-label="${escapeMissionText(t('space.roster.selectAria', { mission: label }))}"><span class="space-mission-roster-marker" style="--mission-roster-color:${color}" aria-hidden="true"></span><span class="space-mission-roster-copy"><strong>${escapeMissionText(label)}</strong><small>${escapeMissionText(provider)} · ${escapeMissionText(date)}</small></span><span class="space-mission-roster-chevron" aria-hidden="true">›</span></button>`;
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
        ? `${Math.max(0, altitudeM / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} KM`
        : null,
    );
    const speedMps = layerState._satelliteTelemetry.get(
      layerState._selectedLaunchId,
    )?.speedMps;
    setMissionPanelField(
      '[data-mission-speed]',
      Number.isFinite(speedMps)
        ? `${(speedMps / 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} KM/S`
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
      'Selected Space Mission',
    );
    layerState._missionPanel.setAttribute(
      'data-i18n-attr',
      'aria-label:space.panel.aria',
    );
    // Static panel chrome is tagged for the declarative binder (rule: dynamic
    // fields repainted by feature code — data-mission-* — never carry
    // data-i18n; their owners translate inside the render functions above).
    layerState._missionPanel.innerHTML = `<div class="space-mission-view-header"><span data-i18n="space.panel.title">SELECTED SPACE MISSION</span><button type="button" data-mission-close title="Show all missions" aria-label="Deselect mission" data-i18n-attr="title:space.panel.closeTitle,aria-label:space.panel.closeAria">×</button></div><div class="space-mission-detail"><strong data-mission-title>MISSION</strong><span data-mission-field data-mission-provider></span><span data-mission-field><span data-i18n="space.panel.status">STATUS · </span><b data-mission-status></b></span><span data-mission-field><span data-i18n="space.panel.launchSite">LAUNCH SITE · </span><b data-mission-site></b></span><span data-mission-field><span data-i18n="space.panel.launchTime">LAUNCH TIME · </span><b data-mission-time></b></span><span data-mission-field><span data-i18n="space.panel.orbit">ORBIT · </span><b data-mission-orbit></b></span><span><span data-i18n="space.panel.ascentPath">ASCENT PATH · </span><b data-mission-ascent-source></b></span><span data-mission-field><span data-i18n="space.panel.distance">CURRENT DISTANCE FROM EARTH · </span><b data-mission-distance></b></span><span data-mission-field><span data-i18n="space.panel.speed">SATELLITE SPEED · </span><b data-mission-speed></b></span></div><section class="mission-data-section"><h4 data-i18n="space.payload.title">PAYLOAD</h4><div class="mission-table-scroll"><table class="mission-data-table"><thead><tr><th data-i18n="space.payload.name">NAME</th><th data-i18n="space.payload.type">TYPE</th><th data-i18n="space.payload.destination">DESTINATION</th></tr></thead><tbody data-mission-payloads></tbody></table></div></section><section class="mission-data-section" data-mission-stages-section><h4 data-i18n="space.stage.title">STAGE / RE-ENTRY / RECOVERY</h4><div class="mission-table-scroll"><table class="mission-data-table"><thead><tr><th data-i18n="space.stage.stage">STAGE</th><th data-i18n="space.stage.status">STATUS</th><th data-i18n="space.stage.finalPosition">FINAL POSITION</th></tr></thead><tbody data-mission-stages></tbody></table></div></section><div class="mission-replay-speed-control"><div class="mission-replay-speed-header"><label for="space-mission-replay-speed" data-i18n="space.replay.speed">REPLAY SPEED</label><output class="gev-slider-value" for="space-mission-replay-speed" data-mission-replay-speed-output>1×</output></div><input id="space-mission-replay-speed" class="gev-quantitative-slider" type="range" min="0.25" max="4" step="0.25" value="1" data-mission-replay-speed aria-label="Replay speed multiplier" data-i18n-attr="aria-label:space.replay.speedAria"><div class="mission-replay-speed-scale" aria-hidden="true"><span>0.25×</span><span>1×</span><span>4×</span></div></div><div class="mission-action-row"><button type="button" class="mission-focus-button" data-mission-focus data-i18n="space.nav.focus">FOCUS</button><button type="button" class="mission-replay-button" data-mission-replay aria-pressed="false">REPLAY ASCENT</button></div><div class="space-mission-nav"><button type="button" class="mission-nav-button" data-mission-prev title="Previous mission" data-i18n-attr="title:space.nav.prevTitle"><span aria-hidden="true">‹</span> <span data-i18n="space.nav.prev">PREV</span></button><span class="mission-nav-index" data-mission-index>—</span><button type="button" class="mission-nav-button" data-mission-next title="Next mission" data-i18n-attr="title:space.nav.nextTitle"><span data-i18n="space.nav.next">NEXT</span> <span aria-hidden="true">›</span></button></div><button type="button" class="panel-layer-toggle" data-mission-show-all data-i18n="space.nav.showAll">SHOW ALL / DESELECT</button>`;
    layerState._missionPanel
      .querySelector('.mission-action-row')
      .insertAdjacentHTML(
        'beforeend',
        `<div class="mission-replay-transport" data-mission-replay-transport hidden>
      <button type="button" data-mission-replay-toggle title="Pause replay" aria-label="Pause replay" data-i18n-attr="title:space.replay.pause,aria-label:space.replay.pause">Ⅱ</button>
      <button type="button" class="cancel" data-mission-replay-cancel title="Cancel replay" aria-label="Cancel replay" data-i18n-attr="title:space.replay.cancel,aria-label:space.replay.cancel"><span aria-hidden="true">×</span></button>
    </div>`,
      );
    applyStaticTranslations(layerState._missionPanel);
    // A locale switch repaints the tagged chrome through the binder above and
    // the data-driven fields through the render functions; the ambient mission
    // overlays replay through the same refresh.
    layerState._panelLocaleUnsubscribe?.();
    layerState._panelLocaleUnsubscribe = subscribeLocale(() => {
      if (!layerState._missionPanel) return;
      applyStaticTranslations(layerState._missionPanel);
      renderMissionPanel();
      renderMissionRoster();
      parts.overlays.syncMissionOverlayEntries();
    });
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
