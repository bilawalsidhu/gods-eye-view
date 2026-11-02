/**
 * The Cockpit Contact card's state as it first renders. It needs only the
 * i18n module, so the controller and the view can both read it.
 */
import { t } from '../i18n/index.js';

/** Cohorts the card counts, in its order. */
const COCKPIT_CONTEXT_COHORTS = Object.freeze([
  'flights',
  'military',
  'ais-live-vessels',
  'military-installations',
]);

/**
 * The card before any snapshot: navigation on, counts and readouts empty,
 * weather off. The controller keeps it, changes it in place and publishes a
 * copy; `CockpitContext` renders it.
 * @returns {object}
 */
export function createContextState() {
  return {
    state: null,
    subject: t('CONTACTS · 250 KM'),
    canPrevious: true,
    canNext: true,
    cohorts: Object.fromEntries(
      COCKPIT_CONTEXT_COHORTS.map((id) => [id, { count: '—', unknown: false }]),
    ),
    nearest: { label: t('NO AVAILABLE EXAMPLE'), ariaLabel: null },
    distance: { text: '—', ariaLabel: null },
    direction: { angle: null, unknown: false },
    bearing: '—',
    uncertainty: t('AVAILABLE INPUTS ONLY · NOT AN ALL-CLEAR'),
    updated: '--:--:--Z',
    weather: false,
  };
}
