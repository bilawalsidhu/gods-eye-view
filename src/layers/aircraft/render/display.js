import { createTrail } from '../../../data/trailRenderer.js';
// The aircraft display (contract: ./contract.js): what the aircraft layers
// (flights, military, local ADS-B) draw, on any globe engine, through the
// engine contract only: engine.movers (the fleet glyphs, the tracked glyph,
// the 3D models), engine.lines (the trail and its live head),
// engine.camera.follow (the follow camera), engine.projector and
// engine.camera.pose() (the view the logic reads). The engine draws.
//
// Handles expose the fields the logic writes (contract.js) as
// setters that write the engine's instance stores; the writes of a frame are
// committed once, at the end of the frame listener that made them (or in a
// microtask for writes outside a frame), so a fleet tick draws in its frame.
//
// Sprites go in banks: one mover set per distance scale and depth mode the
// handles ask for (flights: one), growing by doubling; the tracked glyph has
// its own, drawn over the fleet. Models go in banks per glTF and look (url,
// minimum pixels, blend, unlit). The glyph atlas holds every aircraftIcon()
// kind at the fleet and tracked raster sizes, drawn once from the same SVGs.

import * as geo from '../../../geo/index.js';
import {
  aircraftIconAtlasLayout,
  aircraftIconCells,
  drawAircraftIconAtlas,
} from '../../../data/aircraftIcons.js';
import { cockpitContactDotImage } from '../../../data/cockpitContactDot.js';
import { createEngineLayerView } from '../../shared/render/engineView.js';
import { Rgba, rgbaFromCss } from '../../shared/color.js';
import { SPRITE_LAYER_ORDER } from '../../../data/spriteOrder.js';
import { createMoverBank, writeFields } from '../../shared/render/moverBank.js';

const BASE_SIZE_PX = 20;
/**
 * The model frame → the glTF's own axes (the movers' orientation): Cesium's
 * glTF axis correction, Y_UP_TO_Z_UP × Z_UP_TO_X_UP (data/modelVisualAnchor.js),
 * column-major. setPose keeps modelMatrix in the model frame, as the layers'
 * anchors read it.
 */
const GLTF_AXIS = [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1];
// The trail's alpha where it passes the depth test and where the scene hides
// it, and the live head's.
const HEAD_ALPHA = 0.9;
const HEAD_OCCLUDED_ALPHA = 0.45;

// ---------------------------------------------------------------------------
// Sprite fields
// ---------------------------------------------------------------------------

const scratchColor = new Float64Array(4);
// Sprite setters write synchronously into the mover store; reuse their
// field records rather than allocating one per contact and assignment.
const spritePositionField = { position: null };
const spriteShowField = { show: true };
const spriteRotationField = { rotation: 0 };
const spriteScaleField = { scale: 1 };
const spriteColorField = { color: scratchColor };

const rgbaOf = (color, result = scratchColor) => {
  result[0] = color?.red ?? 1;
  result[1] = color?.green ?? 1;
  result[2] = color?.blue ?? 1;
  result[3] = color?.alpha ?? 1;
  return result;
};

const depthKey = (distance) =>
  distance === Number.POSITIVE_INFINITY
    ? 'always'
    : Number.isFinite(distance) && distance > 0
      ? { disableWithinM: distance }
      : 'normal';

const scalarKey = (scalar) =>
  scalar
    ? `${scalar.near},${scalar.nearValue},${scalar.far},${scalar.farValue}`
    : 'none';

// Follow handle → the tracked handle it follows, for every aircraft layer on
// the engine: a layer whose follow another aircraft layer took reads the
// new owner's tracked handle (its gevSelectionOrigin).
const FOLLOWED_TRACKED = new WeakMap();
// The tracked handle whose follow is being started (any aircraft layer):
// the engine raises followChanged inside follow(), before the follow
// handle is known, and every layer's listener must see the new owner.
let followStarting = null;

// ---------------------------------------------------------------------------
// The display
// ---------------------------------------------------------------------------

/**
 * @param {import('../../../globe/contract.js').GlobeEngine} engine
 * @param {object} options
 * @param {string} options.layerId Names the layer's mover sets and lines.
 * @param {number} [options.order=0] Draw order of the layer's sprites.
 * @param {number} [options.headingOffsetDeg=0] Model nose vs heading 0.
 * @param {() => Promise<{ canvas: object, cells: object }>} [options.drawAtlas]
 *   Test seam: the glyph atlas.
 * @returns {import('./contract.js').AircraftRenderer}
 */
export function createAircraftDisplay(
  engine,
  {
    layerId,
    order = 0,
    headingOffsetDeg = 0,
    drawAtlas = drawAircraftIconAtlas,
  },
) {
  let destroyed = false;
  let attached = false;
  const removers = [];
  const iconCells = aircraftIconCells();
  const defaultIcon = [...iconCells.keys()][0];
  const cellFor = (image) =>
    image && image === cockpitContactDotImage._dataUrl
      ? 'cockpit-dot'
      : iconCells.get(image);

  // --- commits: once per frame listener, or in a microtask -----------------
  const pending = new Set();
  let inFrame = 0;
  let microtask = false;
  const flush = () => {
    microtask = false;
    for (const bank of pending) bank.commit();
    pending.clear();
  };
  const onCommit = (bank) => {
    pending.add(bank);
    if (inFrame === 0 && !microtask) {
      microtask = true;
      queueMicrotask(flush);
    }
  };
  const inFrameDo = (run) => {
    inFrame++;
    try {
      return run();
    } finally {
      inFrame--;
      if (inFrame === 0) flush();
    }
  };

  // --- the view ------------------------------------------------------------
  const layerView = createEngineLayerView(engine, {
    layerId,
    wrap: (run) => inFrameDo(run),
    isDestroyed: () => destroyed,
  });
  removers.push(layerView.destroy);
  const { view, freshCamera } = layerView;

  // --- sprites: the fleet and the tracked glyph -------------------------------
  let atlas = null;
  let fleetVisible = true;
  const spriteBanks = new Map();
  let spriteBankSeq = 0;
  const unbanked = new Set(); // sprites added before the atlas
  const spriteWrite = (sprite, set, index) => {
    writeFields(set, index, {
      position: sprite.position,
      rotation: sprite.rotation,
      scale: sprite.drawnScale(),
      color: rgbaOf(sprite.color),
      cell: sprite.cell,
      show: sprite.show,
    });
    set.set(index, { pickId: sprite.id });
  };
  // One bank per role (fleet, tracked), distance scale and depth mode.
  const spriteBankFor = (sprite) => {
    if (!atlas) return null;
    const { tracked } = sprite;
    const depth = depthKey(sprite.disableDepthTestDistance);
    const dot = sprite.cell === 'cockpit-dot';
    const key = `${tracked ? 'tracked' : 'fleet'}|${scalarKey(sprite.scaleByDistance)}|${JSON.stringify(depth)}|${dot}`;
    let bank = spriteBanks.get(key);
    if (!bank) {
      const scalar = sprite.scaleByDistance;
      const index = spriteBankSeq++;
      bank = createMoverBank(engine, {
        options: (capacity, generation) => ({
          id: `${layerId}-${tracked ? 'tracked' : 'sprites'}-${index}-${generation}`,
          kind: 'sprite',
          capacity,
          // The tracked glyph over the fleet.
          order: tracked ? order + 0.5 : order,
          depthTest: depth,
          pickable: true,
          sprite: {
            atlas: dot
              ? {
                  url: cockpitContactDotImage(),
                  cells: { 'cockpit-dot': [0, 0, 1, 1] },
                }
              : atlas,
            sizePx: BASE_SIZE_PX,
            scaleByDistance: scalar
              ? [scalar.near, scalar.nearValue, scalar.far, scalar.farValue]
              : undefined,
          },
        }),
        write: spriteWrite,
        onCommit,
      });
      bank.setVisible(tracked || fleetVisible);
      spriteBanks.set(key, bank);
    }
    return bank;
  };
  const placeSprite = (sprite) => {
    if (!sprite.live) return;
    const bank = spriteBankFor(sprite);
    if (!bank) {
      unbanked.add(sprite);
      return;
    }
    bank.add(sprite);
  };
  const atlasReady = Promise.resolve()
    .then(() => drawAtlas())
    .then((drawn) => {
      if (destroyed) return;
      atlas = drawn;
      const waiting = [...unbanked];
      unbanked.clear();
      for (const sprite of waiting) placeSprite(sprite);
      engine.render.request(layerId);
    })
    .catch((error) =>
      console.warn(`[${layerId}] aircraft atlas failed`, error),
    );

  class Sprite {
    constructor(spec, tracked = false) {
      this.gevBank = null;
      this.gevIndex = -1;
      this.live = true;
      this.tracked = tracked;
      this._position = geo.cartesian3.clone(
        spec.position ?? geo.cartesian3.ZERO,
      );
      this._show = spec.show !== false;
      this._rotation = spec.rotation ?? 0;
      this._scale = spec.scale ?? 1;
      this._width = spec.width ?? BASE_SIZE_PX;
      this._height = spec.height ?? BASE_SIZE_PX;
      this._color = new Rgba(
        spec.color?.red ?? 1,
        spec.color?.green ?? 1,
        spec.color?.blue ?? 1,
        spec.color?.alpha ?? 1,
      );
      this._image = spec.image;
      this.cell = cellFor(spec.image) ?? iconCells.get(defaultIcon);
      this._scaleByDistance = spec.scaleByDistance
        ? { ...spec.scaleByDistance }
        : undefined;
      this._disableDepthTestDistance = spec.disableDepthTestDistance ?? 0;
      this._id = spec.id;
      this.alignedAxis = spec.alignedAxis;
      this.sizeInMeters = false;
    }

    drawnScale() {
      return Math.max(0, this._scale * (this._width / BASE_SIZE_PX));
    }

    write(fields) {
      this.gevBank?.update(this, fields);
    }

    get id() {
      return this._id;
    }

    set id(value) {
      this._id = value;
      if (this.gevBank?.set) {
        this.gevBank.set.set(this.gevIndex, { pickId: value });
        this.gevBank.touch();
      }
    }

    get position() {
      return this._position;
    }

    set position(value) {
      geo.cartesian3.clone(value, this._position);
      spritePositionField.position = this._position;
      this.write(spritePositionField);
    }

    get show() {
      return this._show;
    }

    set show(value) {
      const next = value !== false;
      if (next === this._show) return;
      this._show = next;
      spriteShowField.show = next;
      this.write(spriteShowField);
    }

    get rotation() {
      return this._rotation;
    }

    set rotation(value) {
      if (value === this._rotation) return;
      this._rotation = value;
      spriteRotationField.rotation = value;
      this.write(spriteRotationField);
    }

    get scale() {
      return this._scale;
    }

    set scale(value) {
      if (value === this._scale) return;
      this._scale = value;
      spriteScaleField.scale = this.drawnScale();
      this.write(spriteScaleField);
    }

    get width() {
      return this._width;
    }

    set width(value) {
      if (value === this._width) return;
      this._width = value;
      spriteScaleField.scale = this.drawnScale();
      this.write(spriteScaleField);
    }

    // Glyphs are square: the width sizes them.
    get height() {
      return this._height;
    }

    set height(value) {
      this._height = value;
    }

    get color() {
      return this._color;
    }

    set color(value) {
      if (
        value !== this._color &&
        (value?.red ?? 1) === this._color.red &&
        (value?.green ?? 1) === this._color.green &&
        (value?.blue ?? 1) === this._color.blue &&
        (value?.alpha ?? 1) === this._color.alpha
      )
        return;
      this._color = new Rgba(
        value?.red ?? 1,
        value?.green ?? 1,
        value?.blue ?? 1,
        value?.alpha ?? 1,
      );
      rgbaOf(this._color);
      this.write(spriteColorField);
    }

    get image() {
      return this._image;
    }

    set image(value) {
      this._image = value;
      const cell = cellFor(value);
      if (!cell || cell === this.cell) return;
      const rebank = (cell === 'cockpit-dot') !== (this.cell === 'cockpit-dot');
      this.cell = cell;
      if (rebank) placeSprite(this);
      else this.write({ cell });
    }

    get scaleByDistance() {
      return this._scaleByDistance;
    }

    set scaleByDistance(value) {
      const next = value ? { ...value } : undefined;
      if (scalarKey(next) === scalarKey(this._scaleByDistance)) return;
      this._scaleByDistance = next;
      // Another distance scale is another set.
      if (this.gevBank) placeSprite(this);
    }

    get disableDepthTestDistance() {
      return this._disableDepthTestDistance;
    }

    set disableDepthTestDistance(value) {
      const next = value ?? 0;
      if (next === this._disableDepthTestDistance) return;
      this._disableDepthTestDistance = next;
      // Another depth mode is another set.
      if (this.gevBank) placeSprite(this);
    }
  }

  const fleetBanks = () =>
    [...spriteBanks.entries()]
      .filter(([key]) => key.startsWith('fleet|'))
      .map(([, bank]) => bank);

  const fleet = {
    attach() {
      attached = !destroyed;
    },
    detach() {
      attached = false;
      for (const [key, bank] of [...spriteBanks])
        if (key.startsWith('fleet|')) {
          bank.destroy();
          spriteBanks.delete(key);
        }
      for (const sprite of unbanked)
        if (!sprite.tracked) unbanked.delete(sprite);
    },
    attached: () => attached && !destroyed,
    visible: () => attached && !destroyed && fleetVisible,
    setVisible(visible) {
      fleetVisible = visible;
      for (const bank of fleetBanks()) bank.setVisible(visible);
    },
    add(spec) {
      const sprite = new Sprite(spec);
      placeSprite(sprite);
      return sprite;
    },
    remove(sprite) {
      if (!sprite) return;
      sprite.live = false;
      unbanked.delete(sprite);
      sprite.gevBank?.remove(sprite);
    },
    // Draw order is each set's `order` (the layer's data/spriteOrder slot).
    restoreOrder() {},
    restoreOrderOnEnable() {},
  };

  // --- models ----------------------------------------------------------------
  let modelsVisible = true;
  const modelBanks = new Map();
  const scratchMatrix3 = geo.matrix3.create();
  const scratchCorrected = geo.matrix4.create();
  const scratchQuaternion = geo.quaternion.create();
  const scratchHpr = { heading: 0, pitch: 0, roll: 0 };
  const modelWrite = (model, set, index) => {
    writeFields(set, index, {
      position: model.translation,
      orientation: model.orientation,
      scale: model.scale,
      color: rgbaOf(model.color),
      show: model.show && model.placed,
    });
    set.set(index, { pickId: model.id });
  };
  const modelBankFor = (model) => {
    const { url, minimumPixelSize, blendAmount, unlit } = model.spec;
    const key = `${url}|${minimumPixelSize}|${blendAmount}|${unlit}`;
    let bank = modelBanks.get(key);
    if (!bank) {
      const index = modelBanks.size;
      bank = createMoverBank(engine, {
        options: (capacity, generation) => ({
          id: `${layerId}-models-${index}-${generation}`,
          kind: 'model',
          capacity: Math.min(capacity, 512),
          order,
          pickable: true,
          model: {
            url,
            minimumPixelSize,
            colorBlend: { mode: 'mix', amount: blendAmount ?? 0.5 },
            unlit: unlit === true,
          },
        }),
        write: modelWrite,
        onCommit,
      });
      bank.setVisible(modelsVisible);
      modelBanks.set(key, bank);
    }
    return bank;
  };

  const scratchOffset = geo.cartesian3.create();

  class ModelHandle {
    constructor(spec) {
      this.spec = spec;
      this.gevBank = null;
      this.gevIndex = -1;
      this.placed = false;
      this._show = true;
      this._scale = spec.scale ?? 1;
      this._color = new Rgba(
        spec.color?.red ?? 1,
        spec.color?.green ?? 1,
        spec.color?.blue ?? 1,
        spec.color?.alpha ?? 1,
      );
      this._id = spec.id;
      this.modelMatrix = geo.matrix4.create();
      this.translation = geo.cartesian3.create();
      this.orientation = geo.quaternion.create(0, 0, 0, 1);
      this.radiusM = spec.radiusM ?? 1;
    }

    /** Placed, and the engine has loaded what this instance draws. */
    get ready() {
      return this.placed && Boolean(this.gevBank?.set?.ready(this.gevIndex));
    }

    /** The engine could not load what this instance draws. */
    get failed() {
      return Boolean(this.gevBank?.set?.failed(this.gevIndex));
    }

    /** The scale drawn: minimumPixelSize kept on the CPU. */
    get computedScale() {
      const minimum = this.spec.minimumPixelSize ?? 0;
      if (!(minimum > 0)) return this._scale;
      const cam = freshCamera();
      // Cesium's distance (Camera distanceToBoundingSphere): the depth
      // along the view less the radius at the model's own scale.
      geo.cartesian3.subtract(this.translation, cam.positionWC, scratchOffset);
      const distance = Math.max(
        0,
        Math.abs(geo.cartesian3.dot(scratchOffset, cam.directionWC)) -
          this.radiusM * this._scale,
      );
      const height = engine.host.size().height;
      if (!(distance > 0) || !(height > 0)) return this._scale;
      const pixels =
        (2 * this.radiusM * this._scale * height) /
        (2 * Math.tan(cam.frustum.fovy / 2) * distance);
      return pixels < minimum ? this._scale * (minimum / pixels) : this._scale;
    }

    get id() {
      return this._id;
    }

    set id(value) {
      this._id = value;
      if (this.gevBank?.set) {
        this.gevBank.set.set(this.gevIndex, { pickId: value });
        this.gevBank.touch();
      }
    }

    get show() {
      return this._show;
    }

    set show(value) {
      this._show = value !== false;
      this.gevBank?.update(this, { show: this._show && this.placed });
    }

    get scale() {
      return this._scale;
    }

    set scale(value) {
      this._scale = value;
      this.gevBank?.update(this, { scale: value });
    }

    get color() {
      return this._color;
    }

    set color(value) {
      this._color = new Rgba(
        value?.red ?? 1,
        value?.green ?? 1,
        value?.blue ?? 1,
        value?.alpha ?? 1,
      );
      this.gevBank?.update(this, { color: rgbaOf(this._color) });
    }
  }

  const dropModel = (model) => model?.gevBank?.remove(model);

  const models = {
    live: () => attached && !destroyed,
    setVisible(visible) {
      modelsVisible = visible;
      for (const bank of modelBanks.values()) bank.setVisible(visible);
    },
    loadFleet: (spec) => Promise.resolve(new ModelHandle(spec)),
    loadTracked: (spec) => Promise.resolve(new ModelHandle(spec)),
    add(model) {
      modelBankFor(model).add(model);
    },
    remove: dropModel,
    destroy: dropModel,
    /** The heading-pitch-roll frame (modelMatrix, the model frame); the
     *  instance turned to the glTF's own axes (GLTF_AXIS). `offsetDeg`: this
     *  model's nose offset when the layer's models differ (default: the
     *  layer's). */
    setPose(model, position, headingDeg, offsetDeg = headingOffsetDeg) {
      scratchHpr.heading = geo.math.toRadians((headingDeg || 0) + offsetDeg);
      geo.transforms.headingPitchRollToFixedFrame(
        position,
        scratchHpr,
        geo.ellipsoid.WGS84,
        undefined,
        model.modelMatrix,
      );
      geo.matrix4.multiplyTransformation(
        model.modelMatrix,
        GLTF_AXIS,
        scratchCorrected,
      );
      geo.quaternion.fromRotationMatrix(
        geo.matrix4.getMatrix3(scratchCorrected, scratchMatrix3),
        scratchQuaternion,
      );
      model.orientation.x = scratchQuaternion.x;
      model.orientation.y = scratchQuaternion.y;
      model.orientation.z = scratchQuaternion.z;
      model.orientation.w = scratchQuaternion.w;
      geo.cartesian3.clone(position, model.translation);
      model.placed = true;
      model.gevBank?.update(model, {
        position: model.translation,
        orientation: model.orientation,
        show: model._show,
      });
      return model.modelMatrix;
    },
  };

  // --- the tracked glyph -----------------------------------------------------
  const trackedSprites = new Set();
  let trackedSeq = 0;
  // Each frame (before drawing): the tracked glyphs read their callbacks.
  // A followed glyph takes the position its follow centred this frame
  // (Cesium's follow reads it before the frame's events).
  removers.push(
    engine.frames.preRender.addEventListener(() =>
      inFrameDo(() => {
        for (const sprite of trackedSprites) {
          const { spec } = sprite;
          const position = sprite.gevFollowSampled
            ? sprite.gevFollowSample
            : spec.position();
          sprite.gevFollowSampled = false;
          if (position) sprite.position = position;
          sprite.rotation = spec.rotation();
          sprite.color = spec.color();
        }
      }),
    ),
  );

  const tracked = {
    create(spec) {
      const sprite = new Sprite(
        {
          position: spec.position() ?? geo.cartesian3.ZERO,
          image: spec.image,
          width: spec.width,
          height: spec.height,
          scale: spec.scale,
          color: spec.color(),
          rotation: spec.rotation(),
          scaleByDistance: spec.scaleByDistance,
          disableDepthTestDistance: spec.disableDepthTestDistance,
          id: `${layerId}-tracked-${++trackedSeq}`,
        },
        true,
      );
      sprite.spec = spec;
      sprite.resumeAircraftFollow = () => follow.start(sprite);
      sprite.viewFrom = null;
      sprite.gevFollowSample = geo.cartesian3.create();
      sprite.gevFollowSampled = false;
      trackedSprites.add(sprite);
      placeSprite(sprite);
      return sprite;
    },
    remove(handle) {
      if (!handle) return;
      handle.live = false;
      trackedSprites.delete(handle);
      unbanked.delete(handle);
      handle.gevBank?.remove(handle);
      if (
        handle.gevFollowHandle &&
        engine.camera.following() === handle.gevFollowHandle
      )
        handle.gevFollowHandle.stop();
    },
    isLive: (handle) => trackedSprites.has(handle),
    setImage(handle, image) {
      if (handle) handle.image = image;
    },
    setViewFrom(handle, offset) {
      handle.viewFrom = geo.cartesian3.create(offset.x, offset.y, offset.z);
    },
    billboardSize: (handle) =>
      handle
        ? {
            width: handle.width,
            height: handle.height,
            scale: handle.scale,
            scaleByDistance: handle.scaleByDistance,
          }
        : null,
  };

  // --- follow ---------------------------------------------------------------
  // The follow carries the tracked readout's card as plain data (the
  // handle's annotation fields, read when the card paints).
  const followOf = (handle) =>
    engine.camera.follow({
      native: handle,
      position() {
        const position = handle.spec.position();
        if (position) {
          geo.cartesian3.clone(position, handle.gevFollowSample);
          handle.gevFollowSampled = true;
        }
        return position;
      },
      viewFrom: () => handle.viewFrom,
      label:
        typeof handle.gevTrackedId === 'string'
          ? {
              id: handle.gevTrackedId,
              model: () => handle.gevLabelModel,
              position: () =>
                handle.gevDisplayPosition?.() ?? handle.spec.position(),
            }
          : undefined,
    });
  const follow = {
    start(handle) {
      const outer = followStarting;
      followStarting = handle;
      let followHandle;
      try {
        followHandle = followOf(handle);
      } finally {
        followStarting = outer;
      }
      handle.gevFollowHandle = followHandle;
      FOLLOWED_TRACKED.set(followHandle, handle);
    },
    refocus(handle) {
      follow.start(handle);
    },
    release() {
      engine.camera.following()?.stop();
    },
    isFollowing: (handle) =>
      Boolean(handle?.gevFollowHandle) &&
      engine.camera.following() === handle.gevFollowHandle,
    // What is followed: an aircraft layer's tracked handle, else what the
    // follow is of (another layer's entity), else the follow itself.
    current() {
      if (followStarting) return followStarting;
      const handle = engine.camera.following();
      return handle
        ? (FOLLOWED_TRACKED.get(handle) ?? handle.native ?? handle)
        : undefined;
    },
    onChanged: (listener) =>
      engine.camera.followChanged.addEventListener(listener),
  };

  // --- trails ----------------------------------------------------------------
  // The layer's lines and heads, released with the display.
  const lines = new Set();
  const heads = new Set();
  const bodies = new Set();
  const lineOf = (options) => {
    const line = engine.lines.createLine(options);
    lines.add(line);
    return line;
  };
  const dropLine = (line) => {
    if (line && lines.delete(line)) line.destroy();
  };
  const samePositions = (a, b) =>
    a.length === b.length &&
    a.every((position, index) => geo.cartesian3.equals(position, b[index]));
  const trails = {
    create(options) {
      const trail = createTrail(engine, options);
      const destroy = trail.destroy;
      trail.destroy = () => {
        bodies.delete(trail);
        destroy();
      };
      bodies.add(trail);
      return trail;
    },
    // The live head segment: its positions are read each frame while shown.
    createHead({ id, show, positions, color, width = 2.5 }) {
      if (destroyed) return null;
      const [r, g, b] = rgbaFromCss(color).rgba();
      const line = lineOf({
        id: `${id}`,
        widthPx: width,
        color: [r, g, b, HEAD_ALPHA],
        depthFailAlpha: HEAD_OCCLUDED_ALPHA / HEAD_ALPHA,
        arc: 'geodesic',
        pickId: id,
      });
      let shown = show !== false;
      line.show(shown);
      // Written only when they move: each write requests a render.
      let drawn = [];
      const remove = engine.frames.preRender.addEventListener(() => {
        if (!shown) return;
        const next = (positions() ?? []).map((position) =>
          geo.cartesian3.clone(position),
        );
        if (samePositions(next, drawn)) return;
        drawn = next;
        line.setPositions(next);
      });
      const head = {
        id,
        get show() {
          return shown;
        },
        set show(value) {
          shown = value !== false;
          line.show(shown);
        },
        remove() {
          if (!heads.delete(head)) return;
          remove();
          dropLine(line);
        },
      };
      heads.add(head);
      return head;
    },
    removeHead(head) {
      head?.remove();
    },
  };

  return {
    engine,
    view,
    fleet,
    models,
    tracked,
    follow,
    trails,
    /** The atlas is drawn (tests, QA). */
    whenReady: () => atlasReady,
    /** A vertical surface probe skips the layer's own mover sets. */
    surfaceExclusions: () =>
      [...spriteBanks.values(), ...modelBanks.values()]
        .map((bank) => bank.set)
        .filter(Boolean),
    destroy() {
      if (destroyed) return;
      flush();
      destroyed = true;
      attached = false;
      for (const remove of removers.splice(0)) remove?.();
      for (const bank of spriteBanks.values()) bank.destroy();
      spriteBanks.clear();
      unbanked.clear();
      for (const bank of modelBanks.values()) bank.destroy();
      modelBanks.clear();
      trackedSprites.clear();
      for (const head of [...heads]) head.remove();
      for (const trail of [...bodies]) trail.destroy();
      for (const line of [...lines]) dropLine(line);
    },
  };
}

/**
 * The registry factory of one aircraft layer (src/app/layers/renderers.js
 * and the Navara mode register the same one): its sprite slot
 * (data/spriteOrder's order) and its model's nose offset. `drawAtlas` is a
 * test seam.
 * @param {string} layerId
 * @param {number} headingOffsetDeg
 */
export function aircraftLayerDisplay(layerId, headingOffsetDeg) {
  /** @param {import('../../../globe/contract.js').GlobeEngine} engine */
  return (engine, { drawAtlas } = {}) =>
    createAircraftDisplay(engine, {
      layerId,
      order: SPRITE_LAYER_ORDER.indexOf(layerId),
      headingOffsetDeg,
      ...(drawAtlas ? { drawAtlas } : {}),
    });
}

// The glyph atlas helpers, re-exported for tests.
export { aircraftIconAtlasLayout as aircraftAtlasLayout, aircraftIconCells };
