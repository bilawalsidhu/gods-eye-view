import * as Cesium from 'cesium';
import { horizonOccluder } from '../data/iconOrientation.js';
import { t } from '../i18n/index.js';

function isQuebecCamera(camera) {
  return String(camera?.sourceKind || '').startsWith('quebec-');
}

function safeSourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}

function safeMediaUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.quebec511.info' ||
      url.username ||
      url.password ||
      url.pathname !== '/Carte/Fenetres/camera.ashx' ||
      url.searchParams.get('format') !== 'mp4' ||
      !/^\d+$/.test(url.searchParams.get('id') || '')
    )
      return '';
    return url.href;
  } catch {
    return '';
  }
}

function setMedia(video, url) {
  const current = video.currentSrc || video.src;
  if (current === url) return;
  video.pause();
  video.removeAttribute('src');
  if (!url) {
    video.load();
    return;
  }
  video.src = url;
  video.load();
}

function mediaRefreshUrl(value) {
  const url = new URL(value);
  url.searchParams.set('_', String(Date.now()));
  return url.href;
}

/** Attach the active Québec source to a floating browser player and map preview. */
export function createQuebecCctvOverlay(viewer) {
  if (!viewer?.scene || typeof document === 'undefined') return null;

  const controller = new AbortController();
  const { signal } = controller;
  const panel = document.createElement('section');
  panel.className = 'qci-panel';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('CCTV camera'));

  const header = document.createElement('header');
  header.className = 'qci-header';
  const title = document.createElement('strong');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', t('Close camera preview'));
  header.append(title, close);

  const coordinates = document.createElement('p');
  coordinates.className = 'qci-coordinates';
  const credit = document.createElement('p');
  credit.className = 'qci-credit';
  const live = document.createElement('video');
  live.className = 'qci-live';
  live.controls = true;
  live.muted = true;
  live.autoplay = true;
  live.loop = true;
  live.playsInline = true;
  live.setAttribute('aria-label', t('CCTV camera'));

  const actions = document.createElement('div');
  actions.className = 'qci-actions';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = t('Refresh map still');
  actions.append(refresh);
  const note = document.createElement('p');
  note.className = 'qci-note';
  const sourceLink = document.createElement('a');
  sourceLink.target = '_blank';
  sourceLink.rel = 'noopener noreferrer';
  sourceLink.textContent = t("Open this image on the provider's site");
  panel.append(header, coordinates, credit, live, actions, note, sourceLink);

  const marker = document.createElement('div');
  marker.className = 'qci-marker';
  marker.hidden = true;
  const still = document.createElement('video');
  still.className = 'qci-marker-still';
  still.muted = true;
  still.playsInline = true;
  still.preload = 'auto';
  still.setAttribute('aria-hidden', 'true');
  const markerLabel = document.createElement('span');
  markerLabel.className = 'qci-marker-label';
  marker.append(still, markerLabel);
  document.body.append(panel, marker);

  let selected = null;
  let selectedPosition = null;
  let closedWindowCameraId = null;
  let selectedMediaUrl = '';
  let mediaRefreshTimer = 0;
  let liveUnavailable = false;
  let stillUnavailable = false;

  function markerLabelText(camera, hasMedia) {
    return hasMedia
      ? `${t('PREVIEW')} · ${camera.positionSource || camera.name}`
      : Number.isFinite(camera.accuracyM) && camera.accuracyM > 0
        ? `${camera.name} · ±${Math.round(camera.accuracyM)} m`
        : camera.name;
  }

  function markLiveUnavailable() {
    liveUnavailable = true;
    note.textContent = t('Source unavailable');
    note.hidden = false;
  }

  function markStillUnavailable() {
    stillUnavailable = true;
    markerLabel.textContent = t('Source unavailable');
  }

  function stopMediaRefresh() {
    clearInterval(mediaRefreshTimer);
    mediaRefreshTimer = 0;
  }

  function startMediaRefresh() {
    stopMediaRefresh();
    if (!selectedMediaUrl) return;
    mediaRefreshTimer = window.setInterval(
      () => {
        if (document.hidden || closedWindowCameraId === selected?.id) return;
        setMedia(live, mediaRefreshUrl(selectedMediaUrl));
        void live.play().catch(markLiveUnavailable);
        refreshStill();
      },
      2 * 60 * 1000,
    );
  }

  function refreshStill() {
    if (!selectedMediaUrl) return;
    setMedia(still, '');
    setMedia(still, mediaRefreshUrl(selectedMediaUrl));
    void still.play().catch(markStillUnavailable);
  }

  function setCamera(camera, { reselected = false } = {}) {
    if (!isQuebecCamera(camera)) {
      selected = null;
      selectedPosition = null;
      closedWindowCameraId = null;
      selectedMediaUrl = '';
      liveUnavailable = false;
      stillUnavailable = false;
      stopMediaRefresh();
      panel.hidden = true;
      marker.hidden = true;
      setMedia(live, '');
      setMedia(still, '');
      return;
    }

    const changed = selected?.id !== camera.id;
    if (changed || reselected) closedWindowCameraId = null;
    selected = camera;
    selectedPosition = Cesium.Cartesian3.fromDegrees(
      Number(camera.lon),
      Number(camera.lat),
      Number(camera.elevationM) || 10,
    );
    if (closedWindowCameraId === camera.id && !reselected) {
      panel.hidden = true;
      updateMarker();
      return;
    }

    const mediaUrl = safeMediaUrl(camera.browserMediaUrl);
    const sourceUrl = safeSourceUrl(camera.sourceUrl);
    if (changed || mediaUrl !== selectedMediaUrl) {
      liveUnavailable = false;
      stillUnavailable = false;
    }
    title.textContent = camera.name || t('CCTV camera');
    coordinates.textContent = [
      `${Number(camera.lat).toFixed(5)}, ${Number(camera.lon).toFixed(5)}`,
      Number.isFinite(camera.accuracyM) && camera.accuracyM > 0
        ? `±${Math.round(camera.accuracyM)} m`
        : '',
      camera.positionSource || '',
    ]
      .filter(Boolean)
      .join(' · ');
    credit.textContent = camera.credit || camera.provider || '';
    credit.hidden = !credit.textContent;
    live.hidden = !mediaUrl;
    refresh.hidden = !mediaUrl;
    actions.hidden = !mediaUrl;
    note.hidden = !mediaUrl;
    note.textContent = mediaUrl
      ? liveUnavailable
        ? t('Source unavailable')
        : t(
            'The map still uses a separate request and may show a different moment.',
          )
      : sourceUrl
        ? ''
        : t('Source unavailable');
    note.hidden = !note.textContent;
    sourceLink.href = sourceUrl || '#';
    sourceLink.hidden = !sourceUrl;
    markerLabel.textContent = stillUnavailable
      ? t('Source unavailable')
      : markerLabelText(camera, mediaUrl);
    marker.classList.toggle('qci-marker-link-only', !mediaUrl);
    still.hidden = !mediaUrl;
    panel.hidden = false;

    if (changed || mediaUrl !== selectedMediaUrl) {
      selectedMediaUrl = mediaUrl;
      setMedia(live, mediaUrl);
      setMedia(still, mediaUrl);
      if (mediaUrl) {
        void live.play().catch(markLiveUnavailable);
        void still.play().catch(markStillUnavailable);
        startMediaRefresh();
      } else {
        stopMediaRefresh();
      }
    } else if (reselected && mediaUrl) {
      if (live.error || live.networkState === 3 || live.readyState < 2) {
        setMedia(live, mediaRefreshUrl(mediaUrl));
      }
      if (live.paused) void live.play().catch(markLiveUnavailable);
      startMediaRefresh();
      if (still.error || still.networkState === 3 || still.readyState < 2)
        refreshStill();
    }
    updateMarker();
  }

  function updateMarker() {
    if (!selected || !selectedPosition) {
      marker.hidden = true;
      return;
    }
    const canvas = viewer.scene.canvas;
    const point = viewer.scene.cartesianToCanvasCoordinates(selectedPosition);
    const visible =
      point &&
      horizonOccluder(viewer.camera).isPointVisible(selectedPosition) &&
      point.x >= 0 &&
      point.y >= 0 &&
      point.x <= canvas.clientWidth &&
      point.y <= canvas.clientHeight;
    marker.hidden = !visible;
    if (!visible) return;
    const rect = canvas.getBoundingClientRect();
    marker.style.left = `${rect.left + point.x}px`;
    marker.style.top = `${rect.top + point.y}px`;
    const distance = Cesium.Cartesian3.distance(
      viewer.camera.positionWC,
      selectedPosition,
    );
    marker.style.setProperty(
      '--qci-scale',
      String(Math.min(1, 600 / Math.max(1, distance))),
    );
  }

  still.addEventListener(
    'loadeddata',
    () => {
      stillUnavailable = false;
      if (selected)
        markerLabel.textContent = markerLabelText(
          selected,
          Boolean(selectedMediaUrl),
        );
      still.pause();
    },
    { signal },
  );
  still.addEventListener('error', markStillUnavailable, { signal });
  live.addEventListener('error', markLiveUnavailable, { signal });
  live.addEventListener(
    'loadeddata',
    () => {
      liveUnavailable = false;
      note.textContent = t(
        'The map still uses a separate request and may show a different moment.',
      );
      note.hidden = false;
    },
    { signal },
  );
  refresh.addEventListener('click', refreshStill, { signal });
  close.addEventListener(
    'click',
    () => {
      closedWindowCameraId = selected?.id || null;
      panel.hidden = true;
      live.pause();
      stopMediaRefresh();
      // The floating player closes independently; keep the paused map still.
      updateMarker();
    },
    { signal },
  );
  header.addEventListener(
    'pointerdown',
    (event) => {
      if (event.target.closest('button')) return;
      const rect = panel.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      header.setPointerCapture(event.pointerId);
      const move = (moveEvent) => {
        panel.style.left = `${Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, moveEvent.clientX - offsetX))}px`;
        panel.style.top = `${Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, moveEvent.clientY - offsetY))}px`;
        panel.style.right = 'auto';
      };
      const stop = () => {
        header.removeEventListener('pointermove', move);
        header.removeEventListener('pointerup', stop);
        header.removeEventListener('pointercancel', stop);
      };
      header.addEventListener('pointermove', move, { signal });
      header.addEventListener('pointerup', stop, { once: true, signal });
      header.addEventListener('pointercancel', stop, { once: true, signal });
    },
    { signal },
  );
  document.addEventListener(
    'visibilitychange',
    () => {
      if (!selectedMediaUrl) return;
      if (document.hidden) {
        live.pause();
        still.pause();
      } else if (closedWindowCameraId !== selected?.id) {
        void live.play().catch(markLiveUnavailable);
        refreshStill();
      }
    },
    { signal },
  );

  const removeRender = viewer.scene.postRender.addEventListener(updateMarker);
  return {
    setCamera,
    dispose() {
      controller.abort();
      stopMediaRefresh();
      removeRender();
      setMedia(live, '');
      setMedia(still, '');
      panel.remove();
      marker.remove();
      selected = null;
      selectedPosition = null;
    },
  };
}
