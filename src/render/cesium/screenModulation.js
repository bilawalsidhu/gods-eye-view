/**
 * @module render/cesium/screenModulation
 * @description The Cesium effects port's `screenModulation`
 * (`src/render/contract/effects.d.ts`): a sweeping band over the drawn
 * markers. It is not a full-screen stage, since the map, lines and shapes
 * must draw as they are: each marker is shaded by where its anchor is on
 * screen.
 *
 * - Points, billboards (labels among them) and icon sets: their draw
 *   commands in this scene's command list are swapped, as the scene's
 *   primitives update, for derived commands whose vertex shader runs the
 *   native one and then scales the colour by the band. `gl_Position` is
 *   left alone, so geometry and picks are unchanged (pick passes keep the
 *   native commands). Cesium has no public shader hook for these
 *   collections, so the swap is tested against one Cesium version
 *   (`SCREEN_MODULATION_CESIUM_VERSION`); on any other, or once a native
 *   shader it does not know turns up, it draws nothing and the pass is not
 *   listed.
 * - Models: their colour is set each drawn frame, after every owner has
 *   written its own (the walk is the last `preRender` listener), and the
 *   owner's colour is given back when the sector goes.
 *
 * The band: full at `angle`, fading over the last part of `width` (at most
 * 10 degrees, at most 42% of it) clockwise from there, and full inside a
 * small disc at `center` (2.5% of `radius`). A marker's colour is pulled by
 * `strength` toward a cool grey outside the band and toward `color` inside
 * it; at a radius of 0 every marker is pulled toward `color`. Labels keep
 * half of what the band takes away, and their backgrounds keep their
 * colour.
 *
 * Render demand: a set asks for a frame, except one that changes nothing
 * drawn: the same sector again, or one that only moves the angle (of a
 * sweeping band) while the last drawn frame had no shaded marker in view.
 * The sweep then needs no frames of its own; a frame drawn for anything
 * else draws the latest sector.
 */
import * as Cesium from 'cesium';
import { IconSetPrimitive } from './iconSetPrimitive.js';

/** The Cesium version the command swap is tested against. */
export const SCREEN_MODULATION_CESIUM_VERSION = '1.138.0';

/** Whether this Cesium can draw the pass at all. */
export const screenModulationSupported = () =>
  Cesium.VERSION === SCREEN_MODULATION_CESIUM_VERSION;

/** The colour markers outside the band are pulled toward. */
const DIM_TINT = Object.freeze([0.62, 0.68, 0.72]);
const FEATHER_DEG = 10;
const FEATHER_SHARE = 0.42;
/** The full disc at the centre, as a share of the radius. */
const CORE_SHARE = 0.025;
const DEG = 180 / Math.PI;

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const finite = (value, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

/**
 * A contract sector as the pass uses it: degrees, the colour as channels.
 * @param {import('../contract/effects').ModulationSector} sector
 */
export function normalizeSector(sector) {
  const color =
    Cesium.Color.fromCssColorString(String(sector.color ?? '')) ??
    Cesium.Color.WHITE;
  return {
    cx: finite(sector.center?.x),
    cy: finite(sector.center?.y),
    angle: (((finite(sector.angle) * DEG) % 360) + 360) % 360,
    width: Math.max(0, finite(sector.width) * DEG),
    radius: Math.max(0, finite(sector.radius)),
    floor: clamp01(finite(sector.floor, 1)),
    strength: clamp01(finite(sector.strength)),
    rgb: [color.red, color.green, color.blue],
  };
}

/** Whether two normalized sectors differ in more than their angle. */
const differsBeyondAngle = (a, b) =>
  !a ||
  !b ||
  a.cx !== b.cx ||
  a.cy !== b.cy ||
  a.width !== b.width ||
  a.radius !== b.radius ||
  a.floor !== b.floor ||
  a.strength !== b.strength ||
  a.rgb.some((c, i) => c !== b.rgb[i]);

/**
 * The band's factor and tint at CSS pixels, for what is shaded on the CPU
 * (models). The GPU pass computes the same in its vertex shader.
 * @param {ReturnType<typeof normalizeSector>} s
 */
export function sectorSampler(s) {
  const radiusSquared = s.radius * s.radius;
  const feather = Math.min(FEATHER_DEG, s.width * FEATHER_SHARE);
  const sweeping = s.radius > 0;
  return {
    floor: s.floor,
    /** Equal for samplers that tint alike (the angle aside). */
    key: `${s.floor}|${s.strength}|${s.rgb.join(',')}|${sweeping}`,
    at(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return 1;
      if (!sweeping) return s.floor;
      const dx = x - s.cx;
      const dy = y - s.cy;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared > radiusSquared) return s.floor;
      if (distanceSquared < radiusSquared * CORE_SHARE * CORE_SHARE) return 1;
      const delta = (((Math.atan2(dx, -dy) * DEG - s.angle) % 360) + 360) % 360;
      if (delta > s.width) return s.floor;
      return (
        s.floor +
        (1 - s.floor) * Math.min(1, (s.width - delta) / (feather || 1))
      );
    },
    /** How far toward `color` (from the grey) a factor tints. */
    coverage(factor) {
      if (!sweeping || s.floor >= 0.9999) return 1;
      return clamp01((factor - s.floor) / (1 - s.floor));
    },
    tint(base, factor, out) {
      const c = this.coverage(factor);
      const k = s.strength;
      out.red =
        base.red * (1 - k) + (DIM_TINT[0] + (s.rgb[0] - DIM_TINT[0]) * c) * k;
      out.green =
        base.green * (1 - k) + (DIM_TINT[1] + (s.rgb[1] - DIM_TINT[1]) * c) * k;
      out.blue =
        base.blue * (1 - k) + (DIM_TINT[2] + (s.rgb[2] - DIM_TINT[2]) * c) * k;
      return out;
    },
  };
}

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

/**
 * The derived command for `native`, kept in `record` across frames: every
 * native field followed, its own program and the pass's uniforms.
 */
export function syncModulatedCommand(
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

/**
 * The native vertex shader with the band applied after it, or null for a
 * shader the pass does not know.
 * @param {object} source A Cesium ShaderSource.
 * @param {'point'|'billboard'|'icon'} kind
 */
export function modulationVertexSource(source, kind) {
  const text = source.sources.join('\n');
  const attribute =
    kind === 'point' ? 'positionHighAndSize' : 'positionHighAndScale';
  const lowAttribute =
    kind === 'point' ? 'positionLowAndOutline' : 'positionLowAndRotation';
  // Icon sets move rows on the GPU, so their shader publishes the anchor itself.
  const anchorSource =
    kind === 'icon'
      ? 'iconAnchorClip'
      : `czm_modelViewProjectionRelativeToEye * czm_translateRelativeToEye(${attribute}.xyz, ${lowAttribute}.xyz)`;
  if (
    (kind === 'icon'
      ? !text.includes('iconAnchorClip')
      : !text.includes(attribute) || !text.includes(lowAttribute)) ||
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
uniform vec2 u_gevSonarCenter;
uniform float u_gevSonarSector;
uniform vec4 u_gevSonarTint; // colour, strength
uniform float u_gevSonarLabelBackground;
void main() {
    gev_sonar_main();
    // All corners/glyphs share the contact anchor, before native screen offsets.
    // Leave gl_Position untouched so appearance never changes geometry or picks.
    vec4 anchor = ${anchorSource};
    if (anchor.w <= 0.0) return;
    vec2 pixel = anchor.xy / anchor.w * u_gevSonarViewport * 0.5 - u_gevSonarCenter;
    float floorValue = u_gevSonar.z;
    float factor = floorValue;
    if (u_gevSonar.w > 0.5) {
        float distanceSquared = dot(pixel, pixel);
        float radiusSquared = u_gevSonar.y * u_gevSonar.y;
        float delta = mod(degrees(atan(pixel.x, pixel.y)) - u_gevSonar.x + 360.0, 360.0);
        if (delta > 359.9999) delta = 0.0;
        if (distanceSquared < radiusSquared * ${(CORE_SHARE * CORE_SHARE).toFixed(6)}) factor = 1.0;
        else if (distanceSquared <= radiusSquared && delta <= u_gevSonarSector)
            factor += (1.0 - floorValue) * min(1.0, (u_gevSonarSector - delta) / max(min(${FEATHER_DEG.toFixed(1)}, u_gevSonarSector * ${FEATHER_SHARE}), 1e-4));
    }
    #ifdef SDF
    factor = (1.0 + factor) * 0.5;
    #else
    if (u_gevSonarLabelBackground > 0.5) factor = (1.0 + factor) * 0.5;
    #endif
    float coverage = (u_gevSonar.w < 0.5 || floorValue >= 0.9999) ? 1.0 : clamp((factor - floorValue) / (1.0 - floorValue), 0.0, 1.0);
    if (u_gevSonarLabelBackground < 0.5)
        v_color.rgb = v_color.rgb * (1.0 - u_gevSonarTint.a) + mix(vec3(${DIM_TINT.join(', ')}), u_gevSonarTint.rgb, coverage) * u_gevSonarTint.a;
    // Apply before native fragment pass classification, never after main().
    v_color.a *= factor;
    ${kind === 'point' ? 'v_outlineColor.a *= factor;' : kind === 'icon' ? '' : '#ifdef SDF\n    v_outlineColor.a *= factor;\n    #endif'}
}
`,
  ];
  return next;
}

/**
 * Whether a command's batch may be in view: its bounds against the frame's
 * culling planes (the far plane left out, as Cesium's frustum builder does,
 * since a batch fits several frusta) and the horizon.
 */
export function isModulatedCommandVisible(command, frameState, culling) {
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

const alive = (value) => value && !value.isDestroyed?.();

/**
 * Calls `visit(model, visible)` for each model under `primitive`, nested
 * collections included, without walking the markers of any collection.
 */
export function visitModels(primitive, visit, visible = true) {
  if (!alive(primitive)) return;
  visible = visible && primitive.show !== false;
  if (primitive instanceof Cesium.PrimitiveCollection) {
    for (let i = 0; i < primitive.length; i++)
      visitModels(primitive.get(i), visit, visible);
  } else if (primitive instanceof Cesium.Model) {
    visit(primitive, visible && primitive.ready);
  }
}

const sameColor = (a, b) =>
  a &&
  b &&
  a.red === b.red &&
  a.green === b.green &&
  a.blue === b.blue &&
  a.alpha === b.alpha;

/**
 * Model colours set by the pass, each over its owner's: a colour the owner
 * writes since is the new base, and the owner's comes back on restore.
 */
export function createModelTint() {
  const states = new Map();
  return {
    get size() {
      return states.size;
    },
    /** Shades `model` by `factor` (models stay opaque: RGB dims, not alpha). */
    apply(model, factor, sampler) {
      const current = model.color;
      let state = states.get(model);
      const owns = state && sameColor(current, state.applied);
      if (!owns) {
        const base = current
          ? Cesium.Color.clone(current)
          : new Cesium.Color(1, 1, 1, 1);
        state = {
          base,
          undefinedBase: current === undefined,
          applied: null,
          factor: Number.NaN,
          key: null,
        };
        states.set(model, state);
      } else if (
        Math.abs(factor - state.factor) <= 0.002 &&
        state.key === sampler.key
      ) {
        return;
      }
      const next = sampler.tint(state.base, factor, new Cesium.Color());
      next.red *= factor;
      next.green *= factor;
      next.blue *= factor;
      // Keep models in their owner's opaque/translucent render pass.
      next.alpha = state.base.alpha;
      model.color = next;
      // Cesium copies on set; compare against what it holds.
      state.applied = Cesium.Color.clone(model.color ?? next);
      state.factor = factor;
      state.key = sampler.key;
    },
    /** Gives `model` its owner's colour back, unless the owner wrote since. */
    restore(model) {
      const state = states.get(model);
      if (!state) return;
      states.delete(model);
      if (!alive(model)) return;
      if (sameColor(model.color, state.applied))
        model.color = state.undefinedBase ? undefined : state.base;
    },
    restoreAll() {
      for (const model of [...states.keys()]) this.restore(model);
    },
    keys: () => states.keys(),
  };
}

/**
 * @param {object} scene A Cesium scene.
 * @param {{
 *   frame: {requestRender: (reason?: string) => void},
 *   onChange: () => void,
 * }} options `onChange` runs when whether the pass draws changes on its own
 *   (a native shader it cannot take turns up).
 */
export function createCesiumScreenModulation(scene, { frame, onChange }) {
  let sector = null;
  let sampler = null;
  let disposed = false;
  let installed = null;
  /** Whether the last drawn frame modulated a marker in view. */
  let lastVisible = false;
  const stats = {
    commands: 0,
    visibleCommands: 0,
    models: 0,
    programs: 0,
    supported: screenModulationSupported(),
    error: null,
  };

  const uniforms = new Cesium.Cartesian4();
  const viewport = new Cesium.Cartesian2();
  const center = new Cesium.Cartesian2();
  const tint = new Cesium.Cartesian4();
  let width = 24;
  const passUniforms = {
    u_gevSonar: () => uniforms,
    u_gevSonarViewport: () => viewport,
    u_gevSonarCenter: () => center,
    u_gevSonarSector: () => width,
    u_gevSonarTint: () => tint,
  };

  const draws = () => !disposed && stats.supported && sector !== null;

  /** Installs the command swap and the model walk on first use. */
  function install() {
    const root = scene.primitives;
    const original = root.update;
    const programs = new Map();
    let commands = new WeakMap();
    const culling = new Cesium.CullingVolume();
    const used = new Set();
    const replaced = [];
    const models = createModelTint();
    const matrix = new Cesium.Matrix4();
    const position = new Cesium.Cartesian3();

    const release = () => {
      for (const { program } of programs.values())
        if (!program.isDestroyed()) program.destroy();
      programs.clear();
      commands = new WeakMap();
      used.clear();
      replaced.length = 0;
      stats.programs = 0;
    };

    function fail(error) {
      stats.supported = false;
      stats.commands = 0;
      stats.visibleCommands = 0;
      stats.error = String(error?.message || error);
      release();
      // The frame drawing now has shaded models; the next one gives them back.
      frame.requestRender('effects-modulation');
      onChange();
    }

    const wrapped = function (frameState) {
      const start = frameState.commandList.length;
      original.call(this, frameState);
      stats.commands = 0;
      stats.visibleCommands = 0;
      if (!frameState.passes.render || frameState.passes.pick) return;
      if (!draws()) {
        if (programs.size) release();
        return;
      }
      const ratioX =
        scene.drawingBufferWidth / (scene.canvas?.clientWidth || 1) || 1;
      const ratioY =
        scene.drawingBufferHeight / (scene.canvas?.clientHeight || 1) || 1;
      viewport.x = scene.drawingBufferWidth;
      viewport.y = scene.drawingBufferHeight;
      center.x = sector.cx * ratioX - viewport.x / 2;
      center.y = viewport.y / 2 - sector.cy * ratioY;
      uniforms.x = sector.angle;
      uniforms.y = sector.radius * ratioX;
      uniforms.z = sector.floor;
      uniforms.w = sector.radius > 0 ? 1 : 0;
      width = sector.width;
      tint.x = sector.rgb[0];
      tint.y = sector.rgb[1];
      tint.z = sector.rgb[2];
      tint.w = sector.strength;
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
                : native.owner instanceof IconSetPrimitive
                  ? 'icon'
                  : null;
          if (!kind || !native.shaderProgram || !native.uniformMap) continue;
          const source = native.shaderProgram;
          // Label backgrounds are non-SDF billboard batches. The version-tested
          // engine pick association distinguishes them without enumerating
          // labels or reaching into EntityCluster. One representative per draw
          // batch; Cesium's label glyph/background collections are homogeneous.
          const labelBackground =
            kind === 'billboard' &&
            !source.vertexShaderSource.defines.includes('SDF') &&
            native.owner.length > 0 &&
            native.owner.get(0).pickPrimitive instanceof Cesium.Label
              ? 1
              : 0;
          let entry = programs.get(source);
          if (!entry) {
            const vertex = modulationVertexSource(
              source.vertexShaderSource,
              kind,
            );
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
            // Compile while errors can still leave the whole native command
            // slice intact, rather than stopping the render loop at draw time.
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
          const derived = syncModulatedCommand(
            native,
            record,
            entry.program,
            passUniforms,
            labelBackground,
          );
          replaced.push(i, native);
          frameState.commandList[i] = derived;
          stats.commands++;
          if (isModulatedCommandVisible(native, frameState, culling))
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
        fail(error);
      }
    };
    root.update = wrapped;

    let epoch = 0;
    const epochs = new WeakMap();
    const shadeModels = () => {
      if (!draws()) {
        models.restoreAll();
        stats.models = 0;
        return;
      }
      const cssWidth = scene.canvas?.clientWidth ?? 0;
      const cssHeight = scene.canvas?.clientHeight ?? 0;
      Cesium.Matrix4.multiply(
        scene.camera.frustum.projectionMatrix,
        scene.camera.viewMatrix,
        matrix,
      );
      epoch++;
      let count = 0;
      visitModels(scene.primitives, (model, visible) => {
        if (!visible) {
          models.restore(model);
          return;
        }
        const p = Cesium.Matrix4.getTranslation(model.modelMatrix, position);
        const w =
          matrix[3] * p.x + matrix[7] * p.y + matrix[11] * p.z + matrix[15];
        const x =
          (matrix[0] * p.x + matrix[4] * p.y + matrix[8] * p.z + matrix[12]) /
          w;
        const y =
          (matrix[1] * p.x + matrix[5] * p.y + matrix[9] * p.z + matrix[13]) /
          w;
        if (w <= 0 || Math.abs(x) > 1.1 || Math.abs(y) > 1.1) return;
        epochs.set(model, epoch);
        models.apply(
          model,
          sampler.at((x + 1) * cssWidth * 0.5, (1 - y) * cssHeight * 0.5),
          sampler,
        );
        count++;
      });
      // Out of view or gone since the last frame: the owner's colour back.
      for (const model of [...models.keys()])
        if (epochs.get(model) !== epoch) models.restore(model);
      stats.models = count;
    };

    // Owners write model colours in preRender (some after this was
    // installed): shade after all of them and before the draw uploads,
    // by taking the last preRender place again at every postUpdate.
    let offShade = null;
    const offUpdate = scene.postUpdate.addEventListener(() => {
      offShade?.();
      offShade = scene.preRender.addEventListener(shadeModels);
    });
    const offRendered = scene.postRender.addEventListener(() => {
      lastVisible = draws() && (stats.visibleCommands > 0 || stats.models > 0);
    });

    return {
      models,
      dispose() {
        offUpdate();
        offShade?.();
        offRendered();
        if (root.update === wrapped && !root.isDestroyed?.())
          root.update = original;
        release();
        models.restoreAll();
      },
    };
  }

  return {
    stats,
    draws,
    /**
     * Sets or clears the sector.
     * @param {import('../contract/effects').ModulationSector | null} next
     */
    set(next) {
      if (disposed || scene.isDestroyed?.()) return;
      const previous = sector;
      sector = next ? normalizeSector(next) : null;
      sampler = sector ? sectorSampler(sector) : null;
      if (sector && !installed && stats.supported) installed = install();
      if (!sector) {
        lastVisible = false;
        installed?.models.restoreAll();
        stats.models = 0;
        if (previous) frame.requestRender('effects-modulation');
        return;
      }
      // The angle moves only a band that sweeps, and only shaded markers.
      if (
        differsBeyondAngle(previous, sector) ||
        (lastVisible && sector.radius > 0 && sector.angle !== previous.angle)
      )
        frame.requestRender('effects-modulation');
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const had = sector;
      sector = null;
      if (installed && !scene.isDestroyed?.()) {
        installed.dispose();
        // The last shaded frame is still on screen.
        if (had) frame.requestRender('effects-modulation');
      }
      installed = null;
    },
  };
}
