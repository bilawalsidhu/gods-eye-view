/**
 * @module render/applicationHooks
 * @description What a renderer's plugin may hand the application beside the
 * contract: behaviour the application uses where a renderer has it, and does
 * without where it has none. Nothing here is part of the renderer contract,
 * and the application never asks which renderer it runs on: it reads the
 * hooks of the renderer it was given, each of them optional.
 *
 * - `mapEngine`: the renderer's own map engine (`src/maps/engine.js`), which
 *   the map stacks switch through in place of the globe port
 *   (`src/maps/globeEngine.js`).
 * - `trimStaleCommands()`: drops the draw commands a renderer keeps for a
 *   while after it stops drawing them; run after a layer turns off.
 * - `viewerDrawsEntity(entity)`: whether an entity is one the renderer draws
 *   itself (Cockpit asks whether the aircraft it flies still draws).
 * - `qaHandles`: values QA scripts read from `window.__godsEyeView`.
 * - `ownCreditDisplay`: true when the renderer shows its credits in a
 *   display of its own; otherwise the application shows what its credits
 *   port lists (`src/ui/creditsView.js`).
 * - `renderFailureNotice({allowReload, store})`: a recoverable notice,
 *   published to `store`, when the renderer stops drawing
 *   (`src/render/cesium/renderFailure.js`); returns its removal.
 * - `cardPreviews`: the Context card's previews of a picked aircraft (its
 *   model turning, its route on a small globe, the view from its cockpit),
 *   each drawn into an element the card gives it
 *   (`src/render/cesium/cardPreviews.js`); without it the card shows its
 *   photo and figures only.
 *
 * A plugin hands them as its `applicationHooks(renderer)`
 * (`ApplicationHooks`, `contract/renderer.d.ts`); the application scene
 * records them here as it creates the renderer. What the renderer should
 * do is in the contract instead: keeping the Earth framed on zooming out is
 * `camera.controls.keepEarthFramed`, the detection overlay's depth test is
 * `query.occlusionTest`, and an inline panel keeps drawing through the frame
 * port (`src/app/panelRendering.js`).
 */

const hooks = new WeakMap();
const NONE = Object.freeze({});

/**
 * Hand the application `value`'s hooks for `renderer`. A renderer's plugin
 * calls it as it creates the renderer; a later call replaces them.
 * @param {object} renderer
 * @param {object} value
 */
export function provideApplicationHooks(renderer, value) {
  hooks.set(renderer, Object.freeze({ ...value }));
}

/**
 * The hooks `renderer`'s plugin provided; an empty object when it provided
 * none, or `renderer` is not an object.
 * @param {object|null|undefined} renderer
 * @returns {Readonly<object>}
 */
export const applicationHooksOf = (renderer) =>
  (renderer && hooks.get(renderer)) || NONE;
