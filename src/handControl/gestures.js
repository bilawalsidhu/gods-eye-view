/**
 * Hand control: the pure half (no DOM, no Cesium, no MediaPipe).
 *
 * MediaPipe's Hand Landmarker gives 21 normalized points per hand. This module
 * turns them into a pose (open, pinch, fist, phone) and, frame to frame, into
 * camera intents:
 *
 * - **right-hand pinch** (thumb + index) grabs the map: moving the hand drags
 *   it, bringing the hand closer to the webcam zooms in, turning the wrist
 *   rotates it;
 * - **left-hand pinch** is the middle mouse button: moving it up or down tilts
 *   the view;
 * - **two pinching hands**: spreading them zooms, moving both up or down tilts
 *   the view, turning the line between them rotates it. When one hand lets go,
 *   nothing moves until both have let go, so the hands can be repositioned;
 * - the pinch lets go at the slightest gap between thumb and index;
 * - **all five fingertips together**, held for 0.6 s, flies back to the home
 *   view;
 * - **fist** stops everything at once;
 * - **phone** 🤙 (thumb + little finger out) held for 0.5 s toggles the
 *   microphone, like holding Space; it re-arms only after the hand changes,
 *   and never twice within a second;
 * - **pilot** 👉 (index forward, thumb out, the rest folded) held 0.4 s starts
 *   a slow straight flight; while the pilot hand is up, pointing the index
 *   left or right steers and bringing the hand nearer speeds up;
 * - **pointer** ☝️ (index only) shows a reticle; a quick pinch from it
 *   (under 0.3 s) clicks at the reticle; held, it becomes a normal grab;
 * - **thumb** 👍 sideways held 0.5 s orbits toward the thumb; up, held
 *   0.7 s, follows the selected target;
 * - **victory** ✌️ held still 0.7 s drops a pin at the screen centre; swiped
 *   left or right steps through the scene's shots;
 * - an **open hand swiped** left/right goes back/forward in the view history
 *   (or spins the globe from far away); **two open hands** held still 1 s turn
 *   north up;
 * - **two pilot hands** (a frame) held 0.6 s save a screenshot;
 * - releasing a dragging pinch while the hand still moves throws the map
 *   (the camera driver coasts it to a stop);
 * - an open hand (or anything else) rests: only a pinch ever moves the map.
 *
 * Coordinates are mirrored (x' = 1 - x) so the preview reads like a mirror and
 * "right" is the person's right. y grows downwards, as in the image.
 *
 * @module handControl/gestures
 */

/** Landmark indices (MediaPipe hand model). */
export const LM = Object.freeze({
  WRIST: 0,
  THUMB_MCP: 2,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_TIP: 20,
});

/** Thresholds, tuned by feel. Ratios are relative to the palm length. */
export const TUNING = Object.freeze({
  /** tip→wrist / mcp→wrist below this: finger folded. */
  curled: 1.3,
  /** tip→wrist / mcp→wrist above this: finger straight. */
  extended: 1.55,
  /** Thumb tip → little-finger knuckle / palm: thumb sticking out. */
  thumbOut: 1.05,
  /** Thumb tip ↔ index tip / palm: pinch closes below `pinchOn`, opens above
   *  `pinchOff`. The gap is small on purpose: the slightest release lets go. */
  pinchOn: 0.22,
  pinchOff: 0.27,
  /** Thumb tip this far behind the index tip (depth / palm): hidden, not
   *  touching — a thumb tucked behind the index only looks like a pinch. */
  thumbBehind: 0.25,
  /** All five fingertips within this distance of their centre / palm: "bunch". */
  bunch: 0.22,
  /** Bunch hold before flying home, and the gap before it can fire again. */
  homeHoldMs: 600,
  homeCooldownMs: 1500,
  /** Frames a fresh pinch waits before moving the map (no jump on contact). */
  grabSettleFrames: 2,
  /** Consecutive frames a fist must hold before it counts. */
  fistFrames: 3,
  /** Phone pose hold before the microphone toggles. */
  phoneHoldMs: 500,
  /** Minimum gap between two microphone toggles. */
  phoneCooldownMs: 1000,
  /** Phone pose must be gone this long before it can fire again. */
  phoneReleaseMs: 150,
  /** Per-frame dead zones (after smoothing). */
  deadPan: 0.0015,
  deadZoom: 0.004,
  deadAngle: 0.006,
  /** Thumb tip → index knuckle / palm above this: thumb held out (👍, 👉). */
  thumbReach: 0.6,
  /** Holds (ms) before each held gesture fires. */
  pilotHoldMs: 400,
  thumbHoldMs: 500,
  followHoldMs: 700,
  pinHoldMs: 700,
  northHoldMs: 1000,
  shotHoldMs: 600,
  /** Gap before the same held gesture can fire again. */
  actionCooldownMs: 1200,
  /** Swipe: palm travel (frame widths) within the window, mostly sideways. */
  swipeDist: 0.22,
  swipeWindowMs: 350,
  swipeMaxSlope: 0.6,
  swipeCooldownMs: 900,
  /** Palm speed (frame/s) under which a hand counts as held still. */
  stillSpeed: 0.35,
  /** A pinch that starts within `pointToPinchMs` of a ☝️ pointer and opens
   *  within `clickMs` is a click. */
  pointToPinchMs: 500,
  clickMs: 300,
  /** Camera frame margin left out of the pointer mapping (reach the edges). */
  pointerMargin: 0.15,
});

/** Tuning keys a calibration may override (all numbers). */
export const CALIBRATED_KEYS = Object.freeze([
  'curled',
  'extended',
  'pinchOn',
  'pinchOff',
  'thumbBehind',
  'thumbReach',
]);

const dist = (a, b, aspect) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);

/** Wrap an angle difference into (-π, π]. */
export function wrapAngle(a) {
  let x = a;
  while (x <= -Math.PI) x += 2 * Math.PI;
  while (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

/** Mirror raw MediaPipe landmarks into screen-like coordinates. */
export function mirrorLandmarks(landmarks) {
  return landmarks.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z ?? 0 }));
}

/**
 * Geometric features of one hand.
 * @param {{x:number,y:number}[]} p Mirrored landmarks (21).
 * @param {number} aspect Video width / height (keeps distances isotropic).
 */
export function handFeatures(p, aspect = 4 / 3) {
  const palm = Math.max(1e-4, dist(p[LM.WRIST], p[LM.MIDDLE_MCP], aspect));
  const ratio = (tip, mcp) =>
    dist(p[tip], p[LM.WRIST], aspect) /
    Math.max(1e-4, dist(p[mcp], p[LM.WRIST], aspect));
  const fingers = {
    index: ratio(LM.INDEX_TIP, LM.INDEX_MCP),
    middle: ratio(LM.MIDDLE_TIP, LM.MIDDLE_MCP),
    ring: ratio(LM.RING_TIP, LM.RING_MCP),
    pinky: ratio(LM.PINKY_TIP, LM.PINKY_MCP),
  };
  const thumb = dist(p[LM.THUMB_TIP], p[LM.PINKY_MCP], aspect) / palm;
  const pinch = dist(p[LM.THUMB_TIP], p[LM.INDEX_TIP], aspect) / palm;
  // MediaPipe depth: smaller is nearer the camera, on roughly the x scale.
  const thumbDepth =
    (((p[LM.THUMB_TIP].z ?? 0) - (p[LM.INDEX_TIP].z ?? 0)) * aspect) / palm;
  const grip = {
    x: (p[LM.THUMB_TIP].x + p[LM.INDEX_TIP].x) / 2,
    y: (p[LM.THUMB_TIP].y + p[LM.INDEX_TIP].y) / 2,
  };
  const tips = [
    LM.THUMB_TIP,
    LM.INDEX_TIP,
    LM.MIDDLE_TIP,
    LM.RING_TIP,
    LM.PINKY_TIP,
  ];
  const cx = tips.reduce((sum, i) => sum + p[i].x, 0) / tips.length;
  const cy = tips.reduce((sum, i) => sum + p[i].y, 0) / tips.length;
  const bunch =
    Math.max(...tips.map((i) => dist(p[i], { x: cx, y: cy }, aspect))) / palm;
  const angle = Math.atan2(
    p[LM.MIDDLE_MCP].y - p[LM.WRIST].y,
    (p[LM.MIDDLE_MCP].x - p[LM.WRIST].x) * aspect,
  );
  const thumbReach = dist(p[LM.THUMB_TIP], p[LM.INDEX_MCP], aspect) / palm;
  // Where the thumb points (screen terms: y grows downwards).
  const tdx = (p[LM.THUMB_TIP].x - p[LM.THUMB_MCP].x) * aspect;
  const tdy = p[LM.THUMB_TIP].y - p[LM.THUMB_MCP].y;
  const thumbDir =
    Math.abs(tdx) > Math.abs(tdy)
      ? tdx > 0
        ? 'right'
        : 'left'
      : tdy < 0
        ? 'up'
        : 'down';
  // Index direction from straight up: > 0 leans to the person's right.
  const indexLean = Math.atan2(
    (p[LM.INDEX_TIP].x - p[LM.INDEX_MCP].x) * aspect,
    -(p[LM.INDEX_TIP].y - p[LM.INDEX_MCP].y),
  );
  return {
    palm,
    fingers,
    thumb,
    pinch,
    thumbDepth,
    bunch,
    grip,
    angle,
    thumbReach,
    thumbDir,
    indexLean,
    tip: { x: p[LM.INDEX_TIP].x, y: p[LM.INDEX_TIP].y },
    center: { x: p[LM.MIDDLE_MCP].x, y: p[LM.MIDDLE_MCP].y },
  };
}

/**
 * Pose of one hand.
 * @param {ReturnType<typeof handFeatures>} f
 * @param {boolean} [wasPinching] Hysteresis: a pinch stays closed until `pinchOff`.
 * @returns {'phone'|'bunch'|'pinch'|'thumb'|'fist'|'pilot'|'point'|'victory'|'open'|'other'}
 */
export function classifyHand(f, wasPinching = false, tuning = TUNING) {
  const { index, middle, ring, pinky } = f.fingers;
  const curled = (r) => r < tuning.curled;
  const straight = (r) => r > tuning.extended;
  if (
    f.thumb > tuning.thumbOut &&
    straight(pinky) &&
    curled(index) &&
    curled(middle) &&
    curled(ring)
  )
    return 'phone';
  // Every fingertip touching: checked before the pinch, which it contains.
  if (f.bunch < tuning.bunch) return 'bunch';
  const pinchLimit = wasPinching ? tuning.pinchOff : tuning.pinchOn;
  // A pinch keeps the index finger reaching forward; a fist folds it away.
  // Only a thumb seen touching the index counts: not one hidden behind it.
  const thumbSeen = !(f.thumbDepth > tuning.thumbBehind);
  if (f.pinch < pinchLimit && thumbSeen && !curled(index)) return 'pinch';
  const thumbFree = f.thumbReach > tuning.thumbReach;
  if (curled(index) && curled(middle) && curled(ring) && curled(pinky))
    return thumbFree ? 'thumb' : 'fist';
  if (straight(index) && curled(middle) && curled(ring) && curled(pinky))
    return thumbFree ? 'pilot' : 'point';
  if (straight(index) && straight(middle) && curled(ring) && curled(pinky))
    return 'victory';
  if (straight(index) && straight(middle) && straight(ring) && straight(pinky))
    return 'open';
  return 'other';
}

/**
 * One Euro filter (Casiez et al.): smooths jitter at rest, follows fast motion.
 */
export class OneEuro {
  constructor({ minCutoff = 1.4, beta = 0.02, dCutoff = 1 } = {}) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }
  /** @param {number} value @param {number} tMs */
  filter(value, tMs) {
    if (this.x === null || this.t === null) {
      this.x = value;
      this.t = tMs;
      return value;
    }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000);
    this.t = tMs;
    const rawDx = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/** Hold-to-fire latch: fires once after `holdMs`, re-arms after release. */
function makeLatch() {
  return { heldMs: 0, goneMs: 0, armed: true, lastFire: -Infinity };
}

function stepLatch(latch, up, dt, tMs, { holdMs, cooldownMs, releaseMs }) {
  if (!up) {
    latch.goneMs += dt;
    if (latch.goneMs >= releaseMs) {
      latch.armed = true;
      latch.heldMs = 0;
    }
    return { fire: false, progress: 0 };
  }
  latch.goneMs = 0;
  latch.heldMs += dt;
  const progress = latch.armed ? Math.min(1, latch.heldMs / holdMs) : 1;
  if (
    latch.armed &&
    latch.heldMs >= holdMs &&
    tMs - latch.lastFire >= cooldownMs
  ) {
    latch.armed = false;
    latch.lastFire = tMs;
    return { fire: true, progress };
  }
  return { fire: false, progress };
}

function makeTrack() {
  return {
    pose: 'other',
    pinchFrames: 0,
    fistFrames: 0,
    poseFrames: 0,
    seen: 0,
    filters: {
      x: new OneEuro(),
      y: new OneEuro(),
      logPalm: new OneEuro({ minCutoff: 1, beta: 0.01 }),
      angle: new OneEuro({ minCutoff: 1, beta: 0.01 }),
      px: new OneEuro({ minCutoff: 1.2, beta: 0.03 }),
      py: new OneEuro({ minCutoff: 1.2, beta: 0.03 }),
    },
    prev: null,
    /** Palm centre trail for swipes: {t, x, y}. */
    trail: [],
    /** Smoothed palm speed, frame widths per second. */
    speed: 0,
    lastCenter: null,
    /** Last time and screen spot of a ☝️ pointer. */
    pointAt: -Infinity,
    pointPos: null,
    /** A pinch that may still turn out to be a click. */
    click: null,
    /** Hand scale when the current pilot streak began. */
    pilotRef: null,
  };
}

/** Map a camera-frame coordinate to the screen, leaving out a margin. */
function toScreen(v, margin) {
  return Math.max(0, Math.min(1, (v - margin) / Math.max(0.1, 1 - 2 * margin)));
}

const dead = (v, zone) => (Math.abs(v) < zone ? 0 : v);

/**
 * Frame-to-frame interpreter. Feed it every tracker result; it returns what
 * the camera should do this frame.
 */
export class GestureInterpreter {
  constructor(tuning = TUNING) {
    this.tuning = tuning;
    /** Left-handed: the right hand tilts, the left one drags. */
    this.leftHanded = false;
    this.tracks = new Map();
    this.reset();
  }

  reset() {
    this.tracks.clear();
    this.pair = null;
    /** After a two-hand grab breaks: nothing moves until every pinch opens. */
    this.locked = false;
    /** > 0: MediaPipe's labels match the screen sides; < 0: swapped. */
    this.sideVotes = 0;
    this.phone = makeLatch();
    this.home = makeLatch();
    this.pilot = makeLatch();
    this.thumbSide = makeLatch();
    this.thumbUp = makeLatch();
    this.pin = makeLatch();
    this.north = makeLatch();
    this.shot = makeLatch();
    this.lastSwipe = -Infinity;
    this.dragging = false;
    this.lastVelocity = null;
    this.lastT = null;
  }

  /** Replace some thresholds (calibration); unknown keys are ignored. */
  setTuning(partial = {}) {
    const next = { ...this.tuning };
    for (const [key, value] of Object.entries(partial || {}))
      if (key in TUNING && Number.isFinite(value)) next[key] = value;
    this.tuning = Object.freeze(next);
  }

  /** Label of the person's left hand (learned from where two hands appear). */
  leftLabel() {
    return this.sideVotes >= 0 ? 'Left' : 'Right';
  }

  /** Label of the hand that tilts: the left one, or the right when left-handed. */
  tiltLabel() {
    const left = this.leftLabel();
    if (!this.leftHanded) return left;
    return left === 'Left' ? 'Right' : 'Left';
  }

  /**
   * @param {{landmarks: {x:number,y:number}[], key: string}[]} hands
   *   Raw (unmirrored) landmarks per hand; `key` keeps identity between
   *   frames (MediaPipe's handedness label).
   * @param {number} tMs Frame time.
   * @param {number} [aspect] Video width / height.
   */
  update(hands, tMs, aspect = 4 / 3) {
    const tune = this.tuning;
    const dt = this.lastT === null ? 0 : Math.max(0, tMs - this.lastT);
    this.lastT = tMs;
    const out = {
      poses: [],
      pan: { dx: 0, dy: 0 },
      zoom: 0,
      rotate: 0,
      tilt: 0,
      grabbing: false,
      grabStart: false,
      twoHands: false,
      tiltHand: false,
      locked: false,
      stop: false,
      micToggle: false,
      phoneProgress: 0,
      home: false,
      homeProgress: 0,
      /** Screen spot (0..1) of the single grabbing hand, for the split line. */
      grip: null,
      /** Pinch let go: last per-frame hand velocity (for the throw). */
      release: null,
      pointer: null,
      click: null,
      pilot: null,
      cruiseStart: false,
      orbit: null,
      follow: false,
      pin: false,
      northUp: false,
      shot: false,
      swipe: null,
      /** Largest progress among the held gestures, and which one. */
      hold: null,
    };

    const seenKeys = new Set();
    const live = [];
    for (const hand of hands) {
      const key = seenKeys.has(hand.key) ? `${hand.key}#2` : hand.key;
      seenKeys.add(key);
      const pts = mirrorLandmarks(hand.landmarks);
      const f = handFeatures(pts, aspect);
      let track = this.tracks.get(key);
      if (!track) {
        track = makeTrack();
        this.tracks.set(key, track);
      }
      const pose = classifyHand(f, track.pose === 'pinch', tune);
      if (pose === 'pinch') track.pinchFrames += 1;
      else track.pinchFrames = 0;
      track.fistFrames = pose === 'fist' ? track.fistFrames + 1 : 0;
      const wasPinching = track.pose === 'pinch';
      track.poseFrames = pose === track.pose ? track.poseFrames + 1 : 1;
      track.pose = pose;
      // Palm speed and the swipe trail.
      if (track.lastCenter && dt > 0) {
        const v =
          Math.hypot(
            (f.center.x - track.lastCenter.x) * aspect,
            f.center.y - track.lastCenter.y,
          ) /
          (dt / 1000);
        track.speed += 0.4 * (v - track.speed);
      }
      track.lastCenter = f.center;
      if (pose === 'open' || pose === 'victory') {
        if (track.trail.length && track.trail[0].pose !== pose)
          track.trail = [];
        track.trail.push({ t: tMs, x: f.center.x, y: f.center.y, pose });
        while (
          track.trail.length &&
          tMs - track.trail[0].t > tune.swipeWindowMs
        )
          track.trail.shift();
      } else track.trail = [];
      const pointer = {
        x: toScreen(track.filters.px.filter(f.tip.x, tMs), tune.pointerMargin),
        y: toScreen(track.filters.py.filter(f.tip.y, tMs), tune.pointerMargin),
      };
      if (pose === 'point') {
        track.pointAt = tMs;
        track.pointPos = pointer;
      }
      // A pinch straight from the pointer may be a click.
      if (
        pose === 'pinch' &&
        !wasPinching &&
        tMs - track.pointAt <= tune.pointToPinchMs
      )
        track.click = { t: tMs, pos: track.pointPos };
      if (pose !== 'pinch' && track.click) {
        if (tMs - track.click.t <= tune.clickMs + 50)
          out.click = track.click.pos;
        track.click = null;
      }
      if (pose === 'pilot') {
        if (track.poseFrames === 1 || track.pilotRef === null)
          track.pilotRef = Math.log(f.palm);
      } else track.pilotRef = null;
      const smooth = {
        x: track.filters.x.filter(f.grip.x, tMs),
        y: track.filters.y.filter(f.grip.y, tMs),
        logPalm: track.filters.logPalm.filter(Math.log(f.palm), tMs),
        angle: 0,
      };
      // Unwrap before filtering so a crossing of ±π does not spin the map.
      const unwrapped = track.prev
        ? track.prev.unwrapped + wrapAngle(f.angle - track.prev.rawAngle)
        : f.angle;
      smooth.angle = track.filters.angle.filter(unwrapped, tMs);
      live.push({ key, pose, f, pts, track, smooth, unwrapped, pointer });
      out.poses.push({
        key,
        pose,
        points: pts,
        grip: f.grip,
        pinch: f.pinch,
        thumbDepth: f.thumbDepth,
      });
    }
    // Forget hands that left the frame.
    for (const key of [...this.tracks.keys()])
      if (!seenKeys.has(key)) this.tracks.delete(key);

    // Fist: stop everything (and drop any grab).
    if (live.some((h) => h.track.fistFrames >= tune.fistFrames))
      out.stop = true;

    // Phone 🤙: hold → toggle once; re-arm after it is gone.
    const phone = stepLatch(
      this.phone,
      live.some((h) => h.pose === 'phone'),
      dt,
      tMs,
      {
        holdMs: tune.phoneHoldMs,
        cooldownMs: tune.phoneCooldownMs,
        releaseMs: tune.phoneReleaseMs,
      },
    );
    out.micToggle = phone.fire;
    out.phoneProgress = phone.progress;
    // Fingertips together: back to the home view.
    const home = stepLatch(
      this.home,
      live.some((h) => h.pose === 'bunch'),
      dt,
      tMs,
      {
        holdMs: tune.homeHoldMs,
        cooldownMs: tune.homeCooldownMs,
        releaseMs: tune.phoneReleaseMs,
      },
    );
    out.home = home.fire;
    out.homeProgress = home.progress;

    const held = (latch, up, holdMs) =>
      stepLatch(latch, up, dt, tMs, {
        holdMs,
        cooldownMs: tune.actionCooldownMs,
        releaseMs: tune.phoneReleaseMs,
      });
    const holds = [];
    const still = (h) => h.track.speed < tune.stillSpeed;
    const pilots = live.filter((h) => h.pose === 'pilot');
    // Two pilot hands make a frame: screenshot.
    const shot = held(this.shot, pilots.length >= 2, tune.shotHoldMs);
    out.shot = shot.fire;
    holds.push(['shot', shot.progress]);
    const pilot = held(this.pilot, pilots.length === 1, tune.pilotHoldMs);
    out.cruiseStart = pilot.fire;
    holds.push(['pilot', pilot.progress]);
    if (pilots.length === 1) {
      const h = pilots[0];
      out.pilot = {
        steer: h.f.indexLean,
        throttle: h.smooth.logPalm - (h.track.pilotRef ?? h.smooth.logPalm),
        fresh: h.track.poseFrames === 1,
      };
    }
    const sideThumb = live.find(
      (h) =>
        h.pose === 'thumb' &&
        (h.f.thumbDir === 'left' || h.f.thumbDir === 'right'),
    );
    const side = held(this.thumbSide, Boolean(sideThumb), tune.thumbHoldMs);
    if (side.fire && sideThumb) out.orbit = sideThumb.f.thumbDir;
    holds.push(['orbit', side.progress]);
    const follow = held(
      this.thumbUp,
      live.some((h) => h.pose === 'thumb' && h.f.thumbDir === 'up' && still(h)),
      tune.followHoldMs,
    );
    out.follow = follow.fire;
    holds.push(['follow', follow.progress]);
    const pin = held(
      this.pin,
      live.some(
        (h) => h.pose === 'victory' && still(h) && h.track.poseFrames > 3,
      ),
      tune.pinHoldMs,
    );
    out.pin = pin.fire;
    holds.push(['pin', pin.progress]);
    const opens = live.filter((h) => h.pose === 'open');
    const north = held(
      this.north,
      opens.length >= 2 && opens.every(still),
      tune.northHoldMs,
    );
    out.northUp = north.fire;
    holds.push(['north', north.progress]);
    let best = null;
    for (const [name, progress] of holds)
      if (progress > 0 && progress < 1 && (!best || progress > best.progress))
        best = { name, progress };
    out.hold = best;

    // Swipes: an open hand or ✌️ crossing the frame quickly, mostly sideways.
    if (tMs - this.lastSwipe >= tune.swipeCooldownMs) {
      for (const h of live) {
        const trail = h.track.trail;
        if (trail.length < 3) continue;
        const dx = trail[trail.length - 1].x - trail[0].x;
        const dy = trail[trail.length - 1].y - trail[0].y;
        if (
          Math.abs(dx) > tune.swipeDist &&
          Math.abs(dy) < tune.swipeMaxSlope * Math.abs(dx)
        ) {
          out.swipe = {
            dir: dx > 0 ? 'right' : 'left',
            pose: trail[0].pose,
          };
          this.lastSwipe = tMs;
          h.track.trail = [];
          break;
        }
      }
    }

    // ☝️ pointer (or the spot a click candidate froze).
    const pointing =
      live.find((h) => h.track.click) || live.find((h) => h.pose === 'point');
    if (pointing)
      out.pointer = pointing.track.click
        ? pointing.track.click.pos
        : pointing.pointer;

    // Learn which label is the person's left hand: with two hands apart, the
    // left one is on the left of the mirrored picture.
    if (
      live.length === 2 &&
      Math.abs(live[0].f.grip.x - live[1].f.grip.x) > 0.15
    ) {
      const [l, r] =
        live[0].f.grip.x < live[1].f.grip.x ? live : [live[1], live[0]];
      const vote =
        l.key.startsWith('Left') && r.key.startsWith('Right')
          ? 1
          : l.key.startsWith('Right') && r.key.startsWith('Left')
            ? -1
            : 0;
      this.sideVotes = Math.max(-30, Math.min(30, this.sideVotes + vote));
    }

    // A click candidate older than the click window becomes a normal grab.
    for (const h of live)
      if (h.track.click && tMs - h.track.click.t > tune.clickMs) {
        h.track.click = null;
        if (h.pose === 'pinch') h.track.pinchFrames = 1;
      }
    const pinchingAll = out.stop ? [] : live.filter((h) => h.pose === 'pinch');
    if (pinchingAll.length >= 2)
      for (const h of pinchingAll) h.track.click = null;
    const pinching = pinchingAll.filter((h) => !h.track.click);
    const settled = pinching.filter(
      (h) => h.track.pinchFrames > tune.grabSettleFrames && h.track.prev,
    );

    if (this.locked) {
      if (pinching.length === 0) this.locked = false;
      else {
        this.pair = null;
        out.locked = true;
      }
    }
    if (out.locked) {
      // Repositioning: hands move freely, the map stays.
    } else if (pinching.length >= 2) {
      out.twoHands = true;
      const [a, b] = pinching;
      const span = Math.hypot(
        (a.smooth.x - b.smooth.x) * aspect,
        a.smooth.y - b.smooth.y,
      );
      const mid = (a.smooth.y + b.smooth.y) / 2;
      const line = Math.atan2(
        b.smooth.y - a.smooth.y,
        (b.smooth.x - a.smooth.x) * aspect,
      );
      const prev = this.pair;
      const sameHands = prev && prev.keys === `${a.key}|${b.key}`;
      if (sameHands && settled.length >= 2) {
        out.zoom = dead(
          Math.log(Math.max(1e-4, span) / Math.max(1e-4, prev.span)),
          tune.deadZoom,
        );
        out.tilt = dead(mid - prev.mid, tune.deadPan);
        out.rotate = dead(wrapAngle(line - prev.line), tune.deadAngle);
        out.grabbing = true;
      } else if (!sameHands) out.grabStart = true;
      this.pair = { keys: `${a.key}|${b.key}`, span, mid, line };
    } else {
      if (this.pair && pinching.length === 1) {
        // One hand of a two-hand grab let go: hold everything still.
        this.pair = null;
        this.locked = true;
        out.locked = true;
      }
      this.pair = null;
      if (pinching.length === 1 && !out.locked) {
        const h = pinching[0];
        const isLeft = h.key.startsWith(this.tiltLabel());
        if (settled.length === 1 && isLeft) {
          // Left hand = middle mouse button: up/down tilts the view.
          // Forward = up or nearer the screen → toward the horizon.
          const p = h.track.prev;
          out.tilt = dead(
            h.smooth.y - p.y - 0.7 * (h.smooth.logPalm - p.logPalm),
            tune.deadPan,
          );
          out.tiltHand = true;
          out.grabbing = true;
        } else if (settled.length === 1) {
          const p = h.track.prev;
          out.pan.dx = dead(h.smooth.x - p.x, tune.deadPan);
          out.pan.dy = dead(h.smooth.y - p.y, tune.deadPan);
          out.zoom = dead(h.smooth.logPalm - p.logPalm, tune.deadZoom);
          out.rotate = dead(h.smooth.angle - p.angle, tune.deadAngle);
          out.grabbing = true;
          out.grip = {
            x: toScreen(h.smooth.x, tune.pointerMargin),
            y: toScreen(h.smooth.y, tune.pointerMargin),
          };
          h.track.velocity = {
            dx: h.smooth.x - p.x,
            dy: h.smooth.y - p.y,
            dt,
          };
        } else if (h.track.pinchFrames === 1) {
          out.grabStart = true;
          out.grip = {
            x: toScreen(h.smooth.x, tune.pointerMargin),
            y: toScreen(h.smooth.y, tune.pointerMargin),
          };
        }
      }
    }

    // A one-hand drag that let go (not a fist): hand it over for the throw.
    // A hand closing into a fist means stop, not throw.
    const releasing = live.find((h) => h.key === this.dragKey);
    if (
      !out.stop &&
      !out.grabbing &&
      !out.locked &&
      this.dragging &&
      this.lastVelocity &&
      releasing?.pose !== 'fist'
    )
      out.release = this.lastVelocity;
    this.dragging = out.grabbing && !out.twoHands && !out.tiltHand;
    if (this.dragging) {
      const h = pinching[0];
      this.dragKey = h?.key ?? null;
      this.lastVelocity = h?.track.velocity || null;
    } else this.lastVelocity = null;

    for (const h of live)
      h.track.prev = {
        ...h.smooth,
        rawAngle: h.f.angle,
        unwrapped: h.unwrapped,
      };
    return out;
  }
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Fewest frames per calibration step that still give a usable measure. */
export const CALIBRATION_MIN_SAMPLES = 10;

/**
 * Thresholds measured from the person's own hand.
 * @param {{pinch: object[], open: object[], fist: object[]}} samples
 *   handFeatures() results gathered while the person held each pose.
 * @returns {{ok: true, tuning: object}|{ok: false, missing: string}}
 */
export function calibrateFromSamples({ pinch = [], open = [], fist = [] }) {
  for (const [name, list] of Object.entries({ pinch, open, fist }))
    if (list.length < CALIBRATION_MIN_SAMPLES)
      return { ok: false, missing: name };
  const fingerValues = (f) => Object.values(f.fingers);
  const gap = quantile(
    pinch.map((f) => f.pinch),
    0.9,
  );
  const depth = quantile(
    pinch.map((f) => f.thumbDepth),
    0.9,
  );
  const openMin = quantile(
    open.map((f) => Math.min(...fingerValues(f))),
    0.1,
  );
  const fistMax = quantile(
    fist.map((f) => Math.max(...fingerValues(f))),
    0.9,
  );
  const fistReach = quantile(
    fist.map((f) => f.thumbReach),
    0.9,
  );
  const pinchOn = clamp(gap * 1.3 + 0.03, 0.14, 0.36);
  const curled = clamp(
    fistMax + 0.1,
    1.05,
    Math.max(1.05, Math.min(1.5, openMin - 0.2)),
  );
  const extended = clamp(openMin - 0.08, curled + 0.1, 1.85);
  return {
    ok: true,
    tuning: {
      pinchOn,
      pinchOff: pinchOn + 0.05,
      thumbBehind: clamp(depth + 0.12, 0.15, 0.6),
      curled,
      extended,
      thumbReach: clamp(fistReach + 0.15, 0.45, 0.85),
    },
  };
}
