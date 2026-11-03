import * as Cesium from 'cesium';
import { horizonOccluder } from '../data/iconOrientation.js';
import { msg, t } from '../i18n/index.js';

const CAMERA_ORIGIN = 'https://www.quebec511.info/Carte/Fenetres/camera.ashx';
// i18n-ignore: provider and licence labels are required source attribution.
const MTQ_ATTRIBUTION = msg('MTQ · CC BY 4.0');
// i18n-ignore: OpenStreetMap credit is shown in its standard form.
const OSM_ATTRIBUTION = msg('OpenStreetMap contributors · ODbL');

function directVideoUrl(camera) {
  return camera.kind === 'traffic' && /^\d+$/.test(camera.id)
    ? `${CAMERA_ORIGIN}?id=${camera.id}&format=mp4`
    : '';
}

function safeViewerUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : '';
  } catch {
    return '';
  }
}

/** Install the opt-in Québec camera browser preview and return its cleanup. */
export function installQuebecCameraPreview(
  viewer,
  { initialId = '3735', fetchImpl = globalThis.fetch } = {},
) {
  const panel = document.createElement('section');
  panel.className = 'qc-preview-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', t('CCTV camera'));

  const header = document.createElement('header');
  header.className = 'qc-preview-header';
  const title = document.createElement('strong');
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', t('Close camera preview'));
  header.append(title, close);

  const select = document.createElement('select');
  select.setAttribute('aria-label', t('CCTV camera'));
  const coordinates = document.createElement('p');
  coordinates.className = 'qc-preview-coordinates';
  const live = document.createElement('video');
  live.className = 'qc-preview-live';
  live.controls = true;
  live.setAttribute('aria-label', t('CCTV camera'));
  live.autoplay = true;
  live.muted = true;
  live.loop = true;
  live.playsInline = true;

  const actions = document.createElement('div');
  actions.className = 'qc-preview-actions';
  const fly = document.createElement('button');
  fly.type = 'button';
  fly.textContent = t('FOCUS');
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = t('Refresh map still');
  actions.append(fly, refresh);
  const note = document.createElement('p');
  const source = document.createElement('a');
  source.target = '_blank';
  source.rel = 'noopener noreferrer';
  const viewerLink = document.createElement('a');
  viewerLink.target = '_blank';
  viewerLink.rel = 'noopener noreferrer';
  viewerLink.textContent = t("Open this image on the provider's site");
  panel.append(
    header,
    select,
    coordinates,
    live,
    actions,
    note,
    source,
    viewerLink,
  );

  const marker = document.createElement('div');
  marker.className = 'qc-preview-marker';
  marker.hidden = true;
  const still = document.createElement('video');
  still.setAttribute('aria-hidden', 'true');
  still.muted = true;
  still.playsInline = true;
  still.preload = 'auto';
  const label = document.createElement('span');
  marker.append(still, label);
  document.body.append(panel, marker);

  const controller = new AbortController();
  let disposed = false;
  let selected = null;
  let cameraPosition = null;
  let mapStillUrl = '';
  const cameraData = [];

  function setMedia(video, url) {
    if (video.src === url) return;
    video.pause();
    video.removeAttribute('src');
    if (!url) {
      video.load();
      return;
    }
    video.src = url;
    video.load();
  }

  function refreshStill() {
    if (!mapStillUrl) return;
    still.load();
    void still.play().catch(() => {});
  }

  function useCamera(camera) {
    selected = camera;
    cameraPosition = Cesium.Cartesian3.fromDegrees(camera.lon, camera.lat, 10);
    const mediaUrl = directVideoUrl(camera);
    const viewerUrl = safeViewerUrl(camera.viewerUrl);
    title.textContent = camera.nameEn || camera.name;
    select.value = camera.id;
    // i18n-ignore: coordinates, accuracy and provenance are camera data.
    coordinates.textContent = `${camera.lat.toFixed(camera.kind === 'traffic' ? 5 : 6)}, ${camera.lon.toFixed(camera.kind === 'traffic' ? 5 : 6)} · ${camera.accuracyM ? `±${camera.accuracyM} m` : camera.positionSource}`;
    live.hidden = !mediaUrl;
    refresh.hidden = !mediaUrl;
    still.hidden = !mediaUrl;
    if (mediaUrl) {
      note.textContent = t(
        'The map still uses a separate request and may show a different moment.',
      );
      setMedia(live, mediaUrl);
      live.play().catch(() => {});
      if (mapStillUrl !== mediaUrl) {
        mapStillUrl = mediaUrl;
        setMedia(still, mediaUrl);
        refreshStill();
      }
      // i18n-ignore: this suffix is provider-provided location provenance.
      label.textContent = `${t('PREVIEW')} · ${camera.positionSource}`;
      marker.classList.remove('qc-preview-marker-link-only');
    } else {
      note.textContent = viewerUrl
        ? t("Open this image on the provider's site")
        : t('Source unavailable');
      setMedia(live, '');
      setMedia(still, '');
      mapStillUrl = '';
      // i18n-ignore: camera names and accuracy are supplied as catalog data.
      label.textContent = camera.accuracyM
        ? `${camera.name} · ±${camera.accuracyM} m`
        : camera.name;
      marker.classList.add('qc-preview-marker-link-only');
    }

    const osmPosition =
      camera.kind === 'montreal' ||
      /openstreetmap|\bosm\b/i.test(camera.positionSource);
    const attribution =
      camera.kind === 'traffic'
        ? t('Source: {label}', { label: MTQ_ATTRIBUTION })
        : osmPosition
          ? t('Source: {label}', { label: OSM_ATTRIBUTION })
          : t('Source: {label}', {
              label: camera.operator || camera.positionSource || t('Source'),
            });
    source.textContent = attribution;
    const attributionUrl =
      camera.kind === 'traffic'
        ? 'https://www.donneesquebec.ca/recherche/dataset/camera-de-circulation'
        : osmPosition
          ? 'https://www.openstreetmap.org/copyright'
          : viewerUrl;
    source.href = attributionUrl || '#';
    source.hidden = !attributionUrl;
    viewerLink.href = viewerUrl || '#';
    viewerLink.hidden = !viewerUrl;
    updateMarker();
  }

  function updateMarker() {
    if (!selected || !cameraPosition) {
      marker.hidden = true;
      return;
    }
    const canvas = viewer.scene.canvas;
    const point = viewer.scene.cartesianToCanvasCoordinates(cameraPosition);
    const visible =
      point &&
      horizonOccluder(viewer.camera).isPointVisible(cameraPosition) &&
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
      cameraPosition,
    );
    marker.style.setProperty(
      '--qc-preview-scale',
      String(Math.min(1, 600 / Math.max(1, distance))),
    );
  }

  select.addEventListener('change', () => {
    const camera = cameraData.find((item) => item.id === select.value);
    if (camera) useCamera(camera);
  });
  still.addEventListener('loadeddata', () => still.pause());
  still.addEventListener('error', () => {
    label.textContent = t('Source unavailable');
  });
  live.addEventListener('error', () => {
    note.textContent = t('Source unavailable');
  });
  refresh.addEventListener('click', refreshStill);
  fly.addEventListener('click', () => {
    if (!selected) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        selected.lon,
        selected.lat,
        600,
      ),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 1.5,
    });
  });

  header.addEventListener('pointerdown', (event) => {
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
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', stop);
    header.addEventListener('pointercancel', stop);
  });

  const removeRender = viewer.scene.postRender.addEventListener(updateMarker);
  const ready = (async () => {
    try {
      const response = await fetchImpl('/quebec-cameras.json', {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Camera list HTTP ${response.status}`);
      const payload = await response.json();
      const cameras = Array.isArray(payload?.cameras) ? payload.cameras : [];
      if (!cameras.length) throw new Error('Empty Québec camera list');
      cameraData.push(...cameras);
      // i18n-ignore: these group names are provider/source categories.
      for (const kind of ['traffic', 'montreal', 'webcam']) {
        const group = document.createElement('optgroup');
        group.label =
          kind === 'traffic'
            ? 'MTQ / Québec 511'
            : kind === 'montreal'
              ? 'Montréal / OpenStreetMap'
              : 'Scenic webcams';
        for (const camera of cameras.filter((item) => item.kind === kind)) {
          const option = document.createElement('option');
          option.value = camera.id;
          // i18n-ignore: camera names and regions are provider catalog data.
          option.textContent = `${camera.nameEn || camera.name} · ${camera.region || camera.category}`;
          group.append(option);
        }
        if (group.children.length) select.append(group);
      }
      const chosen =
        cameras.find((camera) => camera.id === initialId) ||
        cameras.find((camera) => camera.id === '3735') ||
        cameras[0];
      useCamera(chosen);
    } catch {
      if (!disposed) note.textContent = t('Source unavailable');
    }
  })();

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    removeRender();
    for (const video of [live, still]) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    panel.remove();
    marker.remove();
  };
  close.addEventListener('click', dispose);
  return { dispose, ready };
}
