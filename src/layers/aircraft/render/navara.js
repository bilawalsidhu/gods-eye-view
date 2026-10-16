// The aircraft renderer on the Navara engine (contract: ./contract.js),
// built only on the engine contract: engine.movers (the fleet glyphs, the
// tracked glyph, the 3D models), engine.lines (the trail and its live head),
// engine.camera.follow (the follow camera), engine.projector and
// engine.camera.pose() (the view the logic reads). No three, no Cesium: the
// engine draws. Loaded only through the Navara mode's import().
//
// Handles keep the Cesium field vocabulary the logic writes (contract.js) as
// setters that write the engine's instance stores; the writes of a frame are
// committed once, at the end of the frame listener that made them (or in a
// microtask for writes outside a frame), so a fleet tick draws in its frame.
//
// Sprites go in banks: one mover set per distance scale and depth mode the
// handles ask for (flights: one), growing by doubling. Models go in banks per
// glTF and look (url, minimum pixels, blend, unlit). The glyph atlas holds
// every aircraftIcon() kind at the fleet and tracked raster sizes, drawn
// once from the same SVGs Cesium's billboards load.

import * as geo from '../../../geo/index.js';
import {
  aircraftIconAtlasLayout,
  aircraftIconCells,
  drawAircraftIconAtlas,
} from '../../../data/aircraftIcons.js';
import { registerViewerEngine } from '../../../globe/cesium/engineFromViewer.js';

const BASE_SIZE_PX = 20;

/**
 * The model frame → glTF scene axes on Navara. Cesium draws a glTF through
 * Y_UP_TO_Z_UP × Z_UP_TO_X_UP (data/modelVisualAnchor.js); Navara's glTF
 * loader already turns the scene Y-up to Z-up, so here it is Z_UP_TO_X_UP
 * alone: nose, top and heading of airplane.glb where Cesium draws them
 * (checked side by side with Cesium on a tracked aircraft at 300 m against
 * five other axis candidates).
 */
// Cesium's Axis.Z_UP_TO_X_UP, column-major.
const NAVARA_GLTF_AXIS = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];
const FIRST_CAPACITY = 1024;
const ATLAS_PAD = 2;
const TRAIL_ALPHA = 0.85;
const TRAIL_OCCLUDED_ALPHA = 0.4;
const MIN_SEGMENT_DISTANCE_SQ = 0.01;

// ---------------------------------------------------------------------------
// Banks of mover sets
// ---------------------------------------------------------------------------

// Reused set() arguments (set() copies them; no object per write).
const fieldsNoPick = {
  position: undefined,
  orientation: undefined,
  color: undefined,
  rotation: undefined,
  scale: undefined,
  cell: undefined,
  show: undefined,
};
const scratchColor = new Float64Array(4);
function writeFields(set, index, fields) {
  const scratch = fieldsNoPick;
  for (const key in fields) scratch[key] = fields[key];
  set.set(index, scratch);
  for (const key in fields) scratch[key] = undefined;
}

/**
 * A growing bank of one kind of mover: handles hold an index; removal moves
 * the last handle into the hole. `options(capacity, generation)` gives the
 * createSet options; `write(handle, set, index)` writes a handle whole.
 */
export function createMoverBank(engine, { options, write, onCommit }) {
  const handles = [];
  let set = null;
  let generation = 0;
  let capacity = 0;
  let visible = true;
  let dirty = false;
  const build = (wanted) => {
    const next = engine.movers.createSet(options(wanted, ++generation));
    set?.destroy();
    set = next;
    capacity = wanted;
    handles.forEach((handle, index) => write(handle, set, index));
    set.setCount(visible ? handles.length : 0);
    dirty = true;
  };
  const bank = {
    handles,
    get set() {
      return set;
    },
    ready: () => Boolean(set?.ready()),
    add(handle) {
      if (handle.gevBank === bank) return;
      handle.gevBank?.remove(handle);
      handle.gevBank = bank;
      handle.gevIndex = handles.length;
      handles.push(handle);
      if (!set || handles.length > capacity)
        build(Math.max(FIRST_CAPACITY, capacity * 2, handles.length));
      else {
        write(handle, set, handle.gevIndex);
        if (visible) set.setCount(handles.length);
      }
      bank.touch();
    },
    remove(handle) {
      if (handle.gevBank !== bank) return;
      const index = handle.gevIndex;
      const last = handles.pop();
      if (last !== handle) {
        handles[index] = last;
        last.gevIndex = index;
        write(last, set, index);
      }
      handle.gevBank = null;
      handle.gevIndex = -1;
      set?.setCount(visible ? handles.length : 0);
      bank.touch();
    },
    /** Writes `fields` of one handle (when it is in this bank). */
    update(handle, fields) {
      if (handle.gevBank !== bank || !set) return;
      writeFields(set, handle.gevIndex, fields);
      bank.touch();
    },
    setVisible(next) {
      visible = next;
      set?.setCount(visible ? handles.length : 0);
      bank.touch();
    },
    visible: () => visible,
    touch() {
      if (!dirty) {
        dirty = true;
        onCommit(bank);
      }
    },
    commit() {
      if (!dirty) return;
      dirty = false;
      set?.commit();
    },
    destroy() {
      for (const handle of handles) {
        handle.gevBank = null;
        handle.gevIndex = -1;
      }
      handles.length = 0;
      set?.destroy();
      set = null;
    },
  };
  return bank;
}

const rgbaOf = (color, result = scratchColor) => {
  result[0] = color?.red ?? 1;
  result[1] = color?.green ?? 1;
  result[2] = color?.blue ?? 1;
  result[3] = color?.alpha ?? 1;
  return result;
};

/** Plain colour copy (the stored value a handle's colour getter returns). */
class StoredColor {
  constructor(color) {
    this.red = color?.red ?? 1;
    this.green = color?.green ?? 1;
    this.blue = color?.blue ?? 1;
    this.alpha = color?.alpha ?? 1;
  }

  withAlpha(alpha) {
    return new StoredColor({ ...this, alpha });
  }
}

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

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {import('../../../globe/contract.js').GlobeEngine} options.engine
 * @param {string} options.layerId Names the layer's mover sets and lines.
 * @param {number} [options.order=0] Draw order of the layer's sprites.
 * @param {number} [options.headingOffsetDeg=0] Model nose vs heading 0.
 * @param {() => Promise<{ canvas: object, cells: object }>} [options.drawAtlas]
 *   Test seam: the glyph atlas.
 * @returns {import('./contract.js').AircraftRenderer}
 */
export function createAircraftNavaraRenderer({
  engine,
  layerId,
  order = 0,
  headingOffsetDeg = 0,
  drawAtlas = drawAircraftIconAtlas,
}) {
  let destroyed = false;
  const removers = [];
  const iconCells = aircraftIconCells();
  const defaultIcon = [...iconCells.keys()][0];

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
  let frameNumber = 0;
  removers.push(
    engine.frames.preUpdate.addEventListener(() => {
      frameNumber++;
    }),
  );
  const camera = {
    positionWC: geo.cartesian3.create(),
    positionCartographic: geo.cartographic.create(),
    directionWC: geo.cartesian3.create(),
    upWC: geo.cartesian3.create(),
    rightWC: geo.cartesian3.create(),
    heading: 0,
    pitch: 0,
    roll: 0,
    frustum: { fovy: 1, aspectRatio: 1 },
  };
  let poseFrame = -1;
  const lastPosition = geo.cartesian3.create(Number.NaN, 0, 0);
  // The camera as of now: refreshed once per frame, and whenever it moved.
  const freshCamera = () => {
    const live = engine.camera.livePosition;
    if (
      poseFrame === frameNumber &&
      live.x === lastPosition.x &&
      live.y === lastPosition.y &&
      live.z === lastPosition.z
    )
      return camera;
    const pose = engine.camera.pose();
    geo.cartesian3.clone(pose.position, camera.positionWC);
    geo.cartographic.clone(pose.cartographic, camera.positionCartographic);
    geo.cartesian3.clone(pose.direction, camera.directionWC);
    geo.cartesian3.clone(pose.up, camera.upWC);
    geo.cartesian3.clone(pose.right, camera.rightWC);
    camera.heading = pose.heading;
    camera.pitch = pose.pitch;
    camera.roll = pose.roll;
    camera.frustum.fovy = pose.fovy;
    camera.frustum.aspectRatio = pose.aspectRatio ?? 1;
    geo.cartesian3.clone(live, lastPosition);
    poseFrame = frameNumber;
    return camera;
  };
  const cameraView = new Proxy(camera, {
    get: (target, key) => freshCamera()[key],
  });
  const scene = {
    get camera() {
      return cameraView;
    },
    canvas: {
      get clientHeight() {
        return engine.host.size().height;
      },
    },
    frameState: {
      get frameNumber() {
        return frameNumber;
      },
    },
  };
  // Shared helpers project through the engine registered for their scene.
  removers.push(registerViewerEngine(scene, engine));
  const horizon = {
    isPointVisible: (position) => engine.projector.horizonVisible(position),
  };
  const scratchDelta = geo.cartesian3.create();
  let frustum = null;
  const inFrustum = (position) => {
    const { origin, direction, right, up, tanX, tanY } = frustum;
    geo.cartesian3.subtract(position, origin, scratchDelta);
    const z = geo.cartesian3.dot(scratchDelta, direction);
    if (z <= -1) return false;
    const x = Math.abs(geo.cartesian3.dot(scratchDelta, right));
    const y = Math.abs(geo.cartesian3.dot(scratchDelta, up));
    return x <= z * tanX + 1 && y <= z * tanY + 1;
  };
  const view = {
    get camera() {
      return cameraView;
    },
    scene,
    surfaceOwner: engine,
    surfaceScene: engine,
    frameNumber: () => frameNumber,
    viewportHeightPx: () => engine.host.size().height,
    frustumTester() {
      const cam = freshCamera();
      const tanY = Math.tan(cam.frustum.fovy / 2);
      const { width, height } = engine.host.size();
      frustum = {
        origin: cam.positionWC,
        direction: cam.directionWC,
        right: cam.rightWC,
        up: cam.upWC,
        tanY,
        tanX: tanY * (height > 0 ? width / height : 1),
      };
      return inFrustum;
    },
    horizon: () => horizon,
    worldToWindow: (position, result) =>
      engine.projector.worldToWindow(position, result),
    requestRender: () => engine.render.request(layerId),
    on(event, listener) {
      const source =
        event === 'moveEnd'
          ? engine.camera.moveEnd
          : event === 'preRender'
            ? engine.frames.preRender
            : event === 'preUpdate'
              ? engine.frames.preUpdate
              : null;
      if (!source) return null;
      return source.addEventListener((...args) =>
        inFrameDo(() => listener(...args)),
      );
    },
    isDestroyed: () => destroyed || engine.isDestroyed?.() === true,
    holdFrames() {},
    closeFrameLatch() {},
    releaseFrames() {},
  };

  // --- fleet sprites ---------------------------------------------------------
  let atlas = null;
  let fleetVisible = true;
  const spriteBanks = new Map();
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
  const spriteBankFor = (sprite) => {
    if (!atlas) return null;
    const depth = depthKey(sprite.disableDepthTestDistance);
    const key = `${scalarKey(sprite.scaleByDistance)}|${JSON.stringify(depth)}`;
    let bank = spriteBanks.get(key);
    if (!bank) {
      const scalar = sprite.scaleByDistance;
      const index = spriteBanks.size;
      bank = createMoverBank(engine, {
        options: (capacity, generation) => ({
          id: `${layerId}-sprites-${index}-${generation}`,
          kind: 'sprite',
          capacity,
          order,
          depthTest: depth,
          pickable: true,
          sprite: {
            atlas,
            sizePx: BASE_SIZE_PX,
            scaleByDistance: scalar
              ? [scalar.near, scalar.nearValue, scalar.far, scalar.farValue]
              : undefined,
          },
        }),
        write: spriteWrite,
        onCommit,
      });
      bank.setVisible(fleetVisible);
      spriteBanks.set(key, bank);
    }
    return bank;
  };
  const placeSprite = (sprite) => {
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
      for (const sprite of waiting) if (sprite.live) placeSprite(sprite);
      for (const sprite of trackedSprites)
        if (sprite.live) placeTracked(sprite);
      engine.render.request(layerId);
    })
    .catch((error) =>
      console.warn(`[${layerId}] aircraft atlas failed`, error),
    );

  class Sprite {
    constructor(spec, bankFor) {
      this.gevBank = null;
      this.gevIndex = -1;
      this.live = true;
      this.bankFor = bankFor;
      this._position = geo.cartesian3.clone(
        spec.position ?? geo.cartesian3.ZERO,
      );
      this._show = spec.show !== false;
      this._rotation = spec.rotation ?? 0;
      this._scale = spec.scale ?? 1;
      this._width = spec.width ?? BASE_SIZE_PX;
      this._height = spec.height ?? BASE_SIZE_PX;
      this._color = new StoredColor(spec.color);
      this._image = spec.image;
      this.cell = iconCells.get(spec.image) ?? iconCells.get(defaultIcon);
      this._scaleByDistance = spec.scaleByDistance
        ? { ...spec.scaleByDistance }
        : undefined;
      this.disableDepthTestDistance = spec.disableDepthTestDistance ?? 0;
      this.id = spec.id;
      this.alignedAxis = spec.alignedAxis;
      this.sizeInMeters = false;
    }

    drawnScale() {
      return Math.max(0, this._scale * (this._width / BASE_SIZE_PX));
    }

    write(fields) {
      this.gevBank?.update(this, fields);
    }

    get position() {
      return this._position;
    }

    set position(value) {
      geo.cartesian3.clone(value, this._position);
      this.write({ position: this._position });
    }

    get show() {
      return this._show;
    }

    set show(value) {
      this._show = value !== false;
      this.write({ show: this._show });
    }

    get rotation() {
      return this._rotation;
    }

    set rotation(value) {
      this._rotation = value;
      this.write({ rotation: value });
    }

    get scale() {
      return this._scale;
    }

    set scale(value) {
      this._scale = value;
      this.write({ scale: this.drawnScale() });
    }

    get width() {
      return this._width;
    }

    set width(value) {
      this._width = value;
      this.write({ scale: this.drawnScale() });
    }

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
      this._color = new StoredColor(value);
      this.write({ color: rgbaOf(this._color) });
    }

    get image() {
      return this._image;
    }

    set image(value) {
      this._image = value;
      const cell = iconCells.get(value);
      if (!cell || cell === this.cell) return;
      this.cell = cell;
      this.write({ cell });
    }

    get scaleByDistance() {
      return this._scaleByDistance;
    }

    set scaleByDistance(value) {
      const next = value ? { ...value } : undefined;
      if (scalarKey(next) === scalarKey(this._scaleByDistance)) return;
      this._scaleByDistance = next;
      // Another distance scale is another set.
      if (this.gevBank) this.bankFor(this);
    }
  }

  const fleet = {
    attach() {},
    detach() {
      for (const bank of spriteBanks.values()) bank.destroy();
      spriteBanks.clear();
      unbanked.clear();
    },
    attached: () => !destroyed,
    visible: () => !destroyed && fleetVisible,
    setVisible(visible) {
      fleetVisible = visible;
      for (const bank of spriteBanks.values()) bank.setVisible(visible);
    },
    add(spec) {
      const sprite = new Sprite(spec, (s) => placeSprite(s));
      placeSprite(sprite);
      return sprite;
    },
    remove(sprite) {
      if (!sprite) return;
      sprite.live = false;
      unbanked.delete(sprite);
      sprite.gevBank?.remove(sprite);
    },
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

  class ModelHandle {
    constructor(spec) {
      this.spec = spec;
      this.gevBank = null;
      this.gevIndex = -1;
      this.placed = false;
      this._show = true;
      this._scale = spec.scale ?? 1;
      this._color = new StoredColor(spec.color);
      this.id = spec.id;
      this.modelMatrix = geo.matrix4.create();
      this.translation = geo.cartesian3.create();
      this.orientation = geo.quaternion.create(0, 0, 0, 1);
      this.radiusM = spec.radiusM ?? 1;
    }

    get ready() {
      return this.placed && Boolean(this.gevBank?.ready());
    }

    /** The scale drawn: Cesium's minimumPixelSize kept on the CPU. */
    get computedScale() {
      const minimum = this.spec.minimumPixelSize ?? 0;
      if (!(minimum > 0)) return this._scale;
      const cam = freshCamera();
      const distance = geo.cartesian3.distance(
        cam.positionWC,
        this.translation,
      );
      const height = engine.host.size().height;
      if (!(distance > 0) || !(height > 0)) return this._scale;
      const pixels =
        (2 * this.radiusM * this._scale * height) /
        (2 * Math.tan(cam.frustum.fovy / 2) * distance);
      return pixels < minimum ? this._scale * (minimum / pixels) : this._scale;
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
      this._color = new StoredColor(value);
      this.gevBank?.update(this, { color: rgbaOf(this._color) });
    }
  }

  const models = {
    live: () => !destroyed,
    setVisible(visible) {
      modelsVisible = visible;
      for (const bank of modelBanks.values()) bank.setVisible(visible);
    },
    loadFleet: (spec) => Promise.resolve(new ModelHandle(spec)),
    loadTracked: (spec) => Promise.resolve(new ModelHandle(spec)),
    // The engine loads each glTF once per bank; nothing to warm.
    preload: (url) => Promise.resolve({ url, destroy() {} }),
    add(model) {
      modelBankFor(model).add(model);
    },
    remove(model) {
      model?.gevBank?.remove(model);
    },
    destroy(model) {
      model?.gevBank?.remove(model);
    },
    /** The same HPR frame as Cesium (modelMatrix); the instance turned by
     *  Navara's glTF axes (NAVARA_GLTF_AXIS). */
    setPose(model, position, headingDeg) {
      scratchHpr.heading = geo.math.toRadians(
        (headingDeg || 0) + headingOffsetDeg,
      );
      geo.transforms.headingPitchRollToFixedFrame(
        position,
        scratchHpr,
        geo.ellipsoid.WGS84,
        undefined,
        model.modelMatrix,
      );
      geo.matrix4.multiplyTransformation(
        model.modelMatrix,
        NAVARA_GLTF_AXIS,
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
  let trackedBank = null;
  const trackedBankFor = () => {
    if (!atlas) return null;
    trackedBank ??= createMoverBank(engine, {
      options: (capacity, generation) => ({
        id: `${layerId}-tracked-${generation}`,
        kind: 'sprite',
        capacity: Math.max(capacity, 4),
        order: order + 0.5,
        depthTest: 'always',
        pickable: true,
        sprite: {
          atlas,
          sizePx: BASE_SIZE_PX,
          scaleByDistance: [1000, 3.0, 8000000, 0.5],
        },
      }),
      write: spriteWrite,
      onCommit,
    });
    return trackedBank;
  };
  const placeTracked = (sprite) => trackedBankFor()?.add(sprite);
  let trackedSeq = 0;
  // Each frame (before drawing): the tracked glyphs read their callbacks.
  removers.push(
    engine.frames.preRender.addEventListener(() =>
      inFrameDo(() => {
        for (const sprite of trackedSprites) {
          const { spec } = sprite;
          const position = spec.position();
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
          disableDepthTestDistance: spec.disableDepthTestDistance,
          id: `${layerId}-tracked-${++trackedSeq}`,
        },
        () => {},
      );
      // The tracked glyph's distance scale is its bank's (as Cesium's).
      sprite._scaleByDistance = spec.scaleByDistance;
      sprite.spec = spec;
      sprite.viewFrom = null;
      trackedSprites.add(sprite);
      placeTracked(sprite);
      return sprite;
    },
    remove(handle) {
      if (!handle) return;
      handle.live = false;
      trackedSprites.delete(handle);
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
  const ownFollows = new WeakMap(); // follow handle → tracked handle
  // The follow carries the tracked readout's card as plain data (the
  // handle's annotation fields, read when the card paints).
  const followOf = (handle) => {
    const card = {
      id: handle.gevTrackedId,
      model: () => handle.gevLabelModel,
      position: () => handle.gevDisplayPosition?.() ?? handle.spec.position(),
    };
    return engine.camera.follow({
      position: () => handle.spec.position(),
      viewFrom: () => handle.viewFrom,
      label: card,
    });
  };
  // The tracked handle whose follow is being started: the engine raises
  // followChanged inside follow(), before the handle is known here.
  let starting = null;
  const follow = {
    start(handle) {
      starting = handle;
      let followHandle;
      try {
        followHandle = followOf(handle);
      } finally {
        starting = null;
      }
      handle.gevFollowHandle = followHandle;
      ownFollows.set(followHandle, handle);
      // Cesium returns the one-frame camera framing's disposer; the engine's
      // follow frames itself.
      return () => {};
    },
    refocus(handle) {
      return follow.start(handle);
    },
    release() {
      engine.camera.following()?.stop();
    },
    isFollowing: (handle) =>
      Boolean(handle?.gevFollowHandle) &&
      engine.camera.following() === handle.gevFollowHandle,
    current() {
      if (starting) return starting;
      const handle = engine.camera.following();
      return handle ? (ownFollows.get(handle) ?? handle) : undefined;
    },
    onChanged: (listener) =>
      engine.camera.followChanged.addEventListener(listener),
  };

  // --- trails ----------------------------------------------------------------
  let lineSeq = 0;
  const rgbaFromCss = (css) => {
    const hex = String(css).replace('#', '');
    return [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  };
  const trails = {
    create({ color, width = 2.5 }) {
      const [r, g, b] = rgbaFromCss(color);
      const id = `gev-trail:${layerId}-${++lineSeq}`;
      let line = null;
      let visible = true;
      let current = [];
      const ensure = () =>
        (line ??= engine.lines.createLine({
          id,
          widthPx: width,
          color: [r, g, b, TRAIL_ALPHA],
          depthFailAlpha: TRAIL_OCCLUDED_ALPHA / TRAIL_ALPHA,
          arc: 'geodesic',
          pickId: id,
        }));
      return {
        setPositions(cartesians) {
          if (destroyed) return;
          const positions = [];
          for (const position of Array.isArray(cartesians) ? cartesians : []) {
            if (!position) continue;
            const last = positions[positions.length - 1];
            if (
              last &&
              geo.cartesian3.distanceSquared(last, position) <
                MIN_SEGMENT_DISTANCE_SQ
            )
              continue;
            positions.push(position);
          }
          current = positions.length >= 2 ? positions : [];
          ensure().setPositions(current);
          line.show(visible);
        },
        setVisible(next) {
          visible = next !== false;
          line?.show(visible);
        },
        clear() {
          current = [];
          line?.setPositions(current);
        },
        destroy() {
          line?.destroy();
          line = null;
        },
      };
    },
    createHead({ id, show, positions, color, width = 2.5 }) {
      const [r, g, b] = rgbaFromCss(color);
      const line = engine.lines.createLine({
        id: `${id}`,
        widthPx: width,
        color: [r, g, b, 0.9],
        depthFailAlpha: 0.5,
        arc: 'geodesic',
        pickId: id,
      });
      let shown = show !== false;
      line.show(shown);
      const remove = engine.frames.preRender.addEventListener(() => {
        if (!shown) return;
        line.setPositions(positions());
      });
      return {
        id,
        get show() {
          return shown;
        },
        set show(value) {
          shown = value !== false;
          line.show(shown);
        },
        remove() {
          remove();
          line.destroy();
        },
      };
    },
    removeHead(head) {
      head?.remove();
    },
  };

  return {
    kind: 'navara',
    engine,
    view,
    fleet,
    models,
    tracked,
    follow,
    trails,
    /** The atlas is drawn (tests, QA). */
    whenReady: () => atlasReady,
    /** A vertical surface probe skips the layer's own mover sets (by id). */
    surfaceExclusions: () =>
      [...spriteBanks.values(), ...modelBanks.values(), trackedBank]
        .map((bank) => bank?.set?.id)
        .filter(Boolean),
    destroy() {
      if (destroyed) return;
      flush();
      destroyed = true;
      for (const remove of removers.splice(0)) remove?.();
      fleet.detach();
      for (const bank of modelBanks.values()) bank.destroy();
      modelBanks.clear();
      trackedBank?.destroy();
      trackedBank = null;
      trackedSprites.clear();
    },
  };
}

// The glyph atlas helpers, re-exported for tests.
export { aircraftIconAtlasLayout as aircraftAtlasLayout, aircraftIconCells };
