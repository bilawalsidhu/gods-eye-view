// Shared pieces of the strict contract scenarios (qa-strict-*.mjs): a fixed
// layer session, its identity checks, the first-frame probe and the WebGL
// object counters. Everything runs on the existing test hooks
// (window.__godsEyeView); nothing here changes the application.

import assert from 'node:assert/strict';
import { waitForEngine } from './qa-strict-harness.mjs';

/** Austin, 12 km up, OpenStreetMap (answered by the tile disk cache). */
export const SESSION_HASH =
  'v=2&lat=30.27&lon=-97.74&alt=12000&heading=0&pitch=-90&map=osm&l=';

/**
 * In-page fixtures for the session layers: one Austin earthquake, `flights`
 * aircraft in a grid around Austin, `military` aircraft, no vessels.
 * The counters on window.__qaReads show every source read.
 */
export async function installSessionFixtures(
  page,
  { flights = 1, military = 1 } = {},
) {
  await page.evaluateOnNewDocument(
    (flights, military) => {
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
      window.__qaReads = { quakes: 0, flights: 0, military: 0 };
      const fetch = window.fetch.bind(window);
      const side = Math.ceil(Math.sqrt(flights));
      window.fetch = (input, options) => {
        const url = new URL(input?.url ?? input, document.baseURI);
        const now = Math.floor(Date.now() / 1000);
        if (url.hostname === 'earthquake.usgs.gov') {
          window.__qaReads.quakes++;
          return Promise.resolve(
            Response.json({
              type: 'FeatureCollection',
              features: [
                {
                  type: 'Feature',
                  id: 'qa-austin',
                  properties: { mag: 4.1, time: Date.now(), place: 'Austin' },
                  geometry: { type: 'Point', coordinates: [-97.74, 30.27, 8] },
                },
              ],
            }),
          );
        }
        if (url.pathname === '/api/flights') {
          window.__qaReads.flights++;
          const states = [];
          for (let i = 0; i < flights; i++)
            states.push([
              (0xa00000 + i).toString(16),
              'QA' + i,
              'QA',
              now,
              now,
              -99.5 + ((i % side) / side) * 3.5,
              28.5 + (Math.floor(i / side) / side) * 3.5,
              3000 + (i % 40) * 250,
              false,
              180 + (i % 50),
              (i * 37) % 360,
              0,
              null,
              3000 + (i % 40) * 250,
              null,
              false,
              0,
            ]);
          return Promise.resolve(Response.json({ time: now, states }));
        }
        if (url.pathname === '/api/military') {
          window.__qaReads.military++;
          return Promise.resolve(
            Response.json({
              now: Date.now(),
              ac: Array.from({ length: military }, (_, i) => ({
                hex: (0xae0000 + i).toString(16),
                flight: 'QAMIL' + i,
                lon: -97.9 + i * 0.01,
                lat: 30.1 + i * 0.01,
                alt_geom: 20000,
                alt_baro: 20000,
                gs: 300,
                track: 90,
                seen: 0,
                seen_pos: 0,
                dbFlags: 1,
                type: 'adsb_icao',
              })),
            }),
          );
        }
        if (url.pathname.startsWith('/api/flights/'))
          return Promise.resolve(Response.json({ path: [] }));
        if (url.pathname === '/api/vessels')
          return Promise.resolve(Response.json({ status: 'live', rows: [] }));
        return fetch(input, options);
      };
    },
    flights,
    military,
  );
}

/**
 * Open the app on `engine` with the session hash (and `search`, more query
 * parameters such as `&parkedMs=3000`) and wait until it runs.
 */
export async function openApp(
  page,
  origin,
  engine,
  hash = SESSION_HASH,
  search = '',
) {
  const url = new URL(origin);
  url.search = `?engine=${engine}&welcome=0${search}`;
  url.hash = hash;
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await waitForEngine(page, engine);
  await page.evaluate(() => {

    window.__qaEngines = new Map([
      [window.__godsEyeView.engine.kind, window.__godsEyeView.engine],
    ]);
  });
}

/** Enable `layers` and remember the session's identity. */
export async function startSession(page, layers) {
  await page.evaluate(async (layers) => {
    const { dataManager } = window.__godsEyeView;
    for (const id of layers)
      await dataManager.setEnabled(id, true, { origin: 'user' });
    window.__qaSession = {
      manager: dataManager,
      models: new Map(
        [...dataManager.layers].map(([id, entry]) => [id, entry.module]),
      ),
      enabled: [...dataManager.getEnabledLayerIds()].sort(),
    };
  }, layers);
}

/**
 * The session as the page has it now against the one startSession saw:
 * the same manager, every layer model, the same enabled layers.
 */
export function sessionState(page) {
  return page.evaluate(() => {
    const app = window.__godsEyeView;
    const session = window.__qaSession;
    if (!app) return { running: false };
    const { dataManager } = app;
    return {
      running: true,
      engine: app.engine.kind,
      manager: dataManager === session.manager,
      models:
        session.models.size === dataManager.layers.size &&
        [...session.models].every(
          ([id, model]) => dataManager.layers.get(id)?.module === model,
        ),
      enabled:
        JSON.stringify([...dataManager.getEnabledLayerIds()].sort()) ===
        JSON.stringify(session.enabled),
      address: new URL(location.href).searchParams.get('engine'),
      picker: document.querySelector('#globe-engine')?.value ?? null,
      history: history.length,
    };
  });
}

/** Assert the session is intact on `engine`. */
export async function assertSession(page, engine, message) {
  const state = await sessionState(page);
  assert.deepEqual(
    {
      running: state.running,
      engine: state.engine,
      manager: state.manager,
      models: state.models,
      enabled: state.enabled,
      address: state.address,
      picker: state.picker,
    },
    {
      running: true,
      engine,
      manager: true,
      models: true,
      enabled: true,
      address: engine,
      picker: engine,
    },
    message,
  );
  return state;
}

/** Remember the running engine object under its kind (for warm switches). */
export function rememberEngine(page) {
  return page.evaluate(() => {
    const { engine } = window.__godsEyeView;
    window.__qaEngines.set(engine.kind, engine);
    return engine.kind;
  });
}

/**
 * Install (before navigation) the first-frame probe:
 * window.__qaFirstFrame(kind) resolves with the performance.now() times of
 * the first frame of the `kind` engine that is drawn into its connected
 * canvas with a non-blank picture (postRender, the canvas read back in the
 * same task: more than 1% of a 48x48 sample differs from its first pixel),
 * and of the animation frame after it (presented).
 */
export async function installFirstFrameProbe(page) {
  await page.evaluateOnNewDocument(() => {
    window.__qaFirstFrame = (kind) =>
      new Promise((resolve) => {
        const probe = document.createElement('canvas');
        probe.width = probe.height = 48;
        const context = probe.getContext('2d', { willReadFrequently: true });
        const nonBlank = (canvas) => {
          try {
            context.clearRect(0, 0, 48, 48);
            context.drawImage(canvas, 0, 0, 48, 48);
            const d = context.getImageData(0, 0, 48, 48).data;
            let differing = 0;
            for (let i = 4; i < d.length; i += 4)
              if (
                Math.abs(d[i] - d[0]) +
                  Math.abs(d[i + 1] - d[1]) +
                  Math.abs(d[i + 2] - d[2]) >
                24
              )
                differing++;
            return differing > 23;
          } catch {
            return false;
          }
        };
        let attached = null;
        let remove = () => {};
        const attach = (engine) => {
          attached = engine;
          remove = engine.frames.postRender.addEventListener(() => {
            if (!engine.host.canvas.isConnected) return;
            if (!nonBlank(engine.host.canvas)) return;
            const drawn = performance.now();
            remove();
            clearInterval(timer);
            requestAnimationFrame(() =>
              resolve({ drawn, presented: performance.now() }),
            );
          });
        };
        const known = window.__qaEngines?.get(kind);
        if (known) attach(known);
        // A cold engine: attach as soon as the page exposes it.
        const timer = setInterval(() => {
          const engine = window.__godsEyeView?.engine;
          if (!attached && engine?.kind === kind) attach(engine);
        }, 2);
      });
  });
}

/**
 * Count live WebGL objects per context (before navigation): every
 * create/delete pair of buffers, textures, programs, shaders,
 * framebuffers, renderbuffers and vertex arrays (WebGL2 and the OES
 * extension), per context, on window.__qaGl.
 */
export async function installWebGlCounters(page) {
  await page.evaluateOnNewDocument(() => {
    const KINDS = {
      Buffer: 'buffers',
      Texture: 'textures',
      Program: 'programs',
      Shader: 'shaders',
      Framebuffer: 'framebuffers',
      Renderbuffer: 'renderbuffers',
      VertexArray: 'vaos',
    };
    const entries = new WeakMap();
    const live = new WeakSet();
    const contexts = [];
    window.__qaGl = { contexts };
    const fresh = () =>
      Object.fromEntries(Object.values(KINDS).map((key) => [key, 0]));
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      const context = getContext.call(this, type, ...args);
      if (context && /webgl/i.test(type) && !entries.has(context)) {
        const entry = {
          canvas: this,
          context,
          type,
          live: fresh(),
          created: fresh(),
        };
        entries.set(context, entry);
        contexts.push(entry);
      }
      return context;
    };
    const wrap = (target, create, destroy, key, owner = (self) => self) => {
      const make = target[create];
      const drop = target[destroy];
      if (typeof make !== 'function') return;
      target[create] = function (...args) {
        const object = make.apply(this, args);
        const entry = entries.get(owner(this));
        if (object && entry) {
          entry.live[key]++;
          entry.created[key]++;
          live.add(object);
        }
        return object;
      };
      target[destroy] = function (object, ...args) {
        const entry = entries.get(owner(this));
        if (object && entry && live.has(object)) {
          live.delete(object);
          entry.live[key]--;
        }
        return drop.call(this, object, ...args);
      };
    };
    for (const proto of [
      WebGLRenderingContext.prototype,
      globalThis.WebGL2RenderingContext?.prototype,
    ].filter(Boolean))
      for (const [name, key] of Object.entries(KINDS))
        wrap(proto, 'create' + name, 'delete' + name, key);
    // WebGL1 vertex arrays come from an extension object.
    const getExtension = WebGLRenderingContext.prototype.getExtension;
    const vaoOwners = new WeakMap();
    WebGLRenderingContext.prototype.getExtension = function (name, ...args) {
      const extension = getExtension.call(this, name, ...args);
      if (
        extension &&
        name === 'OES_vertex_array_object' &&
        !vaoOwners.has(extension)
      ) {
        vaoOwners.set(extension, this);
        wrap(
          extension,
          'createVertexArrayOES',
          'deleteVertexArrayOES',
          'vaos',
          (self) => vaoOwners.get(self),
        );
      }
      return extension;
    };
    window.__qaGlCounts = () => {
      const engines = window.__qaEngines ?? new Map();
      return contexts.map((entry) => {
        let owner = 'other';
        for (const [kind, engine] of engines)
          if (engine.host?.canvas === entry.canvas) owner = kind;
        return {
          owner,
          connected: entry.canvas.isConnected,
          lost: entry.context.isContextLost(),
          total: Object.values(entry.live).reduce((a, b) => a + b, 0),
          ...entry.live,
        };
      });
    };
  });
}

/** Least-squares slope of y over x. */
export function slope(points) {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((s, p) => s + p[0], 0) / n;
  const my = points.reduce((s, p) => s + p[1], 0) / n;
  let num = 0,
    den = 0;
  for (const [x, y] of points) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den ? num / den : 0;
}

/** The q-quantile (nearest rank) of numbers. */
export function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
}
