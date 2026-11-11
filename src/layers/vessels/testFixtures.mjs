// Test doubles shared by the vessel layer's tests: a renderer that records
// what the logic asks for, and the application services the layer reads.
import * as selection from '../../data/selectionDispatcher.js';
import * as picking from '../../data/pickRegistry.js';

const noop = () => {};
const RAD = Math.PI / 180;

/**
 * A renderer of plain records over the engine: what the logic asks for.
 * `camera` places the view (default: 10,000 km over 0°, 0°); `moveTo` moves
 * it 60 km over a point and raises moveEnd; `raiseFollow` raises a follow
 * change.
 */
export function recordingRenderer(
  engine,
  {
    positionWC = { x: 0, y: 0, z: 20_000_000 },
    positionCartographic = { latitude: 0, longitude: 0, height: 1e7 },
  } = {},
) {
  const sprites = new Set();
  const moveEnd = new Set();
  const followListeners = new Set();
  const camera = {
    positionWC,
    positionCartographic,
    rightWC: { x: 1, y: 0, z: 0 },
    upWC: { x: 0, y: 1, z: 0 },
    heading: 0,
    pitch: 0,
    roll: 0,
  };
  let following = false;
  let attached = false;
  return {
    sprites,
    camera,
    moveTo(lat, lon) {
      camera.positionCartographic = {
        latitude: lat * RAD,
        longitude: lon * RAD,
        height: 60_000,
      };
      for (const listener of moveEnd) listener();
    },
    raiseFollow(active) {
      following = active;
      for (const listener of followListeners) listener();
    },
    renderer: {
      engine,
      view: {
        camera,
        scene: { canvas: { clientWidth: 0, clientHeight: 0 } },
        horizon: () => ({ isPointVisible: () => true }),
        worldToWindow: () => undefined,
        canvasSize: () => ({ width: 1280, height: 800 }),
        requestRender: noop,
        on(event, listener) {
          if (event !== 'moveEnd') return noop;
          moveEnd.add(listener);
          return () => moveEnd.delete(listener);
        },
      },
      fleet: {
        attached: () => attached,
        attach() {
          attached = true;
        },
        setVisible: noop,
        add(spec) {
          const sprite = { ...spec };
          sprites.add(sprite);
          return sprite;
        },
        remove: (sprite) => sprites.delete(sprite),
        detach() {
          attached = false;
        },
      },
      pickedRecord: (picked) =>
        picked?.id && typeof picked.id === 'object' ? picked.id : null,
      follow: {
        onChanged(listener) {
          followListeners.add(listener);
          return () => followListeners.delete(listener);
        },
        active: () => following,
      },
      trails: { create: () => null },
      destroy: noop,
    },
  };
}

/** The application services the layer reads, creating `renderer`. */
export function services(renderer) {
  return {
    context: {
      clearSelectedEntityContextForLayer: noop,
      registerEntityContext: () => null,
      selectEntityContext: noop,
    },
    labels: {},
    picking,
    overlay: {
      setEntries: noop,
      setVisible: noop,
      clearSource: noop,
      hitTest: () => null,
    },
    geoid: { ensureGeoidReady: () => new Promise(noop), geoidHeight: () => 0 },
    sprites: {
      registerSpriteCollection: noop,
      restoreSpriteOrder: noop,
      restoreSpriteOrderOnEnable: noop,
    },
    focus: {
      focusNowMs: (now) => now,
      getFocusTarget: () => null,
      focusPassIsNeeded: () => false,
      forgetSpriteFocus: noop,
    },
    worldFocus: { requestWorldFocus: noop },
    render: {
      holdContinuousRender: noop,
      releaseContinuousRender: noop,
      governorRequestRender: noop,
    },
    selection,
    renderer: { create: () => renderer },
  };
}
