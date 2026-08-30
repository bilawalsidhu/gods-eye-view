import { RTL2832U_Provider } from '@jtarrio/webrtlsdr/rtlsdr.js';
import { findDirectionalFmPeak } from './spectrum.js';

const FM_MIN_HZ = 87_500_000;
const FM_MAX_HZ = 108_000_000;
const READ_SAMPLE_COUNT = 32_768;

/** Receiver presets kept in lockstep with the proven OpenSignal configuration. */
export const SDR_RECEIVER_PRESETS = Object.freeze({
  fm: Object.freeze({
    frequencyHz: 98_500_000,
    sampleRate: 2_048_000,
    ppm: 0,
    gain: null,
    rtlAgc: false,
  }),
  adsb: Object.freeze({
    frequencyHz: 1_090_000_000,
    sampleRate: 2_000_000,
    ppm: 0,
    gain: null,
    rtlAgc: false,
  }),
});

const FM_DEFAULT_HZ = SDR_RECEIVER_PRESETS.fm.frequencyHz;
const FM_SAMPLE_RATE = SDR_RECEIVER_PRESETS.fm.sampleRate;
const ADSB_FREQUENCY_HZ = SDR_RECEIVER_PRESETS.adsb.frequencyHz;
const ADSB_SAMPLE_RATE = SDR_RECEIVER_PRESETS.adsb.sampleRate;

function filterMatchesDevice(filter, device) {
  return (filter.vendorId === undefined || filter.vendorId === device.vendorId)
    && (filter.productId === undefined || filter.productId === device.productId)
    && (filter.serialNumber === undefined || filter.serialNumber === device.serialNumber);
}

/** Reuses an origin-authorized receiver before asking WebUSB to show its picker. */
export function createRememberingWebUsb(webUsb) {
  if (!webUsb?.getDevices || !webUsb?.requestDevice) return webUsb;
  return new Proxy(webUsb, {
    get(target, property) {
      if (property === 'requestDevice') {
        return async (options = {}) => {
          const filters = Array.isArray(options.filters) ? options.filters : [];
          const authorizedDevices = await target.getDevices();
          const rememberedDevice = authorizedDevices.find((device) => (
            filters.length === 0 || filters.some((filter) => filterMatchesDevice(filter, device))
          ));
          return rememberedDevice || target.requestDevice(options);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function setRtlAgc(device, enabled) {
  const method = device?._enableRtlAgc;
  if (typeof method === 'function') await method.call(device, enabled);
}

function publicAircraft(aircraft) {
  return Array.isArray(aircraft) ? aircraft.map((entry) => ({ ...entry })) : [];
}

function clampFmFrequency(value) {
  return Math.max(FM_MIN_HZ, Math.min(FM_MAX_HZ, Math.round(Number(value) / 100_000) * 100_000));
}

function describeConnectionError(error) {
  const message = String(error?.message || error || '').trim();
  if (/No device was selected|NotFoundError/i.test(message)) return 'No RTL-SDR device selected';
  if (/does not support the WebUSB|usb/i.test(message) && /support/i.test(message)) {
    return 'WebUSB requires desktop Chrome or Edge on localhost/HTTPS';
  }
  if (/access|permission|claim|busy/i.test(message)) {
    return 'RTL-SDR access failed; close other SDR apps and check USB permissions';
  }
  return message || 'RTL-SDR connection failed';
}

/** Browser-local RTL-SDR session shared by the FM controls and ADS-B globe layer. */
export class SdrController {
  constructor({
    providerFactory = () => new RTL2832U_Provider({
      webusb: createRememberingWebUsb(navigator.usb),
    }),
  } = {}) {
    const webUsbSupported = typeof navigator !== 'undefined' && Boolean(navigator.usb);
    this.state = {
      webUsbSupported,
      connected: false,
      status: webUsbSupported ? 'idle' : 'unsupported',
      message: webUsbSupported
        ? 'Connect a USB RTL-SDR in desktop Chrome or Edge'
        : 'WebUSB is unavailable in this browser',
      mode: 'fm',
      frequencyHz: FM_DEFAULT_HZ,
      sampleRate: FM_SAMPLE_RATE,
      volume: 0.8,
      seeking: false,
      seekMessage: '',
      snr: null,
      aircraft: [],
      decodedMessages: 0,
      receiverLocation: null,
      locationStatus: 'unknown',
      audioState: 'idle',
      samplesPerSecond: 0,
      workerBlocks: 0,
      iqLevelDbfs: null,
      audioLevelDbfs: null,
    };
    this._listeners = new Set();
    this._provider = null;
    this._device = null;
    this._worker = null;
    this._audioContext = null;
    this._audioNode = null;
    this._usbTail = Promise.resolve();
    this._readGeneration = 0;
    this._fmFrequencyHz = FM_DEFAULT_HZ;
    this._spectrum = null;
    this._spectrumSequence = 0;
    this._spectrumWaiters = new Set();
    this._seekToken = 0;
    this._providerFactory = providerFactory;
    this._sampleWindowStartedAt = 0;
    this._sampleWindowSamples = 0;
  }

  getState() {
    return { ...this.state, aircraft: publicAircraft(this.state.aircraft) };
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    listener(this.getState());
    return () => this._listeners.delete(listener);
  }

  _setState(patch) {
    Object.assign(this.state, patch);
    const snapshot = this.getState();
    for (const listener of this._listeners) {
      try { listener(snapshot); } catch (error) {
        console.warn('[SDR] State listener failed:', error);
      }
    }
  }

  _queueUsb(operation) {
    const queued = this._usbTail.then(operation, operation);
    this._usbTail = queued.catch(() => {});
    return queued;
  }

  _ensureWorker() {
    if (this._worker) return this._worker;
    this._worker = new Worker(new URL('./sdr.worker.js', import.meta.url), { type: 'module' });
    this._worker.onmessage = (event) => this._handleWorkerMessage(event.data || {});
    this._worker.onerror = (event) => {
      console.warn('[SDR] Decoder worker error:', event.message || event);
      this._setState({ status: 'error', message: 'SDR decoder worker failed' });
    };
    return this._worker;
  }

  _configureWorker() {
    this._ensureWorker().postMessage({
      type: 'configure',
      mode: this.state.mode,
      sampleRate: this.state.sampleRate,
      location: this.state.receiverLocation,
    });
  }

  async _ensureAudio() {
    if (typeof AudioContext === 'undefined') return false;
    if (!this._audioContext) {
      this._audioContext = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' });
      this._audioContext.onstatechange = () => {
        this._setState({ audioState: this._audioContext?.state || 'closed' });
      };
    }
    if (!this._audioNode) {
      await this._audioContext.audioWorklet.addModule(new URL('./sdrAudioWorklet.js', import.meta.url));
      this._audioNode = new AudioWorkletNode(this._audioContext, 'gev-sdr-audio-player', {
        outputChannelCount: [1],
      });
      this._audioNode.connect(this._audioContext.destination);
      this._audioNode.port.postMessage({ type: 'volume', value: this.state.volume });
    }
    if (this._audioContext.state !== 'running') await this._audioContext.resume();
    const audioState = this._audioContext.state;
    this._setState({ audioState });
    return audioState === 'running';
  }

  _handleWorkerMessage(message) {
    const diagnostics = message.diagnostics;
    if (diagnostics && Number.isFinite(diagnostics.workerBlocks)) {
      this._setState({
        workerBlocks: diagnostics.workerBlocks,
        iqLevelDbfs: Number.isFinite(diagnostics.iqLevelDbfs)
          ? diagnostics.iqLevelDbfs
          : this.state.iqLevelDbfs,
        audioLevelDbfs: Number.isFinite(diagnostics.audioLevelDbfs)
          ? diagnostics.audioLevelDbfs
          : this.state.audioLevelDbfs,
      });
    }
    if (message.type === 'fm') {
      if (message.samples instanceof Float32Array && this._audioNode && !this.state.seeking) {
        this._audioNode.port.postMessage({ type: 'samples', samples: message.samples }, [message.samples.buffer]);
      }
      if (message.bins instanceof Float32Array) {
        this._spectrum = message.bins;
        this._spectrumSequence += 1;
        for (const waiter of this._spectrumWaiters) waiter(this._spectrumSequence);
        this._spectrumWaiters.clear();
      }
      if (Number.isFinite(message.snr)) this._setState({ snr: message.snr });
      return;
    }
    if (message.type === 'adsb') {
      this._setState({
        aircraft: publicAircraft(message.aircraft),
        decodedMessages: this.state.decodedMessages + (Number(message.decodedCount) || 0),
      });
    }
  }

  async _configureDevice(mode, frequencyHz) {
    const preset = mode === 'adsb' ? SDR_RECEIVER_PRESETS.adsb : SDR_RECEIVER_PRESETS.fm;
    const sampleRate = preset.sampleRate;
    const tunedFrequency = mode === 'adsb' ? preset.frequencyHz : clampFmFrequency(frequencyHz);
    await this._queueUsb(async () => {
      const actualRate = await this._device.setSampleRate(sampleRate);
      await this._device.setFrequencyCorrection(preset.ppm);
      const actualFrequency = await this._device.setCenterFrequency(tunedFrequency);
      await this._device.setGain(preset.gain);
      await setRtlAgc(this._device, preset.rtlAgc);
      await this._device.resetBuffer();
      this._setState({
        sampleRate: Number.isFinite(actualRate) ? actualRate : sampleRate,
        frequencyHz: Number.isFinite(actualFrequency) ? actualFrequency : tunedFrequency,
      });
    });
    this._configureWorker();
    this._audioNode?.port.postMessage({ type: 'clear' });
  }

  async connect(mode = this.state.mode) {
    if (!this.state.webUsbSupported) {
      this._setState({ status: 'unsupported', message: 'WebUSB requires desktop Chrome or Edge' });
      return false;
    }
    if (this._device) return this.setMode(mode);
    this._setState({ status: 'connecting', message: 'Waiting for an RTL-SDR device…' });
    try {
      const nextMode = mode === 'adsb' ? 'adsb' : 'fm';
      this._setState({ mode: nextMode });
      // Resume audio completely before opening the USB chooser. A context that
      // has only been constructed can still be suspended after the chooser
      // consumes the click activation.
      if (nextMode === 'fm' && !await this._ensureAudio()) {
        throw new Error('Browser audio is suspended; press Connect again to resume it');
      }
      this._provider = this._providerFactory();
      this._device = await this._provider.get();
      await this._configureDevice(this.state.mode, this._fmFrequencyHz);
      this._readGeneration += 1;
      this._sampleWindowStartedAt = Date.now();
      this._sampleWindowSamples = 0;
      this._setState({
        connected: true,
        status: 'streaming',
        message: this.state.mode === 'adsb' ? 'Receiving 1090 MHz ADS-B' : 'Receiving broadcast FM',
        workerBlocks: 0,
        iqLevelDbfs: null,
        audioLevelDbfs: null,
      });
      void this._readLoop(this._readGeneration);
      return true;
    } catch (error) {
      console.warn('[SDR] Connection failed:', error);
      try { await this._device?.close(); } catch { /* best-effort failed-open cleanup */ }
      this._device = null;
      this._provider = null;
      this._setState({ connected: false, status: 'error', message: describeConnectionError(error) });
      return false;
    }
  }

  async _readLoop(generation) {
    while (this._device && generation === this._readGeneration) {
      try {
        const block = await this._queueUsb(() => this._device.readSamples(READ_SAMPLE_COUNT));
        if (!this._device || generation !== this._readGeneration) break;
        const buffer = block.data;
        this._sampleWindowSamples += buffer.byteLength / 2;
        const now = Date.now();
        const elapsed = now - this._sampleWindowStartedAt;
        if (elapsed >= 1_000) {
          this._setState({
            samplesPerSecond: Math.round((this._sampleWindowSamples * 1_000) / elapsed),
          });
          this._sampleWindowStartedAt = now;
          this._sampleWindowSamples = 0;
        }
        this._ensureWorker().postMessage({ type: 'samples', buffer }, [buffer]);
      } catch (error) {
        if (generation !== this._readGeneration) break;
        console.warn('[SDR] Sample read failed:', error);
        this._setState({ connected: false, status: 'error', message: 'RTL-SDR sample stream stopped' });
        await this.stop({ preserveMessage: true });
        break;
      }
    }
  }

  async setMode(mode) {
    const nextMode = mode === 'adsb' ? 'adsb' : 'fm';
    this.cancelSeek();
    if (!this._device) {
      this._setState({
        mode: nextMode,
        frequencyHz: nextMode === 'adsb' ? ADSB_FREQUENCY_HZ : this._fmFrequencyHz,
        sampleRate: nextMode === 'adsb' ? ADSB_SAMPLE_RATE : FM_SAMPLE_RATE,
      });
      return true;
    }
    this._setState({ status: 'tuning', mode: nextMode, message: `Switching to ${nextMode === 'adsb' ? 'ADS-B' : 'FM'}…` });
    try {
      if (nextMode === 'fm' && !await this._ensureAudio()) {
        throw new Error('Browser audio is suspended; select FM again to resume it');
      }
      await this._configureDevice(nextMode, this._fmFrequencyHz);
      this._setState({
        status: 'streaming',
        message: nextMode === 'adsb' ? 'Receiving 1090 MHz ADS-B' : 'Receiving broadcast FM',
        snr: null,
        workerBlocks: 0,
        iqLevelDbfs: null,
        audioLevelDbfs: null,
      });
      return true;
    } catch (error) {
      console.warn('[SDR] Mode switch failed:', error);
      this._setState({ status: 'error', message: describeConnectionError(error) });
      return false;
    }
  }

  async tuneFm(frequencyHz, { quiet = false } = {}) {
    const frequency = clampFmFrequency(frequencyHz);
    this._fmFrequencyHz = frequency;
    if (!this._device) {
      this._setState({ mode: 'fm', frequencyHz: frequency, sampleRate: FM_SAMPLE_RATE });
      return true;
    }
    if (this.state.mode !== 'fm') await this.setMode('fm');
    try {
      let actualFrequency = frequency;
      await this._queueUsb(async () => {
        const tuned = await this._device.setCenterFrequency(frequency);
        if (Number.isFinite(tuned)) actualFrequency = tuned;
        await this._device.resetBuffer();
      });
      this._worker?.postMessage({ type: 'reset' });
      this._audioNode?.port.postMessage({ type: 'clear' });
      this._setState({
        frequencyHz: actualFrequency,
        status: 'streaming',
        ...(quiet ? {} : { message: `Tuned to ${(frequency / 1_000_000).toFixed(1)} MHz FM` }),
      });
      return true;
    } catch (error) {
      this._setState({ status: 'error', message: describeConnectionError(error) });
      return false;
    }
  }

  _waitForSpectrum(afterSequence, timeoutMs = 900) {
    if (this._spectrumSequence > afterSequence) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (result) => {
        clearTimeout(timer);
        this._spectrumWaiters.delete(waiter);
        resolve(result);
      };
      const waiter = (sequence) => finish(sequence > afterSequence);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this._spectrumWaiters.add(waiter);
    });
  }

  async seekFm(direction = 1) {
    if (!this._device || this.state.mode !== 'fm' || this.state.seeking) return null;
    const seekDirection = direction < 0 ? -1 : 1;
    const origin = this.state.frequencyHz;
    const token = ++this._seekToken;
    this._setState({ seeking: true, seekMessage: `Seeking ${seekDirection > 0 ? 'up' : 'down'}…` });
    this._audioNode?.port.postMessage({ type: 'volume', value: 0 });
    try {
      for (let scan = 0; scan < 18 && token === this._seekToken; scan += 1) {
        const span = FM_MAX_HZ - FM_MIN_HZ;
        const rawCenter = origin + (seekDirection * scan * 1_200_000);
        const center = FM_MIN_HZ + positiveModulo(rawCenter - FM_MIN_HZ, span);
        const sequence = this._spectrumSequence;
        await this.tuneFm(center, { quiet: true });
        this._setState({ seekMessage: `Scanning ${(center / 1_000_000).toFixed(1)} MHz…` });
        if (!await this._waitForSpectrum(sequence) || token !== this._seekToken) continue;
        const peak = findDirectionalFmPeak(
          this._spectrum,
          this.state.frequencyHz,
          this.state.sampleRate,
          seekDirection,
          origin,
        );
        if (!peak) continue;
        await this.tuneFm(peak.frequency, { quiet: true });
        this._setState({
          seeking: false,
          seekMessage: `Found ${(peak.frequency / 1_000_000).toFixed(1)} MHz · ${peak.snr.toFixed(1)} dB`,
          message: `FM signal found at ${(peak.frequency / 1_000_000).toFixed(1)} MHz`,
        });
        return peak;
      }
      if (token === this._seekToken) {
        await this.tuneFm(origin, { quiet: true });
        this._setState({ seeking: false, seekMessage: 'No FM signal found' });
      }
      return null;
    } finally {
      if (token === this._seekToken) {
        this._audioNode?.port.postMessage({ type: 'volume', value: this.state.volume });
      }
    }
  }

  cancelSeek() {
    this._seekToken += 1;
    if (!this.state.seeking) return false;
    this._setState({ seeking: false, seekMessage: 'Seek stopped' });
    this._audioNode?.port.postMessage({ type: 'volume', value: this.state.volume });
    return true;
  }

  setVolume(value) {
    const volume = Math.max(0, Math.min(1, Number(value) || 0));
    this._setState({ volume });
    if (!this.state.seeking) this._audioNode?.port.postMessage({ type: 'volume', value: volume });
    return volume;
  }

  async requestReceiverLocation() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      this._setState({ locationStatus: 'unavailable', message: 'Browser location is unavailable' });
      return false;
    }
    this._setState({ locationStatus: 'requesting' });
    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: false,
          timeout: 10_000,
          maximumAge: 300_000,
        });
      });
      const receiverLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };
      this._setState({ receiverLocation, locationStatus: 'ready' });
      this._worker?.postMessage({ type: 'location', location: receiverLocation });
      return true;
    } catch (error) {
      console.warn('[SDR] Receiver location failed:', error);
      this._setState({ locationStatus: 'denied', message: 'Receiver location was not granted' });
      return false;
    }
  }

  async stop({ preserveMessage = false } = {}) {
    this.cancelSeek();
    this._readGeneration += 1;
    const device = this._device;
    this._device = null;
    this._provider = null;
    this._audioNode?.port.postMessage({ type: 'clear' });
    if (device) {
      try { await this._queueUsb(() => device.close()); } catch (error) {
        console.warn('[SDR] Device close failed:', error);
      }
    }
    this._setState({
      connected: false,
      status: preserveMessage ? this.state.status : (this.state.webUsbSupported ? 'idle' : 'unsupported'),
      ...(preserveMessage ? {} : { message: 'RTL-SDR disconnected' }),
      snr: null,
      samplesPerSecond: 0,
      workerBlocks: 0,
      iqLevelDbfs: null,
      audioLevelDbfs: null,
    });
    return true;
  }

  async destroy() {
    await this.stop();
    this._worker?.terminate();
    this._worker = null;
    await this._audioContext?.close();
    this._audioContext = null;
    this._audioNode = null;
    this.state.audioState = 'closed';
    this._listeners.clear();
  }
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

export const SDR_FM_BAND = Object.freeze({ minHz: FM_MIN_HZ, maxHz: FM_MAX_HZ });
export const SDR_ADSB_FREQUENCY_HZ = ADSB_FREQUENCY_HZ;

const sdrController = new SdrController();
export default sdrController;
