import { EffectDesc } from '@navaramap/three';

// Raster visibility only hides imagery. The globe scene must stop writing
// colour, depth and shadows while 3D tiles supply the rendered surface.
// A descriptor gives us the public scene context without stopping terrain
// traversal or changing the meshes used by CPU height sampling.
class HiddenGlobeDesc extends EffectDesc {
  static key = 'gevHiddenGlobe';

  createPass() {
    this.wasVisible = this.ctx.scenes.globe.visible;
    this.ctx.scenes.globe.visible = false;
    // No screen pass: only the scene's visibility changes.
  }

  onDestroy() {
    if (this.wasVisible !== undefined)
      this.ctx.scenes.globe.visible = this.wasVisible;
    super.onDestroy();
  }
}

const registered = new WeakSet();

export function hideGlobe(view) {
  if (!registered.has(view)) {
    view.registerEffect(HiddenGlobeDesc.key, HiddenGlobeDesc);
    registered.add(view);
  }
  return view.addEffect({ [HiddenGlobeDesc.key]: {} });
}
