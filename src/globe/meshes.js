// Indexed triangles in Earth-fixed metres. The registry owns copied geometry
// and style; each engine owns the resources that draw it.

import { cartesian3 } from '../geo/index.js';

function geometry(options) {
  const positions = Float64Array.from(options.positions ?? []);
  const indices = Array.from(options.indices ?? []);
  const uv = options.uv == null ? null : Float32Array.from(options.uv);
  if (
    positions.length < 9 ||
    positions.length % 3 ||
    !positions.every(Number.isFinite) ||
    !indices.length ||
    indices.length % 3 ||
    !indices.every(
      (i) => Number.isInteger(i) && i >= 0 && i < positions.length / 3,
    ) ||
    (uv &&
      (uv.length !== (positions.length / 3) * 2 || !uv.every(Number.isFinite)))
  )
    throw new TypeError('Invalid mesh triangles');
  return { positions, indices: new Uint32Array(indices), uv };
}

function normalize(options, previous, patch = options) {
  const color = Array.from(options.color ?? [1, 1, 1, 1]);
  if (
    color.length !== 4 ||
    !color.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
  )
    throw new TypeError('Invalid mesh color');
  const depthTest = options.depthTest ?? 'normal';
  if (!['normal', 'always'].includes(depthTest))
    throw new TypeError('Invalid mesh depthTest');
  if (options.show !== undefined && typeof options.show !== 'boolean')
    throw new TypeError('Mesh show must be a boolean');
  if (
    options.image != null &&
    (typeof options.image !== 'object' || !options.uv)
  )
    throw new TypeError(
      'A mesh image needs an image object and UV coordinates',
    );
  return {
    ...options,
    ...(previous && !['positions', 'indices', 'uv'].some((key) => key in patch)
      ? {
          positions: previous.positions,
          indices: previous.indices,
          uv: previous.uv,
        }
      : geometry(options)),
    color,
    depthTest,
    show: options.show !== false,
    image: options.image ?? null,
    pickId: options.pickId ?? null,
  };
}

/** Nearest forward intersection with either face of the indexed triangles. */
export function meshRayDistance(state, ray) {
  if (!ray) return Infinity;
  const { positions: p, indices } = state;
  const point = (i) => ({ x: p[i * 3], y: p[i * 3 + 1], z: p[i * 3 + 2] });
  const sub = (a, b) => cartesian3.subtract(a, b, cartesian3.create());
  const cross = (a, b) => cartesian3.cross(a, b, cartesian3.create());
  const direction = cartesian3.normalize(ray.direction, cartesian3.create());
  let nearest = Infinity;
  for (let i = 0; i < indices.length; i += 3) {
    const a = point(indices[i]);
    const ab = sub(point(indices[i + 1]), a);
    const ac = sub(point(indices[i + 2]), a);
    const normal = cross(direction, ac);
    const determinant = cartesian3.dot(ab, normal);
    if (Math.abs(determinant) < 1e-10) continue;
    const offset = sub(ray.origin, a);
    const u = cartesian3.dot(offset, normal) / determinant;
    if (u < 0 || u > 1) continue;
    const q = cross(offset, ab);
    const v = cartesian3.dot(direction, q) / determinant;
    if (v < 0 || u + v > 1) continue;
    const distance = cartesian3.dot(ac, q) / determinant;
    if (distance >= 0) nearest = Math.min(nearest, distance);
  }
  return nearest;
}

export function createMeshRegistry(make, request = () => {}) {
  const live = new Map();
  let destroyed = false;
  const meshes = {
    createMesh(options) {
      if (destroyed) throw new Error('Meshes are destroyed');
      if (
        typeof options?.id !== 'string' ||
        !options.id ||
        live.has(options.id)
      )
        throw new TypeError('Mesh id must be unique and nonempty');
      const state = normalize(options);
      let freed = false;
      const backend = make(state);
      const handle = {
        id: state.id,
        update(patch) {
          if (freed) return;
          const next = normalize(
            { ...state, ...patch, id: state.id },
            state,
            patch,
          );
          backend.update(next, patch);
          Object.assign(state, next);
          request();
        },
        show(value) {
          if (value === undefined) return !freed && state.show;
          handle.update({ show: Boolean(value) });
        },
        destroy() {
          if (freed) return;
          freed = true;
          live.delete(state.id);
          backend.destroy();
          request();
        },
      };
      live.set(state.id, { state, handle, backend });
      request();
      return handle;
    },
    list: () => [...live.keys()],
  };
  return {
    meshes,
    live,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const { handle } of [...live.values()]) handle.destroy();
    },
  };
}
