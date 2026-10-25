/**
 * HUD audio spectrum visualizer, mounted below the REC readout in the HUD's
 * upper-right corner. It is source-agnostic: any audio source can drive it by
 * providing
 *
 *   subscribe(listener) -> unsubscribe
 *     listener receives {mode, label, notice}; mode is 'hidden', 'acquiring',
 *     'live' (analyser readable) or 'opaque' (audible but not readable).
 *   getAnalyser() -> AnalyserNode | null
 *
 * Drawing runs only while the source is shown and the HUD is visible.
 * The Radio adapter is src/ui/radioAudioSource.js.
 */

const BAND_COUNT = 48;
const MIN_HZ = 40;
const MAX_HZ = 16000;
// Matches the 330px Context panel less the frame padding and borders.
const CANVAS_WIDTH = 312;
const CANVAS_HEIGHT = 64;
const COLOR_REFRESH_MS = 500;
const FREQUENCY_TICKS = Object.freeze([
  ['60', 60],
  ['250', 250],
  ['1K', 1000],
  ['4K', 4000],
  ['16K', 16000],
]);

/** Fraction (0–1) across the log-frequency axis for `hz`. */
export function frequencyPosition(hz) {
  const clamped = Math.min(MAX_HZ, Math.max(MIN_HZ, hz));
  return Math.log(clamped / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ);
}

/**
 * Average analyser bins into `bandCount` log-spaced bands, each 0–1.
 * @param {Uint8Array} bins Byte frequency data.
 * @param {number} sampleRate
 * @param {number} [bandCount]
 * @returns {number[]}
 */
export function frequencyBands(bins, sampleRate, bandCount = BAND_COUNT) {
  const nyquist = sampleRate / 2;
  const binHz = nyquist / bins.length;
  const bands = [];
  for (let band = 0; band < bandCount; band += 1) {
    const lowHz = MIN_HZ * (MAX_HZ / MIN_HZ) ** (band / bandCount);
    const highHz = MIN_HZ * (MAX_HZ / MIN_HZ) ** ((band + 1) / bandCount);
    const first = Math.min(bins.length - 1, Math.floor(lowHz / binHz));
    const last = Math.min(
      bins.length - 1,
      Math.max(first, Math.ceil(highHz / binHz) - 1),
    );
    let sum = 0;
    for (let bin = first; bin <= last; bin += 1) sum += bins[bin];
    bands.push(sum / (last - first + 1) / 255);
  }
  return bands;
}

/**
 * RMS level of byte time-domain samples, in dBFS (−∞ for silence).
 * @param {Uint8Array} samples
 * @returns {number}
 */
export function rmsDecibels(samples) {
  if (!samples.length) return -Infinity;
  let sum = 0;
  for (const sample of samples) {
    const value = (sample - 128) / 128;
    sum += value * value;
  }
  const rms = Math.sqrt(sum / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

export const AUDIO_VISUALIZER_MODES = Object.freeze([
  'hidden',
  'acquiring',
  'live',
  'opaque',
]);

const STATUS_TEXT = Object.freeze({
  acquiring: 'ACQUIRING',
  live: 'LIVE',
  opaque: 'NO SIGNAL',
});
const DEFAULT_NOTICE = 'SPECTRUM UNAVAILABLE';

function withAlpha(color, alpha) {
  const match = /rgba?\(([^)]+)\)/.exec(color || '');
  if (match) {
    const [r, g, b] = match[1].split(',').map((part) => part.trim());
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((color || '').trim());
  if (hex) {
    const digits =
      hex[1].length === 3
        ? [...hex[1]].map((digit) => digit + digit).join('')
        : hex[1];
    const value = Number.parseInt(digits, 16);
    return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
  }
  return `rgba(0, 255, 255, ${alpha})`;
}

/**
 * Mount the visualizer in `host` and follow an audio source.
 * @param {object} options
 * @param {{subscribe: Function, getAnalyser: Function}} options.source
 * @param {HTMLElement|null} options.host
 * @param {() => boolean} [options.isActive] Whether the HUD is visible.
 * @returns {{destroy: () => void}}
 */
export function createAudioVisualizer({
  source,
  host,
  isActive = () => true,
  documentRef = globalThis.document,
  windowRef = globalThis.window,
} = {}) {
  if (!host || !source?.subscribe || !documentRef) return { destroy() {} };

  const root = documentRef.createElement('div');
  root.className = 'hud-audio-viz';
  root.hidden = true;
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="hud-audio-viz__head">
      <span class="hud-audio-viz__tag">AUDIO SPECTRUM</span>
      <span class="hud-audio-viz__label"></span>
      <span class="hud-audio-viz__status"></span>
      <span class="hud-audio-viz__level">−∞ dB</span>
    </div>
    <div class="hud-audio-viz__frame">
      <canvas class="hud-audio-viz__canvas"></canvas>
      <span class="hud-audio-viz__notice"></span>
    </div>`;
  const status = root.querySelector('.hud-audio-viz__status');
  const label = root.querySelector('.hud-audio-viz__label');
  const notice = root.querySelector('.hud-audio-viz__notice');
  const level = root.querySelector('.hud-audio-viz__level');
  const canvas = root.querySelector('.hud-audio-viz__canvas');
  host.appendChild(root);

  const context = canvas.getContext?.('2d') ?? null;
  const pixelRatio = Math.min(2, windowRef?.devicePixelRatio || 1);
  canvas.width = Math.round(CANVAS_WIDTH * pixelRatio);
  canvas.height = Math.round(CANVAS_HEIGHT * pixelRatio);
  context?.scale(pixelRatio, pixelRatio);

  let mode = 'hidden';
  let frame = 0;
  let destroyed = false;
  let bins = null;
  let samples = null;
  const smoothed = new Array(BAND_COUNT).fill(0);
  const peaks = new Array(BAND_COUNT).fill(0);
  let colors = null;
  let colorsReadAt = 0;
  let lastLevelText = '';

  function readColors(now) {
    if (colors && now - colorsReadAt < COLOR_REFRESH_MS) return colors;
    const style = windowRef?.getComputedStyle?.(root);
    const primary =
      style?.getPropertyValue('--hud-color').trim() || 'rgba(0, 255, 255, 0.6)';
    const secondary =
      style?.getPropertyValue('--secondary-accent').trim() || '#ffd38a';
    colors = { primary, secondary };
    colorsReadAt = now;
    return colors;
  }

  function drawGrid(ctx, palette) {
    ctx.strokeStyle = withAlpha(palette.primary, 0.12);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let row = 1; row < 4; row += 1) {
      const y = Math.round((CANVAS_HEIGHT * row) / 4) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(CANVAS_WIDTH, y);
    }
    for (const [, hz] of FREQUENCY_TICKS) {
      const x = Math.round(frequencyPosition(hz) * CANVAS_WIDTH) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CANVAS_HEIGHT);
    }
    ctx.stroke();
    ctx.fillStyle = withAlpha(palette.primary, 0.45);
    ctx.font = '7px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    for (const [text, hz] of FREQUENCY_TICKS) {
      const x = Math.round(frequencyPosition(hz) * CANVAS_WIDTH) + 2;
      if (x + 14 < CANVAS_WIDTH) ctx.fillText(text, x, 1);
    }
  }

  function drawSweep(ctx, palette, now) {
    const x = ((now / 2400) % 1) * CANVAS_WIDTH;
    const gradient = ctx.createLinearGradient(x - 36, 0, x, 0);
    gradient.addColorStop(0, withAlpha(palette.primary, 0));
    gradient.addColorStop(1, withAlpha(palette.primary, 0.16));
    ctx.fillStyle = gradient;
    ctx.fillRect(x - 36, 0, 36, CANVAS_HEIGHT);
  }

  function drawBars(ctx, palette, bands) {
    const slot = CANVAS_WIDTH / BAND_COUNT;
    const barWidth = Math.max(2, slot - 2);
    const gradient = ctx.createLinearGradient(0, CANVAS_HEIGHT, 0, 0);
    gradient.addColorStop(0, withAlpha(palette.primary, 0.25));
    gradient.addColorStop(0.65, withAlpha(palette.primary, 0.85));
    gradient.addColorStop(1, withAlpha(palette.secondary, 0.95));
    ctx.fillStyle = gradient;
    for (let band = 0; band < BAND_COUNT; band += 1) {
      smoothed[band] = Math.max(bands[band], smoothed[band] * 0.86);
      peaks[band] = Math.max(smoothed[band], peaks[band] - 0.008);
      const height = smoothed[band] * (CANVAS_HEIGHT - 4);
      const x = band * slot + 1;
      // Segmented, LED-style cells.
      for (let y = CANVAS_HEIGHT; y > CANVAS_HEIGHT - height; y -= 4) {
        ctx.fillRect(x, y - 3, barWidth, 3);
      }
    }
    ctx.fillStyle = withAlpha(palette.secondary, 0.95);
    ctx.shadowColor = palette.secondary;
    ctx.shadowBlur = 6;
    for (let band = 0; band < BAND_COUNT; band += 1) {
      if (peaks[band] < 0.02) continue;
      const y = CANVAS_HEIGHT - peaks[band] * (CANVAS_HEIGHT - 4) - 2;
      ctx.fillRect(band * slot + 1, y, barWidth, 1.5);
    }
    ctx.shadowBlur = 0;
  }

  function drawWaveform(ctx, palette, waveform) {
    ctx.strokeStyle = withAlpha(palette.secondary, 0.75);
    ctx.lineWidth = 1.2;
    ctx.shadowColor = palette.secondary;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    const middle = CANVAS_HEIGHT * 0.32;
    const step = waveform.length / CANVAS_WIDTH;
    for (let x = 0; x <= CANVAS_WIDTH; x += 2) {
      const sample =
        waveform[Math.min(waveform.length - 1, Math.floor(x * step))];
      const y = middle + ((sample - 128) / 128) * CANVAS_HEIGHT * 0.28;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function drawFlatline(ctx, palette, now) {
    ctx.strokeStyle = withAlpha(palette.primary, 0.45);
    ctx.setLineDash([3, 4]);
    ctx.lineDashOffset = -(now / 60) % 7;
    ctx.beginPath();
    ctx.moveTo(0, CANVAS_HEIGHT / 2 + 0.5);
    ctx.lineTo(CANVAS_WIDTH, CANVAS_HEIGHT / 2 + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function setLevel(text) {
    if (text === lastLevelText) return;
    lastLevelText = text;
    level.textContent = text;
  }

  function render(now) {
    frame = 0;
    if (destroyed || mode === 'hidden') return;
    frame = windowRef.requestAnimationFrame(render);
    if (!context || !isActive()) return;
    const palette = readColors(now);
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    drawGrid(context, palette);
    drawSweep(context, palette, now);

    const analyser = mode === 'live' ? source.getAnalyser?.() : null;
    if (!analyser) {
      smoothed.fill(0);
      peaks.fill(0);
      drawFlatline(context, palette, now);
      setLevel('−∞ dB');
      return;
    }
    if (bins?.length !== analyser.frequencyBinCount) {
      bins = new Uint8Array(analyser.frequencyBinCount);
      samples = new Uint8Array(analyser.fftSize);
    }
    analyser.getByteFrequencyData(bins);
    analyser.getByteTimeDomainData(samples);
    const sampleRate = analyser.context?.sampleRate || 48000;
    drawBars(context, palette, frequencyBands(bins, sampleRate));
    drawWaveform(context, palette, samples);
    const decibels = rmsDecibels(samples);
    setLevel(Number.isFinite(decibels) ? `${decibels.toFixed(1)} dB` : '−∞ dB');
  }

  function onState(state) {
    if (destroyed) return;
    const nextMode = AUDIO_VISUALIZER_MODES.includes(state?.mode)
      ? state.mode
      : 'hidden';
    label.textContent = state?.label || '';
    notice.textContent = state?.notice || DEFAULT_NOTICE;
    status.textContent = STATUS_TEXT[nextMode] || '';
    root.dataset.mode = nextMode;
    root.hidden = nextMode === 'hidden';
    mode = nextMode;
    if (mode !== 'hidden' && !frame && windowRef?.requestAnimationFrame) {
      frame = windowRef.requestAnimationFrame(render);
    }
  }

  const unsubscribe = source.subscribe(onState);

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (frame) windowRef?.cancelAnimationFrame?.(frame);
      frame = 0;
      if (typeof unsubscribe === 'function') unsubscribe();
      root.remove();
    },
  };
}
