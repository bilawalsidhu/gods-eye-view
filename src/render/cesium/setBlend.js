/**
 * @module render/cesium/setBlend
 * @description `SetSpec.blend` on the Cesium renderer: a set's host draws
 * its commands as it always has, and each frame drawn, the commands it gave
 * are turned to the set's blend before the scene sorts them into passes.
 *
 * - none: as drawn (opaque parts opaque with depth writes; translucent ones
 *   blended without).
 * - `opaque`: every command in the opaque pass, unblended (alpha ignored)
 *   with depth writes: billboards and points are built so (every fragment
 *   Cesium keeps, above an alpha of 0.005), and a GPU icon set's solid and
 *   translucent commands both drawn so here.
 * - `translucent`: every command alpha-blended in the translucent pass,
 *   without depth writes, even where its alpha is 1.
 * - `additive`: every command's colour times its alpha added to what is
 *   drawn, without depth writes and still depth-tested. They draw after
 *   every opaque command and before the translucent pass (in the pass
 *   Cesium keeps for Gaussian splats, back to front): the translucent pass
 *   blends order-independently, which would undo the addition.
 *
 * Ground (classification) commands keep their pass, stencil and depth: only
 * their blending is turned. Picks are untouched: only render passes are.
 * A command keeps what it was given, so a set whose blend changes is turned
 * again from it on the next frame, without being rebuilt.
 */

import * as Cesium from 'cesium';

const { Pass, BlendingState } = Cesium;

/** Passes drawn in colour, with depth: the ones a blend moves between. */
const COLOUR_PASSES = new Set([Pass.OPAQUE, Pass.TRANSLUCENT]);
/** Ground passes: classification draws through the stencil. */
const GROUND_PASSES = new Set([
  Pass.TERRAIN_CLASSIFICATION,
  Pass.CESIUM_3D_TILE_CLASSIFICATION,
  Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW,
]);
/** Where additive commands draw: after opaque ones, before translucent. */
export const ADDITIVE_PASS = Pass.GAUSSIAN_SPLATS;

const WRAPPED = Symbol('setBlend.wrapped');
const GIVEN = Symbol('setBlend.given');

/** Render states made from another, by blend and whether it moves passes. */
const turned = new WeakMap();

function turnedState(given, blend, colour) {
  let byBlend = turned.get(given);
  if (!byBlend) turned.set(given, (byBlend = new Map()));
  const key = `${blend}|${colour}`;
  let state = byBlend.get(key);
  if (state) return state;
  const description = Cesium.RenderState.getState(given);
  if (blend === 'opaque') {
    description.blending = BlendingState.DISABLED;
    if (colour) description.depthMask = true;
  } else if (blend === 'translucent') {
    if (!description.blending?.enabled)
      description.blending = BlendingState.ALPHA_BLEND;
    if (colour) description.depthMask = false;
  } else {
    description.blending = BlendingState.ADDITIVE_BLEND;
    if (colour) description.depthMask = false;
  }
  state = Cesium.RenderState.fromCache(description);
  byBlend.set(key, state);
  return state;
}

/**
 * Turn the commands `list` holds from `start` on to `blend`.
 * @param {object[]} list A frame's command list.
 * @param {number} start
 * @param {'opaque'|'translucent'|'additive'|undefined} blend
 */
export function blendCommands(list, start, blend) {
  for (let i = start; i < list.length; i++) {
    const command = list[i];
    const given = command[GIVEN];
    // What the command was given: kept while it still holds what this made.
    let renderState = command.renderState;
    let pass = command.pass;
    if (given && renderState === given.made) {
      renderState = given.renderState;
      pass = given.pass;
    }
    if (blend === undefined || !renderState) {
      if (given) {
        command.renderState = renderState;
        command.pass = pass;
        command[GIVEN] = undefined;
      }
      continue;
    }
    const colour = COLOUR_PASSES.has(pass);
    if (!colour && !GROUND_PASSES.has(pass)) continue;
    const made = turnedState(renderState, blend, colour);
    const to = !colour
      ? pass
      : blend === 'opaque'
        ? Pass.OPAQUE
        : blend === 'translucent'
          ? Pass.TRANSLUCENT
          : command.boundingVolume?.center
            ? ADDITIVE_PASS
            : Pass.TRANSLUCENT;
    command[GIVEN] = { renderState, pass, made };
    // Assigned only when changed: a command that changes is derived again.
    if (command.renderState !== made) command.renderState = made;
    if (command.pass !== to) command.pass = to;
  }
}

/**
 * Make `host` draw its commands in the blend `blendOf()` answers each frame.
 * @param {{update: (frameState: object) => void}} host
 * @param {() => ('opaque'|'translucent'|'additive'|undefined)} blendOf
 * @returns {object} `host`.
 */
export function blendHost(host, blendOf) {
  if (!host || host[WRAPPED] || typeof host.update !== 'function') return host;
  host[WRAPPED] = true;
  const update = host.update;
  // Once turned, commands are turned back when the blend is gone.
  let turnedAny = false;
  host.update = function (frameState) {
    const list = frameState.commandList;
    const start = list.length;
    const result = update.call(this, frameState);
    if (!frameState.passes?.render) return result;
    // A host that draws this blend itself keeps its commands as made: a
    // collection built translucent draws in the opaque pass, blended in its
    // order, which the translucent pass's order-independent blend would
    // average away.
    const asked = blendOf();
    const ownBlend =
      this.drawsBlend?.(asked) ||
      (asked === 'translucent' &&
        this.blendOption === Cesium.BlendOption.TRANSLUCENT);
    const blend = ownBlend ? undefined : asked;
    if (blend === undefined && !turnedAny) return result;
    if (blend !== undefined) turnedAny = true;
    blendCommands(list, start, blend);
    return result;
  };
  return host;
}
