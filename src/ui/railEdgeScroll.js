// Edge scrolling for the side rails. While the pointer is in a screen edge's
// strip (from the edge to just past its rail), that rail's border lights up,
// and the scroll wheel steps to the next or previous panel on that side
// instead of zooming the globe, wrapping round at either end. The open item's
// highlight slides between items however the panel changes, and a panel
// opened by the wheel slides in from the direction of travel.

/** How far past the rail the strip reaches, in pixels. */
const STRIP_MARGIN = 16;
/** Wheel travel (pixels) that counts as one step. */
const STEP_DELTA = 40;
/**
 * A pause this long (ms) with no wheel events ends a scroll gesture. One
 * gesture moves one step, however long it runs, trackpad coasting included.
 */
const GESTURE_GAP_MS = 180;
/** After a step, how long (ms) before the same motion can count as a new flick. */
const STEP_COOLDOWN_MS = 220;
/**
 * The least time (ms) between two steps, whatever the wheel does. A motion
 * that would step sooner waits and steps once the gap has passed (one step
 * held at most), so panels never switch back to back and no step is lost.
 */
const STEP_GAP_MS = 500;
/** A wheel event this large (pixels) is a mouse wheel notch, not a trackpad. */
const NOTCH_DELTA = 100;
/** The widest the strip gets, measured from the screen edge, whatever shape the rail takes. */
const STRIP_MAX = 84;
/**
 * After a step, how long (ms) the rest of that gesture is still swallowed once
 * the pointer has left the strip, so trackpad coasting does not go on to zoom
 * the globe. Past it, the wheel belongs to whatever is under the pointer.
 */
const COAST_MAX_MS = 800;
/** Pixels per wheel line, for mice that report lines rather than pixels. */
const LINE_PX = 16;
/**
 * Things in the strip that keep their own pointer and wheel behaviour: any
 * control, and every panel in either side's stack (a panel scrolls itself).
 */
const OWN_CONTROLS =
  'a, button, input, select, textarea, dialog, [role="dialog"], .ui-panel, #left-panel-stack > :not(.gev-panel-rail), #right-context-rail > :not(.gev-panel-rail), #first-run-launcher, #cesium-credits, #world-timeline';

/**
 * @param {Document} [doc]
 * @returns {() => void} removes the listeners and observers
 */
export function installRailEdgeScroll(doc = globalThis.document) {
  const win = doc?.defaultView;
  if (!doc || !win) return () => {};
  const coarse = win.matchMedia?.('(pointer: coarse)');

  let hot = null;
  let travel = 0;
  let lastWheel = 0;
  let lastSpeed = 0;
  let stepped = false;
  /** When the last step was taken, the fastest the gesture has been, and whether it has slowed since. */
  let steppedAt = 0;
  /** A step waiting for the gap to pass, if any. */
  let heldStep = 0;
  let peakSpeed = 0;
  let slowed = false;
  let frame = 0;
  /** Set once removed, so frames already queued do nothing. */
  let removed = false;

  // Clean view and recording hide the rails with visibility and opacity,
  // which keep their boxes, so a box alone does not mean the rail shows.
  const showing = (node) =>
    node.getBoundingClientRect().width > 0 &&
    (typeof node.checkVisibility !== 'function' ||
      node.checkVisibility({
        visibilityProperty: true,
        opacityProperty: true,
      }));

  // Which screen edge a rail is on comes from where it is, not its name: in a
  // right-to-left language the left stack sits on the right.
  const rails = () =>
    ['left', 'right']
      .map((name) => doc.querySelector(`.ui-rail--${name}`))
      .filter((rail) => rail && showing(rail))
      .map((rail) => {
        const box = rail.getBoundingClientRect();
        const middle = doc.documentElement.clientWidth / 2;
        return {
          side: box.left + box.width / 2 < middle ? 'left' : 'right',
          rail,
        };
      });

  const items = (rail) =>
    // Only items that show: a theme or mode may hide some, and the wheel must
    // not open those.
    [...rail.querySelectorAll('.ui-rail__item')].filter(
      (item) => !item.disabled && showing(item),
    );

  // ── The sliding highlight ──
  // Each rail draws it as a ::before under its items, placed by custom
  // properties; the open item's own background steps aside while it shows.
  // Vue rewrites a rail's class list when it folds its labels, so whether the
  // highlight is showing is kept here, and the classes are put back each time.
  const gliding = new WeakSet();

  function glide(rail) {
    if (removed) return;
    rail.classList.toggle('ui-rail--edge-hot', rail === hot);
    const on = rail.querySelector('.ui-rail__item[aria-pressed="true"]');
    if (!on?.offsetWidth) {
      gliding.delete(rail);
      rail.classList.remove('ui-rail--glide');
      return;
    }
    const railBox = rail.getBoundingClientRect();
    const box = on.getBoundingClientRect();
    const shown = gliding.has(rail);
    // A rail opening its first panel folds its labelled pills to icons, the
    // buttons shrinking over a few frames; the highlight waits until the open
    // button is an icon again (square) rather than fading in at a pill's
    // width and then shrinking.
    if (
      !shown &&
      (rail.classList.contains('ui-rail--expanded') ||
        box.width > box.height + 2)
    )
      return;
    // Appearing from nothing: jump into place, then fade in.
    rail.classList.toggle('ui-rail--glide-jump', !shown);
    rail.style.setProperty(
      '--rail-glide-x',
      `${box.left - railBox.left - rail.clientLeft}px`,
    );
    rail.style.setProperty(
      '--rail-glide-y',
      `${box.top - railBox.top - rail.clientTop}px`,
    );
    rail.style.setProperty('--rail-glide-w', `${box.width}px`);
    rail.style.setProperty('--rail-glide-h', `${box.height}px`);
    rail.classList.add('ui-rail--glide');
    gliding.add(rail);
    if (!shown)
      win.requestAnimationFrame(() =>
        rail.classList.remove('ui-rail--glide-jump'),
      );
  }

  // Follow the rails for a few frames after any change, as their items
  // resize while labels fold away.
  function follow(frames = 24) {
    win.cancelAnimationFrame(frame);
    let left = frames;
    const tick = () => {
      if (removed) return;
      watchRails();
      doc.querySelectorAll('.ui-rail').forEach(glide);
      if ((left -= 1) > 0) frame = win.requestAnimationFrame(tick);
    };
    tick();
  }

  const observer =
    typeof win.MutationObserver === 'function'
      ? new win.MutationObserver((records) => {
          // A rail item opened or closed. Nothing here writes aria-pressed,
          // and the work waits for the next frame, so this never feeds itself.
          if (
            records.some((record) =>
              record.target.classList?.contains('ui-rail__item'),
            )
          )
            win.requestAnimationFrame(() => follow());
        })
      : null;
  observer?.observe(doc.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-pressed'],
  });

  // A rail also changes shape with nothing pressed or released: hidden and
  // shown again (Context docked and undocked), or turned from a column to a
  // row (panels moved to the screen edge). Its highlight is placed again
  // whenever its size changes, so it is never left where an icon was.
  const sized =
    typeof win.ResizeObserver === 'function'
      ? new win.ResizeObserver(() => follow(2))
      : null;
  const watched = new WeakSet();
  const watchRails = () => {
    if (!sized) return;
    doc.querySelectorAll('.ui-rail').forEach((rail) => {
      if (watched.has(rail)) return;
      watched.add(rail);
      sized.observe(rail);
    });
  };
  watchRails();

  // ── The edge strip ──
  /** The rail whose strip holds the point, unless a control there owns it. */
  function railAt(x, target) {
    if (doc.body.classList.contains('mobile-shell') || coarse?.matches)
      return null;
    for (const { side, rail } of rails()) {
      const box = rail.getBoundingClientRect();
      // From the screen edge to just past the rail, but never wider than a
      // rail's own column: a rail laid out as a row across the top of its
      // panels would otherwise claim most of the panel's width.
      const width = doc.documentElement.clientWidth;
      const inStrip =
        side === 'left'
          ? x <= Math.min(box.right + STRIP_MARGIN, STRIP_MAX)
          : x >= Math.max(box.left - STRIP_MARGIN, width - STRIP_MAX);
      if (!inStrip) continue;
      if (rail.contains(target)) return rail;
      if (target?.closest?.(OWN_CONTROLS)) return null;
      return rail;
    }
    return null;
  }

  function setHot(rail) {
    if (rail === hot) return;
    // A held step belongs to the strip it was made in; leaving drops it, so
    // coming back later does not set it off with no wheel turned.
    if (heldStep) {
      win.clearTimeout(heldStep);
      heldStep = 0;
    }
    hot?.classList.remove('ui-rail--edge-hot');
    hot = rail;
    travel = 0;
    hot?.classList.add('ui-rail--edge-hot');
    follow(2);
  }

  function onMove(event) {
    setHot(railAt(event.clientX, event.target));
  }

  function onLeave(event) {
    if (!event.relatedTarget) setHot(null);
  }

  function step(direction) {
    const list = items(hot);
    if (!list.length) return;
    const current = list.findIndex(
      (item) => item.getAttribute('aria-pressed') === 'true',
    );
    // Past either end, carry on from the other.
    const nextIndex =
      current < 0
        ? direction > 0
          ? 0
          : list.length - 1
        : (current + direction + list.length) % list.length;
    if (nextIndex === current) return;
    const target = list[nextIndex];
    target.click();
    const panel = doc.getElementById(target.dataset.railItem);
    if (panel) {
      panel.classList.remove('rail-switch-down', 'rail-switch-up');
      void panel.offsetWidth;
      panel.classList.add(
        direction > 0 ? 'rail-switch-down' : 'rail-switch-up',
      );
      // The classes come off when the slide ends, or after a moment where
      // there is no slide to end (reduced motion).
      const settle = () => {
        win.clearTimeout(timer);
        panel.removeEventListener('animationend', settle);
        panel.classList.remove('rail-switch-down', 'rail-switch-up');
      };
      const timer = win.setTimeout(settle, 600);
      panel.addEventListener('animationend', settle);
    }
    follow();
  }

  function onWheel(event) {
    // Pinch zoom, and sideways or empty moves (trackpads send them mid-swipe),
    // are left alone: they neither step nor turn a gesture round.
    if (event.ctrlKey || !event.deltaY) return;
    const now = win.performance?.now?.() ?? Date.now();
    const inGesture = now - lastWheel <= GESTURE_GAP_MS;
    // Recheck: the pointer may not have moved since the panels changed.
    const stillHot =
      Boolean(hot) && railAt(event.clientX, event.target) === hot;
    if (!stillHot) {
      setHot(null);
      // The rest of a gesture that has already stepped is used up here, so
      // its coasting does not go on to zoom the globe or scroll what opened
      // under the pointer.
      if (stepped && inGesture && now - steppedAt <= COAST_MAX_MS) {
        event.preventDefault();
        event.stopPropagation();
        lastWheel = now;
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Line- and page-based wheels report far smaller numbers than pixels.
    const deltaY =
      event.deltaMode === 1
        ? event.deltaY * LINE_PX
        : event.deltaMode === 2
          ? event.deltaY * win.innerHeight
          : event.deltaY;
    const speed = Math.abs(deltaY);
    // A new gesture: after a pause, after turning round, a mouse wheel notch,
    // or a fresh flick while the last one is still coasting. A flick is a
    // rise in speed after the gesture has clearly slowed, and not in the
    // moment after a step: a swipe is still speeding up when it first steps.
    const turned = travel && Math.sign(deltaY) !== Math.sign(travel);
    const cooled = now - steppedAt > STEP_COOLDOWN_MS;
    // Every event from a line- or page-based wheel is a notch.
    const notch =
      stepped && cooled && (speed >= NOTCH_DELTA || event.deltaMode > 0);
    const flick =
      stepped && cooled && slowed && speed > Math.max(8, lastSpeed * 1.8);
    if (!inGesture || turned || notch || flick) {
      // A held step belongs to the motion it came from; a reversal or a new
      // flick replaces it rather than queueing behind it.
      if (turned && heldStep) {
        win.clearTimeout(heldStep);
        heldStep = 0;
      }
      travel = 0;
      stepped = false;
      peakSpeed = 0;
      slowed = false;
    }
    lastWheel = now;
    lastSpeed = speed;
    peakSpeed = Math.max(peakSpeed, speed);
    if (stepped) {
      if (speed < peakSpeed * 0.5) slowed = true;
      return;
    }
    travel += deltaY;
    if (Math.abs(travel) < STEP_DELTA) return;
    stepped = true;
    const direction = Math.sign(travel);
    const wait = STEP_GAP_MS - (now - steppedAt);
    if (wait <= 0) {
      steppedAt = now;
      step(direction);
      return;
    }
    // Too soon after the last step: hold this one until the gap has passed.
    if (heldStep) return;
    const heldRail = hot;
    heldStep = win.setTimeout(() => {
      heldStep = 0;
      // The pointer may have left the strip, or moved to the other rail,
      // meanwhile; then nothing steps.
      if (!hot || hot !== heldRail) return;
      steppedAt = win.performance?.now?.() ?? Date.now();
      step(direction);
    }, wait);
  }

  const onResize = () => follow(2);
  doc.addEventListener('pointermove', onMove, { passive: true });
  doc.addEventListener('pointerout', onLeave, { passive: true });
  win.addEventListener('wheel', onWheel, { capture: true, passive: false });
  win.addEventListener('resize', onResize, { passive: true });
  follow();

  return () => {
    removed = true;
    win.clearTimeout(heldStep);
    setHot(null);
    observer?.disconnect();
    sized?.disconnect();
    win.cancelAnimationFrame(frame);
    doc.removeEventListener('pointermove', onMove);
    doc.removeEventListener('pointerout', onLeave);
    win.removeEventListener('wheel', onWheel, { capture: true });
    win.removeEventListener('resize', onResize);
    doc.querySelectorAll('.ui-rail').forEach((rail) => {
      rail.classList.remove(
        'ui-rail--glide',
        'ui-rail--glide-jump',
        'ui-rail--edge-hot',
      );
    });
  };
}
