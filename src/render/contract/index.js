/**
 * @module render/contract
 * @description The renderer contract at run time: the capability flags, every
 * port's members, and a shape check. The types live beside this file
 * (`index.d.ts` and one `.d.ts` per port); `contract.test.mjs` keeps
 * {@link PORTS} and those types in step, member for member.
 *
 * A member is required (`null`) or added by a capability: a renderer without
 * that capability leaves the member out.
 */

/** @type {import('./index').ContractVersion} */
export const CONTRACT_VERSION = '0';

/** @type {readonly import('./common').Capability[]} */
export const CAPABILITIES = Object.freeze([
  'photoreal',
  'vectorBase',
  'finestHeights',
  'terrain',
  'modelAtmosphere',
  'imageryOnTiles',
  'splitSwipe',
  'imageryFrames',
  'surfaceShading',
  'screenModulation',
  'gpuTiming',
  'pickPosition',
  'sampleHeight',
  'rayCast',
  'columns',
  'motionSegments',
  'models',
  'quads',
  'meshes',
  'fields',
  'celestial',
  'agents',
  'cluster',
  'styles',
  'bloom',
  'sharpen',
  'followAutodetect',
  'benchmark',
]);

/** @type {readonly import('./frame').FrameStep[]} */
export const FRAME_STEPS = Object.freeze([
  'flight',
  'input',
  'changed',
  'follow',
  'preUpdate',
  'moveDetection',
  'preRender',
  'render',
  'postRender',
]);

/** Every quality setting a renderer may support. */
export const QUALITY_KEYS = Object.freeze([
  'pixelRatio',
  'overlayPixelRatio',
  'msaa',
  'tiles3dDetail',
  'terrainDetail',
  'imageryDetail',
  'tilesCacheBytes',
  'clouds',
  'shadows',
  'water',
  'atmosphere',
  'milkyWay',
  'particles',
  'models',
  'postFx',
  'animatedStyleFps',
  'sonarCadenceHz',
  'targetFps',
]);

const required = (...names) => names.map((name) => [name, null]);

/**
 * Every port's members. Nested members are dotted (`imagery.add`); the
 * instance shapes a port hands out (`drawSet`, `imageryLayer`, `flight`,
 * `lease`) are listed as their own entries.
 * @type {Readonly<Record<string, Readonly<Record<string, import('./common').Capability|null>>>>}
 */
export const PORTS = deepFreeze({
  renderer: Object.fromEntries(
    required(
      'id',
      'contractVersion',
      'capabilities',
      'canvas',
      'frame',
      'globe',
      'draw',
      'camera',
      'query',
      'input',
      'effects',
      'credits',
      'quality',
      'capture',
      'readPixels',
      'whenSettled',
      'resize',
      'releaseUnused',
      'on',
      'destroy',
    ),
  ),
  frame: Object.fromEntries(
    required(
      'on',
      'requestRender',
      'holdContinuous',
      'mode',
      'diagnostics',
      'suspend',
      'renderNow',
      'renderOnce',
      'setTargetFps',
      'setTime',
      'time',
    ),
  ),
  globe: Object.fromEntries([
    ...required(
      'setBase',
      'setPhotoreal',
      'setTerrain',
      'setGlobeVisible',
      'imagery',
      'imagery.add',
      'imagery.list',
      'imagery.host',
      'imagery.onHostChange',
      'sky',
      'sky.get',
      'sky.set',
      'isSettled',
      'on',
    ),
    ['setSurfaceShading', 'surfaceShading'],
    ['imagery.getSplit', 'splitSwipe'],
    ['imagery.setSplit', 'splitSwipe'],
  ]),
  draw: Object.fromEntries([
    ...required('icons', 'points', 'lines', 'shapes', 'atlas'),
    ['models', 'models'],
    ['quads', 'quads'],
    ['meshes', 'meshes'],
    ['field', 'fields'],
    ['celestial', 'celestial'],
    ['agents', 'agents'],
  ]),
  camera: Object.fromEntries(
    required(
      'pose',
      'setView',
      'setFov',
      'viewRectangle',
      'flyTo',
      'flyToBounds',
      'cancelFlight',
      'flying',
      'lookAt',
      'release',
      'move',
      'look',
      'rotateAround',
      'zoom',
      'follow',
      'followed',
      'followFramed',
      'followOffset',
      'followOffset.get',
      'followOffset.set',
      'controls',
      'controls.enabled',
      'controls.suspend',
      'controls.enableTilt',
      'controls.enableRotate',
      'controls.enableZoom',
      'controls.minDistance',
      'controls.maxDistance',
      'controls.inertiaSpin',
      'controls.inertiaTranslate',
      'controls.inertiaZoom',
      'controls.collision',
      'controls.zoomFactor',
      'controls.pitchRange',
      'controls.zoomInputs',
      'on',
      'onCommand',
      'matrices',
    ),
  ),
  query: Object.fromEntries(
    required(
      'pick',
      'drillPick',
      'pickPosition',
      'pickEllipsoid',
      'pickGlobe',
      'pickRay',
      'project',
      'projectMany',
      'isOccluded',
      'sampleHeightNow',
      'sampleHeightNowMany',
      'sampleHeight',
      'clampToSurface',
      'rayCast',
    ),
  ),
  input: Object.fromEntries(
    required(
      'on',
      'claimPointer',
      'isPointerFree',
      'suspendCameraControls',
      'behaviours',
      'behaviours.select',
      'behaviours.select.enabled',
      'behaviours.select.suppress',
      'behaviours.dblclickFollow',
      'behaviours.dblclickFollow.enabled',
      'behaviours.dblclickFollow.suppress',
      'ctrlWheelZoom',
    ),
  ),
  effects: Object.fromEntries([
    ...required(
      'styles',
      'setStyle',
      'setStyleIntensity',
      'setStyleParams',
      'bloom',
      'sharpen',
      'diagnostics',
      'on',
    ),
    ['screenModulation', 'screenModulation'],
  ]),
  credits: Object.fromEntries(required('addStatic', 'list', 'on')),
  quality: Object.fromEntries([
    ...required(
      'knobs',
      'get',
      'set',
      'device',
      'probe',
      'signals',
      'signals.gpuTiming',
      'signals.on',
    ),
    ['benchmark', 'benchmark'],
  ]),
  drawSet: Object.fromEntries([
    ...required(
      'id',
      'set',
      'upsert',
      'remove',
      'clear',
      'setOptions',
      'size',
      'show',
      'on',
      'dispose',
    ),
    ['setColumns', 'columns'],
  ]),
  imageryLayer: Object.fromEntries([
    ...required(
      'alpha',
      'show',
      'split',
      'drapeOn',
      'on',
      'raise',
      'lower',
      'remove',
    ),
    ['setFrames', 'imageryFrames'],
    ['setFrameTime', 'imageryFrames'],
  ]),
  flight: Object.fromEntries(required('done', 'cancel')),
  lease: Object.fromEntries(required('owner', 'current', 'release')),
});

/** The ports a renderer object holds, by the key it holds them under. */
const RENDERER_PORTS = [
  'frame',
  'globe',
  'draw',
  'camera',
  'query',
  'input',
  'effects',
  'credits',
  'quality',
];

function deepFreeze(value) {
  for (const inner of Object.values(value))
    if (inner && typeof inner === 'object') deepFreeze(inner);
  return Object.freeze(value);
}

function has(target, dotted) {
  let at = target;
  for (const key of dotted.split('.')) {
    if (at == null || (typeof at !== 'object' && typeof at !== 'function'))
      return false;
    if (!(key in at)) return false;
    at = at[key];
  }
  return true;
}

/**
 * What `target` is missing against one descriptor, and what it has that its
 * capabilities do not allow.
 * @param {object} target
 * @param {string} port
 * @param {ReadonlySet<string>} capabilities
 * @returns {string[]}
 */
export function checkPortShape(target, port, capabilities) {
  const problems = [];
  for (const [member, capability] of Object.entries(PORTS[port])) {
    const present = has(target, member);
    if (capability === null) {
      if (!present) problems.push(`${port}.${member} is missing`);
    } else if (capabilities.has(capability) && !present) {
      problems.push(`${port}.${member} is missing with ${capability}`);
    } else if (!capabilities.has(capability) && present) {
      problems.push(`${port}.${member} is present without ${capability}`);
    }
  }
  return problems;
}

/**
 * What a renderer is missing against the contract.
 * @param {unknown} renderer
 * @returns {string[]}
 */
export function checkRendererShape(renderer) {
  if (!renderer || typeof renderer !== 'object')
    return ['renderer is not an object'];
  const r = /** @type {any} */ (renderer);
  const capabilities = r.capabilities instanceof Set ? r.capabilities : null;
  if (!capabilities) return ['renderer.capabilities is not a Set'];
  const problems = [];
  for (const capability of capabilities)
    if (!CAPABILITIES.includes(capability))
      problems.push(`unknown capability ${capability}`);
  if (r.contractVersion !== CONTRACT_VERSION)
    problems.push(`contractVersion is ${r.contractVersion}`);
  problems.push(...checkPortShape(r, 'renderer', capabilities));
  for (const port of RENDERER_PORTS)
    if (r[port]) problems.push(...checkPortShape(r[port], port, capabilities));
  return problems;
}
