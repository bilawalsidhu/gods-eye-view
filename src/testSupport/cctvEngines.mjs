// The two engines the CCTV display tests run on: the fake engine and the
// Cesium engine over a stub scene (testSupport/cesiumMoversEngine.mjs). Each
// harness scripts picks of what the display drew (a mover instance or a
// line, as the engine's own pick returns it), fires screen input through
// engine.input and gives the canvas a style and a window, as the browser's.

import * as Cesium from 'cesium';
import * as geo from '../geo/index.js';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';
import { createCesiumMoversEngine } from './cesiumMoversEngine.mjs';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A canvas stand-in with a style and a window for blur. */
function testCanvas(width = 1280, height = 800) {
  const canvas = Object.assign(new EventTarget(), {
    clientWidth: width,
    clientHeight: height,
    width,
    height,
    style: {},
  });
  canvas.ownerDocument = { defaultView: new EventTarget() };
  return canvas;
}

// The camera looks down from 50 km over lon 0, lat 0, where the tests draw.
const VIEW = { height: 50_000 };

export function fakeCctvHarness() {
  const canvas = testCanvas();
  const engine = createFakeEngine({
    canvas,
    width: 1280,
    height: 800,
    altitude: VIEW.height,
  });
  const pickResult = (target) => {
    if (target.line) {
      const line = engine.fake.line(target.line);
      return { id: target.pickId ?? line.options.pickId, owner: target.line };
    }
    if (target.set) {
      const { store } = engine.fake.moverSet(target.set);
      return {
        id: target.pickId ?? store.pickIds[target.index ?? 0],
        owner: target.set,
        instance: target.index ?? 0,
      };
    }
    return target.result;
  };
  return {
    name: 'the fake engine',
    engine,
    canvas,
    frame: () => engine.fake.frame(),
    settle,
    fire: (type, event) => engine.fake.input(type, event),
    /** The next picks return these targets: { line } | { set, index } | { result }. */
    scriptPicks(...targets) {
      const results = targets.map(pickResult);
      engine.fake.script('pick', () => results[0]);
      engine.fake.script('drillPick', () => results);
    },
    // Camera inputs off at each suspension, on again at its resume.
    cameraInputs: () =>
      engine.fake.calls
        .filter(({ method }) =>
          ['input.suspendCameraInputs', 'input.resumeCameraInputs'].includes(
            method,
          ),
        )
        .map(({ method }) => method === 'input.resumeCameraInputs'),
    lineState: (id) => {
      const line = engine.fake.line(id);
      return line && { ...line.options, color: line.color, shown: line.shown };
    },
    destroy: () => engine.destroy(),
  };
}

/** Screen input for the Cesium engine's ScreenSpaceEventHandler seam. */
function testEventHandler() {
  const actions = new Map();
  return {
    setInputAction: (action, type, modifier) =>
      actions.set(`${type}:${modifier}`, action),
    removeInputAction: (type, modifier) =>
      actions.delete(`${type}:${modifier}`),
    fire: (type, event) => actions.get(`${type}:undefined`)?.(event),
    isDestroyed: () => false,
    destroy: () => actions.clear(),
  };
}

const CESIUM_TYPES = {
  click: Cesium.ScreenSpaceEventType.LEFT_CLICK,
  move: Cesium.ScreenSpaceEventType.MOUSE_MOVE,
  down: Cesium.ScreenSpaceEventType.LEFT_DOWN,
  up: Cesium.ScreenSpaceEventType.LEFT_UP,
};

export function cesiumCctvHarness() {
  const handler = testEventHandler();
  const { engine, viewer, frame, primitive } = createCesiumMoversEngine({
    engineOptions: {
      createEventHandler: () => handler,
      scheduleFrame: (run) => run(),
    },
  });
  viewer.scene.pick = () => undefined;
  viewer.scene.drillPick = () => [];
  const canvas = viewer.scene.canvas;
  canvas.style = {};
  canvas.ownerDocument = { defaultView: new EventTarget() };
  viewer.scene.screenSpaceCameraController = { enableInputs: true };
  // Camera inputs off at each suspension, on again at its resume.
  const inputs = [];
  const suspend = engine.input.suspendCameraInputs;
  engine.input.suspendCameraInputs = () => {
    inputs.push(false);
    const resume = suspend();
    return () => {
      inputs.push(true);
      resume();
    };
  };
  engine.camera.setView({
    destination: geo.cartesian3.fromDegrees(0, 0, VIEW.height),
  });
  const native = (target) => {
    if (target.line) {
      const drawn = primitive(target.line);
      return {
        primitive: drawn,
        id: target.pickId ?? drawn?.geometryInstances?.id,
      };
    }
    if (target.set) {
      const item = primitive(target.set).get(target.index ?? 0);
      return { primitive: item, id: target.pickId ?? item.id };
    }
    return target.native;
  };
  return {
    name: 'the Cesium engine',
    cesium: true,
    engine,
    viewer,
    canvas,
    primitive,
    frame,
    settle,
    fire: (type, event) =>
      handler.fire(CESIUM_TYPES[type], {
        ...(event.position
          ? {
              position: new Cesium.Cartesian2(
                event.position.x,
                event.position.y,
              ),
            }
          : {}),
        ...(event.endPosition
          ? {
              startPosition: new Cesium.Cartesian2(
                event.startPosition?.x ?? 0,
                event.startPosition?.y ?? 0,
              ),
              endPosition: new Cesium.Cartesian2(
                event.endPosition.x,
                event.endPosition.y,
              ),
            }
          : {}),
      }),
    /** The next picks return these targets: { line } | { set, index } | { native }. */
    scriptPicks(...targets) {
      const results = targets.map(native);
      viewer.scene.pick = () => results[0];
      viewer.scene.drillPick = () => results;
    },
    cameraInputs: () => inputs,
    lineState: (id) => {
      const drawn = primitive(id);
      return drawn && { drawn };
    },
    destroy: () => engine.destroy(),
  };
}

export const CCTV_HARNESSES = [fakeCctvHarness, cesiumCctvHarness];
