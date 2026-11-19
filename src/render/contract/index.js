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
  'weather',
  'imageryOnTiles',
  'splitSwipe',
  'imageryFrames',
  'imageryDecoded',
  'surfaceShading',
  'surfaceIdentity',
  'imageHooks',
  'screenModulation',
  'gpuTiming',
  'pickPosition',
  'sampleHeight',
  'rayCast',
  'columns',
  'motionSegments',
  'models',
  'modelParts',
  'quads',
  'meshes',
  'fields',
  'courseGlide',
  'cluster',
  'styles',
  'bloom',
  'sharpen',
  'followAutodetect',
  'globeVisibility',
  'followFrame',
  'cameraChangeThreshold',
  'occlusionTest',
  'keepEarthFramed',
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
  'msaa',
  'tiles3dDetail',
  'terrainDetail',
  'imageryDetail',
  'tilesCacheBytes',
  'shadows',
  'atmosphere',
  'milkyWay',
  'particles',
  'models',
  'postFx',
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
      'onHeldChange',
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
      'sky',
      'sky.get',
      'sky.set',
      'isSettled',
      'on',
    ),
    ['isGlobeVisible', 'globeVisibility'],
    ['surfaceVersion', 'surfaceIdentity'],
    ['setSurfaceShading', 'surfaceShading'],
    ['imagery.getSplit', 'splitSwipe'],
    ['imagery.setSplit', 'splitSwipe'],
    ['weather', 'weather'],
    ['weather.get', 'weather'],
    ['weather.set', 'weather'],
  ]),
  draw: Object.fromEntries([
    ...required(
      'icons',
      'points',
      'lines',
      'shapes',
      'atlas',
      'clampState',
      'on',
    ),
    ['models', 'models'],
    ['quads', 'quads'],
    ['meshes', 'meshes'],
    ['field', 'fields'],
  ]),
  camera: Object.fromEntries([
    ...required(
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
      'controls.coast',
      'controls.coast.drag',
      'controls.coast.zoom',
      'controls.collision',
      'controls.zoomFactor',
      'controls.pitchRange',
      'controls.zoomInputs',
      'on',
      'onCommand',
      'matrices',
    ),
    ['followFrame', 'followFrame'],
    ['controls.keepEarthFramed', 'keepEarthFramed'],
  ]),
  query: Object.fromEntries([
    ...required(
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
      'sampleHeight',
      'clampToSurface',
      'rayCast',
    ),
    ['occlusionTest', 'occlusionTest'],
  ]),
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
    ),
  ),
  effects: Object.fromEntries([
    ...required(
      'styles',
      'defineStyle',
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
  quality: Object.fromEntries(
    required(
      'knobs',
      'get',
      'set',
      'device',
      'probe',
      'signals',
      'signals.gpuTiming',
      'signals.on',
    ),
  ),
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
      'lit',
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

/**
 * What a renderer does, by role rather than by port. A renderer is more than
 * a drawing surface: it streams and builds the Earth from map sources, draws
 * the application's data as keyed sets, moves the camera, answers questions
 * about the world, applies the look, and runs the frame. The application owns the data
 * (providers, records, layers); the renderer owns everything from a source
 * spec or a draw set down to the pixels.
 *
 * Each role lists the members it covers as `port` (all of a port) or
 * `port.member` (that member and the members under it); the most specific
 * entry wins, so every member of {@link PORTS} has exactly one role
 * ({@link roleOf}). The roles describe the contract; they change no member.
 * @type {readonly import('./index').ContractRole[]}
 */
export const ROLES = deepFreeze([
  {
    id: 'surface',
    // i18n-ignore: developer documentation of the contract, never shown in the app
    title: 'The Earth',
    summary:
      'Streams, decodes and builds the globe from map sources: base imagery, terrain, photoreal 3D tiles and draped imagery layers (frames, split), with their credits and loading state.',
    members: ['globe', 'imageryLayer', 'credits'],
  },
  {
    id: 'scene',
    // i18n-ignore: developer documentation of the contract, never shown in the app
    title: 'Scene contents',
    summary:
      "Draws the application's data as keyed, retained sets: icons, points, lines, shapes, models, quads, meshes and fields, clamped to the surface where asked.",
    members: ['draw', 'drawSet'],
  },
  {
    id: 'view',
    // i18n-ignore: developer documentation of the contract, never shown in the app
    title: 'Camera and input',
    summary:
      'Places and moves the camera (views, flights, follow, user controls) and hands pointer input to the application.',
    members: ['camera', 'flight', 'input', 'lease'],
  },
  {
    id: 'queries',
    // i18n-ignore: developer documentation of the contract, never shown in the app
    title: 'World queries',
    summary:
      'Answers questions about what is drawn: picks, surface positions and heights, rays, projection and occlusion.',
    members: ['query'],
  },
  {
    id: 'look',
    // i18n-ignore: developer documentation of the contract, never shown in the app
    title: 'Look',
    summary:
      'How the world is lit and finished: sky and atmosphere, surface shading, styles and screen effects.',
    members: [
      'effects',
      'globe.sky',
      'globe.weather',
      'globe.setSurfaceShading',
      'imageryLayer.lit',
    ],
  },
  {
    id: 'host',
    // i18n-ignore: developer documentation of the contract, never shown in the app
    title: 'Host and frame',
    summary:
      'The renderer itself: its canvas and life cycle, the frame loop and scene time, quality, capture and settling.',
    members: ['renderer', 'frame', 'quality'],
  },
]);

/**
 * The role a member belongs to: the most specific {@link ROLES} entry naming
 * its port or one of its dotted prefixes.
 * @param {string} port
 * @param {string} [member] dotted, as in {@link PORTS}; empty for the port's own role
 * @returns {string|undefined} the role's id; undefined for a member the port does not have
 */
export function roleOf(port, member = '') {
  if (member && !(PORTS[port] && member in PORTS[port])) return undefined;
  const parts = member ? member.split('.') : [];
  for (let n = parts.length; n >= 0; n--) {
    const key = [port, ...parts.slice(0, n)].join('.');
    const role = ROLES.find((r) => r.members.includes(key));
    if (role) return role.id;
  }
  return undefined;
}

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
