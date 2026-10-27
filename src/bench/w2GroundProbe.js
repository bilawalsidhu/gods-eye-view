// Local QA entry only: actual forward-scene geometry through public Navara
// EffectDesc context. Normal production does not import this module.
export async function createW2ForwardMeshProbe({
  view,
  EffectDesc,
  NavaraEffect,
}) {
  const { Effect, EffectAttribute } = await import('postprocessing');
  const { BoxGeometry, Mesh, MeshBasicMaterial, Vector3 } =
    await import('three');
  const geo = await import('../geo/index.js');
  let context;
  class ContextProbe extends EffectDesc {
    static key = 'gevW2ContextProbe';
    static insertBefore = ['final'];
    constructor(view, ctx, config) {
      super(view, ctx, config);
      context = ctx;
    }
    createPass() {
      this.effect = new Effect(
        'GevW2ContextProbe',
        'void mainImage(const in vec4 inputColor,const in vec2 uv,out vec4 outputColor){outputColor=inputColor;}',
        { attributes: EffectAttribute.CONVOLUTION },
      );
      return new NavaraEffect(this.view.camera.raw, this.effect);
    }
    onDestroy() {
      this.effect?.dispose();
      super.onDestroy();
    }
  }
  view.registerEffect(ContextProbe.key, ContextProbe);
  const handle = view.addEffect({ [ContextProbe.key]: {}, visible: true });
  const geometry = new BoxGeometry(200, 200, 200);
  const material = new MeshBasicMaterial({
    color: 0x808080,
    toneMapped: false,
  });
  const mesh = new Mesh(geometry, material);
  const position = geo.cartesian3.fromDegrees(-122.4028, 37.7952, 1000);
  mesh.position.set(position.x, position.y, position.z);
  const up = geo.ellipsoid.WGS84.geodeticSurfaceNormal(position);
  mesh.quaternion.setFromUnitVectors(
    new Vector3(0, 0, 1),
    new Vector3(up.x, up.y, up.z),
  );
  context.scenes.opaque.add(mesh);
  return {
    dispose() {
      context.scenes.opaque.remove(mesh);
      geometry.dispose();
      material.dispose();
      handle.delete();
    },
  };
}
