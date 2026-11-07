import { getLocale, t } from '../../i18n/index.js';
import { formatMeasure } from '../../ui/unitLabels.js';

// coverageLabel is machine-composed English from installations/controls.js
// (pinned by src/data/militaryInstallations.test.mjs). The Contacts snapshot
// keeps it as given; the panel and the Cockpit word the known forms when they
// present them, so a language or unit switch rewords them in place.
const WITHIN_KM_RE = /^WITHIN (\d+) KM$/;

/**
 * The mapped-installation coverage in the UI language and unit system:
 * `WITHIN 62 KM` reads `WITHIN 39 MI` under imperial units. Anything else
 * passes through.
 * @param {string|null} label
 * @returns {string|null}
 */
export function localizeCoverageLabel(label) {
  if (typeof label !== 'string' || !label) return label;
  if (label === 'CURRENT VIEWPORT ONLY') return t('CURRENT VIEWPORT ONLY');
  const within = WITHIN_KM_RE.exec(label);
  if (within)
    return t('WITHIN {distance}', {
      distance: formatMeasure(Number(within[1]), 'km').toLocaleUpperCase(
        getLocale(),
      ),
    });
  return label;
}
