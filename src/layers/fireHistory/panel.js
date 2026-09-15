/**
 * Historic Fires context panel — event roster, event card, daily detection
 * chart, spread-replay transport and source references. Markup builders are
 * pure and exported for tests; only {@link createFireHistoryPanel} touches
 * the DOM. The layer owns the panel's lifetime and calls `render()` whenever
 * its state changes (the same beat that repaints the layer row).
 */
import { perimeterText, progressCss } from './model.js';
import { REPLAY_SPEEDS, formatReplayClock, replayActive } from './replay.js';

export const FIRE_HISTORY_PANEL_ID = 'fire-history-panel';
const CHART_WIDTH = 300;
const CHART_HEIGHT = 56;
const CHART_GAP = 1.5;

/**
 * HTML-escape untrusted text (event config and FIRMS values are data, never
 * markup).
 * @param {*} value
 * @returns {string}
 */
export function escapeText(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        ch
      ],
  );
}

/**
 * Roster buttons, one per registered event.
 * @param {Array<object>} events
 * @param {?string} selectedId
 * @returns {string}
 */
export function rosterHtml(events, selectedId) {
  if (!events?.length)
    return '<div class="fire-history-roster-empty">NO REGISTERED EVENTS</div>';
  return events
    .map((event) => {
      const active = event.id === selectedId;
      const year = String(event.startDate || '').slice(0, 4);
      return (
        `<button type="button" class="fire-history-roster-item${active ? ' active' : ''}" ` +
        `data-event-id="${escapeText(event.id)}" aria-pressed="${active}" ` +
        `aria-label="Show ${escapeText(event.name)} ${escapeText(year)}">` +
        `<span class="fire-history-roster-marker" aria-hidden="true"></span>` +
        `<span class="fire-history-roster-copy"><strong>${escapeText(String(event.name).toUpperCase())} · ${escapeText(year)}</strong>` +
        `<small>${escapeText(event.region || 'REGION UNAVAILABLE')} · ${escapeText(event.startDate)} → ${escapeText(event.endDate)}</small></span>` +
        `<span class="fire-history-roster-chevron" aria-hidden="true">›</span></button>`
      );
    })
    .join('');
}

/**
 * Hectares with a thousands separator, or an unavailable marker.
 * @param {?number} ha
 * @returns {string}
 */
export function formatHectares(ha) {
  return Number.isFinite(ha) && ha > 0
    ? `${Math.round(ha).toLocaleString('en-US')} HA`
    : 'UNAVAILABLE';
}

/**
 * Inline SVG bar chart of detections per UTC day. Bars take the progress
 * ramp so the chart reads like the map; an engaged replay draws a cursor.
 * @param {Array<{date: string, count: number, maxFrp: number}>} timeline
 * @param {?number} cursorFraction - 0..1 while replay is engaged, else null.
 * @returns {string} SVG markup, or an empty-state div.
 */
export function timelineChartSvg(timeline, cursorFraction = null) {
  if (!timeline?.length)
    return '<div class="fire-history-chart-empty">NO DAILY DATA</div>';
  const n = timeline.length;
  const peak = Math.max(1, ...timeline.map((day) => day.count));
  const slot = CHART_WIDTH / n;
  const barWidth = Math.max(1, slot - CHART_GAP);
  const bars = timeline
    .map((day, i) => {
      const h = Math.max(
        day.count > 0 ? 1.5 : 0,
        (day.count / peak) * (CHART_HEIGHT - 2),
      );
      const x = (i * slot).toFixed(2);
      const y = (CHART_HEIGHT - h).toFixed(2);
      const fill = progressCss(n === 1 ? 0 : i / (n - 1));
      const title = `${day.date} · ${day.count.toLocaleString('en-US')} detections · peak ${Math.round(day.maxFrp)} MW`;
      return `<rect x="${x}" y="${y}" width="${barWidth.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}" rx="0.8"><title>${escapeText(title)}</title></rect>`;
    })
    .join('');
  const cursor =
    Number.isFinite(cursorFraction) && cursorFraction !== null
      ? `<line class="fire-history-chart-cursor" x1="${(cursorFraction * CHART_WIDTH).toFixed(2)}" x2="${(cursorFraction * CHART_WIDTH).toFixed(2)}" y1="0" y2="${CHART_HEIGHT}" />`
      : '';
  return (
    `<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" preserveAspectRatio="none" role="img" ` +
    `aria-label="Detections per day, ${timeline[0].date} to ${timeline[n - 1].date}">` +
    `<line class="fire-history-chart-base" x1="0" x2="${CHART_WIDTH}" y1="${CHART_HEIGHT}" y2="${CHART_HEIGHT}" />${bars}${cursor}</svg>`
  );
}

/**
 * Reference links (https only, validated server-side) or an empty note.
 * @param {Array<{label: string, url: string}>} references
 * @returns {string}
 */
export function referencesHtml(references, perimeter = null) {
  const nifc = perimeter
    ? '<li><a href="https://data-nifc.opendata.arcgis.com/" target="_blank" rel="noopener noreferrer">NIFC Open Data — perimeter source ↗</a></li>'
    : '';
  if (!references?.length)
    return (
      nifc || '<li class="fire-history-ref-empty">NO LINKED DOCUMENTS</li>'
    );
  return (
    nifc +
    references
      .filter((ref) => /^https:\/\//.test(String(ref?.url || '')))
      .map(
        (ref) =>
          `<li><a href="${escapeText(ref.url)}" target="_blank" rel="noopener noreferrer">${escapeText(ref.label)} ↗</a></li>`,
      )
      .join('')
  );
}

/**
 * Fraction of the event window at the replay cursor.
 * @param {?object} replay - Layer replay state.
 * @returns {number} 0..1.
 */
export function replayFraction(replay) {
  if (!replay || !(replay.endMs > replay.startMs)) return 0;
  return Math.max(
    0,
    Math.min(
      1,
      (replay.cursorMs - replay.startMs) / (replay.endMs - replay.startMs),
    ),
  );
}

/**
 * Human clock line for the panel.
 * @param {?object} replay
 * @param {object} [event]
 * @returns {string}
 */
export function clockText(replay, event) {
  if (!replay) return 'LOAD AN EVENT TO REPLAY ITS SPREAD';
  if (!replayActive(replay))
    return `STATIC · ALL DETECTIONS ${event?.startDate || ''} → ${event?.endDate || ''}`.trim();
  const verb =
    replay.status === 'playing'
      ? 'PLAYING'
      : replay.status === 'paused'
        ? 'PAUSED'
        : 'END';
  return `${verb} · ${formatReplayClock(replay.cursorMs)} · ${replay.shown.toLocaleString('en-US')} SHOWN · ${replay.active.toLocaleString('en-US')} BURNING`;
}

const PANEL_HTML = `
  <div class="panel-header">
    <span class="panel-title">HISTORIC FIRES</span>
    <span class="fire-history-state" data-role="state">ARCHIVE</span>
    <span class="panel-divider"></span>
    <button class="fire-history-disclose" type="button" data-role="disclose" aria-expanded="true" aria-controls="fire-history-panel-body" title="Collapse Historic Fires" aria-label="Collapse Historic Fires">−</button>
  </div>
  <div class="fire-history-body" id="fire-history-panel-body" data-role="body">
    <div class="fire-history-roster" data-role="roster" aria-label="Registered fire events"></div>
    <div class="fire-history-detail" data-role="detail" hidden>
      <strong data-role="title">EVENT</strong>
      <span>REGION · <b data-role="region"></b></span>
      <span>WINDOW · <b data-role="window"></b></span>
      <span>BURNED AREA · <b data-role="burned"></b></span>
      <span>ARCHIVED DETECTIONS · <b data-role="count"></b></span>
      <span>OFFICIAL PERIMETER · <b data-role="perimeter"></b></span>
      <p class="fire-history-summary" data-role="summary"></p>
    </div>
    <section class="fire-history-section">
      <h4>DETECTIONS PER DAY</h4>
      <div class="fire-history-chart" data-role="chart"></div>
      <div class="fire-history-chart-scale" aria-hidden="true"><span data-role="chart-start"></span><span data-role="chart-end"></span></div>
    </section>
    <section class="fire-history-section">
      <h4>SPREAD REPLAY</h4>
      <div class="fire-history-clock" data-role="clock" role="status" aria-live="polite"></div>
      <input class="gev-quantitative-slider fire-history-seek" type="range" min="0" max="1000" step="1" value="0" data-role="seek" aria-label="Replay position in the event window" />
      <div class="fire-history-speed">
        <div class="fire-history-speed-header"><label for="fire-history-speed">REPLAY SPEED</label><output class="gev-slider-value" for="fire-history-speed" data-role="speed-out">1×</output></div>
        <input id="fire-history-speed" class="gev-quantitative-slider" type="range" min="0" max="${REPLAY_SPEEDS.length - 1}" step="1" value="1" data-role="speed" aria-label="Replay speed" />
        <div class="fire-history-speed-scale" aria-hidden="true">${REPLAY_SPEEDS.map((s) => `<span>${s}×</span>`).join('')}</div>
      </div>
      <div class="fire-history-actions">
        <button type="button" class="fire-history-focus" data-role="focus">FOCUS</button>
        <button type="button" class="fire-history-replay" data-role="replay" aria-pressed="false">▶ REPLAY SPREAD</button>
        <button type="button" class="fire-history-reset" data-role="reset">↺ ALL</button>
      </div>
    </section>
    <section class="fire-history-section">
      <h4>SOURCES &amp; DOCUMENTS</h4>
      <ul class="fire-history-refs" data-role="refs"></ul>
      <small class="fire-history-attribution">Detections: NASA FIRMS standard-processing archive (VIIRS, MODIS) — satellite passes. Perimeter: NIFC Open Data (final mapped perimeter, U.S. public domain).</small>
    </section>
  </div>`;

/**
 * Build and own the panel element.
 * @param {object} options
 * @param {object} options.layer - Historic fires layer (transport + state).
 * @param {Document} [options.doc]
 * @returns {{mount: Function, unmount: Function, render: Function, setVisible: Function, element: ?HTMLElement}}
 */
export function createFireHistoryPanel({ layer, doc = globalThis.document }) {
  let element = null;
  let refs = null;
  let collapsed = false;

  function resolveHost() {
    return (
      doc.querySelector('#global-context-panel .global-context-panel-inner') ||
      doc.getElementById('right-context-rail') ||
      doc.body
    );
  }

  function mount() {
    if (element || !doc) return;
    const host = resolveHost();
    if (!host) return;
    element = doc.createElement('section');
    element.id = FIRE_HISTORY_PANEL_ID;
    element.className = 'fire-history-panel';
    element.hidden = true;
    element.setAttribute('aria-label', 'Historic fires');
    element.innerHTML = PANEL_HTML;
    const q = (role) => element.querySelector(`[data-role="${role}"]`);
    refs = Object.fromEntries(
      [
        'state',
        'disclose',
        'body',
        'roster',
        'detail',
        'title',
        'region',
        'window',
        'burned',
        'count',
        'perimeter',
        'summary',
        'chart',
        'chart-start',
        'chart-end',
        'clock',
        'seek',
        'speed',
        'speed-out',
        'focus',
        'replay',
        'reset',
        'refs',
      ].map((role) => [role, q(role)]),
    );
    refs.roster.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-event-id]');
      if (button) layer.selectEvent(button.dataset.eventId, { origin: 'user' });
    });
    refs.disclose.addEventListener('click', () => {
      collapsed = !collapsed;
      render();
    });
    refs.focus.addEventListener('click', () => layer.focusEvent());
    refs.replay.addEventListener('click', () => layer.toggleReplay());
    refs.reset.addEventListener('click', () => layer.resetReplay());
    refs.speed.addEventListener('input', (event) => {
      layer.setReplaySpeed(
        REPLAY_SPEEDS[Number(event.currentTarget.value)] ?? 1,
      );
    });
    refs.seek.addEventListener('input', (event) => {
      layer.seekReplay(Number(event.currentTarget.value) / 1000);
    });
    const radio = host.querySelector('#radio-panel');
    if (radio && radio.parentNode === host) host.insertBefore(element, radio);
    else host.appendChild(element);
    render();
  }

  function unmount() {
    element?.remove();
    element = null;
    refs = null;
  }

  function setVisible(visible) {
    if (element) element.hidden = !visible;
  }

  function render() {
    if (!element || !refs) return;
    const { events, selectedId, event, timeline, count, perimeter } =
      layer.getEventState();
    const replay = layer.getReplayState();
    const stats = layer.getStats();
    const engaged = replayActive(replay);
    refs.body.hidden = collapsed;
    refs.disclose.textContent = collapsed ? '+' : '−';
    refs.disclose.setAttribute('aria-expanded', String(!collapsed));
    refs.disclose.title = collapsed
      ? 'Expand Historic Fires'
      : 'Collapse Historic Fires';
    refs.state.textContent = stats.loading
      ? 'LOADING'
      : stats.keyRequired
        ? 'KEY REQUIRED'
        : engaged
          ? replay.status.toUpperCase()
          : 'ARCHIVE';
    refs.state.classList.toggle(
      'active',
      engaged && replay.status === 'playing',
    );

    refs.roster.innerHTML = rosterHtml(events, selectedId);
    refs.detail.hidden = !event;
    if (event) {
      refs.title.textContent = `${event.name.toUpperCase()} · ${String(event.startDate).slice(0, 4)}`;
      refs.region.textContent = event.region || 'UNAVAILABLE';
      refs.window.textContent = `${event.startDate} → ${event.endDate}`;
      refs.burned.textContent = formatHectares(event.burnedHa);
      refs.count.textContent = count
        ? count.toLocaleString('en-US')
        : stats.keyRequired
          ? 'KEY REQUIRED'
          : stats.loading
            ? 'LOADING'
            : '0';
      refs.perimeter.textContent = perimeter
        ? perimeterText(perimeter)
        : event.perimeter
          ? 'LOADING'
          : perimeterText(null);
      refs.summary.textContent = event.summary || '';
      refs.summary.hidden = !event.summary;
    }
    const fraction = engaged ? replayFraction(replay) : null;
    refs.chart.innerHTML = timelineChartSvg(timeline, fraction);
    refs['chart-start'].textContent = timeline[0]?.date || '';
    refs['chart-end'].textContent = timeline[timeline.length - 1]?.date || '';
    refs.clock.textContent = clockText(replay, event);
    const ready = Boolean(replay) && count > 0 && !stats.loading;
    refs.seek.disabled = !ready;
    if (doc.activeElement !== refs.seek)
      refs.seek.value = String(Math.round((fraction ?? 0) * 1000));
    refs.speed.disabled = !ready;
    const speedIndex = Math.max(0, REPLAY_SPEEDS.indexOf(replay?.speed ?? 1));
    if (doc.activeElement !== refs.speed) refs.speed.value = String(speedIndex);
    refs['speed-out'].textContent = `${REPLAY_SPEEDS[speedIndex]}×`;
    refs.focus.disabled = !event;
    refs.replay.disabled = !ready;
    const playing = engaged && replay.status === 'playing';
    refs.replay.textContent = playing ? '❚❚ PAUSE' : '▶ REPLAY SPREAD';
    refs.replay.setAttribute('aria-pressed', String(playing));
    refs.reset.disabled = !engaged;
    refs.refs.innerHTML = referencesHtml(event?.references, perimeter);
  }

  return {
    mount,
    unmount,
    render,
    setVisible,
    get element() {
      return element;
    },
  };
}
