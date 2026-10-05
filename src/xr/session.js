import {
  detectXR,
  sessionOptions,
  attachXR,
} from './vendor/xr-capabilities.js';
import { qualityLevel } from './vendor/xr-quality.js';
import { watchSession } from './vendor/xr-lifecycle.js';

/** App-specific session ownership around the template's capability and lifecycle hooks. */
export function createSessionController({
  renderer,
  xrSystem = globalThis.navigator?.xr,
  secure = globalThis.isSecureContext,
  detect = detectXR,
  attach = attachXR,
  watch = watchSession,
  onChange = () => {},
  onStart = async () => {},
  onEnd = () => {},
  onStatus = () => {},
}) {
  let capabilities = { ar: false, vr: false, mode: null },
    active = null,
    lifecycle = null,
    pending = false,
    destroyed = false;
  let mode = 'auto';
  const selected = () => (mode === 'auto' ? capabilities.mode : mode);
  const state = () => ({
    capabilities,
    active: Boolean(active),
    pending,
    mode,
    selected: selected(),
    visible: lifecycle?.visible ?? true,
    secure,
  });
  const publish = () => {
    if (!destroyed) onChange(state());
  };
  const controller = {
    state,
    async detect() {
      capabilities = secure
        ? await detect(xrSystem)
        : { ar: false, vr: false, mode: null };
      publish();
      return state();
    },
    setMode(value) {
      if (
        pending ||
        active ||
        !['auto', 'immersive-ar', 'immersive-vr'].includes(value)
      )
        return;
      mode = value;
      publish();
    },
    async enter() {
      const nextMode = selected();
      if (destroyed || pending || active || !secure || !nextMode || !xrSystem)
        return;
      if (nextMode === 'immersive-ar' ? !capabilities.ar : !capabilities.vr)
        return;
      pending = true;
      publish();
      let next = null;
      try {
        // Must remain before any await: immersive entry needs this click's activation.
        next = await xrSystem.requestSession(
          nextMode,
          sessionOptions(nextMode),
        );
        if (destroyed) {
          await next.end();
          return;
        }
        active = next;
        lifecycle = watch(next, { onVisibility: () => publish() });
        next.addEventListener(
          'end',
          () => {
            if (active !== next) return;
            active = lifecycle = null;
            onEnd();
            publish();
          },
          { once: true },
        );
        const attached = await attach(renderer, next, {
          quality: qualityLevel('balanced'),
        });
        if (active !== next || destroyed) return;
        await onStart({
          session: next,
          mixedReality: nextMode === 'immersive-ar',
          ...attached,
        });
        if (active === next)
          onStatus(
            `${nextMode === 'immersive-ar' ? 'Mixed reality' : 'Virtual reality'} · ${attached.floor ? 'floor tracking' : 'estimated 1.6 m floor'}`,
          );
      } catch (error) {
        if (next) await (lifecycle?.end() || next.end().catch(() => {}));
        if (
          error.name === 'NotSupportedError' &&
          nextMode === 'immersive-ar' &&
          capabilities.vr
        ) {
          capabilities.ar = false;
          capabilities.mode = 'immersive-vr';
          mode = 'immersive-vr';
          onStatus('MR unavailable. Choose Enter VR to retry.');
        } else onStatus(`Could not enter headset: ${error.message}`);
      } finally {
        pending = false;
        publish();
      }
    },
    exit() {
      return lifecycle?.end() || Promise.resolve();
    },
    async destroy() {
      destroyed = true;
      await controller.exit();
    },
  };
  return controller;
}
