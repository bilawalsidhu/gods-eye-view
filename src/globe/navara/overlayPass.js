import { Pass } from 'postprocessing';

export class GevOverlayPass extends Pass {
  constructor(scene, camera, overlay) {
    super('GevOverlayPass', scene, camera);
    this.needsSwap = false;
    this.overlay = overlay;
  }
  render(renderer, inputBuffer) {
    if (!this.overlay.hasDrawables()) return;
    const resolution = this.overlay.uniforms.uGevResolution.value;
    resolution[0] = inputBuffer?.width ?? 0;
    resolution[1] = inputBuffer?.height ?? 0;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.autoClear = autoClear;
    }
  }
}
