import { msg, t, translateKnown } from '../i18n/index.js';
import { createRailTimeline, utcClock } from './railTimeline.js';

const LAYER_LABELS = [
  ['air', msg('AIR')],
  ['mil', msg('MIL')],
  ['vessel', msg('SEA')],
  ['local', msg('LOCAL')],
];
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
  const speedChips = controller
    .state()
    .speeds.map((value) => [
      value,
      makeChip(chips, `${value}×`, t('Playback speed'), () =>
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
  const fenceList = document.createElement('div');
  fenceList.className = 'replay-fences';
  const alerts = document.createElement('div');
  alerts.className = 'replay-alerts';
  const timelineHost = document.createElement('div');
  timelineHost.className = 'weather-timeline-block';
  root.append(status, chips, layerRow, fenceList, alerts, timelineHost);
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

  const render = (state) => {
    const ready = state.active && state.ticks.length > 1;
    if (panel) set(panel, 'hidden', !state.status && !state.active);
    if (count)
      set(count, 'textContent', state.active ? t('REPLAY') : t('LIVE'));
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
    set(start, 'disabled', state.loading || !state.range);
    set(fit, 'disabled', !state.active || !state.contacts);
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
