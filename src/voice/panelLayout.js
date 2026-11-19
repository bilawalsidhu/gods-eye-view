import { nextTick } from 'vue';

const DOCK_KEY = 'gev.panel.docked';

// The last height each dock root showed, so the next panel can grow from it.
const handoffs = new WeakMap();

function readDocked() {
  try {
    return localStorage.getItem(DOCK_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * The shared dock choice for the assistant panels: above the dock, or docked
 * into the right rail's lane. Bind it before the panels' layouts, which place
 * again after it toggles.
 * @returns {() => void} Removes the listener.
 */
export function bindLayoutDock(ui) {
  ui.update('layout', { docked: readDocked() });
  return ui.on('layout-dock', () => {
    const docked = !ui.state.layout.docked;
    try {
      localStorage.setItem(DOCK_KEY, String(docked));
    } catch {
      /* Storage is optional. */
    }
    ui.update('layout', { docked, trayDocked: false });
  });
}

/**
 * Place an assistant panel (`chatPanel` or `voicePanel`, as the presenter
 * names it) above the command dock, or docked into the right rail's lane. The
 * panel renders on the next tick; session and presentation ownership stay
 * with the caller.
 */
export function bindAssistantPanelLayout({ ui, name, minimize, restore }) {
  let cancelled = false;
  let teardown = () => {};
  void nextTick(() => {
    if (!cancelled) teardown = layOut({ ui, name, minimize, restore });
  });
  return () => {
    cancelled = true;
    teardown();
  };
}

function layOut({ ui, name, minimize, restore }) {
  const panel = ui.element(name);
  const root = ui.element('root');
  if (!panel || !root?.getBoundingClientRect) return () => {};
  const lifetime = new AbortController();
  const doc = panel.ownerDocument;
  const view = doc.defaultView || window;
  panel.dataset.assistantPanel = '';
  const isDocked = () => Boolean(ui.state.layout.docked);
  const listen = (target, event, handler) =>
    target?.addEventListener(event, handler, { signal: lifetime.signal });
  const isMobile = () => view.matchMedia?.('(max-width: 720px)').matches;
  const shown = (element) =>
    !element.hidden && element.checkVisibility?.() !== false;
  // The rail yields its lane while any assistant panel is docked over it.
  const syncRail = () => {
    const occupied =
      isDocked() &&
      !isMobile() &&
      [...(root.querySelectorAll?.('[data-assistant-panel]') ?? [])].some(
        (item) => shown(item) && !item.dataset.minimized,
      );
    const body = doc.body;
    if (!body?.dataset) return;
    if (occupied) body.dataset.assistantDocked = 'true';
    else delete body.dataset.assistantDocked;
  };
  const floatingReply = panel.querySelector('#gev-chat-mini-reply');
  // The dock's Location and Visual Presets wings open trays above the dock.
  // They are looked up on use, since the dock can mount or re-render after
  // this binds; each new wing is watched as it is found. Trays open, close
  // and pin through the wings' classes.
  const trayChanges = new MutationObserver(() => {
    schedule();
    release();
  });
  const leaveWing = () => {
    release();
    schedule();
  };
  const watchedWings = new WeakSet();
  const wings = () => {
    const found = ['location-bar', 'control-panel']
      .map((id) => doc.getElementById?.(id))
      .filter(Boolean);
    for (const wing of found) {
      if (watchedWings.has(wing)) continue;
      watchedWings.add(wing);
      trayChanges.observe(wing, {
        attributes: true,
        attributeFilter: ['class'],
      });
      listen(wing, 'pointerleave', leaveWing);
    }
    return found;
  };
  const openTrays = () =>
    wings()
      .filter((wing) => !wing.classList.contains('collapsed'))
      .map((wing) => wing.querySelector('.dock-popover-content'))
      .filter((tray) => tray && shown(tray));
  const trayOpen = () =>
    wings().some(
      (wing) => !wing.classList.contains('collapsed') && shown(wing),
    );
  // A centred panel yields to the trays as its minimized bar. The yield
  // passes to the other panel on a switch, and ends with an expand, or once
  // the trays close and the pointer leaves the wings. A dock taken for a
  // tray ends then too.
  const yieldToTrays = () => {
    ui.update('layout', { yielded: name });
    minimize();
  };
  // Touch screens can keep :hover on the last wing tapped.
  const hovered = (wing) =>
    view.matchMedia?.('(hover: hover)').matches && wing.matches?.(':hover');
  const release = () => {
    if (trayOpen() || wings().some(hovered)) return;
    // Either panel's layout may end the dock; the other re-places on its own
    // schedule.
    if (ui.state.layout.trayDocked) {
      ui.update('layout', { docked: false, trayDocked: false });
      place();
    }
    if (ui.state.layout.yielded !== name) return;
    ui.update('layout', { yielded: null });
    if (shown(panel) && panel.dataset.minimized) restore();
  };
  let frame = 0;
  let seen = false;
  let wasMinimized = false;
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
    // Minimized bars always sit centred above the dock; only an expanded
    // docked panel takes the right lane.
    const mobile = isMobile();
    const inLane = isDocked() && !minimized && !mobile;
    // The height animation resizes the panel every frame. While it runs and
    // nothing it was placed for has changed, leave the placement as it is;
    // it is placed again when the animation finishes.
    const inputs = [
      minimized,
      isDocked(),
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
    panel.dataset.placement = inLane ? 'docked' : 'compact';
    syncRail();
    if (lifetime.signal.aborted) return;
    if (panel.hidden || !shown(panel)) {
      wasShown = false;
      seen = false;
      wasMinimized = false;
      return;
    }
    const appearing = !seen;
    const expanding = !appearing && wasMinimized && !minimized;
    seen = true;
    wasMinimized = minimized;
    if (!isDocked() && !mobile) {
      // A panel opened or switched to while the trays hold the centre
      // starts as its bar.
      if (appearing && !minimized && (ui.state.layout.yielded || trayOpen())) {
        yieldToTrays();
        return;
      }
      // Expanding over an open tray takes the right lane instead of covering
      // it. Only the layout state changes; the saved dock choice stays.
      if (expanding && trayOpen()) {
        ui.update('layout', { docked: true, trayDocked: true, yielded: null });
        void nextTick(place);
        return;
      }
    }
    if (expanding && ui.state.layout.yielded === name)
      ui.update('layout', { yielded: null });
    // Offsets are from the root's padding box, inside its border.
    const box = root.getBoundingClientRect();
    const anchor = {
      left: box.left + (root.clientLeft || 0),
      top: box.top + (root.clientTop || 0),
    };
    const anchorBottom = anchor.top + (root.clientHeight || box.height);
    let measured = null;
    const w = view.innerWidth,
      h = view.innerHeight;
    if (inLane) {
      const rail = doc.getElementById?.('right-context-rail');
      const lane = rail?.getBoundingClientRect();
      // The panel takes the rail's whole column, its icon strip included;
      // the hidden strip keeps its layout.
      const strip = rail
        ?.querySelector?.('.gev-panel-rail--right')
        ?.getBoundingClientRect();
      const right = lane?.width
        ? Math.max(lane.right, strip?.right || 0)
        : w - 52;
      const width = lane?.width ? right - lane.left : 330;
      const top = lane?.width ? lane.top : h * 0.26;
      const bottom = Number(rail?.dataset.safeBottom) || h * 0.77;
      panel.style.width = `${width}px`;
      panel.style.height = `${Math.max(240, bottom - top)}px`;
      panel.style.left = `${right - width - anchor.left}px`;
      panel.style.top = `${top - anchor.top}px`;
      panel.style.bottom = 'auto';
    } else {
      // Above the dock on its centre line, at the panel's own CSS size; phones
      // get a full-width sheet above the tab bar. The bottom edge is the
      // anchor, so height changes grow upward from the dock.
      const dockRect = doc
        .getElementById?.('command-dock')
        ?.getBoundingClientRect();
      panel.style.removeProperty('height');
      if (mobile && !minimized) panel.style.width = `${w - 16}px`;
      else panel.style.removeProperty('width');
      const rect = panel.getBoundingClientRect();
      const centre = dockRect?.width
        ? dockRect.left + dockRect.width / 2
        : w / 2;
      const x = Math.max(
        8,
        Math.min(centre - rect.width / 2, w - rect.width - 8),
      );
      const replyRect = floatingReply?.getBoundingClientRect();
      const above = replyRect?.height
        ? Math.max(0, rect.top - replyRect.top)
        : 0;
      // The voice control rises above the dock; keep the gap from its top,
      // and rest above any open tray under the panel.
      const trayTop = openTrays()
        .map((tray) => tray.getBoundingClientRect())
        .filter((tray) => tray.left < x + rect.width && tray.right > x)
        .reduce((top, tray) => Math.min(top, tray.top), Infinity);
      const base = Math.min(dockRect?.top ?? Infinity, box.top, trayTop);
      const ceiling = base - rect.height - 16;
      const y = Math.max(8 + above, Math.min(ceiling, h - rect.height - 8));
      panel.style.left = `${x - anchor.left}px`;
      panel.style.top = 'auto';
      panel.style.bottom = `${anchorBottom - (y + rect.height)}px`;
      measured = rect.height;
    }
    panel.style.transform = 'none';
    // Grow from the panel shown before (chat and voice swap), or from this
    // panel's last height when its view changes. A running animation is
    // mid-flight, so its frames are not recorded as the panel's height.
    if (heightAnimation?.playState === 'running' && !animateNext) return;
    // A centred panel was measured above; placing it moves it but keeps its
    // size. The lane's height is set here, so it is measured again.
    const height = measured ?? panel.getBoundingClientRect().height;
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
  // The dock choice toggles first (bindLayoutDock), then each panel places.
  // Undocking while a tray is open brings the panel back as its bar.
  const offDock = ui.on('layout-dock', () =>
    nextTick(() => {
      if (
        !isDocked() &&
        !isMobile() &&
        trayOpen() &&
        shown(panel) &&
        !panel.dataset.minimized
      )
        yieldToTrays();
      place();
    }),
  );
  listen(view, 'resize', schedule);
  // The dock slides into place; observers report size changes, not moves.
  const commandDock = doc.getElementById?.('command-dock');
  listen(commandDock, 'transitionend', schedule);
  listen(commandDock, 'animationend', schedule);
  // A rail panel opened while docked (a typed "show cameras", say) wins the
  // lane: the assistant panel steps down to its minimized bar.
  const rail = doc.getElementById?.('right-context-rail');
  const expandedRailPanels = () =>
    new Set(
      [...(rail?.children ?? [])]
        .filter(
          (item) =>
            item.matches?.('[data-panel-id]') &&
            !item.classList.contains('collapsed'),
        )
        .map((item) => item.id),
    );
  let railOpen = expandedRailPanels();
  // Rail panels open and close through their own class, so only the rail's
  // direct children are watched, each as it joins the rail.
  const watchedRailPanels = new WeakSet();
  const watchRailPanels = () => {
    for (const item of rail?.children ?? []) {
      if (watchedRailPanels.has(item)) continue;
      watchedRailPanels.add(item);
      railChanges.observe(item, {
        attributes: true,
        attributeFilter: ['class'],
      });
    }
  };
  const railChanges = new MutationObserver((records) => {
    if (records.some((record) => record.type === 'childList'))
      watchRailPanels();
    if (!records.some((record) => record.type === 'attributes')) return;
    const next = expandedRailPanels();
    const opened = [...next].some((id) => !railOpen.has(id));
    railOpen = next;
    if (
      opened &&
      panel.dataset.placement === 'docked' &&
      shown(panel) &&
      !panel.dataset.minimized
    )
      minimize();
  });
  if (rail) {
    railChanges.observe(rail, { childList: true });
    watchRailPanels();
  }
  // Reaching for a wing's button steps a centred panel down to its bar,
  // which then rests above the tray.
  const reachWing = ({ target }) => {
    if (
      target?.closest?.('.dock-tray-toggle') &&
      wings().some((wing) => wing.contains(target)) &&
      panel.dataset.placement === 'compact' &&
      !isMobile() &&
      shown(panel) &&
      !panel.dataset.minimized
    )
      yieldToTrays();
  };
  for (const event of ['pointerover', 'pointerdown'])
    listen(doc, event, reachWing);
  wings();
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
    railChanges.disconnect();
    trayChanges.disconnect();
    heightAnimation?.cancel();
    offDock();
    delete panel.dataset.assistantPanel;
    syncRail();
  };
}
