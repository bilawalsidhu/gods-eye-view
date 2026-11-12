import { msg, t, translateKnown } from '../i18n/index.js';
import { aircraftEmergency } from '../data/aircraftEmergency.js';
import {
  formatBytes,
  formatSpan,
  formatSpanCompact,
  driveSpace,
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
const FEED_STATE = {
  ok: msg('delivering'),
  empty: msg('empty reply'),
  failing: msg('failing'),
  idle: msg('not asked'),
  unseen: msg('not seen yet'),
};
const MOVED = msg('Recording moved to {path}');
const REUSED = msg('Using the history already in that folder');
const OLD_DELETED = msg('The old copy was deleted');
const DRIVE_FULL = msg(
  '{drive} is nearly full: {free} free of {total}. New points cannot be saved once it fills.',
);
const DRIVE_NAMELESS = msg('The recording drive');
const DRIVE_DOWN = msg(
  'Cannot write to the recording folder: {error}. {count} points are waiting.',
);
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
  chips.className = 'replay-chips replay-modes';
  const areaRow = document.createElement('div');
  areaRow.className = 'replay-chips';
  const windowRow = document.createElement('div');
  windowRow.className = 'replay-chips';
  const start = makeChip(chips, t('REPLAY'), t('Replay recorded history'), () =>
    controller.enter(),
  );
  const fit = makeChip(chips, t('FIT'), t('Fly to the replayed contacts'), () =>
    controller.fit(),
  );
  const watch = makeChip(areaRow, t('WATCH'), t('Draw an area to watch'), () =>
    controller.watch(),
  );
  let alertsOn = alertsEnabled();
  const alertsChip = makeChip(
    areaRow,
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
    areaRow,
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
  jumpRow.className = 'replay-chips replay-row-input';
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
  compareRow.className = 'replay-chips replay-row-pair';
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
  // Where recordings are kept: a folder, perhaps on another drive.
  const locationBlock = document.createElement('div');
  locationBlock.className = 'replay-settings';
  const folderIn = makeInput(
    locationBlock,
    'text',
    t('Save recordings in (full folder path)'),
  );
  const driveRow = document.createElement('div');
  driveRow.className = 'replay-chips';
  const copyBox = document.createElement('input');
  copyBox.type = 'checkbox';
  copyBox.checked = true;
  const deleteBox = document.createElement('input');
  deleteBox.type = 'checkbox';
  const check = (box, label) => {
    const wrap = document.createElement('label');
    wrap.className = 'replay-check';
    const text = document.createElement('span');
    text.textContent = label;
    wrap.append(box, text);
    return wrap;
  };
  const whereNote = document.createElement('div');
  whereNote.className = 'replay-alerts';
  locationBlock.replaceChildren(
    field(t('Save recordings in (full folder path)'), folderIn),
    driveRow,
    check(copyBox, t('Copy the history so far to the new place')),
    check(deleteBox, t('Delete the old copy afterwards to free space here')),
    whereNote,
  );
  folderIn.addEventListener('input', () => {
    settingsDirty = true;
  });
  /** Chips for the other drives; pressing one fills in a folder on it. */
  let drivesLoaded = false;
  async function loadDrives() {
    if (drivesLoaded) return;
    drivesLoaded = true;
    try {
      const { drives } = await controller.drives();
      driveRow.replaceChildren(
        ...drives
          .filter((d) => !d.main)
          .map((d) => {
            const chip = makeChip(
              driveRow,
              t('{label} · {free} free', {
                label: d.volume ? `${d.label} ${d.volume}` : d.label,
                free: formatBytes(d.freeBytes),
              }),
              d.path,
              () => {
                folderIn.value = d.path;
                settingsDirty = true;
              },
            );
            return chip;
          }),
      );
    } catch {
      drivesLoaded = false;
    }
  }
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
        const here = controller.state().status?.storage?.path;
        const folderChanged =
          folderIn.value.trim() &&
          folderIn.value.trim().replace(/[\\/]+$/, '') !==
            String(here ?? '').replace(/[\\/][^\\/]*$/, '');
        const result = await controller.saveSettings({
          ...(folderChanged
            ? {
                folder: folderIn.value.trim(),
                copy: copyBox.checked,
                deleteOld: deleteBox.checked,
              }
            : {}),
          retention: retentionIn.value,
          maxMb: capIn.value === '' ? 0 : capIn.value,
          interval: intervalIn.value,
          layers: [...recordChosen],
        });
        settingsDirty = false;
        const moved = result.moved?.changed
          ? [
              t(MOVED, { path: result.moved.to }),
              result.moved.reused ? t(REUSED) : '',
              result.moved.deleted ? t(OLD_DELETED) : '',
            ]
              .filter(Boolean)
              .join('. ') + '. '
          : '';
        settingsMessage =
          moved +
          (result.saved
            ? t('Settings applied')
            : t(
                'Settings applied for now, but could not be saved to the settings file',
              ));
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
  settingsBlock.prepend(locationBlock);
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
  const feedsChip = makeChip(
    analysisRow,
    t('FEEDS'),
    t('Show whether each data feed is delivering'),
    () => {
      feedList.hidden = !feedList.hidden;
      render(controller.state());
    },
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
  findRow.className = 'replay-chips replay-row-input';
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
      makeChip(windowRow, `${hours}h`, t('Time window'), () =>
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
  const driveWarn = document.createElement('div');
  driveWarn.className = 'replay-storage-warn';
  driveWarn.hidden = true;
  const driveFull = document.createElement('div');
  driveFull.className = 'replay-storage-warn replay-drive-full';
  driveFull.hidden = true;
  const storageWarn = document.createElement('div');
  storageWarn.className = 'replay-storage-warn';
  // Feed health: one coloured word per feed, and the detail on request.
  const feedLine = document.createElement('div');
  feedLine.className = 'replay-alerts replay-feedline';
  const feedList = document.createElement('div');
  feedList.className = 'replay-alerts';
  feedList.hidden = true;
  storage.append(
    storageHead,
    bar,
    storageNumbers,
    storageNote,
    storageLayers,
    feedLine,
    feedList,
    driveWarn,
    driveFull,
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
  // Controls sit in labelled groups so the panel reads top to bottom: what is
  // recorded, how to play it, what to show, then the tools.
  const group = (label, ...nodes) => {
    const box = document.createElement('div');
    box.className = 'replay-group';
    if (label) {
      const title = document.createElement('span');
      title.className = 'replay-group-label';
      title.textContent = label;
      box.appendChild(title);
    }
    box.append(...nodes);
    return box;
  };
  root.append(
    status,
    storage,
    chips,
    timelineHost,
    group(t('Speed'), speedRow),
    group(t('Time window'), windowRow),
    group(t('Layers'), layerRow),
    group(t('Area'), areaRow, fenceList),
    group(t('JUMP'), jumpRow),
    group('', compareRow, analysisRow, heatLegend, compareLine, settingsBlock),
    group(t('FIND'), findRow, trackLine),
    group(t('EXPORT'), exportRow),
    legend,
    alerts,
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

  const gapWhy = (kinds) => {
    const parts = [];
    if (kinds?.failing)
      parts.push(t('{count} feed down', { count: kinds.failing }));
    if (kinds?.idle) parts.push(t('{count} not asked', { count: kinds.idle }));
    return parts.length ? ` (${parts.join(', ')})` : '';
  };
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

  const feedText = (feed, now) => {
    const ago = (sec) => formatSpan(Math.max(0, now - sec));
    if (feed.state === 'ok')
      return t('{count} contacts, {ago} ago', {
        count: feed.lastCount.toLocaleString(),
        ago: ago(feed.lastRequest),
      });
    if (feed.state === 'empty')
      return t('Answered with no contacts, {ago} ago', {
        ago: ago(feed.lastRequest),
      });
    if (feed.state === 'failing')
      return t('HTTP {status}, since {time}', {
        status: feed.lastStatus,
        time: utcClock(new Date(feed.since * 1000).toISOString()),
      });
    if (feed.state === 'idle')
      return t('Nothing has asked for it for {ago}', {
        ago: formatSpan(feed.idleFor),
      });
    return t('Not seen since the server started');
  };
  const renderFeeds = (s) => {
    const feeds = s?.feeds ?? [];
    const backup = s?.n2yo?.enabled ? s.n2yo : null;
    set(feedLine, 'hidden', !feeds.length);
    const now = Math.floor(Date.now() / 1000);
    const names = Object.fromEntries(
      LAYER_LABELS.map(([id, label]) => [id, t(label)]),
    );
    set(
      feedsChip,
      'className',
      `data-toggle-chip${feedList.hidden ? '' : ' active'}`,
    );
    const key = `${feedList.hidden ? 0 : 1}|${backup ? `${backup.loaded}${backup.error}` : ''}|${feeds.map((f) => `${f.layer}:${f.state}:${f.lastRequest}`).join('|')}`;
    if (feedLine.dataset.key === key) return;
    feedLine.dataset.key = key;
    feedLine.replaceChildren(
      ...feeds.flatMap((f, i) => {
        const node = document.createElement('span');
        node.className = `replay-feed replay-feed-${f.state}`;
        node.textContent = `● ${names[f.layer] || f.layer}`;
        node.title = `${names[f.layer] || f.layer}: ${t(FEED_STATE[f.state])}`;
        return i ? [' ', node] : [node];
      }),
    );
    feedList.replaceChildren(
      ...feeds.map((f) => {
        const row = document.createElement('div');
        row.className = `replay-feed-${f.state}`;
        row.textContent = `${names[f.layer] || f.layer} ${t(FEED_STATE[f.state])} · ${feedText(f, now)}`;
        return row;
      }),
      ...(backup
        ? [
            Object.assign(document.createElement('div'), {
              textContent: backup.error
                ? `${t('N2YO backup: {count} pinned satellites loaded', { count: backup.loaded })} · ${backup.error}`
                : t('N2YO backup: {count} pinned satellites loaded', {
                    count: backup.loaded,
                  }),
            }),
          ]
        : []),
    );
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
    set(locationBlock, 'hidden', s.backend === 'postgres');
    loadDrives();
    if (!settingsDirty) {
      folderIn.value = String(s.storage?.path ?? '').replace(
        /[\\/][^\\/]*$/,
        '',
      );
    }
    set(
      whereNote,
      'textContent',
      s.storage?.path
        ? t('Recording to {path}', { path: s.storage.path }) +
            (s.disk_free_bytes != null
              ? ` · ${t('{free} free', { free: formatBytes(s.disk_free_bytes) })}`
              : '')
        : '',
    );
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

  const renderDriveWarning = (s) => {
    const bad = s.storage && s.storage.ok === false;
    set(
      driveWarn,
      'textContent',
      bad
        ? t(DRIVE_DOWN, {
            error: s.storage.error,
            count: s.storage.waiting.toLocaleString(),
          })
        : '',
    );
    set(driveWarn, 'hidden', !bad);
  };

  const renderStorage = (s) => {
    set(storage, 'hidden', !s);
    if (!s) return;
    renderDriveWarning(s);
    const space = driveSpace(s);
    const full = space && space.level !== 'ok';
    set(
      driveFull,
      'textContent',
      full
        ? t(DRIVE_FULL, {
            drive: s.disk_label || t(DRIVE_NAMELESS),
            free: formatBytes(space.free),
            total: formatBytes(space.total),
          })
        : '',
    );
    set(driveFull, 'hidden', !full);
    driveFull.dataset.level = space?.level ?? 'ok';
    const use = storageUse(s);
    const percent = Math.round(use.fraction * 100);
    storage.dataset.level = use.basis === 'none' ? 'none' : use.level;
    set(
      storageLabel,
      'textContent',
      use.basis === 'none'
        ? t('STORAGE')
        : `${t('STORAGE')} · ${s.disk_label ? s.disk_label : t(BASIS[use.basis])}`,
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
    renderFeeds(state.status);
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
              ` · ${t('{count} gaps', { count: tr.gaps.length })}${gapWhy(tr.gapKinds)}`,
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
