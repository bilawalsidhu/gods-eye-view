import { Pass } from 'postprocessing';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import {
  Color,
  HalfFloatType,
  ShaderMaterial,
  WebGLRenderTarget,
  NearestFilter,
  NoColorSpace,
  SRGBColorSpace,
} from 'three';

const vertexShader = `
varying vec2 vUv;
void main() { vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }
`;
const transfer = `
vec3 gevDisplay(vec3 c) {
  return mix(12.92*c,1.055*pow(max(c,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));
}
vec3 gevLinear(vec3 c) {
  return mix(c/12.92,pow(max((c+0.055)/1.055,vec3(0.0)),vec3(2.4)),step(vec3(0.04045),c));
}
`;
function displayResources(renderer) {
  // Keep only the native-stage glyphs in this target. The final composite
  // blends them over the input once, avoiding a full-screen encode copy.
  const target = new WebGLRenderTarget(1, 1, {
    type: HalfFloatType,
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  target.texture.colorSpace = NoColorSpace;
  const composite = new ShaderMaterial({
    vertexShader,
    fragmentShader: `uniform sampler2D image; uniform sampler2D glyphs; uniform bool encodeOutput; varying vec2 vUv; ${transfer}
void main(){vec4 bg=texture2D(image,vUv);vec4 glyph=texture2D(glyphs,vUv);if(glyph.a<=0.0){gl_FragColor=vec4(encodeOutput?gevDisplay(bg.rgb):bg.rgb,bg.a);return;}vec3 display=gevDisplay(bg.rgb)*(1.0-glyph.a)+glyph.rgb;display=floor(clamp(display,0.0,1.0)*255.0+0.5)/255.0;vec3 linear=gevLinear(display);gl_FragColor=vec4(encodeOutput?gevDisplay(linear):linear,bg.a);}`,
    uniforms: {
      image: { value: null },
      glyphs: { value: null },
      encodeOutput: { value: false },
    },
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const quad = new FullScreenQuad(composite);
  const canvas = renderer.domElement;
  const display = { target, composite, quad, canvas, signature: null };
  const invalidate = () => {
    display.signature = null;
  };
  canvas?.addEventListener('webglcontextlost', invalidate);
  canvas?.addEventListener('webglcontextrestored', invalidate);
  display.invalidate = invalidate;
  return display;
}

function staticSpriteSignature(scene, camera, renderer, width, height) {
  if (
    scene.children.length === 0 ||
    scene.background ||
    scene.fog ||
    scene.overrideMaterial
  )
    return null;
  // The globe render updates the shared camera before this pass. Mover origins
  // update their world matrices when placed, so a cache hit needn't traverse
  // the overlay scene just to compare its static state.
  const snapshot = [
    width,
    height,
    renderer.getPixelRatio(),
    renderer.toneMapping,
    renderer.toneMappingExposure,
    camera.layers.mask,
    ...camera.matrixWorldInverse.elements,
    ...camera.projectionMatrix.elements,
  ];
  for (const mesh of scene.children) {
    if (!mesh.isInstancedMesh || mesh.userData.gevStaticSprite !== true)
      return null;
    const material = mesh.material,
      texture = material?.map;
    if (!texture) return null;
    snapshot.push(
      mesh.id,
      mesh.visible ? 1 : 0,
      mesh.layers.mask,
      mesh.count,
      mesh.renderOrder,
      mesh.instanceMatrix.version,
      mesh.instanceColor?.version ?? -1,
      ...mesh.matrixWorld.elements,
      material.id,
      material.version,
      material.opacity,
      material.alphaTest,
      material.side,
      material.blending,
      material.transparent ? 1 : 0,
      material.toneMapped ? 1 : 0,
      material.color.r,
      material.color.g,
      material.color.b,
      texture.id,
      texture.version,
      texture.colorSpace,
      texture.format,
      texture.type,
      texture.minFilter,
      texture.magFilter,
      ...texture.matrix.elements,
      mesh.geometry.drawRange.start,
      mesh.geometry.drawRange.count,
      mesh.geometry.index?.version ?? -1,
      mesh.geometry.index?.count ?? 0,
    );
    for (const [name, attribute] of Object.entries(mesh.geometry.attributes))
      snapshot.push(name, attribute.version, attribute.count);
  }
  return snapshot;
}

function signatureMatches(current, previous) {
  return (
    current &&
    previous &&
    current.length === previous.length &&
    current.every((value, index) => value === previous[index])
  );
}

export class GevOverlayPass extends Pass {
  constructor(scene, camera, overlay) {
    super('GevOverlayPass', scene, camera);
    this.needsSwap = false;
    this.overlay = overlay;
    this.display = null;
  }
  render(renderer, inputBuffer, outputBuffer) {
    this.needsSwap = false;
    if (!this.overlay.hasDrawables()) return;
    const resolution = this.overlay.uniforms.uGevResolution.value;
    resolution[0] = inputBuffer?.width ?? 0;
    resolution[1] = inputBuffer?.height ?? 0;
    if (!this.overlay.displayBlend) {
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      try {
        renderer.setRenderTarget(this.renderToScreen ? null : inputBuffer);
        renderer.render(this.scene, this.camera);
      } finally {
        renderer.autoClear = autoClear;
      }
      return;
    }
    const display = (this.display ??= displayResources(renderer));
    const signature = staticSpriteSignature(
      this.scene,
      this.camera,
      renderer,
      resolution[0],
      resolution[1],
    );
    if (signature) {
      // The sonar's uniforms change the glyphs only while it applies; its
      // angle moves every frame even then, so it is left out otherwise.
      const uniforms = this.overlay.uniforms;
      const enabled = uniforms.uGevSonarEnabled?.value >= 0.5;
      const [angle, range, floor, active] = uniforms.uGevSonar?.value ?? [];
      signature.push(enabled);
      if (enabled) signature.push(floor, active);
      if (enabled && active >= 0.5)
        signature.push(angle, range, uniforms.uGevSonarSector?.value);
    }
    const targetWidth = resolution[0];
    const targetHeight = resolution[1];
    if (
      display.target.width !== targetWidth ||
      display.target.height !== targetHeight
    ) {
      display.target.setSize(targetWidth, targetHeight);
      display.signature = null;
    }
    const autoClear = renderer.autoClear;
    const output = this.renderToScreen ? null : outputBuffer;
    this.needsSwap = !this.renderToScreen;
    const blend = this.overlay.uniforms.uGevDisplayBlend;
    const reuseGlyphs = signatureMatches(signature, display.signature);
    const clearColor = reuseGlyphs ? null : renderer.getClearColor(new Color());
    const clearAlpha = reuseGlyphs ? null : renderer.getClearAlpha();
    renderer.autoClear = false;
    try {
      if (!reuseGlyphs) {
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(display.target);
        renderer.clear(true, false, false);
        blend.value = 1;
        renderer.render(this.scene, this.camera);
        blend.value = 0;
        display.signature = signature;
      }
      display.composite.uniforms.image.value = inputBuffer.texture;
      display.composite.uniforms.glyphs.value = display.target.texture;
      display.composite.uniforms.encodeOutput.value =
        this.renderToScreen && renderer.outputColorSpace === SRGBColorSpace;
      renderer.setRenderTarget(output);
      display.quad.material = display.composite;
      display.quad.render(renderer);
    } finally {
      if (!reuseGlyphs) {
        blend.value = 0;
        renderer.setClearColor(clearColor, clearAlpha);
      }
      renderer.setRenderTarget(output);
      renderer.autoClear = autoClear;
    }
  }
  dispose() {
    if (this.display) {
      this.display.canvas?.removeEventListener(
        'webglcontextlost',
        this.display.invalidate,
      );
      this.display.canvas?.removeEventListener(
        'webglcontextrestored',
        this.display.invalidate,
      );
      this.display.target.dispose();
      this.display.composite.dispose();
      this.display.quad.dispose();
      this.display = null;
    }
    super.dispose();
  }
}
