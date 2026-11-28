// The AIS degradation chip reads in the UI language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, translateKnown } from '../i18n/index.js';
import aisLiveVesselsLayer from './aisLiveVessels.js';

const { deriveAisFeedError } = aisLiveVesselsLayer.testing.parts.queries;

test('AIS degraded-feed reasons are localized in es', () => {
  setLocale('es');
  try {
    const cases = [
      [
        { status: 'down', reconnectAttempt: 3 },
        'feed down — retrying slowly (attempt 3)',
      ],
      [{ status: 'missing-key' }, 'AISSTREAM_API_KEY not set'],
      [
        { status: 'stale', silentForMs: 90000 },
        'feed silent 90s — no AIS data',
      ],
      [{ status: 'auth-failed' }, 'API key rejected — check AISSTREAM_API_KEY'],
      [{ status: 'connecting' }, 'connecting to feed…'],
      [{ status: 'closed' }, 'feed disconnected'],
    ];
    for (const [payload, english] of cases) {
      // The layer panel runs stats.error through translateKnown(); emulate it.
      const shown = translateKnown(deriveAisFeedError(payload, 0));
      assert.notEqual(shown, english, `status ${payload.status} still English`);
    }
  } finally {
    setLocale('en');
  }
});
