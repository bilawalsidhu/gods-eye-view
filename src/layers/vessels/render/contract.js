// The vessel renderer: what the vessels layer's logic asks of an engine to
// draw its ship chevrons and the selected vessel's trail, and to read the
// camera. render/display.js implements it on every engine, over the globe
// contract; tests implement it over their own doubles. Nothing here imports
// an engine.
//
// The logic holds HANDLES and writes plain fields on them, in Cesium's
// Billboard vocabulary:
//
//   SpriteHandle (fleet.add) — one chevron: position (Cartesian3), show,
//     rotation (screen angle, rad), image (a chevron data URL of
//     ../icons.js), scale, color ({red, green, blue, alpha} with
//     withAlpha(); reads return the renderer's copy), width/height (CSS px,
//     the artwork's size before the scale), id (the record). Data/focus keys
//     its emphasis on the handle object.
//   Trail (trails.create): setPositions(Cartesian3[]), setVisible(boolean),
//     clear(), destroy().
//
// The view: `camera` camera-shaped (positionWC, positionCartographic,
// rightWC, upWC, heading, pitch, roll, pickEllipsoid(screen)) and `scene`
// scene-shaped ({ camera, canvas }) for the shared helpers that take them
// (iconOrientation, the view-area request), the scene carrying the engine's
// `projector` so projections go through it.

/**
 * @typedef {object} VesselView
 * @property {object} camera
 * @property {object} scene
 * @property {() => ({ isPointVisible(position: object): boolean } | null)} horizon
 *   For this pass: the ellipsoid horizon at the camera.
 * @property {(position: object, result?: object) => ({x: number, y: number} | undefined)} worldToWindow
 * @property {() => { width: number, height: number }} canvasSize CSS px.
 * @property {() => void} requestRender
 * @property {(event: 'preRender'|'moveEnd', listener: Function) => (() => void) | null} on
 */

/**
 * @typedef {object} VesselRenderer
 * @property {object|null} engine
 * @property {VesselView} view
 * @property {{ attached(): boolean,
 *   attach(options: { show: boolean }): void, setVisible(show: boolean): void,
 *   add(spec: { position: object, show: boolean, image: string, scale: number,
 *     rotation: number, id: object }): object,
 *   remove(handle: object): void, detach(): void }} fleet
 * @property {(picked: object) => object|null} pickedRecord The vessel record
 *   a pick is of (keyed or not), or null.
 * @property {{ onChanged(listener: Function): () => void, active(): boolean }} follow
 *   The engine's follow camera (vessels never follow: a follow belongs to
 *   another layer).
 * @property {{ create(options: { color: string, width: number }): object|null }} trails
 * @property {() => void} destroy
 */
