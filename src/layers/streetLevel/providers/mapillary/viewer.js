import { mapillaryImageUrl } from './policy.js';
import { msg } from '../../../../i18n/index.js';

const OPEN_TIMEOUT_MS = 12_000;
// A timed-out move leaves a short separate window to identify the frame still on screen.
const DISPLAY_CHECK_TIMEOUT_MS = 500;

/**
 * @typedef {object} StreetPose
 * @property {string} imageId
 * @property {{lon: number, lat: number}} position
 * @property {number|null} bearing
 * @property {number|null} altitude
 * @property {boolean} isPano
 * @property {number|null} capturedAt   Epoch milliseconds.
 * @property {string|null} creator
 * @property {string|null} sequenceId
 * @property {string} externalUrl      Deep link to the image on mapillary.com.
 */

/**
 * The source's Graph endpoint as an absolute URL ending in `/`, as MapillaryJS
 * resolves its lookup paths against it; '' when the source has none.
 */
export function graphEndpointUrl(source) {
  if (!source?.graphEndpoint) return '';
  const url = new URL(
    source.graphEndpoint,
    globalThis.location?.href || 'http://localhost/',
  );
  url.pathname = url.pathname.replace(/\/*$/, '/');
  return url.href;
}

/**
 * The card’s photo viewer: loads MapillaryJS on the first `mount` and emits
 * a pose on every image, view or position change.
 */
export function createMapillaryViewer({ source, render } = {}) {
  let viewer = null;
  let Library = null;
  let container = null;
  /** The viewer being built for a host: a second mount joins it, not a twin. */
  let building = null;
  let openRequest = null;
  let withdrawn = null;
  /** Bumped by `unmount`, so a construction it overtook builds nothing. */
  let generation = 0;
  let renderMode = 'letterbox';
  /** Metadata of the image on screen; pov/position events reuse it. */
  let current = null;
  let imageEvent = 0;
  let viewerRun = 0;
  /** The pose listener (the viewer host); one at a time. */
  let poseListener = null;

  function requestRender() {
    render?.governorRequestRender?.('mapillary-viewer');
  }

  function libraryRenderMode(mode) {
    const { RenderMode } = Library || {};
    if (!RenderMode) return undefined;
    return mode === 'fill' ? RenderMode.Fill : RenderMode.Letterbox;
  }

  async function ensureLibrary() {
    if (Library) return Library;
    // Lazy CSS: Vite applies it before the import resolves, so the viewer is
    // styled from its first frame without ~90 KB of render-blocking CSS.
    const [library] = await Promise.all([
      import('mapillary-js'),
      import('mapillary-js/dist/mapillary.css'),
    ]);
    Library = library;
    return Library;
  }

  function emit(pose) {
    try {
      poseListener?.(pose);
    } catch {
      /* listener errors are the core's to log */
    }
  }

  function poseOf(image, pov) {
    // Camera position interpolates between images. This position belongs to
    // the accepted image itself, even while the camera is still moving.
    const { lat, lng } = image.lngLat || {};
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const imageId = String(image.id);
    return {
      imageId,
      position: { lon: lng, lat },
      bearing: Number.isFinite(pov?.bearing) ? pov.bearing : null,
      isPano: image.cameraType === 'spherical',
      capturedAt: image.capturedAt ?? null,
      sequenceId: image.sequenceId ?? null,
      altitude: Number.isFinite(image.computedAltitude)
        ? image.computedAltitude
        : Number.isFinite(image.originalAltitude)
          ? image.originalAltitude
          : null,
      creator: image.creatorUsername || null,
      externalUrl: mapillaryImageUrl(imageId),
    };
  }

  function invalidate() {
    if (!current) return;
    current = null;
    emit(null);
  }

  async function publishPose(instance, frame) {
    const pov = await instance.getPointOfView().catch(() => null);
    if (viewer !== instance || openRequest || current !== frame) return;
    const pose = poseOf(frame.image, pov);
    if (!pose) {
      invalidate();
      return;
    }
    emit(pose);
    requestRender();
  }

  async function onImage(instance, image) {
    const request = openRequest;
    if (!image?.id || (!request && !current)) return;
    const run = viewerRun;
    const event = ++imageEvent;
    const displayed = await instance.getImage().catch(() => null);
    if (
      viewer !== instance ||
      run !== viewerRun ||
      request !== openRequest ||
      displayed?.id !== image.id ||
      event < (current?.event ?? 0)
    )
      return;
    if (request) {
      // A transition away from the old image leaves it unconfirmed even
      // if a later load fails. Only this request's image can finish it.
      if (current?.image.id !== displayed.id) invalidate();
      request.observe(displayed);
    } else if (current) {
      if (displayed.id === withdrawn?.id && current.image.id !== displayed.id) {
        // A cancelled SDK move reached the display after the card left.
        // Return to the previously confirmed frame without announcing the abandoned one.
        const retained = current;
        withdrawn = null;
        try {
          await instance.moveTo(retained.image.id);
        } catch {
          if (run === viewerRun && current === retained) invalidate();
        }
        return;
      }
      if (displayed.id !== current.image.id) withdrawn = null;
      const frame = { image: displayed, event };
      current = frame;
      void publishPose(instance, frame);
    }
  }

  async function openPose(instance, request) {
    const id = request.id;
    // moveTo resolves when the navigator installs the target. The viewer's
    // animation frame can still report the previous image at that point.
    let target;
    try {
      target = await instance.moveTo(id);
    } catch (error) {
      // Native arrow navigation supersedes the pending SDK move. Its target
      // can now be visited intentionally, including the same photo.
      if (withdrawn === request && error?.name === 'CancelMapillaryError')
        withdrawn = null;
      throw error;
    }
    if (openRequest !== request) return;
    if (String(target?.id) !== id)
      throw new Error(msg('Image could not be opened'));
    void instance.getImage().then(request.observe, () => {});
    const image = await request.shown;
    if (!image || openRequest !== request) return;
    const pov = await instance.getPointOfView().catch(() => null);
    if (openRequest !== request) return;
    const displayed = await instance.getImage();
    if (String(displayed?.id) !== id || openRequest !== request) return;
    const pose = poseOf(displayed, pov);
    return pose ? { image: displayed, pose } : null;
  }

  function ensureViewer(host) {
    if (viewer && container === host) return Promise.resolve(viewer);
    if (building?.host === host) return building.promise;
    const promise = buildViewer(host).finally(() => {
      if (building?.promise === promise) building = null;
    });
    building = { host, promise };
    return promise;
  }

  async function buildViewer(host) {
    const built = generation;
    destroyViewer();
    const { Viewer, GraphDataProvider } = await ensureLibrary();
    // Unmounted (layer off) while the library loaded: a viewer built now
    // would hold a WebGL context nobody releases.
    if (built !== generation) throw new Error('Mapillary viewer was unmounted');
    const endpoint = graphEndpointUrl(source);
    viewer = new Viewer({
      // A source with its own Graph endpoint (which adds the token itself)
      // answers the viewer's lookups, sent without a token; otherwise
      // MapillaryJS calls the Graph API with the client token.
      ...(endpoint
        ? { dataProvider: new GraphDataProvider({ endpoint }) }
        : { accessToken: source.token }),
      container: host,
      component: {
        cover: false,
        bearing: true,
        zoom: true,
        attribution: true,
      },
      // The viewer wrapper's ResizeObserver resizes the viewer, and skips it while it
      // is hidden (0x0); MapillaryJS's own window tracking would resize a
      // hidden viewer and ask for a tile at z=NaN.
      trackResize: false,
      renderMode: libraryRenderMode(renderMode),
    });
    container = host;
    const instance = viewer;
    instance.on('image', (event) => void onImage(instance, event.image));
    instance.on('pov', () => {
      if (current && !openRequest) void publishPose(instance, current);
    });
    return instance;
  }

  function destroyViewer() {
    openRequest?.cancel();
    openRequest = null;
    if (viewer) {
      try {
        viewer.remove();
      } catch {
        /* already removed */
      }
    }
    viewer = null;
    container = null;
    current = null;
  }

  /** Cancel a pending replacement while retaining the displayed photo. */
  function cancelOpenKeeping(imageId) {
    if (!current || String(current.image.id) !== String(imageId)) return false;
    if (openRequest) withdrawn = openRequest;
    viewerRun++;
    openRequest?.cancel();
    openRequest = null;
    stopPlayback();
    return true;
  }

  /** A playing sequence keeps stepping through (and downloading) images. */
  function stopPlayback() {
    try {
      viewer?.getComponent('sequence')?.stop();
    } catch {
      /* sequence component not available */
    }
  }

  return {
    async mount(host) {
      if (!host) throw new Error('Street Level viewer has no host element');
      await ensureViewer(host);
    },

    /** Resolve with the displayed image ID, after emitting its matching pose. */
    async open(imageId) {
      const id = String(imageId);
      if (!container) throw new Error('Mapillary viewer is not mounted');
      openRequest?.cancel();
      withdrawn = null;
      viewerRun++;
      let show;
      let stop;
      const shown = new Promise((resolve) => (show = resolve));
      const stopped = new Promise((resolve) => (stop = resolve));
      let endCheck;
      const request = {
        id,
        shown,
        observe: (image) => {
          if (String(image?.id) === id) show(image);
        },
        cancel: () => {
          show(null);
          stop(null);
          endCheck?.(null);
        },
      };
      openRequest = request;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        stop(null);
      }, OPEN_TIMEOUT_MS);
      let checkTimer;
      const instance = viewer;
      try {
        // Let a newer open take over before issuing a second move.
        await Promise.resolve();
        if (openRequest !== request) return;
        let frame;
        let failure;
        try {
          frame = await Promise.race([openPose(instance, request), stopped]);
        } catch (error) {
          failure = error;
        }
        if (openRequest !== request) return;
        if (!frame) {
          // Mapillary may keep the earlier image when its move is rejected.
          // Check the SDK's current image before retaining that frame.
          const displayed = current
            ? await Promise.race([
                instance.getImage().catch(() => null),
                new Promise((resolve) => {
                  endCheck = resolve;
                  checkTimer = setTimeout(
                    () => resolve(null),
                    DISPLAY_CHECK_TIMEOUT_MS,
                  );
                }),
              ])
            : null;
          if (openRequest !== request) return;
          if (!displayed || displayed.id !== current?.image.id) invalidate();
          else if (timedOut) cancelOpenKeeping(displayed.id);
          throw failure || new Error(msg('Image could not be opened'));
        }
        current = { image: frame.image, event: imageEvent };
        openRequest = null;
        emit(frame.pose);
        requestRender();
        return frame.pose.imageId;
      } finally {
        clearTimeout(timer);
        clearTimeout(checkTimer);
        request.cancel();
        if (openRequest === request) openRequest = null;
      }
    },

    cancelOpenKeeping,

    close() {
      viewerRun++;
      withdrawn = null;
      openRequest?.cancel();
      openRequest = null;
      current = null;
      // Hidden, the viewer must not keep playing.
      stopPlayback();
    },

    stopPlayback,

    unmount() {
      // A build still waiting for the library gives up when it arrives.
      generation++;
      building = null;
      destroyViewer();
    },

    resize() {
      try {
        viewer?.resize();
      } catch {
        /* no-op */
      }
    },

    /** Show the whole image ('letterbox') or crop it to the frame ('fill'). */
    setRenderMode(mode) {
      renderMode = mode === 'fill' ? 'fill' : 'letterbox';
      try {
        const value = libraryRenderMode(renderMode);
        if (viewer && value !== undefined) viewer.setRenderMode(value);
      } catch {
        /* viewer not ready */
      }
    },

    onPose(listener) {
      poseListener = listener;
      return () => {
        if (poseListener === listener) poseListener = null;
      };
    },
  };
}
