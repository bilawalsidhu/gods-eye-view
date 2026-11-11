// The checked, engine-neutral state of a radial ground pulse field.
// The caller supplies fronts and opacity; the field owns no clock or timer.

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const unit = (value) => finite(value) && value >= 0 && value <= 1;
const list = (value) => Array.isArray(value) || ArrayBuffer.isView(value);
const fail = (message) => {
  throw new TypeError(`Ground pulse field: ${message}`);
};

function centerOf(value) {
  if (
    !value ||
    ![value.x, value.y, value.z].every(finite) ||
    Math.hypot(value.x, value.y, value.z) === 0
  )
    fail('center must be an Earth-fixed position');
  return { x: value.x, y: value.y, z: value.z };
}

function rgba(value, name) {
  if (!list(value) || value.length !== 4 || !Array.from(value).every(unit))
    fail(`${name} must be rgba in 0..1`);
  return Array.from(value);
}

function fronts(value, name) {
  if (!list(value) || value.length > 4 || !Array.from(value).every(unit))
    fail(`${name} must hold up to four values in 0..1`);
  return Array.from({ length: 4 }, (_, index) => value[index] ?? 0);
}

export function createGroundPulseRegistry(
  build = () => ({}),
  hasSet = () => false,
) {
  const live = new Map();
  return {
    live,
    create(input) {
      if (!input || typeof input.id !== 'string' || !input.id)
        fail('id must be a non-empty string');
      if (live.has(input.id) || hasSet(input.id))
        throw new Error(`Ground set ${input.id} already exists`);
      const options = {
        ...input,
        center: centerOf(input.center),
        heightM: input.heightM ?? 0,
      };
      for (const name of ['radiusM', 'depth', 'lineWidth'])
        if (!finite(options[name]) || options[name] <= 0)
          fail(`${name} must be positive`);
      if (options.depth > 1) fail('depth must be at most 1');
      if (!finite(options.heightM) || options.heightM < 0)
        fail('heightM must be non-negative');
      if (
        !finite(options.haloWidth) ||
        options.haloWidth < 0 ||
        options.haloWidth > options.lineWidth
      )
        fail('haloWidth must be between 0 and lineWidth');
      for (const name of ['color', 'lineColor', 'haloColor'])
        options[name] = rgba(input[name], name);
      const part = build(options);
      const state = {
        options,
        center: options.center,
        radii: [0, 0, 0, 0],
        alphas: [0, 0, 0, 0],
        level: 0,
        destroyed: false,
      };
      const handle = {
        id: options.id,
        draw(input) {
          if (state.destroyed) return;
          if (!input || !unit(input.level)) fail('level must be in 0..1');
          const radii = fronts(input.radii, 'radii');
          const alphas = fronts(input.alphas, 'alphas');
          Object.assign(state, { radii, alphas, level: input.level });
          part.draw?.(state);
        },
        move(center) {
          if (state.destroyed) return;
          state.center = centerOf(center);
          part.move?.(state.center);
        },
        destroy() {
          if (state.destroyed) return;
          state.destroyed = true;
          live.delete(options.id);
          part.destroy?.();
        },
        isDestroyed: () => state.destroyed,
      };
      state.handle = handle;
      live.set(options.id, state);
      part.draw?.(state);
      return handle;
    },
    list: () =>
      [...live.values()].map(({ options, level }) => ({
        id: options.id,
        kind: 'pulse-field',
        count: 1,
        shown: level > 0,
        order: 0,
        animated: false,
      })),
    destroyAll() {
      for (const state of [...live.values()]) state.handle.destroy();
    },
  };
}
