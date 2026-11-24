/**
 * @module render/cesium/cardPreviews
 * @description The Context card's previews on the Cesium renderer: an
 * aircraft's model turning on its own, its route on a small globe, and the
 * view ahead from its cockpit. Each draws in a small Cesium scene of its own
 * inside the element it is given, and is torn down with the card. The
 * application reaches them through the `cardPreviews` application hook
 * (`render/applicationHooks.js`); the card's words, figures and HUD stay
 * the application's.
 *
 * Every preview is `{setActive(active), update(values), destroy()}`: a
 * hidden one stops drawing and rests on its last frame, and shown again it
 * draws once straight away so there is no gap. A preview that cannot be
 * made calls its `onFailed`.
 */
import * as Cesium from 'cesium';
import { webglContext } from './internals.js';
import { createEsriImagery } from './mapImagery.js';

/**
 * Destroy a preview's widget and free its WebGL context. A browser keeps
 * only a handful of contexts open and drops the oldest, the main globe's,
 * when there are too many; a destroyed widget's context is otherwise freed
 * only when garbage is collected, so flicking through cards could push the
 * globe's out.
 * @param {Cesium.CesiumWidget|null} widget
 */
function destroyWidget(widget) {
  if (!widget || widget.isDestroyed()) return;
  let gl = null;
  try {
    gl = webglContext(widget.scene) ?? null;
  } catch {
    gl = null;
  }
  widget.destroy();
  try {
    gl?.getExtension?.('WEBGL_lose_context')?.loseContext();
  } catch {
    // Nothing more can be done; the context goes when it is collected.
  }
}

/** A small widget with no input, credits or render-loop error panel. */
function createWidget(container, options) {
  const widget = new Cesium.CesiumWidget(container, {
    skyBox: false,
    scene3DOnly: true,
    shadows: false,
    showRenderLoopErrors: false,
    // The globe's own credits already show; a preview's go in its corner.
    creditContainer: document.createElement('div'),
    ...options,
  });
  widget.scene.screenSpaceCameraController.enableInputs = false;
  return widget;
}

/**
 * Stops a hidden widget's render loop once `ready()` says it has something
 * to rest on; shown again, it draws once at once.
 */
function renderLoopSwitch(widget, ready = () => true) {
  let active = true;
  const sync = () => {
    if (widget.isDestroyed()) return;
    const run = active || !ready();
    if (run && !widget.useDefaultRenderLoop) {
      widget.resize();
      widget.render();
    }
    widget.useDefaultRenderLoop = run;
  };
  return {
    sync,
    set(next) {
      active = Boolean(next);
      sync();
    },
  };
}

const reducedMotion = () =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

// ── The turning model ──────────────────────────────────────────────────

/** How long each look lasts, and each reveal between them, in turns. */
const PLAIN_TURNS = 1;
const SCAN_TURNS = 0.3;
const REVEAL_TURNS = 0.07;
/** How long (ms) the plain model holds after the reveal before a cycle ends. */
const HOLD_MS = 700;
/** How fast the model turns, in radians a millisecond (about 0.3 a second). */
const TURN_PER_MS = 0.0003;

// Model space, normalised so the craft reaches about 1.7 from its centre.
// u_reveal runs 0 to 2: from 0 to 1 the edge grows from the centre and
// leaves wire inside it; at 1 it is all wire; from 1 to 2 it grows again and
// leaves the model inside it. Outside that range the model draws as it is.
const LOOK_SHADER = `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
  if (u_reveal <= 0.0 || u_reveal >= 2.0) return;
  vec3 p = fsInput.attributes.positionMC / u_half;
  bool entering = u_reveal < 1.0;
  float r = length(p);
  float front = mix(0.0, 1.8, entering ? u_reveal : u_reveal - 1.0);
  float edge = 1.0 - smoothstep(0.0, 0.05, abs(r - front));
  vec3 white = vec3(0.9, 0.96, 1.0);
  bool wire = entering ? r < front : r > front;
  if (!wire) {
    material.emissive += white * edge * 1.4;
    return;
  }
  // A fine grid: many small cells, hairline lines.
  vec3 q = p * 18.0;
  vec3 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec3(1e-4));
  float line = (1.0 - clamp(min(min(g.x, g.y), g.z) * 2.4, 0.0, 1.0)) * 0.7;
  vec3 base = material.diffuse;
  // Opaque: a near-black body with white lines on it and its own colour
  // faintly through, which reads as a wireframe against the dark card (a
  // translucent model does not blend onto this scene's transparent canvas).
  material.diffuse = base * 0.12 + vec3(0.015, 0.02, 0.03);
  material.specular = vec3(0.0);
  material.emissive = white * line + base * 0.35 + white * edge * 1.4;
}`;

/**
 * An aircraft's model turning slowly, with no globe, sky or imagery. Its
 * look changes as it turns: a whole rotation as it is, then a short
 * wireframe scan (under a third of a turn), then round again; each change is
 * a reveal, a bright ring growing from the craft's centre to its edges. One
 * custom shader does it, driven by a uniform, because a shader set on a
 * model after it is ready does nothing in this Cesium. Under reduced motion
 * there is no scan.
 *
 * `onPhase('plain'|'scan')` says when the look changes; `onCycle(ms)` when a
 * look and its scan end, with the drawing time they took, so the card can
 * give another view the same time.
 * @param {HTMLElement} container
 * @param {{gltf: Uint8Array|ArrayBuffer, basePath?: string, heading?: number,
 *   viewRange?: number}} model The GLB's bytes; the heading (degrees) it
 *   starts facing; how far the camera stands, in bounding radii.
 * @param {{onPhase?: (phase: string) => void, onCycle?: (ms: number) => void,
 *   onFailed?: () => void}} [events]
 */
function modelPreview(
  container,
  { gltf, basePath, heading = 0, viewRange = 1.9 },
  { onPhase = () => {}, onCycle = () => {}, onFailed = () => {} } = {},
) {
  let widget = null;
  let model = null;
  let loaded = false;
  let removeTick = null;
  let loop = null;
  const fail = () => {
    if (!widget) return;
    onFailed();
  };
  try {
    widget = createWidget(container, {
      globe: false,
      skyAtmosphere: false,
      baseLayer: false,
      contextOptions: { webgl: { alpha: true, antialias: true } },
    });
    const { scene } = widget;
    scene.backgroundColor = Cesium.Color.TRANSPARENT;
    scene.light = new Cesium.DirectionalLight({
      direction: Cesium.Cartesian3.normalize(
        new Cesium.Cartesian3(-0.4, -0.6, -0.7),
        new Cesium.Cartesian3(),
      ),
      intensity: 2.4,
    });
    loop = renderLoopSwitch(widget, () => loaded);
  } catch {
    onFailed();
    return { setActive() {}, update() {}, destroy() {} };
  }

  const shader = new Cesium.CustomShader({
    uniforms: {
      u_reveal: { type: Cesium.UniformType.FLOAT, value: 0 },
      u_half: { type: Cesium.UniformType.FLOAT, value: 20 },
    },
    fragmentShaderText: LOOK_SHADER,
  });
  const origin = Cesium.Cartesian3.fromDegrees(0, 0, 0);

  const start = (sphere) => {
    // The craft reaches about 0.6 of its bounding radius from the centre.
    shader.setUniform('u_half', sphere.radius * 0.6);
    const first = Cesium.Math.toRadians(heading + 140);
    let turn = first;
    let phase = 'plain';
    let cycleMs = 0;
    let lastFrame = performance.now();
    let holdMs = null;
    const still = reducedMotion();
    const range = sphere.radius * viewRange;
    const pitch = Cesium.Math.toRadians(-18);
    const ease = (x) => x * x * (3 - 2 * x);
    const frame = () => {
      // Only time spent drawing counts: a hidden preview stops drawing.
      const now = performance.now();
      const drawn = now - lastFrame < 250 ? now - lastFrame : 0;
      lastFrame = now;
      // A steady turn whatever the display's refresh rate; still under
      // reduced motion.
      if (!still) turn += TURN_PER_MS * drawn;
      const turns = (turn - first) / (2 * Math.PI);
      // Where in the scan it is, and from that how far each reveal has gone.
      const into = (turns % (PLAIN_TURNS + SCAN_TURNS)) - PLAIN_TURNS;
      let reveal = 0;
      if (!still && into >= 0) {
        if (into < REVEAL_TURNS) reveal = ease(into / REVEAL_TURNS);
        else if (into > SCAN_TURNS - REVEAL_TURNS)
          reveal =
            1 + ease((into - (SCAN_TURNS - REVEAL_TURNS)) / REVEAL_TURNS);
        else reveal = 1;
      }
      const next = reveal > 0 && reveal < 2 ? 'scan' : 'plain';
      cycleMs += drawn;
      // The cycle ends once the reveal back to the model has finished and
      // the plain model has held a moment, never mid-reveal.
      if (phase === 'scan' && next === 'plain') holdMs = 0;
      if (holdMs !== null && next === 'plain') {
        holdMs += drawn;
        if (holdMs >= HOLD_MS) {
          onCycle(cycleMs);
          cycleMs = 0;
          holdMs = null;
        }
      }
      if (next !== phase) {
        phase = next;
        onPhase(phase);
      }
      shader.setUniform('u_reveal', reveal);
      widget.camera.lookAt(
        sphere.center,
        new Cesium.HeadingPitchRange(turn, pitch, range),
      );
    };
    frame();
    removeTick = widget.scene.preRender.addEventListener(frame);
    widget.render();
    loaded = true;
    loop.sync();
  };

  Cesium.Model.fromGltfAsync({
    gltf,
    basePath,
    customShader: shader,
    modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(origin),
    // A light rim so the mesh reads against the dark card.
    silhouetteColor: Cesium.Color.WHITE.withAlpha(0.3),
    silhouetteSize: 1,
  }).then((made) => {
    if (!widget) {
      made.destroy();
      return;
    }
    model = widget.scene.primitives.add(made);
    model.readyEvent.addEventListener(() => {
      if (widget) start(model.boundingSphere);
    });
    model.errorEvent?.addEventListener?.(fail);
  }, fail);

  function move(atNow) {
    const at = onRoute(from, to, atNow);
    if (!widget || !at || !plane || flyingIn) return;
    pose(plane, at);
    if (flownLine) flownLine.polyline.positions = arc(from, at, 48);
    if (aheadLine) aheadLine.polyline.positions = arc(at, to);
    widget.scene.requestRender();
  }

  return {
    setActive: (active) => loop.set(active),
    update() {},
    destroy() {
      removeTick?.();
      removeTick = null;
      const gone = widget;
      widget = null;
      model = null;
      destroyWidget(gone);
    },
  };
}

// ── The route globe ────────────────────────────────────────────────────

const CYAN = Cesium.Color.fromCssColorString('#36dcff');
const AMBER = Cesium.Color.fromCssColorString('#ffb86b');
/** Height (m) the route and the plane are drawn at, clear of the globe. */
const ROUTE_HEIGHT_M = 30_000;

// The plane: the Material "flight" silhouette, nose up (north), white with
// a cyan glow, drawn once as an image.
const PLANE_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 32 32" width="64" height="64">' +
    '<defs><filter id="g" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.4"/></filter></defs>' +
    '<path filter="url(#g)" fill="#36dcff" d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>' +
    '<path fill="#ffffff" stroke="#0b1820" stroke-width="0.6" d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>' +
    '</svg>',
)}`;

/**
 * An airport's code as an image, white with a dark outline, at the page's
 * pixel ratio. The preview is a small scene of its own, so its two codes are
 * drawn into it rather than on the world overlay, which belongs to the globe.
 * @param {string} code
 * @returns {{image: HTMLCanvasElement, width: number, height: number}}
 *   the image and its size on screen, CSS pixels
 */
function codeImage(code) {
  const ratio = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
  const font = `600 ${11 * ratio}px ui-monospace, monospace`;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  context.font = font;
  const pad = 3 * ratio;
  canvas.width = Math.ceil(context.measureText(code).width + pad * 2);
  canvas.height = Math.ceil(15 * ratio);
  context.font = font;
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.lineWidth = 3 * ratio;
  context.strokeStyle = '#000';
  context.fillStyle = '#fff';
  context.strokeText(code, pad, canvas.height / 2);
  context.fillText(code, pad, canvas.height / 2);
  return {
    image: canvas,
    width: canvas.width / ratio,
    height: canvas.height / ratio,
  };
}

/** The initial bearing (degrees from north) of the great circle a → b. */
function bearing(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
  const x =
    Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) *
      Math.cos(b.lat * rad) *
      Math.cos((b.lon - a.lon) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

const geodesic = (a, b) =>
  new Cesium.EllipsoidGeodesic(
    Cesium.Cartographic.fromDegrees(a.lon, a.lat),
    Cesium.Cartographic.fromDegrees(b.lon, b.lat),
  );

/** Points along the great circle from a to b, as far as `upTo` (0 to 1). */
function arc(a, b, steps = 64, upTo = 1) {
  const line = geodesic(a, b);
  const out = [];
  const n = Math.max(2, Math.round(steps * upTo));
  for (let i = 0; i <= n; i++) {
    const c = line.interpolateUsingFraction((i / n) * upTo);
    out.push(
      Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, ROUTE_HEIGHT_M),
    );
  }
  return out;
}

/**
 * The point on the great circle from `from` to `to` nearest the craft. The
 * craft is drawn there and the route split there, so the path stays one
 * smooth arc: a craft a little off the direct line (vectors, airways, a
 * detour) would otherwise bend it into a sharp corner.
 */
function onRoute(from, to, at) {
  if (!at || !Number.isFinite(at.lat) || !Number.isFinite(at.lon)) return null;
  const route = geodesic(from, to);
  const here = Cesium.Cartesian3.fromDegrees(at.lon, at.lat);
  const point = new Cesium.Cartesian3();
  let best = null;
  let bestDistance = Infinity;
  const STEPS = 200;
  for (let i = 0; i <= STEPS; i++) {
    const c = route.interpolateUsingFraction(i / STEPS);
    Cesium.Cartesian3.fromRadians(
      c.longitude,
      c.latitude,
      0,
      Cesium.Ellipsoid.WGS84,
      point,
    );
    const d = Cesium.Cartesian3.distanceSquared(here, point);
    if (d < bestDistance) {
      bestDistance = d;
      best = {
        lat: Cesium.Math.toDegrees(c.latitude),
        lon: Cesium.Math.toDegrees(c.longitude),
      };
    }
  }
  return best;
}

/**
 * The plane's billboard pose, nose along `deg` from north: the icon's up is
 * tied to the local north on the globe and turned from there, so it points
 * the right way in this tilted view too.
 */
function planePose(at, deg) {
  const position = Cesium.Cartesian3.fromDegrees(
    at.lon,
    at.lat,
    ROUTE_HEIGHT_M,
  );
  const frame = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const north = Cesium.Matrix4.getColumn(frame, 1, new Cesium.Cartesian4());
  return {
    position,
    rotation: -Cesium.Math.toRadians(deg),
    alignedAxis: new Cesium.Cartesian3(north.x, north.y, north.z),
  };
}

/**
 * A flight's route on a small globe: the great circle from origin to
 * destination, solid where it has flown and dashed ahead, the two airports
 * marked with their codes, and a plane where the craft is now, pointing at
 * the destination. On opening, the flown part draws out from the origin to
 * the craft. The globe uses Cesium's bundled Natural Earth image, so it
 * fetches no map tiles. It holds still, north up and framed on the route.
 * @param {HTMLElement} container
 * @param {{from: {code?: string, lat: number, lon: number},
 *   to: {code?: string, lat: number, lon: number},
 *   at?: {lat: number, lon: number}|null}} route
 * @param {{onFailed?: () => void}} [events]
 */
function routePreview(container, route, { onFailed = () => {} } = {}) {
  let widget = null;
  let loop = null;
  let { from, to } = route;
  let plane = null;
  let flownLine = null;
  let aheadLine = null;
  let removeGrow = null;
  /** True while the plane flies in from the origin; moves wait for it. */
  let flyingIn = false;
  /** The craft's latest position, kept through the fly-in and the load. */
  let latest = route.at;

  const pose = (entity, where) => {
    const next = planePose(where, bearing(where, to));
    entity.position = next.position;
    entity.billboard.rotation = next.rotation;
    entity.billboard.alignedAxis = next.alignedAxis;
  };

  const draw = (atNow) => {
    if (!widget) return;
    const at = onRoute(from, to, atNow);
    const { entities, scene } = widget;
    removeGrow?.();
    removeGrow = null;
    entities.removeAll();
    plane = flownLine = null;
    const pin = (place, color) =>
      entities.add({
        position: Cesium.Cartesian3.fromDegrees(place.lon, place.lat),
        point: {
          pixelSize: 7,
          color,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
        },
        ...(place.code
          ? {
              billboard: {
                ...codeImage(place.code),
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(0, -6),
              },
            }
          : {}),
      });
    pin(from, CYAN.withAlpha(0.9));
    pin(to, AMBER);

    // Ahead of the craft, dashed; behind it, solid, drawing out on open.
    aheadLine = entities.add({
      polyline: {
        positions: arc(at || from, to),
        width: 1.5,
        material: new Cesium.PolylineDashMaterialProperty({
          color: AMBER.withAlpha(0.8),
          dashLength: 10,
        }),
        arcType: Cesium.ArcType.NONE,
      },
    });
    if (at) {
      let progress = 0;
      const flown = (flownLine = entities.add({
        polyline: {
          positions: new Cesium.CallbackProperty(
            () => arc(from, at, 48, Math.max(0.02, progress)),
            false,
          ),
          width: 2.5,
          material: new Cesium.PolylineGlowMaterialProperty({
            color: CYAN,
            glowPower: 0.25,
          }),
          arcType: Cesium.ArcType.NONE,
        },
      }));
      // The plane starts at the origin and flies out along the flown line
      // as it draws, arriving where the craft is now.
      const first = planePose(from, bearing(from, to));
      plane = entities.add({
        position: first.position,
        billboard: {
          image: PLANE_ICON,
          width: 26,
          height: 26,
          rotation: first.rotation,
          alignedAxis: first.alignedAxis,
        },
      });
      const leg = geodesic(from, at);
      const ease = (x) => 1 - (1 - x) ** 3;
      // The fly-in waits until the globe has drawn (its imagery loads a
      // moment after the card opens), at most 1.5 s, so it is seen from the
      // start. Under reduced motion it is there at once.
      let began = reducedMotion() ? -Infinity : null;
      const opened = performance.now();
      flyingIn = true;
      const grow = () => {
        if (began === null) {
          if (!scene.globe.tilesLoaded && performance.now() - opened < 1500)
            return;
          began = performance.now();
        }
        const raw = Math.min(1, (performance.now() - began) / 1600);
        progress = ease(raw);
        const c = leg.interpolateUsingFraction(progress);
        pose(plane, {
          lat: Cesium.Math.toDegrees(c.latitude),
          lon: Cesium.Math.toDegrees(c.longitude),
        });
        if (raw >= 1) {
          flyingIn = false;
          flown.polyline.positions = arc(from, at, 48);
          removeGrow?.();
          removeGrow = null;
          // The craft may have moved on while the plane flew in.
          move(latest);
        }
      };
      removeGrow = scene.preRender.addEventListener(grow);
    }

    // Frame the whole route, north up, looking down at a slight tilt; the
    // view holds still so the plane and labels keep their bearings.
    const points = [from, to, ...(at ? [at] : [])].map((p) =>
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
    );
    const sphere = Cesium.BoundingSphere.fromPoints(points);
    const range = Math.max(1_800_000, sphere.radius * 3.2);
    const center =
      Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(sphere.center) ||
      sphere.center;
    widget.camera.lookAt(
      center,
      new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-62), range),
    );
    scene.requestRender();
  };

  try {
    widget = createWidget(container, {
      baseLayer: false,
      skyAtmosphere: false,
      contextOptions: { webgl: { alpha: true, antialias: true } },
    });
    const { scene } = widget;
    scene.backgroundColor = Cesium.Color.TRANSPARENT;
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b1820');
    scene.globe.showGroundAtmosphere = false;
    scene.globe.enableLighting = false;
    loop = renderLoopSwitch(widget);
  } catch {
    onFailed();
    return { setActive() {}, update() {}, destroy() {} };
  }
  Cesium.TileMapServiceImageryProvider.fromUrl(
    Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII'),
  ).then(
    (imagery) => {
      if (!widget) return;
      const layer = widget.scene.imageryLayers.addImageryProvider(imagery);
      // Dimmed and cooled, so the route reads over it.
      layer.brightness = 0.55;
      layer.saturation = 0.35;
      layer.contrast = 1.1;
      draw(latest);
    },
    () => widget && onFailed(),
  );

  function move(atNow) {
    const at = onRoute(from, to, atNow);
    if (!widget || !at || !plane || flyingIn) return;
    pose(plane, at);
    if (flownLine) flownLine.polyline.positions = arc(from, at, 48);
    if (aheadLine) aheadLine.polyline.positions = arc(at, to);
    widget.scene.requestRender();
  }

  return {
    setActive: (active) => loop.set(active),
    /**
     * A new route redraws; the craft moving along it only moves its plane
     * and the two lines, without replaying the opening draw.
     */
    update(next) {
      if (!widget) return;
      latest = next.at;
      if (next.from?.code !== from.code || next.to?.code !== to.code) {
        ({ from, to } = next);
        draw(latest);
        return;
      }
      move(latest);
    },
    destroy() {
      removeGrow?.();
      removeGrow = null;
      const gone = widget;
      widget = null;
      destroyWidget(gone);
    },
  };
}

// ── The cockpit view ───────────────────────────────────────────────────

/** A floor for the eye, so a landed or taxiing craft is not underground. */
const MIN_EYE_M = 60;

/**
 * What the crew sees: the view ahead from the aircraft's own position,
 * height and heading, a little nose down, over Esri World Imagery (the
 * app's keyless basemap) on a plain ellipsoid with the sky's haze. It draws
 * only when asked: a still, moved along with the craft while it shows.
 * @param {HTMLElement} container
 * @param {{lat: number, lon: number, altitudeM?: number|null,
 *   heading?: number|null}} craft
 * @param {{onFailed?: () => void}} [events]
 */
function cockpitPreview(container, craft, { onFailed = () => {} } = {}) {
  let widget = null;
  let loop = null;
  let active = false;
  let at = craft;
  const place = () => {
    if (!widget || !Number.isFinite(at?.lat) || !Number.isFinite(at?.lon))
      return;
    const height = Math.max(
      MIN_EYE_M,
      Number.isFinite(at.altitudeM) ? at.altitudeM : 0,
    );
    widget.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(at.lon, at.lat, height),
      orientation: {
        heading: Cesium.Math.toRadians(
          Number.isFinite(at.heading) ? at.heading : 0,
        ),
        pitch: Cesium.Math.toRadians(-9),
        roll: 0,
      },
    });
    widget.scene.requestRender();
  };
  try {
    widget = createWidget(container, {
      baseLayer: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      contextOptions: { webgl: { alpha: false, antialias: true } },
    });
    const { scene } = widget;
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b1820');
    scene.globe.showGroundAtmosphere = true;
    scene.fog.enabled = true;
    scene.camera.frustum.fov = Cesium.Math.toRadians(70);
    // Tiles arriving ask for a frame, so the still fills in as they load.
    scene.globe.tileLoadProgressEvent.addEventListener(() =>
      scene.requestRender(),
    );
    place();
    // Hidden, it draws nothing at all, not even as tiles arrive.
    loop = renderLoopSwitch(widget);
    loop.set(active);
  } catch {
    onFailed();
    return { setActive() {}, update() {}, destroy() {} };
  }
  createEsriImagery().then(
    (imagery) => {
      if (!widget) return;
      widget.scene.imageryLayers.addImageryProvider(imagery);
      widget.scene.requestRender();
    },
    () => widget && onFailed(),
  );
  return {
    setActive(next) {
      active = Boolean(next);
      if (!widget) return;
      loop.set(active);
      if (active) place();
    },
    /** While it shows, the view keeps up with the craft. */
    update(next) {
      at = next;
      if (active) place();
    },
    destroy() {
      const gone = widget;
      widget = null;
      destroyWidget(gone);
    },
  };
}

/**
 * The card previews, as the `cardPreviews` application hook hands them.
 * @type {Readonly<{model: typeof modelPreview, route: typeof routePreview,
 *   cockpit: typeof cockpitPreview}>}
 */
export const cesiumCardPreviews = Object.freeze({
  model: modelPreview,
  route: routePreview,
  cockpit: cockpitPreview,
});
