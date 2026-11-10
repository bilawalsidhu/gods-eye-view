// The aircraft renderer: what the aircraft layers' logic (flights, military
// and local ADS-B) asks of an engine to draw a fleet of aircraft, its 3D
// models, the tracked aircraft, its trail, and to follow it. One
// implementation, render/display.js, draws it on every engine through the
// globe engine contract (engine.movers / engine.lines /
// engine.camera.follow). Nothing here imports an engine.
//
// The logic holds HANDLES and writes plain fields on them; the field names
// are Cesium's (the layers were written against its objects), and the
// display implements them as setters:
//
//   SpriteHandle (fleet.add) — one aircraft glyph:
//     position (Cartesian3), show, rotation (screen angle, rad),
//     scale, width, height (CSS px), color ({red, green, blue, alpha} with
//     withAlpha(); an Rgba of src/layers/shared/color.js or what the engine
//     stored), image (canvas or URL), scaleByDistance ({near, nearValue,
//     far, farValue}), id. Reads return what was last written (color and
//     scaleByDistance as the engine's own copy). The logic may keep its own
//     bookkeeping fields on a handle (prefixed _gev).
//   ModelHandle (models.load*) — one glTF instance:
//     show, ready (read-only: placed, and its model loaded), failed
//     (read-only: the latest load of its model failed; the engine retries
//     it, and ready turns true once a retry loads), scale,
//     computedScale (read-only: scale after minimumPixelSize), color, id,
//     modelMatrix (16 numbers, column-major, the model frame: written by
//     models.setPose and read for anchors).
//   TrackedHandle (tracked.create) — the selected aircraft's glyph and the
//     follow target: viewFrom (ENU offset, read), and the annotation fields
//     the shell reads: gevSelectionOrigin, gevTrackedId, gevLabelModel,
//     gevDisplayPosition(), gevVisualPosition().
//   Trail (trails.create): setPositions(Cartesian3[]), setVisible(bool),
//     clear(), destroy().  TrailHead (trails.createHead): show (bool).
//
// The view: what the logic reads of the camera and the frame. `camera` is
// camera-shaped (positionWC, positionCartographic, directionWC, upWC,
// rightWC, heading, pitch, roll, frustum.fovy) and `scene` scene-shaped
// ({ camera, canvas.clientHeight, frameState.frameNumber }) for the shared
// helpers that take them (iconOrientation, focusDeemphasis): adapters over
// engine.camera.pose(), the scene carrying the engine's `projector` so
// projections go through it.

/**
 * @typedef {object} AircraftView
 * @property {object} camera
 * @property {object} scene
 * @property {() => number} frameNumber One value per rendered frame.
 * @property {() => number} viewportHeightPx
 * @property {() => ((position: object) => boolean)} frustumTester For this
 *   frame: is a point (1 m sphere) inside or on the view frustum.
 * @property {() => { isPointVisible(position: object): boolean }} horizon
 *   For this frame: the ellipsoid horizon test.
 * @property {(position: object, result?: object) => ({x: number, y: number} | undefined)} worldToWindow
 * @property {() => void} requestRender
 * @property {(event: 'preRender'|'preUpdate'|'moveEnd', listener: Function) => () => void} on
 * @property {object} engine The globe engine used for surface sampling.
 */

/**
 * @typedef {object} AircraftRenderer
 * @property {object} engine The globe engine.
 * @property {AircraftView} view
 * @property {object} fleet attach(), detach(), attached(), visible(),
 *   setVisible(bool), add(spec) → SpriteHandle, remove(sprite),
 *   restoreOrder(), restoreOrderOnEnable().
 * @property {object} models live(), setVisible(bool), loadFleet(spec),
 *   loadTracked(spec) → Promise<ModelHandle>, add(model),
 *   remove(model), destroy(model), setPose(model, position, headingDeg,
 *   offsetDeg?) (offsetDeg: the model's nose offset, default the layer's).
 *   spec: { url, minimumPixelSize, scale, radiusM, color, blendAmount,
 *   unlit, id }.
 * @property {object} tracked create(spec) → TrackedHandle, remove(handle),
 *   isLive(handle), setImage(handle, image), setViewFrom(handle, enu),
 *   billboardSize(handle) → { width, height, scale, scaleByDistance } | null.
 *   spec: { image, width, height, scale, scaleByDistance,
 *   disableDepthTestDistance, position(), color() → colour, rotation() }.
 * @property {object} follow start(handle), refocus(handle),
 *   release(), isFollowing(handle), current() (the tracked handle, or what
 *   another layer follows), onChanged(listener) → remove.
 * @property {object} trails create({ color, width }) → Trail,
 *   createHead({ id, show, positions() → Cartesian3[], color, width }) →
 *   TrailHead, removeHead(head).
 * @property {(objects: { sprites: Iterable, models: Iterable }) => object[]} surfaceExclusions
 *   What a vertical surface probe must not hit: the layer's own mover sets.
 * @property {() => void} destroy
 */
