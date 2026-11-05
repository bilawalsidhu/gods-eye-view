// The aircraft renderer: what the aircraft layers' logic (flights now,
// military and local ADS-B after it) asks of an engine to draw a fleet of
// aircraft, its 3D models, the tracked aircraft, its trail, and to follow it.
// render/cesium.js implements it over Cesium (the objects the layers used
// to build themselves, one for one); render/navara.js implements it on the
// Navara engine over engine.movers / engine.lines / engine.camera.follow.
// Nothing here imports an engine.
//
// The logic holds HANDLES and writes plain fields on them; the field names
// are Cesium's (the extraction is a pure move), and an engine other than
// Cesium implements them as setters:
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
//     show, ready (read-only), scale, computedScale (read-only: scale after
//     minimumPixelSize), color, id, modelMatrix (16 numbers, column-major,
//     written by models.setPose and read for anchors), sceneGraph? (Cesium).
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
// helpers that take them (iconOrientation, focusDeemphasis); on Navara
// they are adapters over engine.camera.pose(), with the engine registered
// for the scene (engineFromViewer) so projections go through its projector.

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
 * @property {object} surfaceOwner What groundSnap/meshFloor sample through
 *   (a viewer registered with its engine, or the engine).
 * @property {object} surfaceScene What sampleMeshFloorCells takes.
 * @property {() => void} holdFrames Evidence capture: stop the engine's own
 *   frame loop (QA only).
 * @property {() => void} closeFrameLatch Evidence capture, one task later:
 *   let manual renders start without waiting for the loop's next frame.
 * @property {() => void} releaseFrames
 */

/**
 * @typedef {object} AircraftRenderer
 * @property {'cesium'|'navara'} kind
 * @property {object|null} engine The globe engine (null in unit tests that
 *   drive a bare viewer).
 * @property {AircraftView} view
 * @property {object} fleet attach(), detach(), attached(), visible(),
 *   setVisible(bool), add(spec) → SpriteHandle, remove(sprite),
 *   restoreOrder(), restoreOrderOnEnable().
 * @property {object} models live(), setVisible(bool), loadFleet(spec),
 *   loadTracked(spec), preload(url) → Promise<ModelHandle>, add(model),
 *   remove(model), destroy(model), setPose(model, position, headingDeg,
 *   offsetDeg?) (offsetDeg: the model's nose offset, default the layer's).
 *   spec: { url, minimumPixelSize, scale, color, blendAmount, unlit, id }.
 * @property {object} tracked create(spec) → TrackedHandle, remove(handle),
 *   isLive(handle), setImage(handle, image), setViewFrom(handle, enu),
 *   billboardSize(handle) → { width, height, scale, scaleByDistance } | null.
 *   spec: { image, width, height, scale, scaleByDistance,
 *   disableDepthTestDistance, position(), color() → colour, rotation() }.
 * @property {object} follow start(handle) → stop, refocus(handle) → stop,
 *   release(), isFollowing(handle), current(), onChanged(listener) → remove.
 * @property {object} trails create({ color, width }) → Trail,
 *   createHead({ id, show, positions() → Cartesian3[], color, width }) →
 *   TrailHead, removeHead(head).
 * @property {(objects: { sprites: Iterable, models: Iterable }) => object[]} surfaceExclusions
 *   What a vertical surface probe must not hit: the layer's own drawings.
 * @property {() => void} destroy
 */
