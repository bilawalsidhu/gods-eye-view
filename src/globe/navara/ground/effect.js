import { Effect, EffectAttribute } from 'postprocessing';
import { withFrameUpdates, withPassDisposal } from '../frameDescriptor.js';

/**
 * A screen-space pass on a Navara view, registered once per view under `key`.
 * `insertAfter` and `insertBefore` place it in the view's effect chain.
 * `uniforms()` lists the pass's [name, Uniform] entries; `update` and
 * `destroy` run as the descriptor's updateFrame and onDestroy, with the
 * descriptor as `this` (its `effect`, `owner`, `view`, `ctx` and `find`).
 * The owner is the `owner` of the config added with `view.addEffect`.
 */
export function defineGroundEffect({
  key,
  name,
  fragmentShader,
  uniforms,
  insertAfter,
  insertBefore,
  update,
  destroy,
}) {
  const registered = new WeakSet();
  const descriptor = (EffectDesc, NavaraEffect) =>
    class GroundEffectDesc extends withPassDisposal(
      withFrameUpdates(EffectDesc),
    ) {
      static allowDuplication = true;
      static key = key;
      static insertAfter = insertAfter;
      static insertBefore = insertBefore;
      constructor(view, context, config) {
        super(view, context, config);
        this.owner = config[key].owner;
      }
      createPass() {
        this.effect = new Effect(name, fragmentShader, {
          // Keep a separate pass: inputColor is the already tone-mapped frame.
          attributes: EffectAttribute.CONVOLUTION,
          uniforms: uniforms && new Map(uniforms()),
        });
        return new NavaraEffect(this.view.camera.raw, this.effect);
      }
      updateFrame() {
        update.call(this);
      }
      onDestroy() {
        destroy?.call(this);
        this.effect?.dispose();
        super.onDestroy();
      }
    };
  return {
    key,
    /** Register the pass on `view` the first time it is used there. */
    register(view, { EffectDesc, NavaraEffect }) {
      if (registered.has(view)) return;
      view.registerEffect(key, descriptor(EffectDesc, NavaraEffect));
      registered.add(view);
    },
  };
}
