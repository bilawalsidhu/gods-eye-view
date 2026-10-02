export { LOCAL_WEB_VOICE, localWebVoiceRequested } from './localWebFlag.js';

const cancelled = () =>
  new DOMException('On-device voice was stopped', 'AbortError');

/**
 * Session adapter factory for the on-device tier that loads the provider on
 * first use, so pages without the flag never download it. A stop issued
 * while the module loads cancels the pending start; after removal the
 * provider is never constructed and every later start is refused.
 */
export function createLocalWebSessionLoader(
  hooks,
  {
    load = () =>
      Promise.all([
        import('./localWebSession.js'),
        import('../../ui/styles/local-voice.css'),
      ]).then(([module]) => module),
  } = {},
) {
  let adapter = null;
  let bound = false;
  let disposed = false;
  let stopEpoch = 0;
  const isDisposed = () => disposed || Boolean(hooks.signal?.aborted);
  const ready = Promise.resolve()
    .then(load)
    .then((module) => {
      if (isDisposed()) return null;
      adapter = module.createLocalWebSession(hooks);
      if (bound) adapter.bindControls();
      return adapter;
    });
  ready.catch(() => {});
  return {
    capabilities: { costControls: false, pushToTalk: true, local: true },
    get local() {
      return adapter?.local || null;
    },
    ready,
    async start(options) {
      if (isDisposed()) throw cancelled();
      const epoch = stopEpoch;
      const loaded = await ready;
      if (!loaded || isDisposed()) throw cancelled();
      if (epoch !== stopEpoch) return undefined;
      return loaded.start(options);
    },
    stop(options = {}) {
      stopEpoch++;
      if (options.removeUi) disposed = true;
      adapter?.stop(options);
    },
    sendText(text) {
      if (isDisposed()) return false;
      void ready.then((loaded) => {
        if (loaded && !isDisposed()) loaded.sendText(text);
      });
      return true;
    },
    sendMapEvent() {
      return false;
    },
    ignoreButtonClick: () => Boolean(adapter?.ignoreButtonClick()),
    bindControls() {
      bound = true;
      if (!isDisposed()) adapter?.bindControls();
    },
  };
}
