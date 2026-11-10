/**
 * Scene-geometry occlusion for detection contacts.
 *
 * The overlay's own horizon test only knows about the Earth's curve. A contact
 * whose marker the scene depth-tests (a street vehicle's dot) can still sit
 * behind a building, a 3D tile or a hill, and painting its bracket and callout
 * there puts a label on the facade in front of it.
 *
 * The fix compares each such contact with what the renderer actually drew: if
 * the drawn surface along the contact's ray is nearer than the contact by more
 * than a small margin, something stands in front of it and its bracket and
 * callout are not drawn. `sceneOcclusionProbe.js` runs that comparison on the
 * GPU, against the frame's own depth, and hands back a yes or no per contact a
 * frame or two later without ever waiting on the GPU. This file holds the
 * arithmetic both sides share and the per-contact memory of the answers.
 *
 * Only contacts that opt in with `depthTested: true` are tested: the ones whose
 * marker the scene itself hides behind geometry. Everything else keeps its
 * label exactly as before, which covers contacts high above the ground
 * (aircraft, satellites): their markers are drawn on top of the scene by
 * design, their 3D models can be scaled up to a minimum pixel size and so fill
 * the very pixel being read, and a label that hid while its marker stayed on
 * screen would be the worse mismatch.
 *
 * This file is plain arithmetic; it never touches the renderer.
 */

/** Never less than this: covers a dot drawn a little above or into its road. */
export const SURFACE_OCCLUSION_MIN_MARGIN_M = 3;
/** The most the margin grows with range: 2% of it. */
export const SURFACE_OCCLUSION_MARGIN_FRACTION = 0.02;
/**
 * How far above a contact a drawn surface on its line of sight must stand to
 * count as in front of it, when the camera looks down on the contact.
 */
export const SURFACE_OCCLUSION_RISE_M = 2;

/**
 * How much nearer than the contact the drawn surface must be before it counts
 * as standing in front of it.
 *
 * The margin absorbs a contact placed a little above or below the drawn
 * ground: a vehicle's position and the scene's road surface are not the same
 * height to the metre. Looking down at the contact, a point on its line of
 * sight `s` metres in front of it stands `s * sinElevation` metres above it,
 * so a surface there only hides the contact once `s` passes
 * `SURFACE_OCCLUSION_RISE_M / sinElevation`. That keeps the margin to a few
 * metres from above, where a fixed share of the range would let a wall,
 * awning or tree 10 to 20 m in front of a street at 1 km pass as "the road".
 * At grazing angles, or looking up, the margin is 2% of the range at most
 * (never under 3 m); depth precision is far finer than that at every range
 * the overlay labels.
 *
 * @param {number} contactDistance Camera-to-contact distance in metres.
 * @param {number} [sinElevation] Sine of the camera's elevation seen from the
 *   contact (1 straight overhead, 0 level, negative below); unknown when
 *   omitted.
 * @returns {number} Margin in metres.
 */
export function surfaceOcclusionMargin(contactDistance, sinElevation = 0) {
  const distance = Number(contactDistance);
  if (!(distance > 0)) return SURFACE_OCCLUSION_MIN_MARGIN_M;
  let margin = distance * SURFACE_OCCLUSION_MARGIN_FRACTION;
  const rise = Number(sinElevation);
  if (rise > 0) margin = Math.min(margin, SURFACE_OCCLUSION_RISE_M / rise);
  return Math.max(SURFACE_OCCLUSION_MIN_MARGIN_M, margin);
}

/**
 * Whether a drawn surface hides a contact.
 * @param {number} contactDistance Camera-to-contact distance in metres.
 * @param {number|undefined} surfaceDistance Camera-to-drawn-surface distance
 *   along the contact's ray; undefined or non-finite when nothing was drawn.
 * @param {number} [sinElevation] See `surfaceOcclusionMargin`.
 * @returns {boolean}
 */
export function surfaceHidesContact(
  contactDistance,
  surfaceDistance,
  sinElevation = 0,
) {
  if (!Number.isFinite(contactDistance) || !Number.isFinite(surfaceDistance))
    return false;
  return (
    surfaceDistance <
    contactDistance - surfaceOcclusionMargin(contactDistance, sinElevation)
  );
}

/**
 * Unpack a depth the renderer stored across the four bytes of an RGBA8 texel
 * (most significant byte first, each byte a base-255 digit).
 * @param {ArrayLike<number>} bytes
 * @param {number} offset Index of the texel's red byte.
 * @returns {number} Window-space depth in [0, 1].
 */
export function unpackDepth(bytes, offset) {
  return (
    bytes[offset] / 255 +
    bytes[offset + 1] / 65025 +
    bytes[offset + 2] / 16581375 +
    bytes[offset + 3] / 4228250625
  );
}

/**
 * Convert a window-space depth to the distance in front of the camera, measured
 * along the view direction, for one depth range ("frustum") of the frame.
 *
 * Logarithmic depth stores `log2(z - near + 1) / log2(far - near + 1)`.
 * Standard perspective depth stores `far * (z - near) / (z * (far - near))`.
 *
 * @param {number} depth Window-space depth in [0, 1].
 * @param {number} near Near plane of the range, metres.
 * @param {number} far Far plane of the range, metres.
 * @param {boolean} logDepth Whether the frame was drawn with logarithmic depth.
 * @returns {number} Metres along the view direction, or NaN where the range
 *   drew nothing (depth at or outside the ends of [0, 1]).
 */
export function depthToViewDistance(depth, near, far, logDepth) {
  if (!(depth > 0) || !(depth < 1)) return Number.NaN;
  if (!(near > 0) || !(far > near)) return Number.NaN;
  if (logDepth)
    return near + Math.pow(2, depth * Math.log2(far - near + 1)) - 1;
  return (near * far) / (far - depth * (far - near));
}

/**
 * Where a world position falls in a frame, and how near a drawn surface has to
 * be there to hide it.
 *
 * A surface hides the contact when its distance along the contact's ray is
 * under the contact's own distance less the margin. Along one ray, distance
 * and view distance (depth in front of the camera) are in a fixed ratio, so
 * the same rule reads: the surface's view distance is under
 * `viewDistance * (1 - margin / contactDistance)`. That number is `threshold`,
 * and comparing a decoded depth with it is all the GPU has to do.
 *
 * The margin depends on how steeply the camera looks down on the contact
 * (see `surfaceOcclusionMargin`). "Up" at the contact is taken as the
 * direction from the world origin to it, which is the Earth's centre in the
 * Earth-fixed frame the scene is drawn in; it differs from the true vertical
 * by a fraction of a degree at most.
 *
 * @param {ArrayLike<number>} view World-to-camera matrix, column-major, the
 *   camera looking down its own -Z axis.
 * @param {number} tanHalfFovX
 * @param {number} tanHalfFovY
 * @param {{x: number, y: number, z: number}} position
 * @param {{u: number, v: number, threshold: number}} out `u`, `v` in [0, 1)
 *   from the bottom-left corner of the frame.
 * @returns {boolean} False when the position is behind the camera or outside
 *   the frame; `out` is then untouched.
 */
export function projectContact(view, tanHalfFovX, tanHalfFovY, position, out) {
  const { x, y, z } = position;
  const viewDistance = -(view[2] * x + view[6] * y + view[10] * z + view[14]);
  if (!(viewDistance > 0)) return false;
  const ex = view[0] * x + view[4] * y + view[8] * z + view[12];
  const ey = view[1] * x + view[5] * y + view[9] * z + view[13];
  const u = (ex / (viewDistance * tanHalfFovX)) * 0.5 + 0.5;
  const v = (ey / (viewDistance * tanHalfFovY)) * 0.5 + 0.5;
  if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) return false;
  const contactDistance = Math.sqrt(
    ex * ex + ey * ey + viewDistance * viewDistance,
  );
  // Up at the contact, turned into camera axes, against the direction from
  // the contact to the camera (-ex, -ey, viewDistance in camera axes).
  const radius = Math.sqrt(x * x + y * y + z * z);
  let sinElevation = 0;
  if (radius > 0) {
    const ux = (view[0] * x + view[4] * y + view[8] * z) / radius;
    const uy = (view[1] * x + view[5] * y + view[9] * z) / radius;
    const uz = (view[2] * x + view[6] * y + view[10] * z) / radius;
    sinElevation = (-ux * ex - uy * ey + uz * viewDistance) / contactDistance;
  }
  out.u = u;
  out.v = v;
  out.threshold =
    viewDistance *
    (1 -
      surfaceOcclusionMargin(contactDistance, sinElevation) / contactDistance);
  return true;
}

/**
 * One frame of depth read back to memory, with the camera it was drawn from.
 * Only the synchronous fallback uses this (see `sceneOcclusionProbe.js`); the
 * normal path never copies depth off the GPU.
 *
 * `bytes` holds `frustums.length` stacked images of `width` x `height` RGBA8
 * texels, nearest depth range first, rows bottom to top (the order the
 * graphics API reads them back in).
 */
export class DepthSnapshot {
  /**
   * @param {{
   *   width: number, height: number, bytes: Uint8Array,
   *   frustums: Array<{near: number, far: number}>, logDepth: boolean,
   *   view: ArrayLike<number>, tanHalfFovX: number, tanHalfFovY: number,
   * }} fields
   */
  constructor(fields) {
    this.width = fields.width;
    this.height = fields.height;
    this.bytes = fields.bytes;
    this.frustums = fields.frustums;
    this.logDepth = fields.logDepth === true;
    this.view = fields.view;
    this.tanHalfFovX = fields.tanHalfFovX;
    this.tanHalfFovY = fields.tanHalfFovY;
    this._projected = { u: 0, v: 0, threshold: 0 };
  }

  /**
   * Distance along the view direction to the nearest surface drawn at a texel.
   * @param {number} column
   * @param {number} row Counted from the bottom of the frame.
   * @returns {number} Metres, or NaN where nothing was drawn.
   */
  surfaceViewDistance(column, row) {
    const { width, height, bytes, frustums, logDepth } = this;
    const texel = (row * width + column) * 4;
    const layer = width * height * 4;
    for (let i = 0; i < frustums.length; i++) {
      const distance = depthToViewDistance(
        unpackDepth(bytes, i * layer + texel),
        frustums[i].near,
        frustums[i].far,
        logDepth,
      );
      if (distance === distance) return distance;
    }
    return Number.NaN;
  }

  /**
   * Whether the frame drew something in front of a world position.
   * @param {{x: number, y: number, z: number}} position
   * @returns {boolean|null} Null when the position is outside the frame.
   */
  hides(position) {
    const projected = this._projected;
    if (
      !projectContact(
        this.view,
        this.tanHalfFovX,
        this.tanHalfFovY,
        position,
        projected,
      )
    )
      return null;
    return (
      this.surfaceViewDistance(
        Math.floor(projected.u * this.width),
        Math.floor(projected.v * this.height),
      ) < projected.threshold
    );
  }
}

/**
 * A contact is tested again at most this long, and at least half this long,
 * after its last test was started, so a view full of contacts spreads its
 * tests over about ten frames instead of repeating all of them on every one.
 * With more contacts in view than the probe's per-frame budget can serve at
 * that pace, the interval stretches (see `SurfaceOcclusion.beginFrame`).
 */
export const SURFACE_RETEST_MS = 200;

/**
 * A contact stays hidden at least this long after the last test that found it
 * hidden, and never less than three retest intervals.
 *
 * Going behind something takes effect as soon as the answer arrives. Coming
 * back takes several visible answers in a row, so a contact on a silhouette
 * edge, which tests either way from one frame to the next while the camera
 * orbits, stays off instead of blinking. It is also the clean failure: when
 * answers stop arriving (no depth to test against) every contact is drawn
 * again within this time, exactly as before this test existed.
 */
export const SURFACE_REAPPEAR_MS = 600;

/**
 * A contact that has never had an answer is held back this long, at most,
 * while a working probe gets it one.
 *
 * A contact new to the view would otherwise be drawn for the frame or two its
 * first test takes, and then vanish if it turned out to be behind something:
 * a camera orbiting a city would flash a bracket for every vehicle that
 * swings into the frame behind a building. With no working probe nothing is
 * held back, and past this time the contact is drawn whatever happens.
 */
export const SURFACE_FIRST_ANSWER_MS = 400;

/**
 * The most one frame advances the occlusion clock.
 *
 * Every interval above is measured on a clock that only runs while the
 * overlay is painting: each painted frame moves it on by the time since the
 * last one, but never by more than this. Answers only arrive while frames are
 * painted, so on a wall clock a pause (a hidden tab, a scene with nothing to
 * redraw) would run out every "hidden" at once and the first frame afterwards
 * would paint every label over the buildings again until fresh answers came.
 * On this clock a pause of any length counts as one slow frame.
 */
export const SURFACE_MAX_FRAME_STEP_MS = 50;

/** A contact not drawn for this long is forgotten. */
export const SURFACE_FORGET_MS = 2000;

/**
 * What is remembered about one contact.
 * @typedef {{lastHiddenAt: number, hiddenUntil: number, appliedHiddenAt: number,
 *   queuedAt: number, pending: boolean, answered: boolean, firstSeenAt: number,
 *   seenAt: number}} SurfaceContact Times are on the occlusion clock.
 */

/**
 * Per-contact occlusion answers, and the schedule that keeps them fresh.
 *
 * `probe` is whatever tests a contact against the drawn scene. It has
 * `add(contact, position)`, which starts a test (setting `contact.pending`)
 * and returns false when it cannot take one now, and it reports back by
 * clearing `contact.pending`, setting `contact.answered` and, when the
 * contact was hidden, setting `contact.lastHiddenAt`. `probe.maxPerFrame`, if
 * set, is how many tests it takes in one frame; `probe.mode` reads `'async'`
 * while answers come a frame or two after the test.
 */
export class SurfaceOcclusion {
  /**
   * @param {{add: (contact: SurfaceContact, position: object) => boolean}} probe
   */
  constructor(probe) {
    this.probe = probe;
    /** @type {Map<string, Map<*, SurfaceContact>>} Layer id -> source id. */
    this.contacts = new Map();
    /**
     * The occlusion clock, in milliseconds of painted time (see
     * `SURFACE_MAX_FRAME_STEP_MS`). The probe must date its answers by it.
     */
    this.now = 0;
    this._wall = Number.NEGATIVE_INFINITY;
    /** Depth-tested contacts drawn or hidden this frame. */
    this.testedCount = 0;
    this.hiddenCount = 0;
    this.retestMs = SURFACE_RETEST_MS;
    this.reappearMs = SURFACE_REAPPEAR_MS;
    this.firstAnswerMs = SURFACE_FIRST_ANSWER_MS;
    this._phase = 0;
  }

  /**
   * Open a frame and move the occlusion clock on.
   * @param {number} wallNow Monotonic milliseconds.
   */
  beginFrame(wallNow) {
    // Contacts arrive in the same order every frame and the probe takes only
    // so many, so if more fell due per frame than it takes, the ones at the
    // end of the order would never be tested. Pace the retests to what the
    // last frame showed the probe can keep up with: all of the contacts, once
    // per interval, with a third of the budget to spare.
    const elapsed = wallNow - this._wall;
    const frameMs =
      elapsed > 0 ? Math.min(SURFACE_MAX_FRAME_STEP_MS, elapsed) : 0;
    this._wall = wallNow;
    const budget = Number(this.probe.maxPerFrame) || Number.POSITIVE_INFINITY;
    this.retestMs = Math.max(
      SURFACE_RETEST_MS,
      (this.testedCount / budget) * frameMs * 2,
    );
    this.reappearMs = Math.max(SURFACE_REAPPEAR_MS, this.retestMs * 3);
    // At a stretched pace a crowd of new contacts takes longer to get its
    // first answers; the hold-back stretches with it.
    this.firstAnswerMs = Math.max(SURFACE_FIRST_ANSWER_MS, this.retestMs * 2);
    this.now += frameMs;
    this.testedCount = 0;
    this.hiddenCount = 0;
  }

  /**
   * Whether a contact's bracket and callout should be left out of this frame.
   * Starts a fresh test of the contact when one is due.
   * @param {string} layerId
   * @param {*} sourceId
   * @param {{x: number, y: number, z: number}} position
   * @returns {boolean}
   */
  isHidden(layerId, sourceId, position) {
    const now = this.now;
    let layer = this.contacts.get(layerId);
    if (!layer) {
      layer = new Map();
      this.contacts.set(layerId, layer);
    }
    let contact = layer.get(sourceId);
    if (!contact || now - contact.seenAt > this.retestMs) {
      // New, or back in view after longer than a retest interval. A returning
      // contact's last answer is older than any contact that stayed in view
      // runs on, and the view has probably turned since: it is held back
      // like a new one until a fresh answer comes, or orbiting flashes it
      // behind the building it went behind while out of view. It gets a new
      // record, so a test still in flight from before answers the old one
      // and cannot end the hold-back with what the previous view showed. A
      // "hidden" it already had keeps running.
      contact = {
        lastHiddenAt: contact?.lastHiddenAt ?? Number.NEGATIVE_INFINITY,
        hiddenUntil: contact?.hiddenUntil ?? Number.NEGATIVE_INFINITY,
        appliedHiddenAt: contact?.appliedHiddenAt ?? Number.NEGATIVE_INFINITY,
        queuedAt: Number.NEGATIVE_INFINITY,
        pending: false,
        answered: false,
        firstSeenAt: now,
        seenAt: now,
      };
      layer.set(sourceId, contact);
    }
    contact.seenAt = now;
    this.testedCount++;
    if (
      !contact.pending &&
      now - contact.queuedAt >= this.retestMs &&
      this.probe.add(contact, position)
    ) {
      // Contacts that came into view together would otherwise all fall due on
      // the same frames for ever. Each test backdates itself by a different
      // part of half the interval, which spreads them out within a second.
      contact.queuedAt = now - this.retestMs * 0.5 * this._phase;
      this._phase = (this._phase + 0.618034) % 1;
    }
    // A new "hidden" answer sets when the contact may come back, once, with
    // the pace in force now. A later change of pace must not bring back a
    // "hidden" that has already run out.
    if (contact.lastHiddenAt !== contact.appliedHiddenAt) {
      contact.appliedHiddenAt = contact.lastHiddenAt;
      contact.hiddenUntil = contact.lastHiddenAt + this.reappearMs;
    }
    const hidden =
      now < contact.hiddenUntil ||
      // Not yet answered: held back while a working probe finds out.
      (!contact.answered &&
        this.probe.mode === 'async' &&
        now - contact.firstSeenAt < this.firstAnswerMs);
    if (hidden) this.hiddenCount++;
    return hidden;
  }

  /** Forget contacts that are no longer drawn. */
  prune() {
    for (const [layerId, layer] of this.contacts) {
      for (const [sourceId, contact] of layer) {
        if (this.now - contact.seenAt > SURFACE_FORGET_MS)
          layer.delete(sourceId);
      }
      if (layer.size === 0) this.contacts.delete(layerId);
    }
  }

  /** Forget every contact (mode off, viewer swap). */
  clear() {
    this.contacts.clear();
    this.testedCount = 0;
    this.hiddenCount = 0;
  }
}
