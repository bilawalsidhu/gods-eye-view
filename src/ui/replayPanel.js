import { msg, t, translateKnown } from '../i18n/index.js';
import { formatBytes, formatSpan, storageUse } from '../replay/model.js';
import { createRailTimeline, utcClock } from './railTimeline.js';

const LAYER_LABELS = [
  ['air', msg('AIR')],
  ['mil', msg('MIL')],
  ['vessel', msg('SEA')],
  ['local', msg('LOCAL')],
  ['sat', msg('SAT')],
];
const BASIS = { cap: msg('CAP'), disk: msg('DISK') };
const ENTERED = msg('{contact} entered {fence}');
const LEFT = msg('{contact} left {fence}');
const set = (node, key, value) => {
  if (node[key] !== value) node[key] = value;
};

/**
 * Right-rail readout for the recorded-history replay. It reuses the weather
 * rail's timeline and chip styling; the controller owns all globe state.
 */
export function createReplayPanel({ container, controller } = {}) {
  const document = container?.ownerDocument;
  if (!document?.createElement || !controller) return null;
  const panel = container.closest?.('#replay-panel');
  const count = panel?.querySelector('#replay-panel-count');

  const root = document.createElement('section');
  root.className = 'replay-readout';
  const status = document.createElement('div');
  status.className = 'weather-observed-scope';
  const makeChip = (parent, label, title, onClick) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'data-toggle-chip';
    node.textContent = label;
    node.title = title;
    node.addEventListener('click', onClick);
    parent.appendChild(node);
    return node;
  };
  const chips = document.createElement('div');
  chips.className = 'replay-chips';
  const start = makeChip(chips, t('REPLAY'), t('Replay recorded history'), () =>
    controller.enter(),
  );
  const fit = makeChip(chips, t('FIT'), t('Fly to the replayed contacts'), () =>
    controller.fit(),
  );
  const watch = makeChip(chips, t('WATCH'), t('Draw an area to watch'), () =>
    controller.watch(),
  );
  const region = makeChip(
    chips,
    t('REGION'),
    t('Limit replay to a drawn area'),
    () => controller.region(),
  );
  const makeInput = (parent, type, label) => {
    const node = document.createElement('input');
    node.type = type;
    node.className = 'replay-input';
    node.setAttribute('aria-label', label);
    node.title = label;
    parent.appendChild(node);
    return node;
  };
  const jumpRow = document.createElement('div');
  jumpRow.className = 'replay-chips';
  const when = makeInput(jumpRow, 'datetime-local', t('Date and time (UTC)'));
  const jump = makeChip(
    jumpRow,
    t('JUMP'),
    t('Replay from this UTC time'),
    () => {
      const ms = Date.parse(`${when.value}:00Z`);
      if (Number.isFinite(ms)) controller.jumpTo(ms);
    },
  );
  const findRow = document.createElement('div');
  findRow.className = 'replay-chips';
  const ident = makeInput(findRow, 'text', t('Identifier'));
  ident.placeholder = t('Callsign, ship name, hex or MMSI');
  const find = makeChip(
    findRow,
    t('FIND'),
    t('Show the recorded path of a contact'),
    () => controller.findTrack(ident.value),
  );
  ident.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') controller.findTrack(ident.value);
  });
  const pin = makeChip(
    findRow,
    t('PIN'),
    t('Keep this contact history past the retention period'),
    () => controller.togglePin(),
  );
  const clearFind = makeChip(findRow, '✕', t('Clear the path'), () => {
    ident.value = '';
    controller.findTrack('');
  });
  const trackLine = document.createElement('div');
  trackLine.className = 'replay-alerts';
  const speedRow = document.createElement('div');
  speedRow.className = 'replay-chips';
  const speedChips = controller
    .state()
    .speeds.map((value) => [
      value,
      makeChip(speedRow, `${value}×`, t('Playback speed'), () =>
        controller.setSpeed(value),
      ),
    ]);
  const windowChips = controller
    .state()
    .windows.map((hours) => [
      hours,
      makeChip(chips, `${hours}h`, t('Time window'), () =>
        controller.setWindowHours(hours),
      ),
    ]);
  const layerRow = document.createElement('div');
  layerRow.className = 'replay-chips';
  const layerChips = LAYER_LABELS.map(([id, label]) => [
    id,
    makeChip(layerRow, t(label), t('Show or hide this layer'), () =>
      controller.toggleLayer(id),
    ),
  ]);
  const exportRow = document.createElement('div');
  exportRow.className = 'replay-chips';
  for (const format of ['csv', 'geojson', 'gpx', 'json'])
    makeChip(
      exportRow,
      format.toUpperCase(),
      t('Download recorded history'),
      () => {
        const { status: s, windowHours, layers } = controller.state();
        if (!s?.to_ts) return;
        const query = new URLSearchParams({
          format,
          from: String(Math.floor(s.to_ts - windowHours * 3600)),
          to: String(s.to_ts),
          layers: layers.join(','),
        });
        const link = document.createElement('a');
        link.href = `/api/history/export?${query}`;
        link.click();
      },
    );
  // Storage: a bar that is green, then orange, then red as it fills.
  const storage = document.createElement('div');
  storage.className = 'replay-storage';
  const storageHead = document.createElement('div');
  storageHead.className = 'replay-storage-head';
  const storageLabel = document.createElement('span');
  const storagePercent = document.createElement('span');
  storageHead.append(storageLabel, storagePercent);
  const bar = document.createElement('div');
  bar.className = 'replay-bar';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const barFill = document.createElement('div');
  barFill.className = 'replay-bar-fill';
  bar.appendChild(barFill);
  const storageNumbers = document.createElement('div');
  storageNumbers.className = 'replay-storage-numbers';
  const storageUsed = document.createElement('span');
  const storageFree = document.createElement('span');
  storageNumbers.append(storageUsed, storageFree);
  const storageNote = document.createElement('div');
  storageNote.className = 'replay-alerts';
  const storageLayers = document.createElement('div');
  storageLayers.className = 'replay-alerts';
  const storageWarn = document.createElement('div');
  storageWarn.className = 'replay-storage-warn';
  storage.append(
    storageHead,
    bar,
    storageNumbers,
    storageNote,
    storageLayers,
    storageWarn,
  );
  const legend = document.createElement('div');
  legend.className = 'replay-alerts';
  legend.textContent = t(
    'Solid dot: recorded position. Ring: estimated between recordings. Gaps over 5 minutes are left blank.',
  );
  const fenceList = document.createElement('div');
  fenceList.className = 'replay-fences';
  const alerts = document.createElement('div');
  alerts.className = 'replay-alerts';
  const timelineHost = document.createElement('div');
  timelineHost.className = 'weather-timeline-block';
  root.append(
    status,
    storage,
    chips,
    speedRow,
    layerRow,
    jumpRow,
    legend,
    findRow,
    trackLine,
    exportRow,
    fenceList,
    alerts,
    timelineHost,
  );
  container.appendChild(root);

  const timeline = createRailTimeline({
    container: timelineHost,
    document,
    sliderClassName: 'weather-timeline',
    heading: false,
    onCommit: (_tick, index) => controller.seek(index),
    onPreview: (tick) => utcClock(tick),
    onStep: (direction) => controller.step(direction),
    onLatest: () => controller.exit(),
    onPlay: () => controller.togglePlay(),
  });

  const renderStorage = (s) => {
    set(storage, 'hidden', !s);
    if (!s) return;
    const use = storageUse(s);
    const percent = Math.round(use.fraction * 100);
    storage.dataset.level = use.basis === 'none' ? 'none' : use.level;
    set(
      storageLabel,
      'textContent',
      use.basis === 'none'
        ? t('STORAGE')
        : `${t('STORAGE')} · ${t(BASIS[use.basis])}`,
    );
    set(storagePercent, 'textContent', use.total ? `${percent}%` : '');
    barFill.style.width = `${use.total ? Math.max(percent, 1) : 0}%`;
    bar.setAttribute('aria-valuenow', String(percent));
    set(bar, 'hidden', !use.total);
    set(
      storageUsed,
      'textContent',
      use.total
        ? t('{used} of {total} used', {
            used: formatBytes(use.used),
            total: formatBytes(use.total),
          })
        : t('{used} used', { used: formatBytes(use.used) }),
    );
    set(
      storageFree,
      'textContent',
      use.total ? t('{free} free', { free: formatBytes(use.free) }) : '',
    );
    const note =
      use.fullInSec !== null
        ? t('Full in about {time} at this rate', {
            time: formatSpan(use.fullInSec),
          })
        : use.settlesAt !== null
          ? t('Settles near {size} at this rate', {
              size: formatBytes(use.settlesAt),
            })
          : use.perHour
            ? t('About {rate} per hour', { rate: formatBytes(use.perHour) })
            : '';
    set(storageNote, 'textContent', note);
    set(storageNote, 'hidden', !note);
    const counts = Object.entries(s.layer_counts || {});
    const names = Object.fromEntries(
      LAYER_LABELS.map(([id, label]) => [id, t(label)]),
    );
    set(
      storageLayers,
      'textContent',
      counts
        .map(([id, n]) => `${names[id] || id} ${n.toLocaleString()}`)
        .join(' · '),
    );
    set(storageLayers, 'hidden', !counts.length);
    const warn =
      use.level !== 'red' || !use.total
        ? ''
        : use.basis === 'cap'
          ? t('Nearly full. The oldest positions are being dropped.')
          : t('Disk nearly full. Lower retention or set a size cap.');
    set(storageWarn, 'textContent', warn);
    set(storageWarn, 'hidden', !warn);
  };

  const render = (state) => {
    const ready = state.active && state.ticks.length > 1;
    if (panel) set(panel, 'hidden', !state.status && !state.active);
    if (count)
      set(
        count,
        'textContent',
        `${state.status?.recording ? `● ${t('REC')} · ` : ''}${state.active ? t('REPLAY') : t('LIVE')}`,
      );
    set(
      status,
      'textContent',
      (state.error ? t('Replay failed') : '') ||
        (state.drawing ? t('Drag a box on the globe') : '') ||
        (state.hint ? translateKnown(state.hint) : '') ||
        (state.loading
          ? t('Loading')
          : state.active
            ? `${utcClock(new Date(state.timeMs).toISOString())} · ${t('{count} contacts', { count: state.contacts })}`
            : state.range
              ? t('{count} positions recorded · kept {days} days', {
                  count: state.status.count.toLocaleString(),
                  days: state.status.retention_days || '∞',
                })
              : t('No recording')),
    );
    renderStorage(state.status);
    set(start, 'disabled', state.loading || !state.range);
    set(fit, 'disabled', !state.active || !state.contacts);
    set(jump, 'disabled', state.loading || !state.range);
    set(legend, 'hidden', !state.active);
    set(find, 'disabled', !state.range);
    set(pin, 'hidden', !state.track);
    set(
      pin,
      'className',
      `data-toggle-chip${state.track && state.pins.includes(state.track.id) ? ' active' : ''}`,
    );
    set(clearFind, 'hidden', !state.track && !ident.value);
    set(
      region,
      'className',
      `data-toggle-chip${state.region ? ' active' : ''}`,
    );
    const tr = state.track;
    const stamp = (p) => utcClock(new Date(p.ts * 1000).toISOString());
    // The first and last fixes are coloured dots on the globe, so the words
    // carry the same colours instead of a map label.
    const trackKey = tr
      ? `${tr.id}|${tr.name}|${tr.count}|${tr.first.ts}|${tr.last.ts}|${tr.gaps.length}`
      : '';
    if (trackLine.dataset.key !== trackKey) {
      trackLine.dataset.key = trackKey;
      const part = (text, className) => {
        const node = document.createElement('span');
        node.className = className;
        node.textContent = text;
        return node;
      };
      trackLine.replaceChildren(
        ...(tr
          ? [
              `${tr.name && tr.name !== tr.id ? `${tr.name} (${tr.id})` : tr.id} · ${t('{count} points', { count: tr.count })} · `,
              part(`● ${t('first')} ${stamp(tr.first)}`, 'replay-track-first'),
              ' · ',
              part(`● ${t('last')} ${stamp(tr.last)}`, 'replay-track-last'),
              ` · ${t('{count} gaps', { count: tr.gaps.length })}`,
            ]
          : []),
      );
    }
    set(trackLine, 'hidden', !tr);
    for (const [hours, node] of windowChips)
      set(
        node,
        'className',
        `data-toggle-chip${hours === state.windowHours ? ' active' : ''}`,
      );
    for (const [value, node] of speedChips)
      set(
        node,
        'className',
        `data-toggle-chip${value === state.speed ? ' active' : ''}`,
      );
    for (const [id, node] of layerChips)
      set(
        node,
        'className',
        `data-toggle-chip${state.layers.includes(id) ? ' active' : ''}`,
      );
    const lines = state.events.map((e) =>
      t(e.kind === 'enter' ? ENTERED : LEFT, {
        contact: e.id,
        fence: e.fence || '',
      }),
    );
    set(
      watch,
      'className',
      `data-toggle-chip${state.drawing ? ' active' : ''}`,
    );
    const fenceKey = state.fences.map((f) => `${f.id}:${f.name}`).join('|');
    if (fenceList.dataset.shown !== fenceKey) {
      fenceList.dataset.shown = fenceKey;
      fenceList.replaceChildren(
        ...state.fences.map((f) => {
          const row = document.createElement('div');
          row.className = 'replay-fence';
          const name = document.createElement('span');
          name.textContent = f.name;
          const remove = makeChip(row, '✕', t('Stop watching this area'), () =>
            controller.removeFence(f.id),
          );
          remove.className = 'data-toggle-chip replay-fence-remove';
          row.prepend(name);
          return row;
        }),
      );
    }
    set(fenceList, 'hidden', !state.fences.length);
    const shown = lines.join('\n');
    if (alerts.dataset.shown !== shown) {
      alerts.dataset.shown = shown;
      alerts.replaceChildren(
        ...lines.map((line) => {
          const row = document.createElement('div');
          row.textContent = line;
          return row;
        }),
      );
    }
    set(alerts, 'hidden', !lines.length);
    timeline.update({
      ticks: state.ticks,
      index: state.index,
      mode: state.active ? 'history' : 'latest',
      playing: state.playing,
      disabled: !ready,
      readout: state.active
        ? utcClock(new Date(state.timeMs).toISOString())
        : t('LIVE'),
    });
  };

  const unsubscribe = controller.subscribe(render);
  render(controller.state());
  controller.refreshRange();

  return {
    destroy() {
      unsubscribe();
      timeline?.destroy();
      root.remove();
      if (panel) set(panel, 'hidden', true);
    },
  };
}
