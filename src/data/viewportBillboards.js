import * as Cesium from 'cesium';
import {
  acquireAircraftSurface,
  createTrackedAircraftSurface,
} from './aircraftSurface.js';

// Contact descriptors stay available to search, tracking and dead reckoning.
// Only the padded viewport gets heavyweight Cesium billboards/GPU attributes.
const FIELDS = [
  'position',
  'show',
  'image',
  'width',
  'height',
  'scale',
  'rotation',
  'alignedAxis',
  'color',
  'sizeInMeters',
  'scaleByDistance',
  'disableDepthTestDistance',
  'pixelOffset',
  'eyeOffset',
  'horizontalOrigin',
  'verticalOrigin',
  'translucencyByDistance',
  'pixelOffsetScaleByDistance',
  'distanceDisplayCondition',
  'id',
];

/** Test a world position against a padded projected viewport, rejecting points behind the camera. */
export function insidePaddedViewport(position, matrix, width, height, padding) {
  if (!position) return false;
  const { x, y, z } = position;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (!(w > 0)) return false;
  const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  return (
    Math.abs(clipX) <= w * (1 + (2 * padding) / width) &&
    Math.abs(clipY) <= w * (1 + (2 * padding) / height)
  );
}

function copy(value, previous) {
  return typeof value?.clone === 'function' ? value.clone(previous) : value;
}

class ContactBillboard {
  constructor(owner, options) {
    this._owner = owner;
    this._resident = null;
    this._inViewport = false;
    this._imageSource = options.image;
    this._values = {
      show: true,
      scale: 1,
      rotation: 0,
      color: Cesium.Color.clone(Cesium.Color.WHITE),
      position: new Cesium.Cartesian3(),
      ...options,
    };
    for (const key of FIELDS)
      if (this._values[key] !== undefined)
        this._values[key] = copy(this._values[key]);
  }

  get viewportVisible() {
    return Boolean(this._owner) && (!this._owner._hasView || this._inViewport);
  }

  // Literal property reads keep these hot accessors monomorphic. A shared
  // keyed getter across twenty different Cesium properties adds measurable
  // overhead when all ten thousand contacts are visible at once.
  get position() {
    return this._resident ? this._resident.position : this._values.position;
  }
  get show() {
    return this._resident ? this._resident.show : this._values.show;
  }
  get color() {
    return this._resident ? this._resident.color : this._values.color;
  }
  get scale() {
    return this._resident ? this._resident.scale : this._values.scale;
  }
  get rotation() {
    return this._resident ? this._resident.rotation : this._values.rotation;
  }
  get width() {
    return this._resident ? this._resident.width : this._values.width;
  }
  get height() {
    return this._resident ? this._resident.height : this._values.height;
  }
  get scaleByDistance() {
    return this._resident
      ? this._resident.scaleByDistance
      : this._values.scaleByDistance;
  }
  get id() {
    return this._resident ? this._resident.id : this._values.id;
  }

  _snapshot() {
    if (!this._resident) return;
    const values = {};
    for (const key of FIELDS) {
      const value = key === 'image' ? this._imageSource : this._resident[key];
      if (value !== undefined) values[key] = copy(value);
    }
    this._values = values;
  }
}

for (const key of FIELDS) {
  Object.defineProperty(ContactBillboard.prototype, key, {
    get:
      Object.getOwnPropertyDescriptor(ContactBillboard.prototype, key)?.get ||
      function () {
        return key === 'image'
          ? this._imageSource
          : this._resident
            ? this._resident[key]
            : this._values[key];
      },
    set(value) {
      if (this._owner) this._owner._surfaceRevision++;
      // The aircraft tick shares scratch Cartesians/Colors. Never retain those
      // scratch objects, whether this contact is resident or not.
      if (key === 'image') {
        if (this._imageSource !== value && this._owner)
          this._owner._pickWarm = true;
        this._imageSource = value;
      }
      if (this._resident) this._resident[key] = value;
      else this._values[key] = copy(value, this._values[key]);
      if (this._owner && (key === 'position' || key === 'show' || key === 'id'))
        this._owner._dirty = true;
    },
  });
}

/** Retain logical contacts while materializing native billboards only for the padded view and pinned subjects. */
export class ViewportBillboardCollection {
  constructor(
    viewer,
    {
      isPinned = () => false,
      createCollection = () => new Cesium.BillboardCollection(),
      enterPaddingPx = 128,
      keepPaddingPx = 256,
      screenSpaceEnabled,
      screenSpaceOrder = 0,
      screenSpaceDistanceScale,
      getTrackedEntity,
    } = {},
  ) {
    this._viewer = viewer;
    this._isPinned = isPinned;
    this._createCollection = createCollection;
    this._enterPadding = enterPaddingPx;
    this._keepPadding = keepPaddingPx;
    this._items = [];
    this._residentCount = 0;
    this._collection = null;
    this._show = true;
    this._dirty = true;
    this._destroyed = false;
    this._matrix = new Cesium.Matrix4();
    this._previousMatrix = null;
    this._width = 0;
    this._height = 0;
    this._hasView = false;
    this._pickWarm = true;
    this._surfaceRevision = 0;
    this._aircraftSurface =
      screenSpaceEnabled &&
      acquireAircraftSurface(
        viewer,
        screenSpaceEnabled,
        screenSpaceOrder,
        screenSpaceDistanceScale,
      );
    this._trackedSurface =
      this._aircraftSurface &&
      getTrackedEntity &&
      createTrackedAircraftSurface(
        viewer,
        getTrackedEntity,
        screenSpaceEnabled,
        screenSpaceOrder,
        screenSpaceDistanceScale,
      );
  }

  get length() {
    return this._items.length;
  }
  get renderedCount() {
    return this._collection?.length || 0;
  }
  get show() {
    return this._show;
  }
  set show(value) {
    this._show = value;
    this._dirty = true;
    if (!value) this._releaseResidents();
    if (!value) {
      this._trackedSurface?.reset();
    }
  }

  add(options = {}) {
    this._surfaceRevision++;
    const contact = new ContactBillboard(this, options);
    contact._index = this._items.length;
    this._items.push(contact);
    this._dirty = true;
    return contact;
  }

  get(index) {
    return this._items[index];
  }
  contains(contact) {
    return contact?._owner === this;
  }
  remove(contact) {
    if (!this.contains(contact)) return false;
    this._surfaceRevision++;
    if (contact._resident) {
      contact._snapshot();
      this._collection.remove(contact._resident);
      // Cesium retains pending-update references after remove(). Its length
      // getter compacts the collection, so count residents without rescanning.
      if (--this._residentCount === 0) this._collection.removeAll();
    }
    const last = this._items.pop();
    if (last !== contact) {
      this._items[contact._index] = last;
      last._index = contact._index;
    }
    contact._resident = null;
    contact._inViewport = false;
    contact._owner = null;
    this._dirty = true;
    return true;
  }

  removeAll() {
    this._releaseResidents();
    for (const item of this._items) item._owner = null;
    this._items.length = 0;
    this._dirty = true;
  }

  _releaseResidents() {
    this._aircraftSurface?.reset();
    for (const item of this._items) {
      item._snapshot();
      item._resident = null;
      item._inViewport = false;
    }
    if (this._collection && !this._collection.isDestroyed())
      this._collection.destroy();
    this._collection = null;
    this._residentCount = 0;
  }

  update(frameState) {
    try {
      this._updateFleet(frameState);
    } finally {
      // The tracked visual is above the fleet on the sharp surface. Emit its
      // native pick commands last as well, including overlapping dense views.
      this._trackedSurface?.update(frameState, this._show);
    }
  }

  _updateFleet(frameState) {
    if (!this._show || this._destroyed || this._items.length === 0) return;
    const camera = this._viewer.camera;
    const canvas = this._viewer.scene.canvas;
    const width = canvas?.clientWidth || canvas?.width || 1;
    const height = canvas?.clientHeight || canvas?.height || 1;
    const canProject =
      (frameState.mode == null ||
        frameState.mode === Cesium.SceneMode.SCENE3D) &&
      camera?.viewMatrix &&
      camera?.frustum?.projectionMatrix;
    if (canProject)
      Cesium.Matrix4.multiply(
        camera.frustum.projectionMatrix,
        camera.viewMatrix,
        this._matrix,
      );
    const changed =
      this._dirty ||
      width !== this._width ||
      height !== this._height ||
      !this._previousMatrix ||
      (canProject &&
        !Cesium.Matrix4.equals(this._matrix, this._previousMatrix));
    this._collection ??= this._createCollection();
    if (changed) {
      for (const contact of this._items) {
        const pinned = this._isPinned(contact.id);
        const inViewport =
          pinned ||
          !canProject ||
          insidePaddedViewport(
            contact.position,
            this._matrix,
            width,
            height,
            contact._inViewport ? this._keepPadding : this._enterPadding,
          );
        contact._inViewport = inViewport;
        const keep = pinned || (inViewport && contact.show !== false);
        if (keep && !contact._resident) {
          contact._resident = this._collection.add(contact._values);
          this._residentCount++;
          this._pickWarm = true;
          this._surfaceRevision++;
          // The resident billboard is the authoritative property store while
          // on screen; do not duplicate its Cartesians, Colors and scalars.
          contact._values = null;
        } else if (!keep && contact._resident) {
          contact._snapshot();
          this._collection.remove(contact._resident);
          if (--this._residentCount === 0) this._collection.removeAll();
          contact._resident = null;
          this._surfaceRevision++;
        }
      }
      this._previousMatrix = Cesium.Matrix4.clone(
        this._matrix,
        this._previousMatrix,
      );
      this._width = width;
      this._height = height;
      this._dirty = false;
      this._hasView = true;
    }
    const sharp = this._aircraftSurface?.accept(
      this._collection,
      this._surfaceRevision,
    );
    const colorPass = frameState.passes?.render && !frameState.passes.pick;
    // Once images are resident, position/color buffers only need uploading
    // when Cesium actually picks. Picking's own update flushes current values.
    if (sharp && colorPass && !this._pickWarm) return;
    const commandStart = frameState.commandList?.length;
    this._collection.update(frameState);
    if (this._collection.ready) this._pickWarm = false;
    // Native attributes/textures stay warm for exact Cesium picking. Only this
    // primitive's color commands are replaced, never a pick/depth pass.
    if (
      sharp &&
      frameState.passes?.render &&
      !frameState.passes.pick &&
      commandStart != null
    )
      frameState.commandList.length = commandStart;
  }

  isDestroyed() {
    return this._destroyed;
  }
  destroy() {
    if (this._destroyed) return;
    this.removeAll();
    this._trackedSurface?.destroy();
    this._aircraftSurface?.release();
    this._viewer = null;
    this._destroyed = true;
  }
}
