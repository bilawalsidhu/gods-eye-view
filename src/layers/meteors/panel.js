import { GMN_DATA_URL } from './records.js';

/** An always-available observation guide; provider fields only enter text nodes. */
export function createMeteorPanel({
  parent,
  onClose,
  onNext,
  onFocus,
  onReplay,
  onScrub,
  onSelect,
  onContext,
}) {
  const style = document.createElement('style');
  style.textContent = `
    .gev-meteor-card {
      --meteor-cyan: #8fe5df;
      --meteor-gold: #ffcb86;
      position: fixed;
      left: 260px;
      bottom: 112px;
      width: 350px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 240px);
      overflow: auto;
      z-index: 120;
      box-sizing: border-box;
      background: linear-gradient(
        155deg,
        rgba(18, 36, 48, 0.98),
        rgba(7, 16, 26, 0.98)
      );
      border: 1px solid #50718080;
      border-radius: 16px;
      color: #edf4f5;
      font:
        12px/1.5 system-ui,
        sans-serif;
      box-shadow: 0 18px 65px #0008;
      scrollbar-width: thin;
      scrollbar-color: #45606b transparent;
    }
    .gev-meteor-card [hidden],
    .gev-meteor-card[hidden] {
      display: none !important;
    }
    .gev-meteor-card * {
      box-sizing: border-box;
    }
    .gev-meteor-card button,
    .gev-meteor-card input {
      font: inherit;
    }
    .gev-meteor-card button {
      cursor: pointer;
      color: inherit;
    }
    .gev-meteor-card button:focus-visible,
    .gev-meteor-card a:focus-visible,
    .gev-meteor-card input:focus-visible {
      outline: 2px solid var(--meteor-gold);
      outline-offset: 3px;
    }
    .meteor-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 17px 19px;
      border-bottom: 1px solid #91bdc51b;
    }
    .meteor-mark {
      width: 31px;
      height: 31px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: #8fe5df12;
      color: var(--meteor-cyan);
      font-size: 22px;
    }
    .meteor-eyebrow {
      font:
        9px ui-monospace,
        monospace;
      letter-spacing: 1.8px;
      color: var(--meteor-cyan);
    }
    .meteor-header h2 {
      font-size: 16px;
      font-weight: 550;
      letter-spacing: -0.3px;
      margin: 1px 0 0;
    }
    .meteor-minimize {
      margin-left: auto;
      border: 0;
      background: transparent;
      font-size: 22px !important;
      color: #a0b5bd !important;
      padding: 0 5px;
    }
    .gev-meteor-card.is-collapsed .meteor-body {
      display: none;
    }
    .meteor-body {
      padding: 18px 19px;
    }
    .meteor-kicker {
      font:
        9px ui-monospace,
        monospace;
      letter-spacing: 1.4px;
      color: #8fa8b5;
      text-transform: uppercase;
    }
    .meteor-batch-title {
      font-size: 28px;
      letter-spacing: -1px;
      line-height: 1.2;
      font-weight: 500;
      margin: 8px 0;
    }
    .meteor-batch-title strong {
      color: var(--meteor-cyan);
      font-weight: 500;
    }
    .meteor-date {
      font-size: 11px;
      color: #aabec9;
    }
    .meteor-intro {
      font-size: 12px;
      color: #b9cad2;
      line-height: 1.65;
      margin: 13px 0 17px;
    }
    .meteor-status {
      font:
        9px/1.6 ui-monospace,
        monospace;
      color: #9bb7c4;
      margin: 10px 0;
    }
    .meteor-status.is-stale {
      color: var(--meteor-gold);
    }
    .meteor-timeline {
      display: flex;
      align-items: end;
      height: 34px;
      gap: 3px;
      border-bottom: 1px solid #6b969c60;
      margin-top: 16px;
    }
    .meteor-bin {
      flex: 1;
      min-height: 2px;
      background: #75c9c357;
      border-radius: 2px 2px 0 0;
    }
    .meteor-time-labels {
      display: flex;
      justify-content: space-between;
      font:
        9px ui-monospace,
        monospace;
      color: #92aab7;
      margin: 5px 0 18px;
    }
    .meteor-primary {
      display: block;
      width: 100%;
      border: 1px solid #b3ece88c;
      border-radius: 8px;
      background: var(--meteor-cyan);
      color: #08212c !important;
      font-weight: 650 !important;
      padding: 11px 14px;
      text-align: left;
    }
    .meteor-primary:hover {
      background: #b1f4ef;
    }
    .meteor-list-label {
      display: flex;
      justify-content: space-between;
      margin: 21px 0 8px;
    }
    .meteor-list {
      display: grid;
      gap: 4px;
    }
    .meteor-event {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 10px 8px;
      border: 1px solid transparent;
      background: transparent;
      text-align: left;
      border-radius: 8px;
    }
    .meteor-event:hover {
      border-color: #8de8e52e;
      background: #88c4cf0b;
    }
    .meteor-rank {
      color: #68818f;
      font:
        11px ui-monospace,
        monospace;
    }
    .meteor-event-name {
      display: block;
      font-size: 12px;
    }
    .meteor-event-meta {
      display: block;
      font:
        10px/1.7 ui-monospace,
        monospace;
      color: #91a8b6;
    }
    .meteor-event-arrow {
      margin-left: auto;
      color: var(--meteor-cyan);
    }
    .meteor-footer {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      margin-top: 16px;
      border-top: 1px solid #91bdc51b;
      padding-top: 12px;
      font-size: 9px;
      color: #8fa8b5;
    }
    .meteor-footer a,
    .meteor-method a {
      color: var(--meteor-cyan);
    }
    .meteor-close {
      border: 0;
      background: transparent;
      color: #a9bfc9 !important;
      padding: 0;
      margin-bottom: 14px;
      font-size: 10px !important;
    }
    .meteor-detail h3 {
      font-size: 25px;
      letter-spacing: -0.8px;
      font-weight: 500;
      line-height: 1.15;
      margin: 8px 0;
    }
    .meteor-detail .meteor-intro {
      margin: 10px 0 15px;
    }
    .meteor-metrics {
      display: grid;
      grid-template-columns: 1.2fr 1fr 1fr;
      gap: 9px;
      padding: 14px 0;
      border-top: 1px solid #91bdc525;
      border-bottom: 1px solid #91bdc525;
    }
    .meteor-metrics dt {
      font:
        9px ui-monospace,
        monospace;
      color: #91a8b6;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .meteor-metrics dd {
      font-size: 20px;
      letter-spacing: -0.7px;
      margin: 5px 0 0;
    }
    .meteor-metrics small {
      font-size: 10px;
      color: #a4b8c2;
      letter-spacing: 0;
    }
    .meteor-profile {
      margin: 17px 0 8px;
    }
    .meteor-profile svg {
      width: 100%;
      height: 110px;
      display: block;
      margin: 6px 0;
    }
    .meteor-altitudes {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: #bad0d8;
    }
    .meteor-altitudes span:first-child {
      color: var(--meteor-cyan);
    }
    .meteor-altitudes span:last-child {
      color: var(--meteor-gold);
    }
    .meteor-replay-box {
      border: 1px solid #ffcb862b;
      background: #eeb26608;
      border-radius: 10px;
      padding: 12px;
      margin-top: 15px;
    }
    .meteor-actions {
      display: flex;
      gap: 8px;
    }
    .meteor-actions button {
      border: 1px solid #8baba64a;
      background: #28403e52;
      border-radius: 6px;
      padding: 9px 12px;
      font-size: 10px;
      white-space: nowrap;
    }
    .meteor-actions .meteor-play {
      flex: 1;
      text-align: left;
      background: var(--meteor-gold);
      color: #261b0e;
      font-weight: 650;
      border-color: var(--meteor-gold);
    }
    .meteor-actions button:hover {
      filter: brightness(1.15);
    }
    .meteor-progress {
      width: 100%;
      height: 4px;
      margin: 17px 0 7px;
      accent-color: var(--meteor-gold);
      cursor: ew-resize;
    }
    .meteor-clock {
      display: flex;
      justify-content: space-between;
      font:
        9px ui-monospace,
        monospace;
      color: #b5bfc3;
    }
    .meteor-replay-note {
      font-size: 9px;
      color: #8da2ae;
      margin: 9px 0 0;
    }
    .meteor-tools {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 15px 0;
      gap: 10px;
    }
    .meteor-tools button {
      border: 0;
      background: transparent;
      color: var(--meteor-cyan);
      font-size: 10px;
      padding: 0;
    }
    .meteor-context {
      font-size: 10px;
      color: #a8bbc5;
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .meteor-context input {
      accent-color: var(--meteor-cyan);
      margin: 0;
    }
    .meteor-method {
      border-top: 1px solid #91bdc525;
      padding-top: 11px;
      color: #98aeba;
      font-size: 10px;
    }
    .meteor-method summary {
      cursor: pointer;
      color: #b9ccd4;
    }
    .meteor-method p {
      line-height: 1.7;
      margin: 9px 0;
    }
    .meteor-id {
      font:
        9px ui-monospace,
        monospace;
      overflow-wrap: anywhere;
      color: #7e99a8;
    }
    .meteor-empty {
      font-size: 13px;
      line-height: 1.7;
      margin: 12px 0;
      color: #b9cad2;
    }
    @media (max-width: 1000px) {
      .gev-meteor-card {
        left: 20px;
        width: 330px;
        bottom: 110px;
        max-height: calc(100vh - 220px);
      }
    }
    @media (max-width: 600px) {
      .gev-meteor-card {
        left: 12px;
        right: 12px;
        bottom: 104px;
        width: auto;
        max-width: none;
        max-height: 55vh;
        border-radius: 14px;
      }
      .meteor-header {
        padding: 12px 15px;
      }
      .meteor-body {
        padding: 14px 15px;
      }
      .meteor-batch-title {
        font-size: 24px;
      }
      .meteor-event {
        padding: 8px;
      }
      .meteor-profile svg {
        height: 85px;
      }
    }

    @media (max-width: 600px) {
      .meteor-detail {
        display: flex;
        flex-direction: column;
      }
      .meteor-profile {
        order: 2;
      }
      .meteor-tools {
        order: 3;
      }
      .meteor-method {
        order: 4;
      }
    }
  `;
  const card = document.createElement('section');
  card.className = 'gev-meteor-card';
  card.setAttribute('aria-label', 'Meteor observatory');
  card.hidden = true;
  const add = (tag, className, text, target = card) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    target.appendChild(el);
    return el;
  };
  const button = (text, className, action, target) => {
    const el = add('button', className, text, target);
    el.type = 'button';
    el.addEventListener('click', action);
    return el;
  };
  const header = add('header', 'meteor-header');
  add('span', 'meteor-mark', '☄', header).setAttribute('aria-hidden', 'true');
  const heading = add('div', '', null, header);
  add('div', 'meteor-eyebrow', 'GLOBAL METEOR NETWORK', heading);
  add('h2', '', 'Meteor observatory', heading);
  const minimize = button(
    '−',
    'meteor-minimize',
    () => {
      const collapsed = card.classList.toggle('is-collapsed');
      minimize.textContent = collapsed ? '+' : '−';
      minimize.setAttribute('aria-expanded', String(!collapsed));
    },
    header,
  );
  minimize.setAttribute('aria-label', 'Collapse or expand meteor observatory');
  minimize.setAttribute('aria-expanded', 'true');
  const body = add('div', 'meteor-body');
  const overview = add('div', 'meteor-overview', null, body);
  const detail = add('div', 'meteor-detail', null, body);
  detail.hidden = true;
  const status = add('div', 'meteor-status', '', body);
  status.setAttribute('role', 'status');
  const footer = add('footer', 'meteor-footer', null, body);
  const source = add('a', '', 'GMN data · CC BY 4.0', footer);
  source.href = GMN_DATA_URL;
  source.target = '_blank';
  source.rel = 'noopener noreferrer';
  add('span', '', 'Processed observations', footer);
  parent.append(style, card);
  let activeRow = null;
  let playButton, progress, elapsed;
  const date = (ms) =>
    new Date(ms).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const time = (ms) => new Date(ms).toISOString().slice(11, 16);
  const format = (n, digits = 1) =>
    Number.isFinite(n) ? n.toFixed(digits) : '—';
  const origin = (row) =>
    row.shower ? `${row.shower} shower` : 'Sporadic meteor';
  const coordinates = (p) =>
    `${Math.abs(p.lat).toFixed(2)}°${p.lat < 0 ? 'S' : 'N'} · ${Math.abs(p.lon).toFixed(2)}°${p.lon < 0 ? 'W' : 'E'}`;
  function reveal() {
    card.hidden = false;
    card.classList.remove('is-collapsed');
    minimize.textContent = '−';
    minimize.setAttribute('aria-expanded', 'true');
    card.scrollTop = 0;
  }
  function updateStatus(snapshot) {
    status.classList.toggle('is-stale', Boolean(snapshot?.stale));
    status.textContent = snapshot
      ? `${snapshot.stale ? 'STALE DATA · ' : ''}Published ${date(snapshot.generatedAt)} · ${time(snapshot.generatedAt)} UTC`
      : '';
  }
  function showOverview(snapshot, message) {
    activeRow = null;
    detail.hidden = true;
    overview.hidden = false;
    overview.replaceChildren();
    add('div', 'meteor-kicker', 'Latest published observations', overview);
    if (!snapshot?.records.length) {
      add(
        'p',
        'meteor-empty',
        message ||
          (snapshot
            ? 'No reconstructed meteors in this batch. Check back after the next GMN publication.'
            : 'Loading observations from the camera network…'),
        overview,
      );
    } else {
      const title = add('h3', 'meteor-batch-title', null, overview);
      add('strong', '', snapshot.records.length.toLocaleString(), title);
      title.append(' meteors.');
      add(
        'div',
        'meteor-date',
        `${date(snapshot.timeFrom)}${date(snapshot.timeFrom) !== date(snapshot.timeTo) ? ` – ${date(snapshot.timeTo)}` : ''}`,
        overview,
      );
      add(
        'p',
        'meteor-intro',
        'A brief flash, seen from several cameras. Explore the reconstructed paths through the atmosphere, one observation at a time.',
        overview,
      );
      const histogram = add('div', 'meteor-timeline', null, overview);
      histogram.setAttribute('role', 'img');
      histogram.setAttribute(
        'aria-label',
        'Distribution of observation times in the published batch',
      );
      const bins = new Array(28).fill(0);
      for (const row of snapshot.records)
        bins[
          Math.min(
            27,
            Math.floor(
              (28 * (row.time - snapshot.timeFrom)) /
                Math.max(1, snapshot.timeTo - snapshot.timeFrom),
            ),
          )
        ]++;
      const max = Math.max(1, ...bins);
      bins.forEach((count) => {
        const bar = add('span', 'meteor-bin', '', histogram);
        bar.style.height = `${Math.max(2, (32 * count) / max)}px`;
        bar.title = `${count} observations`;
      });
      const labels = add('div', 'meteor-time-labels', null, overview);
      add('span', '', `${time(snapshot.timeFrom)} UTC`, labels);
      add('span', '', `${time(snapshot.timeTo)} UTC`, labels);
      button(
        'Explore the brightest meteor  ↗',
        'meteor-primary',
        () => onSelect(snapshot.records[0].id),
        overview,
      );
      const listLabel = add('div', 'meteor-list-label', null, overview);
      add('span', 'meteor-kicker', 'Start with these', listLabel);
      add('span', 'meteor-kicker', 'Brightest first', listLabel);
      const list = add('div', 'meteor-list', null, overview);
      snapshot.records.slice(0, 4).forEach((row, i) => {
        const entry = button('', 'meteor-event', () => onSelect(row.id), list);
        add('span', 'meteor-rank', String(i + 1).padStart(2, '0'), entry);
        const text = add('span', '', null, entry);
        add('span', 'meteor-event-name', origin(row), text);
        add(
          'span',
          'meteor-event-meta',
          `${row.utc.slice(11, 19)} UTC · ${row.stationCount} cameras · ${format(row.duration, 2)} s`,
          text,
        );
        add('span', 'meteor-event-arrow', '↗', entry);
      });
      if (snapshot.limited)
        add(
          'p',
          'meteor-date',
          `Showing the ${snapshot.records.length} brightest of ${snapshot.totalCount} observations.`,
          overview,
        );
      add(
        'p',
        'meteor-date',
        'Latest processing batch · incomplete sky coverage · not live',
        overview,
      );
    }
    updateStatus(snapshot);
    reveal();
  }
  function svgElement(tag, attrs, target) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs))
      el.setAttribute(key, String(value));
    target.appendChild(el);
    return el;
  }
  return {
    showOverview,
    show(row, snapshot, meta = {}) {
      activeRow = row;
      overview.hidden = true;
      detail.hidden = false;
      detail.replaceChildren();
      button('← All observations', 'meteor-close', onClose, detail);
      add('div', 'meteor-kicker', origin(row), detail);
      add('h3', '', `${row.utc.slice(11, 19)} UTC`, detail);
      add(
        'div',
        'meteor-date',
        `${date(row.time)} · ${coordinates(row.begin)}`,
        detail,
      );
      add(
        'p',
        'meteor-intro',
        `Seen by ${row.stationCount} cameras in just ${format(row.duration, 2)} seconds.`,
        detail,
      );
      const metrics = add('dl', 'meteor-metrics', null, detail);
      for (const [label, value, unit] of [
        ['Speed', format(row.speedKmS), 'km/s'],
        ['Fitted path', format(meta.pathLengthKm), 'km'],
        ['Duration', format(row.duration, 2), 's'],
      ]) {
        const group = add('div', '', null, metrics);
        add('dt', '', label, group);
        const dd = add('dd', '', `${value} `, group);
        add('small', '', unit, dd);
      }
      const profile = add('div', 'meteor-profile', null, detail);
      add('div', 'meteor-kicker', 'Altitude profile · km', profile);
      const svg = svgElement(
        'svg',
        {
          viewBox: '0 0 300 110',
          role: 'img',
          'aria-label': `Fitted altitude profile: ${row.begin.heightKm} to ${row.end.heightKm} kilometres above WGS84`,
        },
        profile,
      );
      const ceiling =
        Math.ceil(Math.max(row.begin.heightKm, row.end.heightKm) / 50) * 50 ||
        50;
      const y = (height) => 88 - (height / ceiling) * 68;
      for (let h = 0; h <= ceiling; h += 50) {
        svgElement(
          'line',
          {
            x1: 28,
            y1: y(h),
            x2: 292,
            y2: y(h),
            stroke: '#78969c35',
            'stroke-dasharray': '2 5',
          },
          svg,
        );
        svgElement(
          'text',
          {
            x: 1,
            y: y(h) + 3,
            fill: '#819ba9',
            'font-size': 8,
            'font-family': 'monospace',
          },
          svg,
        ).textContent = h;
      }
      svgElement(
        'polygon',
        {
          points: `40,${y(row.begin.heightKm)} 282,${y(row.end.heightKm)} 282,88 40,88`,
          fill: '#8fe5df09',
        },
        svg,
      );
      svgElement(
        'line',
        {
          x1: 40,
          y1: y(row.begin.heightKm),
          x2: 282,
          y2: y(row.end.heightKm),
          stroke: '#a2d9d3',
          'stroke-width': 2,
        },
        svg,
      );
      for (const [x, height, color] of [
        [40, row.begin.heightKm, '#8fe5df'],
        [282, row.end.heightKm, '#ffcb86'],
      ])
        svgElement(
          'circle',
          {
            cx: x,
            cy: y(height),
            r: 4,
            fill: color,
            stroke: '#122632',
            'stroke-width': 2,
          },
          svg,
        );
      svgElement(
        'text',
        {
          x: 40,
          y: 105,
          fill: '#819ba9',
          'font-size': 8,
          'font-family': 'monospace',
        },
        svg,
      ).textContent = '0 s';
      svgElement(
        'text',
        {
          x: 282,
          y: 105,
          fill: '#819ba9',
          'font-size': 8,
          'font-family': 'monospace',
          'text-anchor': 'end',
        },
        svg,
      ).textContent = `${format(row.duration, 2)} s`;
      const altitudes = add('div', 'meteor-altitudes', null, profile);
      add(
        'span',
        '',
        `● First seen · ${format(row.begin.heightKm)} km`,
        altitudes,
      );
      add(
        'span',
        '',
        `${format(row.end.heightKm)} km · Last seen ●`,
        altitudes,
      );
      const replayBox = add('div', 'meteor-replay-box', null, detail);
      const actions = add('div', 'meteor-actions', null, replayBox);
      playButton = button('▶ Replay passage', 'meteor-play', onReplay, actions);
      button('↗ Frame path', 'meteor-focus', onFocus, actions);
      progress = add('input', 'meteor-progress', null, replayBox);
      progress.type = 'range';
      progress.min = '0';
      progress.max = '1000';
      progress.value = '0';
      progress.step = '1';
      progress.setAttribute('aria-label', 'Explore the meteor passage');
      progress.addEventListener('input', () =>
        onScrub(Number(progress.value) / 1000),
      );
      const clock = add('div', 'meteor-clock', null, replayBox);
      elapsed = add(
        'span',
        'meteor-elapsed',
        `0.00 / ${format(row.duration, 2)} s observed`,
        clock,
      );
      add('span', '', '6 s playback', clock);
      add(
        'p',
        'meteor-replay-note',
        'Illustrative motion along the fitted path. Drag to explore.',
        replayBox,
      );
      const tools = add('div', 'meteor-tools', null, detail);
      const context = add('label', 'meteor-context', null, tools);
      const checkbox = add('input', '', null, context);
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(meta.showContext);
      checkbox.addEventListener('change', () => onContext(checkbox.checked));
      context.append('Other meteors');
      button('Next observation →', '', onNext, tools);
      const method = add('details', 'meteor-method', null, detail);
      add('summary', '', 'What am I looking at?', method);
      add(
        'p',
        '',
        'Cameras on the ground record the same flash from different angles. GMN fits a trajectory between the first and last observed positions. The bright arrow shows the direction of travel; dashed vertical guides show altitude above the WGS84 reference surface, not an impact path.',
        method,
      );
      add(
        'p',
        '',
        'The profile joins the two measured endpoint heights. Playback assumes constant speed over six seconds; it is not camera footage or a model of deceleration.',
        method,
      );
      add(
        'p',
        '',
        `${row.shower ? `GMN shower code: ${row.shower}.` : 'Sporadic means no meteor shower was assigned.'} Peak absolute magnitude: ${format(row.magnitude, 2)} (lower means brighter).`,
        method,
      );
      add(
        'p',
        '',
        `Participating cameras: ${row.stations.join(' · ')}`,
        method,
      );
      add('div', 'meteor-id', row.id, method);
      updateStatus(snapshot);
      reveal();
    },
    setProgress(fraction, playing = false) {
      if (!activeRow || !progress) return;
      progress.value = String(Math.round(fraction * 1000));
      elapsed.textContent = `${(activeRow.duration * fraction).toFixed(2)} / ${activeRow.duration.toFixed(2)} s observed`;
      playButton.textContent = playing
        ? 'Ⅱ Pause passage'
        : fraction >= 1
          ? '↻ Replay passage'
          : '▶ Replay passage';
      playButton.setAttribute('aria-pressed', String(playing));
    },
    setStatus: updateStatus,
    hide() {
      card.hidden = true;
    },
    destroy() {
      card.remove();
      style.remove();
    },
  };
}
