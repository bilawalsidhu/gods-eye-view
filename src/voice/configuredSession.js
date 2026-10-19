import { createRealtimeSession } from './realtimeSession.js';
import { createLocalSession } from './localSession.js';

/** Select once per page lifetime; settings saves reload the page. Never fall back from Local to cloud. */
export function createConfiguredSession(options) {
  let adapter,
    bound = false,
    generation = 0;
  const ready = fetch('/api/ai/config', {
    signal: options.signal,
    cache: 'no-store',
  }).then(async (response) => {
    if (!response.ok && response.status !== 404)
      throw new Error('Could not load AI provider settings');
    const config =
      response.status === 404 ? { provider: 'openai' } : await response.json();
    options.signal?.throwIfAborted();
    if (!['local', 'openai'].includes(config.provider))
      throw new Error('Invalid AI provider');
    adapter =
      config.provider === 'local'
        ? createLocalSession({ ...options, config })
        : createRealtimeSession(options);
    if (options.ui.tierButton)
      options.ui.tierButton.hidden = config.provider === 'local';
    if (options.ui.costValue)
      options.ui.costValue.hidden = config.provider === 'local';
    if (bound) adapter.bindControls?.();
    return adapter;
  });
  // Report initialization failures on activation; prevent unhandled rejections while idle.
  ready.catch(() => {});
  return {
    capabilities: { costControls: true, pushToTalk: true },
    getController: () => adapter?.controller,
    async start(settings) {
      const attempt = ++generation;
      const selected = await ready;
      if (attempt !== generation || options.signal?.aborted) return;
      return selected.start(settings);
    },
    stop(settings) {
      generation++;
      adapter?.stop(settings);
    },
    sendText(text) {
      return adapter?.sendText(text);
    },
    sendMapEvent(event) {
      return adapter?.sendMapEvent(event);
    },
    ignoreButtonClick: () => adapter?.ignoreButtonClick?.() || false,
    bindControls() {
      bound = true;
      adapter?.bindControls?.();
    },
  };
}
