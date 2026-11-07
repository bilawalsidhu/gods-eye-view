// engine.imagery on Navara: every shown layer in one screen pass (pass.js),
// classified on the scene depth, so rasters drape on terrain and 3D tiles
// alike. An image source is one texture (mipmapped, wrapping across 180°
// when it spans the globe); setting the same canvas again uploads its new
// pixels. A tiles source is an atlas of at most 8×8 Web Mercator tiles over
// the part of its rectangle in view, at the level the camera's height asks
// for, rebuilt when the camera moves to another plan and filled as tiles
// arrive (6 loads at a time, or the source's maxRequests). A layer's credit
// shows while it does. Every change composes the drawn layers (bottom
// first) and asks for one frame; nothing animates on its own.

import {
  CanvasTexture,
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  Texture,
  UnsignedByteType,
} from 'three';
import {
  WEB_MERCATOR_LIMIT,
  createImageryRegistry,
  createImageryTileQueue,
  imageryTileLevel,
  imageryTilePlan,
  imageryTileUrl,
  isPixelImage,
  wrapsGlobe,
} from '../../imagery.js';
/** Layers one frame of the pass draws (pass.js samples one texture each). */
export const MAX_IMAGERY_SLOTS = 8;

const SIDE = { none: 0, left: -1, right: 1 };

async function loadTile(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Imagery tile HTTP ${response.status}`);
  const blob = await response.blob();
  signal.throwIfAborted();
  return createImageBitmap(blob);
}

const defaultCanvas = (width, height) =>
  Object.assign(document.createElement('canvas'), { width, height });

// Linear between texels, mipmapped, row 0 at v = 0 (no flip).
function finish(texture, wrap) {
  texture.flipY = false;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = wrap ? RepeatWrapping : ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

// An image source's texture. RGBA bytes are read as they are (sRGB bytes,
// blended in display space), as canvases and images are.
function imageTexture(image, wrap) {
  if (isPixelImage(image))
    return finish(
      new DataTexture(
        image.data,
        image.width,
        image.height,
        RGBAFormat,
        UnsignedByteType,
      ),
      wrap,
    );
  return finish(
    typeof image.getContext === 'function'
      ? new CanvasTexture(image)
      : new Texture(image),
    wrap,
  );
}

// Degrees, east past west (an antimeridian crossing adds 360°).
const unwrapped = ({ west, south, east, north }) => [
  west,
  south,
  east <= west ? east + 360 : east,
  north,
];

/**
 * @param {object} view an initialised Navara ThreeView
 * @param {{ camera: object, size: () => { width: number, height: number },
 *   credits: { addStatic: (html: string) => () => void },
 *   photorealActive: () => boolean,
 *   createPass: (view: object) => ReturnType<typeof import('./pass.js').createImageryPass>,
 *   load?: (url: string, signal: AbortSignal) => Promise<object>,
 *   createCanvas?: (width: number, height: number) => object }} options
 *   The engine's camera, size and credits; `createPass` makes the pass
 *   (pass.js createImageryPass; the view's three runtime, which Node tests
 *   replace); `load` (a tile or an image URL to a decoded image) and
 *   `createCanvas` are test seams.
 * @returns {{ imagery: import('../../contract.js').GlobeImagery,
 *   diagnostics: () => object, destroy: () => void }}
 */
export function createNavaraImagery(
  view,
  {
    camera,
    size,
    credits,
    photorealActive,
    createPass,
    load = loadTile,
    createCanvas = defaultCanvas,
  },
) {
  const pass = createPass(view);
  const entries = new Map();
  let warned = false;

  const compose = () => {
    const drawn = registry
      .ordered()
      .map((state) => entries.get(state))
      .filter(
        (entry) => entry?.state.shown && entry.state.alpha > 0 && entry.slot(),
      );
    if (drawn.length > MAX_IMAGERY_SLOTS && !warned) {
      warned = true;
      console.warn(
        `[Imagery] Navara draws the top ${MAX_IMAGERY_SLOTS} of ${drawn.length} layers`,
      );
    }
    pass.set(
      drawn.slice(-MAX_IMAGERY_SLOTS).map((entry) => entry.slot()),
      registry.imagery.splitPosition(),
    );
    view.forceUpdate();
  };

  // A layer's credit shows while the layer does.
  function syncCredit(entry) {
    const credit = entry.state.shown ? entry.state.source.credit : null;
    if (credit === entry.credit) return;
    entry.releaseCredit?.();
    entry.credit = credit;
    entry.releaseCredit = credit ? credits.addStatic(credit) : null;
  }

  function imageEntry(entry) {
    let texture = null,
      image = null,
      loading = null;
    const drop = () => {
      texture?.dispose();
      texture = null;
    };
    const show = (next, source) => {
      const wrapS = wrapsGlobe(source.rectangle)
        ? RepeatWrapping
        : ClampToEdgeWrapping;
      if (texture && image === next && texture.wrapS === wrapS) {
        // The same canvas or bytes again: their new pixels.
        texture.needsUpdate = true;
      } else {
        drop();
        texture = imageTexture(next, wrapS === RepeatWrapping);
      }
      image = next;
    };
    return {
      source() {
        const { source } = entry.state;
        loading?.abort();
        loading = null;
        if (source.image) {
          show(source.image, source);
          return;
        }
        drop();
        image = null;
        const controller = new AbortController();
        loading = controller;
        Promise.resolve()
          .then(() => load(source.url, controller.signal))
          .then(
            (decoded) => {
              if (controller.signal.aborted || entry.state.destroyed) {
                decoded?.close?.();
                return;
              }
              loading = null;
              show(decoded, source);
              compose();
            },
            (error) => {
              if (controller.signal.aborted) return;
              loading = null;
              console.warn('[Imagery] image failed to load:', error);
            },
          );
      },
      slot() {
        if (!texture) return null;
        const rect = unwrapped(entry.state.source.rectangle);
        return {
          texture,
          rect,
          bounds: rect,
          look: [entry.state.alpha, SIDE[entry.state.split], 0, 0],
        };
      },
      ready: () => texture !== null,
      cameraChanged: () => false,
      destroy() {
        loading?.abort();
        loading = null;
        drop();
        image = null;
      },
      diagnostics: () => ({ kind: 'image', loaded: texture !== null }),
    };
  }

  function tilesEntry(entry) {
    let atlas = null,
      queue = null;
    const disposeAtlas = () => {
      const current = atlas;
      atlas = null;
      if (!current) return;
      for (const controller of current.controllers) controller.abort();
      current.texture.dispose();
      current.canvas.width = current.canvas.height = 0;
      queue?.prune();
    };
    // The source's rectangle within Web Mercator's latitudes; across the
    // antimeridian the atlas covers every longitude.
    const box = () => {
      const { west, south, east, north } = entry.state.source.rectangle;
      return {
        west: west < east ? west : -180,
        east: west < east ? east : 180,
        south: Math.max(south, -WEB_MERCATOR_LIMIT),
        north: Math.min(north, WEB_MERCATOR_LIMIT),
      };
    };
    // The atlas for the view; true when it changed.
    function update() {
      if (!entry.state.shown) {
        if (!atlas) return false;
        disposeAtlas();
        return true;
      }
      const source = entry.state.source;
      let pose;
      try {
        pose = camera.pose();
      } catch {
        // Before the first frame the camera has no pose yet.
        return false;
      }
      const level = Math.max(
        source.minLevel,
        Math.min(
          source.maxLevel,
          imageryTileLevel({
            height: pose.cartographic.height,
            latitude: pose.cartographic.latitude,
            fovy: pose.fovy,
            heightPx: size().height,
          }),
        ),
      );
      const plan = imageryTilePlan(box(), camera.viewRectangle(), level);
      if ((atlas?.plan.key ?? null) === (plan?.key ?? null)) return false;
      disposeAtlas();
      if (!plan) return true;
      const tile = source.tileSize;
      const canvas = createCanvas(plan.width * tile, plan.height * tile);
      const texture = finish(new CanvasTexture(canvas), false);
      const current = {
        plan,
        canvas,
        texture,
        controllers: new Set(),
        loaded: 0,
        failed: 0,
      };
      atlas = current;
      const context = canvas.getContext('2d');
      const tasks = [];
      for (let y = 0; y < plan.height; y++)
        for (let x = 0; x < plan.width; x++)
          tasks.push({
            url: imageryTileUrl(
              source.url,
              plan.x + x,
              plan.y + y,
              plan.z,
              source.subdomains,
            ),
            controllers: current.controllers,
            live: () => !entry.state.destroyed && atlas === current,
            draw(image) {
              context.drawImage(image, x * tile, y * tile, tile, tile);
              current.loaded++;
              texture.needsUpdate = true;
              view.forceUpdate();
            },
            fail() {
              current.failed++;
            },
          });
      queue.add(tasks);
      return true;
    }
    return {
      source() {
        queue?.destroy();
        disposeAtlas();
        queue = createImageryTileQueue({
          load,
          limit: entry.state.source.maxRequests ?? 6,
        });
        update();
      },
      slot() {
        if (!atlas) return null;
        const [west, south, east, north] = unwrapped(
          entry.state.source.rectangle,
        );
        return {
          texture: atlas.texture,
          rect: [
            west,
            Math.max(south, -WEB_MERCATOR_LIMIT),
            east,
            Math.min(north, WEB_MERCATOR_LIMIT),
          ],
          bounds: atlas.plan.bounds,
          look: [entry.state.alpha, SIDE[entry.state.split], 1, 0],
        };
      },
      ready: () => true,
      cameraChanged: update,
      look: update,
      destroy() {
        queue?.destroy();
        queue = null;
        disposeAtlas();
      },
      diagnostics: () => ({
        kind: 'tiles',
        ...(queue?.diagnostics() ?? {}),
        atlas: atlas
          ? {
              level: atlas.plan.z,
              tiles: atlas.plan.width * atlas.plan.height,
              loaded: atlas.loaded,
              failed: atlas.failed,
            }
          : null,
      }),
    };
  }

  // One drawing per source kind; a new kind replaces it.
  function drawingFor(entry) {
    const kind = entry.state.source.kind;
    if (entry.drawing?.kind === kind) return entry.drawing;
    entry.drawing?.destroy();
    entry.drawing = kind === 'image' ? imageEntry(entry) : tilesEntry(entry);
    entry.drawing.kind = kind;
    return entry.drawing;
  }

  const registry = createImageryRegistry(
    (state) => {
      const entry = {
        state,
        drawing: null,
        credit: null,
        releaseCredit: null,
        slot: () => entry.drawing?.slot() ?? null,
      };
      entries.set(state, entry);
      drawingFor(entry).source();
      syncCredit(entry);
      compose();
      return {
        source() {
          drawingFor(entry).source();
          syncCredit(entry);
          compose();
        },
        look() {
          entry.drawing.look?.();
          syncCredit(entry);
          compose();
        },
        ready: () => entry.drawing.ready(),
        destroy() {
          entries.delete(state);
          entry.drawing.destroy();
          entry.releaseCredit?.();
          entry.releaseCredit = null;
          compose();
        },
      };
    },
    {
      splitPosition: () => compose(),
      surface: () => (photorealActive() ? 'tiles' : 'globe'),
    },
  );

  const offCamera = camera.changed.addEventListener(() => {
    let changed = false;
    for (const entry of entries.values())
      changed = entry.drawing.cameraChanged() || changed;
    if (changed) compose();
  });

  return {
    imagery: registry.imagery,
    /** Not contract: what each layer holds (QA reads it). */
    diagnostics: () =>
      Object.fromEntries(
        registry
          .ordered()
          .map((state) => [
            state.options.id,
            entries.get(state)?.drawing.diagnostics(),
          ]),
      ),
    destroy() {
      offCamera();
      registry.destroyAll();
      pass.destroy();
    },
  };
}
