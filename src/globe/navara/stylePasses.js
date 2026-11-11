// The Navara effect of the app's visual styles (stylePass.js): one
// EffectDesc whose pass draws every style that shows, and the styles port
// createNavaraEngine takes. Kept apart from stylePass.js so the shaders,
// the pass and the port run in Node tests (Navara itself does not load
// there).

import { EffectDesc, Pass as NavaraPass } from '@navaramap/three';
import { pipelinePassNames } from './internals.js';
import { withPassDisposal } from './frameDescriptor.js';
import {
  GevStylesPass,
  STYLES_EFFECT_KEY,
  createStylesPort,
} from './stylePass.js';

class StylesEffectDesc extends withPassDisposal(EffectDesc) {
  static key = STYLES_EFFECT_KEY;
  // Last before Navara's final copy: after bloom when it is on, else after
  // everything the scene and its overlays draw (nothing anchors after it).
  static insertAfter = ['gevBloom'];
  static insertBefore = ['final'];

  constructor(view, ctx, config) {
    super(view, ctx, config);
    this.controller = config[STYLES_EFFECT_KEY].controller;
    // For the diagnostics below.
    this.controller.ctx = ctx;
  }

  createPass() {
    // Navara inserts a bare pass only when it comes from its own
    // postprocessing copy: wrap it (as overlay.js does).
    return new NavaraPass(new GevStylesPass(this.controller), null);
  }
}

/**
 * createStylesPort (stylePass.js) on a view with the styles effect
 * registered.
 * @param {object} view an initialised ThreeView
 * @param {Parameters<typeof createStylesPort>[1]} options
 */
export function createNavaraStyles(view, options) {
  view.registerEffect(STYLES_EFFECT_KEY, StylesEffectDesc);
  const port = createStylesPort(view, options);
  return {
    ...port,
    /** Navara only (QA): whether the pass shows, and the pipeline order. */
    diagnostics: () => ({
      shown: port.passShown(),
      passes: pipelinePassNames(port.controller.ctx),
    }),
  };
}
