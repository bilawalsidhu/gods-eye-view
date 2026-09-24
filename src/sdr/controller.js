import { RTL2832U_Provider } from '@jtarrio/webrtlsdr/rtlsdr.js';
import { findDirectionalFmPeak } from './spectrum.js';
import {
  SDR_GAIN_DEFAULTS,
  normalizeSdrGain,
  readSdrGainSettings,
  tunerGainValue,
  writeSdrGainSettings,
} from './gain.js';
import {
  RTL_SDR_USB_FILTERS,
  createRememberingWebUsb,
  createSdrDeviceMemory,
  sameSdrDevice,
  sdrDeviceIdentity,
  sdrDeviceLabel,
  selectAuthorizedSdrDevice,
} from './usbDevices.js';
import { summarizeLocalAdsb } from '../sources/adsbRecords.js';

export { createRememberingWebUsb } from './usbDevices.js';

const FM_MIN_HZ = 87_500_000;
const FM_MAX_HZ = 108_000_000;
const READ_SAMPLE_COUNT = 32_768;
const RATE_WINDOW_MS = 1_000;
// A bulk read that has not completed in this long is treated as a stalled
// USB transfer: the session is torn down instead of waiting forever.
export const SDR_READ_STALL_MS = 5_000;
// Upper bound on a graceful close queued behind other USB work; past it the
// raw USB device is closed directly, which aborts any pending transfer. The
// raw close is bounded by the same deadline, so a teardown settles within
// twice this even when `USBDevice.close()` itself never settles.
export const SDR_CLOSE_TIMEOUT_MS = 2_000;

/** Tuning presets per receiver mode; gain is a separate per-mode setting. */
export const SDR_RECEIVER_PRESETS = Object.freeze({
  fm: Object.freeze({
    frequencyHz: 98_500_000,
    sampleRate: 2_048_000,
    ppm: 0,
    rtlAgc: false,
  }),
  adsb: Object.freeze({
    frequencyHz: 1_090_000_000,
    sampleRate: 2_000_000,
    ppm: 0,
    rtlAgc: false,
  }),
});

const FM_DEFAULT_HZ = SDR_RECEIVER_PRESETS.fm.frequencyHz;
const FM_SAMPLE_RATE = SDR_RECEIVER_PRESETS.fm.sampleRate;
const ADSB_FREQUENCY_HZ = SDR_RECEIVER_PRESETS.adsb.frequencyHz;
const ADSB_SAMPLE_RATE = SDR_RECEIVER_PRESETS.adsb.sampleRate;

function normalizeMode(mode) {
  return mode === 'adsb' ? 'adsb' : 'fm';
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

async function setRtlAgc(device, enabled) {
  const method = device?._enableRtlAgc;
  if (typeof method === 'function') await method.call(device, enabled);
}

// Guarded stand-in -> the WebUSB `USBDevice` it forwards to. Ownership checks
// compare real devices, never the per-acquisition stand-ins.
const GUARDED_USB_DEVICES = new WeakMap();

/** The real WebUSB `USBDevice` behind a guarded stand-in (or itself). */
function unwrapUsb(usbDevice) {
  return (usbDevice && GUARDED_USB_DEVICES.get(usbDevice)) || usbDevice;
}

/** The WebUSB `USBDevice` under an opened RTL2832U, when reachable. */
function rawUsbDevice(device, provider) {
  return unwrapUsb(device?.com?.device || provider?.device || null);
}

/** Close a raw USB device, ignoring an already-closed or vanished one. */
async function forceCloseUsb(usbDevice) {
  if (!usbDevice || typeof usbDevice.close !== 'function') return;
  try {
    await usbDevice.close();
  } catch {
    /* already closed or unplugged */
  }
}

function closedUsbError() {
  return Promise.reject(new Error('RTL-SDR session was closed'));
}

/**
 * A stand-in for `usbDevice` whose methods reject once `isFenced()` holds,
 * so an abandoned acquisition that is still running can never open, claim,
 * write to or close the device a newer session has opened since (WebUSB
 * hands every opener the same `USBDevice`).
 */
function guardUsbDevice(usbDevice, isFenced) {
  const guarded = new Proxy(usbDevice, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args) =>
        isFenced() ? closedUsbError() : value.apply(target, args);
    },
  });
  GUARDED_USB_DEVICES.set(guarded, usbDevice);
  return guarded;
}

/**
 * Wrap a WebUSB entry point for one acquisition: every `USBDevice` it hands
 * out is reported to `onDevice` and handed on guarded by `isFenced`. The
 * RTL-SDR provider opens and initializes the device inside `get()`, so this
 * is the only way to reach a device whose initialization failed before
 * `get()` returned it, and the only way to stop a selection that resolves
 * after the acquisition was abandoned from initializing that device.
 */
function captureRequestedUsb(webUsb, { onDevice, isFenced }) {
  if (!webUsb || typeof webUsb.requestDevice !== 'function') return webUsb;
  return new Proxy(webUsb, {
    get(target, property) {
      if (property === 'requestDevice') {
        return async (...args) => {
          const usbDevice = await target.requestDevice(...args);
          if (!usbDevice) return usbDevice;
          // A late selection belongs to no session: the device it names may
          // already be open for a newer one.
          if (isFenced())
            throw new Error('RTL-SDR device selection was abandoned');
          onDevice(usbDevice);
          return guardUsbDevice(usbDevice, isFenced);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Stand-in for the WebUSB device of an abandoned session: every method
 * rejects, so nothing still running for that session reaches the hardware.
 */
const CLOSED_USB_DEVICE = new Proxy(
  {},
  {
    get: (_target, property) =>
      property === 'then' ? undefined : closedUsbError,
  },
);

/**
 * Detach an abandoned RTL2832U from its WebUSB device. WebUSB hands a later
 * session the SAME `USBDevice` object, so a graceful close (or any other
 * transfer) of the old session that resumes after we gave up on it would
 * otherwise act on the new session's open device.
 */
function fenceDevice(device) {
  const com = device?.com;
  if (com && typeof com === 'object' && 'device' in com) {
    try {
      com.device = CLOSED_USB_DEVICE;
    } catch {
      /* read-only: nothing to fence */
    }
  }
}

/** Resolve with the operation's outcome, or reject once `ms` elapses. */
function withDeadline(promise, ms, message) {
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message);
      error.name = 'TimeoutError';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function publicAircraft(aircraft) {
  return Array.isArray(aircraft) ? aircraft.map((entry) => ({ ...entry })) : [];
}

function clampFmFrequency(value) {
  return Math.max(
    FM_MIN_HZ,
    Math.min(FM_MAX_HZ, Math.round(Number(value) / 100_000) * 100_000),
  );
}

function describeConnectionError(error) {
  const message = String(error?.message || error || '').trim();
  if (/No device was selected|NotFoundError/i.test(message))
    return 'No RTL-SDR device selected';
  if (
    /does not support the WebUSB|usb/i.test(message) &&
    /support/i.test(message)
  ) {
    return 'WebUSB requires desktop Chrome or Edge on localhost/HTTPS';
  }
  if (/access|permission|claim|busy/i.test(message)) {
    return 'RTL-SDR access failed; close other SDR apps and check USB permissions';
  }
  return message || 'RTL-SDR connection failed';
}

function streamingMessage(mode) {
  return mode === 'adsb'
    ? 'Receiving 1090 MHz ADS-B'
    : 'Receiving broadcast FM';
}

/**
 * Browser-local RTL-SDR session shared by the FM controls and the Local ADS-B
 * layer. `state.aircraft` holds source-agnostic records from
 * `src/sources/adsbRecords.js`.
 */
export class SdrController {
  /**
   * @param {object} [options]
   * @param {(webusb: USB) => {get(): Promise<object>}} [options.providerFactory]
   *   Builds the RTL-SDR provider around the selecting WebUSB wrapper.
   * @param {Storage|null} [options.storage] Gain and device preferences.
   * @param {USB|null} [options.webUsb] WebUSB entry point.
   * @param {number} [options.readStallMs] Deadline for one bulk sample read.
   * @param {number} [options.closeTimeoutMs] Deadline for a graceful close.
   */
  constructor({
    providerFactory = null,
    readStallMs = SDR_READ_STALL_MS,
    closeTimeoutMs = SDR_CLOSE_TIMEOUT_MS,
    storage = defaultStorage(),
    webUsb = typeof navigator !== 'undefined' ? navigator.usb : null,
  } = {}) {
    const webUsbSupported = Boolean(webUsb);
    this._webUsb = webUsb || null;
    this._storage = storage;
    this._gainByMode = readSdrGainSettings(storage);
    this._deviceMemory = createSdrDeviceMemory(storage);
    this.state = {
      webUsbSupported,
      connected: false,
      status: webUsbSupported ? 'idle' : 'unsupported',
      message: webUsbSupported
        ? 'Connect an RTL-SDR to begin.'
        : 'WebUSB is unavailable in this browser',
      mode: 'fm',
      frequencyHz: FM_DEFAULT_HZ,
      sampleRate: FM_SAMPLE_RATE,
      volume: 0.8,
      gain: this._gainByMode.fm,
      seeking: false,
      seekMessage: '',
      snr: null,
      aircraft: [],
      decodedMessages: 0,
      messagesPerSecond: null,
      aircraftHeard: 0,
      aircraftPositioned: 0,
      positionsRejected: 0,
      deviceLabel: null,
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
    this._deviceIdentity = null;
    this._forcePicker = false;
    this._worker = null;
    this._audioContext = null;
    this._audioNode = null;
    this._readStallMs = readStallMs;
    this._closeTimeoutMs = closeTimeoutMs;
    this._usbTail = Promise.resolve();
    // Bumped whenever a stalled queue is abandoned; work queued in an older
    // epoch refuses to touch whatever device is current when it finally runs.
    this._usbEpoch = 0;
    this._readGeneration = 0;
    // Bumped by every connect() and stop(); a connect, mode change or
    // configuration whose token is stale after an await has been superseded
    // (stopped, destroyed or restarted) and must not publish its result.
    this._sessionToken = 0;
    // The device teardown in progress, if any. Single-flight: a stop() during
    // it joins it, and connect() waits for it before opening a device, so an
    // old session's close can never race a new session's open.
    this._teardown = null;
    // Device acquisitions (`provider.get()` plus the cleanup of whatever it
    // opened) that have not handed their device to a session yet. A connect
    // waits for older ones, so an old acquisition can never close the WebUSB
    // device a newer session opened.
    this._acquisitions = new Set();
    this._acquisitionSequence = 0;
    this._destroyed = false;
    this._fmFrequencyHz = FM_DEFAULT_HZ;
    this._spectrum = null;
    this._spectrumSequence = 0;
    this._spectrumWaiters = new Set();
    this._seekToken = 0;
    // Every provider opens its device through the selecting WebUSB wrapper.
    const createProvider =
      providerFactory || ((webusb) => new RTL2832U_Provider({ webusb }));
    this._providerFactory = ({
      onUsbDevice = () => {},
      isFenced = () => false,
    } = {}) =>
      createProvider(
        captureRequestedUsb(
          createRememberingWebUsb(this._webUsb, {
            getMode: () => this.state.mode,
            memory: this._deviceMemory,
            consumeForcePicker: () => {
              const force = this._forcePicker;
              this._forcePicker = false;
              return force;
            },
            onSelected: (device) => {
              if (!isFenced()) this._deviceIdentity = sdrDeviceIdentity(device);
            },
          }),
          { onDevice: onUsbDevice, isFenced },
        ),
      );
    this._sampleWindowStartedAt = 0;
    this._sampleWindowSamples = 0;
    this._messageWindowStartedAt = 0;
    this._messageWindowCount = 0;
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
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('[SDR] State listener failed:', error);
      }
    }
  }

  _queueUsb(operation) {
    const epoch = this._usbEpoch;
    const run = () => {
      if (epoch !== this._usbEpoch)
        throw new Error('USB work abandoned after a stalled transfer');
      return operation();
    };
    const queued = this._usbTail.then(run, run);
    this._usbTail = queued.catch(() => {});
    return queued;
  }

  /** Abandon a queue that a stalled transfer is blocking. */
  _resetUsbQueue() {
    this._usbEpoch += 1;
    this._usbTail = Promise.resolve();
  }

  _ensureWorker() {
    if (this._worker) return this._worker;
    const worker = new Worker(new URL('./sdr.worker.js', import.meta.url), {
      type: 'module',
    });
    this._worker = worker;
    worker.onmessage = (event) => {
      if (this._worker !== worker) return;
      this._handleWorkerMessage(event.data || {});
    };
    worker.onerror = (event) => {
      if (this._worker !== worker) return;
      console.warn('[SDR] Decoder worker error:', event?.message || event);
      // A failed worker (e.g. its module did not load) never recovers: drop
      // it so the next session builds and configures a fresh one.
      this._discardWorker();
      this._setState({ status: 'error', message: 'SDR decoder worker failed' });
      if (this._device) void this.stop({ preserveMessage: true });
    };
    return worker;
  }

  _discardWorker() {
    const worker = this._worker;
    this._worker = null;
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    try {
      worker.terminate();
    } catch {
      /* already gone */
    }
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
      this._audioContext = new AudioContext({
        sampleRate: 48_000,
        latencyHint: 'interactive',
      });
      this._audioContext.onstatechange = () => {
        this._setState({ audioState: this._audioContext?.state || 'closed' });
      };
    }
    if (!this._audioNode) {
      await this._audioContext.audioWorklet.addModule(
        new URL('./sdrAudioWorklet.js', import.meta.url),
      );
      this._audioNode = new AudioWorkletNode(
        this._audioContext,
        'gev-sdr-audio-player',
        {
          outputChannelCount: [1],
        },
      );
      this._audioNode.connect(this._audioContext.destination);
      this._audioNode.port.postMessage({
        type: 'volume',
        value: this.state.volume,
      });
    }
    if (this._audioContext.state !== 'running')
      await this._audioContext.resume();
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
      if (
        message.samples instanceof Float32Array &&
        this._audioNode &&
        !this.state.seeking
      ) {
        this._audioNode.port.postMessage(
          { type: 'samples', samples: message.samples },
          [message.samples.buffer],
        );
      }
      if (message.bins instanceof Float32Array) {
        this._spectrum = message.bins;
        this._spectrumSequence += 1;
        for (const waiter of this._spectrumWaiters)
          waiter(this._spectrumSequence);
        this._spectrumWaiters.clear();
      }
      if (Number.isFinite(message.snr)) this._setState({ snr: message.snr });
      return;
    }
    if (message.type === 'adsb') {
      this._applyAdsbUpdate(message, Date.now());
    }
  }

  /** Merge one decoder update: records, cumulative and per-second counts. */
  _applyAdsbUpdate(message, now) {
    const decodedCount = Math.max(0, Number(message.decodedCount) || 0);
    if (!this._messageWindowStartedAt) this._messageWindowStartedAt = now;
    this._messageWindowCount += decodedCount;
    const elapsed = now - this._messageWindowStartedAt;
    const patch = {
      aircraft: publicAircraft(message.aircraft),
      decodedMessages: this.state.decodedMessages + decodedCount,
    };
    // Cumulative count of fixes the decoder's speed check refused.
    if (Number.isFinite(message.positionsRejected))
      patch.positionsRejected = Math.max(0, message.positionsRejected);
    if (elapsed >= RATE_WINDOW_MS) {
      patch.messagesPerSecond =
        Math.round(((this._messageWindowCount * 1_000) / elapsed) * 10) / 10;
      this._messageWindowStartedAt = now;
      this._messageWindowCount = 0;
    }
    const { heard, positioned } = summarizeLocalAdsb(patch.aircraft, now);
    patch.aircraftHeard = heard;
    patch.aircraftPositioned = positioned;
    this._setState(patch);
  }

  _resetAdsbCounters() {
    this._messageWindowStartedAt = 0;
    this._messageWindowCount = 0;
    return { messagesPerSecond: null };
  }

  /**
   * Whether the session identified by `token` still owns `device`.
   * @param {number} token Session token captured before an await.
   * @param {object} device The device that session was configuring.
   */
  _owns(token, device) {
    return (
      !this._destroyed &&
      token === this._sessionToken &&
      Boolean(device) &&
      device === this._device
    );
  }

  /**
   * Tune the open device for a mode and configure the decoder worker.
   * @returns {Promise<boolean>} False when the session was superseded (stopped,
   *   torn down after a stall, or replaced) during configuration; nothing is
   *   published then.
   */
  async _configureDevice(mode, frequencyHz, token = this._sessionToken) {
    const preset =
      mode === 'adsb' ? SDR_RECEIVER_PRESETS.adsb : SDR_RECEIVER_PRESETS.fm;
    const sampleRate = preset.sampleRate;
    const tunedFrequency =
      mode === 'adsb' ? preset.frequencyHz : clampFmFrequency(frequencyHz);
    const gain = this._gainByMode[mode];
    const device = this._device;
    if (!this._owns(token, device)) return false;
    const owned = await this._queueUsb(async () => {
      const steps = [
        () => device.setSampleRate(sampleRate),
        () => device.setFrequencyCorrection(preset.ppm),
        () => device.setCenterFrequency(tunedFrequency),
        () => device.setGain(tunerGainValue(gain)),
        () => setRtlAgc(device, preset.rtlAgc),
        () => device.resetBuffer(),
      ];
      const results = [];
      for (const step of steps) {
        if (!this._owns(token, device)) return false;
        results.push(await step());
      }
      if (!this._owns(token, device)) return false;
      const [actualRate, , actualFrequency] = results;
      this._setState({
        sampleRate: Number.isFinite(actualRate) ? actualRate : sampleRate,
        frequencyHz: Number.isFinite(actualFrequency)
          ? actualFrequency
          : tunedFrequency,
        gain,
      });
      return true;
    });
    if (!owned || !this._owns(token, device)) return false;
    this._configureWorker();
    this._audioNode?.port.postMessage({ type: 'clear' });
    return true;
  }

  async connect(mode = this.state.mode) {
    if (this._destroyed) return false;
    if (!this.state.webUsbSupported) {
      this._setState({
        status: 'unsupported',
        message: 'WebUSB requires desktop Chrome or Edge',
      });
      return false;
    }
    if (this._device) return this.setMode(mode);
    const token = ++this._sessionToken;
    const superseded = () => this._destroyed || token !== this._sessionToken;
    this._setState({
      status: 'connecting',
      message: 'Waiting for an RTL-SDR device…',
    });
    let acquisition = null;
    try {
      const nextMode = normalizeMode(mode);
      this._setState({ mode: nextMode, gain: this._gainByMode[nextMode] });
      // Resume audio completely before opening the USB chooser. A context that
      // has only been constructed can still be suspended after the chooser
      // consumes the click activation.
      if (nextMode === 'fm' && !(await this._ensureAudio())) {
        throw new Error(
          'Browser audio is suspended; press Connect again to resume it',
        );
      }
      if (superseded()) return false;
      // An old session's device may still be closing, or an older connect may
      // still be opening or cleaning up the same WebUSB device: opening it now
      // would let that close act on this session.
      await this._awaitUsbOwnership(superseded);
      if (superseded()) return false;
      acquisition = this._beginAcquisition();
      const device = await acquisition.provider.get();
      acquisition.device = device || null;
      // stop() or destroy() ran while the picker/open was pending: the late
      // device belongs to no session, so close it without publishing state.
      if (superseded()) {
        await this._discardAcquisition(acquisition, device);
        return false;
      }
      this._provider = acquisition.provider;
      this._device = device;
      // The session owns the device now; teardown takes over from here.
      this._endAcquisition(acquisition);
      acquisition = null;
      const configured = await this._configureDevice(
        this.state.mode,
        this._fmFrequencyHz,
        token,
      );
      // A stop() during configuration already closed this device.
      if (!configured || superseded()) return false;
      this._readGeneration += 1;
      this._sampleWindowStartedAt = Date.now();
      this._sampleWindowSamples = 0;
      this._setState({
        connected: true,
        status: 'streaming',
        message: streamingMessage(this.state.mode),
        deviceLabel: this._deviceIdentity
          ? sdrDeviceLabel(this._deviceIdentity)
          : null,
        workerBlocks: 0,
        iqLevelDbfs: null,
        audioLevelDbfs: null,
        ...this._resetAdsbCounters(),
      });
      void this._readLoop(this._readGeneration);
      return true;
    } catch (error) {
      // provider.get() failed after it may already have opened and claimed
      // the raw device (a failed initialization transfer): close whatever it
      // opened, whether or not this connect was superseded meanwhile.
      if (acquisition) await this._discardAcquisition(acquisition, null);
      if (superseded()) {
        // An installed device was closed by the stop() that superseded us.
        return false;
      }
      console.warn('[SDR] Connection failed:', error);
      const failedDevice = this._device;
      const failedProvider = this._provider;
      this._device = null;
      this._provider = null;
      // Best-effort failed-open cleanup, bounded and fenced like stop().
      if (failedDevice)
        await this._teardownDevice(failedDevice, failedProvider);
      if (superseded()) return false;
      this._setState({
        connected: false,
        status: 'error',
        message: describeConnectionError(error),
      });
      return false;
    }
  }

  /**
   * Start one device acquisition. Its provider reports every WebUSB device
   * it is handed, so a device opened by a `get()` that later fails can still
   * be closed.
   */
  _beginAcquisition() {
    let settle = null;
    const acquisition = {
      sequence: ++this._acquisitionSequence,
      usbDevices: new Set(),
      provider: null,
      // The RTL2832U its get() returned, once it has.
      device: null,
      ended: false,
      // Superseded: from here on its provider cannot reach the hardware.
      abandoned: false,
      // A newer connect stopped waiting for it to settle.
      waitedOut: false,
      settled: new Promise((resolve) => {
        settle = resolve;
      }),
      settle,
    };
    acquisition.provider = this._providerFactory({
      onUsbDevice: (usbDevice) => {
        acquisition.usbDevices.add(usbDevice);
      },
      isFenced: () => acquisition.abandoned,
    });
    this._acquisitions.add(acquisition);
    return acquisition;
  }

  _endAcquisition(acquisition) {
    if (acquisition.ended) return;
    acquisition.ended = true;
    this._acquisitions.delete(acquisition);
    acquisition.settle();
  }

  /** Every raw WebUSB device an acquisition opened or may have opened. */
  _acquisitionUsbDevices(acquisition, device = null) {
    const usbDevices = new Set(acquisition.usbDevices);
    const provider = acquisition.provider;
    for (const usbDevice of [
      rawUsbDevice(device || acquisition.device, provider),
      unwrapUsb(provider?.device),
    ]) {
      if (usbDevice && typeof usbDevice === 'object') usbDevices.add(usbDevice);
    }
    return usbDevices;
  }

  /**
   * Whether a raw WebUSB device belongs to someone other than `acquisition`:
   * the installed session, or a newer acquisition that reopened it (WebUSB
   * hands every opener the same `USBDevice`).
   */
  _usbClaimedElsewhere(usbDevice, acquisition) {
    if (!usbDevice) return false;
    const installed = this._device
      ? [
          rawUsbDevice(this._device, this._provider),
          unwrapUsb(this._provider?.device),
        ]
      : [];
    if (installed.includes(usbDevice)) return true;
    for (const other of this._acquisitions) {
      if (
        other !== acquisition &&
        other.sequence > acquisition.sequence &&
        this._acquisitionUsbDevices(other).has(usbDevice)
      )
        return true;
    }
    return false;
  }

  /** Close raw WebUSB devices, each bounded by the close deadline. */
  async _forceCloseUsbDevices(usbDevices) {
    await Promise.all(
      [...usbDevices].map((usbDevice) =>
        withDeadline(
          forceCloseUsb(usbDevice),
          this._closeTimeoutMs,
          'RTL-SDR USB close timed out',
        ).catch((error) => {
          console.warn('[SDR] USB close did not settle:', error);
        }),
      ),
    );
  }

  /**
   * Close everything an acquisition that will not become a session opened:
   * the RTL2832U it returned (a superseded connect), or only the raw WebUSB
   * device a failed `get()` left open. A raw device that another session
   * has reopened meanwhile is left alone. Bounded; never throws.
   */
  async _discardAcquisition(acquisition, device) {
    if (acquisition.ended) return;
    try {
      const usbDevices = this._acquisitionUsbDevices(acquisition, device);
      const ownRaw = rawUsbDevice(device, acquisition.provider);
      const claimedElsewhere = (usbDevice) =>
        this._usbClaimedElsewhere(usbDevice, acquisition);
      if (device) {
        // A newer connect that stopped waiting may be opening this device
        // right now: never let this old handle reach it gracefully.
        if (acquisition.waitedOut) fenceDevice(device);
        if (claimedElsewhere(ownRaw)) fenceDevice(device);
        else
          await this._closeDevice(device, acquisition.provider, {
            queued: false,
            // Re-checked when the fallback comes due: a newer session may
            // have opened the device while the graceful close stalled.
            mayForceClose: (usbDevice) => !claimedElsewhere(usbDevice),
          });
      }
      // Without an RTL2832U (a failed get()), every raw device is closed
      // directly; with one, its own raw device was handled above.
      const remaining = [...usbDevices].filter(
        (usbDevice) =>
          !(device && usbDevice === ownRaw) &&
          !this._usbClaimedElsewhere(usbDevice, acquisition),
      );
      await this._forceCloseUsbDevices(remaining);
    } catch (error) {
      console.warn('[SDR] Acquisition cleanup failed:', error);
    } finally {
      this._endAcquisition(acquisition);
    }
  }

  /**
   * Abort a superseded acquisition that is still initializing: closing the
   * raw device it opened fails its pending transfers, so its `get()` settles
   * (and cleans up) promptly instead of holding up the next session.
   */
  _abandonAcquisitions() {
    for (const acquisition of this._acquisitions) {
      if (acquisition.abandoned) continue;
      acquisition.abandoned = true;
      const usbDevices = [...this._acquisitionUsbDevices(acquisition)].filter(
        (usbDevice) => !this._usbClaimedElsewhere(usbDevice, acquisition),
      );
      if (usbDevices.length) void this._forceCloseUsbDevices(usbDevices);
    }
  }

  /**
   * Wait until no teardown is closing a device and no older acquisition can
   * still open or close one. An older acquisition is abandoned first and
   * waited for within the close deadlines; one that still has not settled
   * (a `get()` that ignores the closed device) stays fenced by
   * `_usbClaimedElsewhere`, so it cannot close this session's device later.
   */
  async _awaitUsbOwnership(superseded) {
    const waitedOut = new Set();
    for (;;) {
      if (this._teardown) {
        await this._teardown;
        if (superseded()) return;
        continue;
      }
      const older = [...this._acquisitions].filter(
        (acquisition) => !waitedOut.has(acquisition),
      );
      if (!older.length) return;
      this._abandonAcquisitions();
      try {
        await withDeadline(
          Promise.all(older.map((acquisition) => acquisition.settled)),
          this._closeTimeoutMs * 3,
          'RTL-SDR acquisition did not settle',
        );
      } catch {
        for (const acquisition of older) {
          waitedOut.add(acquisition);
          this._fenceWaitedOut(acquisition);
        }
      }
      if (superseded()) return;
    }
  }

  /**
   * Cut an acquisition that a newer connect stopped waiting for off the
   * hardware: its provider's WebUSB calls already reject (it was abandoned),
   * and an RTL2832U it returned is detached from the shared `USBDevice`, so
   * a graceful close still running for it cannot close the newer session's
   * device. Its cleanup still closes the device unless someone else owns it.
   */
  _fenceWaitedOut(acquisition) {
    acquisition.abandoned = true;
    acquisition.waitedOut = true;
    if (acquisition.device) fenceDevice(acquisition.device);
  }

  /**
   * Start the single-flight teardown of a detached device. A teardown
   * requested while another runs waits for it first.
   * @returns {Promise<void>} Settles within the close deadlines.
   */
  _teardownDevice(device, provider) {
    const prior = this._teardown || Promise.resolve();
    const teardown = prior
      .then(() => this._closeDevice(device, provider, { queued: true }))
      .finally(() => {
        if (this._teardown === teardown) this._teardown = null;
      });
    this._teardown = teardown;
    return teardown;
  }

  /**
   * Close one device: gracefully when that finishes in time, else by closing
   * the raw WebUSB device. Before the raw close, queued USB work is abandoned
   * (so a graceful close still waiting in the queue never starts) and the old
   * device is fenced from the hardware (so a graceful close that is already
   * running cannot reach a device a later session reopens). `mayForceClose`
   * is asked immediately before the raw close, so a device that someone else
   * opened while the graceful close stalled is left alone. The raw close is
   * bounded too; this never throws.
   */
  async _closeDevice(device, provider, { queued, mayForceClose = () => true }) {
    const usbDevice = rawUsbDevice(device, provider);
    try {
      // Graceful close waits behind queued USB work, but only so long: a
      // stalled bulk read would otherwise wedge stop, mode and device
      // changes behind it.
      const graceful = queued
        ? this._queueUsb(() => device.close())
        : Promise.resolve().then(() => device?.close());
      await withDeadline(
        graceful,
        this._closeTimeoutMs,
        'RTL-SDR close timed out',
      );
      return;
    } catch (error) {
      console.warn('[SDR] Device close failed:', error);
    }
    if (queued) this._resetUsbQueue();
    fenceDevice(device);
    if (!mayForceClose(usbDevice)) return;
    try {
      // Closing the raw USB device aborts any pending transfer.
      await withDeadline(
        forceCloseUsb(usbDevice),
        this._closeTimeoutMs,
        'RTL-SDR USB close timed out',
      );
    } catch (error) {
      console.warn('[SDR] USB close did not settle:', error);
    }
  }

  /**
   * Open the WebUSB picker on the next connection so the user can choose a
   * different receiver (or the other channel of a dual-channel board). Call
   * from a click handler: the picker needs user activation.
   * @returns {Promise<boolean>} Whether a receiver is streaming afterwards.
   */
  async changeDevice() {
    if (!this.state.webUsbSupported) return this.connect();
    this._forcePicker = true;
    if (this._device) await this.stop({ preserveMessage: true });
    const connected = await this.connect(this.state.mode);
    this._forcePicker = false;
    return connected;
  }

  async _readLoop(generation) {
    while (this._device && generation === this._readGeneration) {
      try {
        const device = this._device;
        // A transfer that never settles would hold the shared USB queue
        // forever; past the deadline the session is torn down (stop() closes
        // the raw USB device, which aborts the transfer).
        const block = await this._queueUsb(() =>
          withDeadline(
            device.readSamples(READ_SAMPLE_COUNT),
            this._readStallMs,
            'RTL-SDR sample read stalled',
          ),
        );
        if (!this._device || generation !== this._readGeneration) break;
        const buffer = block.data;
        this._sampleWindowSamples += buffer.byteLength / 2;
        const now = Date.now();
        const elapsed = now - this._sampleWindowStartedAt;
        if (elapsed >= RATE_WINDOW_MS) {
          this._setState({
            samplesPerSecond: Math.round(
              (this._sampleWindowSamples * 1_000) / elapsed,
            ),
          });
          this._sampleWindowStartedAt = now;
          this._sampleWindowSamples = 0;
        }
        this._ensureWorker().postMessage({ type: 'samples', buffer }, [buffer]);
      } catch (error) {
        if (generation !== this._readGeneration) break;
        console.warn('[SDR] Sample read failed:', error);
        this._setState({
          connected: false,
          status: 'error',
          message: 'RTL-SDR sample stream stopped',
        });
        await this.stop({ preserveMessage: true });
        break;
      }
    }
  }

  async setMode(mode) {
    const nextMode = normalizeMode(mode);
    this.cancelSeek();
    const token = this._sessionToken;
    const device = this._device;
    if (!device) {
      this._setState({
        mode: nextMode,
        gain: this._gainByMode[nextMode],
        frequencyHz:
          nextMode === 'adsb' ? ADSB_FREQUENCY_HZ : this._fmFrequencyHz,
        sampleRate: nextMode === 'adsb' ? ADSB_SAMPLE_RATE : FM_SAMPLE_RATE,
      });
      return true;
    }
    // A different authorized receiver preferred for this mode (the 1090 MHz
    // channel of a dual-channel board, or a device remembered for the mode)
    // takes over: reopen through selection instead of retuning this one.
    if (nextMode !== this.state.mode && this._deviceIdentity) {
      const preferred = await this._preferredDevice(nextMode);
      if (!this._owns(token, device)) return false;
      if (preferred && !sameSdrDevice(preferred, this._deviceIdentity)) {
        await this.stop({ preserveMessage: true });
        return this.connect(nextMode);
      }
    }
    this._setState({
      status: 'tuning',
      mode: nextMode,
      gain: this._gainByMode[nextMode],
      message: `Switching to ${nextMode === 'adsb' ? 'ADS-B' : 'FM'}…`,
    });
    try {
      if (nextMode === 'fm' && !(await this._ensureAudio())) {
        throw new Error(
          'Browser audio is suspended; select FM again to resume it',
        );
      }
      // A stall teardown, stop() or reconnect during the switch supersedes
      // it: that path owns the published state, never "streaming" from here.
      if (!this._owns(token, device)) return false;
      const configured = await this._configureDevice(
        nextMode,
        this._fmFrequencyHz,
        token,
      );
      if (!configured || !this._owns(token, device)) return false;
      this._setState({
        status: 'streaming',
        message: streamingMessage(nextMode),
        snr: null,
        workerBlocks: 0,
        iqLevelDbfs: null,
        audioLevelDbfs: null,
        ...this._resetAdsbCounters(),
      });
      return true;
    } catch (error) {
      if (!this._owns(token, device)) return false;
      console.warn('[SDR] Mode switch failed:', error);
      this._setState({
        status: 'error',
        message: describeConnectionError(error),
      });
      return false;
    }
  }

  /** The authorized receiver selection would open for a mode, if any. */
  async _preferredDevice(mode) {
    try {
      return selectAuthorizedSdrDevice(await this._webUsb?.getDevices?.(), {
        filters: RTL_SDR_USB_FILTERS,
        mode,
        remembered: this._deviceMemory.get(mode),
      });
    } catch {
      return null;
    }
  }

  /**
   * Set the tuner gain for a mode and apply it live when that mode is active.
   * @param {'auto'|number|string} value `'auto'` or a gain in dB.
   * @param {object} [options]
   * @param {'fm'|'adsb'} [options.mode] Mode to configure; defaults to current.
   * @returns {Promise<'auto'|number|null>} Applied setting, or null if invalid.
   */
  async setGain(value, { mode = this.state.mode } = {}) {
    const targetMode = normalizeMode(mode);
    const setting = normalizeSdrGain(value);
    if (setting === null) return null;
    this._gainByMode = { ...this._gainByMode, [targetMode]: setting };
    writeSdrGainSettings(this._storage, this._gainByMode);
    if (targetMode !== this.state.mode) return setting;
    this._setState({ gain: setting });
    if (!this._device) return setting;
    try {
      await this._queueUsb(() =>
        this._device?.setGain(tunerGainValue(setting)),
      );
      if (targetMode === 'adsb') this._setState(this._resetAdsbCounters());
    } catch (error) {
      console.warn('[SDR] Gain change failed:', error);
      this._setState({
        status: 'error',
        message: 'RTL-SDR gain change failed',
      });
      return null;
    }
    return setting;
  }

  /**
   * Current gain setting for a mode.
   * @param {'fm'|'adsb'} [mode]
   * @returns {'auto'|number}
   */
  getGain(mode = this.state.mode) {
    const target = normalizeMode(mode);
    return this._gainByMode[target] ?? SDR_GAIN_DEFAULTS[target];
  }

  async tuneFm(frequencyHz, { quiet = false } = {}) {
    const frequency = clampFmFrequency(frequencyHz);
    this._fmFrequencyHz = frequency;
    if (!this._device) {
      this._setState({
        mode: 'fm',
        gain: this._gainByMode.fm,
        frequencyHz: frequency,
        sampleRate: FM_SAMPLE_RATE,
      });
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
        ...(quiet
          ? {}
          : {
              message: `Tuned to ${(frequency / 1_000_000).toFixed(1)} MHz FM`,
            }),
      });
      return true;
    } catch (error) {
      this._setState({
        status: 'error',
        message: describeConnectionError(error),
      });
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
    if (!this._device || this.state.mode !== 'fm' || this.state.seeking)
      return null;
    const seekDirection = direction < 0 ? -1 : 1;
    const origin = this.state.frequencyHz;
    const token = ++this._seekToken;
    this._setState({
      seeking: true,
      seekMessage: `Seeking ${seekDirection > 0 ? 'up' : 'down'}…`,
    });
    this._audioNode?.port.postMessage({ type: 'volume', value: 0 });
    try {
      for (let scan = 0; scan < 18 && token === this._seekToken; scan += 1) {
        const span = FM_MAX_HZ - FM_MIN_HZ;
        const rawCenter = origin + seekDirection * scan * 1_200_000;
        const center = FM_MIN_HZ + positiveModulo(rawCenter - FM_MIN_HZ, span);
        const sequence = this._spectrumSequence;
        await this.tuneFm(center, { quiet: true });
        this._setState({
          seekMessage: `Scanning ${(center / 1_000_000).toFixed(1)} MHz…`,
        });
        if (
          !(await this._waitForSpectrum(sequence)) ||
          token !== this._seekToken
        )
          continue;
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
        this._audioNode?.port.postMessage({
          type: 'volume',
          value: this.state.volume,
        });
      }
    }
  }

  cancelSeek() {
    this._seekToken += 1;
    if (!this.state.seeking) return false;
    this._setState({ seeking: false, seekMessage: 'Seek stopped' });
    this._audioNode?.port.postMessage({
      type: 'volume',
      value: this.state.volume,
    });
    return true;
  }

  setVolume(value) {
    const volume = Math.max(0, Math.min(1, Number(value) || 0));
    this._setState({ volume });
    if (!this.state.seeking)
      this._audioNode?.port.postMessage({ type: 'volume', value: volume });
    return volume;
  }

  async requestReceiverLocation() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      this._setState({
        locationStatus: 'unavailable',
        message: 'Browser location is unavailable',
      });
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
      this._worker?.postMessage({
        type: 'location',
        location: receiverLocation,
      });
      return true;
    } catch (error) {
      console.warn('[SDR] Receiver location failed:', error);
      this._setState({
        locationStatus: 'denied',
        message: 'Receiver location was not granted',
      });
      return false;
    }
  }

  /**
   * Close the receiver.
   * @param {object} [options]
   * @param {boolean} [options.preserveMessage] Keep the current status text.
   * @param {string} [options.message] Status text explaining the stop.
   * @returns {Promise<boolean>}
   */
  async stop({ preserveMessage = false, message = null } = {}) {
    this.cancelSeek();
    this._readGeneration += 1;
    const token = ++this._sessionToken;
    const device = this._device;
    const provider = this._provider;
    this._device = null;
    this._provider = null;
    // A connect still opening a device is superseded: abort its
    // initialization so it settles and closes what it opened.
    this._abandonAcquisitions();
    this._audioNode?.port.postMessage({ type: 'clear' });
    // Single-flight: a stop() while another teardown runs joins it.
    const teardown = device
      ? this._teardownDevice(device, provider)
      : this._teardown;
    if (teardown) await teardown;
    // A connect() that started meanwhile owns the published state now.
    if (token !== this._sessionToken) return true;
    const idleStatus = this.state.webUsbSupported ? 'idle' : 'unsupported';
    this._setState({
      connected: false,
      status: preserveMessage ? this.state.status : idleStatus,
      ...(preserveMessage
        ? {}
        : { message: message || 'RTL-SDR disconnected' }),
      snr: null,
      samplesPerSecond: 0,
      workerBlocks: 0,
      iqLevelDbfs: null,
      audioLevelDbfs: null,
      ...this._resetAdsbCounters(),
    });
    return true;
  }

  async destroy() {
    this._destroyed = true;
    await this.stop();
    this._discardWorker();
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

export const SDR_FM_BAND = Object.freeze({
  minHz: FM_MIN_HZ,
  maxHz: FM_MAX_HZ,
});
export const SDR_ADSB_FREQUENCY_HZ = ADSB_FREQUENCY_HZ;
