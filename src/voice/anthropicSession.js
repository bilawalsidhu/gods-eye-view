import { createTextOnlySession } from './textOnlySession.js';
import { t } from '../i18n/index.js';

/** Typed chat only: Claude has no voice, so the microphone is never opened. */
export function createAnthropicSession(options) {
  return createTextOnlySession(options, {
    provider: 'anthropic',
    advisory: t(
      'Claude answers in chat only; voice is not available for this provider.',
    ),
    voiceRefusal: t('Claude has no voice. Open CHAT to type instead.'),
  });
}
