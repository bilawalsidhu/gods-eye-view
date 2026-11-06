import { createTextChat } from './textChat.js';

/**
 * Typed chat only: the provider has no voice, so the microphone is never
 * opened. `voiceRefusal` answers a voice start; `advisory` explains the limit.
 */
export function createTextOnlySession(
  options,
  { provider, voiceRefusal, advisory },
) {
  const chat = createTextChat({ ...options, provider });
  let textOnly = false;
  return {
    capabilities: {
      costControls: false,
      pushToTalk: false,
      textOnly: true,
      advisoryLimit: advisory,
    },
    start: (settings) => {
      if (settings?.textOnly) {
        textOnly = true;
        return chat.start();
      }
      options.emit({
        type: 'state',
        state: 'error',
        detail: voiceRefusal,
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
