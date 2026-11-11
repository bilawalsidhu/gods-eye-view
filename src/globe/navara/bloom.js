// The app's Bloom control on Navara: postprocessing's BloomEffect (mipmap
// blur) as a Navara custom effect, with the settings of bloomSettings.js.
// Navara 0.2.1 has no bloom of its own. It runs just before the visual
// styles (stylePasses.js), after everything the scene and its overlays
// draw, as Cesium's bloom stage precedes the app's post stages and glows
// billboards too. A hidden pass is skipped: off costs nothing.

import { Effect as NavaraEffect, EffectDesc } from '@navaramap/three';
import { BloomEffect } from 'postprocessing';
import { createBloomPort } from './bloomSettings.js';
import { pipelinePassNames } from './internals.js';
import { withPassDisposal } from './frameDescriptor.js';

const BLOOM_EFFECT_KEY = 'gevBloom';

function apply(effect, settings) {
  effect.luminanceMaterial.threshold = settings.luminanceThreshold;
  effect.luminanceMaterial.smoothing = settings.luminanceSmoothing;
  effect.mipmapBlurPass.radius = settings.radius;
  effect.intensity = settings.intensity;
}

/** config.gevBloom: { settings } (bloomSettingsFromStrength). */
class BloomEffectDesc extends withPassDisposal(EffectDesc) {
  static key = BLOOM_EFFECT_KEY;
  // Nothing anchors after it but the styles: before them, else before the
  // final copy (the styles anchor after it).
  static insertAfter = [];
  static insertBefore = ['gevStyles', 'final'];

  constructor(view, ctx, config) {
    super(view, ctx, config);
    this.settings = config[BLOOM_EFFECT_KEY].settings;
    config[BLOOM_EFFECT_KEY].onContext?.(ctx);
  }

  createPass() {
    const camera = this.view.camera.raw;
    if (!camera) throw new Error('Camera not available for the bloom');
    this.effect = new BloomEffect({ mipmapBlur: true, levels: 6 });
    apply(this.effect, this.settings);
    return new NavaraEffect(camera, this.effect);
  }

  onUpdateConfig(updates) {
    super.onUpdateConfig(updates);
    const settings = updates?.[BLOOM_EFFECT_KEY]?.settings;
    if (!settings) return;
    this.settings = settings;
    if (this.effect) apply(this.effect, settings);
  }
}

/**
 * The bloom port createNavaraEngine takes (bloomSettings.js
 * createBloomPort) on a view with the effect registered.
 * @param {object} view an initialised ThreeView
 */
export function createNavaraBloom(view) {
  view.registerEffect(BLOOM_EFFECT_KEY, BloomEffectDesc);
  let context = null;
  const port = createBloomPort((settings) => {
    const handle = view.addEffect({
      [BLOOM_EFFECT_KEY]: {
        settings,
        onContext: (ctx) => {
          context = ctx;
        },
      },
      visible: true,
    });
    return {
      update: ({ settings: next, visible }) =>
        handle.update({ [BLOOM_EFFECT_KEY]: { settings: next }, visible }),
      delete: () => handle.delete(),
    };
  });
  return {
    ...port,
    /** Navara only (QA): whether bloom draws, and the pipeline order. */
    diagnostics: () => ({
      shown: port.shown(),
      passes: pipelinePassNames(context),
    }),
  };
}
