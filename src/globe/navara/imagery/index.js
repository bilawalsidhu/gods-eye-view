// engine.imagery on Navara: every shown layer in one screen pass (pass.js),
// classified on the scene depth, so rasters drape on terrain and 3D tiles
// alike, or, raised, on a shell above the ellipsoid. An image source is one
// texture (mipmapped, wrapping across 180° when it spans the globe);
// setting the same canvas again uploads its new pixels. A tiles source is
// an atlas of at most 8×8 Web Mercator or geographic tiles over the part of
// its rectangle in view, at the level the camera's height asks for, rebuilt
// when the camera moves to another plan and filled as tiles arrive (6
// loads at a time, or the source's maxRequests), each through the source's
// transform. A staged source builds its own texture or atlas while the
// drawn one shows and takes its place once it is complete. A raised
// layer's detail is a second slot right over its own, which the pass
// draws in place of the layer inside the detail's rectangle. A layer's
// credit shows while it does. Every change composes the drawn layers
// (bottom first) and asks for one frame; nothing animates on its own.

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
  raisedLift,
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
 *   destroy: () => void }}
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
  // The metres every raised layer rises at the camera's height now.
  let lift = 0;
  const liftNow = () => {
    try {
      return raisedLift(camera.pose().cartographic.height);
    } catch {
      // Before the first frame the camera has no pose yet.
      return lift;
    }
  };

  const compose = () => {
    lift = liftNow();
    const drawn = registry
      .ordered()
      .map((state) => entries.get(state))
      .filter(
        (entry) => entry?.state.shown && entry.state.alpha > 0 && entry.slot(),
      );
    const slots = drawn.flatMap((entry) => entry.slots());
    if (slots.length > MAX_IMAGERY_SLOTS && !warned) {
      warned = true;
      console.warn(
        `[Imagery] Navara draws the top ${MAX_IMAGERY_SLOTS} of ${slots.length} slots`,
      );
    }
    // A detail never draws without its layer under it.
    let top = slots.slice(-MAX_IMAGERY_SLOTS);
    if (top[0]?.detailOf) top = top.slice(1);
    pass.set(top, registry.imagery.splitPosition());
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

  // A raised layer's height on the pass, lifted with the camera.
  const raiseOf = (entry) =>
    entry.state.options.raise === null ? 0 : entry.state.options.raise + lift;

  // One image source's texture: { texture, image, source } built from a
  // decoded image, or loaded from its URL (`then(texture | null)`).
  function textureFor(next, source, previous = null) {
    const wrap = wrapsGlobe(source.rectangle);
    if (
      previous &&
      previous.image === next &&
      previous.texture.wrapS === (wrap ? RepeatWrapping : ClampToEdgeWrapping)
    ) {
      // The same canvas or bytes again: their new pixels.
      previous.texture.needsUpdate = true;
      return previous;
    }
    return { texture: imageTexture(next, wrap), image: next };
  }
  function loadImage(source, controller) {
    return Promise.resolve()
      .then(() => load(source.url, controller.signal))
      .then(
        (decoded) => {
          if (controller.signal.aborted) {
            decoded?.close?.();
            return null;
          }
          return decoded;
        },
        (error) => {
          if (!controller.signal.aborted)
            console.warn('[Imagery] image failed to load:', error);
          return null;
        },
      );
  }

  function imageEntry(entry) {
    let drawn = null,
      loading = null,
      staging = null,
      detail = null;
    const drop = (held) => {
      if (held && held !== drawn) held.texture.dispose();
    };
    const dropDrawn = () => {
      drawn?.texture.dispose();
      drawn = null;
    };
    const cancelStage = () => {
      staging?.controller.abort();
      if (staging?.built) drop(staging.built);
      staging = null;
    };
    const slotOf = (held, rectangle) => {
      const rect = unwrapped(rectangle);
      return {
        texture: held.texture,
        rect,
        bounds: rect,
        look: [entry.state.alpha, SIDE[entry.state.split], 0, 0],
        raise: raiseOf(entry),
      };
    };
    return {
      source() {
        const { source } = entry.state;
        loading?.abort();
        loading = null;
        cancelStage();
        if (source.image) {
          const next = textureFor(source.image, source, drawn);
          if (next !== drawn) dropDrawn();
          drawn = next;
          return;
        }
        dropDrawn();
        const controller = new AbortController();
        loading = controller;
        loadImage(source, controller).then((decoded) => {
          if (!decoded || entry.state.destroyed || loading !== controller) {
            decoded?.close?.();
            return;
          }
          loading = null;
          drawn = textureFor(decoded, source);
          compose();
        });
      },
      stage(source, finish) {
        cancelStage();
        const controller = new AbortController();
        const job = { controller, built: null };
        staging = job;
        const swap = (decoded) => {
          if (staging !== job || entry.state.destroyed) {
            if (!source.image) decoded?.close?.();
            return;
          }
          if (!decoded) {
            staging = null;
            finish(false);
            return;
          }
          // The drawn texture goes as the staged one takes its place: three
          // uploads it on the frame that draws it.
          loading?.abort();
          loading = null;
          job.built = textureFor(decoded, source, drawn);
          staging = null;
          if (job.built !== drawn) dropDrawn();
          drawn = job.built;
          finish(true);
          syncCredit(entry);
          compose();
        };
        // Never in the call itself: a newer source can still replace it.
        if (source.image) queueMicrotask(() => swap(source.image));
        else loadImage(source, controller).then(swap);
      },
      unstage: cancelStage,
      detail(next, finish) {
        detail?.held.texture.dispose();
        detail = null;
        if (next) {
          detail = {
            held: { texture: imageTexture(next.image, false) },
            rectangle: next.rectangle,
          };
          finish(true);
        }
        compose();
      },
      slot() {
        return drawn ? slotOf(drawn, entry.state.source.rectangle) : null;
      },
      slots() {
        const main = this.slot();
        if (!main) return [];
        if (!detail) return [main];
        main.look[3] = 1;
        return [
          main,
          { ...slotOf(detail.held, detail.rectangle), detailOf: main },
        ];
      },
      ready: () => drawn !== null,
      cameraChanged: () => false,
      destroy() {
        loading?.abort();
        loading = null;
        cancelStage();
        dropDrawn();
        detail?.held.texture.dispose();
        detail = null;
      },
    };
  }

  // The atlas of one tiles source over the view, its loads `limit` at a
  // time; `onTile()` after each tile settles.
  function createTiler(source, onTile) {
    const scheme = source.scheme;
    const queue = createImageryTileQueue({
      load,
      limit: source.maxRequests ?? 6,
    });
    let atlas = null;
    let disposed = false;
    const disposeAtlas = () => {
      const current = atlas;
      atlas = null;
      if (!current) return;
      for (const controller of current.controllers) controller.abort();
      current.texture.dispose();
      current.canvas.width = current.canvas.height = 0;
      queue.prune();
    };
    // The source's rectangle within the tiling's latitudes.
    const limit = scheme === 'geographic' ? 90 : WEB_MERCATOR_LIMIT;
    const box = () => {
      const { west, south, east, north } = source.rectangle;
      return {
        west,
        east,
        south: Math.max(south, -limit),
        north: Math.min(north, limit),
      };
    };
    return {
      source,
      atlas: () => atlas,
      /** The atlas for the view; true when it changed. */
      update(shown) {
        if (disposed) return false;
        if (!shown) {
          if (!atlas) return false;
          disposeAtlas();
          return true;
        }
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
              scheme,
            }),
          ),
        );
        const plan = imageryTilePlan(
          box(),
          camera.viewRectangle(),
          level,
          scheme,
        );
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
                (plan.x + x) %
                  2 ** (plan.z + (scheme === 'geographic' ? 1 : 0)),
                plan.y + y,
                plan.z,
                source.subdomains,
              ),
              controllers: current.controllers,
              live: () => !disposed && atlas === current,
              draw(image) {
                const drawn = source.transform
                  ? source.transform(image)
                  : image;
                context.drawImage(drawn, x * tile, y * tile, tile, tile);
                current.loaded++;
                texture.needsUpdate = true;
                view.forceUpdate();
                onTile();
              },
              fail() {
                current.failed++;
                onTile();
              },
            });
        queue.add(tasks);
        return true;
      },
      /** Every tile of the view's atlas settled (none: nothing to load). */
      complete: () =>
        !atlas ||
        atlas.loaded + atlas.failed === atlas.plan.width * atlas.plan.height,
      failed: () => (atlas?.failed ?? 0) > 0,
      dispose() {
        disposed = true;
        queue.destroy();
        disposeAtlas();
      },
    };
  }

  function tilesEntry(entry) {
    let tiler = null;
    // The staged source's tiler and its finish.
    let staged = null;
    const settleStaged = () => {
      const job = staged;
      if (!job) return;
      const shown = entry.state.shown;
      if (shown && !job.tiler.complete()) return;
      staged = null;
      if (shown && job.tiler.failed()) {
        job.tiler.dispose();
        job.finish(false);
        return;
      }
      tiler?.dispose();
      tiler = job.tiler;
      job.finish(true);
      syncCredit(entry);
      compose();
    };
    const dropStaged = () => {
      staged?.tiler.dispose();
      staged = null;
    };
    const update = () => {
      const changed = tiler?.update(entry.state.shown) ?? false;
      staged?.tiler.update(entry.state.shown);
      settleStaged();
      return changed;
    };
    return {
      source() {
        dropStaged();
        tiler?.dispose();
        tiler = createTiler(entry.state.source, () => {});
        update();
      },
      stage(source, finish) {
        dropStaged();
        const job = { finish, tiler: null };
        job.tiler = createTiler(source, () => {
          if (staged === job) queueMicrotask(settleStaged);
        });
        staged = job;
        update();
      },
      unstage: dropStaged,
      slot() {
        const atlas = tiler?.atlas();
        if (!atlas) return null;
        const source = tiler.source;
        const [west, south, east, north] = unwrapped(source.rectangle);
        const mercator = source.scheme !== 'geographic';
        const limit = mercator ? WEB_MERCATOR_LIMIT : 90;
        return {
          texture: atlas.texture,
          rect: [west, Math.max(south, -limit), east, Math.min(north, limit)],
          bounds: atlas.plan.bounds,
          look: [
            entry.state.alpha,
            SIDE[entry.state.split],
            mercator ? 1 : 0,
            0,
          ],
          raise: 0,
        };
      },
      slots() {
        const main = this.slot();
        return main ? [main] : [];
      },
      ready: () => true,
      cameraChanged: update,
      look: update,
      destroy() {
        dropStaged();
        tiler?.dispose();
        tiler = null;
      },
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
        slots: () => entry.drawing?.slots() ?? [],
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
        credit() {
          syncCredit(entry);
          compose();
        },
        // A staged source of another kind builds the other drawing aside.
        stage(source, finish) {
          if (source.kind === entry.drawing.kind) {
            entry.drawing.stage(source, finish);
            return;
          }
          const aside =
            source.kind === 'image' ? imageEntry(entry) : tilesEntry(entry);
          aside.kind = source.kind;
          entry.aside?.destroy();
          entry.aside = aside;
          aside.stage(source, (ok) => {
            if (entry.aside !== aside) return;
            entry.aside = null;
            if (ok) {
              entry.drawing.destroy();
              entry.drawing = aside;
            } else aside.destroy();
            finish(ok);
            syncCredit(entry);
            compose();
          });
        },
        unstage() {
          entry.drawing.unstage();
          entry.aside?.destroy();
          entry.aside = null;
        },
        detail(detail, finish) {
          entry.drawing.detail?.(detail, finish);
        },
        look() {
          entry.drawing.look?.();
          entry.aside?.look?.();
          syncCredit(entry);
          compose();
        },
        ready: () => entry.drawing.ready(),
        destroy() {
          entries.delete(state);
          entry.aside?.destroy();
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

  const viewChanged = () => {
    let changed = false;
    for (const entry of entries.values()) {
      changed = entry.drawing.cameraChanged() || changed;
      entry.aside?.cameraChanged();
    }
    // Raised layers rise with the camera.
    if (changed || liftNow() !== lift) compose();
  };
  const offCamera = camera.changed.addEventListener(viewChanged);
  view.on?.('resize', viewChanged);

  return {
    imagery: registry.imagery,
    destroy() {
      offCamera();
      view.off?.('resize', viewChanged);
      registry.destroyAll();
      pass.destroy();
    },
  };
}
