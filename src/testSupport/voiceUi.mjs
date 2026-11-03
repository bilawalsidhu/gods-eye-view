import { createPinia } from 'pinia';
import { useVoiceStore } from '../ui/stores/voice.js';
import { createVoiceControl } from '../voice/control.js';

/**
 * A real voice control presenter on its own store, for owner tests that run
 * without a page. Read what it shows from `ui.state`; report interactions
 * with `ui.emit(name, ...args)`.
 * @param {{panel?: boolean, pinia?: import('pinia').Pinia}} [options]
 */
export function createTestVoiceUi({
  panel = false,
  pinia = createPinia(),
} = {}) {
  return createVoiceControl({ panel, store: useVoiceStore(pinia) });
}
