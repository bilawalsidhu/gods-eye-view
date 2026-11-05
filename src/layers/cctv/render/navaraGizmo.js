import { GIZMO_ID_PREFIX } from '../../../data/cctvGizmo.js';
import { createCctvNavaraLine } from './navaraLine.js';

export function createNavaraCctvGizmoRenderer(engine) {
  const entities = new Map();
  const removers = [];
  let destroyed = false;
  const pointSets = new Set();
  const makePoint = (part, color, size) => {
    const id = `${GIZMO_ID_PREFIX}${part}`;
    const set = engine.movers.createSet({
      id,
      kind: 'point',
      capacity: 1,
      pickable: true,
      depthTest: 'always',
      order: 100,
      point: { sizePx: size, outlinePx: 2, outlineColor: [0, 0, 0, 0.7] },
    });
    pointSets.add(set);
    let position = { x: 0, y: 0, z: 0 };
    let visible = false;
    let pixelSize = size;
    const sync = () => {
      if (destroyed) return;
      set.setCount(1);
      set.set(0, {
        position,
        show: visible,
        scale: pixelSize / size,
        color: color.rgba(),
        pickId: id,
      });
      set.commit();
    };
    return {
      id,
      get position() {
        return position;
      },
      set position(value) {
        position = value;
        sync();
      },
      get show() {
        return visible;
      },
      set show(value) {
        if (visible !== Boolean(value)) {
          visible = Boolean(value);
          sync();
        }
      },
      point: {
        get pixelSize() {
          return pixelSize;
        },
        set pixelSize(value) {
          if (value !== pixelSize) {
            pixelSize = value;
            sync();
          }
        },
      },
    };
  };
  const add = (part, entity) => {
    entities.set(part, entity);
    return entity;
  };
  const assertNew = (part) => {
    if (destroyed) throw new Error('CCTV gizmo is destroyed');
    if (entities.has(part))
      throw new Error(`CCTV handle is already owned: ${part}`);
  };
  return {
    createPoint(part, color, size) {
      assertNew(part);
      return add(part, makePoint(part, color, size));
    },
    createLine(part, color, width, arrow = false) {
      assertNew(part);
      const line = createCctvNavaraLine(engine, `${GIZMO_ID_PREFIX}${part}`, {
        tint: color.withAlpha(arrow ? 1 : 0.9),
        depthFail: color.withAlpha(0.45),
        width,
        arrow,
        order: 100,
      });
      if (!arrow) return add(part, line);
      let point;
      try {
        point = makePoint(part, color, 14);
      } catch (error) {
        line.destroy();
        throw error;
      }
      const visibility = Object.getOwnPropertyDescriptor(point, 'show');
      Object.defineProperty(point, 'show', {
        get: visibility.get,
        set(value) {
          visibility.set(value);
          line.show = value;
        },
      });
      point.polyline = line.polyline;
      point.destroy = () => line.destroy();
      return add(part, point);
    },
    pickPart(position) {
      for (const hit of engine.picker.drillPick(position, 6)) {
        if (typeof hit?.id !== 'string' || !hit.id.startsWith(GIZMO_ID_PREFIX))
          continue;
        const part = hit.id.slice(GIZMO_ID_PREFIX.length);
        if (hit.owner === hit.id && entities.get(part)?.show) return part;
      }
      return null;
    },
    pickRay: (position) => engine.camera.pickRay(position),
    setCursor(value) {
      if (engine.host.canvas.style) engine.host.canvas.style.cursor = value;
    },
    suspendCameraInputs: () => engine.input.suspendCameraInputs(),
    on(type, listener) {
      if (type !== 'cancel') {
        removers.push(engine.input.on(type, listener));
        return;
      }
      const canvas = engine.host.canvas;
      for (const [target, event] of [
        [canvas, 'pointercancel'],
        [canvas.ownerDocument?.defaultView, 'blur'],
      ]) {
        if (!target?.addEventListener) continue;
        target.addEventListener(event, listener);
        removers.push(() => target.removeEventListener(event, listener));
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const remove of removers.splice(0)) remove();
      for (const entity of entities.values()) entity.destroy?.();
      for (const set of pointSets) set.destroy();
      entities.clear();
      pointSets.clear();
      if (engine.host.canvas.style) engine.host.canvas.style.cursor = '';
    },
  };
}
