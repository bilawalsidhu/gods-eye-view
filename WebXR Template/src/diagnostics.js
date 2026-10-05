// Self-reporting state for the MR/VR test scene.
//
// Everything above createDiagnosticsPanel() is pure: no renderer, no document, no WebXR. That is
// what makes the checklist and the input labelling testable without a GL context, the same way
// locomotion.js keeps its teleport math renderer-free.

import * as THREE from 'three';

// The basics a headset session has to prove. Order is the order a tester naturally works through.
export const STATIONS = [
  { id: 'desktop', label: 'Desktop controls', hint: 'Click to play, mouse to look, WASD to move, click a pad' },
  { id: 'desktop-pickup', label: 'Desktop pickup', hint: 'Aim at a block, E to pick up, scroll to push and pull' },
  { id: 'controller-select', label: 'Controller select', hint: 'Point at a button and pull the trigger' },
  { id: 'controller-grab', label: 'Controller grab', hint: 'Squeeze the grip near a block' },
  { id: 'controller-hands', label: 'Controller hands', hint: 'Turn on in Settings, then pull trigger and grip' },
  { id: 'throw', label: 'Throw', hint: 'Release a block while moving your hand' },
  { id: 'teleport', label: 'Teleport (VR only)', hint: 'Push the stick forward, release on valid floor' },
  { id: 'teleport-rejected', label: 'Teleport blocked (VR only)', hint: 'Aim past the wall — the ring turns red' },
  { id: 'snap-turn', label: 'Snap turn (VR only)', hint: 'Push the stick sideways' },
  { id: 'hand-grab', label: 'Hand pinch grab', hint: 'Put controllers down, pinch a block' },
  { id: 'hand-select', label: 'Hand pinch select', hint: 'Pinch while aiming at a button' },
  { id: 'haptics', label: 'Haptics', hint: 'Trigger the pulse pad' },
  { id: 'mr-placement', label: 'MR surface', hint: 'In passthrough, place a marker on a real surface' },
];

export const STATION_IDS = STATIONS.map((station) => station.id);

// Completion only ever moves forward. A station that passed once stays passed for the session, so
// a tester never loses progress to a momentary tracking dropout.
export class Checklist {
  constructor(stations = STATIONS) {
    this.stations = stations;
    this.done = new Set();
  }

  complete(id) {
    if (!this.stations.some((station) => station.id === id)) throw new Error(`Unknown station: ${id}`);
    const first = !this.done.has(id);
    this.done.add(id);
    return first;
  }

  isComplete(id) {
    return this.done.has(id);
  }

  pending() {
    return this.stations.filter((station) => !this.done.has(station.id));
  }

  progress() {
    return { done: this.done.size, total: this.stations.length };
  }

  entries() {
    return this.stations.map((station) => ({ ...station, done: this.done.has(station.id) }));
  }
}

// An XRInputSource describes itself through three separate fields; collapse them into one label a
// tester can read off a panel at arm's length.
export function describeInputSource(source) {
  if (!source) return { connected: false, label: 'not connected' };
  const kind = source.hand ? 'hand' : source.targetRayMode ?? 'unknown';
  const gamepad = Boolean(source.gamepad);
  const haptics = Boolean(source.gamepad?.hapticActuators?.length);
  const handedness = source.handedness ?? 'none';
  return {
    connected: true,
    handedness,
    kind,
    gamepad,
    haptics,
    label: [handedness, kind, gamepad ? 'gamepad' : null, haptics ? 'haptics' : null].filter(Boolean).join(' · '),
  };
}

export class FrameRate {
  constructor(samples = 30) {
    this.limit = samples;
    this.times = [];
  }

  push(time) {
    const previous = this.times.at(-1);
    this.times.push(time);
    if (this.times.length > this.limit) this.times.shift();
    return previous === undefined ? 0 : time - previous;
  }

  get fps() {
    if (this.times.length < 2) return 0;
    const span = this.times.at(-1) - this.times[0];
    return span > 0 ? (this.times.length - 1) / span : 0;
  }

  get frameMs() {
    const fps = this.fps;
    return fps > 0 ? 1000 / fps : 0;
  }
}

// Re-rasterising a 1024px canvas every frame would distort the very frame timing this panel
// reports, so redraws are throttled and the caller asks before drawing.
export const REDRAW_INTERVAL = 0.25;

export class Diagnostics {
  constructor({ checklist = new Checklist(), interval = REDRAW_INTERVAL } = {}) {
    this.checklist = checklist;
    this.interval = interval;
    this.frames = new FrameRate();
    this.mode = 'desktop';
    this.referenceSpace = null;
    this.hitTest = 'not requested';
    this.inputs = [];
    this.hands = [];
    this.framebuffer = null;
    this.lastEvent = 'waiting';
    this.lastDraw = -Infinity;
    this.dirty = true;
  }

  setSession({ mode, referenceSpace, hitTest }) {
    this.mode = mode ?? 'desktop';
    if (referenceSpace !== undefined) this.referenceSpace = referenceSpace;
    if (hitTest !== undefined) this.hitTest = hitTest;
    this.dirty = true;
  }

  setInputs(sources) {
    this.inputs = sources.map(describeInputSource);
    this.dirty = true;
  }

  // The probed buffer from xr-capabilities.js's attachXR(), or null before a session (or on a
  // renderer/runtime the probe could not read). Recorded once at session entry -- the runtime does
  // not resize the layer mid-session -- so this is the first-entry fix actually landing, not the
  // adaptive step-down guess.
  setFramebuffer(framebuffer) {
    this.framebuffer = framebuffer ?? null;
    this.dirty = true;
  }

  setHands(poses) {
    this.hands = poses.map((pose) => (pose ? { tracked: true, pinchMm: Math.round(pose.distance * 1000), pinching: Boolean(pose.pinching) } : { tracked: false }));
  }

  note(event) {
    this.lastEvent = event;
    this.dirty = true;
  }

  complete(id, event = id) {
    if (this.checklist.complete(id)) {
      this.note(`${event} ✓`);
      return true;
    }
    return false;
  }

  frame(time) {
    this.frames.push(time);
  }

  shouldRedraw(time) {
    if (time - this.lastDraw < this.interval) return false;
    this.lastDraw = time;
    this.dirty = false;
    return true;
  }

  lines() {
    const { done, total } = this.checklist.progress();
    return [
      ['Session', this.mode],
      ['Reference space', this.referenceSpace ?? '—'],
      ['Hit test', this.hitTest],
      ['Inputs', this.inputs.length ? this.inputs.map((input) => input.label).join('   ') : 'none'],
      ['Hands', this.hands.some((hand) => hand.tracked) ? this.hands.map((hand) => (hand.tracked ? `${hand.pinchMm}mm${hand.pinching ? ' pinch' : ''}` : '—')).join('   ') : 'not tracked'],
      ['Framebuffer', this.framebuffer ? `${this.framebuffer.width}×${this.framebuffer.height} @ ${this.framebuffer.scale.toFixed(2)}` : 'unknown'],
      ['Frame', this.frames.fps ? `${this.frames.fps.toFixed(0)} fps · ${this.frames.frameMs.toFixed(1)} ms` : 'measuring'],
      ['Checked', `${done} / ${total}`],
      ['Last', this.lastEvent],
    ];
  }
}

// ---------------------------------------------------------------------------------------------
// Renderer side. Uses the same canvas-texture technique as the brand plaque in scene.js.
// ---------------------------------------------------------------------------------------------

export function createDiagnosticsPanel(scene, diagnostics, brand) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false, transparent: true }));
  panel.position.set(-2.4, 1.5, -2.2);
  panel.rotation.y = 0.5;
  scene.add(panel);

  function draw() {
    const { width } = canvas;
    context.clearRect(0, 0, width, canvas.height);
    context.fillStyle = brand.colors.background;
    context.fillRect(0, 0, width, canvas.height);
    context.fillStyle = brand.colors.accent;
    context.fillRect(0, 0, width, 10);

    context.font = `700 40px "${brand.fonts.display.family}"`;
    context.fillStyle = brand.colors.text;
    context.fillText('XR TEST BENCH', 44, 90);

    let y = 160;
    context.font = `500 27px "${brand.fonts.body.family}"`;
    for (const [label, value] of diagnostics.lines()) {
      context.fillStyle = brand.colors.muted;
      context.fillText(label, 44, y);
      context.fillStyle = brand.colors.text;
      context.fillText(String(value), 340, y, 640);
      y += 42;
    }

    y += 22;
    context.fillStyle = brand.colors.border;
    context.fillRect(44, y - 26, width - 88, 2);
    context.font = `500 25px "${brand.fonts.body.family}"`;
    for (const station of diagnostics.checklist.entries()) {
      // A check mark alone would be the only signal; the colour change is paired with it, never
      // standing in for it.
      context.fillStyle = station.done ? brand.colors.accent : brand.colors.muted;
      context.fillText(station.done ? '✓' : '○', 44, y);
      context.fillStyle = station.done ? brand.colors.text : brand.colors.muted;
      context.fillText(station.label, 96, y);
      if (!station.done) {
        context.font = `400 20px "${brand.fonts.body.family}"`;
        context.fillStyle = brand.colors.muted;
        context.fillText(station.hint, 440, y, 540);
        context.font = `500 25px "${brand.fonts.body.family}"`;
      }
      y += 36;
    }
    texture.needsUpdate = true;
  }

  draw();
  return {
    panel,
    draw,
    update(time) {
      if (diagnostics.shouldRedraw(time)) draw();
    },
    // In MR the room is hidden, so the panel parks relative to the viewer instead of the wall.
    setMixedReality(active, camera) {
      if (!active) {
        panel.position.set(-2.4, 1.5, -2.2);
        panel.rotation.set(0, 0.5, 0);
        return;
      }
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      forward.y = 0;
      forward.normalize();
      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
      panel.position.copy(camera.position).addScaledVector(forward, 1.6).addScaledVector(right, -1.15).add(new THREE.Vector3(0, -0.2, 0));
      panel.lookAt(camera.position);
    },
  };
}
