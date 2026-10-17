// Bottom timeline. Two honest layers of information:
//  1. Observation windows per enabled event layer, built from the records the
//     engine actually holds (earliest to latest observation time). A feed that
//     only provides a current snapshot is drawn as a snapshot, not a span.
//  2. Playback, only for the engine's weather clock, which really does hold
//     a sequence of observed radar / satellite / lightning frames. Every other
//     feed has no history, so playback controls stay disabled for it.
import { t } from '../../i18n/index.js';
import { el, button, chip, replaceChildren } from './dom.js';
import { formatTimestamp } from './provenance.js';
import { EVENT_LAYERS } from './engine.js';

const WINDOW_HOURS = 24;

export function createTimeline({ engine }) {
  const root = document.getElementById('oryn-timeline');
  const bar = document.getElementById('oryn-timeline-bar');
  const body = document.getElementById('oryn-timeline-body');
  let unsubscribeClock = null;
  let unsubscribeActivity = null;
  let frame = null;

  function setOpen(open) {
    root.dataset.orynExpanded = String(open);
    body.hidden = !open;
    document.body.dataset.orynTimeline = open ? 'open' : 'closed';
    render();
  }

  function observationTracks(current) {
    const now = Date.now();
    const start = now - WINDOW_HOURS * 3600 * 1000;
    const tracks = [];
    for (const [layerId, spec] of Object.entries(EVENT_LAYERS)) {
      const entry = current.dataManager.layers.get(layerId);
      if (!entry?.enabled) continue;
      const feed = current.feedsById().get(layerId);
      let records = [];
      try {
        records = entry.module?.getAnalystRecords?.(2000) || [];
      } catch {
        records = [];
      }
      const times = records
        .map((record) => spec.observedAt(record))
        .map((value) => (typeof value === 'number' ? value : Date.parse(value)))
        .filter((value) => Number.isFinite(value));
      tracks.push({
        id: layerId,
        name: feed?.name || layerId,
        count: records.length,
        earliest: times.length ? Math.min(...times) : null,
        latest: times.length ? Math.max(...times) : null,
        snapshot: !times.length,
        retrievedAt: feed?.lastUpdate ?? null,
      });
    }
    return { tracks, start, now };
  }

  function trackRow(track, start, now) {
    const rail = el('div', { className: 'oryn-track-rail' });
    const span = now - start;
    if (track.earliest !== null && track.latest !== null) {
      const left = Math.max(0, ((track.earliest - start) / span) * 100);
      const right = Math.min(100, ((track.latest - start) / span) * 100);
      const node = el('div', { className: 'oryn-track-span' });
      node.style.left = `${left}%`;
      node.style.width = `${Math.max(0.6, right - left)}%`;
      rail.append(node);
    } else if (track.retrievedAt) {
      const left = Math.min(
        100,
        Math.max(0, ((track.retrievedAt - start) / span) * 100),
      );
      const node = el('div', {
        className: 'oryn-track-span oryn-track-snapshot',
      });
      node.style.left = `calc(${left}% - 3px)`;
      node.style.width = '6px';
      rail.append(node);
    }
    const meta = track.snapshot
      ? t('snapshot · {count}', { count: track.count })
      : t('{count} obs.', { count: track.count });
    return el(
      'div',
      {
        className: 'oryn-track',
        attrs: {
          title: track.snapshot
            ? t(
                'This feed provides current records without observation times; it is drawn as a snapshot at the retrieval time.',
              )
            : t(
                'Observation times reported by the source, within the last 24 hours.',
              ),
        },
      },
      el('span', { className: 'oryn-track-name', text: track.name }),
      rail,
      el('span', { className: 'oryn-track-meta', text: meta }),
    );
  }

  function weatherControls(current) {
    const weatherClock = current.weatherClock;
    const state = weatherClock?.getState?.();
    const timeline = state?.timeline ?? [];
    const title = el('h4', {
      className: 'oryn-section-title',
      text: t('Weather playback'),
    });
    if (!weatherClock || !timeline.length) {
      return el(
        'div',
        { className: 'oryn-timeline-controls' },
        title,
        el('p', {
          className: 'oryn-note',
          text: t(
            'Enable Weather radar, satellite or lightning to replay observed frames. Other feeds provide no history, so playback is unavailable for them.',
          ),
        }),
      );
    }
    const index = state.target
      ? Math.max(0, timeline.indexOf(state.target))
      : timeline.length - 1;
    const slider = el('input', {
      className: 'oryn-slider',
      attrs: {
        type: 'range',
        min: 0,
        max: timeline.length - 1,
        value: index,
        'aria-label': t('Weather frame'),
      },
      on: {
        input: (event) => {
          const time = timeline[Number(event.target.value)];
          if (time) weatherClock.setTarget(time);
        },
      },
    });
    const shown = state.target ?? timeline.at(-1);
    return el(
      'div',
      { className: 'oryn-timeline-controls' },
      title,
      el(
        'div',
        { className: 'oryn-actions' },
        button({
          iconName: 'stepBack',
          className: 'oryn-btn-sm oryn-btn-icon',
          title: t('Previous frame'),
          onClick: () => weatherClock.step(-1),
        }),
        button({
          iconName: state.playing ? 'pause' : 'play',
          className: 'oryn-btn-sm oryn-btn-icon',
          title: state.playing ? t('Pause') : t('Play'),
          onClick: () => weatherClock.togglePlay(),
        }),
        button({
          iconName: 'stepForward',
          className: 'oryn-btn-sm oryn-btn-icon',
          title: t('Next frame'),
          onClick: () => weatherClock.step(1),
        }),
        button({
          label: t('Latest'),
          className: 'oryn-btn-sm',
          onClick: () => weatherClock.latest(),
        }),
      ),
      slider,
      el('div', {
        className: 'oryn-card-meta',
        text: t('{index} of {total} · {time}', {
          index: index + 1,
          total: timeline.length,
          time: formatTimestamp(shown),
        }),
      }),
      el('p', {
        className: 'oryn-note',
        text: t('Frames span {from} to {to}, as published by the provider.', {
          from: formatTimestamp(timeline[0]),
          to: formatTimestamp(timeline.at(-1)),
        }),
      }),
    );
  }

  function render() {
    const current = engine();
    const now = new Date();
    const barNodes = [
      button({
        iconName:
          root.dataset.orynExpanded === 'true' ? 'chevronRight' : 'chevronLeft',
        className: 'oryn-btn-ghost oryn-btn-sm oryn-btn-icon',
        title:
          root.dataset.orynExpanded === 'true'
            ? t('Collapse timeline')
            : t('Expand timeline'),
        attrs: {
          'aria-expanded':
            root.dataset.orynExpanded === 'true' ? 'true' : 'false',
        },
        onClick: () => setOpen(root.dataset.orynExpanded !== 'true'),
      }),
      el('span', { text: t('TIMELINE'), className: 'oryn-panel-title' }),
      el('span', { className: 'oryn-mono', text: formatTimestamp(now) }),
    ];
    if (current) {
      const { tracks } = observationTracks(current);
      const enabled = tracks.length;
      barNodes.push(
        chip(
          t('{count} event feeds', { count: enabled }),
          enabled ? 'info' : 'neutral',
        ),
      );
      const weatherState = current.weatherClock?.getState?.();
      if (weatherState?.timeline?.length)
        barNodes.push(
          chip(
            weatherState.playing
              ? t('WEATHER PLAYING')
              : t('WEATHER FRAMES {count}', {
                  count: weatherState.timeline.length,
                }),
            'ok',
          ),
        );
    } else {
      barNodes.push(chip(t('ENGINE STARTING'), 'loading'));
    }
    replaceChildren(bar, barNodes);

    if (body.hidden) return;
    if (!current) {
      replaceChildren(
        body,
        el('p', {
          className: 'oryn-note',
          text: t('Timeline data appears once the globe has initialized.'),
        }),
      );
      return;
    }
    const { tracks, start } = observationTracks(current);
    const nowMs = Date.now();
    const trackNodes = tracks.length
      ? tracks.map((track) => trackRow(track, start, nowMs))
      : [
          el('p', {
            className: 'oryn-note',
            text: t(
              'No event layers are enabled. Enable Earthquakes, Fires or Cyclones in the layer manager to see observation windows.',
            ),
          }),
        ];
    replaceChildren(
      body,
      weatherControls(current),
      el(
        'div',
        { className: 'oryn-timeline-tracks' },
        el('h4', {
          className: 'oryn-section-title',
          text: t('Observation windows (last 24 h)'),
        }),
        el(
          'div',
          { className: 'oryn-timeline-axis' },
          el('span', { text: formatTimestamp(start) }),
          el('span', { text: t('now') }),
        ),
        trackNodes,
      ),
    );
  }

  function attach() {
    unsubscribeClock?.();
    unsubscribeActivity?.();
    const current = engine();
    if (!current) return;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        render();
      });
    };
    unsubscribeActivity = current.subscribeActivity(schedule);
    if (current.weatherClock?.subscribe)
      unsubscribeClock = current.weatherClock.subscribe(schedule);
    render();
  }

  render();
  const ticker = setInterval(() => {
    if (body.hidden) render();
  }, 30_000);

  return Object.freeze({
    attach,
    render,
    toggle: () => setOpen(root.dataset.orynExpanded !== 'true'),
    open: () => setOpen(true),
    close: () => setOpen(false),
    get isOpen() {
      return root.dataset.orynExpanded === 'true';
    },
    destroy() {
      clearInterval(ticker);
      unsubscribeClock?.();
      unsubscribeActivity?.();
    },
  });
}
