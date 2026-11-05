import { Material, Mesh } from 'three';

const stateKeys = [
  'side',
  'colorWrite',
  'depthWrite',
  'depthTest',
  'stencilWrite',
  'stencilFunc',
  'stencilRef',
  'stencilFuncMask',
  'stencilWriteMask',
  'stencilFail',
  'stencilZFail',
  'stencilZPass',
];

// Keep Navara's three stencil draws, but submit them together. Three resolves
// the entire multisampled MRT after each render(), even for colorWrite=false.
// Use the public DrapedMesh.process callback to obtain the SDK's exact states.
export function batchStencilDraws(mesh) {
  const process = mesh.process;
  if (!process || Array.isArray(mesh.material)) return mesh;
  const source = mesh.material;
  let stages = null,
    hidden = null,
    version = -1,
    disposed = false;
  const dispose = () => {
    disposed = true;
    source.removeEventListener('dispose', dispose);
    for (const stage of stages ?? []) stage.material.dispose();
    hidden?.dispose();
    stages = null;
  };
  source.addEventListener('dispose', dispose);
  mesh.process = function (render) {
    if (disposed) return;
    if (this.material !== source || this.children.length)
      return process.call(this, render);
    let index = 0;
    process.call(this, () => {
      if (!stages) {
        hidden = new Material();
        hidden.visible = false;
        stages = Array.from({ length: 3 }, (_, order) => {
          const stage = new Mesh(this.geometry, source.clone());
          stage.renderOrder = order;
          return stage;
        });
      }
      const stage = stages[index++];
      if (!stage) return;
      const material = stage.material;
      if (version !== source.version) {
        material.copy(source);
        material.defines = { ...source.defines };
        material.onBeforeCompile = source.onBeforeCompile;
        material.customProgramCacheKey = source.customProgramCacheKey;
        material.needsUpdate = true;
      }
      for (const key of stateKeys) material[key] = source[key];
      material.color = source.color;
      material.emissive = source.emissive;
      material.opacity = source.opacity;
      material.visible = source.visible;
      material.transparent = source.transparent;
      stage.geometry = this.geometry;
      stage.frustumCulled = this.frustumCulled;
      stage.layers.mask = this.layers.mask;
    });
    if (index === 0) return;
    if (index !== 3) return process.call(this, render);
    version = source.version;
    this.material = hidden;
    this.add(...stages);
    try {
      render();
    } finally {
      this.remove(...stages);
      this.material = source;
    }
  };
  return mesh;
}
