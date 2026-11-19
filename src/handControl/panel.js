/**
 * Hand control: UTILITIES ▸ Hands.
 *
 * The toggle (HandControls.vue, through the display store) turns the webcam on, shows a small mirrored preview with the
 * detected hand points, and steers the camera with gestures
 * (handControl/gestures.js → handControl/cameraDriver.js). The 🤙 gesture
 * toggles the microphone through the same path as holding Space
 * (voice/gestureTalk.js).
 *
 * Off means off: the camera stream is stopped and MediaPipe is closed.
 *
 * @module handControl/panel
 */
import { t } from '../i18n/index.js';
import {
  CALIBRATED_KEYS,
  TUNING as DEFAULTS,
  GestureInterpreter,
  calibrateFromSamples,
  handFeatures,
  mirrorLandmarks,
} from './gestures.js';
import { createCameraDriver } from './cameraDriver.js';
import { cameraOf, canvasOf } from '../render/rendererOf.js';
import { HandTrackerError, startHandTracker } from './tracker.js';
import {
  gestureTalkListening,
  toggleGestureTalk,
} from '../voice/gestureTalk.js';

const SENSITIVITY_KEY = 'gev-hand-sensitivity';
const TUNING_KEY = 'gev-hand-tuning';
const LEFTY_KEY = 'gev-hand-lefty';
/** Calibration: each pose is held this long; the first part is ignored. */
const CALIBRATION_STEP_MS = 2600;
const CALIBRATION_SETTLE_MS = 700;
const HAND_LINKS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
];
const POSE_COLORS = {
  pinch: '#00d4ff',
  fist: '#ff5a5a',
  phone: '#ffb020',
  bunch: '#c58bff',
  open: '#9be37a',
  pilot: '#ff7ac8',
  point: '#ffffff',
  thumb: '#5fe0c0',
  victory: '#ffd84a',
  other: '#c8c8c8',
};
/** Ring colour of each held gesture. */
const HOLD_COLORS = {
  pilot: POSE_COLORS.pilot,
  orbit: POSE_COLORS.thumb,
  follow: POSE_COLORS.thumb,
  pin: POSE_COLORS.victory,
  north: POSE_COLORS.open,
  shot: POSE_COLORS.pilot,
};

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function writeStore(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

function readSensitivity() {
  try {
    const v = Number(localStorage.getItem(SENSITIVITY_KEY));
    return Number.isFinite(v) && v >= 0.3 && v <= 2.5 ? v : 1;
  } catch {
    return 1;
  }
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

/**
 * @param {{viewer: object, annotations?: object, sceneDirector?: object,
 *   publish?: (view: {active: boolean}) => void,
 *   connect?: (actions: object) => (() => void)}} deps
 * @returns {{destroy: () => void}|null}
 */
export function initHandControl({
  viewer,
  annotations = null,
  sceneDirector = null,
  publish = () => {},
  connect = () => () => {},
}) {
  if (!viewer) return null;

  let sensitivity = readSensitivity();
  let tracker = null;
  let starting = false;
  let generation = 0;
  let lastStatus = '';
  let micNote = '';
  let micNoteUntil = 0;
  let homeNoteUntil = 0;
  let actionNote = '';
  let actionNoteUntil = 0;
  /** Calibration in progress: {step, startedAt, samples}. */
  let calibration = null;
  const interpreter = new GestureInterpreter();
  const savedTuning = readJson(TUNING_KEY);
  if (savedTuning && typeof savedTuning === 'object') {
    const picked = {};
    for (const key of CALIBRATED_KEYS)
      if (Number.isFinite(savedTuning[key])) picked[key] = savedTuning[key];
    interpreter.setTuning(picked);
  }
  interpreter.leftHanded = readJson(LEFTY_KEY) === true;
  const driver = createCameraDriver(viewer, {
    sensitivity: () => sensitivity,
    annotations,
    sceneDirector,
  });
  // ☝️ pointer reticle over the map.
  const reticle = el('div', {
    class: 'gev-hands-reticle',
    'aria-hidden': 'true',
  });
  reticle.hidden = true;

  const video = el('video', {
    class: 'gev-hands__video',
    'aria-hidden': 'true',
  });
  const canvas = el('canvas', {
    class: 'gev-hands__overlay',
    width: '320',
    height: '240',
    'aria-hidden': 'true',
  });
  const status = el('div', {
    class: 'gev-hands__status',
    'aria-live': 'polite',
  });
  const mic = el('span', {
    class: 'gev-hands__mic material-symbols-outlined',
    title: t('Microphone'),
    'aria-hidden': 'true',
    text: 'mic',
  });
  const slider = el('input', {
    class: 'gev-quantitative-slider pp-slider gev-hands__slider',
    type: 'range',
    min: '0.3',
    max: '2.5',
    step: '0.1',
    'aria-label': t('Sensitivity'),
    title: t('Sensitivity'),
  });
  slider.value = String(sensitivity);
  const close = el(
    'button',
    {
      class: 'gev-hands__close',
      type: 'button',
      title: t('Close'),
      'aria-label': t('Close'),
    },
    [
      el('span', {
        class: 'material-symbols-outlined',
        'aria-hidden': 'true',
        text: 'close',
      }),
    ],
  );
  const calibrate = el('button', {
    class: 'gev-hands__btn',
    type: 'button',
    text: t('Calibrate hand'),
  });
  const resetTuning = el('button', {
    class: 'gev-hands__btn',
    type: 'button',
    text: t('Default thresholds'),
  });
  const lefty = el('input', { type: 'checkbox' });
  lefty.checked = interpreter.leftHanded;
  // Live numbers for tuning: thumb↔index gap and how far the thumb is behind.
  const diag = el('div', { class: 'gev-hands__diag', 'aria-hidden': 'true' });
  const help = el('details', { class: 'gev-hands__help' }, [
    el('summary', { text: t('Gestures') }),
    el('div', {
      text: t('🤏 right hand: drag · nearer/farther: zoom · turn: rotate'),
    }),
    el('div', {
      text: t(
        '🤏 left hand up/down or forward/back: tilt (like the mouse wheel)',
      ),
    }),
    el('div', { text: t('🤏🤏 two hands: spread to zoom, up/down to tilt') }),
    el('div', { text: t('✊ fist: stop · 🤙 hold: microphone on/off') }),
    el('div', { text: t('🤌 all fingertips together: home view') }),
    el('div', {
      text: t(
        '👉 pilot (index + thumb out) hold: fly straight · point left/right: turn · hand nearer: faster',
      ),
    }),
    el('div', { text: t('☝️ index only: pointer · quick pinch: click') }),
    el('div', { text: t('👍 thumb sideways: orbit') }),
    el('div', {
      text: t('✌️ held still: drop a pin · swiped: next/previous shot'),
    }),
    el('div', {
      text: t(
        '✋ swipe left/right: previous/next view (far away: spin the globe)',
      ),
    }),
    el('div', { text: t('✋✋ both hands open and still: north up') }),
    el('div', { text: t('👉👉 frame with both hands: screenshot') }),
    el('div', { text: t('Let go while moving: the map coasts on') }),
    el('div', { class: 'gev-hands__row' }, [calibrate, resetTuning]),
    el('label', { class: 'gev-hands__row' }, [
      lefty,
      el('span', { text: t('Left-handed (right hand tilts)') }),
    ]),
    diag,
  ]);
  const header = el(
    'header',
    { class: 'gev-hands__header', title: t('Drag to move') },
    [
      el('span', {
        class: 'material-symbols-outlined',
        'aria-hidden': 'true',
        text: 'back_hand',
      }),
      el('span', { class: 'gev-hands__title', text: t('Hand control') }),
      mic,
      close,
    ],
  );
  const panel = el(
    'section',
    { class: 'gev-hands', 'aria-label': t('Hand control') },
    [
      header,
      el('div', { class: 'gev-hands__stage' }, [video, canvas]),
      status,
      el('label', { class: 'gev-hands__row' }, [
        el('span', { text: t('Sensitivity') }),
        slider,
      ]),
      help,
    ],
  );
  panel.hidden = true;
  document.body.append(panel, reticle);
  const ctx = canvas.getContext('2d');

  // Draggable by the header for the session; it always opens top right with
  // the gesture list folded, out of the way of the map.
  const placeAt = (left, top) => {
    const rect = panel.getBoundingClientRect();
    const x = Math.min(
      Math.max(8, left),
      Math.max(8, window.innerWidth - rect.width - 8),
    );
    const y = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - 60));
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
    panel.style.bottom = 'auto';
  };
  const openTopRight = () => {
    help.open = false;
    const width = panel.getBoundingClientRect().width || 240;
    placeAt(window.innerWidth - width - 16, 72);
  };
  const onDragStart = (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    const dx = event.clientX - rect.left;
    const dy = event.clientY - rect.top;
    const move = (e) => placeAt(e.clientX - dx, e.clientY - dy);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  header.addEventListener('pointerdown', onDragStart);

  const setStatus = (text) => {
    if (text === lastStatus) return;
    lastStatus = text;
    status.textContent = text;
  };

  const renderMic = () => {
    const on = gestureTalkListening();
    mic.classList.toggle('is-on', on);
    mic.textContent = on ? 'mic' : 'mic_off';
  };

  function draw(intent) {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    for (const hand of intent.poses) {
      const color = POSE_COLORS[hand.pose] || POSE_COLORS.other;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [a, b] of HAND_LINKS) {
        ctx.moveTo(hand.points[a].x * w, hand.points[a].y * h);
        ctx.lineTo(hand.points[b].x * w, hand.points[b].y * h);
      }
      ctx.stroke();
      for (const p of hand.points) {
        ctx.beginPath();
        ctx.arc(p.x * w, p.y * h, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Hold-to-fire progress rings: 🤙 microphone, fingertips home.
    const ring = (progress, color) => {
      if (!(progress > 0 && progress < 1)) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(
        w - 20,
        20,
        12,
        -Math.PI / 2,
        -Math.PI / 2 + progress * Math.PI * 2,
      );
      ctx.stroke();
    };
    ring(intent.phoneProgress, POSE_COLORS.phone);
    ring(intent.homeProgress, POSE_COLORS.bunch);
    if (intent.hold) ring(intent.hold.progress, HOLD_COLORS[intent.hold.name]);
  }

  function placeReticle(pointer) {
    if (!pointer) {
      reticle.hidden = true;
      return;
    }
    const rect = canvasOf(viewer).getBoundingClientRect();
    reticle.hidden = false;
    reticle.style.left = `${rect.left + pointer.x * rect.width}px`;
    reticle.style.top = `${rect.top + pointer.y * rect.height}px`;
  }

  const HOLD_TEXT = {
    pilot: () => t('Hold to fly'),
    orbit: () => t('Hold to orbit'),
    pin: () => t('Hold to drop a pin'),
    north: () => t('Hold for north up'),
    shot: () => t('Hold for a screenshot'),
  };

  /** A short note for an action that just happened (shown for 2.5 s). */
  function noteFor(intent, outcome) {
    switch (outcome) {
      case 'orbit':
        return t('Orbiting — ✊ to stop');
      case 'globe':
        return t('Spinning the globe — ✊ to stop');
      case 'back':
        return t('Previous view');
      case 'forward':
        return t('Next view');
      case 'no-history':
        return t('No other view to go to');
      case 'pin':
        return t('Pin dropped at the centre');
      case 'north':
        return t('North up');
      case 'shot':
        return t('Screenshot saved');
      case 'scene':
        return intent.swipe?.dir === 'left'
          ? t('Previous shot')
          : t('Next shot');
      case 'no-scenes':
        return t('No saved shots in this scene');
      case 'click':
        return t('Click sent');
      case 'no-target':
        if (intent.orbit) return t('No ground at the centre to orbit');
        return t('No ground at the centre');
      default:
        return '';
    }
  }

  function describe(intent, outcome) {
    const now = performance.now();
    if (micNote && now < micNoteUntil) return micNote;
    const note = noteFor(intent, outcome);
    if (note) {
      actionNote = note;
      actionNoteUntil = now + 2500;
    }
    if (actionNote && now < actionNoteUntil) return actionNote;
    if (outcome === 'busy')
      return t('Following a target — release it to steer by hand');
    if (!intent.poses.length) return t('Show a hand to the camera');
    if (outcome === 'home' || homeNoteUntil > now) {
      if (outcome === 'home') homeNoteUntil = now + 2000;
      return t('Back to the home view');
    }
    if (intent.stop) return t('Stop');
    if (intent.phoneProgress > 0) return t('Microphone');
    if (intent.hold) return HOLD_TEXT[intent.hold.name]?.() || '';
    if (outcome === 'split') return t('Moving the split line');
    if (intent.homeProgress > 0) return t('Fingertips together — home view');
    if (intent.locked) return t('Release both hands to continue');
    if (intent.twoHands) return t('Two-hand grab');
    if (intent.tiltHand) return t('Tilt');
    if (intent.grabbing || intent.grabStart) return t('Grab');
    const motion = driver.state();
    if (motion.cruising) {
      const speed = {
        'very slow': () => t('Flying very slowly — ✊ to stop'),
        slow: () => t('Flying slowly — ✊ to stop'),
        normal: () => t('Flying — ✊ to stop'),
        fast: () => t('Flying fast — ✊ to stop'),
      }[motion.speed];
      return speed();
    }
    if (motion.gliding) return t('Coasting to a stop');
    if (intent.pointer) return t('Pointer — quick pinch to click');
    return t('Rest — pinch to grab the map');
  }

  function onMicToggle() {
    const result = toggleGestureTalk();
    micNote =
      result === 'listening'
        ? t('Microphone on — 🤙 again to send')
        : result === 'sent'
          ? t('Sent')
          : result === 'open-mic'
            ? t('Voice already listening (open mic)')
            : t('Voice is not available');
    micNoteUntil = performance.now() + 2500;
    renderMic();
  }

  const CALIBRATION_STEPS = [
    [
      'pinch',
      () => t('Calibration 1/3: touch thumb and index (pinch) and hold'),
    ],
    ['open', () => t('Calibration 2/3: open hand, fingers straight')],
    ['fist', () => t('Calibration 3/3: closed fist, thumb over the fingers')],
  ];

  function calibrationFrame(hands, tMs, aspect) {
    const c = calibration;
    if (c.startedAt === null) c.startedAt = tMs;
    const elapsed = tMs - c.startedAt;
    const [pose, text] = CALIBRATION_STEPS[c.step];
    if (hands[0] && elapsed > CALIBRATION_SETTLE_MS)
      c.samples[pose].push(
        handFeatures(mirrorLandmarks(hands[0].landmarks), aspect),
      );
    const left = Math.max(0, Math.ceil((CALIBRATION_STEP_MS - elapsed) / 1000));
    setStatus(`${text()} · ${left}`);
    if (elapsed < CALIBRATION_STEP_MS) return;
    c.step += 1;
    c.startedAt = tMs;
    if (c.step < CALIBRATION_STEPS.length) return;
    calibration = null;
    const result = calibrateFromSamples(c.samples);
    if (!result.ok) {
      actionNote = t(
        'Calibration failed — keep one hand in view and try again',
      );
    } else {
      interpreter.setTuning(result.tuning);
      writeStore(TUNING_KEY, result.tuning);
      actionNote = t('Calibrated to your hand');
    }
    actionNoteUntil = performance.now() + 3500;
    interpreter.reset();
  }

  function onFrame(hands, tMs, aspect) {
    if (calibration) {
      reticle.hidden = true;
      const intent = interpreter.update(hands, tMs, aspect);
      draw(intent);
      calibrationFrame(hands, tMs, aspect);
      return;
    }
    const intent = interpreter.update(hands, tMs, aspect);
    // 👍 up (follow the selected target) is not wired here: clicking a
    // contact with the pointer already follows it.
    if (intent.hold?.name === 'follow') intent.hold = null;
    if (intent.micToggle) onMicToggle();
    const outcome = driver.apply(intent);
    draw(intent);
    placeReticle(intent.pointer);
    setStatus(describe(intent, outcome));
    if (help.open)
      diag.textContent = intent.poses
        .map(
          (h) =>
            `${h.key}: ${t('pinch gap')} ${h.pinch.toFixed(2)} · ${t('thumb behind')} ${h.thumbDepth.toFixed(2)}`,
        )
        .join('  |  ');
    renderMic();
  }

  const reflect = (on) => {
    publish({ active: on });
    panel.hidden = !on;
    if (on) openTopRight();
  };

  async function start() {
    if (tracker || starting) return;
    starting = true;
    const myGeneration = ++generation;
    reflect(true);
    setStatus(t('Starting camera…'));
    interpreter.reset();
    try {
      const next = await startHandTracker({ video, onFrame });
      if (myGeneration !== generation) {
        next.stop();
        return;
      }
      tracker = next;
      setStatus(t('Show a hand to the camera'));
    } catch (error) {
      if (myGeneration !== generation) return;
      const code = error instanceof HandTrackerError ? error.code : 'model';
      setStatus(
        code === 'denied'
          ? t('Camera blocked — allow it in the browser')
          : code === 'no-camera' || code === 'unsupported'
            ? t('No camera found')
            : t('Hand model failed to load'),
      );
      // Keep the panel open so the message is read; the toggle closes it.
    } finally {
      if (myGeneration === generation) starting = false;
    }
  }

  function stop() {
    generation++;
    starting = false;
    tracker?.stop();
    tracker = null;
    interpreter.reset();
    driver.stopLocal();
    calibration = null;
    reticle.hidden = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    reflect(false);
  }

  const onToggle = () => (panel.hidden ? void start() : stop());
  const onSlider = () => {
    sensitivity = Number(slider.value) || 1;
    try {
      localStorage.setItem(SENSITIVITY_KEY, String(sensitivity));
    } catch {
      /* private mode */
    }
  };
  // The tab in the background cannot see the hands; free the camera.
  const onVisibility = () => {
    if (document.visibilityState === 'hidden' && !panel.hidden) stop();
  };
  const onCalibrate = () => {
    if (!tracker) return;
    driver.takeOver('hand-calibrate');
    calibration = {
      step: 0,
      startedAt: null,
      samples: { pinch: [], open: [], fist: [] },
    };
  };
  const onResetTuning = () => {
    interpreter.setTuning(
      Object.fromEntries(CALIBRATED_KEYS.map((key) => [key, DEFAULTS[key]])),
    );
    writeStore(TUNING_KEY, null);
    actionNote = t('Default thresholds restored');
    actionNoteUntil = performance.now() + 2500;
  };
  const onLefty = () => {
    interpreter.leftHanded = lefty.checked;
    writeStore(LEFTY_KEY, lefty.checked);
  };
  calibrate.addEventListener('click', onCalibrate);
  resetTuning.addEventListener('click', onResetTuning);
  lefty.addEventListener('change', onLefty);
  const disconnect = connect({ toggleHands: onToggle });
  close.addEventListener('click', stop);
  slider.addEventListener('input', onSlider);
  document.addEventListener('visibilitychange', onVisibility);
  // QA handle: feed synthetic intents to the camera driver.
  const qaHandle = {
    apply: (intent) => driver.apply(intent),
    state: () => driver.state(),
    camera: () => {
      const pose = cameraOf(viewer).pose();
      return {
        lat: pose.lat,
        lon: pose.lon,
        height: pose.height,
        heading: (pose.heading * 180) / Math.PI,
        pitch: (pose.pitch * 180) / Math.PI,
      };
    },
  };
  window.__gevHandControl = qaHandle;

  return {
    destroy() {
      if (window.__gevHandControl === qaHandle) delete window.__gevHandControl;
      stop();
      disconnect?.();
      close.removeEventListener('click', stop);
      header.removeEventListener('pointerdown', onDragStart);
      slider.removeEventListener('input', onSlider);
      calibrate.removeEventListener('click', onCalibrate);
      resetTuning.removeEventListener('click', onResetTuning);
      lefty.removeEventListener('change', onLefty);
      driver.destroy();
      reticle.remove();
      document.removeEventListener('visibilitychange', onVisibility);
      panel.remove();
    },
  };
}
