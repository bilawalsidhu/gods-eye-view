/**
 * Sky view content: stars, constellations, Sun/Moon/planets, labels,
 * the layer switches, the magnitude limit and the search box. skyView.js
 * owns the camera, the observer and the overlay (horizon, grid, compass);
 * it calls update() when sky time or the observer changes and draw() inside
 * every redraw. Everything is drawn on the same Canvas (no Cesium labels).
 *
 * Cadence: star/constellation positions and the ephemeris are recomputed
 * when 2 s of sky time passed, on a time jump or an observer change
 * (STAR_UPDATE_MS); a redraw between updates only re-projects.
 */
import { loadBoundaries, loadSkyData } from './starData.js';
import { t } from '../i18n/index.js';
import { skyEphemeris } from './ephemeris.js';
import {
  STAR_UPDATE_MS,
  USER_LIMIT_MAX,
  USER_LIMIT_MIN,
  createSpriteAtlas,
  createStarField,
  drawStars,
  makeProjector,
  starBuffers,
  starLimit,
  starModel,
} from './starLayer.js';
import {
  constellationModel,
  drawConstellations,
  positionConstellations,
  prepareBoundaries,
  prepareConstellations,
  starNameCandidates,
} from './constellationLayer.js';
import { bodiesModel, drawBodies } from './bodyLayer.js';
import { placeLabels, textWidth } from './skyLabels.js';
import { createTextSprites } from './textSprites.js';
import {
  LOOK_AT_MS,
  buildSearchIndex,
  lookAtView,
  resolveTarget,
  searchSky,
} from './skySearch.js';
import { enuFromAzEl } from './skyMath.js';
import { DEFAULT_SKY_FLAGS } from './skyUrl.js';

/** Switches shown in the Layers panel, in order. */
export const LAYER_SWITCHES = Object.freeze([
  ['stars', 'Stars'],
  ['lines', 'Constellation lines'],
  ['names', 'Constellation names'],
  ['boundaries', 'Constellation boundaries'],
  ['starNames', 'Star names'],
  ['planets', 'Sun, Moon, planets'],
  ['telescopic', 'Uranus and Neptune (telescopic)'],
  ['grid', 'Alt/az grid'],
]);
/** Height of the compass strip at the bottom (kept clear of sky drawing). */
export const COMPASS_STRIP_PX = 34;
export const PERF_SAMPLES = 600;
/** Worst skySearch.matchScore a submitted query jumps to (2 = word prefix). */
export const MAX_JUMP_SCORE = 2;
/**
 * The overlay canvas renders at most at 2x the CSS pixel size: a 2.6-3x
 * phone canvas costs ~1.7-2.25x the fill work for detail the eye cannot see
 * on 1-7 px star discs (measured: mid-phone p95 19 ms all layers at 2.625x).
 */
export const MAX_OVERLAY_RATIO = 2;
export const overlayPixelRatio = (dpr) =>
  Math.min(MAX_OVERLAY_RATIO, Number(dpr) > 0 ? Number(dpr) : 1);

const FONTS = {
  body: '600 12px system-ui, sans-serif',
  constellation: '500 11px system-ui, sans-serif',
  star: '400 11px system-ui, sans-serif',
  marker: '600 12px system-ui, sans-serif',
};
/** Dark halo behind label text (keeps it readable over lines and stars). */
const LABEL_HALO = 'rgba(0, 0, 0, 0.55)';
const LABEL_COLOURS = {
  body: 'rgba(255, 236, 190, 0.95)',
  constellation: 'rgba(150, 190, 245, 0.85)',
  star: 'rgba(225, 232, 245, 0.85)',
  marker: 'rgba(120, 255, 190, 0.98)',
};

function el(doc, tag, attrs = {}, text) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else node.setAttribute(key, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The tools DOM: a Layers button + panel and the search form. */
export function buildContentDom(doc) {
  const root = el(doc, 'div', {
    className: 'gev-sky-tools',
    'data-sky': 'tools',
  });
  root.hidden = true;
  const form = el(doc, 'form', {
    className: 'gev-sky-search',
    'data-sky': 'sky-search',
    role: 'search',
  });
  const query = el(doc, 'input', {
    type: 'search',
    'data-sky': 'sky-search-query',
    placeholder: t('Find: Orion, Jupiter, Vega, ISS'),
    'aria-label': t('Find a constellation, planet, star or satellite'),
    autocomplete: 'off',
  });
  const find = el(
    doc,
    'button',
    { type: 'submit', 'data-sky': 'sky-search-go' },
    'Find',
  );
  const clear = el(
    doc,
    'button',
    {
      type: 'button',
      'data-sky': 'sky-search-clear',
      'aria-label': 'Clear the marker',
    },
    '×',
  );
  clear.hidden = true;
  form.append(query, find, clear);
  const results = el(doc, 'div', {
    className: 'gev-sky-results',
    'data-sky': 'sky-search-results',
    role: 'listbox',
    'aria-label': 'Matches',
  });
  results.hidden = true;
  const status = el(doc, 'div', {
    className: 'gev-sky-search-status',
    'data-sky': 'sky-search-status',
    role: 'status',
    'aria-live': 'polite',
  });
  const layersButton = el(
    doc,
    'button',
    {
      type: 'button',
      className: 'gev-sky-layers-btn',
      'data-sky': 'layers',
      'aria-expanded': 'false',
    },
    'Layers',
  );
  const layers = el(doc, 'div', {
    className: 'gev-sky-layers',
    'data-sky': 'layers-panel',
    role: 'group',
    'aria-label': 'Sky layers',
  });
  layers.hidden = true;
  const switches = {};
  for (const [name, label] of LAYER_SWITCHES) {
    const row = el(doc, 'label', { className: 'gev-sky-switch' });
    const box = el(doc, 'input', {
      type: 'checkbox',
      'data-sky': `layer-${name}`,
    });
    row.append(box, el(doc, 'span', {}, ` ${label}`));
    layers.append(row);
    switches[name] = box;
  }
  const magRow = el(doc, 'div', { className: 'gev-sky-mag' });
  const auto = el(doc, 'input', {
    type: 'checkbox',
    'data-sky': 'mag-auto',
    'aria-label': 'Automatic faintest magnitude',
  });
  auto.checked = true;
  const autoLabel = el(doc, 'label', {});
  autoLabel.append(auto, el(doc, 'span', {}, ' Auto '));
  const mag = el(doc, 'input', {
    type: 'range',
    min: String(USER_LIMIT_MIN),
    max: String(USER_LIMIT_MAX),
    step: '0.1',
    value: String(USER_LIMIT_MAX),
    'data-sky': 'mag-limit',
    'aria-label': 'Faintest star magnitude',
  });
  mag.disabled = true;
  const magText = el(doc, 'span', { 'data-sky': 'mag-text' }, '');
  magRow.append(el(doc, 'span', {}, 'Faintest mag '), autoLabel, mag, magText);
  layers.append(magRow);
  const dataStatus = el(doc, 'div', {
    className: 'gev-sky-data-status',
    'data-sky': 'data-status',
    role: 'status',
  });
  root.append(form, results, status, layersButton, layers, dataStatus);
  return {
    root,
    form,
    query,
    find,
    clear,
    results,
    status,
    layersButton,
    layers,
    switches,
    auto,
    mag,
    magText,
    dataStatus,
  };
}

const quantile = (sorted, q) =>
  sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    : NaN;

/**
 * Boxes of the horizon cardinal labels and ticks (overlay.drawOverlay
 * draws them centred, bottom-aligned 14/9 px above the horizon point), so
 * sky labels keep clear of them.
 */
export function cardinalBoxes(cardinals = []) {
  return cardinals.map((c) => {
    const size = c.major ? 16 : 12;
    const half = (c.label.length * size * 0.62) / 2 + 3;
    const bottom = c.y;
    const top = c.y - (c.major ? 14 : 9) - size - 2;
    return { x0: c.x - half, y0: top, x1: c.x + half, y1: bottom };
  });
}

/**
 * @param {object} options
 *   doc, getView(), applyView(view), requestRedraw(), onFlagsChange(flags),
 *   satellites?: { search(query) -> [{id, name}], position(id) -> {azDeg, elDeg} }
 */
export function createSkyContent({
  doc,
  getView,
  applyView,
  requestRedraw = () => {},
  onFlagsChange = () => {},
  loadData = () => loadSkyData(),
  loadBoundaryData = () => loadBoundaries(),
  ephemerisAt = (ms, observer) =>
    skyEphemeris(
      ms,
      {
        latDeg: observer.latDeg,
        lonDeg: observer.lonDeg,
        heightM: (observer.groundHeightM || 0) + (observer.eyeHeightM || 0),
      },
      { refraction: true },
    ),
  createCanvas = (w, h) => {
    const canvas = doc?.createElement?.('canvas');
    if (canvas) {
      canvas.width = w;
      canvas.height = h;
    }
    return canvas;
  },
  now = () => Date.now(),
  perfNow = () => globalThis.performance?.now?.() ?? Date.now(),
  requestFrame = (fn) => globalThis.requestAnimationFrame?.(fn) ?? null,
  cancelFrame = (id) => globalThis.cancelAnimationFrame?.(id),
  reducedMotion = () =>
    Boolean(
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
    ),
  satellites = null,
} = {}) {
  const dom = doc?.createElement ? buildContentDom(doc) : null;
  // Called through the provider object (never extracted): a class-based
  // provider keeps its `this`.
  const satelliteSearch =
    typeof satellites?.search === 'function'
      ? (query) => satellites.search(query)
      : undefined;
  const satellitePosition =
    typeof satellites?.position === 'function'
      ? (id) => satellites.position(id)
      : undefined;
  let flags = { ...DEFAULT_SKY_FLAGS };
  let userLimit = null;
  let data = null;
  let dataError = null;
  let loading = null;
  let field = null;
  let prepared = null;
  let boundaries = null;
  let boundaryState = 'idle';
  let positioned = null;
  let ephemeris = null;
  let ephMs = null;
  let ephKey = '';
  let observer = null;
  let active = false;
  let atlas = null;
  let atlasRatio = 0;
  let buffers = null;
  // The Sun, Moon and planets come from the ephemeris, not the star
  // catalogue: they are searchable while the catalogue loads or after it
  // failed. Catalogue entries are merged in when it arrives.
  let index = buildSearchIndex();
  let marker = null;
  let lookFrame = null;
  let lastResults = [];
  let lastStats = null;
  let lastMs = null;
  const perf = [];
  const removers = [];
  const listen = (target, type, handler) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, handler);
    removers.push(() => target.removeEventListener(type, handler));
  };

  const setDataStatus = (text) => {
    if (dom) dom.dataStatus.textContent = text || '';
  };
  const setSearchStatus = (text) => {
    if (dom) dom.status.textContent = text || '';
  };

  function syncSwitches() {
    if (!dom) return;
    for (const [name] of LAYER_SWITCHES)
      dom.switches[name].checked = Boolean(flags[name]);
    dom.auto.checked = userLimit == null;
    dom.mag.disabled = userLimit == null;
    if (userLimit != null) dom.mag.value = String(userLimit);
  }

  function ensureData() {
    if (data || loading) return loading;
    setDataStatus('Loading star data...');
    loading = Promise.resolve()
      .then(() => loadData())
      .then((loaded) => {
        data = loaded;
        field = createStarField(loaded.stars);
        prepared = prepareConstellations(loaded.constellations, loaded.stars);
        index = buildSearchIndex(loaded);
        buffers = starBuffers(field.count);
        dataError = null;
        setDataStatus('');
        if (observer && lastMs != null)
          update(lastMs, observer, { force: true });
        requestRedraw();
        return loaded;
      })
      .catch((error) => {
        dataError = error;
        loading = null;
        setDataStatus('Star data could not be loaded; stars are off.');
        return null;
      });
    return loading;
  }

  function ensureBoundaries() {
    if (boundaryState !== 'idle') return;
    boundaryState = 'loading';
    Promise.resolve()
      .then(() => loadBoundaryData())
      .then((edges) => {
        boundaries = prepareBoundaries(edges);
        boundaryState = 'ready';
        if (field?.matrix)
          positioned = positionConstellations(
            prepared,
            boundaries,
            field.matrix,
          );
        requestRedraw();
      })
      .catch(() => {
        boundaryState = 'idle';
        setDataStatus('Constellation boundaries could not be loaded.');
      });
  }

  /**
   * Sky time or observer changed. Recomputes positions on the 2 s cadence;
   * returns true when anything moved (the caller redraws anyway).
   */
  function update(ms, nextObserver, { force = false } = {}) {
    if (!nextObserver || !Number.isFinite(ms)) return false;
    observer = nextObserver;
    lastMs = ms;
    let changed = false;
    if (field) {
      if (field.update(ms, observer, { force })) {
        positioned = positionConstellations(prepared, boundaries, field.matrix);
        changed = true;
      }
    }
    const key = `${observer.latDeg},${observer.lonDeg},${observer.groundHeightM},${observer.eyeHeightM}`;
    if (
      force ||
      ephMs == null ||
      key !== ephKey ||
      Math.abs(ms - ephMs) >= STAR_UPDATE_MS
    ) {
      try {
        ephemeris = ephemerisAt(ms, observer);
      } catch {
        ephemeris = null;
      }
      ephMs = ms;
      ephKey = key;
      changed = true;
    }
    return changed;
  }

  // label text sprites, rasterised once per (text, style, pixel ratio)
  const labelText = createTextSprites(createCanvas);

  function spriteAtlas(ratio) {
    if (!atlas || atlasRatio !== ratio) {
      atlas = createSpriteAtlas(createCanvas, ratio);
      atlasRatio = ratio;
    }
    return atlas;
  }

  const sources = () => ({
    field,
    positioned,
    ephemeris,
    satellite: satellitePosition,
  });

  /**
   * Paint the sky content. Returns per-layer counts (what was drawn).
   * reserved: label boxes to keep clear (horizon cardinal labels).
   */
  function draw(
    ctx,
    {
      view,
      width,
      height,
      sunAltDeg,
      occlusion = null,
      reserved = [],
      ratio = 1,
    },
  ) {
    const t0 = perfNow();
    const stats = {
      stars: 0,
      lim: null,
      segments: 0,
      dimSegments: 0,
      names: 0,
      boundaries: 0,
      starNames: 0,
      bodies: 0,
      bodyNames: [],
      labels: [],
      marker: null,
    };
    if (!active) return stats;
    const lim = starLimit({ sunAltDeg, fovDeg: view.fovDeg, userLimit });
    stats.lim = lim;
    // write the DOM only when the text changes (a write per redraw dirties
    // the page's style for every later canvas font/layout read)
    const limText = lim.toFixed(1);
    if (dom && dom.magText.textContent !== limText)
      dom.magText.textContent = limText;
    const skyHeight = Math.max(0, height - COMPASS_STRIP_PX);
    ctx.save();
    ctx.beginPath?.();
    ctx.rect?.(0, 0, width, skyHeight);
    ctx.clip?.();
    const candidates = [];
    let model = null;
    if (field) {
      const constellations = constellationModel(prepared, positioned, field, {
        view,
        width,
        height,
        lines: flags.lines,
        names: flags.names,
        boundaries: flags.boundaries && boundaryState === 'ready',
        occlusion,
      });
      stats.segments =
        (constellations.segments.length + constellations.dimSegments.length) /
        4;
      stats.dimSegments = constellations.dimSegments.length / 4;
      stats.boundaries = constellations.boundaries.length;
      drawConstellations(ctx, constellations);
      if (flags.stars) {
        model = starModel(field, {
          view,
          width,
          height,
          lim,
          occlusion,
          buffers,
        });
        stats.stars = drawStars(ctx, model, spriteAtlas(ratio));
      }
      for (const name of constellations.names)
        candidates.push({
          kind: 'constellation',
          text: name.text,
          x: name.x,
          y: name.y,
          align: 'center',
          priority: 50,
          alpha: name.alpha ?? 1,
        });
      stats.names = constellations.names.length;
      if (flags.starNames && model) {
        const names = starNameCandidates(field, model, { fovDeg: view.fovDeg });
        stats.starNames = names.length;
        for (const s of names)
          candidates.push({
            kind: 'star',
            text: s.text,
            x: s.x,
            y: s.y,
            align: 'left',
            priority: 30 - s.mag,
            alpha: s.alpha ?? 1,
          });
      }
    }
    if (flags.planets && ephemeris) {
      const bodies = bodiesModel(ephemeris, {
        view,
        width,
        height,
        sunAltDeg,
        lim,
        telescopic: flags.telescopic,
        occlusion,
      });
      stats.bodies = drawBodies(ctx, bodies);
      stats.bodyNames = bodies.map((b) => b.name);
      stats.bodyAlpha = Object.fromEntries(
        bodies.map((b) => [b.name, b.alpha]),
      );
      for (const body of bodies)
        candidates.push({
          kind: 'body',
          text: body.name,
          x: body.x + body.r + 4,
          y: body.y,
          align: 'left',
          priority: body.kind === 'planet' ? 100 : 110,
          alpha: body.alpha ?? 1,
        });
    }
    if (marker) {
      const at = resolveTarget(marker.target, sources());
      const project = makeProjector(view, width, height);
      const p = at ? project(...enuFromAzEl(at.azDeg, at.elDeg)) : null;
      if (
        p &&
        p.x > -40 &&
        p.y > -40 &&
        p.x < width + 40 &&
        p.y < height + 40
      ) {
        stats.marker = { x: p.x, y: p.y };
        ctx.strokeStyle = LABEL_COLOURS.marker;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
        ctx.stroke();
        candidates.push({
          kind: 'marker',
          text: marker.label,
          x: p.x,
          y: p.y - 26,
          align: 'center',
          priority: 200,
        });
      }
    }
    for (const c of candidates) {
      c.width = textWidth(ctx, c.text, FONTS[c.kind]);
      c.height = 13;
    }
    const placed = placeLabels(candidates, {
      width,
      height: skyHeight,
      reserved,
    });
    // pre-rendered label text (textSprites.js): no font switch per frame
    for (const label of placed) {
      // labels of objects behind the terrain are dimmed with their object
      ctx.globalAlpha = label.alpha ?? 1;
      labelText.draw(
        ctx,
        label.text,
        label.x,
        label.y,
        {
          font: FONTS[label.kind],
          fill: LABEL_COLOURS[label.kind],
          stroke: LABEL_HALO,
          strokeWidth: 3,
          align: label.align,
          baseline: 'middle',
        },
        ratio,
      );
    }
    ctx.globalAlpha = 1;
    stats.labels = placed.map(({ kind, text, box, alpha }) => ({
      kind,
      text,
      box,
      alpha: alpha ?? 1,
    }));
    ctx.restore();
    const spent = perfNow() - t0;
    perf.push(spent);
    if (perf.length > PERF_SAMPLES) perf.shift();
    lastStats = stats;
    return stats;
  }

  /**
   * Merge flag changes. With notify, the parent receives ONLY the changed
   * keys: this content keeps a copy of every flag, and handing the whole
   * copy back would overwrite state the parent owns (the Flat horizon
   * button) with a stale value.
   */
  function setFlags(next, { notify = false } = {}) {
    flags = { ...flags, ...next };
    if (flags.boundaries) ensureBoundaries();
    syncSwitches();
    if (notify) onFlagsChange({ ...next });
  }

  // ── search ───────────────────────────────────────────────────────────────
  function search(query) {
    lastResults = searchSky(query, index, {
      satellites: satelliteSearch,
    });
    return lastResults;
  }

  /** Why a submitted query found nothing worth jumping to. */
  function noMatchText(query, results) {
    const q = String(query ?? '').trim();
    const notes = [];
    if (data == null && !dataError)
      notes.push(
        'Star data is still loading: only the Sun, Moon and planets can be found yet.',
      );
    else if (dataError)
      notes.push(
        'Star data could not be loaded: only the Sun, Moon and planets can be found.',
      );
    const satStatus = satellites?.status;
    if (satellites && satStatus === 'loading')
      notes.push('Satellites are still loading.');
    else if (satellites && satStatus === 'unavailable')
      notes.push('Satellites are not available.');
    const head = results.length
      ? `No exact match for "${q}". Closest: ${results
          .slice(0, 3)
          .map((r) => r.label)
          .join(', ')}.`
      : `Nothing called "${q}" here.`;
    return [head, ...notes].join(' ');
  }

  function cancelLook() {
    if (lookFrame != null) cancelFrame(lookFrame);
    lookFrame = null;
  }

  /** Look at a search result with a marker. Returns the target az/el. */
  function lookAt(result) {
    const at = resolveTarget(result?.target, sources());
    if (!at) {
      setSearchStatus(
        result?.target?.type === 'satellite'
          ? `No position for ${result.label} right now: it is below the horizon or not computed yet.`
          : `No position for ${result?.label ?? 'that'} yet.`,
      );
      return null;
    }
    marker = { target: result.target, label: result.label };
    if (dom) dom.clear.hidden = false;
    setSearchStatus(
      at.elDeg < 0
        ? `${result.label} is below the horizon now (${at.elDeg.toFixed(1)}°).`
        : `${result.label}: az ${at.azDeg.toFixed(1)}°, alt ${at.elDeg.toFixed(1)}°`,
    );
    cancelLook();
    const from = getView();
    const target = { azDeg: at.azDeg, elDeg: at.elDeg };
    if (reducedMotion()) {
      applyView(lookAtView(from, target, 1));
      return at;
    }
    const started = now();
    const step = () => {
      lookFrame = null;
      if (!active) return;
      const f = Math.min(1, (now() - started) / LOOK_AT_MS);
      applyView(lookAtView(from, target, f));
      if (f < 1) lookFrame = requestFrame(step);
    };
    lookFrame = requestFrame(step);
    if (lookFrame == null) applyView(lookAtView(from, target, 1));
    return at;
  }

  function clearMarker() {
    marker = null;
    if (dom) dom.clear.hidden = true;
    setSearchStatus('');
    requestRedraw();
  }

  function renderResults(results) {
    if (!dom) return;
    for (const child of [...(dom.results.children || [])]) child.remove?.();
    dom.results.hidden = !results.length;
    results.forEach((result, i) => {
      const button = el(
        doc,
        'button',
        {
          type: 'button',
          role: 'option',
          'data-sky': 'sky-search-result',
          'data-index': String(i),
        },
        result.detail ? `${result.label} · ${result.detail}` : result.label,
      );
      listen(button, 'click', () => {
        dom.results.hidden = true;
        lookAt(result);
      });
      dom.results.append(button);
    });
  }

  if (dom) {
    syncSwitches();
    for (const [name] of LAYER_SWITCHES)
      listen(dom.switches[name], 'change', () =>
        setFlags(
          { [name]: Boolean(dom.switches[name].checked) },
          { notify: true },
        ),
      );
    listen(dom.layersButton, 'click', () => {
      dom.layers.hidden = !dom.layers.hidden;
      dom.layersButton.setAttribute(
        'aria-expanded',
        dom.layers.hidden ? 'false' : 'true',
      );
    });
    listen(dom.auto, 'change', () => {
      userLimit = dom.auto.checked ? null : Number(dom.mag.value);
      syncSwitches();
      requestRedraw();
    });
    listen(dom.mag, 'input', () => {
      if (dom.auto.checked) return;
      userLimit = Number(dom.mag.value);
      requestRedraw();
    });
    listen(dom.query, 'input', () =>
      renderResults(dom.query.value.trim() ? search(dom.query.value) : []),
    );
    listen(dom.form, 'submit', (event) => {
      event.preventDefault?.();
      const results = search(dom.query.value);
      // Jump only to a real hit (exact, prefix or word prefix). A bare
      // substring ("ISS" inside "Meissa") is listed, never jumped to.
      const best = results[0];
      if (!best || best.score > MAX_JUMP_SCORE) {
        renderResults(results);
        setSearchStatus(noMatchText(dom.query.value, results));
        return;
      }
      renderResults([]);
      lookAt(best);
    });
    listen(dom.clear, 'click', () => clearMarker());
  }

  return {
    elements: dom,
    get root() {
      return dom?.root ?? null;
    },
    get flags() {
      return { ...flags };
    },
    get userLimit() {
      return userLimit;
    },
    setUserLimit(value) {
      userLimit =
        value == null || !Number.isFinite(Number(value)) ? null : Number(value);
      syncSwitches();
    },
    get status() {
      if (dataError) return 'error';
      if (data) return 'ready';
      return loading ? 'loading' : 'idle';
    },
    get data() {
      return data;
    },
    get field() {
      return field;
    },
    get positioned() {
      return positioned;
    },
    get ephemeris() {
      return ephemeris;
    },
    get marker() {
      return marker;
    },
    get lastStats() {
      return lastStats;
    },
    get lastResults() {
      return lastResults;
    },
    /** Pre-rendered label text (shared with the overlay labels). */
    textSprites: labelText,
    /** Redraw timings of draw() (ms): count, p50, p95, max. */
    perf() {
      const sorted = [...perf].sort((a, b) => a - b);
      return {
        count: sorted.length,
        p50: quantile(sorted, 0.5),
        p95: quantile(sorted, 0.95),
        max: sorted.at(-1) ?? NaN,
      };
    },
    resetPerf() {
      perf.length = 0;
    },
    setFlags,
    ensureData,
    update,
    draw,
    search,
    lookAt,
    clearMarker,
    start(nextObserver, ms) {
      active = true;
      if (dom) dom.root.hidden = false;
      if (flags.boundaries) ensureBoundaries();
      update(ms, nextObserver, { force: true });
      return ensureData();
    },
    stop() {
      active = false;
      cancelLook();
      if (dom) {
        dom.root.hidden = true;
        dom.layers.hidden = true;
        dom.results.hidden = true;
      }
    },
    destroy() {
      this.stop();
      for (const remove of removers.splice(0)) remove();
      dom?.root?.remove?.();
    },
  };
}
