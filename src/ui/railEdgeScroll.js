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
/** Things in the strip that keep their own pointer and wheel behaviour. */
const OWN_CONTROLS =
  'a, button, input, select, textarea, [role="dialog"], .ui-panel, #first-run-launcher, #cesium-credits';

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
  let frame = 0;

  const rails = () =>
    ['left', 'right']
      .map((side) => ({ side, rail: doc.querySelector(`.ui-rail--${side}`) }))
      .filter(({ rail }) => rail && rail.getBoundingClientRect().width > 0);

  const items = (rail) =>
    [...rail.querySelectorAll('.ui-rail__item')].filter((item) => !item.disabled);

  // ── The sliding highlight ──
  // Each rail draws it as a ::before under its items, placed by custom
  // properties; the open item's own background steps aside while it shows.
  // Vue rewrites a rail's class list when it folds its labels, so whether the
  // highlight is showing is kept here, and the classes are put back each time.
  const gliding = new WeakSet();
  function glide(rail) {
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
    // Appearing from nothing: jump into place, then fade in.
    rail.classList.toggle('ui-rail--glide-jump', !shown);
    rail.style.setProperty('--rail-glide-x', `${box.left - railBox.left - rail.clientLeft}px`);
    rail.style.setProperty('--rail-glide-y', `${box.top - railBox.top - rail.clientTop}px`);
    rail.style.setProperty('--rail-glide-w', `${box.width}px`);
    rail.style.setProperty('--rail-glide-h', `${box.height}px`);
    rail.classList.add('ui-rail--glide');
    gliding.add(rail);
    if (!shown) win.requestAnimationFrame(() => rail.classList.remove('ui-rail--glide-jump'));
  }

  // Follow the rails for a few frames after any change, as their items
  // resize while labels fold away.
  function follow(frames = 24) {
    win.cancelAnimationFrame(frame);
    let left = frames;
    const tick = () => {
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
          if (records.some((record) => record.target.classList?.contains('ui-rail__item')))
            win.requestAnimationFrame(() => follow());
        })
      : null;
  observer?.observe(doc.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-pressed'],
  });

  // ── The edge strip ──
  /** The rail whose strip holds the point, unless a control there owns it. */
  function railAt(x, target) {
    if (doc.body.classList.contains('mobile-shell') || coarse?.matches) return null;
    for (const { side, rail } of rails()) {
      const box = rail.getBoundingClientRect();
      const inStrip =
        side === 'left'
          ? x <= box.right + STRIP_MARGIN
          : x >= box.left - STRIP_MARGIN;
      if (!inStrip) continue;
      if (rail.contains(target)) return rail;
      if (target?.closest?.(OWN_CONTROLS)) return null;
      return rail;
    }
    return null;
  }

  function setHot(rail) {
    if (rail === hot) return;
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
    const current = list.findIndex((item) => item.getAttribute('aria-pressed') === 'true');
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
      panel.classList.add(direction > 0 ? 'rail-switch-down' : 'rail-switch-up');
      panel.addEventListener(
        'animationend',
        () => panel.classList.remove('rail-switch-down', 'rail-switch-up'),
        { once: true },
      );
    }
    follow();
  }

  function onWheel(event) {
    if (!hot || event.ctrlKey) return;
    // Recheck: the pointer may not have moved since the panels changed.
    if (railAt(event.clientX, event.target) !== hot) return setHot(null);
    event.preventDefault();
    event.stopPropagation();
    const now = win.performance?.now?.() ?? Date.now();
    const speed = Math.abs(event.deltaY);
    // A new gesture: after a pause, after turning round, or a fresh flick
    // while the last one is still coasting (the speed jumps back up).
    const turned = travel && Math.sign(event.deltaY) !== Math.sign(travel);
    const flick = stepped && speed > 20 && speed > lastSpeed * 2;
    if (now - lastWheel > GESTURE_GAP_MS || turned || flick) {
      travel = 0;
      stepped = false;
    }
    lastWheel = now;
    lastSpeed = speed;
    if (stepped) return;
    travel += event.deltaY;
    if (Math.abs(travel) < STEP_DELTA) return;
    stepped = true;
    step(Math.sign(travel));
  }

  const onResize = () => follow(2);
  doc.addEventListener('pointermove', onMove, { passive: true });
  doc.addEventListener('pointerout', onLeave, { passive: true });
  win.addEventListener('wheel', onWheel, { capture: true, passive: false });
  win.addEventListener('resize', onResize, { passive: true });
  follow();

  return () => {
    setHot(null);
    observer?.disconnect();
    win.cancelAnimationFrame(frame);
    doc.removeEventListener('pointermove', onMove);
    doc.removeEventListener('pointerout', onLeave);
    win.removeEventListener('wheel', onWheel, { capture: true });
    win.removeEventListener('resize', onResize);
    doc.querySelectorAll('.ui-rail').forEach((rail) =>
      rail.classList.remove('ui-rail--glide', 'ui-rail--glide-jump', 'ui-rail--edge-hot'),
    );
  };
}
