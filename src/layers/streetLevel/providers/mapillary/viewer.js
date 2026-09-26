import { MAPILLARY_PROVIDER_ID, mapillaryImageUrl } from './policy.js';

/**
 * The Mapillary viewer adapter: lazy-load MapillaryJS, mount it in the host
 * the core hands over, open images, and emit a provider-neutral pose for
 * every image, point-of-view or position change.
 * @returns {import('../../registry.js').ViewerAdapter}
 */
export function createMapillaryViewer({ source, render } = {}) {
  let viewer = null;
  let Library = null;
  let container = null;
  let pendingOpen = null;
  let prewarming = false;
  /** In-flight viewer construction, so pre-warm and open never build two. */
  let creating = null;
  let renderMode = 'letterbox';
  /** Metadata of the image on screen; pov/position events reuse it. */
  let current = null;
  const listeners = new Set();

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
    // The viewer stylesheet is vendored into src/ui/styles/mapillary-js.css.
    Library = await import('mapillary-js');
    return Library;
  }

  function emit(pose) {
    for (const listener of [...listeners]) {
      try {
        listener(pose);
      } catch {
        /* listener errors are the core's to log */
      }
    }
  }

  /** Read MapillaryJS image metadata into the neutral pose shape. */
  function describe(image) {
    return {
      imageId: String(image.id),
      isPano: image.cameraType === 'spherical',
      capturedAt: image.capturedAt ?? null,
      sequenceId: image.sequenceId ?? null,
      altitude: Number.isFinite(image.computedAltitude)
        ? image.computedAltitude
        : Number.isFinite(image.originalAltitude)
          ? image.originalAltitude
          : null,
      creator: image.creatorUsername || null,
    };
  }

  async function publishPose(image) {
    if (!viewer) return;
    try {
      const [lngLat, pov] = await Promise.all([
        viewer.getPosition(),
        viewer.getPointOfView(),
      ]);
      if (image) current = describe(image);
      if (!current || !viewer) return;
      emit({
        providerId: MAPILLARY_PROVIDER_ID,
        ...current,
        position: { lon: lngLat.lng, lat: lngLat.lat },
        bearing: Number.isFinite(pov?.bearing) ? pov.bearing : null,
        tilt: Number.isFinite(pov?.tilt) ? pov.tilt : 0,
        externalUrl: mapillaryImageUrl(current.imageId),
      });
      requestRender();
    } catch {
      /* viewer torn down mid-flight */
    }
  }

  function ensureViewer(host) {
    if (viewer && container === host) return viewer;
    if (creating?.container === host) return creating.promise;
    const promise = createViewer(host).finally(() => {
      if (creating?.promise === promise) creating = null;
    });
    creating = { container: host, promise };
    return promise;
  }

  async function createViewer(host) {
    destroyViewer();
    const { Viewer } = await ensureLibrary();
    viewer = new Viewer({
      accessToken: source.token,
      container: host,
      component: {
        cover: false,
        bearing: true,
        zoom: true,
        attribution: true,
      },
      trackResize: true,
      renderMode: libraryRenderMode(renderMode),
    });
    container = host;
    viewer.on('image', (event) => publishPose(event.image));
    viewer.on('pov', () => publishPose(null));
    viewer.on('position', () => publishPose(null));
    return viewer;
  }

  function destroyViewer() {
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

  return {
    async mount(host) {
      if (!host) throw new Error('Street Level viewer has no host element');
      await ensureViewer(host);
    },

    /** Resolves once the image is on screen and its first pose was emitted. */
    async open(imageId) {
      const id = String(imageId);
      if (!container) throw new Error('Mapillary viewer is not mounted');
      pendingOpen = id;
      const instance = await ensureViewer(container);
      if (pendingOpen !== id) return;
      const image = await instance.moveTo(id);
      if (pendingOpen !== id) return;
      await publishPose(image);
    },

    close() {
      pendingOpen = null;
      current = null;
    },

    unmount() {
      pendingOpen = null;
      destroyViewer();
    },

    resize() {
      try {
        viewer?.resize();
      } catch {
        /* no-op */
      }
    },

    /**
     * Load the library and stand the viewer up ahead of the first image, so
     * opening one only costs the image download. Safe to call repeatedly.
     */
    async prewarm(host) {
      if (prewarming || !host) return;
      prewarming = true;
      try {
        await ensureLibrary();
        if (!viewer) await ensureViewer(host);
      } catch {
        /* the real open reports errors */
      } finally {
        prewarming = false;
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
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
