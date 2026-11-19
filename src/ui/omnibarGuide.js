// "Show me how": a short guided walk through the real controls. Each step
// spotlights the control to press, explains it in one line, and waits until
// the visitor presses it (or the step is already done), then moves on. It
// does not press the controls the walk is about. A layer walk clears
// layer-list filter chips only when they would hide the row it is about;
// steps scroll their target into view.
//
// The callout is a non-modal dialog: focus moves to it when a walk starts,
// the rest of the page stays usable (the walk is about pressing it), Escape
// ends the walk and no other key is taken.
//
// Recipes are data: any data layer gets one from its id, and the main
// features (styles, HUD, compass, tilt, globe view, share, clear) have their
// own. The walk works the same for all of them.

import { t } from '../i18n/index.js';
import { EXCLUSIVE_SURFACE_CLASSES } from '../exclusiveSurfaces.js';
import { LABEL_LAYERS } from './contextLayerTabs.js';

const LEFT_RAIL = '.ui-rail--left .ui-rail__item';
const RIGHT_RAIL = '.ui-rail--right .ui-rail__item';
const MOBILE_PANELS = {
  'data-panel': 'layers',
  'pp-toggles': 'more',
  'global-context-panel': 'context',
};
const SEARCH_BUTTON = '#layer-finder-search-btn';
const SEARCH_INPUT = '#layer-finder-input';
const FILTER_BUTTON = '#data-panel .layer-finder__filter button';
const AIRCRAFT_LAYERS = new Set(['flights', 'military', 'local-adsb']);
/** Above this altitude (metres) the camera already shows the globe. */
const GLOBE_ALTITUDE = 2_500_000;
/**
 * Layers spread wider than a street-level view, and the camera altitude
 * (metres) from which enough of them are in frame. Traffic layers spread over
 * a region: aircraft cruise kilometres up across hundreds of kilometres, so
 * from a low, tilted camera almost none are in view. Global layers read best
 * from the globe view.
 */
const VIEW_ALTITUDE = Object.freeze({
  flights: 150_000,
  military: 400_000,
  'local-adsb': 60_000,
  'ais-live-vessels': 120_000,
  satellites: GLOBE_ALTITUDE,
  'rocket-launches': GLOBE_ALTITUDE,
  'weather-cyclones': GLOBE_ALTITUDE,
  'telegeography-submarine-cables': GLOBE_ALTITUDE,
  earthquakes: GLOBE_ALTITUDE,
  'local-firms': GLOBE_ALTITUDE,
  'weather-satellite': GLOBE_ALTITUDE,
});

const $ = (selector, doc = globalThis.document) => doc?.querySelector(selector);

/** The camera altitude from the share hash, the app's own record of it. */
function cameraAltitude() {
  const alt = Number(
    new URLSearchParams(globalThis.location?.hash.slice(1) || '').get('alt'),
  );
  return Number.isFinite(alt) ? alt : 0;
}

const pressed = (selector) =>
  $(selector)?.getAttribute('aria-pressed') === 'true';
const screenIsOwned = (doc) =>
  EXCLUSIVE_SURFACE_CLASSES.some((name) => doc.body.classList.contains(name));

/** Steps that open a side panel from its rail, unless it is already open. */
function openPanelSteps(rail, item, label) {
  const button = () =>
    MOBILE_PANELS[item] &&
    globalThis.document?.body.classList.contains('mobile-shell')
      ? $(`#mobile-tab-bar [data-mobile-sheet="${MOBILE_PANELS[item]}"]`)
      : $(`${rail}[data-rail-item="${item}"]`);
  return [
    {
      targets: () => [button()],
      text: () => t('Open {panel}', { panel: label }),
      done: () =>
        button()?.getAttribute('aria-pressed') === 'true' ||
        button()?.getAttribute('aria-expanded') === 'true',
    },
  ];
}

/** Steps that open the Visual panel from the left rail. */
function openVisualSteps() {
  return openPanelSteps(LEFT_RAIL, 'pp-toggles', t('Visual'));
}

/** Steps that bring up a section of Context's Properties tab. */
function propertiesSteps(section, text) {
  const pane = `#context-tab-${section}`;
  const tab = () => $('#context-tab-btn-props');
  return [
    ...openPanelSteps(RIGHT_RAIL, 'global-context-panel', t('Context')),
    {
      targets: () => [tab()],
      text: () => t('Open Properties: settings for the layers that are on'),
      skip: () => !tab(),
      done: () => tab()?.getAttribute('aria-selected') === 'true',
    },
    {
      prepare: () => $(pane)?.scrollIntoView?.({ block: 'center' }),
      targets: () => [$(pane)?.closest('.context-props__section') || $(pane)],
      text,
      skip: () => !$(pane)?.offsetParent,
    },
  ];
}

const rowHidden = (selector) =>
  Boolean($(selector)?.classList.contains('is-filtered'));
const hasSearchQuery = () => Boolean($(SEARCH_INPUT)?.value.trim());

/**
 * The settings that change what a layer shows: its own option chips in the
 * Data layers row, then, where they apply, the Display panel's detection
 * labels and how dense they are.
 * @param {{id: string, shown: string}} layer
 */
export function layerSettingsGuide(layer) {
  const rowSelector = `[data-layer-id="${layer.id}"]`;
  const controls = `${rowSelector} .data-toggle-controls`;
  const chipNames = () =>
    [...(globalThis.document?.querySelectorAll(`${controls} button`) || [])]
      .map((chip) => {
        const name = chip.textContent.trim();
        const what = chip.getAttribute('title');
        // The title as translated: lowering its first letter is wrong in
        // German and other languages.
        return what ? `${name}: ${what}` : name;
      })
      .filter(Boolean)
      .join(' · ');
  return [
    ...openPanelSteps(LEFT_RAIL, 'data-panel', t('Data layers')),
    {
      prepare: () => $(rowSelector)?.scrollIntoView?.({ block: 'center' }),
      targets: () => [$(controls)],
      text: () =>
        chipNames()
          ? t('{layer} options. {options}', {
              layer: layer.shown,
              options: chipNames(),
            })
          : t('{layer} options appear here once it has loaded.', {
              layer: layer.shown,
            }),
      skip: () => !$(controls),
    },
    // Labels and 3D models now sit in Context's Properties while their
    // layers are on.
    ...(LABEL_LAYERS.has(layer.id)
      ? propertiesSteps('labels', () =>
          t(
            'Labels tag {layer} on the map. Density sets how many are labelled; Fade and Outside set how they thin out beyond the scope.',
            {
              layer: layer.shown,
            },
          ),
        )
      : []),
    ...(AIRCRAFT_LAYERS.has(layer.id)
      ? propertiesSteps('aircraft', () =>
          t(
            '3D models: Proximity shows them up close only, All shows every aircraft as a model.',
          ),
        )
      : []),
  ];
}

/**
 * The walk for one data layer.
 * @param {{id: string, shown: string}} layer
 * @param {(id: string) => boolean} isEnabled
 * @param {{readAltitude?: () => number}} [options] Current camera altitude in metres.
 */
export function layerGuide(
  layer,
  isEnabled,
  { readAltitude = cameraAltitude } = {},
) {
  const rowSelector = `[data-layer-id="${layer.id}"]`;
  return [
    // The walk asks for Data layers to be opened (or skips that when it is
    // open); it closes no panel the visitor has open.
    ...openPanelSteps(LEFT_RAIL, 'data-panel', t('Data layers')),
    {
      // A filter left on from before could hide the row; start from the full list.
      prepare: () => {
        if (rowHidden(rowSelector) && !hasSearchQuery()) {
          for (const chip of globalThis.document.querySelectorAll(
            '#data-panel .layer-finder__chip',
          ))
            chip.click();
        }
      },
      targets: () => [$(SEARCH_BUTTON)],
      text: () =>
        t('Press search to find {layer} in the list', { layer: layer.shown }),
      skip: () => isEnabled(layer.id) || !$(SEARCH_BUTTON),
      done: () => pressed(SEARCH_BUTTON),
    },
    {
      targets: () => [$(SEARCH_INPUT)],
      text: () => t('Type {layer}', { layer: layer.shown }),
      skip: () => isEnabled(layer.id) || !$(SEARCH_INPUT),
      done: () => hasSearchQuery() && !rowHidden(rowSelector),
    },
    {
      prepare: () => $(rowSelector)?.scrollIntoView?.({ block: 'center' }),
      targets: () => [$(rowSelector), $(`${rowSelector} .data-toggle-btn`)],
      text: () => t('Turn on {layer} with its switch', { layer: layer.shown }),
      skip: () => isEnabled(layer.id),
      done: () => isEnabled(layer.id),
    },
    {
      // Too close to see them: zoom out (any way) or press the globe view.
      targets: () => [$('#reset-globe-view')],
      text: () =>
        VIEW_ALTITUDE[layer.id] >= GLOBE_ALTITUDE
          ? t('{layer} are easiest to see from the globe view', {
              layer: layer.shown,
            })
          : t(
              '{layer} spread over a wide area, so few are in view this close. Zoom out, or press the globe view.',
              {
                layer: layer.shown,
              },
            ),
      skip: () =>
        !VIEW_ALTITUDE[layer.id] || readAltitude() >= VIEW_ALTITUDE[layer.id],
      done: () => readAltitude() >= VIEW_ALTITUDE[layer.id],
    },
    {
      // The end: offer the settings that shape this layer.
      text: () =>
        t('{layer} is on. Want to fine-tune what it shows?', {
          layer: layer.shown,
        }),
      offer: {
        label: () => t('Show settings'),
        steps: () => layerSettingsGuide(layer),
      },
    },
  ];
}

/** Walks for features, keyed like the omnibar's commands. */
export const FEATURE_GUIDES = Object.freeze({
  styles: () => [
    ...openVisualSteps(),
    {
      prepare: () =>
        $('.visual-presets__grid')?.scrollIntoView?.({ block: 'center' }),
      targets: () => [$('.visual-presets__grid')],
      text: () =>
        t('Pick a look: Normal, CRT, NVG, FLIR, Anime or Noir (keys 1–6)'),
    },
  ],
  'map-source': () => [
    ...openVisualSteps(),
    {
      prepare: () =>
        $('#pp-toggles .visual-presets')?.scrollIntoView?.({ block: 'start' }),
      targets: () => [$('#pp-toggles .visual-presets')],
      text: () =>
        t(
          'Under Map source, pick the map underneath: Google 3D, Bing, Esri or OpenStreetMap',
        ),
    },
  ],
  hud: () => [
    ...openVisualSteps(),
    {
      prepare: () => $('#hud-toggle')?.scrollIntoView?.({ block: 'center' }),
      targets: () => [$('#hud-toggle')],
      text: () =>
        t('Switch the HUD on or off here; Layout picks Tactical or Minimal'),
    },
  ],
  scope: () => [
    ...openVisualSteps(),
    {
      prepare: () => $('#scope-toggle')?.scrollIntoView?.({ block: 'center' }),
      targets: () => [$('#scope-toggle')?.closest('.pp-toggle-group')],
      text: () =>
        t(
          'Scope frames the view in a circle. Feather softens its edge, Opacity sets how dark it shades outside.',
        ),
    },
  ],
  clean: () => [
    ...openVisualSteps(),
    {
      prepare: () =>
        $('#clean-view-toggle')?.scrollIntoView?.({ block: 'center' }),
      targets: () => [$('#clean-view-toggle')],
      text: () => t('Clean UI hides the panels and readouts for a clear view'),
    },
  ],
  'find-layer': () => [
    ...openPanelSteps(LEFT_RAIL, 'data-panel', t('Data layers')),
    {
      targets: () => [$(SEARCH_BUTTON)],
      text: () => t('Press search, then type part of a layer name or source'),
      done: () => pressed(SEARCH_BUTTON),
    },
    {
      targets: () => [$(SEARCH_INPUT)],
      text: () => t('Type to narrow the list; Esc clears it'),
      done: hasSearchQuery,
    },
    {
      targets: () => [$(FILTER_BUTTON)],
      text: () =>
        t('Filter shows only layers that are on or off, or one category'),
    },
  ],
  'filter-layers': () => [
    ...openPanelSteps(LEFT_RAIL, 'data-panel', t('Data layers')),
    {
      targets: () => [$(FILTER_BUTTON)],
      text: () => t('Open the filter'),
      done: () => $(FILTER_BUTTON)?.getAttribute('aria-expanded') === 'true',
    },
    {
      targets: () => [$('.layer-finder__menu')],
      text: () =>
        t(
          'Pick a status (On, Off) and a category; each shows as a chip you can clear',
        ),
    },
  ],
  'section-index': () => [
    ...openPanelSteps(LEFT_RAIL, 'data-panel', t('Data layers')),
    {
      targets: () => [$('.layer-section-index')],
      text: () => t('Hover a tick to see its group; click to jump there'),
    },
  ],
  preferences: () => [
    {
      targets: () => [$('#corner-actions')],
      text: () => t('Add provider keys with Power Up, or change the language'),
    },
  ],
  edge: () => [
    ...openPanelSteps(LEFT_RAIL, 'data-panel', t('Data layers')),
    {
      targets: () => [$('#data-panel .ui-panel-edge')],
      text: () =>
        t(
          'Press this to slide panels over the rail to the screen edge; press again to bring them back',
        ),
    },
  ],
  context: () => [
    ...openPanelSteps(RIGHT_RAIL, 'global-context-panel', t('Context')),
    {
      targets: () => [$('#global-context-panel .cyber-panel-body')],
      text: () =>
        t(
          'Context describes the view: weather, hazards, what your layers have nearby, and whatever you pick on the map',
        ),
    },
  ],
  properties: () =>
    propertiesSteps('labels', () =>
      t(
        'Properties holds the settings for the layers that are on, each layer marked by a coloured dot',
      ),
    ),
  north: () => [
    {
      targets: () => [$('#north-up-view')],
      text: () => t('Press the compass to face north'),
    },
  ],
  tilt: () => [
    {
      targets: () => [$('#tilt-map-view')],
      text: () => t('Tilt the camera for a 3D view'),
    },
  ],
  globe: () => [
    {
      targets: () => [$('#reset-globe-view')],
      text: () => t('Zoom out to the whole globe'),
    },
  ],
  share: () => [
    {
      targets: () => [$('#share-btn')],
      text: () => t('Copy a link to exactly this view'),
    },
  ],
  clear: () => [
    {
      targets: () => [$('#clear-selected-layers')],
      text: () => t('Turn off every layer at once'),
    },
  ],
  // Drawing, and measuring with it: a line shows its length and an area its
  // size while it is drawn (src/annotations/drawMode.js).
  draw: () => [
    ...openPanelSteps(LEFT_RAIL, 'utilities-panel', t('Utilities')),
    {
      prepare: () => $('#draw-group')?.scrollIntoView?.({ block: 'center' }),
      targets: () => [$('#draw-toggle')],
      text: () => t('Press Draw to start drawing on the map'),
      skip: () => pressed('#draw-toggle'),
      done: () => pressed('#draw-toggle'),
    },
    {
      targets: () => [$('#draw-mode-row')],
      text: () =>
        t(
          'Pick Line to measure a distance or Area for its size, then click points on the map; double-click or Enter finishes',
        ),
    },
  ],
});

/** The omnibar command ids that have a feature walk. */
export function featureGuideFor(commandId) {
  if (commandId.startsWith('style-')) return 'styles';
  if (commandId.startsWith('map-')) return 'map-source';
  if (commandId.startsWith('hud-')) return 'hud';
  if (commandId === 'reset') return 'globe';
  return FEATURE_GUIDES[commandId] ? commandId : null;
}

let active = null;

/**
 * Run a walk. Starting another ends the one in progress.
 * @param {Array<object>} steps
 * @param {{title?: string}} [options]
 */
export function startGuide(steps, { title = '' } = {}) {
  active?.stop();
  const doc = globalThis.document;
  if (!doc?.body || screenIsOwned(doc) || !steps?.length) return;
  const root = doc.createElement('div');
  root.className = 'gev-guide';
  root.innerHTML =
    '<div class="gev-guide-ring"><i></i></div>' +
    '<div class="gev-guide-callout" role="dialog" aria-modal="false" tabindex="-1" aria-labelledby="gev-guide-title" aria-describedby="gev-guide-text">' +
    '<div class="gev-guide-head"><p id="gev-guide-title" class="gev-guide-title"></p>' +
    '<p class="gev-guide-count"></p>' +
    '<button type="button" class="gev-guide-close"><span aria-hidden="true">×</span></button></div>' +
    '<ol class="gev-guide-progress" aria-hidden="true"></ol>' +
    '<div class="gev-guide-body"><p id="gev-guide-text" class="gev-guide-text"></p>' +
    '<p class="gev-guide-hint"><span class="gev-guide-hint-dot"></span><span></span></p></div>' +
    '<div class="gev-guide-actions"><p class="gev-guide-keys"><kbd></kbd><span></span></p>' +
    '<span><button type="button" class="gev-guide-skip" hidden></button>' +
    '<button type="button" class="gev-guide-offer" hidden></button>' +
    '<button type="button" class="gev-guide-next"></button></span></div>' +
    // Announces each step once; the dialog itself is not a live region, so
    // its buttons and progress are not read out on every change.
    '<p class="gev-guide-status" role="status" aria-live="polite"></p></div>';
  // Focus returns where it was when the walk ends, if that is still there.
  const returnFocus = doc.activeElement;
  doc.body.append(root);
  const ring = root.querySelector('.gev-guide-ring');
  const callout = root.querySelector('.gev-guide-callout');
  const subRings = [];
  const endLabel = t('End guide');
  root.querySelector('.gev-guide-close').setAttribute('aria-label', endLabel);
  root.querySelector('.gev-guide-close').title = endLabel;
  // i18n-ignore: the Escape keycap, matching the keyboard shortcut.
  root.querySelector('.gev-guide-keys kbd').textContent = 'Esc';
  root.querySelector('.gev-guide-keys span').textContent = t('to end');
  root.querySelector('.gev-guide-title').textContent = title
    ? t('Guide · {topic}', { topic: title })
    : t('Guide');
  root.querySelector('.gev-guide-next').textContent = t('Next');
  root.querySelector('.gev-guide-hint span:last-child').textContent = t(
    'Press the highlighted control',
  );

  const live = steps.filter(Boolean);
  let index = -1;
  let frame = 0;
  let advanceTimer = 0;
  let stopped = false;
  let current = null;
  let shown = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    clearInterval(poll);
    clearTimeout(advanceTimer);
    resizeObserver?.disconnect();
    globalThis.removeEventListener?.('resize', schedule);
    doc.removeEventListener('scroll', schedule, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKey, true);
    const hadFocus = root.contains(doc.activeElement);
    root.remove();
    if (hadFocus && returnFocus?.isConnected) returnFocus.focus?.();
    if (active?.stop === stop) active = null;
  };
  const next = () => {
    clearTimeout(advanceTimer);
    advanceTimer = 0;
    void run(index + 1);
  };

  const advance = () => {
    if (advanceTimer) return;
    advanceTimer = setTimeout(next, 350);
  };

  async function run(at) {
    if (stopped) return;
    if (screenIsOwned(doc)) return stop();
    current = null;
    index = at;
    const step = live[index];
    if (!step) return stop();
    await step.prepare?.();
    if (stopped || at !== index) return;
    if (step.skip?.() || step.done?.()) return run(index + 1);
    current = step;
    shown += 1;
    // The total is what is shown so far plus the steps still to come that
    // would not be skipped as things stand.
    const total =
      shown + live.slice(index + 1).filter((later) => !later.skip?.()).length;
    root.querySelector('.gev-guide-count').textContent = `${shown} / ${total}`;
    const progress = root.querySelector('.gev-guide-progress');
    progress.replaceChildren(
      ...Array.from({ length: total }, (_, i) => {
        const dot = doc.createElement('li');
        if (i < shown - 1) dot.className = 'done';
        if (i === shown - 1) dot.className = 'current';
        return dot;
      }),
    );
    const text = step.text();
    root.querySelector('.gev-guide-text').textContent = text;
    root.querySelector('.gev-guide-status').textContent =
      `${shown} / ${total}: ${text}`;
    // Steps that point at a control wait for it to be pressed; say so.
    const waits = Boolean(step.targets) && !step.offer;
    root.querySelector('.gev-guide-hint').hidden = !waits;
    const offer = root.querySelector('.gev-guide-offer');
    const skip = root.querySelector('.gev-guide-skip');
    offer.hidden = !step.offer;
    skip.hidden = !step.offer;
    root.querySelector('.gev-guide-keys').hidden = Boolean(step.offer);
    if (step.offer) {
      offer.textContent = step.offer.label();
      skip.textContent = t('Not now');
    }
    const last = index === live.length - 1;
    const nextButton = root.querySelector('.gev-guide-next');
    nextButton.hidden = Boolean(step.offer);
    nextButton.textContent = last
      ? t('Finish')
      : waits
        ? t('Skip step')
        : t('Next');
    nextButton.classList.toggle('quiet', waits && !last);
    // Replay the entrance so each step reads as new.
    callout.classList.remove('swap');
    void callout.offsetWidth;
    callout.classList.add('swap');
    root.classList.add('visible');
    schedule();
  }

  // The visitor pressed the spotlit control: give the app a moment to react,
  // then move on (or let `done` decide, for steps that wait on a state).
  function onClick(event) {
    if (!current || callout.contains(event.target)) return;
    const [target] = current.targets?.() || [];
    if (target?.contains(event.target) && !current.done) advance();
  }
  // Only Escape is the walk's: it ends the walk and nothing else (the
  // Omnibar or a panel behind it stays as it is). Every other key goes on to
  // the page untouched.
  function onKey(event) {
    if (screenIsOwned(doc)) {
      stop();
      return;
    }
    if (event.key !== 'Escape' || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    stop();
  }
  root.querySelector('.gev-guide-skip').addEventListener('click', stop);
  root.querySelector('.gev-guide-close').addEventListener('click', stop);
  root.querySelector('.gev-guide-next').addEventListener('click', () => {
    if (current) next();
  });
  // Taking the offer carries the walk on with its steps.
  root.querySelector('.gev-guide-offer').addEventListener('click', () => {
    if (!current?.offer) return;
    const extra = current.offer.steps() || [];
    live.splice(index + 1, live.length, ...extra.filter(Boolean));
    next();
  });
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKey, true);

  // Follow the targets as panels open and scroll, and notice when a step's
  // goal is reached however it happened: on resize and scroll, when the page
  // changes size, and otherwise four times a second (panels slide open
  // without an event to follow). Each is at most one frame's work.
  let poll = 0;
  let resizeObserver = null;
  function schedule() {
    if (stopped || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      place();
    });
  }
  const place = () => {
    if (screenIsOwned(doc)) return stop();
    if (!current) return;
    if (current.done?.()) advance();
    const targets = (current.targets?.() || []).filter(Boolean);
    const [main, ...rest] = targets.map((element) =>
      element.getBoundingClientRect(),
    );
    if (!main || !main.width) {
      // Nothing to point at (the closing offer): centre the callout.
      ring.style.opacity = '0';
      subRings.forEach((sub) => (sub.style.opacity = '0'));
      callout.dataset.side = 'none';
      callout.style.left = `${(innerWidth - (callout.offsetWidth || 280)) / 2}px`;
      callout.style.top = `${innerHeight * 0.32}px`;
      return;
    }
    const pad = 6;
    Object.assign(ring.style, {
      opacity: '1',
      left: `${main.left - pad}px`,
      top: `${main.top - pad}px`,
      width: `${main.width + pad * 2}px`,
      height: `${main.height + pad * 2}px`,
    });
    while (subRings.length < rest.length) {
      const sub = doc.createElement('div');
      sub.className = 'gev-guide-ring gev-guide-ring--sub';
      root.append(sub);
      subRings.push(sub);
    }
    subRings.forEach((sub, i) => {
      const box = rest[i];
      Object.assign(
        sub.style,
        box?.width
          ? {
              opacity: '1',
              left: `${box.left - 4}px`,
              top: `${box.top - 4}px`,
              width: `${box.width + 8}px`,
              height: `${box.height + 8}px`,
            }
          : { opacity: '0' },
      );
    });
    // The callout sits beside the target, on whichever side has room.
    const width = callout.offsetWidth || 280;
    const height = callout.offsetHeight || 120;
    const gap = 18;
    const right = main.right + pad + gap;
    const onRight = right + width < innerWidth - 12;
    const left = onRight ? right : Math.max(12, main.left - pad - gap - width);
    const centre = main.top + main.height / 2;
    const top = Math.max(
      12,
      Math.min(innerHeight - height - 12, centre - height / 2),
    );
    // The arrow points at the target's middle, kept inside the callout.
    callout.dataset.side = onRight ? 'right' : 'left';
    callout.style.setProperty(
      '--gev-guide-arrow-y',
      `${Math.min(height - 18, Math.max(18, centre - top))}px`,
    );
    callout.style.left = `${left}px`;
    callout.style.top = `${top}px`;
  };
  globalThis.addEventListener?.('resize', schedule);
  doc.addEventListener('scroll', schedule, true);
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(doc.body);
  }
  // A hidden tab has nothing to follow: the poll rests until it is shown.
  poll = setInterval(() => {
    if (!doc.hidden) schedule();
  }, 250);
  schedule();
  callout.focus({ preventScroll: true });

  active = { stop };
  void run(0);
  return stop;
}
