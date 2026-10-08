import { MAPILLARY_PROVIDER_ID, mapillaryImageUrl } from './policy.js';

/**
 * Viewer adapter: lazy-loads MapillaryJS into the core's host and emits a
 * provider-neutral pose on every image, view or position change.
 * @returns {import('../../registry.js').ViewerAdapter}
 */
export function createMapillaryViewer({ source, render } = {}) {
  let viewer = null;
  let Library = null;
  let container = null;
  let pendingOpen = null;
  let prewarming = null;
  /** In-flight viewer construction, so pre-warm and open never build two. */
  let creating = null;
  /** Bumped by `unmount`, so a construction it overtook builds nothing. */
  let generation = 0;
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
      // Closed (or never opened) while the pose was in flight: a late
      // `image` event must not bring the photo back.
      if (pendingOpen === null) return;
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
    const built = generation;
    destroyViewer();
    const { Viewer } = await ensureLibrary();
    // Unmounted (layer off) while the library loaded: a viewer built now
    // would hold a WebGL context nobody releases.
    if (built !== generation) throw new Error('Mapillary viewer was unmounted');
    viewer = new Viewer({
      accessToken: source.token,
      container: host,
      component: {
        cover: false,
        bearing: true,
        zoom: true,
        attribution: true,
      },
      // The panel's ResizeObserver resizes the viewer, and skips it while it
      // is hidden (0x0); MapillaryJS's own window tracking would resize a
      // hidden viewer and ask for a tile at z=NaN.
      trackResize: false,
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
      // A playing sequence would keep stepping through (and downloading)
      // images in the hidden viewer.
      try {
        viewer?.getComponent('sequence')?.stop();
      } catch {
        /* sequence component not available */
      }
    },

    unmount() {
      pendingOpen = null;
      // The next mount builds afresh rather than joining a stale build.
      generation++;
      creating = null;
      destroyViewer();
    },

    resize() {
      try {
        viewer?.resize();
      } catch {
        /* no-op */
      }
    },

    /** Build the viewer ahead of the first image. Safe to call repeatedly. */
    async prewarm(host) {
      if (!host) return;
      // An in-flight prewarm may give up (layer toggled mid-download): wait
      // for it, then build if it did not.
      if (prewarming) await prewarming;
      if (viewer) return;
      const run = (async () => {
        try {
          await ensureLibrary();
          if (!viewer) await ensureViewer(host);
        } catch {
          /* the real open reports errors */
        }
      })();
      prewarming = run;
      await run;
      if (prewarming === run) prewarming = null;
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
