import * as Cesium from 'cesium';
import {
  readCameraTargetFrame,
  createCameraOrientationAnimator,
} from '../../ui/cameraOrientationControls.js';
import {
  ANGLE_PRESETS,
  ANGLE_KEYS,
  activePreset,
  describeAngle,
  stepPitch,
  stepHeading,
} from './model.js';

/**
 * View-angle controls: four pitch presets, step tilt and rotate buttons, and
 * keyboard shortcuts ([ ] tilt, , . rotate). Every move orbits the point at
 * the centre of the screen (or the tracked aircraft/ship), using the app's
 * own orbit math and easing, so it behaves like the existing tilt button.
 *
 * Cesium's free tilt still works alongside this: Ctrl+drag or middle-drag
 * with a mouse, two-finger drag on touch.
 */

const toDeg = Cesium.Math.toDegrees;
const toRad = Cesium.Math.toRadians;

function camerasLocked(viewer) {
  return viewer?.scene?.screenSpaceCameraController?.enableInputs === false;
}

export function mountViewAngleControls({ viewer, documentRef = document }) {
  injectStyles(documentRef);
  const animator = createCameraOrientationAnimator(viewer, { duration: 450 });
  const root = documentRef.createElement('section');
  root.className = 'gev-angle';
  root.setAttribute('aria-label', 'View angle');
  root.innerHTML = `
    <div class="gev-angle-head"><span>VIEW ANGLE</span><output class="gev-angle-read" aria-live="polite"></output></div>
    <div class="gev-angle-row" role="group" aria-label="Angle presets">
      ${ANGLE_PRESETS.map((p) => `<button type="button" data-preset="${p.id}" title="${p.id === 'top' ? 'Straight down' : `${-p.pitch}° below the horizon`}">${p.label}</button>`).join('')}
    </div>
    <div class="gev-angle-row" role="group" aria-label="Fine adjust">
      <button type="button" data-rotate="-1" title="Rotate left 15° ( , )" aria-label="Rotate left">↺</button>
      <button type="button" data-tilt="1" title="Flatter, toward the horizon ( ] )" aria-label="Tilt toward horizon">▲</button>
      <button type="button" data-tilt="-1" title="Steeper, toward straight down ( [ )" aria-label="Tilt toward straight down">▼</button>
      <button type="button" data-rotate="1" title="Rotate right 15° ( . )" aria-label="Rotate right">↻</button>
    </div>`;
  documentRef.body.appendChild(root);
  const readout = root.querySelector('.gev-angle-read');

  /** Target pitch/heading, chained so rapid presses accumulate. */
  function current() {
    const frame = readCameraTargetFrame(viewer);
    if (!frame) return null;
    const pending = animator.destination;
    return {
      frame,
      pitch: toDeg(pending?.pitch ?? frame.pitch),
      heading: toDeg(pending?.heading ?? frame.heading),
    };
  }

  function go(pitchDeg, headingDeg) {
    if (camerasLocked(viewer)) return false;
    const now = current();
    if (!now) return false;
    const pitch = pitchDeg ?? now.pitch;
    const heading = headingDeg ?? now.heading;
    const ok = animator.animate(now.frame, {
      pitch: toRad(pitch),
      heading: toRad(heading),
    });
    if (ok) paint(pitch, heading);
    return ok;
  }

  function paint(pitchDeg, headingDeg) {
    readout.textContent = describeAngle(pitchDeg, headingDeg);
    const preset = activePreset(pitchDeg);
    for (const b of root.querySelectorAll('[data-preset]'))
      b.setAttribute('aria-pressed', String(b.dataset.preset === preset?.id));
  }

  function refresh() {
    const frame = readCameraTargetFrame(viewer);
    if (frame) paint(toDeg(frame.pitch), toDeg(frame.heading));
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const now = current();
    if (!now) return;
    if (b.dataset.preset) {
      const p = ANGLE_PRESETS.find((x) => x.id === b.dataset.preset);
      go(p.pitch, now.heading);
    } else if (b.dataset.tilt) {
      go(stepPitch(now.pitch, Number(b.dataset.tilt)), now.heading);
    } else if (b.dataset.rotate) {
      go(now.pitch, stepHeading(now.heading, Number(b.dataset.rotate)));
    }
  });

  const onKey = (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (
      e.target?.matches?.('input, textarea, select, [contenteditable="true"]')
    )
      return;
    const action = ANGLE_KEYS[e.key];
    if (!action) return;
    const now = current();
    if (!now) return;
    e.preventDefault();
    if (action.tilt) go(stepPitch(now.pitch, action.tilt), now.heading);
    if (action.rotate) go(now.pitch, stepHeading(now.heading, action.rotate));
  };
  documentRef.addEventListener('keydown', onKey);
  const offMove = viewer.camera.moveEnd.addEventListener(refresh);
  const offTracked = viewer.trackedEntityChanged?.addEventListener?.(
    animator.cancel,
  );
  refresh();

  return {
    go,
    /** Measured camera angle (degrees), not the commanded one. */
    read() {
      const frame = readCameraTargetFrame(viewer);
      return frame
        ? { pitch: toDeg(frame.pitch), heading: toDeg(frame.heading) }
        : null;
    },
    destroy() {
      animator.cancel();
      offMove?.();
      offTracked?.();
      documentRef.removeEventListener('keydown', onKey);
      root.remove();
    },
  };
}

const CSS = `
.gev-angle { position: fixed; z-index: 40; left: var(--left-stack-x, 52px);
  top: calc(var(--left-stack-top, 26vh) + 2 * var(--left-stack-gap, 72px) + 62px);
  width: var(--left-collapsed-width, 176px); padding: 8px 10px 10px; border-radius: var(--panel-radius, 16px);
  border: 1px solid var(--glass-border); background: var(--glass-bg); backdrop-filter: blur(14px);
  color: var(--text-primary); font-family: var(--font-mono); }
.gev-angle-head { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; }
.gev-angle-head span { font-size: 9.5px; letter-spacing: .16em; color: var(--text-secondary); }
.gev-angle-read { font-size: 10px; color: var(--accent); min-height: 13px; }
.gev-angle-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin-top: 4px; }
.gev-angle button { font: inherit; font-size: 11px; padding: 5px 0; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--glass-border); background: rgba(255,255,255,.05); color: var(--text-primary); }
.gev-angle button:hover { border-color: var(--accent); color: var(--accent); }
.gev-angle button[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-dim); color: var(--accent); }
@media (max-width: 900px) { .gev-angle { left: auto; right: 12px; top: auto; bottom: 110px; } }
`;

function injectStyles(documentRef) {
  if (documentRef.getElementById('gev-angle-styles')) return;
  const style = documentRef.createElement('style');
  style.id = 'gev-angle-styles';
  style.textContent = CSS;
  documentRef.head.appendChild(style);
}
