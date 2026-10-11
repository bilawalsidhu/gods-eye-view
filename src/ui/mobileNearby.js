import * as Cesium from 'cesium';
import {
  setOverlayEntries,
  clearOverlaySource,
} from '../overlays/worldOverlay.js';
import { installJerseyNearby } from './jerseyNearby.js';

// A stationary single-finger hold toggles chrome. Drags, pinches, short taps,
// controls, and interrupted touches keep their normal behavior.
export function bindMapDashboardHold({
  documentRef,
  windowRef,
  isMapTarget,
  toggle,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = Date.now,
  holdMs = 650,
  movementPx = 12,
}) {
  const pointers = new Set();
  let press = null,
    timer = null,
    lastHoldAt = -Infinity;
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    press = null;
  };
  const reset = () => {
    cancel();
    pointers.clear();
  };
  const down = (event) => {
    pointers.add(event.pointerId);
    if (pointers.size !== 1) {
      cancel();
      return;
    }
    if (
      !isMapTarget(event.target) ||
      event.isPrimary === false ||
      event.button !== 0
    )
      return;
    cancel();
    press = { id: event.pointerId, x: event.clientX, y: event.clientY };
    timer = setTimer(() => {
      timer = null;
      if (!press || pointers.size !== 1) return;
      lastHoldAt = now();
      toggle();
    }, holdMs);
  };
  const move = (event) => {
    if (
      press?.id === event.pointerId &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > movementPx
    )
      cancel();
  };
  const up = (event) => {
    pointers.delete(event.pointerId);
    if (press?.id === event.pointerId) cancel();
  };
  const click = (event) => {
    if (isMapTarget(event.target) && now() - lastHoldAt < 800) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  const menu = (event) => {
    if (isMapTarget(event.target) && (press || now() - lastHoldAt < 1000))
      event.preventDefault();
  };
  const visibility = () => {
    if (documentRef.hidden) reset();
  };
  const listeners = [
    [documentRef, 'pointerdown', down],
    [documentRef, 'pointermove', move],
    [documentRef, 'pointerup', up],
    [documentRef, 'pointercancel', up],
    [documentRef, 'click', click],
    [documentRef, 'contextmenu', menu],
    [documentRef, 'visibilitychange', visibility],
    [windowRef, 'blur', reset],
    [windowRef, 'pagehide', reset],
  ];
  for (const [target, type, listener] of listeners)
    target.addEventListener(type, listener, { capture: true });
  return () => {
    reset();
    for (const [target, type, listener] of listeners)
      target.removeEventListener(type, listener, { capture: true });
  };
}

function installDashboardHold() {
  if (document.getElementById('gev-dashboard-hold-style')) return;
  const style = document.createElement('style');
  style.id = 'gev-dashboard-hold-style';
  style.textContent = `
    #cesiumContainer canvas { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
    body.ui-clean-view :is(#left-panel-stack, #right-context-rail, #gev-voice-control, #cockpit-hud, #intel-hud, #street-level-panel) {
      visibility: hidden !important; opacity: 0 !important; pointer-events: none !important;
    }
    #clean-view-exit { top: max(12px, env(safe-area-inset-top)); min-height: 44px; letter-spacing: 1px; }
    #gev-dashboard-hold-notice {
      position: fixed; bottom: max(24px, env(safe-area-inset-bottom)); left: 50%; transform: translateX(-50%);
      z-index: 301; max-width: calc(100vw - 32px); width: max-content; padding: 10px 14px;
      border-radius: 18px; background: #081820e8; color: #d0efef; font: 12px system-ui;
      text-align: center; pointer-events: none;
    }
    #gev-dashboard-hold-notice[hidden] { display: none; }
  `;
  document.head.append(style);
  const exit = document.getElementById('clean-view-exit');
  if (exit) {
    exit.textContent = 'SHOW DASHBOARDS';
    exit.title = 'Show dashboards, or hold on the map';
  }
  const notice = document.createElement('div');
  notice.id = 'gev-dashboard-hold-notice';
  notice.hidden = true;
  notice.setAttribute('role', 'status');
  document.body.append(notice);
  let noticeTimer;
  bindMapDashboardHold({
    documentRef: document,
    windowRef: window,
    isMapTarget: (target) =>
      target?.matches?.('#cesiumContainer canvas') === true,
    toggle: () => {
      document.getElementById('clean-view-toggle')?.click();
      const hidden = document.body.classList.contains('ui-clean-view');
      notice.textContent = hidden
        ? 'Dashboards hidden · Hold map to show'
        : 'Dashboards shown · Hold map to hide';
      notice.hidden = false;
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => {
        notice.hidden = true;
      }, 1800);
    },
  });
}

function installPhoneLayout() {
  if (document.getElementById('gev-mobile-nav')) return;
  const panels = {
    'cctv-panel': 'Cameras',
    'location-bar': 'Search',
    'data-panel': 'Layers',
    'control-panel': 'Map style',
    'pp-toggles': 'Display',
    'scene-panel': 'Scenes',
    'global-context-panel': 'Context',
    'street-level-panel': 'Street view',
    'gev-mobile-more': 'More controls',
    'gev-mobile-nearby': 'Around you',
  };
  const style = document.createElement('style');
  style.textContent = `
    #gev-mobile-nav, #gev-mobile-more, #gev-mobile-nearby, .gev-mobile-sheet-heading { display: none; }
    @media (max-width: 720px) {
      body.gev-mobile-ui { --gev-mobile-dock: calc(64px + env(safe-area-inset-bottom)); }
      body.gev-mobile-ui :is(#left-panel-stack, #right-context-rail, #command-dock) {
        display: contents !important; transform: none !important;
      }
      body.gev-mobile-ui :is(#title-bar, #style-indicator, #top-center-actions, #global-loading-status,
        #traffic-sync-chip, #cctv-sync-chip, #gev-voice-control, #cockpit-hud, #intel-hud,
        #gev-browse-jersey, #radio-panel, #weather-panel, #recent-imagery-panel) { display: none !important; }
      body.gev-mobile-ui [data-gev-mobile-panel] { display: none !important; }
      body.gev-mobile-ui [data-gev-mobile-panel][data-gev-mobile-open] {
        display: block !important; position: fixed !important; box-sizing: border-box !important;
        top: auto !important; bottom: calc(var(--gev-mobile-dock) + var(--gev-mobile-keyboard, 0px)) !important;
        left: 8px !important; right: 8px !important; width: auto !important; min-width: 0 !important;
        max-width: none !important; height: auto !important; min-height: 0 !important;
        max-height: min(66dvh, calc(100dvh - var(--gev-mobile-dock) - 24px)) !important;
        margin: 0 !important; padding: 0 12px 12px !important; overflow: auto !important;
        transform: none !important; opacity: 1 !important; visibility: visible !important;
        pointer-events: auto !important; z-index: 260 !important;
        border: 1px solid #396270 !important; border-radius: 18px !important;
        background: #081820f5 !important; box-shadow: 0 -6px 28px #0005 !important;
        -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
      }
      body.gev-mobile-ui [data-gev-mobile-panel] :is(.panel-glow, .panel-header, .pp-header-row,
        .location-toolbar, .dock-pin-btn, .panel-mini-status, .location-mini-status) { display: none !important; }
      body.gev-mobile-ui [data-gev-mobile-panel] > .gev-mobile-sheet-heading {
        display: flex !important; align-items: center; justify-content: space-between; gap: 8px;
        position: sticky; top: 0; z-index: 5; padding: 8px 0; background: #081820;
        color: #e1f6f8; font: 600 17px system-ui;
      }
      body.gev-mobile-ui [data-gev-mobile-panel] :is(.panel-inner, .data-panel-inner, .cctv-panel-inner,
        .street-level-panel-inner, .location-inner, .cyber-panel-body, .pp-panel-body, .dock-popover-content) {
        position: static !important; transform: none !important; width: 100% !important;
        box-sizing: border-box !important; max-height: none !important; height: auto !important;
        min-height: 0 !important; overflow: visible !important; padding: 0 !important;
        background: transparent !important; border: 0 !important; box-shadow: none !important;
        visibility: visible !important; opacity: 1 !important;
      }
      body.gev-mobile-ui [data-gev-mobile-open] :is(.pp-panel-body, .cyber-panel-body, .dock-popover-content, #sl-body) { display: block !important; }
      body.gev-mobile-ui [data-gev-mobile-panel] :is(button, select, input:not([type=range])) {
        min-height: 44px !important; font-size: 16px !important; letter-spacing: normal !important;
      }
      body.gev-mobile-ui [data-gev-mobile-panel] select { max-width: 100% !important; }
      body.gev-mobile-ui [data-gev-mobile-panel] :is(.data-toggle-list, .pp-toggle-group, .button-grid) {
        width: 100% !important; max-height: none !important;
      }
      body.gev-mobile-ui #cctv-frame-wrap { width: 100% !important; aspect-ratio: 16 / 9; max-height: 25dvh !important; }
      body.gev-mobile-ui #cctv-meta { font: 12px/1.4 system-ui; max-height: 2.8em; overflow: hidden; margin: 8px 0; }
      body.gev-mobile-ui #cctv-source-badge { font-size: 12px; }
      body.gev-mobile-ui #cctv-panel .cctv-controls { flex-wrap: wrap !important; gap: 8px !important; }
      body.gev-mobile-ui #gev-camera-picker { order: -1; flex: 1 0 100% !important; width: 100% !important; padding: 8px; }
      body.gev-mobile-ui #cctv-panel :is(#cctv-prev-btn, #cctv-next-btn) { flex: 1; }
      body.gev-mobile-ui:not(.gev-mobile-camera-advanced) #cctv-panel :is(.cctv-calibration-block,
        .cctv-summary-label, #cctv-summary, #cctv-focus-btn, #cctv-coverage-btn, #cctv-auto-hop-btn,
        #cctv-projection-btn, #cctv-quality-chip, #cctv-nearest-btn) { display: none !important; }
      body.gev-mobile-ui #location-bar :is(#poi-row, #location-bar-divider, #location-pills, #search-toggle) { display: none !important; }
      body.gev-mobile-ui #location-bar :is(.location-city-row, .location-search-wrap) { display: block !important; width: 100% !important; }
      body.gev-mobile-ui #location-search { display: block !important; width: 100% !important; max-width: none !important;
        opacity: 1 !important; padding: 12px !important; box-sizing: border-box; }
      body.gev-mobile-ui #gev-mobile-nav {
        position: fixed; bottom: var(--gev-mobile-keyboard, 0px); left: 0; right: 0; z-index: 280;
        display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px;
        padding: 8px 8px calc(8px + env(safe-area-inset-bottom)); background: #081820ee;
        border-top: 1px solid #396270; pointer-events: auto;
      }
      #gev-mobile-nav button, #gev-mobile-more button, .gev-mobile-sheet-heading button {
        min-height: 44px; border: 1px solid #365768; border-radius: 12px; background: #142b37;
        color: #d9f2f5; font: 15px system-ui; padding: 8px 12px; cursor: pointer;
      }
      #gev-mobile-nav button[aria-pressed=true] { background: #205362; border-color: #72d5dc; color: white; }
      #gev-mobile-more .gev-mobile-menu { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      #gev-mobile-nearby { color: #d9f2f5; font: 15px/1.5 system-ui; }
      #gev-mobile-nearby .gev-nearby-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
      #gev-mobile-nearby button { background: #142b37; color: #d9f2f5; border: 1px solid #396270; border-radius: 10px; padding: 8px 12px; }
      #gev-mobile-nearby .gev-nearby-layer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 8px 0; padding: 8px 0; border-bottom: 1px solid #396270; }
      #gev-mobile-nearby .gev-nearby-layer button { min-width: 70px; }
      #gev-mobile-nearby button[aria-pressed=true] { background: #205362; border-color: #72d5dc; }
      #gev-mobile-nearby small { display: block; font-size: 12px; color: #adc9d0; }
      #gev-mobile-nearby a { color: #8ae7ed; }
      body.gev-mobile-ui #cesium-credits { bottom: calc(var(--gev-mobile-dock) + 4px) !important; font-size: 9px !important; }
      body.gev-mobile-ui #gev-dashboard-hold-notice { bottom: calc(var(--gev-mobile-dock) + 12px); }
      body.gev-mobile-ui.ui-clean-view :is(#gev-mobile-nav, [data-gev-mobile-open]) { display: none !important; }
    }
  `;
  document.head.append(style);
  const nav = document.createElement('nav');
  nav.id = 'gev-mobile-nav';
  nav.setAttribute('aria-label', 'Phone controls');
  const more = document.createElement('section');
  more.id = 'gev-mobile-more';
  const nearby = document.createElement('section');
  nearby.id = 'gev-mobile-nearby';
  const menu = document.createElement('div');
  menu.className = 'gev-mobile-menu';
  more.append(menu);
  document.body.append(more, nearby, nav);
  let current = null;
  const open = (id) => {
    for (const panel of document.querySelectorAll('[data-gev-mobile-panel]'))
      panel.removeAttribute('data-gev-mobile-open');
    current = id;
    const panel = id && document.getElementById(id);
    if (panel) {
      if (document.body.classList.contains('ui-clean-view'))
        document.getElementById('clean-view-exit')?.click();
      if (panel.classList.contains('collapsed')) {
        (
          panel.querySelector(`[data-collapse-target="${id}"]`) ||
          panel.querySelector('[data-dock-toggle-target]')
        )?.click();
      }
      panel.setAttribute('data-gev-mobile-open', '');
      panel.scrollTop = 0;
    }
    for (const button of nav.children)
      button.setAttribute(
        'aria-pressed',
        String(button.dataset.panel === (id || 'map')),
      );
  };
  for (const [id, title] of Object.entries(panels)) {
    const panel = document.getElementById(id);
    if (!panel) continue;
    panel.dataset.gevMobilePanel = id;
    const heading = document.createElement('div');
    heading.className = 'gev-mobile-sheet-heading';
    const label = document.createElement('span');
    label.textContent = title;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.style.minWidth = '44px';
    close.setAttribute('aria-label', `Close ${title}`);
    close.addEventListener('click', () => open(null));
    heading.append(label, close);
    panel.prepend(heading);
  }
  for (const [label, id] of [
    ['Map', 'map'],
    ['Nearby', 'gev-mobile-nearby'],
    ['Location', 'location-bar'],
    ['More', 'gev-mobile-more'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.panel = id;
    button.addEventListener('click', () => {
      if (id === 'map' || current === id) {
        open(null);
        return;
      }
      document.body.classList.remove('gev-mobile-camera-advanced');
      open(id);
      if (id === 'cctv-panel')
        document.getElementById('gev-browse-jersey')?.click();
      if (id === 'location-bar') {
        const input = document.getElementById('location-search');
        input?.classList.add('expanded');
        input?.focus();
      }
    });
    nav.append(button);
  }
  for (const [id, title] of Object.entries(panels)) {
    if (['location-bar', 'gev-mobile-more', 'gev-mobile-nearby'].includes(id))
      continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = title;
    button.addEventListener('click', () => {
      open(id);
      if (id === 'cctv-panel')
        document.getElementById('gev-browse-jersey')?.click();
    });
    menu.append(button);
  }
  const advanced = document.createElement('button');
  advanced.type = 'button';
  advanced.textContent = 'Camera options';
  advanced.addEventListener('click', () => {
    document.body.classList.add('gev-mobile-camera-advanced');
    open('cctv-panel');
  });
  menu.append(advanced);
  const phone = matchMedia('(max-width: 720px)');
  const resize = () => {
    document.body.classList.toggle('gev-mobile-ui', phone.matches);
    if (!phone.matches) open(null);
  };
  phone.addEventListener('change', resize);
  resize();
  open(null);
  const keyboard = () =>
    document.body.style.setProperty(
      '--gev-mobile-keyboard',
      `${Math.max(0, innerHeight - (window.visualViewport?.height || innerHeight) - (window.visualViewport?.offsetTop || 0))}px`,
    );
  window.visualViewport?.addEventListener('resize', keyboard);
  window.visualViewport?.addEventListener('scroll', keyboard);
  keyboard();
  installNearbyExperience(nearby, open, phone);
}

export function nearbyDistance(a, b) {
  const rad = Math.PI / 180,
    dlat = (b.lat - a.lat) * rad,
    dlon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dlon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function installNearbyExperience(panel, open, phone) {
  const status = document.createElement('p');
  status.textContent =
    'Use your location to see what is nearby, or choose a place.';
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.className = 'gev-nearby-actions';
  const locate = document.createElement('button');
  locate.type = 'button';
  locate.textContent = 'Use my location';
  locate.disabled = true;
  const change = document.createElement('button');
  change.type = 'button';
  change.textContent = 'Change location';
  const radius = document.createElement('select');
  radius.setAttribute('aria-label', 'Nearby radius');
  for (const km of [2, 5, 10, 50])
    radius.add(
      new Option(`Within ${km} km`, String(km * 1000), km === 5, km === 5),
    );
  actions.append(locate, change, radius);
  panel.append(status, actions);
  const transportRow = document.createElement('div');
  transportRow.className = 'gev-nearby-layer';
  const transportText = document.createElement('div');
  transportText.textContent = 'Transport';
  const transportStatus = document.createElement('small');
  transportStatus.textContent = 'Live buses and bus stops';
  transportText.append(transportStatus);
  const transport = document.createElement('button');
  transport.type = 'button';
  transport.textContent = 'OFF';
  transport.disabled = true;
  transport.setAttribute('aria-label', 'Transport');
  transport.setAttribute('aria-pressed', 'false');
  transportRow.append(transportText, transport);
  panel.append(transportRow);
  const global = document.createElement('details');
  const globalTitle = document.createElement('summary');
  globalTitle.textContent = 'Global layers & cameras';
  globalTitle.style.cssText = 'padding:14px 0;cursor:pointer';
  const layers = document.createElement('div');
  global.append(globalTitle, layers);
  panel.append(global);
  const attribution = document.createElement('a');
  attribution.href = 'https://opendata.je/docs/endpoints/buses/updates/';
  attribution.textContent = 'Jersey bus data · positions refresh every minute';
  attribution.target = '_blank';
  attribution.rel = 'noopener';
  panel.append(attribution);
  let jerseyPack;
  let anchor = null,
    mode = 'map',
    enabled = false,
    generation = 0,
    locationGeneration = 0,
    busy = false,
    userDot,
    app,
    source,
    busData = [],
    stopData = [],
    lastReceived = 0;
  const draw = () => {
    if (!source || !anchor) return;
    source.entities.removeAll();
    clearOverlaySource('jersey-nearby-transport');
    if (!enabled) {
      app.requestRender?.('nearby-transport');
      return;
    }
    const C = Cesium,
      max = Number(radius.value),
      age = (Date.now() - lastReceived) / 1000;
    const validBuses = busData.filter(
      (row) =>
        nearbyDistance(anchor, { lat: row.latitude, lon: row.longitude }) <=
          max && row.secondsAgo + age <= 300,
    );
    const validStops = stopData.filter(
      (row) =>
        nearbyDistance(anchor, { lat: row.latitude, lon: row.longitude }) <=
        Math.min(max, 2000),
    );
    for (const row of validBuses)
      source.entities.add({
        id: 'bus-' + row.deviceId,
        name: `Bus ${row.serviceNumber} · ${row.direction}`,
        position: C.Cartesian3.fromDegrees(row.longitude, row.latitude, 4),
        point: {
          pixelSize: 15,
          color: row.secondsAgo + age > 180 ? C.Color.GRAY : C.Color.ORANGE,
          outlineColor: C.Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Infinity,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
        },
        description: `${row.serviceOperator} · ${row.direction}. Position reported ${Math.round(row.secondsAgo + age)} seconds ago.`,
      });
    for (const row of validStops) {
      const entity = source.entities.add({
        id: 'stop-' + row.id,
        name: `${row.name} · stop ${row.stopNumber}`,
        position: C.Cartesian3.fromDegrees(row.longitude, row.latitude, 2),
        point: {
          pixelSize: 7,
          color: C.Color.CYAN,
          outlineColor: C.Color.BLACK,
          outlineWidth: 1,
          disableDepthTestDistance: Infinity,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
        },
      });
      entity._gevJerseyStop = row.stopNumber;
    }
    setOverlayEntries(
      'jersey-nearby-transport',
      [
        ...validBuses.slice(0, 60).map((row) => ({
          id: 'bus-' + row.deviceId,
          position: C.Cartesian3.fromDegrees(row.longitude, row.latitude, 5),
          title: 'Bus ' + row.serviceNumber,
          variant: 'label',
          accent: '#ffad55',
          priority: 100,
          collisionGroup: 'ambient-label',
          maxDistance: 30000,
        })),
        ...validStops.slice(0, 68).map((row) => ({
          id: 'stop-' + row.id,
          position: C.Cartesian3.fromDegrees(row.longitude, row.latitude, 3),
          title: row.name,
          variant: 'label',
          accent: '#80dce7',
          priority: 10,
          collisionGroup: 'ambient-label',
          maxDistance: 1500,
        })),
      ],
      { cohortLimit: 128, collisionCapacity: 24, moving: false },
    );
    transportStatus.textContent = `${validBuses.length} buses within ${max / 1000} km · ${validStops.length} nearby stops${age > 90 ? ' · waiting for fresh data' : ''}`;
    app.requestRender?.('nearby-transport');
  };
  const center = () => {
    if (!app?.viewer) return null;
    const viewer = app.viewer,
      C = Cesium,
      canvas = viewer.canvas;
    const point = viewer.camera.pickEllipsoid(
      new C.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      viewer.scene.globe.ellipsoid,
    );
    if (!point) return null;
    const position = C.Cartographic.fromCartesian(point);
    return {
      lat: C.Math.toDegrees(position.latitude),
      lon: C.Math.toDegrees(position.longitude),
    };
  };
  const setAnchor = (point, fly = false) => {
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon))
      return;
    anchor = point;
    status.textContent = `${mode === 'gps' ? 'Your location' : 'Chosen area'} · ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`;
    if (userDot) app.viewer.entities.remove(userDot);
    const C = Cesium;
    if (mode === 'gps')
      userDot = app.viewer.entities.add({
        name: 'Your location',
        position: C.Cartesian3.fromDegrees(point.lon, point.lat, 5),
        point: {
          pixelSize: 13,
          color: C.Color.DODGERBLUE,
          outlineColor: C.Color.WHITE,
          outlineWidth: 3,
          heightReference: C.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Infinity,
        },
      });
    if (fly) {
      const navigate = () =>
        app.viewer.camera.flyTo({
          destination: C.Cartesian3.fromDegrees(point.lon, point.lat, 1200),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          duration: 1.2,
        });
      if (app.styleManager?._runExplicitNavigation)
        app.styleManager._runExplicitNavigation('phone location', navigate);
      else navigate();
    }
    draw();
    jerseyPack?.update();
    app.requestRender?.('nearby-location');
  };
  const gps = () => {
    open('gev-mobile-nearby');
    if (!navigator.geolocation) {
      status.textContent = 'Location is unavailable. Choose a place instead.';
      return;
    }
    const token = ++locationGeneration;
    locate.disabled = true;
    status.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (token !== locationGeneration) return;
        locate.disabled = false;
        mode = 'gps';
        setAnchor(
          { lat: position.coords.latitude, lon: position.coords.longitude },
          true,
        );
      },
      (error) => {
        if (token !== locationGeneration) return;
        locate.disabled = false;
        status.textContent =
          error.code === 1
            ? 'Location permission is off. Allow it in Safari, or choose a place.'
            : 'Could not find your location. Try again or choose a place.';
      },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 },
    );
  };
  const refreshTransport = async () => {
    if (!enabled || busy || document.hidden || !anchor) return;
    if (
      anchor.lat < 49.1 ||
      anchor.lat > 49.3 ||
      anchor.lon < -2.3 ||
      anchor.lon > -2.0
    ) {
      source?.entities.removeAll();
      clearOverlaySource('jersey-nearby-transport');
      transportStatus.textContent =
        'Jersey live buses are outside this area. Use the Transit layer below for other supported regions.';
      return;
    }
    busy = true;
    const token = generation;
    try {
      const [buses, stops] = await Promise.all([
        fetch('/api/transit/jersey-local?type=buses', {
          signal: AbortSignal.timeout(15000),
        }),
        stopData.length
          ? null
          : fetch('/api/transit/jersey-local?type=stops', {
              signal: AbortSignal.timeout(15000),
            }),
      ]);
      if (!buses.ok || (stops && !stops.ok)) throw new Error('Unavailable');
      const busBody = await buses.json(),
        stopBody = stops && (await stops.json());
      if (token !== generation || !enabled) return;
      busData = busBody.results;
      if (stopBody) stopData = stopBody.results;
      lastReceived = busBody.fetchedAt;
      draw();
    } catch {
      if (token === generation) {
        draw();
        transportStatus.textContent =
          'Live bus feed unavailable. Old positions expire after 5 minutes; retrying shortly.';
      }
    } finally {
      busy = false;
      if (enabled && token !== generation) refreshTransport();
    }
  };
  locate.addEventListener('click', gps);
  change.addEventListener('click', () => {
    locationGeneration++;
    locate.disabled = false;
    mode = 'map';
    open('location-bar');
    const input = document.getElementById('location-search');
    input.classList.add('expanded');
    input.focus();
  });
  radius.addEventListener('change', () => {
    draw();
    refreshTransport();
    jerseyPack?.update();
  });
  transport.addEventListener('click', () => {
    enabled = !enabled;
    generation++;
    transport.textContent = enabled ? 'ON' : 'OFF';
    transport.setAttribute('aria-pressed', String(enabled));
    if (!anchor) setAnchor(center());
    draw();
    if (enabled) {
      transportStatus.textContent = 'Loading nearby buses…';
      refreshTransport();
    }
  });
  const ready = () => {
    app = window.__godsEyeView;
    if (!app?.dataManager || !app.viewer) return false;
    source = new Cesium.CustomDataSource('Jersey live transport');
    app.viewer.dataSources.add(source);
    (
      app.viewer.cesiumWidget.creditDisplay ||
      app.viewer.scene.frameState?.creditDisplay
    )?.addStaticCredit(
      new Cesium.Credit(
        'Bus data: <a href="https://opendata.je/">Jersey Open Data / LibertyBus</a>',
        true,
      ),
    );
    locate.disabled = false;
    transport.disabled = false;
    setAnchor(center());
    jerseyPack = installJerseyNearby({
      panel,
      before: global,
      app,
      getArea: () => ({ anchor, radius: Number(radius.value) }),
      setLocation: (point, metres) => {
        locationGeneration++;
        locate.disabled = false;
        mode = 'map';
        radius.value = String(metres);
        setAnchor(point, true);
        refreshTransport();
      },
      open,
    });
    const all = app.dataManager
      .getAll()
      .filter((layer) => layer.showInTogglePanel !== false);
    const syncLayers = [];
    for (const layer of all) {
      const row = document.createElement('div');
      row.className = 'gev-nearby-layer';
      const label = document.createElement('div');
      label.textContent = layer.name || layer.id;
      const note = document.createElement('small');
      note.textContent = 'Coverage depends on the chosen area';
      label.append(note);
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', layer.name || layer.id);
      const sync = () => {
        const state = app.dataManager
          .getAll()
          .find((item) => item.id === layer.id);
        button.textContent = state?.enabled ? 'ON' : 'OFF';
        button.setAttribute('aria-pressed', String(!!state?.enabled));
      };
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const state = app.dataManager
            .getAll()
            .find((item) => item.id === layer.id);
          await app.dataManager.setEnabled(layer.id, !state?.enabled, {
            origin: 'user',
          });
        } catch {
          note.textContent = 'Could not enable this layer';
        } finally {
          button.disabled = false;
          sync();
        }
      });
      sync();
      row.append(label, button);
      layers.append(row);
      syncLayers.push(sync);
    }
    setInterval(() => {
      if (!document.hidden && panel.hasAttribute('data-gev-mobile-open'))
        for (const sync of syncLayers) sync();
    }, 2000);
    document
      .querySelector('#gev-mobile-nav [data-panel="gev-mobile-nearby"]')
      ?.addEventListener('click', () => {
        if (mode !== 'gps') setAnchor(center());
        refreshTransport();
      });
    document
      .getElementById('location-search')
      ?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          locationGeneration++;
          locate.disabled = false;
          mode = 'map';
        }
      });
    app.viewer.camera.moveEnd.addEventListener(() => {
      if (mode === 'map') {
        setAnchor(center());
        refreshTransport();
      }
    });
    setInterval(() => {
      draw();
      refreshTransport();
    }, 60000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && phone.matches) {
        if (mode === 'gps') gps();
        else refreshTransport();
      }
    });
    if (phone.matches) {
      open('gev-mobile-nearby');
      if (navigator.maxTouchPoints > 0) gps();
    }
    return true;
  };
  if (!ready()) {
    const timer = setInterval(() => {
      if (ready()) clearInterval(timer);
    }, 500);
  }
}

/** Install compact phone controls after the standalone app has started. */
export function installMobileNearby() {
  if (
    !window.__godsEyeView?.viewer ||
    new URLSearchParams(location.search).get('embed') === '1'
  )
    return;
  installDashboardHold();
  installPhoneLayout();
}
