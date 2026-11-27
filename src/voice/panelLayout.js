import { nextTick } from 'vue';

// The last height each dock root showed, so the next panel can grow from it.
const handoffs = new WeakMap();

/** Place an assistant panel above the command dock after it renders. */
export function bindAssistantPanelLayout({ ui, name }) {
  let cancelled = false;
  let teardown = () => {};
  void nextTick(() => {
    if (!cancelled) teardown = layOut({ ui, name });
  });
  return () => {
    cancelled = true;
    teardown();
  };
}

function layOut({ ui, name }) {
  const panel = ui.element(name);
  const root = ui.element('root');
  if (!panel || !root?.getBoundingClientRect) return () => {};
  const lifetime = new AbortController();
  const doc = panel.ownerDocument;
  const view = doc.defaultView || window;
  const listen = (target, event, handler) =>
    target?.addEventListener(event, handler, { signal: lifetime.signal });
  const isMobile = () => view.matchMedia?.('(max-width: 720px)').matches;
  const shown = (element) =>
    !element.hidden && element.checkVisibility?.() !== false;
  const floatingReply = panel.querySelector('#gev-chat-mini-reply');
  let frame = 0;
  let wasShown = false;
  let lastHeight = 0;
  let animateNext = false;
  let heightAnimation = null;
  // What the last placement depended on, short of measuring.
  let placedInputs = '';
  const animateHeight = (from, to) => {
    if (view.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    heightAnimation?.cancel();
    heightAnimation = panel.animate?.(
      [
        { height: `${from}px`, overflow: 'hidden' },
        { height: `${to}px`, overflow: 'hidden' },
      ],
      { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    );
    // Frames skipped while it runs are placed once it ends.
    if (heightAnimation) heightAnimation.onfinish = schedule;
  };
  const place = () => {
    const minimized = Boolean(panel.dataset.minimized);
    const mobile = isMobile();
    // The height animation resizes the panel every frame. While it runs and
    // nothing it was placed for has changed, leave the placement as it is;
    // it is placed again when the animation finishes.
    const inputs = [
      minimized,
      mobile,
      panel.hidden,
      root.dataset?.chatOpen,
      root.dataset?.assistantMode,
      view.innerWidth,
      view.innerHeight,
    ].join('|');
    if (
      heightAnimation?.playState === 'running' &&
      !animateNext &&
      inputs === placedInputs
    )
      return;
    placedInputs = inputs;
    if (lifetime.signal.aborted) return;
    if (panel.hidden || !shown(panel)) {
      wasShown = false;
      return;
    }
    // Offsets are from the root's padding box, inside its border.
    const box = root.getBoundingClientRect();
    const anchor = {
      left: box.left + (root.clientLeft || 0),
      top: box.top + (root.clientTop || 0),
    };
    const anchorBottom = anchor.top + (root.clientHeight || box.height);
    const w = view.innerWidth;
    const h = view.innerHeight;
    // Above the dock on its centre line, at the panel's own CSS size; phones
    // get a full-width sheet above the tab bar. The bottom edge is the
    // anchor, so height changes grow upward from the dock.
    const dockRect = doc
      .getElementById?.('command-dock')
      ?.getBoundingClientRect();
    if (mobile && !minimized) panel.style.width = `${w - 16}px`;
    else panel.style.removeProperty('width');
    const rect = panel.getBoundingClientRect();
    const centre = dockRect?.width ? dockRect.left + dockRect.width / 2 : w / 2;
    const x = Math.max(
      8,
      Math.min(centre - rect.width / 2, w - rect.width - 8),
    );
    const replyRect = floatingReply?.getBoundingClientRect();
    const above = replyRect?.height ? Math.max(0, rect.top - replyRect.top) : 0;
    const base = Math.min(dockRect?.top ?? Infinity, box.top);
    const ceiling = base - rect.height - 16;
    const y = Math.max(8 + above, Math.min(ceiling, h - rect.height - 8));
    panel.style.left = `${x - anchor.left}px`;
    panel.style.top = 'auto';
    panel.style.bottom = `${anchorBottom - (y + rect.height)}px`;
    panel.style.transform = 'none';
    // Grow from the panel shown before (chat and voice swap), or from this
    // panel's last height when its view changes. A running animation is
    // mid-flight, so its frames are not recorded as the panel's height.
    if (heightAnimation?.playState === 'running' && !animateNext) return;
    const height = rect.height;
    const previous = handoffs.get(root);
    const from = minimized
      ? 0
      : !wasShown
        ? previous?.panel !== panel && !shown(previous?.panel ?? panel)
          ? previous?.height
          : 0
        : animateNext
          ? lastHeight
          : 0;
    animateNext = false;
    wasShown = true;
    if (from && Math.abs(from - height) > 8) animateHeight(from, height);
    lastHeight = height;
    if (!minimized) handoffs.set(root, { panel, height });
  };
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(place);
  };
  listen(view, 'resize', schedule);
  // The dock slides into place; observers report size changes, not moves.
  const commandDock = doc.getElementById?.('command-dock');
  listen(commandDock, 'transitionend', schedule);
  listen(commandDock, 'animationend', schedule);
  const resize = new ResizeObserver(schedule);
  resize.observe(panel);
  resize.observe(root);
  if (floatingReply) resize.observe(floatingReply);
  // Show, hide, minimize and view changes place at once; only resizes wait
  // for a frame. A view change animates from the old height.
  const changes = new MutationObserver((records) => {
    if (records.some((record) => record.attributeName === 'data-view'))
      animateNext = true;
    place();
  });
  changes.observe(panel, {
    attributes: true,
    attributeFilter: ['hidden', 'data-minimized', 'data-view'],
  });
  // Chat and voice hide each other through root state, not their own hidden.
  changes.observe(root, {
    attributes: true,
    attributeFilter: ['data-chat-open', 'data-assistant-mode'],
  });
  place();
  return () => {
    lifetime.abort();
    cancelAnimationFrame(frame);
    resize.disconnect();
    changes.disconnect();
    heightAnimation?.cancel();
  };
}
