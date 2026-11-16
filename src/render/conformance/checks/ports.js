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
import { deepEqual, equal, near, nearVec, ok, throws } from '../expect.js';
import { iconPosition } from '../../motion/iconMotion.js';
import { encodeVectorTile } from '../../vectorBase/encode.js';

/** 1 × 1 PNGs (red, green, blue), so imagery checks load nothing from the network. */
const PIXEL_PNGS = [
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==',
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==',
];
const PIXEL_PNG = PIXEL_PNGS[0];

const DOT = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="#fff"/></svg>',
};

/** A white square, solid to its edges. */
const SQUARE = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#fff"/></svg>',
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
 * query answers from what is loaded. Where the renderer draws synchronously it
 * is settled at once.
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

/**
 * Every call a set takes after it is disposed: each must do nothing. `item`
 * (null: none) is what `set` and `upsert` are given.
 */
function lateCalls(set, item) {
  const list = item ? [item] : [];
  set.set(list);
  set.upsert(item ? [{ ...item, id: 'b' }] : []);
  set.show = true;
  set.setOptions({ pickable: true, drawOrder: 3 });
  set.setColumns?.({
    ids: ['c'],
    positions: new Float64Array(
      item?.pos ? [item.pos.x, item.pos.y, item.pos.z] : [0, 0, 0],
    ),
  });
  set.remove(['missing']);
  set.upsert(list);
  set.dispose();
}

/** A check over a fresh renderer, destroyed afterwards. */
/**
 * The sky with the renderer's look off (`SkySettings`): what is drawn shows
 * its own colours, for the checks that read an exact colour.
 */
const BARE_SKY = Object.freeze({
  atmosphere: false,
  fog: false,
  lighting: false,
});

function check(id, title, run, extra = {}) {
  return {
    id,
    port: id.split('.')[0],
    title,
    ...extra,
    async run(h) {
      const r = await fresh(h);
      try {
        // One capability or several, each needed.
        for (const capability of [extra.capability ?? []].flat())
          if (!r.capabilities.has(capability))
            return { skip: `no ${capability}` };
        if (extra.bareSky) r.globe.sky.set(BARE_SKY);
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

/** A style that mirrors the image left to right: it moves every pixel. */
const mirrorStyle = (id) => ({
  id,
  params: [],
  animated: false,
  shader: {
    glsl: `uniform sampler2D colorTexture;
uniform float intensity;
in vec2 v_textureCoordinates;
void main() {
  vec2 uv = v_textureCoordinates;
  vec2 mirrored = vec2(1.0 - uv.x, uv.y);
  out_FragColor = vec4(texture(colorTexture, mix(uv, mirrored, step(0.5, intensity))).rgb, 1.0);
}`,
    wgsl: `@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let mirrored = vec2f(1.0 - uv.x, uv.y);
  let at = mix(uv, mirrored, step(0.5, params.intensity));
  return vec4f(textureSample(colorTexture, colorSampler, at).rgb, 1.0);
}`,
  },
});

/** `draw.icons.cluster`, and with `moving` its rows on their segments. */
function clusterCheck(moving) {
  return check(
    moving ? 'draw.motion.cluster' : 'draw.icons.cluster',
    moving
      ? 'moving icons cluster where their segments put them, picked as their members seed first; apart again, each is its own'
      : 'icons close on screen draw as one cluster, picked as its members seed first at its position; apart again, each is its own',
    async (h, r) => {
      await overAustin(h, r, 2000);
      const counts = [];
      const t0 = r.frame.time();
      if (moving) r.frame.setTime(t0 + 20000);
      const set = r.draw.icons({
        id: 'conf:cluster',
        ...(moving ? { motionClock: { kind: 'scene' } } : {}),
        cluster: {
          pixelRange: 20,
          minimumSize: 3,
          icon: (count) => {
            counts.push(count);
            return DOT;
          },
        },
      });
      const at = (dx, dy) =>
        h.toEcef({
          lon: AUSTIN.lon + 0.0008 + dx * 0.0003,
          lat: AUSTIN.lat + 0.0006 + dy * 0.0003,
          height: 0,
        });
      const members = [
        ['a', at(0, 0)],
        ['b', at(1, 0)],
        ['c', at(0, 1)],
        ['d', at(1, 1)],
      ];
      const far = h.toEcef({
        lon: AUSTIN.lon - 0.003,
        lat: AUSTIN.lat - 0.002,
        height: 0,
      });
      set.set([
        ...members.map(([id, pos]) => ({
          id,
          // Moving: given far off, come to rest where the rest are.
          pos: moving ? far : pos,
          image: DOT,
          size: [16, 16],
          meta: { m: id },
          ...(moving
            ? {
                motion: {
                  kind: 'lerp',
                  from: far,
                  to: pos,
                  t0,
                  t1: t0 + 10000,
                },
              }
            : {}),
        })),
        {
          id: 'far',
          pos: far,
          image: DOT,
          size: [16, 16],
          ...(moving ? { motion: { kind: 'hold' } } : {}),
        },
      ]);
      await drawn(h, r);
      await settled(r);
      await drawn(h, r);
      ok(counts.includes(4), 'the icon is drawn for its count');
      const mean = members.reduce(
        (m, [, p]) => ({
          x: m.x + p.x / members.length,
          y: m.y + p.y / members.length,
          z: m.z + p.z / members.length,
        }),
        { x: 0, y: 0, z: 0 },
      );
      const s = r.query.project(mean);
      ok(s, 'the cluster projects');
      const hit = r.query.pick(s.x, s.y);
      deepEqual(
        [hit?.set, hit?.id, hit?.meta],
        ['conf:cluster', 'a', { m: 'a' }],
        'pick gives the seed, with its own meta',
      );
      ok(hit?.position, 'at a position');
      nearVec(hit.position, mean, 1, 'the cluster’s position');
      const drilled = r.query
        .drillPick(s.x, s.y)
        .filter((x) => x.set === 'conf:cluster');
      deepEqual(
        drilled.map((x) => [x.id, x.meta?.m]),
        members.map(([id]) => [id, id]),
        'drillPick gives every member, seed first',
      );
      const sf = r.query.project(far);
      equal(r.query.pick(sf.x, sf.y)?.id, 'far', 'an icon on its own');

      await overAustin(h, r, 300);
      r.camera.setView({
        destination: {
          lon: AUSTIN.lon + 0.00095,
          lat: AUSTIN.lat + 0.00075,
          height: 300,
        },
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      await drawn(h, r);
      await settled(r);
      await drawn(h, r);
      for (const [id, pos] of members) {
        const m = r.query.project(pos);
        ok(m, `${id} projects`);
        deepEqual(
          r.query
            .drillPick(m.x, m.y)
            .filter((x) => x.set === 'conf:cluster')
            .map((x) => x.id),
          [id],
          `${id} on its own once apart`,
        );
      }
      set.dispose();
    },
    { capability: moving ? ['cluster', 'motionSegments'] : 'cluster' },
  );
}

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
        // Set in preUpdate, it is the time the frame under way draws at.
        const t1 = t0 + 3_600_000;
        let drawnAt = null;
        const offUpdate = r.frame.on('preUpdate', () => r.frame.setTime(t1));
        let laterAt = null;
        const offLater = r.frame.on('preUpdate', (t) => (laterAt = t.time));
        const offRender = r.frame.on('preRender', (t) => (drawnAt = t.time));
        const once = r.frame.renderOnce();
        await h.frame(r);
        await once;
        offUpdate();
        offLater();
        offRender();
        equal(laterAt, t1, 'later preUpdate listeners see it');
        equal(drawnAt, t1, 'a time set in preUpdate is that frame’s time');
        equal(r.frame.time(), t1, 'and time() reports it');
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
    check(
      'frame.renderNow.ifDue',
      'renderNow({ifDue}) ticks the loop now and draws a frame that is due',
      async (h, r) => {
        let ticks = 0;
        let drawnFrames = 0;
        r.frame.on('preUpdate', () => (ticks += 1));
        r.frame.on('postRender', () => (drawnFrames += 1));
        await h.frame(r);
        const [ticked, drawn] = [ticks, drawnFrames];
        r.frame.requestRender('conformance');
        r.frame.renderNow({ ifDue: true });
        equal(ticks, ticked + 1, 'one tick, synchronously');
        equal(drawnFrames, drawn + 1, 'the asked-for frame drawn');
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
      'draw.afterDispose',
      'a disposed set draws nothing, whatever is called on it after',
      async (h, r) => {
        await overAustin(h, r);
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        // A live set beside them, so the picks below can find something.
        const live = r.draw.points({ id: 'conf:kept' });
        live.set([{ id: 'kept', pos, pixelSize: 8, color: '#0f0' }]);
        const point = { id: 'a', pos, pixelSize: 30, color: '#f00' };
        const icon = { id: 'a', pos, image: DOT, size: [32, 32] };
        const gone = [
          [r.draw.points({ id: 'conf:gone:points' }), point],
          [r.draw.icons({ id: 'conf:gone:icons' }), icon],
        ];
        for (const [kind, capability] of SET_KINDS)
          if (!capability || r.capabilities.has(capability))
            gone.push([r.draw[kind]({ id: `conf:gone:${kind}:empty` }), null]);
        for (const [set] of gone) set.dispose();
        for (const [set, item] of gone) lateCalls(set, item);
        await drawn(h, r);
        await settled(r);
        const s = r.query.project(pos);
        ok(s, 'the point projects');
        const hits = r.query.drillPick(s.x, s.y);
        ok(
          hits.some((hit) => hit.set === 'conf:kept'),
          'the live set is picked',
        );
        ok(
          hits.every((hit) => !String(hit.set).startsWith('conf:gone')),
          'nothing of a disposed set is picked',
        );
        ok(
          gone.every(([set]) => set.show === false || set.show === true),
          'show still reads',
        );
        // Its id is free; the old handle does not reach the new set.
        const again = r.draw.points({ id: 'conf:gone:points' });
        lateCalls(gone[0][0], point);
        equal(again.size(), 0, 'the newer set under the id is untouched');
        again.dispose();
        live.dispose();
      },
    ),
    {
      id: 'renderer.afterDestroy',
      port: 'renderer',
      title: 'once the renderer is destroyed, its sets and new ones do nothing',
      async run(h) {
        const r = await fresh(h);
        const sets = [];
        try {
          await overAustin(h, r);
          for (const [kind, capability] of SET_KINDS)
            if (!capability || r.capabilities.has(capability))
              sets.push(r.draw[kind]({ id: `conf:destroyed:${kind}` }));
        } finally {
          r.destroy();
        }
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        const point = { id: 'a', pos, pixelSize: 30, color: '#f00' };
        const late = r.draw.points({ id: 'conf:destroyed:late' });
        // What is set on them is not kept, so nothing is drawn of it.
        for (const set of [sets[1], late]) {
          set.set([point]);
          set.upsert([{ ...point, id: 'b' }]);
          equal(set.size(), 0, `${set.id} keeps nothing set after destroy`);
        }
        for (const set of sets) lateCalls(set, set === sets[1] ? point : null);
        lateCalls(late, point);
        for (const set of [...sets, late]) set.dispose();
      },
    },
    {
      id: 'renderer.afterDestroy.frames',
      port: 'renderer',
      title:
        'once the renderer is destroyed, renderOnce and capture reject, and a renderOnce waiting rejects too',
      async run(h) {
        const r = await fresh(h);
        let waiting;
        try {
          await overAustin(h, r);
          // Suspended, the loop draws nothing: the renderOnce waits.
          r.frame.suspend(true);
          waiting = r.frame.renderOnce().then(
            () => 'resolved',
            (error) => error,
          );
        } finally {
          r.destroy();
        }
        const destroyed = (error, what) =>
          ok(
            error instanceof Error && /destroyed/.test(error.message),
            `${what} rejects saying the renderer is destroyed (${error})`,
          );
        const settledIn = (promise) =>
          Promise.race([
            promise,
            new Promise((resolve) => setTimeout(() => resolve('hung'), 2000)),
          ]);
        destroyed(await settledIn(waiting), 'a renderOnce waiting at destroy');
        destroyed(
          await settledIn(
            r.frame.renderOnce().then(
              () => 'resolved',
              (error) => error,
            ),
          ),
          'renderOnce',
        );
        destroyed(
          await settledIn(
            r.capture().then(
              () => 'resolved',
              (error) => error,
            ),
          ),
          'capture',
        );
      },
    },
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
        equal(
          r.query.drillPick(s.x, s.y, { limit: 0 }).length,
          0,
          'a limit of 0 picks nothing',
        );
        ok(
          r.query.drillPick(s.x, s.y).every((hit) => hit.surface === false),
          'never the surface',
        );
        deepEqual(
          r.query.drillPick(s.x + 120, s.y + 120),
          [],
          'nothing over the bare globe',
        );
        // An unpickable set over them is looked through, never named.
        const cover = r.draw.points({
          id: 'conf:drill-cover',
          pickable: false,
        });
        cover.set([{ id: 'c', pos, pixelSize: 30, color: '#00f' }]);
        await drawn(h, r);
        const through = r.query.drillPick(s.x, s.y, { limit: 2 });
        ok(
          through.every((hit) => hit.set === 'conf:drill'),
          'an unpickable set is not named',
        );
        equal(through.length, 2, 'the items under it are');
        cover.dispose();
        set.dispose();
        // Nearest first: stacked under a downward eye, the highest is nearest.
        const stack = r.draw.points({ id: 'conf:drill-stack' });
        stack.set(
          [0, 300, 600].map((height) => ({
            id: `h${height}`,
            pos: h.toEcef({ ...AUSTIN, height }),
            pixelSize: 20,
            color: '#f0f',
          })),
        );
        await drawn(h, r);
        const top = r.query.project(h.toEcef({ ...AUSTIN, height: 600 }));
        const all = r.query
          .drillPick(top.x, top.y)
          .filter((x) => x.set === 'conf:drill-stack')
          .map((x) => x.id);
        deepEqual(all, ['h600', 'h300', 'h0'], 'nearest first');
        const bounded = r.query
          .drillPick(top.x, top.y, { limit: 2 })
          .map((x) => x.id);
        ok(bounded.length <= 2, 'no more than the limit');
        deepEqual(bounded, all.slice(0, bounded.length), 'the nearest of them');
        stack.dispose();
      },
    ),
    check(
      'draw.field.rasterShell',
      "a shell draws its image, and its 'drawn' comes once per change, never while hidden",
      async (h, r) => {
        await overAustin(h, r, 20000);
        // Around Austin, below the eye, which the shell covers whole; where
        // it projects is in the units `readPixels` crops in.
        const below = r.query.project(h.toEcef({ ...AUSTIN, height: 0 }));
        ok(below, 'the ground below projects');
        const middle = async () => {
          await settled(r);
          r.frame.renderNow();
          return r.readPixels({
            crop: {
              x: Math.round(below.x) - 6,
              y: Math.round(below.y) - 6,
              width: 13,
              height: 13,
            },
          }).data;
        };
        // How many pixels are clearly bluer than they were.
        const bluer = (now, was) => {
          let n = 0;
          for (let i = 0; i < now.length; i += 4)
            if (now[i + 2] - was[i + 2] > 40 && now[i] - was[i] < 20) n++;
          return n;
        };
        const readsPixels = h.pixels !== false;
        const empty = readsPixels ? await middle() : null;
        const svg = (fill) => ({
          svg: `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${fill}"/></svg>`,
        });
        const errors = [];
        const offError = r.on('error', (e) => errors.push(e));
        const field = r.draw.field({
          kind: 'rasterShell',
          id: 'conf:shell',
          image: svg('#0a84ff'),
          rectangle: { west: -98.5, south: 29.5, east: -97, north: 31 },
          heightM: 8000,
          alpha: 0.6,
        });
        let drawnCount = 0;
        const off = field.on('drawn', () => (drawnCount += 1));
        // Frames until 'drawn' has come `want` times, for at most 20 s.
        const until = async (want) => {
          const deadline = Date.now() + 20000;
          while (drawnCount < want && Date.now() < deadline)
            await drawn(h, r, 1);
        };
        try {
          await until(1);
          equal(drawnCount, 1, 'drawn once made');
          if (readsPixels)
            ok(
              bluer(await middle(), empty) >= 150,
              'the shell draws its image over the frame',
            );
          await drawn(h, r, 4);
          equal(drawnCount, 1, 'not again while nothing changes');
          field.update({ image: svg('#ff3b30') });
          await until(2);
          equal(drawnCount, 2, 'drawn after a new image');
          field.update({ alpha: 0.3 });
          await until(3);
          equal(drawnCount, 3, 'drawn after a new alpha');
          field.show = false;
          field.update({ liftM: 500 });
          await drawn(h, r, 6);
          equal(drawnCount, 3, 'never while hidden');
          field.show = true;
          await until(4);
          equal(drawnCount, 4, 'drawn once shown again');
          await drawn(h, r, 4);
          equal(drawnCount, 4, 'and only once');
          deepEqual(errors, [], 'no errors');
          await listenerRules(
            r,
            "field.on('drawn')",
            (cb) => field.on('drawn', cb),
            async () => {
              const want = drawnCount + 1;
              field.update({ alpha: drawnCount % 2 ? 0.4 : 0.5 });
              await until(want);
            },
          );
        } finally {
          off();
          offError();
          field.dispose();
        }
      },
      { capability: 'fields' },
    ),
    check(
      'draw.field.windStreamlines',
      "streamlines' 'drawn' comes once per change, never while hidden",
      async (h, r) => {
        await overAustin(h, r, 2000000);
        const width = 8;
        const height = 5;
        const errors = [];
        const offError = r.on('error', (e) => errors.push(e));
        const field = r.draw.field({
          kind: 'windStreamlines',
          id: 'conf:wind',
          u: new Float32Array(width * height).fill(12),
          v: new Float32Array(width * height).fill(4),
          width,
          height,
          rectangle: { west: -180, south: -80, east: 180, north: 80 },
          pathBudget: 200,
          steps: 8,
          style: { color: '#80c9e6', widthPx: 2 },
          heightM: 12000,
          alpha: 1,
        });
        let drawnCount = 0;
        const off = field.on('drawn', () => (drawnCount += 1));
        // Frames until 'drawn' has come `want` times, for at most 20 s.
        const until = async (want) => {
          const deadline = Date.now() + 20000;
          while (drawnCount < want && Date.now() < deadline)
            await drawn(h, r, 1);
        };
        try {
          await until(1);
          equal(drawnCount, 1, 'drawn once made');
          await drawn(h, r, 4);
          equal(drawnCount, 1, 'not again while nothing changes');
          field.update({ alpha: 0.5 });
          await until(2);
          equal(drawnCount, 2, 'drawn after a new alpha');
          field.update({ paused: true });
          await until(3);
          equal(drawnCount, 3, 'drawn once paused');
          field.show = false;
          field.update({ alpha: 0.4 });
          await drawn(h, r, 6);
          equal(drawnCount, 3, 'never while hidden');
          field.show = true;
          await until(4);
          equal(drawnCount, 4, 'drawn once shown again');
          deepEqual(errors, [], 'no errors');
        } finally {
          off();
          offError();
          field.dispose();
        }
      },
      { capability: 'fields' },
    ),
    check(
      'draw.drawOrder',
      'of sets drawn over depth, the higher draw order is on top and picked',
      async (h, r) => {
        await overAustin(h, r);
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        const icon = (id) => ({
          id,
          pos,
          image: DOT,
          size: [24, 24],
          disableDepthTest: Infinity,
        });
        const first = r.draw.icons({ id: 'conf:order-first' });
        // Made after it, but drawn over it.
        const second = r.draw.icons({ id: 'conf:order-second', drawOrder: 2 });
        first.set([icon('a')]);
        second.set([icon('b')]);
        await drawn(h, r);
        await settled(r);
        const s = r.query.project(pos);
        ok(s, 'the icons project');
        const sets = () =>
          r.query
            .drillPick(s.x, s.y)
            .filter((x) => x.set.startsWith('conf:order-'))
            .map((x) => x.set);
        equal(r.query.pick(s.x, s.y)?.set, 'conf:order-second', 'the higher');
        deepEqual(
          sets(),
          ['conf:order-second', 'conf:order-first'],
          'topmost first',
        );
        first.setOptions({ drawOrder: 3 });
        await drawn(h, r);
        equal(
          r.query.pick(s.x, s.y)?.set,
          'conf:order-first',
          'raised, the pick flips',
        );
        deepEqual(
          sets(),
          ['conf:order-first', 'conf:order-second'],
          'and the drill',
        );
        // Of one order, they keep the order they were made in.
        first.setOptions({ drawOrder: 0 });
        second.setOptions({ drawOrder: 0 });
        await drawn(h, r);
        equal(
          r.query.pick(s.x, s.y)?.set,
          'conf:order-first',
          'equal ones as they were made',
        );
        first.dispose();
        second.dispose();
      },
    ),
    check(
      'query.pickBeforeStyles',
      'picks answer against the scene as drawn before styles',
      async (h, r) => {
        await overAustin(h, r);
        const set = r.draw.icons({ id: 'conf:pick-styled' });
        // Off centre, so a style that mirrors the image moves it.
        const pos = h.toEcef({
          lon: AUSTIN.lon + 0.004,
          lat: AUSTIN.lat,
          height: 0,
        });
        set.set([{ id: 'one', pos, image: DOT, size: [24, 24] }]);
        await drawn(h, r);
        await settled(r);
        const s = r.query.project(pos);
        ok(s, 'the icon projects');
        const off = r.effects.defineStyle(mirrorStyle('conf:mirror'));
        r.effects.setStyle('conf:mirror');
        r.effects.setStyleIntensity('conf:mirror', 1);
        await drawn(h, r);
        equal(r.effects.diagnostics().style, 'conf:mirror', 'the style is on');
        const hit = r.query.pick(s.x, s.y);
        equal(
          hit?.set,
          'conf:pick-styled',
          'picked where it is, not where it shows',
        );
        equal(hit?.id, 'one', 'Hit.id');
        r.effects.setStyle(null);
        off();
        set.dispose();
      },
      { capability: 'styles' },
    ),
    check(
      'effects.screenModulation',
      'a sector draws its pass, asks for a frame, and leaves picks alone',
      async (h, r) => {
        await overAustin(h, r);
        const set = r.draw.icons({ id: 'conf:pick-swept' });
        const pos = h.toEcef({
          lon: AUSTIN.lon + 0.004,
          lat: AUSTIN.lat,
          height: 0,
        });
        const passes = () => r.effects.diagnostics().passes;
        // The sweep stands 100 px left of the icon and points up, so the
        // icon is outside the band, dimmed all the way.
        const sector = (s) => ({
          center: { x: s.x - 100, y: s.y },
          angle: 0,
          width: 0.3,
          radius: 400,
          floor: 0,
          strength: 0.6,
          color: '#00ff88',
        });
        // Whether one tick after `change`, with nothing else asked of it,
        // draws: from idle, which is asserted first.
        const drawsOnItsOwn = async (change) => {
          deepEqual(await idleWatch(h, r, 1), [['u', false]], 'idle first');
          let rendered = false;
          const off = r.frame.on('postRender', () => (rendered = true));
          try {
            change();
            await h.frame(r);
          } finally {
            off();
          }
          return rendered;
        };
        const demand = r.frame.mode() !== 'continuous';
        try {
          set.set([{ id: 'one', pos, image: DOT, size: [24, 24] }]);
          await drawn(h, r);
          await settled(r);
          const s = r.query.project(pos);
          ok(s, 'the icon projects');
          const before = r.query.pick(s.x, s.y);
          equal(before?.id, 'one', 'the icon picks');
          equal(passes().includes('screenModulation'), false, 'off at first');
          const setSector = () => r.effects.screenModulation(sector(s));
          if (demand)
            ok(await drawsOnItsOwn(setSector), 'setting asks for a frame');
          else setSector();
          await drawn(h, r);
          ok(passes().includes('screenModulation'), 'the pass draws');
          const hit = r.query.pick(s.x, s.y);
          deepEqual(
            [hit?.set, hit?.id],
            [before.set, before.id],
            'a dimmed icon picks as before',
          );
          const clear = () => r.effects.screenModulation(null);
          if (demand)
            ok(await drawsOnItsOwn(clear), 'clearing asks for a frame');
          else clear();
          await drawn(h, r);
          equal(passes().includes('screenModulation'), false, 'gone on null');
        } finally {
          r.effects.screenModulation(null);
          set.dispose();
        }
      },
      { capability: 'screenModulation' },
    ),
    check(
      'effects.screenModulation.pixels',
      'a marker in the band draws, one outside it dims to the floor, a radius of 0 dims every one',
      async (h, r) => {
        await overAustin(h, r);
        const set = r.draw.icons({ id: 'conf:swept-pixels' });
        const pos = h.toEcef({
          lon: AUSTIN.lon + 0.004,
          lat: AUSTIN.lat,
          height: 0,
        });
        const icon = { id: 'one', pos, image: DOT, size: [24, 24] };
        let s = null;
        // The patch of the frame around the icon, once what is set has drawn.
        const patch = async () => {
          await drawn(h, r, 3);
          await settled(r);
          r.frame.renderNow();
          return r.readPixels({
            crop: {
              x: Math.round(s.x) - 6,
              y: Math.round(s.y) - 6,
              width: 13,
              height: 13,
            },
          }).data;
        };
        // How many pixels of `a` differ clearly from `b`.
        const differ = (a, b) => {
          let n = 0;
          for (let i = 0; i < a.length; i += 4)
            if (
              Math.abs(a[i] - b[i]) +
                Math.abs(a[i + 1] - b[i + 1]) +
                Math.abs(a[i + 2] - b[i + 2]) >
              90
            )
              n++;
          return n;
        };
        // The sweep stands 100 px left of the icon. Pointing right, the
        // band's middle on the icon's bearing, it covers it; pointing left,
        // not.
        const sector = (extra) => ({
          center: { x: s.x - 100, y: s.y },
          angle: Math.PI / 2 - 0.3,
          width: 0.6,
          radius: 400,
          floor: 0,
          strength: 0,
          color: '#ffffff',
          ...extra,
        });
        try {
          set.set([icon]);
          await drawn(h, r);
          await settled(r);
          s = r.query.project(pos);
          ok(s, 'the icon projects');
          const shown = await patch();
          set.set([]);
          const empty = await patch();
          const drawnPixels = differ(shown, empty);
          if (h.pixels === false)
            return { skip: 'this harness reads no drawn pixels' };
          ok(drawnPixels >= 20, 'the icon draws into pixels');
          set.set([icon]);
          r.effects.screenModulation(sector());
          ok(
            differ(await patch(), empty) >= drawnPixels * 0.8,
            'in the band the icon draws',
          );
          r.effects.screenModulation(sector({ angle: Math.PI * 1.5 }));
          ok(
            differ(await patch(), empty) <= drawnPixels * 0.1,
            'outside the band it dims to a floor of 0',
          );
          r.effects.screenModulation(sector({ radius: 0 }));
          ok(
            differ(await patch(), empty) <= drawnPixels * 0.1,
            'a radius of 0 dims it to the floor',
          );
          r.effects.screenModulation(sector({ radius: 0, floor: 1 }));
          ok(
            differ(await patch(), empty) >= drawnPixels * 0.8,
            'at a floor of 1 nothing dims',
          );
          r.effects.screenModulation(sector({ strength: 1, color: '#ff0000' }));
          const tinted = await patch();
          let red = 0;
          for (let i = 0; i < tinted.length; i += 4)
            if (tinted[i] > 180 && tinted[i + 1] < 90 && tinted[i + 2] < 90)
              red++;
          ok(red >= drawnPixels * 0.5, 'a strength of 1 draws it in `color`');
          r.effects.screenModulation(null);
          ok(
            differ(await patch(), shown) <= drawnPixels * 0.1,
            'cleared, it draws as before',
          );
        } finally {
          r.effects.screenModulation(null);
          set.dispose();
        }
      },
      { capability: 'screenModulation' },
    ),
    check(
      'effects.withoutScreenModulation',
      'without screenModulation the effects port has no such member',
      async (h) => {
        const r = await h.create({
          viewport: SCRIPT_VIEWPORT,
          capabilities: CAPABILITIES.filter((c) => c !== 'screenModulation'),
        });
        if (!r) return { skip: 'this harness cannot drop capabilities' };
        try {
          equal(r.effects.screenModulation, undefined, 'no member');
          ok(
            !r.effects.diagnostics().passes.includes('screenModulation'),
            'no pass',
          );
        } finally {
          r.destroy();
        }
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
        // Measured from the wall time it was drawn at: a first frame may
        // come a while after the set was made.
        const late = (h.wallTime(r) - w) / 10000;
        ok(pickAt(along(0.5 + late)), 'drawn delayMs behind wall time');
        ok(!pickAt(along(0.7 + late)), 'not at wall time');
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
      'draw.motion.shared',
      'icons are drawn where the shared motion evaluator puts them',
      async (h, r) => {
        await overAustin(h, r, 30000);
        const t0 = r.frame.time();
        const fix = h.toEcef({ ...AUSTIN, height: 9000 });
        const to = h.toEcef({
          ...AUSTIN,
          lon: AUSTIN.lon + 0.03,
          height: 9000,
        });
        const items = [
          {
            id: 'arc',
            pos: fix,
            image: DOT,
            size: [16, 16],
            motion: {
              kind: 'arc',
              fix,
              t0,
              speedMps: 180,
              trackDeg: 200,
              turnRateDps: -2.5,
              climbMps: 100,
              minDtS: -20,
              maxDtS: 15,
            },
          },
          {
            id: 'step',
            pos: fix,
            image: DOT,
            size: [16, 16],
            // No span: at `from` until t0, at `to` after it.
            motion: { kind: 'lerp', from: fix, to, t0: t0 + 4000, t1: t0 },
          },
        ];
        const set = r.draw.icons({
          id: 'conf:shared',
          motionClock: { kind: 'scene' },
        });
        set.set(items);
        const find = (id, p) => {
          const s = r.query.project(p);
          return r.query
            .drillPick(s.x, s.y)
            .find((x) => x.set === 'conf:shared' && x.id === id);
        };
        const apart = (a, b) => {
          const sa = r.query.project(a);
          const sb = r.query.project(b);
          return Math.hypot(sa.x - sb.x, sa.y - sb.y);
        };
        // Each sample against where the item is at another of them: the
        // evaluator's answer, and not the other.
        const samples = [-30, 9, 40];
        for (const [k, dtS] of samples.entries()) {
          const t = t0 + dtS * 1000;
          const other = t0 + samples[(k + 1) % samples.length] * 1000;
          r.frame.setTime(t);
          await drawn(h, r);
          for (const item of items) {
            const want = iconPosition(item, t);
            const elsewhere = iconPosition(item, other);
            if (apart(want, elsewhere) < 20) continue;
            const hit = find(item.id, want);
            ok(hit, `${item.id} at ${dtS} s: picked there`);
            if (hit?.position)
              nearVec(hit.position, want, 50, `${item.id} at ${dtS} s: there`);
            ok(
              !find(item.id, elsewhere),
              `${item.id} at ${dtS} s: not elsewhere`,
            );
          }
        }
        set.dispose();
      },
      { capability: 'motionSegments' },
    ),
    check(
      'draw.displayRange',
      'one thing drawn near and far in two sets shows each over its own range',
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
              displayRange: nearRange,
            },
          ]);
          far.set([
            {
              id: 'a',
              pos,
              image: DOT,
              size: [20, 20],
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
          equal(hits[0]?.id, 'a', `at ${height} m the hit names the item`);
        }
        members([0, 100000], [1000, Infinity]);
        await drawn(h, r);
        deepEqual(
          shown()
            .map((x) => x.set)
            .sort(),
          ['conf:lod-far', 'conf:lod-near'],
          'overlapping ranges show both',
        );
        near.dispose();
        far.dispose();
      },
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
        // A generated slot too, where there is a canvas that draws in 2D.
        const canvas = globalThis.document?.createElement('canvas');
        const g = canvas?.getContext?.('2d');
        const slots = { svg: ['dot', DOT, AUSTIN.lon - 0.002] };
        if (g) {
          canvas.width = canvas.height = 16;
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
      'draw.icons.images',
      'icons draw every kind of image (URL, SVG, blob, keyed canvas and an atlas slot of each), on billboards and moving alike, and are picked',
      async (h, r) => {
        await overAustin(h, r);
        const kinds = {
          url: PIXEL_PNG,
          svg: DOT,
          blob: { blob: new Blob([DOT.svg], { type: 'image/svg+xml' }) },
        };
        const canvas = globalThis.document?.createElement('canvas');
        const g = canvas?.getContext?.('2d');
        if (g) {
          canvas.width = canvas.height = 16;
          g.fillStyle = '#fff';
          g.fillRect(0, 0, 16, 16);
          kinds.canvas = { canvas, key: 'conf:images-square' };
        }
        r.draw.atlas('conf:images', kinds);
        const images = Object.entries(kinds).flatMap(([kind, image]) => [
          [kind, image],
          [`atlas-${kind}`, { atlas: 'conf:images', slot: kind }],
        ]);
        // Two sets: still icons, and a set that recedes (drawn as moving
        // icons are, where a renderer draws them apart).
        const rows = [
          ['still', {}, AUSTIN.lat + 0.004],
          ['receding', { recede: {} }, AUSTIN.lat - 0.004],
        ];
        const at = (i, lat) =>
          h.toEcef({
            lon: AUSTIN.lon + (i - (images.length - 1) / 2) * 0.0012,
            lat,
            height: 0,
          });
        const sets = rows.map(([name, extra, lat]) => {
          const set = r.draw.icons({ id: `conf:images-${name}`, ...extra });
          set.set(
            images.map(([id, image], i) => ({
              id,
              pos: at(i, lat),
              image,
              size: [20, 20],
            })),
          );
          return set;
        });
        await drawn(h, r);
        await settled(r);
        await drawn(h, r);
        for (const [name, , lat] of rows)
          images.forEach(([id], i) => {
            const s = r.query.project(at(i, lat));
            ok(s, `${name} ${id} projects`);
            const hit = r.query.pick(s.x, s.y);
            deepEqual(
              [hit?.set, hit?.id],
              [`conf:images-${name}`, id],
              `${name} ${id} drawn and picked`,
            );
          });
        for (const set of sets) set.dispose();
      },
    ),
    check(
      'draw.sets.recede',
      'icon and model sets take `recede` and change it live: their items, near the eye, are drawn and picked whether the set recedes or not',
      async (h, r) => {
        await overAustin(h, r);
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        const icons = r.draw.icons({ id: 'conf:recede-icons', recede: {} });
        icons.set([{ id: 'one', pos, image: DOT, size: [24, 24], focus: 0.5 }]);
        const models = r.draw.models?.({
          id: 'conf:recede-models',
          recede: { alphaFloor: 0.5 },
        });
        try {
          await drawn(h, r);
          await settled(r);
          const s = r.query.project(pos);
          ok(s, 'the icon projects');
          const picked = () => r.query.pick(s.x, s.y);
          deepEqual(
            [picked()?.set, picked()?.id],
            ['conf:recede-icons', 'one'],
            'a receding icon near the eye is drawn and picked',
          );
          for (const recede of [null, { scaleFloor: 0.6 }, {}]) {
            icons.setOptions({ recede });
            models?.setOptions({ recede });
            await drawn(h, r);
            equal(
              picked()?.id,
              'one',
              `drawn and picked with recede ${JSON.stringify(recede)}`,
            );
          }
        } finally {
          icons.dispose();
          models?.dispose();
        }
      },
    ),
    check(
      'draw.sets.recede.models',
      'a model set that recedes composes each model’s focus as `RecedeSpec` says, and takes a new `recede` live: near the eye a model at focus 1 draws at full strength, at focus 0.25 faded, and a combined floor of 1 brings it back',
      async (h, r) => {
        if (!h.assets?.model) return { skip: 'no model asset in this harness' };
        await overAustin(h, r);
        const set = r.draw.models({ id: 'conf:recede-models', recede: {} });
        const ready = [];
        set.on('ready', (id) => ready.push(id));
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        const model = (focus) => ({
          id: 'm',
          pos,
          url: h.assets.model,
          orientation: { heading: 0, pitch: 0, roll: 0 },
          minPixelSize: 160,
          environmentMap: false,
          shading: 'unlit',
          tint: '#ff0000',
          colorBlend: { mode: 'replace' },
          focus,
        });
        try {
          set.set([model(1)]);
          for (let i = 0; i < 600 && !ready.length; i++) await drawn(h, r, 1);
          deepEqual(ready, ['m'], 'ready');
          const s = r.query.project(pos);
          // How many pixels of a patch at the model's centre are red.
          const red = async () => {
            await drawn(h, r, 3);
            await settled(r);
            r.frame.renderNow();
            const image = r.readPixels({
              crop: {
                x: Math.round(s.x) - 4,
                y: Math.round(s.y) - 4,
                width: 9,
                height: 9,
              },
            });
            let n = 0;
            for (let i = 0; i < image.data.length; i += 4) {
              const [r0, g, b] = image.data.subarray(i, i + 3);
              if (r0 > 180 && g < 70 && b < 70) n++;
            }
            return n;
          };
          ok((await red()) >= 40, 'near the eye, focus 1: full strength');
          set.upsert([model(0.25)]);
          ok((await red()) < 10, 'focus 0.25 fades it');
          set.setOptions({ recede: { combinedAlphaFloor: 1 } });
          ok((await red()) >= 40, 'a combined floor of 1 holds it, live');
          equal(r.query.pick(s.x, s.y)?.set, set.id, 'and it is picked');
          deepEqual(ready, ['m'], 'without loading again');
        } finally {
          set.dispose();
        }
      },
      { capability: 'models', bareSky: true },
    ),
    clusterCheck(false),
    clusterCheck(true),
    check(
      'draw.icons.update',
      'an upserted icon keeps drawing, as it now is, from the next frame: picked at its new size with its new meta, even while a new image loads; a removed one is gone',
      async (h, r) => {
        await overAustin(h, r);
        const set = r.draw.icons({ id: 'conf:icons-update' });
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        const icon = (extra = {}) => ({
          id: 'one',
          pos,
          image: DOT,
          size: [16, 16],
          meta: { n: 1 },
          ...extra,
        });
        set.set([icon()]);
        await drawn(h, r);
        await settled(r);
        const s = r.query.project(pos);
        ok(s, 'the icon projects');
        equal(r.query.pick(s.x, s.y)?.id, 'one', 'drawn and picked');
        const off = () => r.query.pick(s.x + 20, s.y);
        ok(off()?.set !== 'conf:icons-update', 'not picked 20 px off');
        // Not settled again: a restyle keeps drawing, with no reload.
        set.upsert([
          icon({ size: [64, 64], color: '#00ff00', meta: { n: 2 } }),
        ]);
        await drawn(h, r);
        const hit = off();
        equal(hit?.id, 'one', 'picked at its new size in the next frame');
        deepEqual(hit?.meta, { n: 2 }, 'with its new meta');
        // A new image keeps the icon drawn while it loads.
        set.upsert([
          icon({
            size: [64, 64],
            meta: { n: 3 },
            image: { svg: DOT.svg.replace('#fff', '#ff0') },
          }),
        ]);
        await drawn(h, r);
        equal(off()?.id, 'one', 'a new image: still drawn in the next frame');
        await settled(r);
        deepEqual(off()?.meta, { n: 3 }, 'and drawn with it once loaded');
        set.remove(['one']);
        await drawn(h, r);
        const gone = r.query.pick(s.x, s.y);
        ok(!gone || gone.set !== 'conf:icons-update', 'removed: not picked');
        set.dispose();
      },
    ),
    check(
      'draw.icons.distance',
      'icons scale, fade and show by eye distance',
      async (h, r) => {
        await overAustin(h, r);
        const set = r.draw.icons({ id: 'conf:icons-distance' });
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        const icon = (extra = {}) => ({
          id: 'one',
          pos,
          image: DOT,
          size: [16, 16],
          ...extra,
        });
        set.set([icon()]);
        await drawn(h, r);
        await settled(r);
        const s = r.query.project(pos);
        ok(s, 'the icon projects');
        const at = (dx) => r.query.pick(s.x + dx, s.y);
        const mine = (hit) => hit?.set === 'conf:icons-distance';
        ok(mine(at(0)) && !mine(at(20)), 'drawn at its size');
        // The eye is 2 km off: held at the curve's near value.
        const curve = (value) => ({
          near: 1e4,
          nearValue: value,
          far: 1e7,
          farValue: value,
        });
        set.upsert([icon({ scaleByDistance: curve(4) })]);
        await drawn(h, r);
        await settled(r);
        ok(mine(at(20)), 'scaled up by distance: picked 20 px off');
        set.upsert([icon({ fadeByDistance: curve(0) })]);
        await drawn(h, r);
        ok(!mine(at(0)), 'faded out by distance: not drawn');
        set.upsert([icon({ displayRange: [0, 100] })]);
        await drawn(h, r);
        ok(!mine(at(0)), 'out of its display range: not drawn');
        set.upsert([icon({ displayRange: [0, 1e6] })]);
        await drawn(h, r);
        ok(mine(at(0)), 'in its display range: drawn');
        set.dispose();
      },
    ),
    check(
      'draw.icons.offsetTurn',
      'an icon offset shrinks with it when it says so, and one turned by an axis turns by its rotation too',
      async (h, r) => {
        await overAustin(h, r);
        const set = r.draw.icons({ id: 'conf:icons-offset-turn' });
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        const icon = (extra = {}) => ({
          id: 'one',
          pos,
          image: DOT,
          size: [16, 16],
          ...extra,
        });
        const show = async (extra) => {
          set.set([icon(extra)]);
          await drawn(h, r);
          await settled(r);
          await drawn(h, r);
        };
        await show();
        const s = r.query.project(pos);
        ok(s, 'the icon projects');
        const mine = (x, y) =>
          r.query
            .drillPick(x, y)
            .some(
              (hit) => hit.set === 'conf:icons-offset-turn' && hit.id === 'one',
            );
        // The eye is 2 km off: held at the curve's near value, half size.
        const half = { near: 1e4, nearValue: 0.5, far: 1e7, farValue: 0.5 };
        const offset = { x: 40, y: 0 };
        await show({ scaleByDistance: half, pixelOffset: offset });
        ok(
          mine(s.x + 40, s.y) && !mine(s.x + 20, s.y),
          'halved by distance, its offset is not',
        );
        await show({
          scaleByDistance: half,
          pixelOffset: offset,
          offsetScalesByDistance: true,
        });
        ok(
          mine(s.x + 20, s.y) && !mine(s.x + 40, s.y),
          'halved by distance with its offset',
        );
        // Looking north, an up along east turns it a quarter clockwise; a
        // quarter turn counter-clockwise on screen lays it down again.
        const east = h.toEcef({
          lon: AUSTIN.lon + 0.01,
          lat: AUSTIN.lat,
          height: 0,
        });
        const alignedAxis = {
          x: east.x - pos.x,
          y: east.y - pos.y,
          z: east.z - pos.z,
        };
        await show({ size: [64, 8], rotationMode: 'axis', alignedAxis });
        ok(
          mine(s.x, s.y + 24) && !mine(s.x + 24, s.y),
          'its up along east stands it up',
        );
        await show({
          size: [64, 8],
          rotationMode: 'axis',
          alignedAxis,
          rotation: Math.PI / 2,
        });
        ok(
          mine(s.x + 24, s.y) && !mine(s.x, s.y + 24),
          'then a quarter turn on screen lays it down',
        );
        set.dispose();
      },
    ),
    check(
      'draw.motion.look',
      'moving icons draw offset, anchored, turned, clamped, faded and ranged as icons do',
      async (h, r) => {
        await overAustin(h, r);
        const set = r.draw.icons({
          id: 'conf:motion-look',
          motionClock: { kind: 'scene' },
        });
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        const icon = (extra = {}) => ({
          id: 'one',
          pos,
          image: DOT,
          size: [16, 16],
          motion: { kind: 'hold' },
          ...extra,
        });
        const mine = (x, y) =>
          r.query
            .drillPick(x, y)
            .some((hit) => hit.set === 'conf:motion-look' && hit.id === 'one');
        const show = async (extra) => {
          set.set([icon(extra)]);
          await drawn(h, r);
          await settled(r);
          await drawn(h, r);
        };
        await show();
        const s = r.query.project(pos);
        ok(s, 'the icon projects');
        ok(mine(s.x, s.y), 'drawn where it is');
        await show({ pixelOffset: { x: 40, y: 0 } });
        ok(mine(s.x + 40, s.y) && !mine(s.x, s.y), 'offset 40 px right');
        await show({ anchor: 'bottom', size: [16, 48] });
        ok(
          mine(s.x, s.y - 36) && !mine(s.x, s.y + 12),
          'anchored by its bottom: above its position',
        );
        // Long and flat; a quarter turn stands it up.
        await show({ size: [64, 8] });
        ok(mine(s.x + 24, s.y) && !mine(s.x, s.y + 24), 'unturned, it is wide');
        await show({
          size: [64, 8],
          rotationMode: 'screen',
          rotation: Math.PI / 2,
        });
        ok(
          mine(s.x, s.y + 24) && !mine(s.x + 24, s.y),
          'a quarter turn on screen stands it up',
        );
        // Looking north, an up along east turns it a quarter clockwise.
        const east = h.toEcef({
          lon: AUSTIN.lon + 0.01,
          lat: AUSTIN.lat,
          height: 0,
        });
        await show({
          size: [64, 8],
          rotationMode: 'axis',
          alignedAxis: {
            x: east.x - pos.x,
            y: east.y - pos.y,
            z: east.z - pos.z,
          },
        });
        ok(
          mine(s.x, s.y + 24) && !mine(s.x + 24, s.y),
          'its up along east stands it up',
        );
        // Off to the east and a kilometre up, clamped: on the ground there.
        const where = { lon: AUSTIN.lon + 0.004, lat: AUSTIN.lat };
        const ground = r.query.project(h.toEcef({ ...where, height: 0 }));
        const raised = r.query.project(h.toEcef({ ...where, height: 1000 }));
        ok(
          ground && raised && Math.abs(raised.x - ground.x) > 30,
          'apart on screen',
        );
        await show({ pos: h.toEcef({ ...where, height: 1000 }) });
        ok(
          mine(raised.x, raised.y) && !mine(ground.x, ground.y),
          'absolute: up high',
        );
        await show({
          pos: h.toEcef({ ...where, height: 1000 }),
          height: 'clampGround',
        });
        ok(
          mine(ground.x, ground.y) && !mine(raised.x, raised.y),
          'clamped: on the ground',
        );
        // Moving between two such points, clamped: on the ground between.
        const lerpAt = (a, b, t) => ({
          x: a.x + (b.x - a.x) * t,
          y: a.y + (b.y - a.y) * t,
          z: a.z + (b.z - a.z) * t,
        });
        const west = { lon: AUSTIN.lon - 0.004, lat: AUSTIN.lat };
        const from = h.toEcef({ ...where, height: 1000 });
        const to = h.toEcef({ ...west, height: 1000 });
        const t0 = r.frame.time();
        r.frame.setTime(t0 + 2500);
        await show({
          pos: from,
          height: 'clampGround',
          motion: { kind: 'lerp', from, to, t0, t1: t0 + 10000 },
        });
        const quarter = r.query.project(
          lerpAt(
            h.toEcef({ ...where, height: 0 }),
            h.toEcef({ ...west, height: 0 }),
            0.25,
          ),
        );
        const up = r.query.project(lerpAt(from, to, 0.25));
        ok(
          mine(quarter.x, quarter.y) && !mine(up.x, up.y),
          'moving clamped: on the ground under it',
        );
        // The eye is 2 km off.
        const curve = (value) => ({
          near: 1e4,
          nearValue: value,
          far: 1e7,
          farValue: value,
        });
        await show({ fadeByDistance: curve(0) });
        ok(!mine(s.x, s.y), 'faded out by distance: not drawn');
        await show({ fadeByDistance: curve(1) });
        ok(mine(s.x, s.y), 'not faded: drawn');
        await show({ displayRange: [0, 100] });
        ok(!mine(s.x, s.y), 'out of its display range: not drawn');
        await show({ displayRange: [0, 1e6] });
        ok(mine(s.x, s.y), 'in its display range: drawn');
        set.dispose();
      },
      { capability: 'motionSegments' },
    ),
    check(
      'draw.lines.depthFail',
      'a line dashed behind the surface draws, moves in place and changes back to solid',
      async (h, r) => {
        await overAustin(h, r);
        const lines = r.draw.lines({ id: 'conf:line-dash' });
        const at = (dLon, height) =>
          h.toEcef({ lon: AUSTIN.lon + dLon, lat: AUSTIN.lat, height });
        const band = (height, extra = {}) => ({
          id: 'band',
          positions: [at(-0.002, 50), at(0.002, height)],
          widthPx: 3,
          mode: 'geodesic',
          style: { kind: 'dash', color: [1, 1, 0, 0.9], length: 16 },
          depthFail: { kind: 'dash', color: [0, 1, 1, 0.35], length: 16 },
          ...extra,
        });
        lines.set([band(-200)]);
        await drawn(h, r);
        equal(lines.size(), 1, 'held');
        lines.upsert([band(-100)]);
        await drawn(h, r);
        equal(lines.size(), 1, 'moved in place, not added');
        lines.upsert([
          band(-100, { depthFail: { kind: 'solid', color: [0, 1, 1, 0.35] } }),
        ]);
        await drawn(h, r);
        equal(lines.size(), 1, 'solid behind the surface again');
        lines.dispose();
      },
    ),
    check(
      'draw.lines.settled',
      'solid lines in space left unchanged for many frames still pick, hide, recolour and move in place',
      async (h, r) => {
        await overAustin(h, r);
        const at = (dLon, dLat, height = 300) =>
          h.toEcef({ lon: AUSTIN.lon + dLon, lat: AUSTIN.lat + dLat, height });
        const lines = r.draw.lines({ id: 'conf:line-settled' });
        const mine = (pos, id) => {
          const s = r.query.project(pos);
          return Boolean(
            s &&
            r.query
              .drillPick(s.x, s.y)
              .some((hit) => hit.set === 'conf:line-settled' && hit.id === id),
          );
        };
        const until = async (test) => {
          for (let i = 0; i < 300; i++) {
            await drawn(h, r, 1);
            if (test()) return true;
          }
          return false;
        };
        const line = (id, dLat, extra = {}) => ({
          id,
          positions: [at(-0.003, dLat), at(0.003, dLat)],
          widthPx: 8,
          mode: '3d',
          style: { kind: 'solid', color: [1, 0.4, 0.1, 1] },
          ...extra,
        });
        lines.set([
          line('a', 0.002),
          line('b', -0.002, {
            style: { kind: 'solid', color: [0.1, 0.6, 1, 0.6] },
          }),
        ]);
        ok(await until(() => mine(at(0, 0.002), 'a')), 'drawn');
        // Long enough for a renderer to draw unchanged lines another way.
        await drawn(h, r, 120);
        ok(mine(at(0, 0.002), 'a'), 'still picks once settled');
        ok(mine(at(0, -0.002), 'b'), 'a translucent one too');
        lines.upsert([line('a', 0.002, { show: false })]);
        await drawn(h, r);
        ok(!mine(at(0, 0.002), 'a'), 'hidden in place');
        ok(mine(at(0, -0.002), 'b'), 'the other still drawn');
        lines.upsert([
          line('a', 0.002, {
            style: { kind: 'solid', color: [0.2, 1, 0.2, 1] },
          }),
        ]);
        ok(await until(() => mine(at(0, 0.002), 'a')), 'shown and recoloured');
        await drawn(h, r, 120);
        lines.upsert([line('b', -0.004)]);
        ok(
          await until(
            () => mine(at(0, -0.004), 'b') && !mine(at(0, -0.002), 'b'),
          ),
          'moved',
        );
        equal(lines.size(), 2, 'held');
        lines.dispose();
        await drawn(h, r);
        ok(!mine(at(0, 0.002), 'a'), 'gone with its set');
      },
    ),
    check(
      'draw.shapes.drapedRotation',
      'a draped rectangle with an image fill draws turned by its rotation, picks there, and hides in place',
      async (h, r) => {
        await overAustin(h, r);
        const at = (dLon, dLat = 0) =>
          h.toEcef({ lon: AUSTIN.lon + dLon, lat: AUSTIN.lat + dLat });
        const shapes = r.draw.shapes({ id: 'conf:overlay' });
        const mine = (pos) => {
          const s = r.query.project(pos);
          return Boolean(
            s &&
            r.query
              .drillPick(s.x, s.y)
              .some(
                (hit) => hit.set === 'conf:overlay' && hit.id === 'overlay',
              ),
          );
        };
        // Wide east to west; a quarter turn stands it north to south.
        const overlay = (rotation, extra = {}) => ({
          id: 'overlay',
          geometry: {
            kind: 'rectangle',
            rect: {
              west: AUSTIN.lon - 0.004,
              south: AUSTIN.lat - 0.001,
              east: AUSTIN.lon + 0.004,
              north: AUSTIN.lat + 0.001,
            },
            ...(rotation === undefined ? {} : { rotation }),
          },
          fill: { image: PIXEL_PNG },
          height: 'clampGround',
          ...extra,
        });
        const until = async (test) => {
          for (let i = 0; i < 300; i++) {
            await drawn(h, r, 1);
            if (test()) return true;
          }
          return false;
        };
        shapes.set([overlay(undefined)]);
        // A draped fill can reach the pick pass tile by tile, so wait for
        // both ends, as the turned case below waits for its own.
        ok(await until(() => mine(at(0))), 'unturned, it draws');
        ok(await until(() => mine(at(0.003))), 'unturned, it is wide');
        ok(!mine(at(0, 0.003)), 'unturned, it is not tall');
        shapes.set([overlay(Math.PI / 2)]);
        ok(
          await until(() => mine(at(0, 0.003)) && !mine(at(0.003))),
          'a quarter turn stands it north to south',
        );
        ok(mine(at(0)), 'turned about its centre');
        shapes.upsert([overlay(Math.PI / 2, { show: false })]);
        await drawn(h, r);
        ok(!mine(at(0)), 'hidden');
        shapes.upsert([overlay(Math.PI / 2)]);
        ok(await until(() => mine(at(0, 0.003))), 'shown again');
        equal(shapes.size(), 1, 'held');
        shapes.dispose();
        await drawn(h, r);
        ok(!mine(at(0)), 'gone with its set');
      },
    ),
    check(
      'draw.shapes.clamped',
      'clamped shapes of every kind draw and are picked: outlined, outline only (along its rim), extruded and walls',
      async (h, r) => {
        await overAustin(h, r, 3000);
        const shapes = r.draw.shapes({ id: 'conf:clamped-shapes' });
        const box = (dLon, dLat, d = 0.0012) => ({
          west: AUSTIN.lon + dLon - d,
          south: AUSTIN.lat + dLat - d,
          east: AUSTIN.lon + dLon + d,
          north: AUSTIN.lat + dLat + d,
        });
        shapes.set([
          {
            id: 'outlined',
            geometry: { kind: 'rectangle', rect: box(-0.004, 0.002) },
            fill: [1, 0, 0, 0.6],
            outline: '#ffffff',
            outlineWidth: 3,
            height: 'clampGround',
          },
          {
            id: 'rim',
            geometry: { kind: 'rectangle', rect: box(0.004, 0.002) },
            outline: '#00ff00',
            outlineWidth: 3,
            outlineOnly: true,
            height: 'clampGround',
          },
          {
            id: 'tower',
            geometry: {
              kind: 'ellipse',
              center: { lon: AUSTIN.lon - 0.004, lat: AUSTIN.lat - 0.003 },
              semiMajor: 120,
              semiMinor: 120,
            },
            fill: '#0000ff',
            outline: '#ffffff',
            extrudeHeight: 300,
            height: 'clampGround',
          },
          {
            id: 'fence',
            geometry: {
              kind: 'wall',
              positions: [
                {
                  lon: AUSTIN.lon + 0.003,
                  lat: AUSTIN.lat - 0.003,
                  height: 40,
                },
                {
                  lon: AUSTIN.lon + 0.005,
                  lat: AUSTIN.lat - 0.003,
                  height: 40,
                },
              ],
            },
            fill: '#ffff00',
            height: 'clampGround',
          },
        ]);
        equal(shapes.size(), 4, 'every kind is taken');
        await settled(r);
        await drawn(h, r);
        const picked = (id, lon, lat, height) => {
          const s = r.query.project(h.toEcef({ lon, lat, height }));
          ok(s, `${id} projects`);
          ok(
            r.query
              .drillPick(s.x, s.y)
              .some(
                (hit) => hit.set === 'conf:clamped-shapes' && hit.id === id,
              ),
            `${id} drawn and picked`,
          );
        };
        picked('outlined', AUSTIN.lon - 0.004, AUSTIN.lat + 0.002, 0);
        picked('tower', AUSTIN.lon - 0.004, AUSTIN.lat - 0.003, 300);
        // An outline-only shape is picked on its rim, its west edge here.
        picked('rim', AUSTIN.lon + 0.004 - 0.0012, AUSTIN.lat + 0.002, 0);
        // A wall, seen from the south a little above it, on its face.
        r.camera.setView({
          destination: {
            lon: AUSTIN.lon + 0.004,
            lat: AUSTIN.lat - 0.007,
            height: 120,
          },
          orientation: { heading: 0, pitch: -0.2, roll: 0 },
        });
        await h.frame(r);
        await settled(r);
        await drawn(h, r);
        picked('fence', AUSTIN.lon + 0.004, AUSTIN.lat - 0.003, 20);
        shapes.dispose();
      },
    ),
    check(
      'draw.shapes.lit',
      'a lit extruded shape shades its walls by the light, as the renderer shades its own solids: the wall facing the eye brighter than half its colour, its top unlike its wall',
      async (h, r) => {
        if (h.pixels === false) return { skip: 'reads pixels' };
        r.globe.setGlobeVisible(false);
        // Shown again however the check ends.
        try {
          const dLat = 150 / 111320;
          const dLon = dLat / Math.cos((AUSTIN.lat * Math.PI) / 180);
          const shapes = r.draw.shapes({ id: 'conf:lit' });
          shapes.set([
            {
              id: 'block',
              geometry: {
                kind: 'polygon',
                rings: [
                  [
                    { lon: AUSTIN.lon - dLon, lat: AUSTIN.lat - dLat },
                    { lon: AUSTIN.lon + dLon, lat: AUSTIN.lat - dLat },
                    { lon: AUSTIN.lon + dLon, lat: AUSTIN.lat + dLat },
                    { lon: AUSTIN.lon - dLon, lat: AUSTIN.lat + dLat },
                  ],
                ],
              },
              fill: '#808080',
              extrudeHeight: 300,
              height: 'absolute',
            },
          ]);
          // 3.3 km south, 1.5 km up, looking north and down.
          r.camera.setView({
            destination: {
              lon: AUSTIN.lon,
              lat: AUSTIN.lat - 3300 / 111320,
              height: 1500,
            },
            orientation: { heading: 0, pitch: (-35 * Math.PI) / 180, roll: 0 },
          });
          await h.frame(r);
          await settled(r);
          await drawn(h, r);
          const grey = (lon, lat, height) => {
            const s = r.query.project(h.toEcef({ lon, lat, height }));
            ok(s, 'projects');
            const { data } = r.readPixels({
              crop: {
                x: Math.round(s.x) - 2,
                y: Math.round(s.y) - 2,
                width: 5,
                height: 5,
              },
            });
            let sum = 0;
            for (let i = 0; i < data.length; i += 4)
              sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
            return sum / (data.length / 4);
          };
          // A little in from the south face's middle, and the top's middle.
          const wall = grey(AUSTIN.lon, AUSTIN.lat - dLat * 0.98, 150);
          const top = grey(AUSTIN.lon, AUSTIN.lat, 300);
          ok(
            wall > 85,
            `the wall facing the eye is lit, brighter than half its colour (${Math.round(wall)})`,
          );
          ok(
            Math.abs(top - wall) > 10,
            `its top and its wall shade differently (${Math.round(top)}, ${Math.round(wall)})`,
          );
          shapes.dispose();
        } finally {
          r.globe.setGlobeVisible(true);
        }
      },
      { capability: 'globeVisibility' },
    ),
    check(
      'draw.shapes.resize',
      'a clamped ellipse whose radius alone is upserted draws at the new radius, growing and shrinking',
      async (h, r) => {
        const shapes = r.draw.shapes({ id: 'conf:rings' });
        const ring = (radius) => ({
          id: 'ring',
          geometry: {
            kind: 'ellipse',
            center: { lon: AUSTIN.lon, lat: AUSTIN.lat },
            semiMajor: radius,
            semiMinor: radius,
          },
          fill: [0.5, 0.9, 1, 0.6],
          height: 'clampGround',
        });
        // Metres east of the centre, at its latitude.
        const east = (m) =>
          h.toEcef({
            lon:
              AUSTIN.lon +
              m / (111320 * Math.cos((AUSTIN.lat * Math.PI) / 180)),
            lat: AUSTIN.lat,
          });
        const covers = (m) => {
          const s = r.query.project(east(m));
          return Boolean(
            s &&
            r.query
              .drillPick(s.x, s.y)
              .some((hit) => hit.set === 'conf:rings' && hit.id === 'ring'),
          );
        };
        const until = async (test) => {
          for (let i = 0; i < 300; i++) {
            await drawn(h, r, 1);
            if (test()) return true;
          }
          return false;
        };
        await overAustin(h, r, 4000);
        shapes.set([ring(200)]);
        ok(
          await until(() => covers(150) && !covers(260)),
          'at 200 m it reaches 150 m, not 260 m',
        );
        shapes.upsert([ring(400)]);
        ok(
          await until(() => covers(300) && !covers(460)),
          'at 400 m it reaches 300 m, not 460 m',
        );
        shapes.upsert([ring(200)]);
        ok(await until(() => covers(150) && !covers(260)), 'back at 200 m');
        shapes.dispose();
        await drawn(h, r);
        ok(!covers(0), 'gone with its set');
      },
    ),
    check(
      'draw.lines.styles',
      'flow lines draw draped and in space, and a line with a depth-fail colour moves every frame, without stopping the frame or picks',
      async (h, r) => {
        await overAustin(h, r);
        const lines = r.draw.lines({ id: 'conf:line-styles' });
        const at = (dLon, height = 0) =>
          h.toEcef({ lon: AUSTIN.lon + dLon, lat: AUSTIN.lat, height });
        const flow = {
          kind: 'flow',
          color: [0.2, 0.8, 1, 0.95],
          repeat: 8,
          duty: 0.5,
          speed: 1,
        };
        const head = (height) => ({
          id: 'head',
          positions: [at(-0.002, 50), at(0.002, height)],
          widthPx: 3,
          mode: '3d',
          style: { kind: 'solid', color: '#ff00ff' },
          depthFail: { kind: 'solid', color: [1, 0, 1, 0.45] },
        });
        lines.set([
          {
            id: 'route',
            positions: [at(-0.003), at(0), at(0.003)],
            widthPx: 9,
            mode: 'draped',
            clampTo: 'both',
            style: flow,
          },
          {
            id: 'air',
            positions: [at(-0.003, 200), at(0.003, 200)],
            widthPx: 4,
            mode: '3d',
            style: flow,
          },
          head(100),
        ]);
        equal(lines.size(), 3, 'every line held');
        for (let i = 0; i < 4; i++) {
          lines.upsert([head(100 + 50 * i)]);
          await drawn(h, r, 1);
        }
        equal(lines.size(), 3, 'moved in place, not added');
        lines.upsert([{ ...head(300), show: false }]);
        await drawn(h, r);
        const points = r.draw.points({ id: 'conf:line-styles-points' });
        const pos = at(0, 0);
        points.set([{ id: 'p', pos, pixelSize: 16, color: '#ff0000' }]);
        await drawn(h, r);
        const s = r.query.project(pos);
        ok(s, 'the point projects');
        equal(
          r.query
            .drillPick(s.x, s.y)
            .find((hit) => hit.set === 'conf:line-styles-points')?.id,
          'p',
          'picks still find what is drawn among the lines',
        );
        lines.clear();
        await drawn(h, r);
        equal(lines.size(), 0, 'cleared');
        points.dispose();
        lines.dispose();
      },
    ),
    check(
      'draw.lines.outline',
      'a solid line’s outline is `widthPx` in all, half on each side, inside the line’s width',
      async (h, r) => {
        await overAustin(h, r);
        const lines = r.draw.lines({ id: 'conf:line-outline' });
        const at = (dLon) =>
          h.toEcef({ lon: AUSTIN.lon + dLon, lat: AUSTIN.lat, height: 200 });
        // 20 px wide with an outline of 8: 4 px of red each side of 12 px
        // of green. Read as 8 px each side, it would leave 4 px of green.
        lines.set([
          {
            id: 'l',
            positions: [at(-0.004), at(0.004)],
            widthPx: 20,
            mode: '3d',
            style: {
              kind: 'solid',
              color: '#00ff00',
              outline: { color: '#ff0000', widthPx: 8 },
            },
          },
        ]);
        await drawn(h, r);
        await settled(r);
        r.frame.renderNow();
        const s = r.query.project(at(0));
        ok(s, 'the line projects');
        const half = 30;
        const image = r.readPixels({
          crop: {
            x: Math.round(s.x) - 2,
            y: Math.round(s.y) - half,
            width: 5,
            height: 2 * half + 1,
          },
        });
        // The middle column, top to bottom: r(ed), g(reen) or - (neither).
        let column = '';
        for (let row = 0; row < image.height; row++) {
          const i = (row * image.width + 2) * 4;
          const [red, green, blue] = image.data.slice(i, i + 3);
          column +=
            red > 160 && green < 100 && blue < 100
              ? 'r'
              : green > 160 && red < 100 && blue < 100
                ? 'g'
                : '-';
        }
        lines.dispose();
        if (h.pixels === false)
          return { skip: 'this harness reads no drawn pixels' };
        const runs = column.match(/r+|g+/g) ?? [];
        const sides = runs.filter((run) => run[0] === 'r');
        const core = runs.find((run) => run[0] === 'g') ?? '';
        equal(sides.length, 2, `an outline each side (${column})`);
        for (const side of sides)
          ok(
            side.length >= 3 && side.length <= 5,
            `4 px of outline each side, not ${side.length} (${column})`,
          );
        ok(
          core.length >= 10 && core.length <= 14,
          `12 px of line between them, not ${core.length} (${column})`,
        );
      },
    ),
    check(
      'draw.sets.blend',
      'a set’s blend draws its items as it says, changed live: none blends translucent items; opaque ignores alpha; translucent blends; additive adds colour, still behind what is nearer',
      async (h, r) => {
        if (h.pixels === false)
          return { skip: 'this harness reads no drawn pixels' };
        await overAustin(h, r);
        const rect = (dLon, dLat, d) => ({
          west: AUSTIN.lon + dLon - d,
          south: AUSTIN.lat + dLat - d,
          east: AUSTIN.lon + dLon + d,
          north: AUSTIN.lat + dLat + d,
        });
        // Green under it all; blue nearer the eye over the second spot.
        const under = r.draw.shapes({ id: 'conf:blend-under' });
        under.set([
          {
            id: 'green',
            geometry: { kind: 'rectangle', rect: rect(0, 0, 0.003), height: 0 },
            fill: '#00ff00',
            height: 'absolute',
          },
          {
            id: 'blue',
            geometry: {
              kind: 'rectangle',
              rect: rect(0.0015, 0, 0.0004),
              height: 300,
            },
            fill: '#0000ff',
            height: 'absolute',
          },
        ]);
        const spotA = h.toEcef({ ...AUSTIN, height: 50 });
        const spotB = h.toEcef({
          lon: AUSTIN.lon + 0.0015,
          lat: AUSTIN.lat,
          height: 50,
        });
        const pixel = (pos) => {
          r.frame.renderNow();
          const s = r.query.project(pos);
          const image = r.readPixels({
            crop: {
              x: Math.round(s.x) - 1,
              y: Math.round(s.y) - 1,
              width: 3,
              height: 3,
            },
          });
          const i = (1 * image.width + 1) * 4;
          return [...image.data.slice(i, i + 3)];
        };
        const kinds = {
          points: (alpha) => [
            { id: 'a', pos: spotA, pixelSize: 24, color: [1, 0, 0, alpha] },
            { id: 'b', pos: spotB, pixelSize: 24, color: [1, 0, 0, alpha] },
          ],
          icons: (alpha) => [
            {
              id: 'a',
              pos: spotA,
              image: SQUARE,
              size: [24, 24],
              color: [1, 0, 0, alpha],
            },
            {
              id: 'b',
              pos: spotB,
              image: SQUARE,
              size: [24, 24],
              color: [1, 0, 0, alpha],
            },
          ],
          lines: (alpha) => [
            {
              id: 'l',
              positions: [
                h.toEcef({
                  lon: AUSTIN.lon - 0.001,
                  lat: AUSTIN.lat,
                  height: 50,
                }),
                h.toEcef({
                  lon: AUSTIN.lon + 0.0025,
                  lat: AUSTIN.lat,
                  height: 50,
                }),
              ],
              widthPx: 24,
              mode: '3d',
              style: { kind: 'solid', color: [1, 0, 0, alpha] },
            },
          ],
          shapes: (alpha) =>
            [
              ['a', 0],
              ['b', 0.0015],
            ].map(([id, dLon]) => ({
              id,
              geometry: {
                kind: 'rectangle',
                rect: rect(dLon, 0, 0.0002),
                height: 50,
              },
              fill: [1, 0, 0, alpha],
              height: 'absolute',
            })),
        };
        await drawn(h, r);
        await settled(r);
        const [, green] = pixel(spotA);
        ok(green > 150, `the green under it draws (${green})`);
        const show = (rgb) => `(${rgb.join(', ')})`;
        try {
          for (const [kind, items] of Object.entries(kinds)) {
            const set = r.draw[kind]({ id: `conf:blend-${kind}` });
            try {
              set.set(items(0.5));
              await drawn(h, r);
              await settled(r);
              let a = pixel(spotA);
              ok(
                a[0] > 60 && a[1] > 40 && a[1] < green - 30,
                `${kind}, no blend: half red over green ${show(a)}`,
              );
              set.setOptions({ blend: 'opaque' });
              await drawn(h, r);
              a = pixel(spotA);
              ok(
                a[0] > 150 && a[1] < 60,
                `${kind}, opaque: red, its alpha ignored ${show(a)}`,
              );
              set.setOptions({ blend: 'translucent' });
              await drawn(h, r);
              a = pixel(spotA);
              ok(
                a[0] > 60 && a[1] > 40 && a[1] < green - 30,
                `${kind}, translucent: half red over green ${show(a)}`,
              );
              set.setOptions({ blend: 'additive' });
              await drawn(h, r);
              a = pixel(spotA);
              ok(
                a[0] > 60 && a[1] > green - 30,
                `${kind}, additive: red added to green ${show(a)}`,
              );
              const b = pixel(spotB);
              ok(
                b[0] < 60 && b[2] > 150,
                `${kind}, additive: behind the nearer blue ${show(b)}`,
              );
              set.set(items(1));
              set.setOptions({ blend: 'translucent' });
              await drawn(h, r);
              a = pixel(spotA);
              ok(
                a[0] > 150 && a[1] < 60,
                `${kind}, translucent at alpha 1: red ${show(a)}`,
              );
            } finally {
              set.dispose();
            }
          }
        } finally {
          under.dispose();
        }
      },
    ),
    check(
      'draw.lines.drape',
      'draped glow, dash and arrow lines draw and pick; a revealed line draws only its first part; a draped line and a clamped point that move every frame are drawn where they now are in the next frame',
      async (h, r) => {
        await overAustin(h, r);
        const at = (dLon, dLat = 0) =>
          h.toEcef({ lon: AUSTIN.lon + dLon, lat: AUSTIN.lat + dLat });
        const lines = r.draw.lines({ id: 'conf:line-drape' });
        const mine = (pos, id) => {
          const s = r.query.project(pos);
          return Boolean(
            s &&
            r.query
              .drillPick(s.x, s.y)
              .some((hit) => hit.set === 'conf:line-drape' && hit.id === id),
          );
        };
        lines.set([
          {
            id: 'glow',
            positions: [at(-0.003, 0.002), at(0.003, 0.002)],
            widthPx: 12,
            mode: 'draped',
            style: { kind: 'glow', color: [1, 0.6, 0.2, 1], power: 0.25 },
          },
          {
            id: 'dash',
            positions: [at(-0.003, -0.002), at(0.003, -0.002)],
            widthPx: 12,
            mode: 'draped',
            style: {
              kind: 'dash',
              color: [1, 0.6, 0.2, 1],
              length: 16,
            },
          },
          {
            id: 'reveal',
            positions: [at(-0.003), at(0.003)],
            widthPx: 12,
            mode: 'draped',
            style: { kind: 'solid', color: '#20e7f2' },
            revealFraction: 0.5,
          },
          {
            id: 'arrow',
            positions: [at(-0.003, -0.004), at(0.003, -0.004)],
            widthPx: 16,
            mode: 'draped',
            style: { kind: 'arrow', color: [0.5, 0.9, 1, 0.95] },
          },
        ]);
        await drawn(h, r);
        await settled(r);
        await drawn(h, r);
        ok(mine(at(0, 0.002), 'glow'), 'a draped glow line picks');
        ok(mine(at(0, -0.002), 'dash'), 'a draped dash line picks');
        ok(mine(at(-0.002, -0.004), 'arrow'), 'a draped arrow picks');
        ok(mine(at(-0.0015), 'reveal'), 'revealed: its first half draws');
        ok(!mine(at(0.0015), 'reveal'), 'revealed: its second half does not');
        lines.upsert([
          {
            id: 'reveal',
            positions: [at(-0.003), at(0.003)],
            widthPx: 12,
            mode: 'draped',
            style: { kind: 'solid', color: '#20e7f2' },
            revealFraction: 1,
          },
        ]);
        await drawn(h, r);
        ok(mine(at(0.0015), 'reveal'), 'revealed whole: all of it draws');
        // A draped line growing every frame. Its first moves may take a
        // few frames while the renderer readies itself to build it at once.
        const growing = (end) => ({
          id: 'growing',
          positions: [at(-0.003, 0.004), at(end, 0.004)],
          widthPx: 12,
          mode: 'draped',
          style: { kind: 'solid', color: '#ff00ff' },
        });
        lines.upsert([growing(-0.002)]);
        let ready = false;
        for (let i = 0; i < 300 && !ready; i++) {
          lines.upsert([growing(-0.002 + (i % 2) * 1e-6)]);
          await drawn(h, r, 1);
          ready = mine(at(-0.0025, 0.004), 'growing');
        }
        ok(ready, 'the growing line draws');
        const points = r.draw.points({ id: 'conf:line-drape-point' });
        const front = (dLon) => ({
          id: 'front',
          pos: { lon: AUSTIN.lon + dLon, lat: AUSTIN.lat + 0.003, height: 0 },
          height: 'clampGround',
          pixelSize: 16,
          color: '#ff0000',
          // On the surface it would be half under it.
          disableDepthTest: Infinity,
        });
        const point = (dLon) => {
          const s = r.query.project(at(dLon, 0.003));
          return Boolean(
            s &&
            r.query
              .drillPick(s.x, s.y)
              .some((hit) => hit.set === 'conf:line-drape-point'),
          );
        };
        points.set([front(-0.002)]);
        await drawn(h, r);
        await settled(r);
        await drawn(h, r);
        ok(point(-0.002), 'the clamped point draws');
        for (let i = 1; i <= 4; i++) {
          const end = -0.002 + i * 0.001;
          lines.upsert([growing(end)]);
          points.upsert([front(-0.002 + i * 0.001)]);
          await drawn(h, r, 1);
          ok(
            mine(at(end - 0.0004, 0.004), 'growing'),
            `grown, frame ${i}: drawn to its new end`,
          );
          ok(
            point(-0.002 + i * 0.001),
            `moved, frame ${i}: the point is there`,
          );
          ok(
            i < 2 || !point(-0.002 + (i - 2) * 0.001),
            `moved, frame ${i}: not where it was`,
          );
        }
        equal(lines.size(), 5, 'every line held');
        points.dispose();
        lines.dispose();
      },
    ),
    check(
      'draw.lines.split',
      'a draped split line draws its behind colour before its split and its colour after it, each with a darker rim, the split and its direction moved in place',
      async (h, r) => {
        if (h.pixels === false)
          return { skip: 'this harness reads no drawn pixels' };
        await overAustin(h, r);
        // Off the row under the camera, where a ground line can leave a gap.
        const at = (dLon) =>
          h.toEcef({ lon: AUSTIN.lon + dLon, lat: AUSTIN.lat + 0.002 });
        const lines = r.draw.lines({ id: 'conf:line-split' });
        const item = (split, reverse = false) => ({
          id: 'route',
          positions: [at(-0.004), at(0.004)],
          widthPx: 24,
          mode: 'draped',
          style: {
            kind: 'split',
            color: '#ff0000',
            behind: '#00ff00',
            at: split,
            reverse,
            rim: { shade: 0.25, widthFraction: 0.3 },
          },
        });
        // The middle column across the line at `dLon`, top to bottom:
        // R/G its core, r/g the rim (under 0.8 of the core’s brightness, as
        // a renderer may light or fog the colours), - neither.
        const column = (dLon) => {
          r.frame.renderNow();
          const s = r.query.project(at(dLon));
          const half = 24;
          const image = r.readPixels({
            crop: {
              x: Math.round(s.x) - 2,
              y: Math.round(s.y) - half,
              width: 5,
              height: 2 * half + 1,
            },
          });
          const read = [];
          for (let row = 0; row < image.height; row++) {
            const i = (row * image.width + 2) * 4;
            const [red, green, blue] = image.data.slice(i, i + 3);
            const hue =
              red > green + 20 && red > blue + 20
                ? 'r'
                : green > red + 20 && green > blue + 20
                  ? 'g'
                  : '';
            read.push([hue, hue === 'r' ? red : hue === 'g' ? green : 0]);
          }
          const core = Math.max(...read.map(([, v]) => v));
          return read
            .map(([hue, v]) =>
              !hue ? '-' : v >= 0.8 * core ? hue.toUpperCase() : hue,
            )
            .join('');
        };
        const reads = (col, hue) => {
          const runs = col.match(/([rRgG])\1*/g) ?? [];
          const core = runs.find((run) => run[0] === hue.toUpperCase());
          const rims = runs.filter((run) => run[0] === hue);
          return Boolean(core) && rims.length >= 2;
        };
        try {
          lines.set([item(0.25)]);
          await drawn(h, r);
          await settled(r);
          await drawn(h, r);
          let a = column(-0.003);
          let b = column(0.001);
          ok(reads(a, 'g'), `behind its split: green, rimmed (${a})`);
          ok(reads(b, 'r'), `ahead of its split: red, rimmed (${b})`);
          lines.upsert([item(0.75)]);
          await drawn(h, r);
          b = column(0.001);
          ok(reads(b, 'g'), `the split moved past it: green (${b})`);
          lines.upsert([item(0.25, true)]);
          await drawn(h, r);
          a = column(-0.003);
          b = column(0.001);
          ok(reads(a, 'r'), `reversed: ahead before the split, red (${a})`);
          ok(reads(b, 'g'), `reversed: behind after it, green (${b})`);
          equal(lines.size(), 1, 'moved in place, not added');
        } finally {
          lines.dispose();
        }
      },
    ),
    check(
      'draw.lines.outlineDraped',
      'a draped, translucent, revealed solid line draws its outline in the same pass: its centre as bright as a plain line of the colour, its edges dark, nothing past the reveal',
      async (h, r) => {
        if (h.pixels === false)
          return { skip: 'this harness reads no drawn pixels' };
        await overAustin(h, r);
        // Off the row under the camera, where a ground line can leave a gap.
        const at = (dLon, dLat) =>
          h.toEcef({ lon: AUSTIN.lon + dLon, lat: AUSTIN.lat + dLat });
        const lines = r.draw.lines({ id: 'conf:line-outline-draped' });
        const green = [0, 1, 0, 0.8];
        lines.set([
          {
            // 24 px with an outline of 8: 4 px of dark each side of 16 px
            // of green, revealed to its middle.
            id: 'outlined',
            positions: [at(-0.004, 0.002), at(0.004, 0.002)],
            widthPx: 24,
            mode: 'draped',
            style: {
              kind: 'solid',
              color: green,
              outline: { color: [0, 0, 0, 0.8], widthPx: 8 },
            },
            revealFraction: 0.5,
          },
          {
            id: 'plain',
            positions: [at(-0.004, -0.002), at(0.004, -0.002)],
            widthPx: 24,
            mode: 'draped',
            style: { kind: 'solid', color: green },
          },
        ]);
        // The middle column across the line at `dLon`, as green values.
        const column = (dLon, dLat) => {
          r.frame.renderNow();
          const s = r.query.project(at(dLon, dLat));
          const half = 20;
          const image = r.readPixels({
            crop: {
              x: Math.round(s.x) - 2,
              y: Math.round(s.y) - half,
              width: 5,
              height: 2 * half + 1,
            },
          });
          const read = [];
          for (let row = 0; row < image.height; row++) {
            const i = (row * image.width + 2) * 4;
            const [red, g, blue] = image.data.slice(i, i + 3);
            read.push({ g, greenish: g > red + 30 && g > blue + 30 });
          }
          return read;
        };
        try {
          await drawn(h, r);
          await settled(r);
          await drawn(h, r);
          const outlined = column(-0.002, 0.002);
          const plain = column(-0.002, -0.002);
          const centre = (col) => col[(col.length - 1) >> 1];
          const coreG = centre(outlined).g;
          const plainG = centre(plain).g;
          ok(
            centre(outlined).greenish && centre(plain).greenish,
            `both centres green (${coreG}, ${plainG})`,
          );
          ok(
            Math.abs(coreG - plainG) <= 0.08 * plainG + 4,
            `the outlined centre as bright as the plain line (${coreG} vs ${plainG})`,
          );
          // The rows just inside each edge: dark, 4 px of outline a side.
          const mid = (outlined.length - 1) >> 1;
          for (const row of [mid - 10, mid + 10])
            ok(
              outlined[row].g < 0.6 * coreG,
              `dark at its edge, row ${row - mid} (${outlined[row].g} vs ${coreG})`,
            );
          const past = column(0.002, 0.002);
          ok(!past.some((p) => p.greenish), 'nothing drawn past the reveal');
        } finally {
          lines.dispose();
        }
      },
    ),
    check(
      'draw.lines.segments',
      'a draped line takes segment colours and shows, changed every frame in place, without stopping the frame or picks',
      async (h, r) => {
        await overAustin(h, r);
        const lines = r.draw.lines({
          id: 'conf:line-segments',
          pickable: false,
        });
        const at = (dLon) =>
          h.toEcef({ lon: AUSTIN.lon + dLon, lat: AUSTIN.lat, height: 0 });
        const trail = (frame) => ({
          id: 'trail',
          positions: [at(-0.003), at(-0.001), at(0.001), at(0.003)],
          widthPx: 5,
          mode: 'draped',
          clampTo: 'both',
          style: { kind: 'solid', color: '#ffffff' },
          segmentColors: [0, 1, 2].map((i) => [
            0.2,
            0.9,
            0.5,
            ((frame + i) % 4) / 4 + 0.2,
          ]),
          segmentShow: [0, 1, 2].map((i) => i <= frame % 3),
        });
        lines.set([trail(0)]);
        await settled(r);
        for (let i = 1; i < 5; i++) {
          lines.upsert([trail(i)]);
          await drawn(h, r, 1);
        }
        equal(lines.size(), 1, 'changed in place, not added');
        const points = r.draw.points({ id: 'conf:line-segments-points' });
        const pos = at(0);
        points.set([{ id: 'p', pos, pixelSize: 16, color: '#ff0000' }]);
        await drawn(h, r);
        const s = r.query.project(pos);
        ok(s, 'the point projects');
        equal(
          r.query
            .drillPick(s.x, s.y)
            .find((hit) => hit.set === 'conf:line-segments-points')?.id,
          'p',
          'picks still find what is drawn over the line',
        );
        points.dispose();
        lines.dispose();
      },
    ),
    check(
      'draw.lines.segmentStyles',
      'every line mode and style takes segment colours and shows: a hidden segment is not picked, a shown one picks as its line',
      async (h, r) => {
        await overAustin(h, r, 3000);
        const lines = r.draw.lines({ id: 'conf:segment-styles' });
        const kinds = [
          ['3d', { kind: 'glow', color: '#ffffff', power: 0.3 }],
          ['geodesic', { kind: 'dash', color: '#ffffff', length: 16 }],
          ['draped', { kind: 'arrow', color: '#ffffff' }],
          ['3d', { kind: 'pattern', image: PIXEL_PNG, repeat: 4 }],
          [
            'draped',
            {
              kind: 'solid',
              color: '#ffffff',
              outline: { color: '#000000', widthPx: 4 },
            },
          ],
        ];
        // Off the canvas's centre row: the Cesium port does not pick draped
        // lines at its exact centre.
        const lat = (k) =>
          AUSTIN.lat + 0.0008 + (k - (kinds.length - 1) / 2) * 0.0015;
        const at = (k, dLon) =>
          h.toEcef({
            lon: AUSTIN.lon + dLon,
            lat: lat(k),
            height: kinds[k][0] === 'draped' ? 0 : 20,
          });
        const ends = [-0.006, -0.002, 0.002, 0.006];
        const line = (k, shows) => ({
          id: `l${k}`,
          positions: ends.map((d) => at(k, d)),
          widthPx: 12,
          mode: kinds[k][0],
          style: kinds[k][1],
          segmentColors: ['#ff0000', '#00ff00', '#0000ff'],
          segmentShow: shows,
        });
        lines.set(kinds.map((_, k) => line(k, [true, false, true])));
        await settled(r);
        await drawn(h, r);
        const pickAt = (k, dLon) => {
          const s = r.query.project(at(k, dLon));
          ok(s, `line ${k} projects`);
          return r.query
            .drillPick(s.x, s.y)
            .filter((hit) => hit.set === 'conf:segment-styles')
            .map((hit) => hit.id);
        };
        kinds.forEach(([mode, style], k) => {
          const what = `${mode} ${style.kind}`;
          deepEqual(pickAt(k, -0.004), [`l${k}`], `${what}: shown segment`);
          deepEqual(pickAt(k, 0), [], `${what}: hidden segment`);
        });
        lines.upsert(kinds.map((_, k) => line(k, [false, true, true])));
        equal(lines.size(), kinds.length, 'changed in place, not added');
        await drawn(h, r);
        kinds.forEach(([mode, style], k) => {
          const what = `${mode} ${style.kind}`;
          deepEqual(pickAt(k, -0.004), [], `${what}: now hidden`);
          deepEqual(pickAt(k, 0), [`l${k}`], `${what}: now shown`);
        });
        lines.dispose();
      },
    ),
    check(
      'draw.points.update',
      'an upserted point is drawn where it now is once drawn again, and shows only within its display range',
      async (h, r) => {
        await overAustin(h, r);
        const set = r.draw.points({ id: 'conf:points-update' });
        const a = h.toEcef({ ...AUSTIN, height: 0 });
        const b = h.toEcef({ lon: AUSTIN.lon + 0.004, lat: AUSTIN.lat });
        const point = (pos, extra = {}) => ({
          id: 'one',
          pos,
          pixelSize: 16,
          color: '#ff0000',
          meta: { n: 1 },
          ...extra,
        });
        set.set([point(a)]);
        await drawn(h, r);
        const sa = r.query.project(a);
        const sb = r.query.project(b);
        ok(sa && sb, 'both places project');
        const mine = (s) =>
          r.query.pick(s.x, s.y)?.set === 'conf:points-update';
        ok(mine(sa) && !mine(sb), 'drawn where it was put');
        set.upsert([point(b, { meta: { n: 2 } })]);
        await drawn(h, r);
        ok(!mine(sa), 'moved: gone from where it was');
        deepEqual(
          r.query.pick(sb.x, sb.y)?.meta,
          { n: 2 },
          'moved: picked where it now is, with its new meta',
        );
        // The eye is 2 km off.
        set.upsert([point(b, { displayRange: [0, 100] })]);
        await drawn(h, r);
        ok(!mine(sb), 'out of its display range: not drawn');
        set.upsert([point(b, { displayRange: [0, 1e6] })]);
        await drawn(h, r);
        ok(mine(sb), 'in its display range: drawn');
        set.upsert([point(b, { displayRange: [1e4, 1e6] })]);
        await drawn(h, r);
        ok(!mine(sb), 'nearer than its display range: not drawn');
        set.dispose();
      },
    ),
    check(
      'draw.points.population',
      'points added and removed one by one draw and pick on their own, the others staying where they are',
      async (h, r) => {
        await overAustin(h, r);
        const set = r.draw.points({
          id: 'conf:points-population',
          blend: 'translucent',
        });
        const at = (k) =>
          h.toEcef({ lon: AUSTIN.lon + 0.003 * k, lat: AUSTIN.lat });
        const point = (k) => ({
          id: `p${k}`,
          pos: at(k),
          pixelSize: 16,
          color: [1, 0, 0, 0.9],
          meta: { k },
        });
        const picked = (k) => {
          const s = r.query.project(at(k));
          const hit = s && r.query.pick(s.x, s.y);
          return hit?.set === 'conf:points-population' ? hit.meta?.k : null;
        };
        set.upsert([point(0)]);
        set.upsert([point(1), point(-1)]);
        await drawn(h, r);
        deepEqual([picked(-1), picked(0), picked(1)], [-1, 0, 1], 'all drawn');
        set.remove(['p0']);
        await drawn(h, r);
        deepEqual(
          [picked(-1), picked(0), picked(1)],
          [-1, null, 1],
          'removed: only that one is gone',
        );
        equal(set.size(), 2, 'two left');
        set.upsert([point(0)]);
        await drawn(h, r);
        equal(picked(0), 0, 'added again: drawn again');
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
    check(
      'draw.models.loadFailed',
      'a model set says when a model fails to load, and loads it when added again',
      async (h, r) => {
        if (!h.assets?.model || !h.assets?.missingModel)
          return { skip: 'no missing model asset in this harness' };
        const set = r.draw.models({ id: 'conf:models.loadFailed' });
        const ready = [];
        const failed = [];
        set.on('ready', (id) => ready.push(id));
        set.on('loadFailed', (id, message) => failed.push([id, message]));
        const model = (id, url) => ({
          id,
          pos: { ...AUSTIN, height: 0 },
          url,
          orientation: { heading: 0, pitch: 0, roll: 0 },
        });
        const until = async (done) => {
          for (let i = 0; i < 600 && !done(); i++) await drawn(h, r, 1);
        };
        set.set([
          model('bad', h.assets.missingModel),
          model('good', h.assets.model),
        ]);
        await until(() => failed.length >= 1 && ready.length >= 1);
        deepEqual(ready, ['good'], 'the good one is ready');
        deepEqual(
          failed.map(([id]) => id),
          ['bad'],
          'the missing one failed',
        );
        ok(
          typeof failed[0]?.[1] === 'string' && failed[0][1].length > 0,
          'with a message',
        );
        equal(set.size(), 2, 'the failed item stays in the set');
        // Removed and added again, it is tried at once, and fails again.
        set.remove(['bad']);
        set.upsert([model('bad', h.assets.missingModel)]);
        await until(() => failed.length >= 2);
        deepEqual(
          failed.map(([id]) => id),
          ['bad', 'bad'],
          'tried again when added again',
        );
        // Pointed at a url that loads, it is ready.
        set.upsert([model('bad', h.assets.model)]);
        await until(() => ready.length >= 2);
        deepEqual(ready, ['good', 'bad'], 'a good url loads');
        equal(failed.length, 2, 'no failure for a good url');
        set.dispose();
      },
      { capability: 'models' },
    ),
    check(
      'draw.models.update',
      'a model moves, turns and restyles in place; only a new url loads it again',
      async (h, r) => {
        if (!h.assets?.model) return { skip: 'no model asset in this harness' };
        await overAustin(h, r);
        const set = r.draw.models({ id: 'conf:models.update' });
        const ready = [];
        set.on('ready', (id) => ready.push(id));
        const here = h.toEcef({ ...AUSTIN, height: 0 });
        const there = h.toEcef({
          lon: AUSTIN.lon + 0.004,
          lat: AUSTIN.lat,
          height: 0,
        });
        const model = (pos, extra = {}) => ({
          id: 'm',
          pos,
          url: h.assets.model,
          orientation: { heading: 0, pitch: 0, roll: 0 },
          minPixelSize: 96,
          ...extra,
        });
        const untilReady = async (count) => {
          for (let i = 0; i < 600 && ready.length < count; i++)
            await drawn(h, r, 1);
        };
        const picked = (pos) => {
          const s = r.query.project(pos);
          return (
            s !== null &&
            r.query.drillPick(s.x, s.y).some((hit) => hit.set === set.id)
          );
        };
        set.set([model(here)]);
        await untilReady(1);
        deepEqual(ready, ['m'], 'ready once loaded');
        await drawn(h, r);
        await settled(r);
        ok(picked(here), 'picked where it is');
        set.upsert([
          model(there, {
            orientation: { heading: 1.2, pitch: 0.1, roll: 0.2 },
            scale: 2,
            shading: 'unlit',
            tint: '#00ff00',
            colorBlend: { mode: 'mix', amount: 0.5 },
            environmentMap: false,
            meta: { n: 2 },
          }),
        ]);
        await drawn(h, r, 4);
        await settled(r);
        deepEqual(ready, ['m'], 'moved and restyled without loading again');
        ok(picked(there), 'picked where it moved to');
        ok(!picked(here), 'not where it was');
        const s = r.query.project(there);
        const hit = r.query.drillPick(s.x, s.y).find((x) => x.set === set.id);
        deepEqual(hit?.meta, { n: 2 }, 'its new meta');
        set.upsert([model(there, { url: `${h.assets.model}?again` })]);
        await untilReady(2);
        deepEqual(ready, ['m', 'm'], 'a new url loads again');
        await drawn(h, r);
        await settled(r);
        ok(picked(there), 'the new model is drawn');
        equal(set.size(), 1, 'one model');
        set.dispose();
      },
      { capability: 'models' },
    ),
    check(
      'draw.models.tint',
      'a model’s tint and colour blend change live',
      async (h, r) => {
        if (!h.assets?.model) return { skip: 'no model asset in this harness' };
        await overAustin(h, r);
        const set = r.draw.models({ id: 'conf:models.tint' });
        const ready = [];
        set.on('ready', (id) => ready.push(id));
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        const model = (extra) => ({
          id: 'm',
          pos,
          url: h.assets.model,
          orientation: { heading: 0, pitch: 0, roll: 0 },
          minPixelSize: 160,
          environmentMap: false,
          ...extra,
        });
        set.set([model({ shading: 'pbr' })]);
        for (let i = 0; i < 600 && !ready.length; i++) await drawn(h, r, 1);
        deepEqual(ready, ['m'], 'ready');
        const s = r.query.project(pos);
        // How many pixels of a patch at the model's centre `like` holds.
        const count = async (like) => {
          await drawn(h, r, 3);
          await settled(r);
          r.frame.renderNow();
          const image = r.readPixels({
            crop: {
              x: Math.round(s.x) - 4,
              y: Math.round(s.y) - 4,
              width: 9,
              height: 9,
            },
          });
          let n = 0;
          for (let i = 0; i < image.data.length; i += 4)
            if (like(image.data[i], image.data[i + 1], image.data[i + 2])) n++;
          return n;
        };
        const red = (r0, g, b) => r0 > 180 && g < 70 && b < 70;
        const blue = (r0, g, b) => b > 180 && r0 < 70 && g < 70;
        set.upsert([
          model({
            shading: 'unlit',
            tint: '#ff0000',
            colorBlend: { mode: 'replace' },
          }),
        ]);
        ok((await count(red)) >= 40, 'replaced by a red tint');
        set.upsert([
          model({
            shading: 'unlit',
            tint: '#0000ff',
            colorBlend: { mode: 'replace' },
          }),
        ]);
        ok((await count(blue)) >= 40, 'the tint changes live');
        set.upsert([
          model({
            shading: 'unlit',
            tint: '#0000ff',
            colorBlend: { mode: 'mix', amount: 0 },
          }),
        ]);
        equal(await count(blue), 0, 'mixed in at none, its own colour');
        deepEqual(ready, ['m'], 'restyled without loading again');
        set.dispose();
      },
      { capability: 'models', bareSky: true },
    ),
    check(
      'draw.models.blend',
      'a model set’s blend changes live, without loading again: additive adds the model’s colour to what is under it',
      async (h, r) => {
        if (!h.assets?.model) return { skip: 'no model asset in this harness' };
        if (h.pixels === false)
          return { skip: 'this harness reads no drawn pixels' };
        await overAustin(h, r);
        const d = 0.003;
        const under = r.draw.shapes({ id: 'conf:models.blend-under' });
        under.set([
          {
            id: 'green',
            geometry: {
              kind: 'rectangle',
              rect: {
                west: AUSTIN.lon - d,
                south: AUSTIN.lat - d,
                east: AUSTIN.lon + d,
                north: AUSTIN.lat + d,
              },
              height: 0,
            },
            fill: '#00ff00',
            height: 'absolute',
          },
        ]);
        const set = r.draw.models({ id: 'conf:models.blend' });
        const ready = [];
        set.on('ready', (id) => ready.push(id));
        const pos = h.toEcef({ ...AUSTIN, height: 50 });
        set.set([
          {
            id: 'm',
            pos,
            url: h.assets.model,
            orientation: { heading: 0, pitch: 0, roll: 0 },
            minPixelSize: 160,
            environmentMap: false,
            shading: 'unlit',
            tint: '#ff0000',
            colorBlend: { mode: 'replace' },
          },
        ]);
        try {
          for (let i = 0; i < 600 && !ready.length; i++) await drawn(h, r, 1);
          deepEqual(ready, ['m'], 'ready');
          const s = r.query.project(pos);
          const count = async (like) => {
            await drawn(h, r, 3);
            await settled(r);
            r.frame.renderNow();
            const image = r.readPixels({
              crop: {
                x: Math.round(s.x) - 4,
                y: Math.round(s.y) - 4,
                width: 9,
                height: 9,
              },
            });
            let n = 0;
            for (let i = 0; i < image.data.length; i += 4)
              if (like(image.data[i], image.data[i + 1], image.data[i + 2]))
                n++;
            return n;
          };
          const red = (r0, g, b) => r0 > 180 && g < 70 && b < 70;
          const yellow = (r0, g, b) => r0 > 180 && g > 150 && b < 70;
          ok((await count(red)) >= 40, 'no blend: red over green');
          set.setOptions({ blend: 'additive' });
          ok((await count(yellow)) >= 40, 'additive: red added to green');
          equal(await count(red), 0, 'additive: none red alone');
          set.setOptions({ blend: 'translucent' });
          ok((await count(red)) >= 40, 'translucent at alpha 1: red');
          set.setOptions({ blend: 'opaque' });
          ok((await count(red)) >= 40, 'opaque: red');
          deepEqual(ready, ['m'], 'never loaded again');
        } finally {
          set.dispose();
          under.dispose();
        }
      },
      { capability: 'models', bareSky: true },
    ),
    check(
      'draw.models.bytes',
      'a model given its bytes is drawn from them, its url never fetched',
      async (h, r) => {
        if (!h.assets?.modelBytes || !h.assets?.missingModel)
          return { skip: 'no model bytes in this harness' };
        const gltf = await h.assets.modelBytes();
        const set = r.draw.models({ id: 'conf:models.bytes' });
        const ready = [];
        const failed = [];
        set.on('ready', (id) => ready.push(id));
        set.on('loadFailed', (id) => failed.push(id));
        set.set([
          {
            id: 'm',
            pos: { ...AUSTIN, height: 0 },
            // A url that does not load: only the bytes can draw it.
            url: h.assets.missingModel,
            gltf,
            orientation: { heading: 0, pitch: 0, roll: 0 },
          },
        ]);
        for (let i = 0; i < 600 && !ready.length && !failed.length; i++)
          await drawn(h, r, 1);
        deepEqual(ready, ['m'], 'ready from its bytes');
        deepEqual(failed, [], 'its url not fetched');
        set.dispose();
      },
      { capability: 'models' },
    ),
    check(
      'draw.models.fleet',
      'a model’s axis scale and clip change live, without loading again',
      async (h, r) => {
        if (!h.assets?.model) return { skip: 'no model asset in this harness' };
        await overAustin(h, r);
        const set = r.draw.models({ id: 'conf:models.fleet' });
        const ready = [];
        const failed = [];
        set.on('ready', (id) => ready.push(id));
        set.on('loadFailed', (id) => failed.push(id));
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        const model = (extra) => ({
          id: 'm',
          pos,
          url: h.assets.model,
          orientation: { heading: 0, pitch: 0, roll: 0 },
          minPixelSize: 96,
          meta: { n: 1 },
          ...extra,
        });
        const picked = () => {
          const s = r.query.project(pos);
          return (
            s !== null &&
            r.query.drillPick(s.x, s.y).some((hit) => hit.set === set.id)
          );
        };
        set.set([model({ axisScale: [1, 1, 1] })]);
        for (let i = 0; i < 600 && !ready.length; i++) await drawn(h, r, 1);
        deepEqual(ready, ['m'], 'ready');
        set.upsert([model({ axisScale: [1, 1.5, 2], clip: 'belowOrigin' })]);
        await drawn(h, r, 3);
        await settled(r);
        ok(picked(), 'stretched and clipped, still drawn where it is');
        set.upsert([model({ axisScale: [2, 1, 1], clip: undefined })]);
        await drawn(h, r, 3);
        await settled(r);
        ok(picked(), 'restretched and unclipped');
        deepEqual(ready, ['m'], 'restyled without loading again');
        deepEqual(failed, [], 'nothing failed');
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
              kind: 'polygon',
              rings: [
                [
                  [-0.001, -0.001],
                  [0.001, -0.001],
                  [0.001, 0.001],
                  [-0.001, 0.001],
                ].map(([dLon, dLat]) => ({
                  lon: AUSTIN.lon + dLon,
                  lat: AUSTIN.lat + dLat,
                  height: 0,
                })),
              ],
            },
            extrudeHeight: 1000,
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
    check(
      'query.occlusionTest',
      'an occlusion test takes points and leaves the unanswered pending',
      async (h) => {
        const r = await h.create({ viewport: SCRIPT_VIEWPORT });
        try {
          const test = r.query.occlusionTest();
          ok(
            ['async', 'sync', 'off'].includes(test.mode),
            'mode is async, sync or off',
          );
          ok(test.maxPerFrame > 0, 'takes at least one point a frame');
          const point = { pending: false, answered: false, lastHiddenAt: 0 };
          test.beginFrame(0);
          const taken = test.add(point, h.toEcef({ ...AUSTIN, height: 10 }));
          equal(typeof taken, 'boolean', 'add says whether it took the point');
          if (taken && test.mode === 'async')
            ok(point.pending || point.answered, 'a point taken is under test');
          test.endFrame();
          test.reset();
          test.destroy();
        } finally {
          r.destroy();
        }
      },
      { capability: 'occlusionTest' },
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
        equal(lease.owner, 'tool', 'the lease names its owner');
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
      'input.lease.lost',
      'the newest claim takes over: the lease it ends is told once, after the new one holds the pointer, and its late release frees nothing; a throwing onLost is reported',
      async (h, r) => {
        if (!h.pointer) return { skip: 'no pointer in this harness' };
        const told = [];
        // What the ended lease's holder sees from inside its `onLost`.
        let inside = null;
        const a = r.input.claimPointer('a', {
          onLost: () => {
            told.push('a');
            inside = { free: r.input.isPointerFree(), current: a.current };
          },
        });
        const heard = [];
        r.input.on('down', () => heard.push('a'), { lease: a });
        const b = r.input.claimPointer('b', { onLost: () => told.push('b') });
        r.input.on('down', () => heard.push('b'), { lease: b });
        deepEqual(told, ['a'], 'the ended lease is told');
        deepEqual(
          inside,
          { free: false, current: false },
          'inside onLost the new lease already holds the pointer and the old one has ended',
        );
        ok(!a.current && b.current, 'the newest lease holds the pointer');
        await h.pointer(r, 'down', 640, 360);
        await h.pointer(r, 'up', 640, 360);
        deepEqual(heard, ['b'], 'the newest holder gets the press');
        a.release();
        ok(b.current, "the ended lease's release frees nothing");
        ok(!r.input.isPointerFree(), 'still taken');
        deepEqual(told, ['a'], 'told once');
        b.release();
        deepEqual(told, ['a'], 'a lease its holder releases is not told');
        ok(r.input.isPointerFree(), 'free again');

        const errors = [];
        r.on('error', (e) => errors.push(e));
        r.input.claimPointer('c', {
          onLost: () => {
            throw new Error('conformance onLost');
          },
        });
        const d = r.input.claimPointer('d');
        equal(errors.length, 1, 'a throwing onLost is reported');
        ok(d.current, 'and the new lease holds the pointer regardless');
        heard.length = 0;
        r.input.on('down', () => heard.push('d'), { lease: d });
        await h.pointer(r, 'down', 640, 360);
        await h.pointer(r, 'up', 640, 360);
        deepEqual(heard, ['d'], 'and gets the press');
        d.release();
        ok(r.input.isPointerFree(), 'free at the end');
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
      'globe.base.vector',
      'a vector base draws its style: the fills its filters keep, over its background; legacy string stops; transparent with no background; a style that fails to load changes nothing; a base without it draws none of it',
      async (h, r) => {
        await overAustin(h, r, 20000);
        // One tile for every tile: the whole of it sea, and a road.
        const whole = [
          [
            [-64, -64],
            [4160, -64],
            [4160, 4160],
            [-64, 4160],
            [-64, -64],
          ],
        ];
        // Roads 256 units (16 px of a 256 px tile) apart: lines 24 px wide
        // cover the tile.
        const roads = [];
        for (let y = -256; y <= 4352; y += 256)
          roads.push({
            type: 'LineString',
            geometry: [
              [
                [-64, y],
                [4160, y],
              ],
            ],
            properties: { class: 'road' },
          });
        const tile = encodeVectorTile({
          water: [
            { type: 'Polygon', geometry: whole, properties: { class: 'sea' } },
          ],
          roads,
        });
        let binary = '';
        for (const byte of tile) binary += String.fromCharCode(byte);
        const style = {
          version: 8,
          sources: {
            base: {
              type: 'vector',
              tiles: [`data:application/x-protobuf;base64,${btoa(binary)}`],
              maxzoom: 14,
              attribution: '<a href="https://example.test">Test tiles</a>',
            },
          },
          layers: [
            {
              id: 'bg',
              type: 'background',
              paint: { 'background-color': '#ff0000' },
            },
            {
              id: 'sea',
              type: 'fill',
              source: 'base',
              'source-layer': 'water',
              filter: ['==', ['get', 'class'], 'sea'],
              paint: { 'fill-color': '#00c8ff' },
            },
            {
              id: 'lake',
              type: 'fill',
              source: 'base',
              'source-layer': 'water',
              filter: ['==', 'class', 'lake'],
              paint: { 'fill-color': '#ffff00' },
            },
          ],
        };
        const styleUrl = `data:application/json,${encodeURIComponent(JSON.stringify(style))}`;
        const status = await r.globe.setBase({ vector: { styleUrl } });
        ok(status && Array.isArray(status.imagery), 'the base is set');
        const below = r.query.project(h.toEcef({ ...AUSTIN, height: 0 }));
        const middle = async () => {
          await settled(r);
          r.frame.renderNow();
          const { data } = r.readPixels({
            crop: {
              x: Math.round(below.x) - 4,
              y: Math.round(below.y) - 4,
              width: 9,
              height: 9,
            },
          });
          const mean = [0, 0, 0];
          for (let i = 0; i < data.length; i += 4)
            for (let c = 0; c < 3; c++)
              mean[c] += data[i + c] / (data.length / 4);
          return mean;
        };
        if (h.pixels !== false) {
          const [red, green, blue] = await middle();
          ok(
            blue > 170 && green > 120 && red < 90,
            `the sea is drawn, not its background or the filtered lake (${[red, green, blue].map(Math.round)})`,
          );
        }
        let failed = false;
        try {
          await r.globe.setBase({
            vector: { styleUrl: 'data:application/json,%7B%7D' },
          });
        } catch {
          failed = true;
        }
        ok(failed, 'a document that is no style is refused');
        if (h.pixels !== false) {
          const [red, green, blue] = await middle();
          ok(
            blue > 170 && red < 90,
            `the base is as it was (${[red, green, blue].map(Math.round)})`,
          );
        }
        const credited = () =>
          r.credits.list().some((c) => /Test tiles/.test(c.text ?? ''));
        const gaveCredit = credited();
        // A style with no background, whose roads join and cap by legacy
        // zoom functions of strings (stepped, as the specification says,
        // not interpolated): the roads are drawn, and where a layer draws
        // nothing the globe shows through, never black.
        const lines = (filter) => ({
          version: 8,
          sources: style.sources,
          layers: [
            {
              id: 'roads',
              type: 'line',
              source: 'base',
              'source-layer': 'roads',
              filter,
              layout: {
                'line-join': {
                  stops: [
                    [0, 'bevel'],
                    [22, 'round'],
                  ],
                },
                'line-cap': {
                  stops: [
                    [0, 'butt'],
                    [22, 'square'],
                  ],
                },
              },
              paint: { 'line-color': '#ff00ff', 'line-width': 24 },
            },
          ],
        });
        const urlOf = (doc) =>
          `data:application/json,${encodeURIComponent(JSON.stringify(doc))}`;
        await r.globe.setBase({
          vector: { styleUrl: urlOf(lines(['==', 'class', 'road'])) },
        });
        if (h.pixels !== false) {
          const [red, green, blue] = await middle();
          ok(
            red > 170 && blue > 170 && green < 90,
            `roads with legacy string stops are drawn (${[red, green, blue].map(Math.round)})`,
          );
        }
        await r.globe.setBase({
          vector: { styleUrl: urlOf(lines(['==', 'class', 'none'])) },
        });
        if (h.pixels !== false) {
          const mean = await middle();
          ok(
            mean.reduce((a, b) => a + b, 0) > 40 &&
              !(mean[0] > 170 && mean[2] > 170),
            `no background: the globe shows through, not black (${mean.map(Math.round)})`,
          );
        }
        // Back to a base without it: none of it drawn, its credit gone.
        await r.globe.setBase({ vector: null, imagery: [] });
        equal(r.globe.imagery.list().length, 0, 'the base is restored');
        if (gaveCredit) ok(!credited(), 'its credit goes with it');
        if (h.pixels !== false) {
          const [red, green, blue] = await middle();
          ok(
            !(blue > 170 && green > 120) && !(red > 170 && blue > 170),
            `the vector base is no longer drawn (${[red, green, blue].map(Math.round)})`,
          );
        }
      },
      { capability: 'vectorBase', bareSky: true },
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
      'globe.imagery.video',
      'video tiles show the time within their segment, nearest segment end outside it',
      async (h, r) => {
        if (h.pixels === false)
          return { skip: 'this harness reads no drawn pixels' };
        if (typeof MediaRecorder !== 'function')
          return { skip: 'no MediaRecorder to make a video with' };
        await overAustin(h, r, 200000);
        // Two seconds of video: red, then blue.
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const g = canvas.getContext('2d');
        const recorder = new MediaRecorder(canvas.captureStream(30), {
          mimeType: 'video/webm',
        });
        const chunks = [];
        recorder.ondataavailable = (e) => chunks.push(e.data);
        let colour = '#ff0000';
        const paint = setInterval(() => {
          g.fillStyle = colour;
          g.fillRect(0, 0, 32, 32);
        }, 20);
        const wait = (ms) => new Promise((done) => setTimeout(done, ms));
        recorder.start();
        await wait(1000);
        colour = '#0000ff';
        await wait(1000);
        await new Promise((done) => {
          recorder.onstop = done;
          recorder.stop();
        });
        clearInterval(paint);
        const url = URL.createObjectURL(
          new Blob(chunks, { type: 'video/webm' }),
        );
        const t0 = r.frame.time();
        const layer = r.globe.imagery.add({
          kind: 'single-image',
          url: PIXEL_PNG,
          rectangle: {
            west: AUSTIN.lon - 2,
            south: AUSTIN.lat - 2,
            east: AUSTIN.lon + 2,
            north: AUSTIN.lat + 2,
          },
        });
        const ready = [];
        layer.on('frameReady', (time) => ready.push(time));
        const shows = async (ms, like, what) => {
          const before = ready.length;
          layer.setFrameTime(ms);
          for (let i = 0; i < 500 && ready.length === before; i++) {
            await drawn(h, r, 1);
            await wait(10);
          }
          ok(ready.length > before, `${what}: ready`);
          r.frame.renderNow();
          const s = r.query.project(h.toEcef({ ...AUSTIN, height: 0 }));
          const image = r.readPixels({
            crop: {
              x: Math.round(s.x),
              y: Math.round(s.y),
              width: 1,
              height: 1,
            },
          });
          const [red, , blue] = image.data;
          ok(like(red, blue), `${what}: (${red}, ${blue})`);
        };
        try {
          layer.setFrames(
            { kind: 'video', segments: [{ url, start: t0, end: t0 + 2000 }] },
            { clock: 'own' },
          );
          const red = (rr, b) => rr > 180 && b < 70;
          const blue = (rr, b) => b > 180 && rr < 70;
          await shows(t0 + 300, red, 'early in the segment');
          await shows(t0 + 1700, blue, 'late in the segment');
          await shows(t0 - 60000, red, 'before it: its start');
          await shows(t0 + 60000, blue, 'after it: its end');
        } finally {
          layer.remove();
          URL.revokeObjectURL(url);
        }
      },
      { capability: 'imageryFrames', bareSky: true },
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
      'globe.visible',
      'the globe surface reads back as it was shown or hidden',
      (h, r) => {
        r.globe.setGlobeVisible(false);
        equal(r.globe.isGlobeVisible(), false, 'hidden');
        r.globe.setGlobeVisible(true);
        equal(r.globe.isGlobeVisible(), true, 'shown');
      },
      { capability: 'globeVisibility' },
    ),
    check(
      'globe.surfaceVersion',
      'the surface version changes with what heights answer against, only',
      async (h, r) => {
        await overAustin(h, r);
        await drawn(h, r);
        const first = r.globe.surfaceVersion();
        equal(typeof first, 'number', 'a number');
        r.camera.setView({
          destination: { ...AUSTIN, height: 9000 },
          orientation: { heading: 1, pitch: -1, roll: 0 },
        });
        await drawn(h, r, 4);
        equal(
          r.globe.surfaceVersion(),
          first,
          'steady across frames and moves',
        );
        r.globe.setGlobeVisible(false);
        await drawn(h, r);
        const hidden = r.globe.surfaceVersion();
        ok(hidden !== first, 'the globe hidden changes it');
        equal(
          r.globe.isSettled('surface'),
          false,
          'with no globe and no tiles there is no surface to settle',
        );
        r.globe.setGlobeVisible(true);
        await drawn(h, r);
        ok(r.globe.surfaceVersion() !== hidden, 'shown again changes it');
      },
      { capability: 'surfaceIdentity' },
    ),
    check(
      'globe.surfaceShading',
      'hillshade shading is set, restrengthened and cleared, drawing each time',
      async (h, r) => {
        await overAustin(h, r, 20000);
        const errors = [];
        const off = r.on('error', (e) => errors.push(e));
        const draws = [];
        const offDraw = r.frame.on('postRender', () => draws.push(1));
        try {
          for (const shading of [
            { kind: 'hillshade', strength: 0.28 },
            { kind: 'hillshade', strength: 0.5 },
            null,
          ]) {
            const before = draws.length;
            r.globe.setSurfaceShading(shading);
            await h.frame(r);
            await h.frame(r);
            ok(
              draws.length > before,
              `drawn after ${shading?.strength ?? 'clearing'}`,
            );
          }
          deepEqual(errors, [], 'no errors');
        } finally {
          off();
          offDraw();
        }
      },
      { capability: 'surfaceShading' },
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

    check(
      'globe.weather',
      'weather starts clear, keeps what a set leaves out, and clamps',
      (h, r) => {
        const first = r.globe.weather.get();
        for (const key of ['clouds', 'fog', 'haze', 'rain', 'snow'])
          equal(first[key], 0, `${key} clear at first`);
        equal(first.wind.speedMps, 0, 'no wind at first');
        r.globe.weather.set({ clouds: 0.6, rain: 2 });
        r.globe.weather.set({
          fog: -1,
          wind: { speedMps: 8, fromDeg: -45 },
        });
        const after = r.globe.weather.get();
        near(after.clouds, 0.6, 1e-9, 'clouds kept');
        equal(after.rain, 1, 'rain clamped to 1');
        equal(after.fog, 0, 'fog clamped to 0');
        equal(after.snow, 0, 'snow untouched');
        near(after.wind.speedMps, 8, 1e-9, 'wind speed');
        near(after.wind.fromDeg, 315, 1e-9, 'wind direction wrapped');
        after.clouds = 0;
        near(r.globe.weather.get().clouds, 0.6, 1e-9, 'get hands out a copy');
      },
      { capability: 'weather' },
    ),
    check(
      'globe.weather.drawn',
      'clouds and fog change the drawn frame; clearing them brings it back',
      async (h, r) => {
        if (h.pixels === false) return { skip: 'reads pixels' };
        // Low and looking toward the horizon, where fog and a cloud layer
        // both show.
        r.camera.setView({
          destination: { ...AUSTIN, height: 600 },
          orientation: { heading: 0, pitch: -0.12, roll: 0 },
        });
        const frame = async () => {
          await drawn(h, r, 4);
          await settled(r);
          r.frame.renderNow();
          return r.readPixels({ scale: 0.1 }).data;
        };
        const apart = (a, b) => {
          let sum = 0;
          for (let i = 0; i < a.length; i += 4)
            for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c] - b[i + c]);
          return sum / ((a.length / 4) * 3);
        };
        const clear = await frame();
        r.globe.weather.set({ clouds: 1, fog: 1 });
        const weathered = await frame();
        ok(
          apart(clear, weathered) > 6,
          `weather changes the frame (${apart(clear, weathered).toFixed(1)})`,
        );
        r.globe.weather.set({ clouds: 0, fog: 0 });
        const again = await frame();
        ok(
          apart(clear, again) < 3,
          `cleared, the frame is back (${apart(clear, again).toFixed(1)})`,
        );
      },
      { capability: 'weather' },
    ),
    check(
      'globe.weather.sceneTime',
      'clouds are where scene time puts them: moving it moves them, going back brings them back',
      async (h, r) => {
        if (h.pixels === false) return { skip: 'reads pixels' };
        r.camera.setView({
          destination: { ...AUSTIN, height: 600 },
          orientation: { heading: 0, pitch: 0.05, roll: 0 },
        });
        const frame = async () => {
          await drawn(h, r, 4);
          await settled(r);
          r.frame.renderNow();
          return r.readPixels({ scale: 0.1 }).data;
        };
        const apart = (a, b) => {
          let sum = 0;
          for (let i = 0; i < a.length; i += 4)
            for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c] - b[i + c]);
          return sum / ((a.length / 4) * 3);
        };
        const t0 = r.frame.time();
        const later = t0 + 30 * 60_000;
        // What moving scene time changes without clouds (the sun), so the
        // clouds' own movement is measured on top of it.
        const clearAt0 = await frame();
        r.frame.setTime(later);
        const clearLater = await frame();
        r.frame.setTime(t0);
        r.globe.weather.set({
          clouds: 0.5,
          wind: { speedMps: 20, fromDeg: 270 },
        });
        const cloudsAt0 = await frame();
        r.frame.setTime(later);
        const cloudsLater = await frame();
        r.frame.setTime(t0);
        const cloudsAgain = await frame();
        r.globe.weather.set({ clouds: 0, wind: { speedMps: 0, fromDeg: 0 } });
        const sun = apart(clearAt0, clearLater);
        const moved = apart(cloudsAt0, cloudsLater);
        ok(
          moved > sun + 2,
          `30 minutes of wind move the clouds (${moved.toFixed(1)} against ${sun.toFixed(1)} clear)`,
        );
        ok(
          apart(cloudsAt0, cloudsAgain) < 3,
          `the same scene time draws the same clouds (${apart(cloudsAt0, cloudsAgain).toFixed(1)})`,
        );
      },
      { capability: 'weather' },
    ),

    // --- Effects, credits, quality ---------------------------------------
    check(
      'effects.styles',
      'a style is set, tuned and cleared; diagnostics follow',
      (h, r) => {
        // The app defines its styles on a renderer with none of its own.
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
      'The application defines a style: listed, set, replaced and removed',
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
      'renderer.capture',
      'capture encodes the last drawn frame as asked: cropped, scaled, its type and quality, drawing none of its own when the frame is kept',
      async (h, r) => {
        if (h.pixels === false || typeof createImageBitmap !== 'function')
          return { skip: 'no encoded pixels to read' };
        await overAustin(h, r);
        const set = r.draw.points({ id: 'conf:capture' });
        const pos = h.toEcef({ ...AUSTIN, height: 0 });
        set.set([{ id: 'p', pos, pixelSize: 24, color: '#ff0000' }]);
        await drawn(h, r);
        await settled(r);
        const size = async (blob) => {
          const bitmap = await createImageBitmap(blob);
          const wh = [bitmap.width, bitmap.height];
          bitmap.close();
          return wh;
        };
        let frames = 0;
        const off = r.frame.on('postRender', () => (frames += 1));
        const full = await r.capture();
        equal(full.type, 'image/png', 'a PNG by default');
        deepEqual(
          await size(full),
          [SCRIPT_VIEWPORT.width, SCRIPT_VIEWPORT.height],
          'the canvas’s CSS size',
        );
        const crop = { x: 10, y: 20, width: 40, height: 30 };
        deepEqual(
          await size(await r.capture({ crop, scale: 0.5 })),
          [20, 15],
          'a crop, scaled',
        );
        deepEqual(
          await size(await r.capture({ scale: 0.25 })),
          [SCRIPT_VIEWPORT.width / 4, SCRIPT_VIEWPORT.height / 4],
          'scaled',
        );
        const low = await r.capture({ type: 'jpeg', quality: 0.05 });
        const high = await r.capture({ type: 'jpeg', quality: 1 });
        equal(low.type, 'image/jpeg', 'a JPEG when asked');
        ok(low.size < high.size, 'a lower quality encodes smaller');
        // What a crop over the point shows is the point, as drawn.
        const s = r.query.project(pos);
        const around = { x: s.x - 4, y: s.y - 4, width: 8, height: 8 };
        const bitmap = await createImageBitmap(
          await r.capture({ crop: around }),
        );
        const canvas = new OffscreenCanvas(8, 8);
        const g = canvas.getContext('2d');
        g.drawImage(bitmap, 0, 0);
        bitmap.close();
        const [red, green, blue] = g.getImageData(4, 4, 1, 1).data;
        ok(
          red > 200 && green < 60 && blue < 60,
          `the point is in the crop (${red}, ${green}, ${blue})`,
        );
        off();
        // Where the renderer keeps its frame it reads it; otherwise it may
        // draw again to read.
        const gl =
          r.canvas.getContext?.('webgl2') ?? r.canvas.getContext?.('webgl');
        if (gl?.getContextAttributes?.()?.preserveDrawingBuffer === true)
          equal(frames, 0, 'no frame drawn for a capture of a kept frame');
        set.dispose();
      },
    ),
    check(
      'renderer.resize',
      'resize follows the container: the lens and the frame read take its new size',
      async (h, r) => {
        if (!h.resizeContainer)
          return { skip: 'the harness cannot resize the container' };
        await overAustin(h, r);
        // A new aspect too, so a lens left as it was shows.
        const size = { width: 480, height: 320 };
        await h.resizeContainer(r, size);
        r.resize();
        await drawn(h, r);
        near(
          r.camera.pose().aspectRatio,
          size.width / size.height,
          1e-6,
          'the aspect is the container’s',
        );
        const full = r.readPixels({ scale: 0.1 });
        deepEqual(
          [full.width, full.height],
          [size.width / 10, size.height / 10],
          'the frame is the container’s size',
        );
      },
    ),
    check(
      'frame.setTargetFps',
      'setTargetFps caps the loop; diagnostics say the cap, 0 the display rate',
      (h, r) => {
        r.frame.setTargetFps(24);
        equal(r.frame.diagnostics().targetFps, 24, 'capped');
        r.frame.setTargetFps(0);
        equal(r.frame.diagnostics().targetFps, 0, 'the display’s rate');
      },
    ),
    check(
      'globe.setTerrain',
      'setTerrain to the ellipsoid, exaggerated or not, resolves and leaves the globe settling',
      async (h, r) => {
        await r.globe.setTerrain({ kind: 'ellipsoid', exaggeration: 2 });
        await r.globe.setTerrain({ kind: 'ellipsoid' });
        await overAustin(h, r);
        await drawn(h, r);
        const result = await r.whenSettled({ timeoutMs: 10_000 });
        ok(
          !result.blockers.includes('terrain'),
          `the ellipsoid has nothing to load (${result.blockers})`,
        );
      },
    ),
    check(
      'globe.setPhotoreal',
      'setPhotoreal(null) turns photoreal off: its status is route none',
      async (h, r) => {
        const status = await r.globe.setPhotoreal(null);
        equal(status.route, 'none', 'off');
      },
    ),
    check(
      'globe.progress',
      'progress listeners hear counts of what is loading, and their Off ends them',
      async (h, r) => {
        const heard = [];
        const off = r.globe.on('progress', (p) => heard.push(p));
        equal(typeof off, 'function', 'an Off');
        await overAustin(h, r);
        // Something to load: an image over the view.
        const over = (url) =>
          r.globe.imagery.add({
            kind: 'single-image',
            url,
            rectangle: {
              west: AUSTIN.lon - 1,
              south: AUSTIN.lat - 1,
              east: AUSTIN.lon + 1,
              north: AUSTIN.lat + 1,
            },
          });
        const layer = over(PIXEL_PNGS[0]);
        // Frames until the load is heard, or a while passes: a renderer may
        // first say nothing loads, before it starts on the image. The image
        // loads in time of its own, so each frame lets some pass.
        const loading = (p) =>
          p.tilesPending + p.imageryPending + p.terrainPending > 0;
        const until = Date.now() + 10_000;
        for (let i = 0; !heard.some(loading) && i < 600; i++) {
          if (Date.now() > until) break;
          await drawn(h, r, 1);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        ok(heard.some(loading), 'a load is heard');
        for (const p of heard)
          for (const key of [
            'tilesPending',
            'imageryPending',
            'terrainPending',
          ])
            ok(p[key] >= 0, `${key} is a count (${p[key]})`);
        off();
        const before = heard.length;
        layer.remove();
        const again = over(PIXEL_PNGS[1]);
        await overAustin(h, r, 9000);
        await drawn(h, r);
        equal(heard.length, before, 'none after its Off');
        again.remove();
      },
    ),
    check(
      'effects.setStyleParams',
      'a style’s parameters change what it draws',
      async (h, r) => {
        if (h.pixels === false) return { skip: 'no pixels to read' };
        const off = r.effects.defineStyle({
          id: 'conf:fill',
          params: [{ key: 'red', min: 0, max: 1, default: 0 }],
          animated: false,
          shader: {
            glsl: `uniform float red;
void main() {
  out_FragColor = vec4(red, 0.0, 0.0, 1.0);
}`,
            wgsl: `@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(params.red, 0.0, 0.0, 1.0);
}`,
          },
        });
        try {
          await overAustin(h, r);
          // Below the eye, in the units `readPixels` crops in.
          const below = r.query.project(h.toEcef({ ...AUSTIN, height: 0 }));
          ok(below, 'the ground below projects');
          const red = async () => {
            await settled(r);
            r.frame.renderNow();
            const px = r.readPixels({
              crop: {
                x: Math.round(below.x),
                y: Math.round(below.y),
                width: 1,
                height: 1,
              },
            });
            return px.data[0];
          };
          r.effects.setStyleIntensity('conf:fill', 1);
          r.effects.setStyle('conf:fill', { red: 0 });
          ok((await red()) < 30, 'its default draws black');
          r.effects.setStyleParams('conf:fill', { red: 1 });
          ok((await red()) > 225, 'red once its parameter is 1');
          r.effects.setStyle(null);
          r.effects.setStyleIntensity('conf:fill', 0);
        } finally {
          off();
        }
      },
      { capability: 'styles' },
    ),
    check(
      'effects.bloom',
      'bloom on lists its pass, off drops it; the strength is kept',
      (h, r) => {
        const passes = () => r.effects.diagnostics().passes;
        r.effects.bloom({ enabled: true, strength: 0.4 });
        ok(passes().includes('bloom'), 'drawn while on');
        r.effects.bloom({ enabled: false });
        ok(!passes().includes('bloom'), 'not while off');
        r.effects.bloom({ enabled: true });
        ok(passes().includes('bloom'), 'on again at the kept strength');
        r.effects.bloom({ enabled: false });
      },
      { capability: 'bloom' },
    ),
    check(
      'effects.sharpen',
      'sharpen on lists its pass, off drops it',
      (h, r) => {
        const passes = () => r.effects.diagnostics().passes;
        r.effects.sharpen({ enabled: true, amount: 0.5 });
        ok(passes().includes('sharpen'), 'drawn while on');
        r.effects.sharpen({ enabled: false });
        ok(!passes().includes('sharpen'), 'not while off');
      },
      { capability: 'sharpen' },
    ),
    check(
      'quality.probe',
      'probe says the device, the browser and the knobs',
      (h, r) => {
        const probe = r.quality.probe();
        ok(
          ['webgl1', 'webgl2', 'webgpu'].includes(probe.device.backend),
          `a backend (${probe.device.backend})`,
        );
        ok(probe.device.maxTextureSize > 0, 'a texture size');
        ok(probe.browser.devicePixelRatio > 0, 'a pixel ratio');
        equal(typeof probe.browser.touchOnly, 'boolean', 'touch only or not');
        deepEqual(
          probe.knobs.map((k) => k.key),
          r.quality.knobs().map((k) => k.key),
          'the knobs, as knobs() lists them',
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
      'quality.signals.gpuTiming',
      'with gpuTiming, drawn frames come to carry their GPU time; without it they never do',
      async (h, r) => {
        const timed = r.capabilities.has('gpuTiming');
        equal(
          r.quality.signals.gpuTiming !== 'none',
          timed,
          'gpuTiming says whether frames are timed',
        );
        equal(r.quality.device().gpuTimer, timed, 'device facts agree');
        const signals = [];
        const off = r.quality.signals.on('frame', (s) => signals.push(s));
        for (let i = 0; i < 30 && !signals.some((s) => 'gpuMs' in s); i++)
          await drawn(h, r, 1);
        off();
        const gpu = signals.filter((s) => 'gpuMs' in s);
        if (timed) {
          ok(gpu.length > 0, 'a GPU time came back within 30 frames');
          ok(
            gpu.every((s) => Number.isFinite(s.gpuMs) && s.gpuMs >= 0),
            'GPU times are milliseconds',
          );
        } else equal(gpu.length, 0, 'no GPU time without gpuTiming');
        if (!timed) return;
        const without = await h.create({
          viewport: SCRIPT_VIEWPORT,
          capabilities: CAPABILITIES.filter((c) => c !== 'gpuTiming'),
        });
        if (!without) return;
        try {
          equal(without.quality.signals.gpuTiming, 'none', 'none without it');
        } finally {
          without.destroy();
        }
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
