import { t } from '../../i18n/index.js';
import { createKiwiAudio } from './audio.js';
import { createKiwiSession } from './client.js';
import { stationStyle } from './palette.js';
import {
  MODES,
  MODE_IDS,
  PRESETS,
  axisTicks,
  formatFrequency,
  formatSmeter,
  formatSpan,
  frequencyAtFraction,
  MAX_ZOOM,
  panCenterKhz,
  snapFrequencyKhz,
  tuneStepKhz,
  waterfallSpanKhz,
  zoomAround,
} from './protocol.js';
import { createKiwiStore } from './storage.js';
import { createWaterfall } from './waterfall.js';

const PANEL_ID = 'kiwisdr-panel';

function el(doc, tag, props = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

/**
 * The listening panel: one receiver at a time. Everything that came from the
 * public directory (names, antennas) is inserted with textContent only.
 */
export function createKiwiPanel({
  document: doc = globalThis.document,
  createSession = createKiwiSession,
  createAudio = createKiwiAudio,
  store = createKiwiStore(),
  onClose = () => {},
} = {}) {
  let root = null;
  let session = null;
  let audio = null;
  let waterfall = null;
  let unsubscribes = [];
  let ui = null;
  let currentStation = null;
  let reconnecting = false;
  let lastFrequency = null;
  let generation = 0;
  let docked = false;
  let unsubStore = null;

  function setStatus(text, tone = 'info') {
    if (!ui) return;
    ui.status.textContent = text;
    ui.status.dataset.tone = tone;
  }

  function setDiag(text) {
    if (!ui) return;
    ui.diag.textContent = text;
    ui.diag.hidden = !text;
  }

  function renderStar() {
    if (!ui || !currentStation) return;
    const on = store.isFavorite(currentStation.id);
    ui.star.setAttribute('aria-pressed', String(on));
    ui.star.textContent = on ? '★' : '☆';
    ui.star.title = on ? t('Remove from favorites') : t('Add to favorites');
  }

  function renderSaved() {
    if (!ui || !currentStation) return;
    const saved = store.getPresets(currentStation.id);
    ui.saved.replaceChildren(
      ...saved.map((preset) => {
        const mode = preset.mode ? ` ${MODES[preset.mode]?.label ?? ''}` : '';
        return el(doc, 'span', { className: 'kiwisdr-saved' }, [
          el(doc, 'button', {
            type: 'button',
            className: 'kiwisdr-chip',
            // i18n-ignore: frequency and mode codes
            text: `${formatFrequency(preset.freqKhz)}${mode}`,
            onclick: () =>
              session?.tune({
                freqKhz: preset.freqKhz,
                ...(preset.mode ? { mode: preset.mode } : {}),
              }),
          }),
          el(doc, 'button', {
            type: 'button',
            className: 'kiwisdr-chip kiwisdr-chip-x',
            text: '×',
            'aria-label': t('Delete saved frequency'),
            onclick: () => store.removePreset(currentStation.id, preset),
          }),
        ]);
      }),
    );
    ui.savedEmpty.hidden = saved.length > 0;
  }

  function renderDock() {
    if (!root) return;
    root.dataset.docked = String(docked);
    ui.minimize.textContent = docked ? '▴' : '▾';
    ui.minimize.setAttribute('aria-expanded', String(!docked));
    ui.minimize.title = docked ? t('Expand receiver') : t('Minimize receiver');
    ui.minimize.setAttribute('aria-label', ui.minimize.title);
  }

  function setDocked(next) {
    docked = next;
    renderDock();
  }

  function renderZoom(view) {
    ui.zoom.textContent =
      view.zoom === 0
        ? t('Full band')
        : // i18n-ignore: zoom factor and frequency span
          `×${2 ** view.zoom} · ${formatSpan(waterfallSpanKhz(view.zoom, view.fullKhz))}`;
  }

  /** Move the tuned frequency by whole steps of the current resolution. */
  function nudge(steps) {
    if (!session) return;
    const span = waterfallSpanKhz(session.view.zoom, session.view.fullKhz);
    const step = tuneStepKhz(span);
    session.tune({
      freqKhz: snapFrequencyKhz(session.tuning.freqKhz + steps * step, span),
    });
  }

  function zoomAt(fraction, delta) {
    if (!session) return;
    const next = zoomAround(session.view, fraction, delta);
    if (next) session.setZoom(next.zoom, next.centerKhz);
  }

  function renderAxis(view) {
    ui.axis.replaceChildren(
      ...axisTicks(view).map((tick) =>
        el(doc, 'span', {
          className: 'kiwisdr-tick',
          text: tick.label,
          style: `left:${(tick.fraction * 100).toFixed(2)}%`,
        }),
      ),
    );
  }

  function renderTuning(tuning) {
    // Only protect the box while the user is mid-edit. Merely being focused
    // (open() focuses it) must not block the first value from appearing.
    if (ui.freq.dataset.editing !== '1')
      ui.freq.value = tuning.freqKhz.toFixed(3);
    ui.readout.textContent = formatFrequency(tuning.freqKhz);
    ui.miniReadout.textContent = formatFrequency(tuning.freqKhz);
    for (const [id, button] of ui.modes) {
      button.setAttribute('aria-pressed', String(id === tuning.mode));
    }
    const mode = MODES[tuning.mode] || MODES.am;
    waterfall?.setTuning({
      freqKhz: tuning.freqKhz,
      low: mode.low,
      high: mode.high,
    });
  }

  function teardownSession() {
    for (const off of unsubscribes) off();
    unsubscribes = [];
    session?.close();
    session = null;
    waterfall?.destroy();
    waterfall = null;
  }

  async function start(station) {
    const mine = ++generation;
    teardownSession();
    ui.reconnect.hidden = true;
    setDiag('');
    ui.meterText.textContent = '--';
    ui.miniMeter.textContent = '--';
    ui.meterBar.style.width = '0%';
    setStatus('Connecting…');
    try {
      audio ||= createAudio();
      // Created inside the click that opened the panel, so the browser lets it play.
      await audio.resume();
      // A newer open() or a close() superseded this one while audio woke up.
      if (mine !== generation || !ui) return;
      session = createSession({
        station,
        audioOutRate: audio.sampleRate,
        startKhz: lastFrequency ?? 10_000,
      });
    } catch (error) {
      setStatus(
        error?.message ? t(error.message) : t('Audio could not start.'),
        'error',
      );
      ui.reconnect.hidden = false;
      return;
    }
    waterfall = createWaterfall({
      canvas: ui.canvas,
      overlay: ui.overlay,
      onTune: (fraction) => {
        const view = session.view;
        const khz = frequencyAtFraction(fraction, view);
        session.tune({
          freqKhz: snapFrequencyKhz(
            khz,
            waterfallSpanKhz(view.zoom, view.fullKhz),
          ),
        });
      },
      onZoom: zoomAt,
      onPan: (delta) => {
        const view = session.view;
        if (view.zoom === 0) return;
        session.setZoom(view.zoom, panCenterKhz(view, delta));
      },
      onHover: (fraction) => {
        if (fraction === null) {
          ui.hover.hidden = true;
          return;
        }
        const view = session.view;
        const khz = snapFrequencyKhz(
          frequencyAtFraction(fraction, view),
          waterfallSpanKhz(view.zoom, view.fullKhz),
        );
        ui.hover.hidden = false;
        ui.hover.textContent = formatFrequency(khz);
        ui.hover.style.left = `${(fraction * 100).toFixed(2)}%`;
      },
    });
    const on = (name, fn) => unsubscribes.push(session.on(name, fn));
    on('state', ({ state, detail }) => {
      if (state === 'connecting') setStatus(t('Connecting…'));
      else if (state === 'live') setStatus(t('Live'), 'ok');
      else if (state === 'error') {
        setStatus(detail ? t(detail) : t('Connection lost.'), 'error');
        ui.reconnect.hidden = false;
      }
    });
    on('diag', (info) => {
      // i18n-ignore: protocol diagnostics for troubleshooting
      const text = `${info.stream} ${info.host}:${info.port} ${info.legacy ? 'legacy path' : '/kiwi path'}: ${info.opened ? 'closed' : 'refused'} · code ${info.code} · ${(info.elapsedMs / 1000).toFixed(1)}s${info.reason ? ` · ${info.reason}` : ''}`;
      console.warn('[KiwiSDR]', currentStation?.host, text);
      setDiag(text);
    });
    on('audio', ({ samples, rate }) => audio.push(samples, rate));
    on('smeter', ({ dbm }) => {
      // i18n-ignore: S-meter units are universal
      const label = `${formatSmeter(dbm)} · ${Math.round(dbm)} dBm`;
      ui.meterText.textContent = label;
      ui.miniMeter.textContent = formatSmeter(dbm);
      ui.meterBar.style.width = `${Math.max(0, Math.min(100, ((dbm + 127) / 100) * 100))}%`;
    });
    // Docked: audio keeps flowing, but nobody is looking at the picture.
    on('waterfall', ({ bins }) => {
      if (!docked) waterfall.addRow(bins);
    });
    on('view', (view) => {
      waterfall.setView(view);
      renderAxis(view);
      renderZoom(view);
    });
    on('waterfallLost', ({ message }) =>
      setStatus(t('Audio only · {message}', { message: t(message) }), 'warn'),
    );
    on('tuning', (tuning) => {
      lastFrequency = tuning.freqKhz;
      renderTuning(tuning);
    });
    renderTuning(session.tuning);
    renderAxis(session.view);
    session.start();
  }

  function build() {
    const freq = el(doc, 'input', {
      id: 'kiwisdr-freq',
      type: 'number',
      step: 'any',
      min: '0',
      max: '30000',
      inputmode: 'decimal',
      'aria-label': t('Frequency in kilohertz'),
    });
    const apply = () => {
      delete freq.dataset.editing;
      const khz = Number(freq.value);
      if (Number.isFinite(khz) && session) session.tune({ freqKhz: khz });
    };
    freq.addEventListener('input', () => {
      freq.dataset.editing = '1';
    });
    freq.addEventListener('blur', () => {
      delete freq.dataset.editing;
    });
    freq.addEventListener('change', apply);
    freq.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') apply();
    });
    const modes = new Map(
      MODE_IDS.map((id) => [
        id,
        el(doc, 'button', {
          type: 'button',
          className: 'kiwisdr-chip',
          text: MODES[id].label,
          'aria-pressed': 'false',
          onclick: () => session?.tune({ mode: id }),
        }),
      ]),
    );
    const canvas = el(doc, 'canvas', {
      className: 'kiwisdr-wf',
      height: '160',
    });
    const overlay = el(doc, 'canvas', {
      className: 'kiwisdr-wf-overlay',
      height: '160',
      title: t('Click to tune · scroll to zoom · drag to pan'),
      tabindex: '0',
      role: 'slider',
      'aria-label': t('Waterfall: arrow keys tune, up and down zoom'),
    });
    const hover = el(doc, 'div', { className: 'kiwisdr-hover', hidden: '' });
    overlay.addEventListener('keydown', (event) => {
      const big = event.shiftKey ? 10 : 1;
      if (event.key === 'ArrowLeft') nudge(-big);
      else if (event.key === 'ArrowRight') nudge(big);
      else if (event.key === 'ArrowUp') zoomAt(0.5, 1);
      else if (event.key === 'ArrowDown') zoomAt(0.5, -1);
      else return;
      event.preventDefault();
    });
    const axis = el(doc, 'div', {
      className: 'kiwisdr-axis',
      'aria-hidden': 'true',
    });
    const status = el(doc, 'div', {
      className: 'kiwisdr-status',
      role: 'status',
      'aria-live': 'polite',
    });
    const reconnect = el(doc, 'button', {
      type: 'button',
      className: 'kiwisdr-chip',
      text: t('Reconnect'),
      hidden: '',
      onclick: () => {
        if (currentStation && !reconnecting) {
          reconnecting = true;
          void start(currentStation).finally(() => (reconnecting = false));
        }
      },
    });
    const meterBar = el(doc, 'div', { className: 'kiwisdr-meter-bar' });
    const meterText = el(doc, 'span', {
      className: 'kiwisdr-meter-text',
      text: '--',
    });
    const readout = el(doc, 'div', {
      className: 'kiwisdr-readout',
      'aria-hidden': 'true',
    });
    const zoom = el(doc, 'span', {
      className: 'kiwisdr-zoom',
      text: t('Full band'),
    });
    // Buttons zoom around the tuned frequency, so the signal stays on screen.
    const zoomBy = (delta) => {
      if (!session) return;
      const view = session.view;
      const next = Math.min(MAX_ZOOM, Math.max(0, view.zoom + delta));
      session.setZoom(next, session.tuning.freqKhz);
    };
    const volume = el(doc, 'input', {
      type: 'range',
      min: '0',
      max: '100',
      value: '80',
      'aria-label': t('Volume'),
      oninput: (event) => audio?.setVolume(Number(event.target.value) / 100),
    });
    const mute = el(doc, 'button', {
      type: 'button',
      className: 'kiwisdr-chip',
      text: t('Mute'),
      'aria-pressed': 'false',
      onclick: (event) => {
        const next = !(audio?.muted ?? false);
        audio?.setMuted(next);
        event.currentTarget.setAttribute('aria-pressed', String(next));
        ui.miniMute.setAttribute('aria-pressed', String(next));
        ui.miniMute.textContent = next ? '🔇' : '🔊';
      },
    });
    const title = el(doc, 'h2', { className: 'kiwisdr-title' });
    const subtitle = el(doc, 'p', { className: 'kiwisdr-sub' });
    const star = el(doc, 'button', {
      type: 'button',
      className: 'kiwisdr-iconbtn kiwisdr-star',
      'aria-pressed': 'false',
      text: '☆',
      onclick: () => currentStation && store.toggleFavorite(currentStation),
    });
    const minimize = el(doc, 'button', {
      type: 'button',
      className: 'kiwisdr-iconbtn kiwisdr-minimize',
      text: '▾',
      onclick: () => setDocked(!docked),
    });
    const miniReadout = el(doc, 'span', { className: 'kiwisdr-mini-freq' });
    const miniMeter = el(doc, 'span', {
      className: 'kiwisdr-mini-meter',
      text: '--',
    });
    const miniMute = el(doc, 'button', {
      type: 'button',
      className: 'kiwisdr-iconbtn',
      text: '🔊',
      'aria-pressed': 'false',
      'aria-label': t('Mute'),
      onclick: (event) => {
        const next = !(audio?.muted ?? false);
        audio?.setMuted(next);
        event.currentTarget.setAttribute('aria-pressed', String(next));
        event.currentTarget.textContent = next ? '🔇' : '🔊';
        ui.mute.setAttribute('aria-pressed', String(next));
      },
    });
    const close = el(doc, 'button', {
      type: 'button',
      className: 'kiwisdr-close',
      'aria-label': t('Close receiver'),
      text: '×',
      onclick: () => api.close(),
    });
    const diag = el(doc, 'div', { className: 'kiwisdr-diag', hidden: '' });
    const saved = el(doc, 'span', { className: 'kiwisdr-savedlist' });
    const savedEmpty = el(doc, 'span', {
      className: 'kiwisdr-hint',
      text: t('Nothing saved for this receiver yet'),
    });
    const presets = el(
      doc,
      'div',
      {
        className: 'kiwisdr-row',
        role: 'group',
        'aria-label': t('Quick tune'),
      },
      PRESETS.map((p) =>
        el(doc, 'button', {
          type: 'button',
          className: 'kiwisdr-chip',
          text: p.label,
          onclick: () => session?.tune({ freqKhz: p.freqKhz }),
        }),
      ),
    );
    const node = el(
      doc,
      'section',
      {
        id: PANEL_ID,
        className: 'kiwisdr-panel',
        role: 'dialog',
        'aria-label': t('KiwiSDR receiver'),
      },
      [
        el(doc, 'header', { className: 'kiwisdr-head' }, [
          el(doc, 'div', { className: 'kiwisdr-headtext' }, [title, subtitle]),
          el(doc, 'div', { className: 'kiwisdr-mini' }, [
            miniReadout,
            miniMeter,
            miniMute,
          ]),
          el(doc, 'div', { className: 'kiwisdr-headbtns' }, [
            star,
            minimize,
            close,
          ]),
        ]),
        status,
        diag,
        el(doc, 'div', { className: 'kiwisdr-body' }, [
          el(doc, 'div', { className: 'kiwisdr-wf-wrap' }, [
            canvas,
            overlay,
            hover,
          ]),
          axis,
          el(doc, 'div', { className: 'kiwisdr-row kiwisdr-tune' }, [
            readout,
            el(doc, 'label', { className: 'kiwisdr-field' }, [
              el(doc, 'span', { text: 'kHz' }),
              freq,
            ]),
            el(
              doc,
              'div',
              {
                className: 'kiwisdr-row',
                role: 'group',
                'aria-label': t('Mode'),
              },
              [...modes.values()],
            ),
          ]),
          presets,
          el(doc, 'div', { className: 'kiwisdr-row kiwisdr-savedrow' }, [
            el(doc, 'span', { className: 'kiwisdr-label', text: t('Saved') }),
            el(doc, 'button', {
              type: 'button',
              className: 'kiwisdr-chip',
              text: t('＋ Save this'),
              title: t('Save the current frequency and mode for this receiver'),
              onclick: () => {
                if (!currentStation || !session) return;
                const tuning = session.tuning;
                store.addPreset(currentStation.id, {
                  freqKhz: tuning.freqKhz,
                  mode: tuning.mode,
                });
              },
            }),
            saved,
            savedEmpty,
          ]),
          el(doc, 'div', { className: 'kiwisdr-row' }, [
            el(
              doc,
              'div',
              { className: 'kiwisdr-meter', 'aria-hidden': 'true' },
              [meterBar],
            ),
            meterText,
          ]),
          el(doc, 'div', { className: 'kiwisdr-row' }, [
            el(doc, 'span', { className: 'kiwisdr-label', text: t('Zoom') }),
            el(doc, 'button', {
              type: 'button',
              className: 'kiwisdr-chip',
              text: '−',
              'aria-label': t('Zoom out'),
              onclick: () => zoomBy(-1),
            }),
            zoom,
            el(doc, 'button', {
              type: 'button',
              className: 'kiwisdr-chip',
              text: '+',
              'aria-label': t('Zoom in'),
              onclick: () => zoomBy(1),
            }),
            el(doc, 'button', {
              type: 'button',
              className: 'kiwisdr-chip',
              text: '◀',
              'aria-label': t('Tune down one step'),
              onclick: () => nudge(-1),
            }),
            el(doc, 'button', {
              type: 'button',
              className: 'kiwisdr-chip',
              text: '▶',
              'aria-label': t('Tune up one step'),
              onclick: () => nudge(1),
            }),
            el(doc, 'span', { className: 'kiwisdr-label', text: t('Vol') }),
            volume,
            mute,
            reconnect,
          ]),
          el(doc, 'a', {
            className: 'kiwisdr-ext',
            target: '_blank',
            rel: 'noopener noreferrer',
            text: t("Open this receiver's own page"),
          }),
        ]),
      ],
    );
    const ext = node.querySelector('.kiwisdr-ext');
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        api.close();
      }
    });
    ui = {
      title,
      subtitle,
      status,
      canvas,
      overlay,
      axis,
      freq,
      readout,
      modes,
      meterBar,
      meterText,
      zoom,
      reconnect,
      star,
      minimize,
      miniReadout,
      miniMeter,
      hover,
      diag,
      saved,
      savedEmpty,
      ext,
      mute,
      miniMute,
    };
    return node;
  }

  const api = {
    get isOpen() {
      return Boolean(root);
    },
    get stationId() {
      return currentStation?.id ?? null;
    },
    /** Open (or switch to) a receiver. Call from a user gesture so audio may start. */
    open(station) {
      if (currentStation?.id === station.id && root) {
        // Clicking the receiver that is already playing brings it back up.
        setDocked(false);
        return;
      }
      currentStation = station;
      if (!root) {
        root = build();
        doc.body.append(root);
        unsubStore = store.onChange((what) => {
          if (what === 'favorites') renderStar();
          else renderSaved();
        });
      }
      docked = false;
      ui.ext.setAttribute('href', station.origin);
      renderDock();
      renderStar();
      renderSaved();
      const style = stationStyle(station);
      ui.title.textContent = station.name;
      const bits = [
        station.loc,
        station.antenna &&
          t('Antenna: {antenna}', { antenna: station.antenna }),
        t('{users}/{max} users', {
          users: station.users,
          max: station.usersMax,
        }),
        station.hardware,
      ].filter(Boolean);
      ui.subtitle.textContent = bits.join(' · ');
      root.dataset.load = style.bucket;
      void start(station);
      ui.freq.focus({ preventScroll: true });
    },
    close() {
      generation++;
      unsubStore?.();
      unsubStore = null;
      docked = false;
      teardownSession();
      void audio?.close();
      audio = null;
      root?.remove();
      root = null;
      ui = null;
      currentStation = null;
      onClose();
    },
    destroy() {
      api.close();
    },
  };
  return api;
}
