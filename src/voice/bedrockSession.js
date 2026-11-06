import { createTextOnlySession } from './textOnlySession.js';
import { t } from '../i18n/index.js';

/** Typed chat only: Amazon Bedrock has no realtime voice API, so no voice. */
export function createBedrockSession(options) {
  return createTextOnlySession(options, {
    provider: 'bedrock',
    advisory: t(
      'Amazon Bedrock answers in chat only; voice is not available for this provider.',
    ),
    voiceRefusal: t('Amazon Bedrock has no voice. Open CHAT to type instead.'),
  });
}
