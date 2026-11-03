import * as Cesium from 'cesium';

// Narrow, version-tested engine adapter. Cesium has no public custom shader
// option for native point/billboard collections. Do not patch its prototypes or
// access EntityCluster's private collections. An engine upgrade must revalidate
// this adapter; unsupported versions keep the original commands unchanged.
export const CYBER_SONAR_CESIUM_VERSION = '1.138.0';

// Follow every public DrawCommand setter, including pick/shadow/culling flags.
// Copying native.dirty would keep derived pipelines dirty forever: the scene
// consumes our command, so it never clears that flag on the native command.
const commandProperties = Object.entries(
  Object.getOwnPropertyDescriptors(Cesium.DrawCommand.prototype),
)
  .filter(
    ([key, descriptor]) =>
      descriptor.set && key !== 'shaderProgram' && key !== 'uniformMap',
  )
  .map(([key]) => key);

export function syncCyberSonarCommand(
  native,
  record,
  program,
  uniforms,
  labelBackground,
) {
  if (!record.command) {
    record.command = new Cesium.DrawCommand();
    record.uniformMap = {
      ...uniforms,
      u_gevSonarLabelBackground: () => record.labelBackground,
    };
  }
  const command = record.command;
  record.labelBackground = labelBackground;
  // Uniform values (angle/viewport/etc.) change through stable callbacks, not
  // new maps/functions. Owner callback replacement and removal still propagate.
  for (const key in record.uniformMap) {
    if (
      !(key in uniforms) &&
      key !== 'u_gevSonarLabelBackground' &&
      !(key in native.uniformMap)
    ) {
      delete record.uniformMap[key];
      command.dirty = true;
    }
  }
  for (const key in native.uniformMap) {
    if (record.uniformMap[key] !== native.uniformMap[key]) {
      record.uniformMap[key] = native.uniformMap[key];
      command.dirty = true;
    }
  }
  for (const key of commandProperties) command[key] = native[key];
  command.shaderProgram = program;
  command.uniformMap = record.uniformMap;
  return command;
}

export function sonarVertexSource(source, kind) {
  const text = source.sources.join('\n');
  const attribute =
    kind === 'point' ? 'positionHighAndSize' : 'positionHighAndScale';
  const lowAttribute =
    kind === 'point' ? 'positionLowAndOutline' : 'positionLowAndRotation';
  if (
    !text.includes(attribute) ||
    !text.includes(lowAttribute) ||
    !text.includes('v_color') ||
    !/void\s+main\s*\(\s*\)/.test(text)
  )
    return null;
  const next = source.clone();
  next.sources = [
    text.replace(/void\s+main\s*\(\s*\)/, 'void gev_sonar_main()'),
    `
uniform vec4 u_gevSonar; // angle, radius, opacity floor, sweep enabled
uniform vec2 u_gevSonarViewport;
uniform float u_gevSonarSector;
uniform float u_gevSonarLabelBackground;
void main() {
    gev_sonar_main();
    // All corners/glyphs share the contact anchor, before native screen offsets.
    // Leave gl_Position untouched so appearance never changes geometry or picks.
    vec4 anchor = czm_modelViewProjectionRelativeToEye * czm_translateRelativeToEye(${attribute}.xyz, ${lowAttribute}.xyz);
    if (anchor.w <= 0.0) return;
    vec2 pixel = anchor.xy / anchor.w * u_gevSonarViewport * 0.5;
    float floorValue = u_gevSonar.z;
    float factor = floorValue + (1.0 - floorValue) * 0.46;
    if (u_gevSonar.w > 0.5) {
        float distanceSquared = dot(pixel, pixel);
        float radiusSquared = u_gevSonar.y * u_gevSonar.y;
        float delta = mod(degrees(atan(pixel.x, pixel.y)) - u_gevSonar.x + 360.0, 360.0);
        if (delta > 359.9999) delta = 0.0;
        factor = floorValue;
        if (distanceSquared < radiusSquared * 0.000625) factor = 1.0;
        else if (distanceSquared <= radiusSquared && delta <= u_gevSonarSector)
            factor += (1.0 - floorValue) * min(1.0, (u_gevSonarSector - delta) / min(10.0, u_gevSonarSector * 0.42));
    }
    #ifdef SDF
    factor = (1.0 + factor) * 0.5;
    #else
    if (u_gevSonarLabelBackground > 0.5) factor = (1.0 + factor) * 0.5;
    #endif
    float coverage = floorValue >= 0.9999 ? 1.0 : clamp((factor - floorValue) / (1.0 - floorValue), 0.0, 1.0);
    if (u_gevSonarLabelBackground < 0.5)
        v_color.rgb = v_color.rgb * 0.28 + (vec3(0.62, 0.68, 0.72) + vec3(0.38, 0.16, 0.12) * coverage) * 0.72;
    // Apply before native fragment pass classification, never after main().
    v_color.a *= factor;
    ${kind === 'point' ? 'v_outlineColor.a *= factor;' : '#ifdef SDF\n    v_outlineColor.a *= factor;\n    #endif'}
}
`,
  ];
  return next;
}

// Use native batch bounds, never individual contacts, for idle render demand.
// Like Cesium's frustum builder, exclude the far plane (it fits multiple frusta).
export function isCyberSonarCommandVisible(command, frameState, culling) {
  const bounds = command.boundingVolume;
  if (!bounds || !command.cull) return true;
  culling ??= new Cesium.CullingVolume(
    frameState.cullingVolume.planes.slice(0, 5),
  );
  if (culling.computeVisibility(bounds) === Cesium.Intersect.OUTSIDE)
    return false;
  return !(
    frameState.mode === Cesium.SceneMode.SCENE3D &&
    frameState.occluder &&
    command.occlude &&
    bounds.isOccluded(frameState.occluder)
  );
}

/** Work scales with draw commands, not the number of contacts in a collection.
 * Source programs, colors, pick IDs, render states and other scenes stay owned
 * by Cesium. Only this scene's rendered command slice receives derived shaders.
 */
export function createCyberSonarGpu(scene, readFrame) {
  const root = scene.primitives;
  const original = root.update;
  const programs = new Map();
  let commands = new WeakMap();
  let disposed = false;
  const stats = {
    commands: 0,
    visibleCommands: 0,
    programs: 0,
    supported: Cesium.VERSION === CYBER_SONAR_CESIUM_VERSION,
    error: null,
  };
  const uniforms = new Cesium.Cartesian4();
  const viewport = new Cesium.Cartesian2();
  let sector = 24;
  const sonarUniforms = {
    u_gevSonar: () => uniforms,
    u_gevSonarViewport: () => viewport,
    u_gevSonarSector: () => sector,
  };
  const culling = new Cesium.CullingVolume();
  const used = new Set();
  const replaced = [];
  const release = () => {
    for (const { program } of programs.values())
      if (!program.isDestroyed()) program.destroy();
    programs.clear();
    commands = new WeakMap();
    used.clear();
    replaced.length = 0;
    stats.programs = 0;
  };
  const wrapped = function (frameState) {
    const start = frameState.commandList.length;
    original.call(this, frameState);
    stats.commands = 0;
    stats.visibleCommands = 0;
    if (
      disposed ||
      !stats.supported ||
      !frameState.passes.render ||
      frameState.passes.pick
    )
      return;
    const frame = readFrame();
    if (!frame.enabled) {
      if (programs.size) release();
      return;
    }
    viewport.x = scene.drawingBufferWidth;
    viewport.y = scene.drawingBufferHeight;
    uniforms.x = frame.angle;
    uniforms.y =
      (Math.min(viewport.x * 0.4, viewport.y * 0.52) * frame.range) / 100;
    uniforms.z = frame.opacity / 100;
    uniforms.w = frame.active ? 1 : 0;
    sector = frame.sector;
    used.clear();
    replaced.length = 0;
    if (frameState.cullingVolume)
      for (let i = 0; i < 5; i++)
        culling.planes[i] = frameState.cullingVolume.planes[i];
    try {
      for (let i = start; i < frameState.commandList.length; i++) {
        const native = frameState.commandList[i];
        const kind =
          native.owner instanceof Cesium.PointPrimitiveCollection
            ? 'point'
            : native.owner instanceof Cesium.BillboardCollection
              ? 'billboard'
              : null;
        if (!kind || !native.shaderProgram || !native.uniformMap) continue;
        const source = native.shaderProgram;
        // Label backgrounds are non-SDF billboard batches. The version-tested
        // engine pick association distinguishes them without enumerating labels
        // or reaching into EntityCluster. One representative per draw batch;
        // Cesium's label glyph/background collections are homogeneous.
        const labelBackground =
          kind === 'billboard' &&
          !source.vertexShaderSource.defines.includes('SDF') &&
          native.owner.length > 0 &&
          native.owner.get(0).pickPrimitive instanceof Cesium.Label
            ? 1
            : 0;
        let entry = programs.get(source);
        if (!entry) {
          const vertex = sonarVertexSource(source.vertexShaderSource, kind);
          if (!vertex) throw new Error('Unsupported native contact shader');
          const attributes = Object.fromEntries(
            Object.entries(source.vertexAttributes).map(([name, value]) => [
              name,
              value.index,
            ]),
          );
          const program = Cesium.ShaderProgram.fromCache({
            context: frameState.context,
            vertexShaderSource: vertex,
            fragmentShaderSource: source.fragmentShaderSource,
            attributeLocations: attributes,
          });
          // Compile while errors can still leave the whole native command slice
          // intact, rather than stopping the viewer's render loop at draw time.
          try {
            void program.allUniforms;
          } catch (error) {
            program.destroy();
            throw error;
          }
          programs.set(source, (entry = { program }));
        }
        used.add(source);
        let record = commands.get(native);
        if (!record) commands.set(native, (record = {}));
        const derived = syncCyberSonarCommand(
          native,
          record,
          entry.program,
          sonarUniforms,
          labelBackground,
        );
        replaced.push(i, native);
        frameState.commandList[i] = derived;
        stats.commands++;
        if (isCyberSonarCommandVisible(native, frameState, culling))
          stats.visibleCommands++;
      }
      for (const [source, entry] of programs)
        if (!used.has(source)) {
          if (!entry.program.isDestroyed()) entry.program.destroy();
          programs.delete(source);
        }
      stats.programs = programs.size;
    } catch (error) {
      // Recover the original commands already replaced in this slice.
      for (let i = 0; i < replaced.length; i += 2)
        frameState.commandList[replaced[i]] = replaced[i + 1];
      stats.supported = false;
      stats.commands = 0;
      stats.visibleCommands = 0;
      stats.error = String(error?.message || error);
      release();
    }
  };
  root.update = wrapped;
  return {
    stats,
    destroy() {
      if (disposed) return;
      disposed = true;
      if (root.update === wrapped && !root.isDestroyed?.())
        root.update = original;
      release();
    },
  };
}
