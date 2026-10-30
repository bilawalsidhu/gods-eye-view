import { Pass } from 'postprocessing';
import { AlwaysDepth, Mesh, PlaneGeometry, ShaderMaterial } from 'three';
import { hasGeometry, skipEmptySceneRenders } from './emptySceneRender.js';

// Navara 0.2.1 multisamples every composer target, including full-screen
// effects. Resolve geometry once; post effects need one sample per pixel.
// Keep forward meshes and the final overlay multisampled too, not just MRT.
export class GeometrySamplingPass extends Pass {
  constructor(ctx) {
    super('GevGeometrySampling');
    this.needsSwap = false;
    this.ctx = ctx;
    this.samples = ctx.getInputBuffer().samples;
    this.buffers = new Map();
    this.wrapped = new Map();
    this.target = null;
    this.copy = new ShaderMaterial({
      vertexShader:
        'varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader:
        'uniform sampler2D image; uniform sampler2D depth; varying vec2 vUv; void main(){gl_FragColor=texture2D(image,vUv);gl_FragDepth=texture2D(depth,vUv).r;}',
      uniforms: { image: { value: null }, depth: { value: null } },
      depthTest: true,
      depthFunc: AlwaysDepth,
      depthWrite: true,
      toneMapped: false,
    });
    this.background = new Mesh(new PlaneGeometry(2, 2), this.copy);
    this.background.frustumCulled = false;
    this.background.renderOrder = -Infinity;
  }

  render(renderer, input, output) {
    if (!this.samples) return;
    for (const buffer of [input, output]) {
      if (!this.buffers.has(buffer)) this.buffers.set(buffer, buffer.samples);
      this.setSamples(buffer, 0);
    }
    // G-buffer attachments can be replaced when an effect is added/removed.
    this.setSamples(this.ctx.getRenderTarget(), this.samples);
    for (const key of ['mrt', 'transparent', 'gevOverlay']) {
      const pass = this.ctx.getPass(key);
      if (!pass || this.wrapped.has(pass)) continue;
      const original = pass.render;
      const draw =
        key === 'mrt'
          ? skipEmptySceneRenders(original, this.ctx.scenes)
          : original;
      const owner = this;
      pass.render = function (renderer, input, output, ...rest) {
        if (key === 'gevOverlay' && !this.overlay.hasDrawables()) return;
        if (key === 'transparent' && !hasGeometry(owner.ctx.scenes.transparent))
          return;
        if (key === 'mrt' && !hasGeometry(owner.ctx.scenes.opaque))
          return draw.call(this, renderer, input, output, ...rest);
        const target = (owner.target ??= input.clone());
        owner.setSamples(target, owner.samples);
        target.setSize(input.width, input.height);
        const autoClear = renderer.autoClear;
        renderer.autoClear = false;
        try {
          if (key !== 'mrt') {
            owner.copy.uniforms.image.value = input.texture;
            owner.copy.uniforms.depth.value = input.depthTexture;
            // Copy and geometry share one render() and therefore one MSAA
            // resolve. The opaque background sorts before transparent glyphs.
            this.scene.add(owner.background);
          }
          draw.call(this, renderer, target, output, ...rest);
          renderer.initRenderTarget(input);
          renderer.copyTextureToTexture(target.texture, input.texture);
          if (key === 'mrt')
            renderer.copyTextureToTexture(
              target.depthTexture,
              input.depthTexture,
            );
        } finally {
          owner.background.removeFromParent();
          renderer.setRenderTarget(input);
          renderer.autoClear = autoClear;
        }
      };
      this.wrapped.set(pass, original);
    }
  }

  setSamples(target, samples) {
    if (target.samples === samples) return;
    target.dispose();
    target.samples = samples;
  }

  dispose() {
    for (const [pass, render] of this.wrapped) pass.render = render;
    for (const [buffer, samples] of this.buffers)
      this.setSamples(buffer, samples);
    this.wrapped.clear();
    this.buffers.clear();
    this.background.geometry.dispose();
    super.dispose();
  }
}
