// The status after a tier switch names the tier in the interface
// language, as the tier button does; the stored tier value stays English.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setLocale, t } from '../i18n/index.js';
import { RealtimeCost } from './realtimeCost.js';
import { createTestVoiceUi } from '../testSupport/voiceUi.mjs';

function harness() {
  const ui = createTestVoiceUi();
  const statusCalls = [];
  const cost = new RealtimeCost({
    readUi: () => ui,
    readStatus: () => 'listening',
    operations: {
      isActive: () => true,
      isVoiceSessionSettled: () => false,
      setStatus: (status, detail) => statusCalls.push(detail),
    },
  });
  return { cost, ui, statusCalls };
}

const EXPECTED = {
  en: {
    mini: 'MINI applies next session',
    standard: 'STANDARD applies next session',
  },
  ru: {
    mini: 'МИНИ — со следующей сессии',
    standard: 'СТАНДАРТ — со следующей сессии',
  },
  es: {
    mini: 'MINI desde la próxima sesión',
    standard: 'ESTÁNDAR desde la próxima sesión',
  },
};

for (const locale of Object.keys(EXPECTED)) {
  test(`${locale}: tier status names the tier in the interface language`, (ctx) => {
    setLocale(locale);
    ctx.after(() => setLocale('en'));
    for (const tier of ['mini', 'standard']) {
      const { cost, ui, statusCalls } = harness();
      assert.equal(cost.setVoiceTier(tier), tier, 'stored tier stays English');
      assert.equal(statusCalls.at(-1), EXPECTED[locale][tier]);
      assert.equal(
        ui.state.tier.text,
        tier === 'mini' ? t('MINI') : t('STD'),
      );
    }
  });
}
