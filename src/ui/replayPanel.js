import { msg, t, translateKnown } from '../i18n/index.js';
import { aircraftEmergency } from '../data/aircraftEmergency.js';
import {
  formatBytes,
  formatSpan,
  formatSpanCompact,
  storageUse,
} from '../replay/model.js';
import { alertsEnabled, announce, setAlerts } from './replayAlerts.js';
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
const EMERGENCY = msg('{contact}: {status} (squawk {squawk})');
const EMERGENCY_ADSB = msg('{contact}: {status}');
const EMERGENCY_TITLE = msg('Emergency broadcast');
const COULD_NOT_APPLY = msg('Could not apply the settings');
const COULD_NOT_THIN = msg('Could not thin the data');
const BLOCKED = msg(
  'Browser notifications are blocked. Alerts sound and show here only.',
);

/** One notice as a line of text: an area event or an emergency broadcast. */
function noticeText(n) {
  const contact = n.name || n.id;
  if (n.type === 'emergency') {
    const status = aircraftEmergency({ emergency: n.kind, squawk: n.squawk });
    const label = translateKnown(status?.label ?? n.kind);
    return n.squawk
      ? t(EMERGENCY, { contact, status: label, squawk: n.squawk })
      : t(EMERGENCY_ADSB, { contact, status: label });
  }
  return t(n.kind === 'enter' ? ENTERED : LEFT, {
    contact,
    fence: n.fence || '',
  });
}
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
  let alertsOn = alertsEnabled();
  const alertsChip = makeChip(
    chips,
    t('ALERTS'),
    t(
      'Sound and notify when a watched area is entered or an emergency is broadcast',
    ),
    async () => {
      alertsOn = !alertsOn;
      const permission = await setAlerts(alertsOn);
      note = alertsOn && permission !== 'granted' ? t(BLOCKED) : '';
      render(controller.state());
    },
  );
  let note = '';
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
  // Heat map and comparison of two times.
  const compareRow = document.createElement('div');
  compareRow.className = 'replay-chips';
  const timeA = makeInput(compareRow, 'datetime-local', t('Time A (UTC)'));
  const timeB = makeInput(compareRow, 'datetime-local', t('Time B (UTC)'));
  const analysisRow = document.createElement('div');
  analysisRow.className = 'replay-chips';
  const heatChip = makeChip(
    analysisRow,
    t('HEAT'),
    t('Show where contacts were densest in this period'),
    () => controller.toggleHeat(),
  );
  const compareChip = makeChip(
    analysisRow,
    t('COMPARE'),
    t('Show who appeared and who left between time A and time B'),
    () =>
      controller.compareTimes(
        Date.parse(`${timeA.value}:00Z`),
        Date.parse(`${timeB.value}:00Z`),
      ),
  );
  const clearCompare = makeChip(
    analysisRow,
    '✕',
    t('Clear the comparison'),
    () => controller.clearCompare(),
  );
  const heatLegend = document.createElement('div');
  heatLegend.className = 'replay-heat-legend replay-alerts';
  const heatSwatch = document.createElement('span');
  heatSwatch.className = 'replay-heat-swatch';
  const heatText = document.createElement('span');
  heatLegend.append(heatSwatch, heatText);
  const compareLine = document.createElement('div');
  compareLine.className = 'replay-alerts';
  // Settings and thinning: changed here, applied at once, and saved to the
  // settings file so they last.
  const settingsBlock = document.createElement('div');
  settingsBlock.className = 'replay-settings';
  settingsBlock.hidden = true;
  const field = (label, input) => {
    const wrap = document.createElement('label');
    wrap.className = 'replay-field';
    const text = document.createElement('span');
    text.textContent = label;
    wrap.append(text, input);
    return wrap;
  };
  const retentionIn = makeInput(
    settingsBlock,
    'text',
    t('Keep for (6h, 14d, 8w, 3m, 1y)'),
  );
  const capIn = makeInput(
    settingsBlock,
    'number',
    t('Size cap in MB (0 for none)'),
  );
  const intervalIn = makeInput(
    settingsBlock,
    'number',
    t('Save a point every (seconds)'),
  );
  capIn.min = '0';
  intervalIn.min = '1';
  intervalIn.max = '3600';
  const settingsInputs = {
    retention: retentionIn,
    maxMb: capIn,
    interval: intervalIn,
  };
  settingsBlock.replaceChildren(
    field(t('Keep for (6h, 14d, 8w, 3m, 1y)'), retentionIn),
    field(t('Size cap in MB (0 for none)'), capIn),
    field(t('Save a point every (seconds)'), intervalIn),
  );
  const recordLabel = document.createElement('div');
  recordLabel.className = 'replay-alerts';
  recordLabel.textContent = t('Record these layers');
  const recordRow = document.createElement('div');
  recordRow.className = 'replay-chips';
  const recordChosen = new Set();
  const recordChips = LAYER_LABELS.map(([id, label]) => [
    id,
    makeChip(recordRow, t(label), t('Record this layer'), () => {
      if (recordChosen.has(id)) recordChosen.delete(id);
      else recordChosen.add(id);
      settingsDirty = true;
      render(controller.state());
    }),
  ]);
  const settingsNote = document.createElement('div');
  settingsNote.className = 'replay-alerts';
  let settingsMessage = '';
  let settingsDirty = false;
  // Typing marks the form as edited, so a refresh does not overwrite it.
  for (const input of Object.values(settingsInputs))
    input.addEventListener('input', () => {
      settingsDirty = true;
    });
  const applyRow = document.createElement('div');
  applyRow.className = 'replay-chips';
  makeChip(
    applyRow,
    t('APPLY'),
    t('Apply these settings now and save them'),
    async () => {
      try {
        const result = await controller.saveSettings({
          retention: retentionIn.value,
          maxMb: capIn.value === '' ? 0 : capIn.value,
          interval: intervalIn.value,
          layers: [...recordChosen],
        });
        settingsDirty = false;
        settingsMessage = result.saved
          ? t('Settings applied')
          : t(
              'Settings applied for now, but could not be saved to the settings file',
            );
      } catch (error) {
        settingsMessage = `${t(COULD_NOT_APPLY)}: ${error.message}`;
      }
      render(controller.state());
    },
  );
  const thinLabel = document.createElement('div');
  thinLabel.className = 'replay-alerts';
  thinLabel.textContent = t('Thin old data');
  const olderIn = makeInput(
    settingsBlock,
    'text',
    t('Older than (6h, 14d, 8w)'),
  );
  const everyIn = makeInput(
    settingsBlock,
    'number',
    t('Keep one point every (seconds)'),
  );
  olderIn.value = '1d';
  everyIn.value = '60';
  everyIn.min = '1';
  const thinFields = document.createElement('div');
  thinFields.className = 'replay-settings';
  thinFields.append(
    field(t('Older than (6h, 14d, 8w)'), olderIn),
    field(t('Keep one point every (seconds)'), everyIn),
  );
  const thinRow = document.createElement('div');
  thinRow.className = 'replay-chips';
  const thinNote = document.createElement('div');
  thinNote.className = 'replay-alerts';
  let previewed = '';
  const thinParams = () => ({
    olderThan: olderIn.value,
    keepEvery: everyIn.value,
  });
  const thinNow = makeChip(
    thinRow,
    t('THIN NOW'),
    t('Remove the extra points; pinned contacts are never thinned'),
    async () => {
      try {
        const r = await controller.thin({ ...thinParams(), dryRun: false });
        thinNote.textContent = t('Removed {removed} of {total} positions', {
          removed: r.removed.toLocaleString(),
          total: r.total.toLocaleString(),
        });
      } catch (error) {
        thinNote.textContent = `${t(COULD_NOT_THIN)}: ${error.message}`;
      }
      previewed = '';
      render(controller.state());
    },
  );
  makeChip(
    thinRow,
    t('PREVIEW'),
    t('Count what thinning would remove'),
    async () => {
      try {
        const r = await controller.thin({ ...thinParams(), dryRun: true });
        previewed = JSON.stringify(thinParams());
        thinNote.textContent = t(
          'Would remove {removed} of {total} positions',
          {
            removed: r.removed.toLocaleString(),
            total: r.total.toLocaleString(),
          },
        );
      } catch (error) {
        previewed = '';
        thinNote.textContent = `${t(COULD_NOT_THIN)}: ${error.message}`;
      }
      render(controller.state());
    },
  );
  settingsBlock.append(
    recordLabel,
    recordRow,
    applyRow,
    settingsNote,
    thinLabel,
    thinFields,
    thinRow,
    thinNote,
  );
  const settingsChip = makeChip(
    analysisRow,
    t('SETTINGS'),
    t('Change how the recorder keeps data'),
    () => {
      settingsBlock.hidden = !settingsBlock.hidden;
      if (!settingsBlock.hidden) settingsDirty = false;
      render(controller.state());
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
    compareRow,
    analysisRow,
    heatLegend,
    compareLine,
    settingsBlock,
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

  const stamp = (ms) => new Date(ms).toISOString().slice(0, 16);
  const renderAnalysis = (state) => {
    const to = state.status?.to_ts;
    // Start with the newest hour against the one before it, ready to press.
    if (to && !timeA.value && !timeB.value) {
      timeB.value = stamp(to * 1000);
      timeA.value = stamp((to - 3600) * 1000);
    }
    set(heatChip, 'disabled', !state.range);
    set(compareChip, 'disabled', !state.range || state.analysisBusy);
    set(
      heatChip,
      'className',
      `data-toggle-chip${state.heat ? ' active' : ''}`,
    );
    set(clearCompare, 'hidden', !state.compare);
    set(heatLegend, 'hidden', !state.heat);
    set(
      heatText,
      'textContent',
      state.heat
        ? t('{count} contacts in the busiest square', { count: state.heat.max })
        : '',
    );
    const c = state.compare;
    const key = c ? `${c.appeared}|${c.gone}|${c.stayed}` : '';
    if (compareLine.dataset.key !== key) {
      compareLine.dataset.key = key;
      const part = (text, className) => {
        const node = document.createElement('span');
        node.className = className;
        node.textContent = text;
        return node;
      };
      compareLine.replaceChildren(
        ...(c
          ? [
              part(
                `● ${t('{count} appeared', { count: c.appeared })}`,
                'replay-track-first',
              ),
              ' · ',
              part(
                `● ${t('{count} gone', { count: c.gone })}`,
                'replay-track-last',
              ),
              ` · ${t('{count} in both', { count: c.stayed })}`,
            ]
          : []),
      );
    }
    set(compareLine, 'hidden', !c);
  };

  const renderSettings = (state) => {
    const s = state.status;
    set(
      settingsChip,
      'className',
      `data-toggle-chip${settingsBlock.hidden ? '' : ' active'}`,
    );
    if (!s || settingsBlock.hidden) return;
    // Show what the recorder uses now, until the viewer starts editing.
    if (!settingsDirty) {
      retentionIn.value = s.retention_sec
        ? formatSpanCompact(s.retention_sec)
        : '0';
      capIn.value = s.max_bytes
        ? String(Math.round(s.max_bytes / 1048576))
        : '0';
      intervalIn.value = String(s.interval_sec ?? 30);
      recordChosen.clear();
      for (const id of s.layers ?? []) recordChosen.add(id);
    }
    const locked = new Set(s.locked ?? []);
    for (const [key, input] of Object.entries(settingsInputs))
      input.classList.toggle('replay-locked', locked.has(key));
    for (const [id, node] of recordChips) {
      set(node, 'hidden', !(s.available_layers ?? []).includes(id));
      set(
        node,
        'className',
        `data-toggle-chip${recordChosen.has(id) ? ' active' : ''}`,
      );
    }
    const lockedText = locked.size
      ? t(
          'Dashed settings are also fixed by environment variables, which return after a restart.',
        )
      : '';
    set(
      settingsNote,
      'textContent',
      [settingsMessage, lockedText].filter(Boolean).join(' '),
    );
    const current = JSON.stringify(thinParams());
    set(thinNow, 'disabled', previewed !== current);
  };

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
    set(
      storageWarn,
      'textContent',
      warn ? `${warn} ${t('Open SETTINGS to thin old data.')}` : '',
    );
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
    renderAnalysis(state);
    renderSettings(state);
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
    const lines = state.events.map(noticeText);
    set(
      alertsChip,
      'className',
      `data-toggle-chip${alertsOn ? ' active' : ''}`,
    );
    if (note) lines.push(note);
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
        ...lines.map((line, i) => {
          const row = document.createElement('div');
          row.textContent = line;
          if (state.events[i]?.type === 'emergency')
            row.className = 'replay-alert-emergency';
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

  const unsubscribeNotices = controller.onNotice((n) => {
    if (!alertsOn) return;
    const urgent = n.type === 'emergency' && n.severity === 'emergency';
    // A priority status (minimum fuel, lifeguard) is listed but never sounds.
    if (n.type === 'emergency' && !urgent) return;
    announce({
      title: urgent ? t(EMERGENCY_TITLE) : t('Watched area'),
      body: noticeText(n),
      urgent,
      tag: `${n.type}:${n.id}:${n.kind}`,
    });
  });
  const unsubscribe = controller.subscribe(render);
  render(controller.state());
  controller.refreshRange();

  return {
    destroy() {
      unsubscribe();
      unsubscribeNotices();
      timeline?.destroy();
      root.remove();
      if (panel) set(panel, 'hidden', true);
    },
  };
}
