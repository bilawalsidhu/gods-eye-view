// The API-key cost tooltip states an incomplete estimate in the
// interface language; the tracker keeps its English note for diagnostics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale } from '../i18n/index.js';
import { RealtimeCost } from './realtimeCost.js';
import { createVoiceCostTracker } from './voiceCost.js';

for (const locale of ['es', 'ru']) {
  test(`API-key cost tooltip for an incomplete session has no English (${locale})`, () => {
    setLocale(locale);
    try {
      const costTracker = createVoiceCostTracker({ tier: 'standard' });
      costTracker.markIncomplete();
      const host = {
        costTracker,
        voiceTier: 'standard',
        cloudVoiceAuth: 'api-key',
        sessionCloudVoiceAuth: 'api-key',
        isActive: () => false,
        ui: {
          costValue: { hidden: true, dataset: {}, title: '', textContent: '' },
        },
      };
      RealtimeCost.prototype.syncCostUi.call(host);
      const title = host.ui.costValue.title;
      assert.ok(title.length > 0);
      assert.doesNotMatch(
        title,
        /Estimate is incomplete|still in flight/,
        title,
      );
    } finally {
      setLocale('en');
    }
  });
}

test('API-key cost tooltip in English still ends with the tracker note', () => {
  const costTracker = createVoiceCostTracker({ tier: 'standard' });
  costTracker.markIncomplete();
  const host = {
    costTracker,
    voiceTier: 'standard',
    cloudVoiceAuth: 'api-key',
    sessionCloudVoiceAuth: 'api-key',
    isActive: () => false,
    ui: {
      costValue: { hidden: true, dataset: {}, title: '', textContent: '' },
    },
  };
  RealtimeCost.prototype.syncCostUi.call(host);
  assert.ok(host.ui.costValue.title.endsWith(` ${costTracker.state().note}`));
});
