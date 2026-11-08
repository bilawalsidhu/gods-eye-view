// CCTV input tests use scripted picks and a canvas with style and window events.
import { createFakeEngine } from '../globe/testing/fakeEngine.js';

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

export const CCTV_HARNESSES = [fakeCctvHarness];
