/**
 * Operations console — composition root.
 *
 * Structural chrome layered over the existing interface: a command bar with
 * live camera telemetry, a module rail that drives the application's own
 * panels, a dossier with the feed roster and the scene analyst, a status
 * strip, and a command palette.
 *
 * It is strictly additive. The console constructs no scene state, owns no
 * layer, and every action it offers is delegated to the control that already
 * owns that behaviour (see `bridge.js`). Standing it down removes one class
 * from `<body>` and leaves the original interface exactly as it was, which is
 * also what happens when the markup is absent: `mountOperationsConsole`
 * returns an inert handle rather than failing the page.
 */

import {
  applicationHandle,
  cameraTelemetry,
  clickControl,
  isPanelOpen,
  layerRoster,
  onRenderedFrame,
  activeStyleName,
  applyVisualStyle,
  setLayerEnabled,
  subscribeLayers,
  togglePanel,
  whenApplicationReady,
} from './bridge.js';
import { buildCommands, CONSOLE_MODULES } from './commands.js';
import { createCommandPalette } from './palette.js';
import { createAnalystPanel } from './analyst.js';
import {
  formatAge,
  formatBearing,
  formatCount,
  formatElevation,
  formatLatitude,
  formatLongitude,
  formatPitch,
  formatUtcDate,
  formatUtcTime,
  compassPoint,
} from './format.js';
import { gridReference } from './grid.js';
import { layerFeedState } from '../data/feedState.js';
import { LOCATIONS, flyToPresetLocation } from '../locations.js';

const STORAGE_KEY = 'godsEyeView.console.enabled';
const CONSOLE_BODY_CLASS = 'gev-console';
const READOUT_INTERVAL_MS = 250;
const CLOCK_INTERVAL_MS = 1000;
const EVENT_LOG_LIMIT = 80;
const STATUS_CHIP_LIMIT = 5;
const FPS_SAMPLES = 36;

const FEED_TONE = Object.freeze({
  nominal: 'good',
  loading: 'wait',
  partial: 'warn',
  fallback: 'warn',
  stale: 'warn',
  degraded: 'warn',
  unavailable: 'bad',
});

/** Read a persisted preference without letting a blocked store break startup. */
function readStoredPreference(storage) {
  try {
    return storage?.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredPreference(storage, value) {
  try {
    storage?.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* private browsing and blocked storage are not console failures */
  }
}

/**
 * Mount the console over an already-loaded document.
 *
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @param {Window} [options.win]
 * @param {Storage|null} [options.storage] Preference store; null disables it.
 * @returns {{destroy: Function, activate: Function, standDown: Function}}
 */
export function mountOperationsConsole({
  documentRef = document,
  win = window,
  storage = (() => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  })(),
} = {}) {
  const root = documentRef.getElementById('gev-console');
  const restoreButton = documentRef.getElementById('gev-console-restore');
  if (!root) return { destroy() {}, activate() {}, standDown() {} };

  const element = (id) => documentRef.getElementById(id);
  const body = documentRef.body;
  const removers = [];
  const timers = [];
  const listen = (target, type, handler, options) => {
    target?.addEventListener(type, handler, options);
    removers.push(() => target?.removeEventListener(type, handler, options));
  };

  let handle = null;
  let destroyed = false;
  let enabled = readStoredPreference(storage) !== '0';
  let dossierOpen = false;
  let frames = 0;
  let framesSince = performance.now();
  const fpsHistory = [];
  let stopFrameCounter = () => {};
  const roster = { layers: [], updatedAt: 0, seeded: false };
  const eventLog = [];

  const readout = {
    lat: element('gev-console-lat'),
    lon: element('gev-console-lon'),
    elev: element('gev-console-elev'),
    hdg: element('gev-console-hdg'),
    tilt: element('gev-console-tilt'),
    grid: element('gev-console-grid'),
    fps: element('gev-console-fps'),
    graph: element('gev-console-fps-graph'),
    clock: element('gev-console-clock'),
    date: element('gev-console-date'),
    place: element('gev-console-place'),
    note: element('gev-console-status-note'),
    chips: element('gev-console-active-layers'),
    railCount: element('gev-console-rail-count'),
    feedList: element('gev-console-feed-list'),
    logList: element('gev-console-event-log'),
  };
  const chips = {
    link: element('gev-console-chip-link'),
    feeds: element('gev-console-chip-feeds'),
    analyst: element('gev-console-chip-analyst'),
  };
  const dossier = element('gev-console-dossier');
  const dossierButton = element('gev-console-dossier-btn');

  // ── Event log ────────────────────────────────────────────────────────

  function note(text, tone = '') {
    if (readout.note) {
      readout.note.textContent = text;
      readout.note.dataset.tone = tone;
    }
    recordEvent(text, tone);
  }

  function recordEvent(text, tone = '') {
    eventLog.unshift({ at: new Date(), text, tone });
    if (eventLog.length > EVENT_LOG_LIMIT) eventLog.length = EVENT_LOG_LIMIT;
    renderEventLog();
  }

  function renderEventLog() {
    const host = readout.logList;
    if (!host) return;
    host.textContent = '';
    if (!eventLog.length) {
      const empty = documentRef.createElement('p');
      empty.className = 'gc-empty';
      empty.textContent = 'NO CONSOLE ACTIVITY YET';
      host.appendChild(empty);
      return;
    }
    const fragment = documentRef.createDocumentFragment();
    for (const entry of eventLog) {
      const row = documentRef.createElement('div');
      row.className = 'gc-log-row';
      if (entry.tone) row.dataset.tone = entry.tone;
      const time = documentRef.createElement('span');
      time.className = 'gc-log-time';
      time.textContent = formatUtcTime(entry.at);
      const text = documentRef.createElement('span');
      text.className = 'gc-log-text';
      text.textContent = entry.text;
      row.appendChild(time);
      row.appendChild(text);
      fragment.appendChild(row);
    }
    host.appendChild(fragment);
  }

  // ── Telemetry ────────────────────────────────────────────────────────

  function drawFpsGraph() {
    const canvas = readout.graph;
    const context = canvas?.getContext?.('2d');
    if (!context) return;
    const { width, height } = canvas;
    context.clearRect(0, 0, width, height);
    if (fpsHistory.length < 2) return;
    const step = width / (FPS_SAMPLES - 1);
    const ceiling = 70;
    context.beginPath();
    fpsHistory.forEach((value, index) => {
      const x = index * step;
      const y =
        height - (Math.min(value, ceiling) / ceiling) * (height - 2) - 1;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.strokeStyle = 'rgba(53, 227, 255, 0.85)';
    context.lineWidth = 1.25;
    context.stroke();
    context.lineTo((fpsHistory.length - 1) * step, height);
    context.lineTo(0, height);
    context.closePath();
    context.fillStyle = 'rgba(53, 227, 255, 0.12)';
    context.fill();
  }

  function sampleFrameRate() {
    const now = performance.now();
    const elapsed = now - framesSince;
    if (elapsed <= 0) return;
    const rate = documentRef.hidden ? 0 : Math.round((frames * 1000) / elapsed);
    frames = 0;
    framesSince = now;
    fpsHistory.push(rate);
    if (fpsHistory.length > FPS_SAMPLES) fpsHistory.shift();
    // The globe renders on demand, so a second with no frame means the scene
    // is settled — reporting a flat zero would read as a stall.
    if (readout.fps) {
      readout.fps.textContent = documentRef.hidden
        ? '--'
        : rate === 0
          ? 'IDLE'
          : String(rate);
    }
    drawFpsGraph();
  }

  /** The place name the location controls already resolved, if any. */
  function currentPlaceLabel() {
    const city = element('location-mini-city')?.textContent || '';
    const match = /:\s*(.+)$/.exec(city.trim());
    const place = match?.[1]?.trim();
    return place && place !== '--' ? place : '';
  }

  function updateReadouts() {
    if (!enabled || destroyed || documentRef.hidden) return;
    const telemetry = cameraTelemetry(handle?.viewer);
    if (!telemetry) return;
    const { latitude, longitude, height, heading, pitch } = telemetry;
    if (readout.lat) readout.lat.textContent = formatLatitude(latitude);
    if (readout.lon) readout.lon.textContent = formatLongitude(longitude);
    if (readout.elev) readout.elev.textContent = formatElevation(height);
    if (readout.hdg)
      readout.hdg.textContent = `${formatBearing(heading)} ${compassPoint(heading)}`;
    if (readout.tilt) readout.tilt.textContent = formatPitch(pitch);
    if (readout.grid)
      readout.grid.textContent = gridReference(latitude, longitude);
    if (readout.place) {
      const place = currentPlaceLabel();
      readout.place.textContent = place || gridReference(latitude, longitude);
    }
  }

  function updateClock() {
    const now = new Date();
    if (readout.clock) readout.clock.textContent = formatUtcTime(now);
    if (readout.date) readout.date.textContent = formatUtcDate(now);
  }

  // ── Feeds ────────────────────────────────────────────────────────────

  function setChip(chip, state, value) {
    if (!chip) return;
    chip.dataset.state = state;
    const slot = chip.querySelector('b');
    if (slot) slot.textContent = value;
  }

  /** A layer's current lens: off, or the feed state its stats report. */
  function rosterState(layer) {
    return layer.enabled ? layerFeedState(layer.stats) : 'off';
  }

  function refreshRoster() {
    const previous = new Map(
      roster.layers.map((layer) => [layer.id, rosterState(layer)]),
    );
    roster.layers = layerRoster(handle?.dataManager);
    roster.updatedAt = Date.now();
    // The first roster is the starting position, not a set of transitions.
    if (roster.seeded) logRosterTransitions(previous);
    roster.seeded = roster.layers.length > 0;
    renderFeedList();
    renderStatusChips();
  }

  /**
   * Record what changed since the last roster.
   *
   * Feeds come and go on their own — a provider degrades, a cache goes stale,
   * a share link restores a layer — so the log follows the lifecycle rather
   * than only the actions taken here.
   */
  function logRosterTransitions(previous) {
    for (const layer of roster.layers) {
      const before = previous.get(layer.id);
      if (before === undefined) continue;
      const now = rosterState(layer);
      if (before === now) continue;
      const name = String(layer.name).toUpperCase();
      if (before === 'off' || now === 'off') {
        recordEvent(`${name} ${now === 'off' ? 'STOPPED' : 'STARTED'}`);
        continue;
      }
      const tone = FEED_TONE[now];
      recordEvent(`${name} ${now.toUpperCase()}`, tone === 'good' ? '' : tone);
    }
  }

  function renderStatusChips() {
    const active = roster.layers.filter((layer) => layer.enabled);
    setChip(
      chips.feeds,
      active.length ? 'nominal' : 'idle',
      `${active.length}/${roster.layers.length}`,
    );
    if (readout.railCount)
      readout.railCount.textContent = String(active.length);

    const host = readout.chips;
    if (!host) return;
    host.textContent = '';
    if (!active.length) {
      const idle = documentRef.createElement('span');
      idle.className = 'gc-status-idle';
      idle.textContent = 'NO ACTIVE FEEDS';
      host.appendChild(idle);
      return;
    }
    const fragment = documentRef.createDocumentFragment();
    for (const layer of active.slice(0, STATUS_CHIP_LIMIT)) {
      const state = layerFeedState(layer.stats);
      const chip = documentRef.createElement('span');
      chip.className = 'gc-status-chip';
      chip.dataset.tone = FEED_TONE[state] || 'good';
      chip.title = `${layer.name} — ${state.toUpperCase()}`;
      const label = documentRef.createElement('em');
      label.textContent = layer.name;
      const value = documentRef.createElement('b');
      value.textContent = formatCount(layer.stats?.count);
      chip.appendChild(label);
      chip.appendChild(value);
      fragment.appendChild(chip);
    }
    if (active.length > STATUS_CHIP_LIMIT) {
      const more = documentRef.createElement('span');
      more.className = 'gc-status-more';
      more.textContent = `+${active.length - STATUS_CHIP_LIMIT}`;
      fragment.appendChild(more);
    }
    host.appendChild(fragment);
  }

  function renderFeedList() {
    const host = readout.feedList;
    if (!host) return;
    host.textContent = '';
    if (!roster.layers.length) {
      const empty = documentRef.createElement('p');
      empty.className = 'gc-empty';
      empty.textContent = 'LAYER CATALOG NOT READY';
      host.appendChild(empty);
      return;
    }
    const fragment = documentRef.createDocumentFragment();
    for (const layer of roster.layers) {
      const state = layer.enabled ? layerFeedState(layer.stats) : 'off';
      const row = documentRef.createElement('div');
      row.className = 'gc-feed-row';
      row.dataset.tone = layer.enabled ? FEED_TONE[state] || 'good' : 'off';

      const toggle = documentRef.createElement('button');
      toggle.type = 'button';
      toggle.className = 'gc-feed-toggle';
      toggle.setAttribute('aria-pressed', String(layer.enabled));
      toggle.setAttribute(
        'aria-label',
        `${layer.enabled ? 'Disable' : 'Enable'} ${layer.name}`,
      );
      toggle.disabled = layer.keyRequired && !layer.enabled;
      toggle.addEventListener('click', () => {
        toggle.setAttribute('aria-busy', 'true');
        void setLayerEnabled(
          handle?.dataManager,
          layer.id,
          !layer.enabled,
        ).finally(() => toggle.removeAttribute('aria-busy'));
      });

      const name = documentRef.createElement('span');
      name.className = 'gc-feed-name';
      name.textContent = layer.name;

      const meta = documentRef.createElement('span');
      meta.className = 'gc-feed-meta';
      const age = layer.stats?.lastUpdate
        ? formatAge(Date.now() - Number(layer.stats.lastUpdate))
        : '';
      const stateLabel = layer.keyRequired
        ? 'KEY REQUIRED'
        : state.toUpperCase();
      meta.textContent = age ? `${stateLabel} · ${age}` : stateLabel;

      const count = documentRef.createElement('span');
      count.className = 'gc-feed-count';
      count.textContent = layer.enabled ? formatCount(layer.stats?.count) : '—';

      const text = documentRef.createElement('span');
      text.className = 'gc-feed-text';
      text.appendChild(name);
      text.appendChild(meta);

      row.appendChild(toggle);
      row.appendChild(text);
      row.appendChild(count);
      fragment.appendChild(row);
    }
    host.appendChild(fragment);
  }

  // ── Module rail ──────────────────────────────────────────────────────

  const railButtons = [...root.querySelectorAll('[data-console-panel]')];

  function syncRail() {
    for (const button of railButtons) {
      const panelId = button.dataset.consolePanel;
      const open = isPanelOpen(panelId, documentRef);
      const exists = Boolean(documentRef.getElementById(panelId));
      button.setAttribute('aria-pressed', String(open));
      button.classList.toggle('is-open', open);
      button.classList.toggle('is-absent', !exists);
      button.disabled = !exists;
    }
  }

  for (const button of railButtons) {
    listen(button, 'click', () => {
      const panelId = button.dataset.consolePanel;
      if (!togglePanel(panelId, documentRef)) return;
      syncRail();
      const module = CONSOLE_MODULES.find((entry) => entry.panelId === panelId);
      recordEvent(
        `${isPanelOpen(panelId, documentRef) ? 'OPENED' : 'CLOSED'} ${(module?.label || panelId).toUpperCase()}`,
      );
    });
  }

  // Panels are opened by their own controls too — keyboard shortcuts, the
  // dock, a share link restoring layout — so the rail follows the document
  // rather than assuming it is the only thing that moves them.
  const panelObserver = new MutationObserver(syncRail);
  panelObserver.observe(documentRef.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });
  removers.push(() => panelObserver.disconnect());

  // ── Dossier ──────────────────────────────────────────────────────────

  const tabs = [
    { tab: 'gev-console-tab-analyst', view: 'gev-console-view-analyst' },
    { tab: 'gev-console-tab-feeds', view: 'gev-console-view-feeds' },
    { tab: 'gev-console-tab-log', view: 'gev-console-view-log' },
  ];

  function selectTab(tabId) {
    for (const entry of tabs) {
      const tab = element(entry.tab);
      const view = element(entry.view);
      const selected = entry.tab === tabId;
      tab?.setAttribute('aria-selected', String(selected));
      if (tab) tab.tabIndex = selected ? 0 : -1;
      if (view) view.hidden = !selected;
    }
  }

  for (const [index, entry] of tabs.entries()) {
    const tab = element(entry.tab);
    listen(tab, 'click', () => selectTab(entry.tab));
    listen(tab, 'keydown', (event) => {
      const step =
        event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      const next = tabs[(index + step + tabs.length) % tabs.length];
      selectTab(next.tab);
      element(next.tab)?.focus();
    });
  }

  function setDossierOpen(open, { focusAnalyst = false } = {}) {
    dossierOpen = Boolean(open);
    if (dossier) dossier.hidden = !dossierOpen;
    dossierButton?.setAttribute('aria-expanded', String(dossierOpen));
    body?.classList.toggle('gev-console-dossier-open', dossierOpen);
    if (dossierOpen && focusAnalyst) analyst.focus();
  }

  listen(dossierButton, 'click', () =>
    setDossierOpen(!dossierOpen, { focusAnalyst: true }),
  );
  listen(element('gev-console-dossier-close'), 'click', () => {
    setDossierOpen(false);
    dossierButton?.focus();
  });

  // ── Analyst ──────────────────────────────────────────────────────────

  function analystContext() {
    const telemetry = cameraTelemetry(handle?.viewer);
    const active = roster.layers.filter((layer) => layer.enabled);
    return {
      utc: new Date().toISOString(),
      place: currentPlaceLabel() || null,
      camera: telemetry
        ? {
            latitude: Number(telemetry.latitude.toFixed(5)),
            longitude: Number(telemetry.longitude.toFixed(5)),
            altitudeMetres: Math.round(telemetry.height),
            headingDegrees: Math.round(telemetry.heading),
            pitchDegrees: Math.round(telemetry.pitch),
            grid: gridReference(telemetry.latitude, telemetry.longitude),
          }
        : null,
      visualStyle: activeStyleName(documentRef),
      activeLayers: active.map((layer) => ({
        name: layer.name,
        records: Number(layer.stats?.count) || 0,
        feedState: layerFeedState(layer.stats),
      })),
      availableLayers: roster.layers
        .filter((layer) => !layer.enabled)
        .map((layer) => layer.name),
    };
  }

  const analyst = createAnalystPanel({
    documentRef,
    collectContext: analystContext,
    onStatus: (state) => {
      const label =
        state === 'ready'
          ? 'READY'
          : state === 'busy'
            ? 'WORKING'
            : state === 'error'
              ? 'ERROR'
              : 'OFFLINE';
      setChip(
        chips.analyst,
        state === 'ready'
          ? 'nominal'
          : state === 'busy'
            ? 'loading'
            : state === 'error'
              ? 'bad'
              : 'idle',
        label,
      );
    },
  });

  // ── Palette ──────────────────────────────────────────────────────────

  function flyToPlace(placeId) {
    const pill = documentRef.querySelector(
      `.location-pill[data-location-id="${placeId}"]`,
    );
    if (pill) {
      pill.click();
      return;
    }
    if (handle?.viewer) flyToPresetLocation(handle.viewer, placeId);
  }

  const palette = createCommandPalette({
    documentRef,
    collectCommands: () =>
      buildCommands({
        layers: roster.layers,
        places: LOCATIONS,
        activeStyle: activeStyleName(documentRef),
        isPanelOpen: (panelId) => isPanelOpen(panelId, documentRef),
        actions: {
          flyToPlace,
          setLayerEnabled: (layerId, next) =>
            setLayerEnabled(handle?.dataManager, layerId, next),
          applyStyle: (styleName) =>
            applyVisualStyle(handle?.styleManager, styleName),
          togglePanel: (panelId) => {
            togglePanel(panelId, documentRef);
            syncRail();
          },
          resetGlobe: () => clickControl('#reset-globe-view', documentRef),
          northUp: () => clickControl('#north-up-view', documentRef),
          toggleTilt: () => clickControl('#tilt-map-view', documentRef),
          clearLayers: () =>
            clickControl('#clear-selected-layers', documentRef),
          share: () => clickControl('#share-btn', documentRef),
          openDossier: () => setDossierOpen(true, { focusAnalyst: true }),
          standDown,
        },
      }),
    onRun: (command) => note(command.title.toUpperCase()),
  });

  listen(element('gev-console-search-btn'), 'click', () => palette.open());

  const platformMac = /mac|iphone|ipad/i.test(
    win.navigator?.platform || win.navigator?.userAgent || '',
  );
  const searchKbd = element('gev-console-search-kbd');
  if (searchKbd) searchKbd.textContent = platformMac ? '⌘K' : 'Ctrl K';

  listen(
    documentRef,
    'keydown',
    (event) => {
      if (!enabled || destroyed) return;
      const accelerator = platformMac ? event.metaKey : event.ctrlKey;
      if (accelerator && !event.altKey && event.key?.toLowerCase() === 'k') {
        event.preventDefault();
        event.stopPropagation();
        if (palette.isOpen()) palette.close();
        else palette.open();
      }
    },
    true,
  );

  // ── Activation ───────────────────────────────────────────────────────

  function activate({ persist = true } = {}) {
    enabled = true;
    root.hidden = false;
    body?.classList.add(CONSOLE_BODY_CLASS);
    if (restoreButton) restoreButton.hidden = true;
    if (persist) writeStoredPreference(storage, true);
    syncRail();
    updateReadouts();
    updateClock();
  }

  function standDown({ persist = true } = {}) {
    enabled = false;
    palette.close();
    setDossierOpen(false);
    root.hidden = true;
    body?.classList.remove(CONSOLE_BODY_CLASS);
    if (restoreButton) restoreButton.hidden = false;
    if (persist) writeStoredPreference(storage, false);
  }

  listen(element('gev-console-exit-btn'), 'click', () => {
    standDown();
    restoreButton?.focus?.({ preventScroll: true });
  });
  listen(restoreButton, 'click', () => {
    activate();
    element('gev-console-search-btn')?.focus?.({ preventScroll: true });
  });

  // ── Wiring ───────────────────────────────────────────────────────────

  timers.push(setInterval(updateReadouts, READOUT_INTERVAL_MS));
  timers.push(setInterval(updateClock, CLOCK_INTERVAL_MS));
  timers.push(setInterval(sampleFrameRate, 1000));
  timers.push(setInterval(refreshRoster, 2000));

  updateClock();
  renderEventLog();
  renderFeedList();
  renderStatusChips();
  selectTab('gev-console-tab-analyst');
  if (enabled) activate({ persist: false });
  else standDown({ persist: false });

  const ready = whenApplicationReady({
    win,
    onReady: (resolved) => {
      handle = resolved;
      root.dataset.consoleState = 'live';
      setChip(chips.link, 'nominal', 'ONLINE');
      stopFrameCounter = onRenderedFrame(handle.viewer, () => {
        frames += 1;
      });
      removers.push(() => stopFrameCounter());
      const unsubscribe = subscribeLayers(handle.dataManager, () =>
        refreshRoster(),
      );
      removers.push(unsubscribe);
      refreshRoster();
      updateReadouts();
      syncRail();
      note('CONSOLE ONLINE');
      void analyst.probe();
    },
  });
  removers.push(() => ready.destroy());

  return {
    activate,
    standDown,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const timer of timers.splice(0)) clearInterval(timer);
      for (const remove of removers.splice(0)) remove();
      palette.destroy();
      analyst.destroy();
      body?.classList.remove(CONSOLE_BODY_CLASS);
      body?.classList.remove('gev-console-dossier-open');
    },
  };
}
