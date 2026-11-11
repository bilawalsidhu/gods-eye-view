// Behavioural checks every GlobeEngine must pass. The suite is engine-agnostic
// and imports nothing from Node, so it runs in Node against the fake engine and
// in a headless browser against the Cesium and Navara engines:
//
//   const checks = createContractSuite(engine, { waitFrames });
//   for (const { name, run } of checks) await run();
//
// `waitFrames(count)` resolves after the engine has rendered `count` frames.
// Checks request renders themselves, so engines in request-render mode work.
// Each check sets the view it needs; checks may leave the camera anywhere.

import { engineCapabilities } from '../../contract.js';
import {
  mapErrorChecks,
  terrainRevisionChecks,
  photorealChecks,
  terrainChecks,
  mapChecks,
} from './maps.mjs';
import {
  moverListChecks,
  failedModelChecks,
  spriteChecks,
  moverChecks,
} from './movers.mjs';
import { groundBehaviourChecks, groundChecks } from './ground.mjs';
import { imageryBehaviourChecks, imageryChecks } from './imagery.mjs';
import { clockLatchChecks, clockChecks } from './clock.mjs';
import {
  terrainSampleChecks,
  surfaceChecks,
  globePickChecks,
} from './surface.mjs';
import {
  renderBehaviourChecks,
  renderChecks,
  contactSonarChecks,
  cloudCoverChecks,
  bloomChecks,
  styleChecks,
} from './render.mjs';
import {
  cameraBehaviourChecks,
  poseChecks,
  flightChecks,
  swingChecks,
  cameraChecks,
  aspectChecks,
  followChecks,
} from './camera.mjs';
import { cartesian2, cartesian3, math, ensure } from './helpers.mjs';
import {
  shapeChecks,
  eventChecks,
  creditChecks,
  listenerChecks,
  lifetimeChecks,
} from './events.mjs';
import { lineChecks, dashChecks } from './lines.mjs';
import { pickInputChecks, pointerChecks, inputChecks } from './input.mjs';
import { meshChecks } from './meshes.mjs';

/**
 * @param {import('../../contract.js').GlobeEngine} engine
 * @param {{ waitFrames: (count: number) => Promise<void>, maxWaitFrames?: number,
 *   mapSources?: { imagery: object[], photoreal: object },
 *   readRegion?: (x: number, y: number, width: number, height: number) => Uint8ClampedArray,
 *   makeCanvas?: (width: number, height: number) => object,
 *   resize?: (width: number, height: number) => Promise<void>,
 *   fixtures?: object,
 *   pointer?: { click: (x: number, y: number) => Promise<void>, move: (x: number, y: number) => Promise<void>,
 *     drag?: (x: number, y: number, endX: number, endY: number) => Promise<void> } }} options
 *   `mapSources` (two imagery sources and a photoreal one the engine can
 *   show) adds the maps checks; they leave photoreal tiles hidden.
 *   `readRegion` (RGBA bytes of the last drawn frame in a CSS-pixel box) and
 *   `makeCanvas` (a 2D canvas) add the pixel checks of drawn objects.
 *   `pointer` (a real left click and pointer move at a canvas position)
 *   adds the pick checks; `drag` adds the flight gesture check.
 *   `fixtures` supplies deterministic provider inputs; `resize` exercises
 *   imagery replanning. waitFrames must observe frames without requesting
 *   them, and reject if no requested frame arrives.
 * @returns {{ name: string, run: () => Promise<void> }[]}
 */
export function createContractSuite(
  engine,
  {
    waitFrames,
    maxWaitFrames = 240,
    mapSources = null,
    readRegion = null,
    makeCanvas = null,
    pointer = null,
    fixtures = null,
    resize = null,
  },
) {
  if (typeof waitFrames !== 'function')
    throw new TypeError('createContractSuite needs a waitFrames(count) helper');
  const { camera } = engine;

  const settle = async (count = 2) => {
    for (let index = 0; index < count; index++) {
      engine.render.request();
      await waitFrames(1);
    }
  };
  const until = async (predicate, label) => {
    for (let frame = 0; frame < maxWaitFrames; frame++) {
      if (predicate()) return;
      await settle(1);
    }
    ensure(
      predicate(),
      `${label} did not happen within ${maxWaitFrames} frames`,
    );
  };

  // A view 1000 km above (20°E, 10°N) looking straight down, heading north.
  const nadirView = async (height = 1e6) => {
    camera.setView({
      destination: cartesian3.fromDegrees(20, 10, height),
      orientation: { heading: 0, pitch: -math.PI_OVER_TWO, roll: 0 },
    });
    await settle();
  };
  const centre = () => {
    const { width, height } = engine.host.size();
    return cartesian2.create(width / 2, height / 2);
  };

  const capabilities = engineCapabilities(engine);
  const context = {
    settle,
    until,
    nadirView,
    centre,
    readRegion,
    makeCanvas,
    pointer,
    waitFrames,
    fixtures,
    resize,
    mapSources,
  };
  const checks = [
    ...shapeChecks(engine, context),
    ...poseChecks(engine, context),
    ...eventChecks(engine, context),
    ...clockChecks(engine, context),
    ...spriteChecks(engine, context),
    ...lineChecks(engine, context),
    ...pickInputChecks(engine, context),
    ...dashChecks(engine, context),
    ...moverChecks(engine, context),
    ...renderChecks(engine, context),
    ...flightChecks(engine, context),
    ...surfaceChecks(engine, context),
    ...pointerChecks(engine, context),
    ...swingChecks(engine, context),
    ...inputChecks(engine, context),
    ...creditChecks(engine, context),
    ...photorealChecks(engine, context),
    ...listenerChecks(engine, context),
    ...cameraChecks(engine, context),
    ...lifetimeChecks(engine, context),
    ...aspectChecks(engine, context),
    ...globePickChecks(engine, context),
    ...terrainChecks(engine, context),
    ...followChecks(engine, context),
  ];
  checks.push(
    ...meshChecks(engine, { settle, until, nadirView, readRegion, makeCanvas }),
    ...groundChecks(engine, { settle, until, nadirView, readRegion, pointer }),
    ...imageryChecks(engine, { settle, until, nadirView, readRegion }),
  );
  if (mapSources?.photoreal && mapSources.imagery?.length >= 2)
    checks.push(...mapChecks(engine.maps, mapSources));
  if (capabilities.visualStyles)
    checks.push(...styleChecks(engine.render, settle));
  if (capabilities.bloom) checks.push(...bloomChecks(engine.render, settle));
  if (capabilities.cloudCover)
    checks.push(...cloudCoverChecks(engine.render, settle));
  if (capabilities.contactSonar)
    checks.push(...contactSonarChecks(engine.render, settle));
  checks.push(
    ...cameraBehaviourChecks(engine, context),
    ...renderBehaviourChecks(engine, context),
    ...terrainSampleChecks(engine, context),
    ...terrainRevisionChecks(engine, context),
    ...clockLatchChecks(engine, context),
    ...groundBehaviourChecks(engine, context),
    ...imageryBehaviourChecks(engine, context),
    ...mapErrorChecks(engine, context),
    ...moverListChecks(engine),
  );
  if (fixtures?.failModel || makeCanvas)
    checks.push(...failedModelChecks(engine, context));
  return checks.map(([name, run]) => ({ name, run }));
}

/** Runs every check in order; never throws for a failing check. */
export async function runContractSuite(engine, options) {
  const results = [];
  for (const { name, run } of createContractSuite(engine, options)) {
    try {
      await run();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({
        name,
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return results;
}
