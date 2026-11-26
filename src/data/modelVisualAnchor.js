/**
 * Model-space anchors on the aircraft layers' fleet models: where brackets
 * and readouts sit (a model's visual centre) and where a tracked trail
 * attaches (its aft-belly point, measured per model in fleetTrailAnchors.js
 * and handed to the layers with each model's spec by fleetModels.js).
 *
 * Values are native model units in raw glTF axes; the trail anchors are
 * turned into the placed model's frame here (`gltfToPlacedAxes`), so the
 * layer's ENU placement applies to them. A fleet model's visual centre is its
 * origin. Callers supply the scale the model is drawn at (`modelDrawnScale`),
 * which the placement does not carry and which the pixel floor may raise
 * above `scale`.
 */

/**
 * How a model's raw glTF axes land in its placed frame, as the renderer
 * draws a glTF model (`ModelItem`: Y-up, turned to Z-up, nose along the
 * frame's own axis): raw glTF `[x, y, z]` becomes `[z, x, y]` in the frame
 * `orientation` places. modelScale.test.mjs pins it against the Cesium
 * renderer's own axis correction.
 * @param {readonly number[]} v Raw glTF `[x, y, z]`.
 * @returns {number[]} `[x, y, z]` in the placed frame.
 */
export const gltfToPlacedAxes = (v) => [v[2] || 0, v[0] || 0, v[1] || 0];

/**
 * World position of a model-local anchor, through the same chain the model
 * is drawn with: its placement `matrix` (column-major, the frame the layer
 * posed it in) after the glTF axis turn (`gltfToPlacedAxes`), at the scale
 * it is drawn at.
 *
 * This exists because doing it by hand got it wrong. The anchors used to be
 * stored after a single glTF Y-up -> Z-up step (`[x, y, z]` -> `[x, -z, y]`) and
 * multiplied straight by the placement. That is only half of the turn: the
 * full one maps raw glTF `[x, y, z]` -> `[z, x, y]`. The aircraft's
 * longitudinal axis is raw glTF X, so the old conversion put the aft offset on
 * the RENDERED model's lateral axis — a 90-degree disagreement. Because the
 * placement carries the heading, both frames rotated together and the offset
 * came out sideways in world space, flipping which side it appeared on as the
 * course changed. Measured on the live rig at N/E/S/W plus a helicopter: the
 * old path put 81.47 m of a civil airliner's anchor entirely on cross-track
 * with 0 aft, at every heading; this path puts 81.47 m aft with 0 cross.
 *
 * The anchors are therefore stored in RAW glTF coordinates and turned here,
 * so exactly one convention stands between the table and the world.
 *
 * @param {ArrayLike<number>|null|undefined} matrix Where the model is placed.
 * @param {readonly number[]} nativeAnchor Raw glTF `[x, y, z]` native-unit offset.
 * @param {number} scale The scale the model is drawn at (`modelDrawnScale`).
 * @param {{x:number,y:number,z:number}} result Mutable Cartesian-like result.
 * @returns {{x:number,y:number,z:number}|null} World position of the anchor.
 */
export function modelAnchorWorld(matrix, nativeAnchor, scale, result) {
  if (!matrix || !nativeAnchor || !result) return null;
  return modelVisualAnchor(
    matrix,
    gltfToPlacedAxes(nativeAnchor),
    scale,
    result,
  );
}

/**
 * The scale a model is drawn at, by the draw contract's pixel rule: `scale`
 * (capped by `maxScale`), raised so its bounding sphere spans `minPixelSize`
 * pixels at the sphere's distance from the eye (its depth along the view
 * direction, less its radius), and capped by `maxScale` again.
 * @param {object} options
 * @param {number} [options.scale] The item's `scale` (default 1). An item
 *   that also has `scaleByDistance` or `maxPixelSize` is drawn at a scale
 *   this does not model; aircraft models use neither.
 * @param {number} [options.minPixelSize]
 * @param {number} [options.maxScale]
 * @param {number} options.radiusM The model's bounding radius at scale 1.
 * @param {{x:number,y:number,z:number}} options.center Where it is placed.
 * @param {{position: object, direction: object, fovy: number}|null} options.pose
 *   The camera pose (`camera.pose()`).
 * @param {number} options.viewportHeightPx Drawn viewport height, CSS pixels.
 * @param {number} [options.viewportWidthPx] Drawn viewport width, CSS pixels.
 * @param {number} [options.pixelRatio] Drawing-buffer pixels per CSS pixel
 *   (default 1): the sphere's drawn size is capped at the drawing buffer's
 *   larger side, in its own pixels.
 * @returns {number}
 */
export function modelDrawnScale({
  scale = 1,
  minPixelSize = 0,
  maxScale,
  radiusM,
  center,
  pose,
  viewportHeightPx,
  viewportWidthPx = viewportHeightPx,
  pixelRatio = 1,
}) {
  const capped = (s) => (Number.isFinite(maxScale) ? Math.min(maxScale, s) : s);
  if (
    !(minPixelSize > 0) ||
    !(radiusM > 0) ||
    !center ||
    !pose?.position ||
    !pose.direction ||
    !(pose.fovy > 0) ||
    !(viewportHeightPx > 0)
  )
    return capped(scale);
  const sphereRadius = radiusM * capped(scale);
  const depth = Math.abs(
    (center.x - pose.position.x) * pose.direction.x +
      (center.y - pose.position.y) * pose.direction.y +
      (center.z - pose.position.z) * pose.direction.z,
  );
  const distance = Math.max(0, depth - sphereRadius);
  const metresPerPixel =
    (2 * distance * Math.tan(pose.fovy / 2)) / viewportHeightPx;
  if (!(metresPerPixel > 0)) return capped(scale);
  const diameterPx = Math.min(
    (2 * sphereRadius) / metresPerPixel,
    Math.max(viewportWidthPx || 0, viewportHeightPx) *
      (pixelRatio > 0 ? pixelRatio : 1),
  );
  const drawn =
    diameterPx < minPixelSize
      ? (minPixelSize * metresPerPixel) / (2 * radiusM)
      : scale;
  return capped(drawn);
}

/**
 * Where a trail head segment should START being drawn: the whole segment, a
 * shortened piece of it, or nothing at all.
 *
 * The head segment bridges the last displayed trail point to the aft-belly
 * anchor. On a moving contact that point is a poll interval behind, so the
 * segment arrives from open air and terminates ON the hull, which is what it
 * should do. On a PARKED one it sits where the aircraft is: the segment
 * degenerates into a line from inside the model out to its own anchor — a stick
 * through half the fuselage on an aeroplane going nowhere. Grounded tracking
 * starts a trail unconditionally, so every parked selection drew one.
 *
 * Three earlier cuts were wrong, and each is recorded because the shape of the
 * mistake matters:
 *
 *  - Testing segment LENGTH against the radius hid real trail. With
 *    an airliner model's 34.41 m radius and 24.09 m tail anchor, a prior fix 58 m
 *    aft gives a 33.98 m segment — under the radius, so suppressed — even
 *    though ~23.6 m of it is in open air behind the aircraft. It also made the
 *    whole segment pop in at once on crossing ~58.4 m.
 *  - CLIPPING the segment at the envelope boundary and keeping only what lay
 *    OUTSIDE fixed the pop but broke the thing the trail is for: a bounding
 *    sphere encloses a lot of empty space around a slender airframe, so
 *    trimming at sphere entry stops the trail visibly SHORT of the aircraft it
 *    is attached to. The head end is never cut. That end is the whole point.
 *  - CONTAINMENT — the whole segment when the start is outside the envelope,
 *    nothing when it is inside — kept both of those ends honest but decided it
 *    with a BOOLEAN, and a boolean at a 34.41 m boundary is a 10.33 m flash.
 *    Moving the start from 34.40 m to 34.42 m turned the entire segment on at
 *    once, and a contact whose next fix landed back inside turned it off again.
 *    Nothing in the world changes by 10 m across 2 cm of travel.
 *
 * So the far end MOVES and the near end does not. The drawn start slides along
 * the segment, from the anchor itself out to the segment's true start, over the
 * shell between the two lengths the model already defines:
 *
 *   - the ANCHOR'S OWN STATION, `|anchor − centre|`. Inside that, the last body
 *     point is no further from the aircraft's centre than its own attachment
 *     point is, so every millimetre of the segment would be drawn forward of
 *     the anchor, into the fuselage. Nothing is drawn. A parked contact sits at
 *     exactly zero here, which is the case this whole guard exists for.
 *   - the ENVELOPE, `radiusM`. At and beyond it the segment is drawn in full,
 *     bit-identical to the containment rule it replaces — so every contact that
 *     has moved more than its own size (any airborne contact: 30 s of flight is
 *     kilometres) is completely unaffected by any of this.
 *
 * Between them the visible length grows continuously from zero, so a contact
 * creeping across the boundary reveals its trail a few centimetres at a time
 * and an in/out/in flap costs a few centimetres each way instead of ten metres.
 *
 * Scale-free rather than tuned: both ends of that shell come from the model —
 * `radiusM` carries the drawn scale, so it tracks whatever
 * `minPixelSize` inflated the model to, and the station comes from the
 * anchor being drawn to.
 *
 * @param {{x:number,y:number,z:number}} start Segment start (last trail point).
 * @param {{x:number,y:number,z:number}|null} anchor Segment end, world space —
 *   the aft-belly attachment point actually being drawn to.
 * @param {{x:number,y:number,z:number}|null} center Model origin, world space.
 * @param {number} radiusM Rendered bounding radius (nativeRadiusM x drawn scale).
 * @param {{x:number,y:number,z:number}} result Mutable Cartesian-like result.
 * @returns {{x:number,y:number,z:number}|null} The point to draw FROM, or null
 *   when the segment should not be drawn. May be `start` itself.
 */
export function trailHeadStart(start, anchor, center, radiusM, result) {
  if (!start) return null;
  // No envelope to judge against (no model drawing this contact, a radius we
  // cannot trust, or nowhere to put the answer) — draw it all rather than lose
  // a real trail.
  if (!anchor || !center || !result) return start;
  if (!Number.isFinite(radiusM) || radiusM <= 0) return start;
  const startD = Math.hypot(
    start.x - center.x,
    start.y - center.y,
    start.z - center.z,
  );
  if (startD >= radiusM) return start;
  const anchorD = Math.hypot(
    anchor.x - center.x,
    anchor.y - center.y,
    anchor.z - center.z,
  );
  // A degenerate shell (an anchor at or outside the envelope — no shipped asset
  // has one, since every anchor is a measured hull point) leaves nothing to
  // ramp across; fall back to the containment verdict rather than divide by it.
  if (!(radiusM > anchorD)) return null;
  const revealed = (startD - anchorD) / (radiusM - anchorD);
  if (revealed <= 0) return null;
  result.x = anchor.x + (start.x - anchor.x) * revealed;
  result.y = anchor.y + (start.y - anchor.y) * revealed;
  result.z = anchor.z + (start.z - anchor.z) * revealed;
  return result;
}

/**
 * The live head line from the last trail report through `points` (on the
 * way to the aircraft) to `head`, as drawn: points inside the model's
 * envelope are left out, and the link into the model slides as
 * `trailHeadStart` decides (nothing on a contact that has not moved).
 * @param {{x:number,y:number,z:number}} start The last body report.
 * @param {Array<{x:number,y:number,z:number}>} points Between it and the head.
 * @param {{x:number,y:number,z:number}} head The aircraft's trail anchor.
 * @param {{x:number,y:number,z:number}|null} center Model origin, or null.
 * @param {number|null} radiusM Rendered bounding radius.
 * @param {{x:number,y:number,z:number}} result Scratch for the slid start.
 * @returns {Array<{x:number,y:number,z:number}>} Empty when nothing is drawn.
 */
export function trailHeadLine(start, points, head, center, radiusM, result) {
  const outside = (p) =>
    !center ||
    !(radiusM > 0) ||
    Math.hypot(p.x - center.x, p.y - center.y, p.z - center.z) >= radiusM;
  const line = [start];
  for (const p of points) if (outside(p)) line.push(p);
  // On a contact that has not moved the last link runs from inside the model
  // out to its own anchor — a line through the fuselage. The END never gives,
  // so a moving trail still terminates on the tail; the START is what
  // slides, from nothing on a parked contact out to the whole link once it
  // has cleared its own envelope.
  const from = trailHeadStart(line.pop(), head, center, radiusM, result);
  if (!from)
    return line.length ? [...line, { x: head.x, y: head.y, z: head.z }] : [];
  line.push(from === result ? { x: from.x, y: from.y, z: from.z } : from);
  line.push({ x: head.x, y: head.y, z: head.z });
  return line;
}

/**
 * Transform a model-local visual centre into world coordinates without
 * allocating. `modelMatrix` continues to own the model origin (including
 * ground snapping); bracket/readout and trail consumers supply their own
 * model-local anchor.
 * @param {ArrayLike<number>} modelMatrix The placement, column-major 4x4.
 * @param {readonly number[]} nativeCenter Placed-frame native-unit offset.
 * @param {number} scale The drawn scale, applied outside the placement.
 * @param {{x:number,y:number,z:number}} result Mutable Cartesian-like result.
 * @returns {{x:number,y:number,z:number}|null} World visual centre.
 */
export function modelVisualAnchor(modelMatrix, nativeCenter, scale, result) {
  if (!modelMatrix || !result) return null;
  const safeScale = Number.isFinite(scale) ? scale : 1;
  const x = (nativeCenter?.[0] || 0) * safeScale;
  const y = (nativeCenter?.[1] || 0) * safeScale;
  const z = (nativeCenter?.[2] || 0) * safeScale;
  result.x =
    modelMatrix[0] * x +
    modelMatrix[4] * y +
    modelMatrix[8] * z +
    modelMatrix[12];
  result.y =
    modelMatrix[1] * x +
    modelMatrix[5] * y +
    modelMatrix[9] * z +
    modelMatrix[13];
  result.z =
    modelMatrix[2] * x +
    modelMatrix[6] * y +
    modelMatrix[10] * z +
    modelMatrix[14];
  return result;
}
