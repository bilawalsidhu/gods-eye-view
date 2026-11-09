import { createTextOnlySession } from './textOnlySession.js';
import { t } from '../i18n/index.js';

/** Typed chat only: Vertex AI Express Mode has no Live models, so no voice. */
export function createVertexSession(options) {
  return createTextOnlySession(options, {
    provider: 'vertex',
    advisory: t(
      'Vertex AI answers in chat only; voice is not available for this provider.',
    ),
    voiceRefusal: t('Vertex AI has no voice. Open CHAT to type instead.'),
  });
}
