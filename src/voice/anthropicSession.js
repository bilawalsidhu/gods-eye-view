import { createTextChat } from './textChat.js';
import { t } from '../i18n/index.js';

/** Typed chat only: Claude has no voice, so the microphone is never opened. */
export function createAnthropicSession(options) {
  const chat = createTextChat({ ...options, provider: 'anthropic' });
  let textOnly = false;
  return {
    capabilities: {
      costControls: false,
      pushToTalk: false,
      textOnly: true,
      advisoryLimit: t(
        'Claude answers in chat only; voice is not available for this provider.',
      ),
    },
    start: (settings) => {
      if (settings?.textOnly) {
        textOnly = true;
        return chat.start();
      }
      options.emit({
        type: 'state',
        state: 'error',
        detail: t('Claude has no voice. Open CHAT to type instead.'),
      });
      return false;
    },
    getStartOptions: () => ({
      pushToTalk: false,
      ...(textOnly ? { textOnly: true } : {}),
    }),
    stop: (settings) => {
      textOnly = false;
      chat.stop(settings);
    },
    // Chat Stop: abort the reply in progress, keep the conversation.
    cancelTurn: () => textOnly && chat.cancelTurn(),
    sendText: (text) => textOnly && chat.sendText(text),
    sendMapEvent: (event) => textOnly && chat.sendMapEvent(event),
    ignoreButtonClick: () => false,
    bindControls: () => {},
  };
}
