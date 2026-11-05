import { CanvasTexture, LinearFilter } from 'three';
import * as geo from '../../../geo/index.js';
import { PRODUCTS, fitViewHeightM, gibsTemplate } from '../model.js';
import { createImageryGround } from './navaraGround.js';
import {
  TILE_SIZE,
  imageryTilePlan,
  imageryTileUrl,
  createImageryTileQueue,
} from './tiles.js';

const keyOf = (b) => [b.west, b.south, b.east, b.north].join(',');
const alphaOf = (x) =>
  Number.isFinite(Number(x)) ? Math.max(0, Math.min(1, Number(x))) : 1;
async function loadTile(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Imagery tile HTTP ${response.status}`);
  const blob = await response.blob();
  signal.throwIfAborted();
  return createImageBitmap(blob);
}

/** Two bounded visible mosaics on actual terrain depth, with no paid source. */
export function createRecentImageryNavaraRenderer(engine, options = {}) {
  const {
    tileTemplate = gibsTemplate,
    credit = 'NASA GIBS',
    load = loadTile,
  } = options;
  const owner = { slots: { a: null, b: null }, split: 0.5, preview: null };
  const ground = createImageryGround(engine, options, owner);
  const queue = createImageryTileQueue({ load });
  let destroyed = false,
    host = null,
    releaseCredit = null;
  const wake = () => engine.render.request('recent-imagery');
  function disposeAtlas(record) {
    const atlas = record.atlas;
    record.atlas = null;
    if (!atlas) return;
    for (const c of atlas.controllers) c.abort();
    atlas.texture.dispose();
    atlas.canvas.width = atlas.canvas.height = 0;
    queue.prune();
  }
  function updateTiles(record) {
    const pose = engine.camera.pose(),
      size = engine.host.size();
    const metresPerPixel =
      (2 * Math.max(1, pose.cartographic.height) * Math.tan(pose.fovy / 2)) /
      Math.max(1, size.height);
    const level = Math.min(
      PRODUCTS[record.candidate.product].maxLevel,
      Math.ceil(
        Math.log2(
          (156543.033928 * Math.cos(pose.cartographic.latitude)) /
            metresPerPixel,
        ),
      ),
    );
    const plan = imageryTilePlan(
      record.box,
      engine.camera.viewRectangle(),
      level,
    );
    if ((record.atlas?.plan.key || null) === (plan?.key || null)) return;
    disposeAtlas(record);
    if (!plan) {
      wake();
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = plan.width * TILE_SIZE;
    canvas.height = plan.height * TILE_SIZE;
    const texture = new CanvasTexture(canvas);
    texture.flipY = false;
    texture.minFilter = texture.magFilter = LinearFilter;
    texture.generateMipmaps = false;
    const atlas = {
      plan,
      canvas,
      texture,
      controllers: new Set(),
      loaded: 0,
      failed: 0,
    };
    record.atlas = atlas;
    const context = canvas.getContext('2d');
    const template = tileTemplate(
        record.candidate.product,
        record.candidate.day,
      ),
      tasks = [];
    for (let y = 0; y < plan.height; y++)
      for (let x = 0; x < plan.width; x++)
        tasks.push({
          url: imageryTileUrl(template, plan.x + x, plan.y + y, plan.z),
          controllers: atlas.controllers,
          live: () => !destroyed && record.atlas === atlas,
          draw(image) {
            context.drawImage(
              image,
              x * TILE_SIZE,
              y * TILE_SIZE,
              TILE_SIZE,
              TILE_SIZE,
            );
            atlas.loaded++;
            texture.needsUpdate = true;
            wake();
          },
          fail() {
            atlas.failed++;
          },
        });
    queue.add(tasks);
    wake();
  }
  function sync() {
    ground.sync();
    const shown = owner.slots.a || owner.slots.b;
    if (shown && !releaseCredit)
      releaseCredit = engine.credits.addStatic(credit);
    else if (!shown && releaseCredit) {
      releaseCredit();
      releaseCredit = null;
    }
    wake();
  }
  function hideSlot(id) {
    const record = owner.slots[id];
    if (!record) return;
    owner.slots[id] = null;
    disposeAtlas(record);
    sync();
  }
  const offCamera = engine.camera.changed.addEventListener(() => {
    for (const record of Object.values(owner.slots))
      if (record) updateTiles(record);
  });
  return {
    resolveHost: () => ({
      identity: engine,
      kind: engine.maps.current()?.photoreal ? 'tileset' : 'globe',
    }),
    rebind(next) {
      host = next;
    },
    showSlot(id, candidate, box, { alpha = 1, splitDirection = 'none' } = {}) {
      if (
        destroyed ||
        !['a', 'b'].includes(id) ||
        !candidate?.key ||
        !PRODUCTS[candidate.product] ||
        !box ||
        !host?.identity
      )
        return false;
      let record = owner.slots[id];
      if (
        record &&
        (record.candidate.key !== candidate.key ||
          keyOf(record.box) !== keyOf(box))
      ) {
        hideSlot(id);
        record = null;
      }
      if (!record) {
        record = owner.slots[id] = {
          candidate: { ...candidate },
          box: { ...box },
          alpha: alphaOf(alpha),
          split: splitDirection,
          atlas: null,
        };
        updateTiles(record);
        sync();
      } else if (
        record.alpha !== alphaOf(alpha) ||
        record.split !== splitDirection
      ) {
        record.alpha = alphaOf(alpha);
        record.split = splitDirection;
        wake();
      }
      return true;
    },
    hideSlot,
    setAlpha(id, alpha) {
      const r = owner.slots[id],
        next = alphaOf(alpha);
      if (r && r.alpha !== next) {
        r.alpha = next;
        wake();
      }
    },
    setSplit(value) {
      if (owner.split !== value) {
        owner.split = value;
        wake();
      }
    },
    setBoxPreview(box) {
      owner.preview = box ? { ...box } : null;
      ground.sync();
      wake();
    },
    viewCentre() {
      const { width, height } = engine.host.size(),
        hit = engine.camera.pickEllipsoid({ x: width / 2, y: height / 2 });
      const c = hit && geo.cartographic.fromCartesian(hit, geo.ellipsoid.WGS84);
      return c
        ? {
            lon: (c.longitude * 180) / Math.PI,
            lat: (c.latitude * 180) / Math.PI,
          }
        : null;
    },
    zoomToFit(target) {
      const height = fitViewHeightM({
        ...engine.host.size(),
        fovy: engine.camera.pose().fovy,
      });
      engine.camera.flyTo({
        destination: geo.cartesian3.fromDegrees(target.lon, target.lat, height),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration: 1.2,
      });
      return height;
    },
    getOwned: () =>
      Object.fromEntries(
        Object.entries(owner.slots).map(([id, r]) => [
          id,
          r
            ? {
                key: r.candidate.key,
                kind: 'globe',
                alpha: r.alpha,
                split: r.split,
              }
            : null,
        ]),
      ),
    ownedCount: () => Object.values(owner.slots).filter(Boolean).length,
    diagnostics: () => ({
      ...queue.diagnostics(),
      slots: Object.fromEntries(
        Object.entries(owner.slots).map(([id, r]) => [
          id,
          r?.atlas
            ? {
                level: r.atlas.plan.z,
                tiles: r.atlas.plan.width * r.atlas.plan.height,
                loaded: r.atlas.loaded,
                failed: r.atlas.failed,
              }
            : null,
        ]),
      ),
    }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      offCamera();
      hideSlot('a');
      hideSlot('b');
      queue.destroy();
      ground.destroy();
      releaseCredit?.();
      releaseCredit = null;
      owner.preview = null;
    },
  };
}
