/**
 * Checks for every port but the camera: shape, the frame loop, draw sets,
 * queries, input, the globe, effects, credits, quality and the renderer.
 * Each check reads and drives the renderer through the contract alone.
 */
import {
  CAPABILITIES,
  CONTRACT_VERSION,
  QUALITY_KEYS,
  checkPortShape,
  checkRendererShape,
} from '../../contract/index.js';
import { AUSTIN, SCRIPT_VIEWPORT } from '../cameraScripts.js';
import {
  eciToEcf,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
} from 'satellite.js';
import { deepEqual, equal, near, nearVec, ok, throws } from '../expect.js';

/** 1 × 1 PNGs (red, green, blue), so imagery checks load nothing from the network. */
const PIXEL_PNGS = [
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==',
];
const PIXEL_PNG = PIXEL_PNGS[0];

/** Elements for the orbit check: a station-like orbit, epoch 2026-01-04. */
const ISS_TLE = Object.freeze([
  '1 25544U 98067A   26004.50000000  .00016717  00000-0  10270-3 0  9992',
  '2 25544  51.6400 208.9163 0006317  69.9862  25.2906 15.49560532 10009',
]);

const DOT = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="#fff"/></svg>',
};

async function fresh(h) {
  return h.create({ viewport: SCRIPT_VIEWPORT });
}

/** Looks straight down on Austin from `height` metres. */
async function overAustin(h, r, height = 2000) {
  r.camera.setView({
    destination: { ...AUSTIN, height },
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
  await h.frame(r);
}

/**
 * Waits until what is drawn has loaded (icon images, tiles, models), as a
 * query answers from what is loaded. A renderer that draws synchronously is
 * settled at once.
 */
async function settled(r) {
  const result = await r.whenSettled({ timeoutMs: 20000 });
  equal(result.state, 'settled', `settled (${result.blockers.join(', ')})`);
}

/**
 * Settles, then watches `ticks` ticks and returns what they did: preUpdate's
 * `['u', rendering]` and a draw's `['r']`. An engine may still draw on its
 * own once in a while after settling (roundoff in its camera bookkeeping,
 * say), so a watch that saw a draw is tried again, up to `tries` times; one
 * that always draws fails every try.
 */
async function idleWatch(h, r, ticks, tries = 3) {
  let seen = [];
  const off = [
    r.frame.on('preUpdate', (t) => seen.push(['u', t.rendering])),
    r.frame.on('postRender', () => seen.push(['r'])),
  ];
  try {
    for (let i = 0; i < tries; i++) {
      await settled(r);
      seen = [];
      for (let k = 0; k < ticks; k++) await h.frame(r);
      if (!seen.some(([kind]) => kind === 'r')) break;
    }
    return seen;
  } finally {
    for (const f of off) f();
  }
}

async function drawn(h, r, frames = 2) {
  for (let i = 0; i < frames; i++) {
    r.frame.requestRender('conformance');
    await h.frame(r);
  }
}

/**
 * The listener rules on one subscription list: subscription order, one
 * removed during delivery does not run, one added during delivery waits for
 * the next event, and a throw goes to `error` while the rest still run.
 * `subscribe(cb)` returns its Off; `fire()` raises one event.
 */
async function listenerRules(r, where, subscribe, fire) {
  const errors = [];
  const offError = r.on('error', (e) => errors.push(e));
  const seen = [];
  const offs = [];
  let offRemoved = () => {};
  let added = false;
  offs.push(
    subscribe(() => {
      seen.push('first');
      offRemoved();
      if (!added) {
        added = true;
        offs.push(subscribe(() => seen.push('added')));
      }
    }),
  );
  offs.push(
    subscribe(() => {
      throw new Error('listener failure');
    }),
  );
  offRemoved = subscribe(() => seen.push('removed'));
  offs.push(offRemoved);
  offs.push(subscribe(() => seen.push('last')));
  await fire();
  deepEqual(
    seen,
    ['first', 'last'],
    `${where}: in order; removed during delivery does not run; added waits`,
  );
  ok(errors.length >= 1, `${where}: the throw went to error`);
  seen.length = 0;
  await fire();
  deepEqual(
    seen,
    ['first', 'last', 'added'],
    `${where}: one added during delivery runs from the next event`,
  );
  for (const off of offs) off();
  offError();
}

/** A check over a fresh renderer, destroyed afterwards. */
function check(id, title, run, extra = {}) {
  return {
    id,
    port: id.split('.')[0],
    title,
    ...extra,
    async run(h) {
      const r = await fresh(h);
      try {
        if (extra.capability && !r.capabilities.has(extra.capability))
          return { skip: `no ${extra.capability}` };
        return await run(h, r);
      } finally {
        r.destroy();
      }
    },
  };
}

const POINTER_TYPES = [
  'down',
  'move',
  'up',
  'click',
  'dblclick',
  'wheel',
  'pinch',
];

const SET_KINDS = [
  ['icons', null],
  ['points', null],
  ['lines', null],
  ['shapes', null],
  ['models', 'models'],
  ['quads', 'quads'],
  ['meshes', 'meshes'],
  ['agents', 'agents'],
  ['orbits', 'orbits'],
];

/** A plain style that swaps colour channels by its intensity. */
const swapStyle = (id) => ({
  id,
  params: [],
  animated: false,
  shader: {
    glsl: `uniform sampler2D colorTexture;
uniform float intensity;
in vec2 v_textureCoordinates;
void main() {
  vec4 c = texture(colorTexture, v_textureCoordinates);
  out_FragColor = vec4(mix(c.rgb, c.gbr, intensity), 1.0);
}`,
    wgsl: `@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureSample(colorTexture, colorSampler, uv);
  return vec4f(mix(c.rgb, c.gbr, params.intensity), 1.0);
}`,
  },
});

export function portChecks() {
  return [
    // --- Shape -------------------------------------------------------------
    check(
      'renderer.shape',
      'every port has exactly the members its capabilities allow',
      (h, r) => {
        deepEqual(checkRendererShape(r), [], 'renderer shape');
        equal(r.contractVersion, CONTRACT_VERSION, 'contract version');
        for (const c of r.capabilities)
          ok(CAPABILITIES.includes(c), `known capability ${c}`);
        for (const [kind, capability] of SET_KINDS) {
          if (capability && !r.capabilities.has(capability)) continue;
          const set = r.draw[kind]({ id: `shape:${kind}` });
          deepEqual(
            checkPortShape(set, 'drawSet', r.capabilities),
            [],
            `${kind} set shape`,
          );
          set.dispose();
        }
        const layer = r.globe.imagery.add({
          kind: 'xyz',
          url: 'https://example.invalid/{z}/{x}/{y}.png',
        });
        deepEqual(
          checkPortShape(layer, 'imageryLayer', r.capabilities),
          [],
          'imagery layer shape',
        );
        layer.remove();
        const flight = r.camera.flyTo(
          { ...AUSTIN, height: 1e6 },
          { durationS: 1 },
        );
        deepEqual(
          checkPortShape(flight, 'flight', r.capabilities),
          [],
          'flight shape',
        );
        r.camera.cancelFlight();
        const lease = r.input.claimPointer('conformance');
        deepEqual(
          checkPortShape(lease, 'lease', r.capabilities),
          [],
          'lease shape',
        );
        lease.release();
      },
    ),
    check(
      'renderer.listeners',
      'listener order, removal during delivery and a throwing listener',
      async (h, r) => {
        const errors = [];
        r.on('error', (e) => errors.push(e));
        const seen = [];
        let offB = () => {};
        r.frame.on('preUpdate', () => {
          seen.push('a');
          offB();
          r.frame.on('preUpdate', () => seen.push('late'));
        });
        offB = r.frame.on('preUpdate', () => seen.push('b'));
        r.frame.on('preUpdate', () => {
          throw new Error('listener failure');
        });
        r.frame.on('preUpdate', () => seen.push('c'));
        await h.frame(r);
        deepEqual(
          seen,
          ['a', 'c'],
          'removed during delivery does not run; added during delivery waits',
        );
        equal(errors.length, 1, 'the throw went to error');
        // The error list keeps the rules too. While an error is delivered,
        // A removes B and subscribes the same callback again: B does not run
        // for that error, and runs from the next one.
        const errorSeen = [];
        const b = () => errorSeen.push('b');
        let offErrorB = () => {};
        let resubscribed = false;
        r.on('error', () => {
          errorSeen.push('a');
          if (resubscribed) return;
          resubscribed = true;
          offErrorB();
          offErrorB = r.on('error', b);
        });
        offErrorB = r.on('error', b);
        r.frame.on('preUpdate', () => {
          throw new Error('another failure');
        });
        seen.length = 0;
        await h.frame(r);
        ok(
          seen.includes('late'),
          'a listener added during delivery runs from the next frame',
        );
        deepEqual(
          errorSeen,
          ['a', 'a', 'b'],
          'an error listener removed during delivery does not run; subscribed again, it waits',
        );
      },
    ),

    check(
      'renderer.listenerRules',
      'every subscription list follows the listener rules',
      async (h, r) => {
        await overAustin(h, r);
        const lists = [
          [
            'frame.on(postRender)',
            (cb) => r.frame.on('postRender', cb),
            () => drawn(h, r, 1),
          ],
          [
            'camera.on(flightEnd)',
            (cb) => r.camera.on('flightEnd', cb),
            () => r.camera.flyTo({ ...AUSTIN, height: 2000 }, { durationS: 0 }),
          ],
          [
            'camera.onCommand',
            (cb) => r.camera.onCommand(cb),
            () =>
              r.camera.setView({ destination: { ...AUSTIN, height: 2000 } }),
          ],
          [
            'quality.signals.on(frame)',
            (cb) => r.quality.signals.on('frame', cb),
            () => drawn(h, r, 1),
          ],
        ];
        // A move between two far-apart views raises one of each camera event.
        let flip = false;
        const moveCamera = async () => {
          await h.frame(r);
          flip = !flip;
          r.camera.setView({
            destination: { ...AUSTIN, height: flip ? 400000 : 2000 },
          });
          for (let i = 0; i < 40; i++) await h.frame(r);
        };
        for (const event of ['changed', 'moveStart', 'moveEnd'])
          lists.push([
            `camera.on(${event})`,
            (cb) => r.camera.on(event, cb),
            moveCamera,
          ]);
        if (h.pointer)
          lists.push([
            'input.on(move)',
            (cb) => r.input.on('move', cb),
            () => h.pointer(r, 'move', 10, 10),
          ]);
        for (const [where, subscribe, fire] of lists)
          await listenerRules(r, where, subscribe, fire);
      },
    ),
    check(
      'credits.listenerRules',
      'credits.on(change) follows the listener rules',
      async (h, r) => {
        const credits = [];
        try {
          await listenerRules(
            r,
            'credits.on(change)',
            (cb) => r.credits.on('change', cb),
            () => {
              credits.push(r.credits.addStatic({ text: 'Conformance data' }));
            },
          );
        } finally {
          for (const off of credits) off();
        }
      },
    ),

    // --- Frame -------------------------------------------------------------
    check(
      'frame.order',
      'phases run preUpdate → preRender → postRender in a drawing frame',
      async (h, r) => {
        const seen = [];
        r.frame.on('postRender', () => seen.push('postRender'));
        r.frame.on('preRender', () => seen.push('preRender'));
        r.frame.on('preUpdate', () => seen.push('preUpdate'));
        r.frame.requestRender('order');
        await h.frame(r);
        deepEqual(
          seen,
          ['preUpdate', 'preRender', 'postRender'],
          'phase order',
        );
      },
    ),
    check(
      'frame.demand',
      'on demand: preUpdate every tick, drawing only when asked or held',
      async (h, r) => {
        if (r.frame.mode() === 'continuous')
          return { skip: 'continuous engine' };
        await drawn(h, r, 3);
        // A renderer still loading is not idle.
        deepEqual(
          await idleWatch(h, r, 1),
          [['u', false]],
          'an idle tick runs preUpdate and draws nothing',
        );
        const seen = [];
        r.frame.on('preUpdate', (t) => seen.push(['u', t.rendering]));
        r.frame.on('postRender', () => seen.push(['r']));
        r.frame.requestRender('one');
        ok(
          r.frame.diagnostics().pendingReasons.includes('one'),
          'the reason is pending',
        );
        await h.frame(r);
        deepEqual(seen, [['u', true], ['r']], 'a request draws one frame');
        deepEqual(
          r.frame.diagnostics().pendingReasons,
          [],
          'and that frame answers it',
        );
        // What that frame started loading (tiles it now needs) may draw on
        // its own; once that is done the loop is idle again.
        deepEqual(await idleWatch(h, r, 1), [['u', false]], 'and only one');
        const a = r.frame.holdContinuous('a');
        const b = r.frame.holdContinuous('b');
        deepEqual(
          [...r.frame.diagnostics().holds].sort(),
          ['a', 'b'],
          'holds listed',
        );
        seen.length = 0;
        await h.frame(r);
        await h.frame(r);
        equal(
          seen.filter(([k]) => k === 'r').length,
          2,
          'a hold draws every frame',
        );
        a();
        a();
        seen.length = 0;
        await h.frame(r);
        equal(seen.filter(([k]) => k === 'r').length, 1, 'one hold still out');
        b();
        equal(
          (await idleWatch(h, r, 2)).filter(([k]) => k === 'r').length,
          0,
          'no holds, no frames',
        );
      },
    ),
    check(
      'frame.prediction',
      'preUpdate rendering says whether the tick draws, whatever came before',
      async (h, r) => {
        if (r.frame.mode() === 'continuous')
          return { skip: 'continuous engine' };
        await settled(r);
        // An earlier listener asks for frames and takes and gives back
        // holds; the prediction, read after it, must match each tick.
        const script = ['idle', 'request', 'idle', 'hold', 'idle', 'release'];
        let step = 0;
        let release = null;
        r.frame.on('preUpdate', () => {
          const op = script[step++ % script.length];
          if (op === 'request') r.frame.requestRender('prediction');
          if (op === 'hold') release = r.frame.holdContinuous('prediction');
          if (op === 'release') release?.();
        });
        const predicted = new Map();
        const drew = new Set();
        r.frame.on('preUpdate', (t) => predicted.set(t.frame, t.rendering));
        r.frame.on('postRender', (t) => drew.add(t.frame));
        for (let i = 0; i < 4 * script.length; i++) await h.frame(r);
        release?.();
        const wrong = [...predicted]
          .filter(([frame, rendering]) => rendering !== drew.has(frame))
          .map(([frame, rendering]) => `${frame}:${rendering}`);
        deepEqual(wrong, [], 'ticks predicted wrongly (frame:prediction)');
        ok(
          [...predicted.values()].some((x) => x) &&
            [...predicted.values()].some((x) => !x),
          'both kinds of tick were seen',
        );
      },
    ),
    check(
      'frame.time',
      'scene time is set and reported in FrameTime',
      async (h, r) => {
        const t0 = Date.UTC(2026, 5, 21, 12);
        r.frame.setTime(t0);
        equal(r.frame.time(), t0, 'time()');
        let seen = null;
        r.frame.on('preUpdate', (t) => (seen = t));
        await h.frame(r);
        equal(seen.time, t0, 'FrameTime.time');
        ok(seen.dt > 0, 'dt is positive');
        ok(Number.isInteger(seen.frame), 'frame is a count');
      },
    ),
    check(
      'frame.renderOnce',
      'renderOnce resolves after a drawn frame; renderNow draws now',
      async (h, r) => {
        let drawnFrames = 0;
        r.frame.on('postRender', () => (drawnFrames += 1));
        const once = r.frame.renderOnce();
        await h.frame(r);
        await once;
        ok(drawnFrames >= 1, 'renderOnce drew a frame');
        const before = drawnFrames;
        r.frame.renderNow();
        equal(drawnFrames, before + 1, 'renderNow drew synchronously');
      },
    ),
    check('frame.suspend', 'a suspended loop does not tick', async (h, r) => {
      let ticks = 0;
      r.frame.on('preUpdate', () => (ticks += 1));
      r.frame.suspend(true);
      ok(r.frame.diagnostics().suspended, 'suspended');
      await h.frame(r);
      equal(ticks, 0, 'no ticks while hidden');
      r.frame.suspend(false);
      await h.frame(r);
      equal(ticks, 1, 'ticking again');
    }),

    // --- Draw --------------------------------------------------------------
    check('draw.sets', 'set, upsert, remove, clear and size', (h, r) => {
      const set = r.draw.points({ id: 'conf:points' });
      const p = (id, lon) => ({
        id,
        pos: { lon, lat: AUSTIN.lat, height: 0 },
        pixelSize: 8,
        color: '#ff0000',
      });
      set.set([p('a', -97.74), p('b', -97.73)]);
      equal(set.size(), 2, 'set');
      set.upsert([p('b', -97.72), p('c', -97.71)]);
      equal(set.size(), 3, 'upsert adds and replaces');
      set.remove(['a', 'missing']);
      equal(set.size(), 2, 'remove ignores unknown ids');
      set.set([p('d', -97.7)]);
      equal(set.size(), 1, 'set replaces every item');
      set.clear();
      equal(set.size(), 0, 'clear');
      set.dispose();
    }),
    check(
      'draw.ids',
      'set ids are unique among live sets and free again once disposed',
      (h, r) => {
        const a = r.draw.icons({ id: 'conf:dup' });
        throws(
          () => r.draw.lines({ id: 'conf:dup' }),
          'a second live set with the id',
        );
        a.dispose();
        const b = r.draw.lines({ id: 'conf:dup' });
        equal(b.id, 'conf:dup', 'the id is free after dispose');
        a.dispose();
        throws(
          () => r.draw.points({ id: 'conf:dup' }),
          'disposing the old handle again leaves the newer set live',
        );
        b.dispose();
      },
    ),
    check(
      'draw.pick',
      'a drawn icon is picked under its projection with its set, id and meta',
      async (h, r) => {
        await overAustin(h, r);
        const set = r.draw.icons({ id: 'conf:pick' });
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        set.set([
          { id: 'one', pos, image: DOT, size: [24, 24], meta: { n: 1 } },
        ]);
        await drawn(h, r);
        await settled(r);
        const s = r.query.project(pos);
        ok(s, 'the icon projects');
        const hit = r.query.pick(s.x, s.y);
        ok(hit, 'a hit');
        equal(hit.set, 'conf:pick', 'Hit.set');
        equal(hit.id, 'one', 'Hit.id');
        deepEqual(hit.meta, { n: 1 }, 'Hit.meta');
        equal(hit.surface, false, 'not the surface');
        for (const purpose of ['hover', 'select'])
          equal(
            r.query.pick(s.x, s.y, { purpose })?.id,
            'one',
            `a ${purpose} pick finds an icon too`,
          );
        set.setOptions({ pickable: false });
        await drawn(h, r);
        const after = r.query.pick(s.x, s.y);
        ok(
          !after || after.set !== 'conf:pick',
          'an unpickable set is not picked',
        );
        set.setOptions({ pickable: true });
        set.show = false;
        await drawn(h, r);
        const hidden = r.query.pick(s.x, s.y);
        ok(!hidden || hidden.set !== 'conf:pick', 'a hidden set is not picked');
        set.dispose();
      },
    ),
    check(
      'draw.drillPick',
      'drillPick returns every item under the pointer',
      async (h, r) => {
        await overAustin(h, r);
        const set = r.draw.points({ id: 'conf:drill' });
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        set.set([
          { id: 'a', pos, pixelSize: 20, color: '#f00' },
          { id: 'b', pos, pixelSize: 20, color: '#0f0' },
        ]);
        await drawn(h, r);
        const s = r.query.project(pos);
        const ids = r.query
          .drillPick(s.x, s.y)
          .filter((x) => x.set === 'conf:drill')
          .map((x) => x.id)
          .sort();
        deepEqual(ids, ['a', 'b'], 'both hits');
        equal(r.query.drillPick(s.x, s.y, { limit: 1 }).length, 1, 'limit');
        set.dispose();
      },
    ),
    check(
      'draw.motion',
      'icons move by their segments on the set\u2019s motion clock',
      async (h, r) => {
        await overAustin(h, r, 8000);
        const t0 = r.frame.time();
        const from = h.toEcef({
          lon: AUSTIN.lon - 0.02,
          lat: AUSTIN.lat,
          height: 0,
        });
        const to = h.toEcef({
          lon: AUSTIN.lon + 0.02,
          lat: AUSTIN.lat,
          height: 0,
        });
        const set = r.draw.icons({
          id: 'conf:motion',
          motionClock: { kind: 'scene' },
        });
        set.set([
          {
            id: 'mover',
            pos: from,
            image: DOT,
            size: [16, 16],
            motion: { kind: 'lerp', from, to, t0, t1: t0 + 10000 },
          },
        ]);
        const pickAt = (p) => {
          const s = r.query.project(p);
          return r.query
            .drillPick(s.x, s.y)
            .some((x) => x.set === 'conf:motion');
        };
        r.frame.setTime(t0 + 5000);
        await drawn(h, r);
        const mid = {
          x: (from.x + to.x) / 2,
          y: (from.y + to.y) / 2,
          z: (from.z + to.z) / 2,
        };
        ok(pickAt(mid), 'picked halfway at half time');
        ok(!pickAt(from), 'not still at the start');
        r.frame.setTime(t0 + 60000);
        await drawn(h, r);
        ok(pickAt(to), 'holds at the end');
        set.dispose();
      },
      { capability: 'motionSegments' },
    ),
    check(
      'draw.motion.arc',
      'an arc turns in the fix\u2019s tangent plane and coasts no longer than maxDtS',
      async (h, r) => {
        await overAustin(h, r, 8000);
        const t0 = r.frame.time();
        const fixAt = { ...AUSTIN, height: 0 };
        const fix = h.toEcef(fixAt);
        const segment = {
          kind: 'arc',
          fix,
          t0,
          speedMps: 50,
          trackDeg: 90,
          turnRateDps: 3,
          minDtS: 0,
          maxDtS: 20,
        };
        const set = r.draw.icons({
          id: 'conf:arc',
          motionClock: { kind: 'scene' },
        });
        set.set([
          {
            id: 'turner',
            pos: fix,
            image: DOT,
            size: [16, 16],
            motion: segment,
          },
        ]);
        // The contract's formula, on the fix's own east and north axes.
        const lon = (fixAt.lon * Math.PI) / 180;
        const lat = (fixAt.lat * Math.PI) / 180;
        const east = { x: -Math.sin(lon), y: Math.cos(lon), z: 0 };
        const north = {
          x: -Math.sin(lat) * Math.cos(lon),
          y: -Math.sin(lat) * Math.sin(lon),
          z: Math.cos(lat),
        };
        const at = (dtS) => {
          const track = (segment.trackDeg * Math.PI) / 180;
          const w = (segment.turnRateDps * Math.PI) / 180;
          const v = segment.speedMps;
          const e = (v / w) * (Math.cos(track) - Math.cos(track + w * dtS));
          const n = (v / w) * (Math.sin(track + w * dtS) - Math.sin(track));
          return {
            x: fix.x + east.x * e + north.x * n,
            y: fix.y + east.y * e + north.y * n,
            z: fix.z + east.z * e + north.z * n,
          };
        };
        const pickAt = (p) => {
          const s = r.query.project(p);
          return r.query.drillPick(s.x, s.y).some((x) => x.set === 'conf:arc');
        };
        r.frame.setTime(t0 + 20000);
        await drawn(h, r);
        ok(pickAt(at(20)), 'on the arc at 20 s');
        const straight = {
          x: fix.x + east.x * 1000,
          y: fix.y + east.y * 1000,
          z: fix.z + east.z * 1000,
        };
        ok(!pickAt(straight), 'not where a straight track would be');
        r.frame.setTime(t0 + 60000);
        await drawn(h, r);
        ok(pickAt(at(20)), 'coasts no further than maxDtS');
        set.dispose();
      },
      { capability: 'motionSegments' },
    ),
    check(
      'draw.motion.live',
      'a live motion clock runs delayMs behind wall time',
      async (h, r) => {
        if (!h.wallTime) return { skip: 'no wall time in this harness' };
        await overAustin(h, r, 8000);
        const w = h.wallTime(r);
        const from = h.toEcef({ ...AUSTIN, lon: AUSTIN.lon - 0.02, height: 0 });
        const to = h.toEcef({ ...AUSTIN, lon: AUSTIN.lon + 0.02, height: 0 });
        const along = (f) => ({
          x: from.x + (to.x - from.x) * f,
          y: from.y + (to.y - from.y) * f,
          z: from.z + (to.z - from.z) * f,
        });
        const set = r.draw.icons({
          id: 'conf:live',
          motionClock: { kind: 'live', delayMs: 2000 },
        });
        // Halfway at wall time minus the delay; 70% at wall time itself.
        set.set([
          {
            id: 'mover',
            pos: from,
            image: DOT,
            size: [16, 16],
            motion: { kind: 'lerp', from, to, t0: w - 7000, t1: w + 3000 },
          },
        ]);
        // Scene time an hour away: a live set must not read it.
        r.frame.setTime(w - 3600000);
        await drawn(h, r, 1);
        const pickAt = (p) => {
          const s = r.query.project(p);
          return r.query.drillPick(s.x, s.y).some((x) => x.set === 'conf:live');
        };
        ok(pickAt(along(0.5)), 'drawn delayMs behind wall time');
        ok(!pickAt(along(0.7)), 'not at wall time');
        ok(!pickAt(from), 'not held at the start by the scene clock');
        // A second of frames later it has moved on by the wall time passed.
        await drawn(h, r, 60);
        const passed = h.wallTime(r) - w;
        ok(passed > 0, 'wall time passed');
        // The segment holds at its end, however much wall time passed.
        ok(
          pickAt(along(Math.min(1, 0.5 + passed / 10000))),
          'moves on with wall time',
        );
        set.dispose();
      },
      { capability: 'motionSegments' },
    ),
    check(
      'draw.motion.climb',
      'an arc climbs at climbMps, and a negative minDtS runs it backward',
      async (h, r) => {
        await overAustin(h, r, 30000);
        const t0 = r.frame.time();
        const fixAt = { ...AUSTIN, height: 12000 };
        const fix = h.toEcef(fixAt);
        const lon = (fixAt.lon * Math.PI) / 180;
        const lat = (fixAt.lat * Math.PI) / 180;
        const east = { x: -Math.sin(lon), y: Math.cos(lon), z: 0 };
        const north = {
          x: -Math.sin(lat) * Math.cos(lon),
          y: -Math.sin(lat) * Math.sin(lon),
          z: Math.cos(lat),
        };
        const up = {
          x: Math.cos(lat) * Math.cos(lon),
          y: Math.cos(lat) * Math.sin(lon),
          z: Math.sin(lat),
        };
        // The contract's formula: the turn in the tangent plane, the climb up.
        const at = (seg, dtS, climbs = true) => {
          const track = (seg.trackDeg * Math.PI) / 180;
          const w = (seg.turnRateDps * Math.PI) / 180;
          const v = seg.speedMps;
          const straight = Math.abs(w) < 1e-4;
          const e = straight
            ? v * dtS * Math.sin(track)
            : (v / w) * (Math.cos(track) - Math.cos(track + w * dtS));
          const n = straight
            ? v * dtS * Math.cos(track)
            : (v / w) * (Math.sin(track + w * dtS) - Math.sin(track));
          const u = climbs ? seg.climbMps * dtS : 0;
          return {
            x: fix.x + east.x * e + north.x * n + up.x * u,
            y: fix.y + east.y * e + north.y * n + up.y * u,
            z: fix.z + east.z * e + north.z * n + up.z * u,
          };
        };
        const segments = {
          straight: {
            kind: 'arc',
            fix,
            t0,
            speedMps: 200,
            trackDeg: 90,
            turnRateDps: 0,
            climbMps: 1000,
            minDtS: -10,
            maxDtS: 10,
          },
          turning: {
            kind: 'arc',
            fix,
            t0,
            speedMps: 150,
            trackDeg: 0,
            turnRateDps: 3,
            climbMps: 1500,
            minDtS: 0,
            maxDtS: 20,
          },
        };
        const set = r.draw.icons({
          id: 'conf:climb',
          motionClock: { kind: 'scene' },
        });
        const find = (id, p) => {
          const s = r.query.project(p);
          return r.query
            .drillPick(s.x, s.y)
            .find((x) => x.set === 'conf:climb' && x.id === id);
        };
        const apart = (a, b) => {
          const sa = r.query.project(a);
          const sb = r.query.project(b);
          return Math.hypot(sa.x - sb.x, sa.y - sb.y);
        };
        for (const [id, seg, sceneDtS, dtS, name] of [
          ['straight', segments.straight, 30, 10, 'climbed, clamped to maxDtS'],
          ['straight', segments.straight, -30, -10, 'run backward to minDtS'],
          ['turning', segments.turning, 8, 8, 'turning and climbing at 8 s'],
        ]) {
          set.set([{ id, pos: fix, image: DOT, size: [16, 16], motion: seg }]);
          r.frame.setTime(t0 + sceneDtS * 1000);
          await drawn(h, r);
          const want = at(seg, dtS);
          const flat = at(seg, dtS, false);
          ok(apart(want, flat) > 20, `${name}: the test can tell`);
          const hit = find(id, want);
          ok(hit, `${name}: picked where the formula puts it`);
          if (hit?.position)
            nearVec(
              hit.position,
              want,
              50,
              `${name}: at the formula's position`,
            );
          ok(!find(id, flat), `${name}: not at the fix's height`);
        }
        set.dispose();
      },
      { capability: 'motionSegments' },
    ),
    check(
      'draw.lodGroup',
      'members of a lodGroup show over their own ranges and picks report the group',
      async (h, r) => {
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        const near = r.draw.points({ id: 'conf:lod-near' });
        const far = r.draw.icons({ id: 'conf:lod-far' });
        const members = (nearRange, farRange) => {
          near.set([
            {
              id: 'a',
              pos,
              pixelSize: 20,
              color: '#f00',
              lodGroup: 'thing',
              displayRange: nearRange,
            },
          ]);
          far.set([
            {
              id: 'a',
              pos,
              image: DOT,
              size: [20, 20],
              lodGroup: 'thing',
              displayRange: farRange,
            },
          ]);
        };
        const shown = () => {
          const s = r.query.project(pos);
          return r.query
            .drillPick(s.x, s.y)
            .filter(
              (x) => x.set === 'conf:lod-near' || x.set === 'conf:lod-far',
            );
        };
        members([0, 10000], [10000, Infinity]);
        for (const [height, set] of [
          [2000, 'conf:lod-near'],
          [50000, 'conf:lod-far'],
        ]) {
          await overAustin(h, r, height);
          await drawn(h, r);
          const hits = shown();
          deepEqual(
            hits.map((x) => x.set),
            [set],
            `at ${height} m only ${set} is drawn`,
          );
          equal(hits[0]?.id, 'a', `at ${height} m the hit names the member`);
          equal(hits[0]?.lodGroup, 'thing', `at ${height} m the group`);
        }
        members([0, 100000], [1000, Infinity]);
        await drawn(h, r);
        deepEqual(
          shown()
            .map((x) => x.set)
            .sort(),
          ['conf:lod-far', 'conf:lod-near'],
          'overlapping ranges show both members',
        );
        const plain = r.draw.points({ id: 'conf:lod-none' });
        plain.set([{ id: 'b', pos, pixelSize: 20, color: '#0f0' }]);
        await drawn(h, r);
        const s = r.query.project(pos);
        const hit = r.query.drillPick(s.x, s.y).find((x) => x.id === 'b');
        ok(hit && !('lodGroup' in hit), 'an item without a group has none');
        near.dispose();
        far.dispose();
        plain.dispose();
      },
    ),
    check(
      'draw.orbits',
      'an orbit is drawn where SGP4 puts it on its set’s motion clock',
      async (h, r) => {
        const t = Date.UTC(2026, 0, 4, 12);
        const expected = (ms) => {
          const date = new Date(ms);
          const satrec = twoline2satrec(ISS_TLE[0], ISS_TLE[1]);
          const eci = propagate(satrec, date).position;
          const gmst = gstime(date);
          const ecf = eciToEcf(eci, gmst);
          const geo = eciToGeodetic(eci, gmst);
          return {
            ecef: { x: ecf.x * 1000, y: ecf.y * 1000, z: ecf.z * 1000 },
            lon: (geo.longitude * 180) / Math.PI,
            lat: (geo.latitude * 180) / Math.PI,
            height: geo.height * 1000,
          };
        };
        const set = r.draw.orbits({
          id: 'conf:orbits',
          motionClock: { kind: 'scene' },
        });
        set.set([
          {
            id: 'iss',
            tle: ISS_TLE,
            marker: { pixelSize: 16, color: '#fff' },
            meta: { n: 1 },
          },
        ]);
        const hitAt = (p) => {
          const s = r.query.project(p);
          return s
            ? r.query
                .drillPick(s.x, s.y)
                .find((x) => x.set === 'conf:orbits' && x.id === 'iss')
            : undefined;
        };
        const now = expected(t);
        r.camera.setView({
          destination: {
            lon: now.lon,
            lat: now.lat,
            height: now.height + 2000000,
          },
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        r.frame.setTime(t);
        await drawn(h, r);
        const hit = hitAt(now.ecef);
        ok(hit, 'picked at its propagated position');
        deepEqual(hit?.meta, { n: 1 }, 'Hit.meta');
        if (hit?.position)
          nearVec(hit.position, now.ecef, 1000, 'within a kilometre of SGP4');
        r.frame.setTime(t + 60000);
        await drawn(h, r);
        const later = expected(t + 60000);
        const laterHit = hitAt(later.ecef);
        ok(laterHit, 'a minute on, where SGP4 puts it then');
        if (laterHit?.position)
          nearVec(
            laterHit.position,
            later.ecef,
            1000,
            'a minute on, within a kilometre',
          );
        ok(!hitAt(now.ecef), 'no longer where it was');
        set.dispose();
        // `orbits` alone, without `motionSegments`, still reads the clock.
        const alone = await h.create({
          viewport: SCRIPT_VIEWPORT,
          capabilities: [...r.capabilities].filter(
            (c) => c !== 'motionSegments',
          ),
        });
        if (alone)
          try {
            const only = alone.draw.orbits({
              id: 'conf:orbits-alone',
              motionClock: { kind: 'scene' },
            });
            only.set([
              {
                id: 'iss',
                tle: ISS_TLE,
                marker: { pixelSize: 16, color: '#fff' },
              },
            ]);
            alone.camera.setView({
              destination: {
                lon: now.lon,
                lat: now.lat,
                height: now.height + 2000000,
              },
              orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
            });
            alone.frame.setTime(t);
            await drawn(h, alone);
            const s = alone.query.project(now.ecef);
            ok(
              alone.query
                .drillPick(s.x, s.y)
                .some((x) => x.set === 'conf:orbits-alone'),
              'without motionSegments, on the scene clock it was given',
            );
            only.dispose();
          } finally {
            alone.destroy();
          }
      },
      { capability: 'orbits' },
    ),
    check(
      'draw.clampState',
      'clampState says whether clamped items drape or overlay',
      (h, r) => {
        ok(
          ['draped', 'overlay'].includes(r.draw.clampState()),
          'draped or overlay',
        );
        const off = r.draw.on('clampState', () => {});
        equal(typeof off, 'function', 'on returns an Off');
        off();
        off();
      },
    ),
    check(
      'draw.atlas',
      'icons draw slots of an atlas registered after them, and are picked',
      async (h, r) => {
        await overAustin(h, r);
        const set = r.draw.icons({ id: 'conf:atlas' });
        const at = (lon) => h.toEcef({ lon, lat: AUSTIN.lat, height: 0 });
        // A generated slot too, where there is a page to make it in.
        const canvas = globalThis.document?.createElement('canvas');
        const slots = { svg: ['dot', DOT, AUSTIN.lon - 0.002] };
        if (canvas) {
          canvas.width = canvas.height = 16;
          const g = canvas.getContext('2d');
          g.fillStyle = '#fff';
          g.fillRect(0, 0, 16, 16);
          slots.canvas = [
            'square',
            { canvas, key: 'conf:square' },
            AUSTIN.lon + 0.002,
          ];
        }
        set.set(
          Object.entries(slots).map(([id, [slot, , lon]]) => ({
            id,
            pos: at(lon),
            image: { atlas: 'conf:atlas', slot },
            size: [24, 24],
          })),
        );
        await drawn(h, r);
        r.draw.atlas(
          'conf:atlas',
          Object.fromEntries(
            Object.values(slots).map(([slot, image]) => [slot, image]),
          ),
        );
        await drawn(h, r);
        await settled(r);
        for (const [id, [, , lon]] of Object.entries(slots)) {
          const s = r.query.project(at(lon));
          ok(s, `${id} projects`);
          equal(r.query.pick(s.x, s.y)?.id, id, `${id} slot drawn and picked`);
        }
        set.dispose();
      },
    ),
    check(
      'draw.columns',
      'column updates are rows: sized, picked, removed',
      async (h, r) => {
        await overAustin(h, r);
        const set = r.draw.icons({ id: 'conf:columns' });
        const a = h.toEcef({
          lon: AUSTIN.lon - 0.003,
          lat: AUSTIN.lat,
          height: 0,
        });
        const b = h.toEcef({
          lon: AUSTIN.lon + 0.003,
          lat: AUSTIN.lat,
          height: 0,
        });
        set.set([
          { id: 'a', pos: a, image: DOT, size: [16, 16] },
          { id: 'b', pos: b, image: DOT, size: [16, 16] },
        ]);
        set.setColumns({
          ids: ['a', 'b'],
          positions: new Float64Array([b.x, b.y, b.z, a.x, a.y, a.z]),
          meta: [{ k: 'a' }, { k: 'b' }],
        });
        await drawn(h, r);
        equal(set.size(), 2, 'size');
        const sa = r.query.project(a);
        const hit = r.query
          .drillPick(sa.x, sa.y)
          .find((x) => x.set === 'conf:columns');
        equal(hit?.id, 'b', 'b moved to a’s place');
        deepEqual(hit?.meta, { k: 'b' }, 'meta from the columns');
        set.remove(['a']);
        equal(set.size(), 1, 'removed');
        set.dispose();
      },
      { capability: 'columns' },
    ),
    check(
      'draw.columns.shown',
      'a row hidden by its column keeps its motion and resumes where it would be',
      async (h, r) => {
        if (!r.capabilities.has('motionSegments'))
          return { skip: 'no motionSegments' };
        await overAustin(h, r, 8000);
        const t0 = r.frame.time();
        const from = h.toEcef({ ...AUSTIN, lon: AUSTIN.lon - 0.02, height: 0 });
        const to = h.toEcef({ ...AUSTIN, lon: AUSTIN.lon + 0.02, height: 0 });
        const along = (f) => ({
          x: from.x + (to.x - from.x) * f,
          y: from.y + (to.y - from.y) * f,
          z: from.z + (to.z - from.z) * f,
        });
        const set = r.draw.icons({
          id: 'conf:shown',
          motionClock: { kind: 'scene' },
        });
        set.set([
          {
            id: 'mover',
            pos: from,
            image: DOT,
            size: [16, 16],
            motion: { kind: 'lerp', from, to, t0, t1: t0 + 10000 },
          },
        ]);
        const pickAt = (p) => {
          const s = r.query.project(p);
          return r.query
            .drillPick(s.x, s.y)
            .some((x) => x.set === 'conf:shown');
        };
        const shown = (on) =>
          set.setColumns({ ids: ['mover'], shown: new Uint8Array([on]) });
        r.frame.setTime(t0 + 2000);
        await drawn(h, r);
        ok(pickAt(along(0.2)), 'moving before it is hidden');
        shown(0);
        r.frame.setTime(t0 + 4000);
        await drawn(h, r);
        ok(!pickAt(along(0.4)), 'hidden');
        r.frame.setTime(t0 + 7000);
        shown(1);
        await drawn(h, r);
        ok(pickAt(along(0.7)), 'shown again where its segment puts it now');
        ok(!pickAt(from), 'not restarted');
        set.dispose();
      },
      { capability: 'columns' },
    ),
    check(
      'draw.models',
      'a model set says when a model is ready',
      async (h, r) => {
        if (!h.assets?.model) return { skip: 'no model asset in this harness' };
        const set = r.draw.models({ id: 'conf:models' });
        const ready = [];
        set.on('ready', (id) => ready.push(id));
        set.set([
          {
            id: 'm',
            pos: { ...AUSTIN, height: 0 },
            url: h.assets.model,
            orientation: { heading: 0, pitch: 0, roll: 0 },
          },
        ]);
        for (let i = 0; i < 600 && !ready.length; i++) await drawn(h, r, 1);
        deepEqual(ready, ['m'], 'ready');
        set.dispose();
      },
      { capability: 'models' },
    ),

    // --- Query -------------------------------------------------------------
    check(
      'query.projectMany',
      'projectMany agrees with project; NaN behind the eye',
      async (h, r) => {
        await overAustin(h, r, 5000);
        const points = [
          h.toEcef({ ...AUSTIN, height: 0 }),
          h.toEcef({ lon: AUSTIN.lon + 0.01, lat: AUSTIN.lat, height: 0 }),
          h.toEcef({ ...AUSTIN, height: 1e6 }),
        ];
        const source = new Float64Array(points.flatMap((p) => [p.x, p.y, p.z]));
        const out = new Float32Array(points.length * 2);
        r.query.projectMany(source, out);
        for (let i = 0; i < 2; i++) {
          const s = r.query.project(points[i]);
          near(out[i * 2], s.x, 0.01, `x ${i}`);
          near(out[i * 2 + 1], s.y, 0.01, `y ${i}`);
        }
        equal(r.query.project(points[2]), null, 'project behind the eye');
        ok(
          Number.isNaN(out[4]) && Number.isNaN(out[5]),
          'projectMany behind the eye',
        );
      },
    ),
    check(
      'query.rays',
      'pickRay starts at the eye; pickEllipsoid lies on its ray; pickGlobe agrees',
      async (h, r) => {
        await overAustin(h, r, 5000);
        await settled(r);
        const eye = r.camera.pose().position;
        const ray = r.query.pickRay(640, 360);
        nearVec(ray.origin, eye, 1e-3, 'ray origin');
        near(
          Math.hypot(ray.direction.x, ray.direction.y, ray.direction.z),
          1,
          1e-9,
          'unit direction',
        );
        const ground = r.query.pickEllipsoid(640, 360);
        ok(ground, 'center of the view meets the ellipsoid');
        const t =
          (ground.x - eye.x) * ray.direction.x +
          (ground.y - eye.y) * ray.direction.y +
          (ground.z - eye.z) * ray.direction.z;
        nearVec(
          ground,
          {
            x: eye.x + ray.direction.x * t,
            y: eye.y + ray.direction.y * t,
            z: eye.z + ray.direction.z * t,
          },
          0.01,
          'on the ray',
        );
        const s = r.query.project(ground);
        nearVec(s, { x: 640, y: 360 }, 0.5, 'projects back to the pixel');
        // A bare globe: the globe surface is the ellipsoid.
        nearVec(
          r.query.pickGlobe(ray),
          ground,
          0.5,
          'pickGlobe meets the globe there',
        );
        const up = { origin: eye, direction: ray.direction };
        up.direction = {
          x: -ray.direction.x,
          y: -ray.direction.y,
          z: -ray.direction.z,
        };
        equal(r.query.pickGlobe(up), null, 'a ray away from the globe misses');
      },
    ),
    check(
      'query.heights',
      'heights: a cached height now, async samples per point, misses as null',
      async (h, r) => {
        if (!h.scriptHeights)
          return { skip: 'no scripted heights in this harness' };
        h.scriptHeights(r, (point) => (point.lon > 0 ? null : 123.5));
        const [hit, miss] = await r.query.sampleHeight([
          { ...AUSTIN },
          { lon: 10, lat: 10 },
        ]);
        near(hit.height, 123.5, 0.01, 'sampled height');
        ok(hit.confidence > 0 && hit.confidence <= 1, 'confidence in (0, 1]');
        ok(['tiles', 'terrain', 'ellipsoid'].includes(hit.source), 'source');
        ok(['visible', 'finest'].includes(hit.lod), 'lod');
        equal(miss, null, 'a miss is null');
        h.scriptHeights(r, (point, against) =>
          against === 'tiles' ? 300 : 123.5,
        );
        const there = { lon: AUSTIN.lon + 0.5, lat: AUSTIN.lat };
        const [terrain] = await r.query.sampleHeight([there], {
          against: 'terrain',
        });
        const [tiles] = await r.query.sampleHeight([there], {
          against: 'tiles',
        });
        near(terrain.height, 123.5, 0.01, 'terrain');
        near(tiles.height, 300, 0.01, 'tiles, not the terrain answer');
        h.scriptHeights(r, (point) => (point.lon > 0 ? null : 123.5));
        const out = new Float64Array(2);
        r.query.sampleHeightNowMany(
          new Float64Array([AUSTIN.lon, AUSTIN.lat, 10, 10]),
          out,
        );
        near(out[0], 123.5, 0.01, 'a batched cached height');
        ok(Number.isNaN(out[1]), 'a batched miss is NaN');
        const [plain] = await r.query.sampleHeight([{ ...AUSTIN }], {
          mostDetailed: true,
        });
        equal(
          plain.lod === 'finest',
          r.capabilities.has('finestHeights'),
          'finest only with finestHeights',
        );
        const [clamped] = await r.query.clampToSurface([
          h.toEcef({ ...AUSTIN, height: 5000 }),
        ]);
        nearVec(
          clamped,
          h.toEcef({ ...AUSTIN, height: 123.5 }),
          0.05,
          'clamped onto the surface',
        );
      },
      { capability: 'sampleHeight' },
    ),
    check(
      'query.heights.sets',
      'draw sets are not ground to height queries unless they ask to be',
      async (h, r) => {
        await overAustin(h, r);
        await drawn(h, r);
        await settled(r);
        const point = { ...AUSTIN };
        const before = await r.query.sampleHeight([point]);
        const shapes = r.draw.shapes({ id: 'conf:not-ground' });
        shapes.set([
          {
            id: 'tower',
            geometry: {
              kind: 'box',
              center: { ...AUSTIN, height: 500 },
              dimensions: { x: 200, y: 200, z: 1000 },
            },
            fill: '#888',
          },
        ]);
        const points = r.draw.points({ id: 'conf:not-ground-points' });
        points.set([
          {
            id: 'p',
            pos: { ...AUSTIN, height: 800 },
            pixelSize: 40,
            color: '#f00',
          },
        ]);
        await drawn(h, r);
        await settled(r);
        const after = await r.query.sampleHeight([point]);
        equal(after[0] === null, before[0] === null, 'answered as before');
        if (after[0] && before[0])
          near(
            after[0].height,
            before[0].height,
            0.5,
            'the same height with sets drawn over the point',
          );
        ok(after[0]?.source !== 'set', 'not answered from a set');
        shapes.dispose();
        points.dispose();
      },
      { capability: 'sampleHeight' },
    ),
    check(
      'query.withoutCapability',
      'without sampleHeight the height members answer null',
      async (h) => {
        const r = await h.create({
          viewport: SCRIPT_VIEWPORT,
          capabilities: CAPABILITIES.filter(
            (c) => !['sampleHeight', 'pickPosition', 'rayCast'].includes(c),
          ),
        });
        if (!r) return { skip: 'this harness cannot drop capabilities' };
        try {
          equal(
            r.query.sampleHeightNow({ ...AUSTIN }),
            null,
            'sampleHeightNow',
          );
          deepEqual(
            await r.query.sampleHeight([{ ...AUSTIN }]),
            [null],
            'sampleHeight',
          );
          equal(r.query.pickPosition(640, 360), null, 'pickPosition');
          equal(
            await r.query.rayCast(r.query.pickRay(640, 360)),
            null,
            'rayCast',
          );
        } finally {
          r.destroy();
        }
      },
    ),

    // --- Input -------------------------------------------------------------
    check(
      'input.lease',
      'a lease leaves ambient subscribers only move and up; a new claim ends the old',
      async (h, r) => {
        if (!h.pointer) return { skip: 'no pointer in this harness' };
        const ambient = [];
        for (const type of POINTER_TYPES)
          r.input.on(type, () => ambient.push(type));
        const seen = [];
        r.input.on('click', () => seen.push('ambient'));
        const lease = r.input.claimPointer('tool');
        for (const type of POINTER_TYPES) await h.pointer(r, type, 640, 360);
        deepEqual(ambient, ['move', 'up'], 'ambient under a lease');
        seen.length = 0;
        r.input.on('click', () => seen.push('tool'), { lease });
        ok(!r.input.isPointerFree(), 'taken');
        await h.pointer(r, 'click', 640, 360);
        deepEqual(seen, ['tool'], 'only the lease holder hears the click');
        const next = r.input.claimPointer('other');
        ok(!lease.current, 'the old lease ended');
        ok(next.current, 'the new one is current');
        seen.length = 0;
        await h.pointer(r, 'click', 640, 360);
        deepEqual(seen, [], 'neither the ambient nor the ended lease');
        next.release();
        ok(r.input.isPointerFree(), 'free again');
        await h.pointer(r, 'click', 640, 360);
        deepEqual(seen, ['ambient'], 'ambient again');
      },
    ),
    check(
      'input.lease.grab',
      'a lease with grab takes only the presses it grabs; wheel and the rest stay free',
      async (h, r) => {
        if (!h.pointer) return { skip: 'no pointer in this harness' };
        const heard = [];
        for (const type of POINTER_TYPES) {
          r.input.on(type, () => heard.push(`ambient:${type}`));
        }
        const errors = [];
        r.on('error', (e) => errors.push(e));
        let throwing = false;
        const lease = r.input.claimPointer('draw', {
          grab: (down) => {
            if (throwing) throw new Error('conformance grab');
            return down.type === 'down' && down.position.x < 640;
          },
        });
        for (const type of POINTER_TYPES)
          r.input.on(type, () => heard.push(`tool:${type}`), { lease });
        const press = async (x) => {
          heard.length = 0;
          for (const type of ['down', 'move', 'up', 'click'])
            await h.pointer(r, type, x, 360);
          return heard.slice();
        };
        deepEqual(
          await press(100),
          [
            'tool:down',
            'ambient:move',
            'tool:move',
            'ambient:up',
            'tool:up',
            'tool:click',
          ],
          'a grabbed press is the tool’s; move and up go to both',
        );
        heard.length = 0;
        await h.pointer(r, 'wheel', 100, 360, { delta: 1 });
        deepEqual(
          heard,
          ['ambient:wheel'],
          'wheel is never grabbed, even after a grabbed press',
        );
        heard.length = 0;
        await h.pointer(r, 'pinch', 100, 360, { delta: 1.1 });
        deepEqual(heard, ['ambient:pinch'], 'nor is pinch');
        deepEqual(
          await press(1000),
          [
            'ambient:down',
            'ambient:move',
            'tool:move',
            'ambient:up',
            'tool:up',
            'ambient:click',
          ],
          'a press left alone goes to the others',
        );
        ok(lease.current, 'the lease stays out');
        ok(!r.input.isPointerFree(), 'the pointer is not free');
        throwing = true;
        deepEqual(
          (await press(100)).filter((x) => x.endsWith(':down')),
          ['ambient:down'],
          'a throwing grab leaves the press to the others',
        );
        equal(errors.length, 1, 'and is reported');
        lease.release();
      },
    ),
    check(
      'input.lease.press',
      'every event of a press goes where its down went, whatever the lease does meanwhile',
      async (h, r) => {
        if (!h.pointer) return { skip: 'no pointer in this harness' };
        const heard = [];
        for (const type of ['down', 'click', 'dblclick'])
          r.input.on(type, () => heard.push(`ambient:${type}`));
        const left = (down) => down.type === 'down' && down.position.x < 640;
        const listen = (lease, name) => {
          for (const type of ['down', 'up', 'click', 'dblclick'])
            r.input.on(type, () => heard.push(`${name}:${type}`), { lease });
        };
        const at = async (x, ...types) => {
          for (const type of types) await h.pointer(r, type, x, 360);
        };

        let lease = r.input.claimPointer('a', { grab: left });
        listen(lease, 'a');
        r.input.on('up', () => lease.release(), { lease });
        heard.length = 0;
        await at(100, 'down', 'up', 'click');
        deepEqual(
          heard,
          ['a:down', 'a:up'],
          'a lease that ends on up takes the click with it: no one hears it',
        );

        heard.length = 0;
        await at(1000, 'down');
        lease = r.input.claimPointer('b', { grab: () => true });
        listen(lease, 'b');
        await at(1000, 'up', 'click');
        deepEqual(
          heard,
          ['ambient:down', 'b:up', 'ambient:click'],
          'a press left to the others stays theirs when a lease is claimed mid-press (up goes to both)',
        );

        heard.length = 0;
        await at(100, 'down', 'up', 'click', 'down', 'up', 'click', 'dblclick');
        deepEqual(
          heard.filter((x) => !x.endsWith(':up')),
          ['b:down', 'b:click', 'b:down', 'b:click', 'b:dblclick'],
          'a grabbed double-click is the lease’s',
        );
        lease.release();

        lease = r.input.claimPointer('c', { grab: left });
        listen(lease, 'c');
        heard.length = 0;
        await at(100, 'down', 'up', 'click');
        await at(1000, 'click');
        deepEqual(
          heard.filter((x) => !x.endsWith(':up')),
          ['c:down', 'c:click', 'ambient:click'],
          'a click with no press of its own is decided afresh',
        );
        lease.release();

        let latest = r.input.claimPointer('d', { grab: () => true });
        r.input.on(
          'down',
          () => {
            heard.push('d:down');
            latest = r.input.claimPointer('e', { grab: () => false });
          },
          { lease: latest },
        );
        r.input.on('down', () => heard.push('latest:down'), {
          lease: () => latest,
        });
        heard.length = 0;
        await at(100, 'down');
        deepEqual(
          heard,
          ['d:down'],
          'a lease claimed during delivery does not inherit the press',
        );
        latest.release();

        let replacement = null;
        const first = r.input.claimPointer('f', {
          grab: () => {
            replacement = r.input.claimPointer('g');
            return true;
          },
        });
        listen(first, 'f');
        heard.length = 0;
        await at(100, 'down');
        listen(replacement, 'g');
        await at(100, 'up', 'click');
        deepEqual(
          heard.filter((x) => !x.endsWith(':up')),
          [],
          'a press grabbed by a lease its grab replaced belongs to that ended lease: no one',
        );
        replacement.release();

        const downs = [];
        lease = r.input.claimPointer('h', {
          grab: (down) => {
            downs.push(down);
            return down.button === 0 && down.position.x < 640;
          },
        });
        listen(lease, 'h');
        const step = (type, x, button = 0) =>
          h.pointer(r, type, x, 360, { button });
        heard.length = 0;
        await step('down', 100);
        await step('move', 300);
        await step('up', 300);
        await step('move', 1000);
        await step('click', 1000);
        deepEqual(
          heard.filter((x) => !x.endsWith(':up')),
          ['h:down', 'ambient:click'],
          'after a drag, a later click is a press of its own',
        );
        heard.length = 0;
        await step('down', 100);
        await step('move', 300);
        await step('up', 300);
        await step('click', 1000);
        deepEqual(
          heard.filter((x) => !x.endsWith(':up')),
          ['h:down', 'ambient:click'],
          'a click straight after a drag, elsewhere, is a press of its own',
        );
        heard.length = 0;
        await step('down', 100, 0);
        await step('down', 100, 2);
        await step('up', 100, 0);
        await step('click', 100, 0);
        await step('up', 100, 2);
        await step('click', 100, 2);
        deepEqual(
          heard.filter((x) => !x.endsWith(':up')),
          ['h:down', 'ambient:down', 'h:click', 'ambient:click'],
          'each button’s press is its own',
        );
        heard.length = 0;
        await at(100, 'down', 'up', 'click');
        await at(1000, 'dblclick');
        deepEqual(
          heard.filter((x) => !x.endsWith(':up')),
          ['h:down', 'h:click', 'ambient:dblclick'],
          'a double-click elsewhere is not the click’s',
        );
        heard.length = 0;
        await at(100, 'down');
        await at(1000, 'dblclick');
        await at(100, 'up', 'click');
        deepEqual(
          heard.filter((x) => !x.endsWith(':up')),
          ['h:down', 'ambient:dblclick', 'h:click'],
          'a stray double-click during a press leaves the press its owner\u2019s',
        );
        downs.length = 0;
        await at(100, 'click');
        equal(downs.length, 1, 'an isolated click asks grab');
        equal(downs[0]?.type, 'down', 'as a down');
        ok(
          !('pick' in downs[0]) &&
            !('drill' in downs[0]) &&
            !('ground' in downs[0]),
          'with no pick',
        );
        lease.release();
      },
    ),
    check(
      'input.clickPick',
      'a click carries one pick shared by every subscriber',
      async (h, r) => {
        if (!h.pointer) return { skip: 'no pointer in this harness' };
        await overAustin(h, r);
        const set = r.draw.icons({ id: 'conf:click' });
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        set.set([{ id: 'x', pos, image: DOT, size: [24, 24] }]);
        await drawn(h, r);
        const s = r.query.project(pos);
        const hits = [];
        r.input.on('click', (ev) => hits.push(ev.pick()));
        r.input.on('click', (ev) => hits.push(ev.pick()));
        await h.pointer(r, 'click', s.x, s.y);
        equal(hits.length, 2, 'both subscribers');
        equal(hits[0]?.id, 'x', 'the hit');
        equal(hits[0], hits[1], 'the same pick object');
        set.dispose();
      },
    ),
    check(
      'input.behaviours',
      'stock behaviours are listed and suppression is counted',
      (h, r) => {
        for (const name of ['select', 'dblclickFollow']) {
          const b = r.input.behaviours[name];
          ok(b && typeof b.suppress === 'function', `${name} listed`);
          if (!b.enabled) continue;
          const one = b.suppress();
          const two = b.suppress();
          ok(!b.enabled, `${name} suppressed`);
          one();
          one();
          ok(!b.enabled, `${name} still suppressed`);
          two();
          ok(b.enabled, `${name} back`);
        }
      },
    ),

    // --- Globe -------------------------------------------------------------
    check(
      'globe.imagery',
      'imagery layers keep order, raise and lower, and leave on remove',
      (h, r) => {
        const a = r.globe.imagery.add({
          kind: 'xyz',
          url: 'https://a.invalid/{z}/{x}/{y}.png',
        });
        const b = r.globe.imagery.add({
          kind: 'xyz',
          url: 'https://b.invalid/{z}/{x}/{y}.png',
        });
        const ours = () =>
          r.globe.imagery
            .list()
            .filter((l) => l === a || l === b)
            .map((l) => (l === a ? 'a' : 'b'));
        deepEqual(ours(), ['a', 'b'], 'added in order');
        a.raise();
        deepEqual(ours(), ['b', 'a'], 'raised');
        a.lower();
        deepEqual(ours(), ['a', 'b'], 'lowered');
        a.alpha = 0.5;
        equal(a.alpha, 0.5, 'alpha');
        equal(b.drapeOn, 'all', 'drapes on whatever is drawn by default');
        equal(b.lit, true, 'lit by default');
        b.drapeOn = 'surface';
        b.lit = false;
        equal(b.drapeOn, 'surface', 'drapeOn is settable');
        equal(b.lit, false, 'lit is settable');
        a.remove();
        deepEqual(ours(), ['b'], 'the removed layer is the one gone');
        b.remove();
        deepEqual(ours(), [], 'both removed');
      },
    ),
    check(
      'globe.imagery.frames',
      'timed frames follow scene time, or setFrameTime on their own clock',
      async (h, r) => {
        await overAustin(h, r, 2000000);
        const t0 = r.frame.time();
        const frames = [0, 60000, 120000].map((dt, i) => ({
          time: t0 + dt,
          url: PIXEL_PNGS[i],
        }));
        const ready = [];
        // Frames decode in real time: wait on the clock, drawing meanwhile.
        const waitFor = async (time, ms = 5000) => {
          const until = Date.now() + ms;
          while (!ready.includes(time) && Date.now() < until) {
            await drawn(h, r, 1);
            await new Promise((done) => setTimeout(done, 10));
          }
          return ready.includes(time);
        };
        const settle = () => waitFor(Symbol('nothing'), 300);
        const scene = r.globe.imagery.add({
          kind: 'single-image',
          url: PIXEL_PNG,
        });
        scene.on('frameReady', (time) => ready.push(time));
        scene.setFrames({ kind: 'frames', frames });
        r.frame.setTime(t0 + 50000);
        ok(await waitFor(t0 + 60000), 'the frame nearest scene time is ready');
        await settle();
        ready.length = 0;
        r.frame.setTime(t0 + 55000);
        scene.setFrameTime(t0 + 130000);
        await settle();
        deepEqual(
          ready,
          [],
          'the same frame is not ready twice, and setFrameTime does nothing on the scene clock',
        );
        scene.remove();

        ready.length = 0;
        const own = r.globe.imagery.add({
          kind: 'single-image',
          url: PIXEL_PNG,
        });
        own.on('frameReady', (time) => ready.push(time));
        own.setFrames({ kind: 'frames', frames }, { clock: 'own' });
        own.setFrameTime(t0 + 130000);
        ok(await waitFor(t0 + 120000), 'setFrameTime on its own clock');
        await settle();
        ready.length = 0;
        r.frame.setTime(t0 + 5000);
        await settle();
        deepEqual(ready, [], 'scene time does not move its own clock');
        own.remove();

        ready.length = 0;
        const paused = r.globe.imagery.add({
          kind: 'single-image',
          url: PIXEL_PNG,
        });
        paused.on('frameReady', (time) => ready.push(time));
        r.frame.suspend(true);
        paused.setFrames({ kind: 'frames', frames });
        r.frame.setTime(t0 + 1000);
        r.frame.setTime(t0 + 61000);
        await settle();
        deepEqual(ready, [], 'nothing is ready while the loop is suspended');
        r.frame.suspend(false);
        ok(
          await waitFor(t0 + 60000),
          'the frame shown is ready once it is drawn',
        );
        equal(ready[0], t0 + 60000, 'and frames never drawn are not announced');
        paused.remove();

        ready.length = 0;
        const first = r.globe.imagery.add({
          kind: 'single-image',
          url: PIXEL_PNG,
        });
        const second = r.globe.imagery.add({
          kind: 'single-image',
          url: PIXEL_PNG,
        });
        first.on('frameReady', () => {
          ready.push('first');
          second.remove();
        });
        second.on('frameReady', () => ready.push('second'));
        first.setFrames({ kind: 'frames', frames });
        second.setFrames({ kind: 'frames', frames });
        r.frame.setTime(t0 + 120000);
        await waitFor('first');
        await settle();
        ok(
          !ready.includes('second'),
          'a layer removed while another announces says nothing',
        );
        first.remove();
      },
      { capability: 'imageryFrames' },
    ),
    check(
      'globe.withoutImageHooks',
      'without imageHooks, a spec with main-thread tile hooks throws',
      async (h) => {
        const r = await h.create({
          viewport: SCRIPT_VIEWPORT,
          capabilities: CAPABILITIES.filter((c) => c !== 'imageHooks'),
        });
        if (!r) return { skip: 'this harness cannot drop capabilities' };
        try {
          const url = 'https://example.invalid/{z}/{x}/{y}.png';
          throws(
            () =>
              r.globe.imagery.add({
                kind: 'xyz',
                url,
                tileTransform: (t, i) => i,
              }),
            'tileTransform',
          );
          throws(
            () =>
              r.globe.imagery.add({
                kind: 'xyz',
                url,
                admit: (t, issue) => issue(),
              }),
            'admit',
          );
          throws(
            () => r.globe.imagery.add({ kind: 'canvas', drawTile: () => {} }),
            'canvas imagery',
          );
          const plain = r.globe.imagery.add({ kind: 'xyz', url });
          ok(plain, 'a plain layer is added');
          plain.remove();
        } finally {
          r.destroy();
        }
      },
    ),
    check(
      'globe.split',
      'the split position round-trips',
      (h, r) => {
        r.globe.imagery.setSplit(0.3);
        near(r.globe.imagery.getSplit(), 0.3, 1e-9, 'split');
      },
      { capability: 'splitSwipe' },
    ),
    check(
      'globe.sky',
      'sky settings round-trip and keep unchanged keys',
      (h, r) => {
        const before = r.globe.sky.get();
        r.globe.sky.set({ stars: !before.stars, milkyWay: 0.25 });
        const after = r.globe.sky.get();
        equal(after.stars, !before.stars, 'stars');
        near(after.milkyWay, 0.25, 1e-9, 'milkyWay');
        equal(after.atmosphere, before.atmosphere, 'atmosphere unchanged');
      },
    ),

    // --- Effects, credits, quality ---------------------------------------
    check(
      'effects.styles',
      'a style is set, tuned and cleared; diagnostics follow',
      (h, r) => {
        // Core defines its styles on a renderer with none of its own.
        const off = r.effects.styles().length
          ? null
          : r.effects.defineStyle(swapStyle('conf:plain'));
        const styles = r.effects.styles();
        ok(styles.length > 0, 'styles listed');
        const changes = [];
        r.effects.on('change', (d) => changes.push(d));
        r.effects.setStyle(styles[0].id);
        equal(r.effects.diagnostics().style, styles[0].id, 'style active');
        r.effects.setStyleIntensity(styles[0].id, 0.5);
        r.effects.setStyle(null);
        equal(r.effects.diagnostics().style, null, 'cleared');
        ok(changes.length >= 2, 'change events');
        r.effects.setStyleIntensity(styles[0].id, 0);
        off?.();
      },
      { capability: 'styles' },
    ),
    check(
      'effects.defineStyle',
      'Core defines a style: listed, set, replaced and removed',
      (h, r) => {
        const definition = {
          id: 'conf:tint',
          params: [{ key: 'amount', min: 0, max: 1, default: 0.5 }],
          animated: false,
          shader: {
            glsl: `uniform sampler2D colorTexture;
uniform float intensity;
uniform float amount;
in vec2 v_textureCoordinates;
void main() {
  vec4 c = texture(colorTexture, v_textureCoordinates);
  out_FragColor = vec4(mix(c.rgb, c.rgb * vec3(1.0, amount, amount), intensity), 1.0);
}`,
            wgsl: `@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureSample(colorTexture, colorSampler, uv);
  let tinted = c.rgb * vec3f(1.0, params.amount, params.amount);
  return vec4f(mix(c.rgb, tinted, params.intensity), 1.0);
}`,
          },
        };
        const off = r.effects.defineStyle(definition);
        equal(typeof off, 'function', 'an Off, with a GLSL and a WGSL source');
        const listed = r.effects.styles().filter((s) => s.id === 'conf:tint');
        equal(listed.length, 1, 'listed once');
        deepEqual(listed[0].params, definition.params, 'with its parameters');
        r.effects.setStyle('conf:tint', { amount: 0.2 });
        equal(r.effects.diagnostics().style, 'conf:tint', 'set');
        const offAgain = r.effects.defineStyle({
          ...definition,
          animated: true,
        });
        equal(
          r.effects.styles().filter((s) => s.id === 'conf:tint').length,
          1,
          'a second definition replaces the first',
        );
        equal(
          r.effects.diagnostics().style,
          'conf:tint',
          'the style stays on through its replacement',
        );
        off();
        ok(
          r.effects.styles().some((s) => s.id === 'conf:tint'),
          'the replaced definition’s Off leaves the new one',
        );
        offAgain();
        ok(!r.effects.styles().some((s) => s.id === 'conf:tint'), 'removed');
        equal(r.effects.diagnostics().style, null, 'and turned off');
        offAgain();
      },
      { capability: 'styles' },
    ),
    check(
      'effects.crossfade',
      'a replaced style draws until its intensity is 0',
      (h, r) => {
        const define = (id) => r.effects.defineStyle(swapStyle(id));
        const offs = [define('conf:a'), define('conf:b')];
        const drawn = () =>
          r.effects
            .diagnostics()
            .passes.filter((p) => p === 'style:conf:a' || p === 'style:conf:b')
            .sort();
        try {
          r.effects.setStyle('conf:a');
          deepEqual(drawn(), ['style:conf:a'], 'the style draws');
          r.effects.setStyleIntensity('conf:b', 0);
          r.effects.setStyle('conf:b');
          deepEqual(
            drawn(),
            ['style:conf:a'],
            'the new style at 0 draws nothing yet',
          );
          r.effects.setStyleIntensity('conf:a', 0.6);
          r.effects.setStyleIntensity('conf:b', 0.4);
          deepEqual(
            drawn(),
            ['style:conf:a', 'style:conf:b'],
            'both draw mid-fade',
          );
          r.effects.setStyleIntensity('conf:a', 0);
          deepEqual(drawn(), ['style:conf:b'], 'the old one stops at 0');
          r.effects.setStyle('conf:a');
          r.effects.setStyle('conf:b');
          r.effects.setStyleIntensity('conf:a', 1);
          deepEqual(
            drawn(),
            ['style:conf:b'],
            'a style replaced at 0 does not fade',
          );
          r.effects.setStyleIntensity('conf:a', 0);
          r.effects.setStyleIntensity('conf:a', 1);
          deepEqual(
            drawn(),
            ['style:conf:b'],
            'a faded-out style does not come back by intensity alone',
          );
          r.effects.setStyle(null);
          deepEqual(drawn(), ['style:conf:b'], 'cleared, it fades');
          r.effects.setStyleIntensity('conf:b', 0);
          deepEqual(drawn(), [], 'and stops');
        } finally {
          for (const off of offs) off?.();
        }
      },
      { capability: 'styles' },
    ),
    check(
      'effects.withoutStyles',
      'without styles, styles() is empty',
      async (h) => {
        const r = await h.create({
          viewport: SCRIPT_VIEWPORT,
          capabilities: CAPABILITIES.filter((c) => c !== 'styles'),
        });
        if (!r) return { skip: 'this harness cannot drop capabilities' };
        try {
          deepEqual(r.effects.styles(), [], 'styles()');
          equal(
            r.effects.defineStyle({
              id: 'x',
              params: [],
              animated: false,
              shader: { glsl: 'void main() {}' },
            }),
            null,
            'defineStyle() answers null',
          );
        } finally {
          r.destroy();
        }
      },
    ),
    check(
      'credits',
      'a static credit is listed until its Off, with change events',
      (h, r) => {
        const events = [];
        r.credits.on('change', (list) => events.push(list.length));
        const base = r.credits.list().length;
        const credit = {
          text: 'Conformance <data>',
          href: 'https://example.invalid/data',
          logoUrl: 'https://example.invalid/logo.png',
          inline: true,
        };
        const off = r.credits.addStatic(credit);
        deepEqual(
          r.credits.list().find((c) => c.text === credit.text),
          credit,
          'listed as given, text left as text',
        );
        off();
        equal(r.credits.list().length, base, 'removed');
        deepEqual(events, [base + 1, base], 'change events');
      },
    ),
    check(
      'quality',
      'knobs name real keys; set applies supported keys and returns the rest',
      async (h, r) => {
        const knobs = r.quality.knobs();
        for (const k of knobs)
          ok(QUALITY_KEYS.includes(k.key), `known key ${k.key}`);
        const supported = new Set(knobs.map((k) => k.key));
        // A value each knob accepts and that differs from its default.
        const valueFor = (k) => {
          if (k.kind === 'boolean') return !k.default;
          if (k.kind === 'enum')
            return k.options.find((o) => o !== k.default) ?? k.default;
          if (k.kind === 'number') return k.default === k.min ? k.max : k.min;
          return k.default;
        };
        const wanted = Object.fromEntries(
          knobs.map((k) => [k.key, valueFor(k)]),
        );
        const patch = {
          ...Object.fromEntries(QUALITY_KEYS.map((k) => [k, 0.5])),
          ...wanted,
        };
        const ignored = r.quality.set(patch);
        await drawn(h, r, 1);
        const applied = r.quality.get();
        for (const [key, value] of Object.entries(wanted))
          deepEqual(applied[key], value, `${key} applied`);
        deepEqual(
          [...ignored].sort(),
          QUALITY_KEYS.filter((k) => !supported.has(k)).sort(),
          'ignored keys',
        );
        ok(
          ['none', 'frame', 'perPass'].includes(r.quality.signals.gpuTiming),
          'gpuTiming',
        );
        const facts = r.quality.device();
        ok(facts && typeof facts === 'object', 'device facts');
      },
    ),
    check(
      'renderer.whenSettled',
      'whenSettled names what is still loading',
      async (h, r) => {
        const result = await r.whenSettled({ timeoutMs: 5000 });
        ok(['settled', 'timeout', 'failed'].includes(result.state), 'state');
        ok(Array.isArray(result.blockers), 'blockers');
        equal(
          result.state === 'settled',
          result.blockers.length === 0,
          'settled exactly when nothing blocks',
        );
      },
    ),
    check(
      'renderer.readPixels',
      'readPixels reads the drawn frame, cropped and scaled, at once',
      async (h, r) => {
        await overAustin(h, r);
        r.frame.renderNow();
        const full = r.readPixels();
        equal(full.width, SCRIPT_VIEWPORT.width, 'the canvas’s CSS width');
        equal(full.height, SCRIPT_VIEWPORT.height, 'the canvas’s CSS height');
        equal(full.data.length, full.width * full.height * 4, 'RGBA bytes');
        const part = r.readPixels({
          crop: { x: 10, y: 20, width: 40, height: 30 },
          scale: 0.5,
        });
        deepEqual(
          [part.width, part.height, part.data.length],
          [20, 15, 20 * 15 * 4],
          'a crop, scaled',
        );
      },
    ),
    check(
      'renderer.releaseUnused',
      'releaseUnused keeps what is in view drawn and picked',
      async (h, r) => {
        await overAustin(h, r);
        const set = r.draw.points({ id: 'conf:release' });
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        set.set([{ id: 'kept', pos, pixelSize: 20, color: '#f00' }]);
        await drawn(h, r);
        r.releaseUnused();
        await drawn(h, r);
        const s = r.query.project(pos);
        ok(s, 'the point projects');
        equal(r.query.pick(s.x, s.y)?.id, 'kept', 'still picked');
        set.dispose();
      },
    ),
    check(
      'quality.signals',
      'frame signals arrive for drawn frames',
      async (h, r) => {
        const signals = [];
        r.quality.signals.on('frame', (s) => signals.push(s));
        await drawn(h, r, 2);
        ok(signals.length >= 1, 'signals');
        ok(signals[0].width > 0 && signals[0].height > 0, 'size');
      },
    ),
  ];
}
