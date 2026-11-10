import { engineContractMembers, isEngineEvent } from '../contract.js';

// Returned handles keep the names of their contract typedefs.
const HANDLE_TYPES = {
  MoverSet: {
    creators: ['movers.createSet'],
    members: [
      'set',
      'setCount',
      'count',
      'commit',
      'ready',
      'failed',
      'destroy',
    ],
  },
  Line: {
    creators: ['lines.createLine'],
    members: ['setPositions', 'setColor', 'setModelMatrix', 'show', 'destroy'],
  },
  LineSegments: {
    creators: ['lines.createSegments'],
    members: ['replace', 'commit', 'show', 'destroy'],
  },
  GroundSet: {
    creators: ['ground.createSet'],
    members: [
      'id',
      'setReveal',
      'replace',
      'commit',
      'show',
      'shown',
      'count',
      'ready',
      'destroy',
    ],
  },
  GroundPulseField: {
    creators: ['ground.createPulseField'],
    members: ['id', 'draw', 'move', 'destroy', 'isDestroyed'],
  },
  ImageryLayer: {
    creators: ['imagery.createLayer'],
    members: [
      'id',
      'setSource',
      'source',
      'staging',
      'setDetail',
      'detail',
      'raise',
      'setAlpha',
      'alpha',
      'show',
      'shown',
      'setSplit',
      'split',
      'ready',
      'destroy',
    ],
  },
  GlobeMesh: {
    creators: ['meshes.createMesh'],
    members: ['id', 'update', 'show', 'destroy'],
  },
  FollowHandle: {
    creators: ['camera.follow', 'camera.following'],
    members: ['stop', 'retarget', 'target', 'native', 'label', 'name'],
  },
  PointerClaim: {
    creators: ['input.acquirePointer'],
    members: ['release'],
  },
  EngineEvent: {
    creators: [],
    members: ['addEventListener', 'removeEventListener'],
  },
};

/** Members tracked by the suite, including handles returned by the engine. */
export function contractCallMembers() {
  return [
    ...engineContractMembers(),
    ...Object.entries(HANDLE_TYPES).flatMap(([type, { members }]) =>
      members.map((member) => `${type}.${member}`),
    ),
  ].sort();
}

/** Log contract calls and value reads without changing the engine's receiver. */
export function withCallLog(engine) {
  const called = new Set();
  const members = new Set(contractCallMembers());
  const namespaces = new Set(
    engineContractMembers().map((name) => name.split('.')[0]),
  );
  const returnedTypes = new Map(
    Object.entries(HANDLE_TYPES).flatMap(([type, { creators }]) =>
      creators.map((name) => [name, type]),
    ),
  );
  const proxies = new WeakMap();
  const originals = new WeakMap();
  const unwrap = (value) => originals.get(value) ?? value;
  const unwrapExclusions = (exclude) =>
    Array.isArray(exclude) && exclude.some((value) => originals.has(value))
      ? exclude.map(unwrap)
      : exclude;

  const wrap = (target, prefix, followEvent = false) => {
    if (target == null || typeof target !== 'object') return target;
    let cached = proxies.get(target);
    if (!cached) proxies.set(target, (cached = new Map()));
    const key = followEvent ? 'camera.followChanged' : prefix;
    if (cached.has(key)) return cached.get(key);
    const methods = new Map();
    const listeners = new WeakMap();
    const proxy = new Proxy(target, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof property !== 'string') return value;
        if (!prefix && namespaces.has(property)) return wrap(value, property);
        const name = `${prefix}.${property}`;
        if (typeof value !== 'function') {
          if (members.has(name)) called.add(name);
          return isEngineEvent(value)
            ? wrap(value, 'EngineEvent', name === 'camera.followChanged')
            : value;
        }
        if (methods.get(property)?.original === value)
          return methods.get(property).wrapped;
        const wrapped = function (...args) {
          if (members.has(name)) called.add(name);
          if (
            followEvent &&
            (property === 'addEventListener' ||
              property === 'removeEventListener') &&
            typeof args[0] === 'function'
          ) {
            const listener = args[0];
            if (!listeners.has(listener))
              listeners.set(listener, (handle) =>
                listener(wrap(handle, 'FollowHandle')),
              );
            args[0] = listeners.get(listener);
          }
          if (name === 'input.on' && args[2]?.pointer) {
            args[2] = { ...args[2], pointer: unwrap(args[2].pointer) };
          }
          // Surface adapters identify excluded resources by their native handles.
          if (
            name === 'surface.sampleHeight' ||
            name === 'surface.clampToHeight'
          ) {
            if (args.length > 1) args[1] = unwrapExclusions(args[1]);
          } else if (
            name === 'surface.sampleHeightDetailed' ||
            name === 'surface.raycast'
          ) {
            const index = name === 'surface.raycast' ? 0 : 1;
            const options = args[index];
            const exclude = unwrapExclusions(options?.exclude);
            if (exclude !== options?.exclude)
              args[index] = { ...options, exclude };
          }
          const result = Reflect.apply(value, target, args);
          const type = returnedTypes.get(name);
          return type ? wrap(result, type) : result;
        };
        methods.set(property, { original: value, wrapped });
        return wrapped;
      },
      set(target, property, value) {
        return Reflect.set(target, property, unwrap(value), target);
      },
    });
    cached.set(key, proxy);
    originals.set(proxy, target);
    return proxy;
  };

  return { engine: wrap(engine, ''), called: () => [...called].sort() };
}
