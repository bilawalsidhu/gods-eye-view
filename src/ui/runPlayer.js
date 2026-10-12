/**
 * The run player (GEN-310): play a simulated run through time.
 *
 * Shown while a world-model layer looks at a `sim/` head. Play, pause, step
 * and scrub move the query time of EVERY world-model layer on that head
 * together, one stored epoch of the receiver track at a time, so the
 * receiver, emitters, links and coverage stay at one instant. A strip draws
 * `sinr_db` over the whole run with the jammer's active windows shaded and a
 * cursor at the current time; a banner says the receiver's state there.
 *
 * The player owns no query state: it writes `validAt` through the manager
 * like the row chips do, and reads it back. A time set from elsewhere (the
 * host's typed time, a row chip) pauses the player and moves its cursor.
 *
 * Under the strip, the run's mission effects (GEN-299): one lane each for
 * communications, collection and navigation, a cell per published row,
 * coloured by its state. Unknown is hatched, never drawn as an outage;
 * opportunities sharing an epoch keep their own cells. When the host opened
 * the run with its pair's nominal case, each lane has the nominal lane under
 * it and a row marks every cell whose state differs. The models the effects
 * came from, and whether any is validated, are said under the lanes. A run
 * with effects but no receiver track plays at the effects' own epochs.
 */
import { SIM_HEAD_PREFIX } from '../layers/worldModel/simulationRuns.js';
import { RECEIVER_TRACK_BINDING } from '../layers/worldModel/receiverPass.js';
import { SPEEDS, createRunClock } from '../layers/worldModel/runClock.js';
import { RECEIVER_STATES } from '../layers/worldModel/receiverPass.js';
import {
  bannerOf,
  createRunTimelines,
  nearestIndex,
  rowAt,
  stripGeometry,
} from '../layers/worldModel/runTimeline.js';
import {
  compareLanes,
  createRunEffects,
  effectsBannerText,
  effectsTimeline,
  lanesGeometry,
} from '../layers/worldModel/runEffects.js';
import { runFocus } from '../layers/worldModel/runFocus.js';

const TICK_MS = 100;
const STRIP = Object.freeze({ width: 480, height: 56 });
const ROOT_CLASS = 'gev-run-player';

const STYLE = `
.${ROOT_CLASS} {
  position: absolute; left: 50%; bottom: 128px; transform: translateX(-50%);
  width: min(520px, calc(100% - 32px)); z-index: 20; box-sizing: border-box;
  padding: 10px 12px 8px; border-radius: 10px;
  background: rgba(10, 10, 15, 0.82); border: 1px solid rgba(0, 212, 255, 0.25);
  backdrop-filter: blur(6px); color: #d8f6ff;
  font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 11px;
}
.${ROOT_CLASS}[hidden] { display: none; }
.${ROOT_CLASS} .rp-banner {
  display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
  font-size: 12px; letter-spacing: 0.06em; font-weight: 600;
}
.${ROOT_CLASS} .rp-swatch { width: 10px; height: 10px; border-radius: 2px; flex: none; }
.${ROOT_CLASS} .rp-banner-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${ROOT_CLASS} .rp-time { color: #8fdcf0; font-weight: 400; }
.${ROOT_CLASS} .rp-strip { position: relative; }
.${ROOT_CLASS} .rp-threshold {
  position: absolute; right: 2px; transform: translateY(-100%);
  font-size: 9px; line-height: 1; padding: 1px 3px; border-radius: 3px;
  background: rgba(10, 10, 15, 0.7); pointer-events: none;
}
.${ROOT_CLASS} svg { display: block; width: 100%; height: 56px; cursor: pointer; touch-action: none; }
.${ROOT_CLASS} svg:focus-visible { outline: 1px solid var(--accent, #00d4ff); outline-offset: 2px; }
.${ROOT_CLASS} .rp-axis { display: flex; justify-content: space-between; gap: 8px; color: #6fa9b8; margin-top: 2px; white-space: nowrap; }
.${ROOT_CLASS} .rp-range { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.${ROOT_CLASS} .rp-controls { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.${ROOT_CLASS} button {
  font: inherit; color: inherit; background: rgba(0, 212, 255, 0.08);
  border: 1px solid rgba(0, 212, 255, 0.3); border-radius: 6px;
  padding: 3px 8px; cursor: pointer;
}
.${ROOT_CLASS} button:hover { background: rgba(0, 212, 255, 0.18); }
.${ROOT_CLASS} button[aria-pressed='true'] { background: rgba(0, 212, 255, 0.3); border-color: var(--accent, #00d4ff); }
.${ROOT_CLASS} .rp-play { min-width: 64px; }
.${ROOT_CLASS} .rp-spacer { flex: 1; }
.${ROOT_CLASS} .rp-note { color: #6fa9b8; }
.${ROOT_CLASS} .rp-lanes { display: grid; grid-template-columns: 68px 1fr; column-gap: 6px; margin-top: 6px; }
.${ROOT_CLASS} .rp-lanes[hidden] { display: none; }
.${ROOT_CLASS} .rp-lane-labels { position: relative; color: #6fa9b8; font-size: 9px; }
.${ROOT_CLASS} .rp-lane-labels span { position: absolute; right: 0; white-space: nowrap; line-height: 8px; }
.${ROOT_CLASS} .rp-lane-labels span.rp-sub { color: #4f7f8c; }
.${ROOT_CLASS} .rp-strip[hidden] { display: none; }
.${ROOT_CLASS} .rp-lanes svg { height: auto; }
.${ROOT_CLASS} .rp-model { margin-top: 4px; color: #6fa9b8; font-size: 10px; }
.${ROOT_CLASS} .rp-model[hidden] { display: none; }
.${ROOT_CLASS} .rp-model .rp-warn { color: #ffb84d; }
`;

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes))
    node.setAttribute(key, String(value));
  return node;
}

function rgb([r, g, b], alpha = 1) {
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

/** A threshold line takes its state's colour: nominal at or above it, unavailable below it. */
const THRESHOLD_STATES = Object.freeze({ nominal: 0, unavailable: 2 });

function sinr(db) {
  return `${Math.round(db)}`.replace('-', '\u2212');
}

function clockText(ms) {
  return `${new Date(ms).toISOString().slice(11, 19)}Z`;
}

/** What the player shows: the run, its revision and its comparison. */
function runKey(run) {
  return [run.head, run.revisionId ?? '', run.compare?.head ?? '', run.compare?.revisionId ?? ''].join('|');
}

/** World-model layers (they expose their projection source) and their params. */
function worldModelLayers(dataManager) {
  const out = [];
  for (const [id, entry] of dataManager?.layers ?? []) {
    const module = entry?.module;
    if (typeof module?.getProjectionSource !== 'function') continue;
    let params;
    try {
      params = module.getParams();
    } catch {
      continue;
    }
    out.push({ id, entry, module, params });
  }
  return out;
}

/**
 * The run on screen: the head of an enabled world-model layer on a `sim/`
 * head (the receiver track's layer first) and every layer on that head.
 * The revision is the player's to resolve: the layer's drawn revision can
 * still be the head it just left -- unless the layer is pinned to the one a
 * receipt named. A run the host opened (`focus`) that put no layer on screen,
 * such as one with mission effects only, is on screen too (GEN-299).
 */
export function runOnScreen(layers, focus = null) {
  const run = layerRun(layers);
  if (run) {
    const focused = focus?.head === run.head ? focus : null;
    return {
      ...run,
      revisionId: run.revisionId ?? focused?.revisionId ?? null,
      compare: focused?.compare ?? null,
      headAdvanced: focused?.headAdvanced ?? false,
    };
  }
  if (!focus?.head || !focus.source) return null;
  return {
    head: focus.head,
    validAt: null,
    source: focus.source,
    layerIds: [],
    revisionId: focus.revisionId,
    compare: focus.compare,
    headAdvanced: focus.headAdvanced,
  };
}

function layerRun(layers) {
  const onRun = layers.filter(
    (layer) =>
      layer.entry.enabled && layer.params.head?.startsWith(SIM_HEAD_PREFIX),
  );
  if (!onRun.length) return null;
  const lead =
    onRun.find((layer) =>
      (layer.params.layers ?? []).includes(RECEIVER_TRACK_BINDING),
    ) ?? onRun[0];
  const head = lead.params.head;
  return {
    head,
    validAt: lead.params.validAt ?? null,
    revisionId:
      lead.params.follow === 'pinned' ? (lead.params.revisionId ?? null) : null,
    source: lead.module.getProjectionSource(),
    layerIds: layers
      .filter((layer) => layer.params.head === head)
      .map((layer) => layer.id),
  };
}

/**
 * Mount the player into `container` (the viewer's). Returns the cleanup.
 * @param {{dataManager: object, container: HTMLElement}} options
 */
export function mountRunPlayer({ dataManager, container }) {
  if (!dataManager || !container) return () => {};
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const root = document.createElement('section');
  root.className = ROOT_CLASS;
  root.hidden = true;
  root.setAttribute('aria-label', 'Simulated run player');
  root.innerHTML = `
    <div class="rp-banner" role="status" aria-live="polite">
      <span class="rp-swatch"></span>
      <span class="rp-banner-text"></span>
      <span class="rp-time"></span>
    </div>
    <div class="rp-strip"><svg viewBox="0 0 ${STRIP.width} ${STRIP.height}" preserveAspectRatio="none" tabindex="0"
      role="slider" aria-label="Run time (SINR over the run)"></svg></div>
    <div class="rp-axis"><span class="rp-start"></span><span class="rp-range"></span><span class="rp-end"></span></div>
    <div class="rp-lanes" hidden><div class="rp-lane-labels"></div>
      <svg class="rp-lane-svg" preserveAspectRatio="none" role="img" aria-label="Mission effects over the run"></svg></div>
    <div class="rp-model" hidden></div>
    <div class="rp-controls">
      <button type="button" class="rp-back" title="Back one epoch" aria-label="Back one epoch">◀◀</button>
      <button type="button" class="rp-play">▶ PLAY</button>
      <button type="button" class="rp-forward" title="Forward one epoch" aria-label="Forward one epoch">▶▶</button>
      <span class="rp-spacer"></span>
      <span class="rp-note"></span>
      ${SPEEDS.map((s) => `<button type="button" class="rp-speed" data-speed="${s}" aria-pressed="false">${s}×</button>`).join('')}
    </div>`;
  container.appendChild(root);
  const $ = (selector) => root.querySelector(selector);
  const strip = $('svg');
  const laneSvg = $('.rp-lane-svg');

  const readers = new WeakMap(); // source -> timeline reader
  const effectReaders = new WeakMap(); // source -> effects reader
  const state = {
    key: null, // the run head the timeline belongs to
    run: null,
    timeline: null,
    clock: null,
    lastApplied: null,
    cursorMs: null,
    lastTick: performance.now(),
    loading: null,
    dragging: false,
    effects: null, // {lanes, card} of the run
    compared: null, // {lanes} of the pair's nominal case, when the host named it
    differences: [],
  };

  function readerFor(source) {
    if (!readers.has(source)) readers.set(source, createRunTimelines(source));
    return readers.get(source);
  }

  function effectsReaderFor(source) {
    if (!effectReaders.has(source))
      effectReaders.set(source, createRunEffects(source));
    return effectReaders.get(source);
  }

  /** Every world-model layer on the run's head goes to `validAt`. */
  function apply(validAt) {
    state.lastApplied = validAt;
    state.cursorMs = Date.parse(validAt);
    for (const layerId of state.run?.layerIds ?? []) {
      try {
        dataManager.setLayerParams(layerId, { validAt });
      } catch (error) {
        console.warn(`[RunPlayer] ${layerId} refused ${validAt}:`, error);
      }
    }
  }

  function applyIndex() {
    apply(state.timeline.rows[state.clock.index].validAt);
  }

  function drawStrip() {
    strip.replaceChildren();
    for (const tag of root.querySelectorAll('.rp-threshold')) tag.remove();
    const timeline = state.timeline;
    if (!timeline) return;
    const geometry = stripGeometry(timeline, STRIP);
    for (const w of geometry.windows) {
      strip.appendChild(
        svg('rect', {
          x: w.x0,
          y: 0,
          width: Math.max(1, w.x1 - w.x0),
          height: STRIP.height,
          fill: 'rgba(255, 70, 70, 0.16)',
        }),
      );
    }
    for (const line of geometry.lines) {
      strip.appendChild(
        svg('polyline', {
          points: line.map(([x, y]) => `${x},${y}`).join(' '),
          fill: 'none',
          stroke: '#8fdcf0',
          'stroke-width': 1.5,
          'vector-effect': 'non-scaling-stroke',
        }),
      );
    }
    // The receiver response's thresholds (GEN-313), in the colours of the
    // states they separate, labelled over the strip (SVG text would stretch).
    for (const t of geometry.thresholds) {
      const colour = rgb(RECEIVER_STATES[THRESHOLD_STATES[t.name]].colorRgb);
      strip.appendChild(
        svg('line', {
          class: 'rp-threshold-line',
          x1: 0,
          x2: STRIP.width,
          y1: t.y,
          y2: t.y,
          stroke: colour,
          'stroke-width': 1,
          'stroke-dasharray': '4 3',
          'vector-effect': 'non-scaling-stroke',
        }),
      );
      const tag = document.createElement('span');
      tag.className = 'rp-threshold';
      tag.style.top = `${(t.y / STRIP.height) * 100}%`;
      tag.style.color = colour;
      tag.textContent = `${t.name} ${sinr(t.db)} dB`;
      strip.parentElement.appendChild(tag);
    }
    // Each epoch's state as a dot on the line: the colour the path uses.
    for (const row of timeline.rows) {
      if (row.sinrDb === null) continue;
      strip.appendChild(
        svg('circle', {
          cx: geometry.x(row.at),
          cy: geometry.y(row.sinrDb),
          r: 1.8,
          fill: rgb(bannerOf(row).colorRgb),
        }),
      );
    }
    const cursor = svg('line', {
      class: 'rp-cursor',
      y1: 0,
      y2: STRIP.height,
      stroke: '#ffffff',
      'stroke-width': 1.5,
      'vector-effect': 'non-scaling-stroke',
    });
    strip.appendChild(cursor);
    $('.rp-start').textContent = clockText(timeline.start);
    $('.rp-end').textContent = clockText(timeline.end);
    // A run with mission effects but no receiver track has no SINR to draw.
    $('.rp-strip').hidden = !timeline.binding;
    $('.rp-range').textContent = timeline.binding
      ? `SINR ${sinr(geometry.sinrMinDb)}…${sinr(geometry.sinrMaxDb)} dB` +
        (geometry.windows.length ? ' · shaded: jammer active' : '')
      : 'no receiver track: mission effects only';
    state.geometry = geometry;
    drawLanes();
  }

  function laneRows() {
    const rows = [];
    const nominal = new Map(
      (state.compared?.lanes ?? []).map((lane) => [lane.family, lane]),
    );
    for (const lane of state.effects?.lanes ?? []) {
      rows.push({ lane, label: lane.label, run: 'contested' });
      const twin = nominal.get(lane.family);
      if (twin) rows.push({ lane: twin, label: 'nominal', run: 'nominal' });
    }
    return rows;
  }

  function drawLanes() {
    laneSvg.replaceChildren();
    const labels = $('.rp-lane-labels');
    labels.replaceChildren();
    const rows = laneRows();
    const lanes = $('.rp-lanes');
    lanes.hidden = !rows.length || !state.geometry;
    if (lanes.hidden) return;
    const geometry = lanesGeometry(rows, {
      x: state.geometry.x,
      cadenceMs: state.timeline.cadenceMs ?? 1000,
    });
    const diffHeight = state.compared ? 6 : 0;
    const height = geometry.height + (diffHeight ? diffHeight + 3 : 0);
    laneSvg.setAttribute('viewBox', `0 0 ${STRIP.width} ${height}`);
    laneSvg.style.height = `${height}px`;
    labels.style.height = `${height}px`;
    const defs = svg('defs');
    const hatch = svg('pattern', { id: 'rp-unknown-hatch', width: 4, height: 4, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' });
    hatch.appendChild(svg('rect', { width: 4, height: 4, fill: 'rgba(150, 150, 150, 0.25)' }));
    hatch.appendChild(svg('line', { x1: 0, y1: 0, x2: 0, y2: 4, stroke: 'rgba(200, 200, 200, 0.8)', 'stroke-width': 1.5 }));
    defs.appendChild(hatch);
    laneSvg.appendChild(defs);
    for (const row of geometry.rows) {
      const tag = document.createElement('span');
      tag.style.top = `${row.y}px`;
      tag.textContent = row.label;
      if (row.run === 'nominal') tag.className = 'rp-sub';
      labels.appendChild(tag);
      for (const box of row.cells) {
        const { cell } = box;
        const rect = svg('rect', {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          fill: cell.unknown ? 'url(#rp-unknown-hatch)' : rgb(RECEIVER_STATES[cell.state].colorRgb, row.run === 'nominal' ? 0.55 : 0.9),
        });
        const title = svg('title');
        title.textContent =
          `${row.run === 'nominal' ? `${row.family} (nominal)` : row.label} · ${cell.opportunity} · ${clockText(cell.at)}: ${cell.stateName}` +
          (cell.reason ? ` (${cell.reason})` : '') +
          (cell.outcome ? ` · ${cell.outcome}` : '');
        rect.appendChild(title);
        laneSvg.appendChild(rect);
      }
    }
    if (state.compared) {
      const y = geometry.height + 3;
      const tag = document.createElement('span');
      tag.style.top = `${y}px`;
      tag.textContent = state.differences.length ? 'differs' : 'no difference';
      labels.appendChild(tag);
      const seen = new Set();
      for (const difference of state.differences) {
        if (seen.has(difference.at)) continue;
        seen.add(difference.at);
        const mark = svg('rect', {
          x: state.geometry.x(difference.at),
          y,
          width: 3,
          height: diffHeight,
          fill: '#ffffff',
        });
        const title = svg('title');
        title.textContent = state.differences
          .filter((d) => d.at === difference.at)
          .map((d) => `${d.family} ${d.opportunity}: ${d.contested} (nominal: ${d.nominal})`)
          .join('\n');
        mark.appendChild(title);
        laneSvg.appendChild(mark);
      }
    }
    const cursor = svg('line', {
      class: 'rp-lane-cursor',
      y1: 0,
      y2: height,
      stroke: '#ffffff',
      'stroke-width': 1,
      'vector-effect': 'non-scaling-stroke',
    });
    laneSvg.appendChild(cursor);
  }

  function renderModel() {
    const model = $('.rp-model');
    const card = state.effects?.card;
    const notes = [];
    if (state.effects?.lanes.length) {
      if (!card)
        notes.push('<span class="rp-warn">Effects model unknown: the run\'s headers could not be read.</span>');
      else {
        const statuses = [...new Set(card.models.map((m) => m.calibrationStatus))].join(', ');
        notes.push(
          card.uncalibrated
            ? `<span class="rp-warn">Effects models ${statuses}, not validated</span>`
            : `Effects models ${statuses}`,
        );
        if (card.assumptions.length) notes.push(`${card.assumptions.length} assumptions (hover)`);
        model.title = card.assumptions.join('\n');
      }
    }
    if (state.run?.headAdvanced)
      notes.push('<span class="rp-warn">This head has a newer revision; showing the published one.</span>');
    model.hidden = !notes.length;
    model.innerHTML = notes.join(' · ');
  }

  function render() {
    const timeline = state.timeline;
    root.hidden = !state.run;
    if (!state.run) return;
    const clock = state.clock;
    $('.rp-play').textContent = clock?.playing ? '❚❚ PAUSE' : '▶ PLAY';
    for (const button of root.querySelectorAll('button'))
      button.disabled = !clock;
    for (const button of root.querySelectorAll('.rp-speed'))
      button.setAttribute(
        'aria-pressed',
        String(Number(button.dataset.speed) === clock?.speed),
      );
    if (!timeline) {
      $('.rp-swatch').style.background = 'transparent';
      $('.rp-banner-text').textContent =
        state.loading === 'failed'
          ? 'Run timeline unavailable'
          : state.loading
            ? 'Reading the run…'
            : 'This run has no receiver track or mission effects to play';
      $('.rp-time').textContent = '';
      renderModel();
      return;
    }
    renderModel();
    const ms = state.cursorMs ?? timeline.rows[clock.index].at;
    const banner = timeline.binding
      ? bannerOf(rowAt(timeline, ms) ?? timeline.rows[0])
      : {
          colorRgb: [0.56, 0.86, 0.94],
          text: effectsBannerText(state.effects?.lanes ?? [], ms) || 'No effect at this time',
        };
    $('.rp-swatch').style.background = rgb(banner.colorRgb);
    $('.rp-banner-text').textContent = banner.text;
    $('.rp-banner-text').style.color = rgb(banner.colorRgb);
    $('.rp-time').textContent = clockText(ms);
    $('.rp-note').textContent =
      `${timeline.label} · ${Math.round(timeline.cadenceMs / 1000)} s steps`;
    const x = state.geometry?.x(
      Math.min(timeline.end, Math.max(timeline.start, ms)),
    );
    for (const cursor of root.querySelectorAll('.rp-cursor, .rp-lane-cursor')) {
      cursor.setAttribute('x1', x);
      cursor.setAttribute('x2', x);
    }
    strip.setAttribute('aria-valuemin', String(0));
    strip.setAttribute('aria-valuemax', String(timeline.rows.length - 1));
    strip.setAttribute('aria-valuenow', String(clock.index));
    strip.setAttribute('aria-valuetext', `${clockText(ms)} ${banner.text}`);
  }

  /** The head's own revision (`GET /heads`); null reads the head by name. */
  async function revisionOf(run) {
    if (typeof run.source.getHeads !== 'function') return null;
    try {
      return (await run.source.getHeads())?.[run.head] ?? null;
    } catch {
      return null;
    }
  }

  async function load(run) {
    const key = runKey(run);
    state.key = key;
    state.timeline = null;
    state.clock = null;
    state.geometry = null;
    state.effects = null;
    state.compared = null;
    state.differences = [];
    strip.replaceChildren();
    state.loading = true;
    render();
    try {
      const revisionId = run.revisionId ?? (await revisionOf(run));
      if (state.key !== key) return;
      const at = { revisionId, head: run.head };
      const [track, effects, compared] = await Promise.all([
        readerFor(run.source).read(at),
        effectsReaderFor(run.source).read(at),
        run.compare
          ? effectsReaderFor(run.source).read(run.compare)
          : Promise.resolve(null),
      ]);
      if (state.key !== key) return;
      state.loading = null;
      state.effects = effects;
      state.compared = compared?.lanes.length ? compared : null;
      state.differences = state.compared
        ? compareLanes(effects.lanes, state.compared.lanes)
        : [];
      const timeline = track ?? effectsTimeline(effects.lanes);
      state.timeline = timeline;
      if (timeline?.cadenceMs) {
        const at = Date.parse(run.validAt);
        state.clock = createRunClock({
          count: timeline.rows.length,
          cadenceMs: timeline.cadenceMs,
          index: Number.isFinite(at) ? nearestIndex(timeline, at) : 0,
        });
        state.cursorMs = Number.isFinite(at) ? at : timeline.start;
        state.lastApplied = run.validAt;
      }
      drawStrip();
    } catch (error) {
      if (state.key !== key) return;
      state.loading = 'failed';
      console.warn('[RunPlayer] run timeline unreadable:', error);
    }
    render();
  }

  function tick() {
    const now = performance.now();
    const elapsed = now - state.lastTick;
    state.lastTick = now;
    const run = runOnScreen(worldModelLayers(dataManager), runFocus());
    state.run = run;
    if (!run) {
      state.clock?.pause();
      state.key = null;
      state.timeline = null;
      render();
      return;
    }
    if (runKey(run) !== state.key) void load(run);
    const { timeline, clock } = state;
    if (!timeline || !clock) {
      render();
      return;
    }
    // A time set from elsewhere: follow it, paused.
    if (run.validAt && run.validAt !== state.lastApplied) {
      clock.pause();
      const at = Date.parse(run.validAt);
      if (Number.isFinite(at)) {
        clock.seek(nearestIndex(timeline, at));
        state.cursorMs = at;
      }
      state.lastApplied = run.validAt;
    }
    if (clock.advance(elapsed)) applyIndex();
    render();
  }

  function seekToClientX(clientX, surface = strip) {
    const { timeline, clock } = state;
    if (!timeline || !clock) return;
    const box = surface.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    const ms = timeline.start + fraction * (timeline.end - timeline.start);
    const index = nearestIndex(timeline, ms);
    if (
      index === clock.index &&
      state.lastApplied === timeline.rows[index].validAt
    )
      return;
    clock.seek(index);
    applyIndex();
    render();
  }

  const listeners = [];
  const on = (element, type, listener) => {
    element.addEventListener(type, listener);
    listeners.push(() => element.removeEventListener(type, listener));
  };
  on($('.rp-play'), 'click', () => {
    if (!state.clock) return;
    state.clock.toggle();
    // Playing from a time typed between epochs starts at its epoch.
    if (state.clock.playing) applyIndex();
    state.lastTick = performance.now();
    render();
  });
  for (const [selector, delta] of [
    ['.rp-back', -1],
    ['.rp-forward', 1],
  ]) {
    on($(selector), 'click', () => {
      if (!state.clock) return;
      state.clock.pause();
      state.clock.step(delta);
      applyIndex();
      render();
    });
  }
  for (const button of root.querySelectorAll('.rp-speed'))
    on(button, 'click', () => {
      state.clock?.setSpeed(Number(button.dataset.speed));
      render();
    });
  on(strip, 'pointerdown', (event) => {
    state.dragging = true;
    strip.setPointerCapture?.(event.pointerId);
    seekToClientX(event.clientX);
  });
  on(strip, 'pointermove', (event) => {
    if (state.dragging) seekToClientX(event.clientX);
  });
  const endDrag = () => {
    state.dragging = false;
  };
  on(strip, 'pointerup', endDrag);
  on(strip, 'pointercancel', endDrag);
  on(laneSvg, 'pointerdown', (event) => seekToClientX(event.clientX, laneSvg));
  on(strip, 'keydown', (event) => {
    if (!state.clock) return;
    const delta = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (delta) {
      event.preventDefault();
      state.clock.pause();
      state.clock.step(delta);
      applyIndex();
      render();
    } else if (event.key === ' ') {
      event.preventDefault();
      $('.rp-play').click();
    }
  });

  const timer = setInterval(tick, TICK_MS);
  tick();
  return () => {
    clearInterval(timer);
    for (const remove of listeners.splice(0)) remove();
    root.remove();
    style.remove();
  };
}
