// Cameras and Sensors workspace: a responsive grid over the camera registry,
// a single-camera focus mode and per-provider status. A media element is
// only created for a verified stream of a supported kind; everything else
// gets an explicit no-stream placeholder.
import { t } from '../../i18n/index.js';
import { el, button, chip, emptyState, formatCoordinate } from './dom.js';
import { formatTimestamp } from './provenance.js';
import { pageHead } from './pages.js';

function statusChip(camera) {
  if (camera.demo) return chip(t('DEMO'), 'demo');
  switch (camera.status) {
    case 'online':
      return chip(t('ONLINE'), 'ok');
    case 'offline':
      return chip(t('OFFLINE'), 'danger');
    case 'unconfigured':
      return chip(t('NO STREAM'), 'neutral');
    default:
      return chip(t('UNKNOWN'), 'neutral');
  }
}

function frame(camera) {
  if (camera.stream?.verified) {
    if (camera.stream.kind === 'mp4' || camera.stream.kind === 'webm') {
      const video = el('video', {
        attrs: {
          controls: true,
          muted: true,
          playsinline: true,
          preload: 'metadata',
          src: camera.stream.url,
        },
      });
      return el('div', { className: 'oryn-camera-frame' }, video);
    }
    if (camera.stream.kind === 'mjpeg')
      return el(
        'div',
        { className: 'oryn-camera-frame' },
        el('img', {
          attrs: {
            src: camera.stream.url,
            alt: t('Live frames from {name}', { name: camera.name }),
          },
        }),
      );
    // HLS needs the engine's hls.js pipeline; the prototype does not wire it
    // here, so the stream is reported but not played.
    return el('div', {
      className: 'oryn-camera-frame',
      text: t(
        'HLS stream registered. Playback requires the engine media pipeline; not wired in this prototype.',
      ),
    });
  }
  if (camera.snapshotUrl)
    return el(
      'div',
      { className: 'oryn-camera-frame' },
      el('img', {
        attrs: {
          src: camera.snapshotUrl,
          alt: t('Still image from {name}', { name: camera.name }),
        },
      }),
    );
  return el('div', {
    className: 'oryn-camera-frame',
    text: camera.demo
      ? t('DEMO record. No stream URL or authorized provider is configured.')
      : t(
          'No stream. Configure an authorized stream URL or provider for this camera.',
        ),
  });
}

function cameraCard(ctx, camera, { focused = false } = {}) {
  const engine = ctx.engine();
  return el(
    'div',
    {
      className: `oryn-card${focused ? ' oryn-camera-focus' : ''}`,
      dataset: { cameraId: camera.id },
    },
    frame(camera),
    el(
      'div',
      { className: 'oryn-card-head' },
      el('h3', { className: 'oryn-card-title', text: camera.name }),
      statusChip(camera),
    ),
    el('span', {
      className: 'oryn-card-meta',
      text: [
        t(camera.source.label),
        camera.source.authorization,
        formatCoordinate(camera.lat, camera.lon),
        camera.headingDeg !== null
          ? t('heading {deg}°', { deg: camera.headingDeg })
          : null,
        camera.lastSeenAt
          ? t('last seen {time}', { time: formatTimestamp(camera.lastSeenAt) })
          : t('last seen: unknown'),
      ]
        .filter(Boolean)
        .join(' · '),
    }),
    el(
      'div',
      { className: 'oryn-actions' },
      button({
        label: focused ? t('Back to grid') : t('Focus'),
        iconName: focused ? 'chevronLeft' : 'cameras',
        className: 'oryn-btn-sm',
        onClick: () =>
          ctx.navigate('cameras', focused ? {} : { focus: camera.id }),
      }),
      button({
        label: t('Show on globe'),
        iconName: 'pin',
        className: 'oryn-btn-sm',
        disabled: !engine,
        onClick: () => {
          if (!engine) return;
          engine.flyTo({
            lat: camera.lat,
            lon: camera.lon,
            range: 1200,
            pitch: -40,
          });
          ctx.inspect(cameraToRef(camera), { fly: false });
          ctx.navigate('map');
        },
      }),
      button({
        label: t('Add to investigation'),
        iconName: 'investigations',
        className: 'oryn-btn-sm oryn-btn-ghost',
        onClick: () => ctx.addToInvestigation(cameraToRef(camera)),
      }),
    ),
  );
}

export function cameraToRef(camera) {
  return {
    kind: 'camera',
    id: camera.id,
    label: camera.name,
    position: { lon: camera.lon, lat: camera.lat },
    source: camera.source.label,
    sourceUrl: camera.source.url || undefined,
    provenance: camera.demo ? 'unverified' : 'provider',
    fields: {
      status: camera.status,
      authorization: camera.source.authorization,
      stream: camera.stream ? camera.stream.kind : 'none',
      demo: camera.demo,
      ...(camera.headingDeg !== null ? { headingDeg: camera.headingDeg } : {}),
      ...(camera.fovDeg !== null ? { fovDeg: camera.fovDeg } : {}),
    },
  };
}

export function renderCameras(ctx, params = {}) {
  const snapshot = ctx.cameras.snapshot;
  const cameras = snapshot.cameras;
  const focused = params.focus
    ? cameras.find((camera) => camera.id === params.focus)
    : null;
  return el(
    'div',
    { className: 'oryn-page' },
    pageHead(
      t('Cameras and Sensors'),
      t(
        'Camera registry for authorized sources. Records labeled DEMO are placeholders; public camera poses come from the engine CCTV layer and carry metadata only. Nothing is shown as live unless a provider supplied a verified stream.',
      ),
      [
        button({
          label: t('Refresh registry'),
          iconName: 'refresh',
          className: 'oryn-btn-sm',
          onClick: async () => {
            await ctx.cameras.refresh();
            ctx.rerender();
          },
        }),
      ],
    ),
    el(
      'section',
      { className: 'oryn-section' },
      el('h4', { className: 'oryn-section-title', text: t('Providers') }),
      el(
        'ul',
        { className: 'oryn-list' },
        snapshot.providerStates.length
          ? snapshot.providerStates.map((state) =>
              el(
                'li',
                { className: 'oryn-list-item' },
                el('span', { text: t(state.label) }),
                chip(
                  state.status === 'ready'
                    ? t('{count} cameras', { count: state.count })
                    : state.status === 'error'
                      ? t('ERROR')
                      : t('NOT CONFIGURED'),
                  state.status === 'ready'
                    ? 'ok'
                    : state.status === 'error'
                      ? 'danger'
                      : 'neutral',
                ),
                el('span', {
                  className: 'oryn-card-meta',
                  text:
                    state.error || (state.setupHint ? t(state.setupHint) : ''),
                }),
              ),
            )
          : el('li', {
              className: 'oryn-note',
              text: t('Registry not loaded yet.'),
            }),
      ),
    ),
    focused
      ? cameraCard(ctx, focused, { focused: true })
      : cameras.length
        ? el(
            'div',
            { className: 'oryn-camera-grid' },
            cameras.map((camera) => cameraCard(ctx, camera)),
          )
        : emptyState(
            t('No cameras registered'),
            t(
              'Connect an organization camera registry or enable the engine CCTV layer and refresh.',
            ),
          ),
    el(
      'section',
      { className: 'oryn-section' },
      el('h4', { className: 'oryn-section-title', text: t('Video analytics') }),
      el('p', {
        className: 'oryn-note',
        text: t(
          'No inference backend is configured, so no detections, counts or classifications are produced for any camera. See Settings for the model registry and what is needed to activate it.',
        ),
      }),
    ),
  );
}
