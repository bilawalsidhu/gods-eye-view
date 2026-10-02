import {
  checkLocalVoiceSupport,
  findLlmModel,
  recommendLlmModel,
} from './local/modelCatalog.js';

const gigabytes = (bytes) => `${Math.round(bytes / 1e9)} GB`;

const modelLine = (id) => {
  const model = findLlmModel(id);
  return `${model.label} (${gigabytes(model.bytes)} download)`;
};

/** Plain hardware guidance for the on-device engine, largest first. */
export const ON_DEVICE_GUIDANCE = Object.freeze([
  `Works best on 16 GB+ Apple Silicon: ${modelLine('gemma-4-12b')}`,
  `8–16 GB: ${modelLine('gemma-4-e4b')}`,
  'Under 8 GB or no WebGPU: use Cloud',
]);

export const ENGINE_DESCRIPTIONS = Object.freeze({
  cloud:
    "OpenAI Realtime through this app's server. Needs an OpenAI key; billed per use.",
  'on-device':
    'Runs in this browser after a one-time download. No key or per-use cost; audio stays on this device.',
});

/**
 * Reads what the browser reports about this device: secure context, WebGPU
 * adapter and limits, and the (rounded, capped) memory estimate.
 */
export async function probeDevice({
  navigator: nav = globalThis.navigator,
  secure = globalThis.isSecureContext,
} = {}) {
  const probe = {
    secure: secure !== false,
    webgpu: Boolean(nav?.gpu),
    adapter: false,
    vendor: '',
    architecture: '',
    maxBufferSize: null,
    deviceMemoryGB: Number(nav?.deviceMemory) || null,
  };
  if (!probe.webgpu) return probe;
  try {
    const adapter = await nav.gpu.requestAdapter();
    if (adapter) {
      probe.adapter = true;
      probe.vendor = adapter.info?.vendor || '';
      probe.architecture = adapter.info?.architecture || '';
      probe.maxBufferSize = adapter.limits?.maxBufferSize ?? null;
    }
  } catch {
    probe.adapter = false;
  }
  return probe;
}

/**
 * Turns a device probe into the hardware check lines and a verdict.
 * @param {object|null} probe Result of probeDevice, null while checking.
 */
export function deviceCheckView(probe) {
  if (!probe)
    return {
      state: 'checking',
      gpu: 'Checking WebGPU…',
      memory: '',
      verdict: '',
      suggested: null,
    };
  const support = checkLocalVoiceSupport({
    hasWebGpu: probe.webgpu,
    adapter: probe.webgpu ? probe.adapter : undefined,
    maxBufferSize: probe.maxBufferSize ?? undefined,
    deviceMemoryGB: probe.deviceMemoryGB ?? undefined,
    isSecureContext: probe.secure,
    model: findLlmModel('gemma-4-e4b'),
  });
  const gpuName = [probe.vendor, probe.architecture].filter(Boolean).join(' ');
  const gpu = !probe.webgpu
    ? 'WebGPU: not available'
    : !probe.adapter
      ? 'WebGPU: no graphics adapter'
      : `WebGPU: available${gpuName ? ` (${gpuName})` : ''}`;
  // Browsers round the estimate down and cap it, so it is a lower bound.
  const memory = probe.deviceMemoryGB
    ? `Memory: browser reports at least ${probe.deviceMemoryGB} GB`
    : 'Memory: not reported by this browser';
  if (!support.ok)
    return {
      state: 'unsupported',
      gpu,
      memory,
      verdict: `On-device voice can't run here: ${support.reason} Use Cloud.`,
      suggested: null,
    };
  const suggested = recommendLlmModel({
    deviceMemoryGB: probe.deviceMemoryGB,
  });
  return {
    state: 'supported',
    gpu,
    memory,
    verdict: `This device can run on-device voice. Suggested: ${modelLine(suggested.id)}.`,
    suggested: suggested.id,
  };
}

/**
 * Derives the engine choice controls from the current engine and probe.
 * @param {{engine: string, probe?: object|null, badge?: string|null}} state
 */
export function voiceEngineView({ engine, probe = null, badge = null }) {
  const device = deviceCheckView(probe);
  const onDevice = engine === 'on-device';
  return {
    toggleLabel: onDevice ? badge || 'ON-DEVICE' : 'CLOUD',
    toggleTitle: onDevice
      ? 'Voice runs on this device · change or see models'
      : 'Voice runs in the cloud · choose Cloud or On-device',
    chips: [
      {
        id: 'cloud',
        label: 'CLOUD',
        title: ENGINE_DESCRIPTIONS.cloud,
        active: !onDevice,
      },
      {
        id: 'on-device',
        label: 'ON-DEVICE',
        title: ENGINE_DESCRIPTIONS['on-device'],
        active: onDevice,
        // Stay selectable while checking or when already chosen, so the
        // choice can always be undone.
        disabled: device.state === 'unsupported' && !onDevice,
      },
    ],
    description: ENGINE_DESCRIPTIONS[engine] || ENGINE_DESCRIPTIONS.cloud,
    device,
    guidance: ON_DEVICE_GUIDANCE,
    unsupported: device.state === 'unsupported',
  };
}
