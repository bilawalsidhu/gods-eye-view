/** Card model for one selected message sign. Pure: no Cesium types. */
import { formatRelativeTime, t } from '../../i18n/index.js';
import { cardLines, parseMultiText, spokenText } from './multi.js';

const TITLE_MAX_CHARS = 48;

function pageLabels() {
  return {
    pageLabel: (n, total) => t('Page {n} of {total}', { n, total }),
    graphicOnly: t('Graphic only'),
  };
}

/**
 * How old MnDOT's data is, in the UI language ("45 seconds ago").
 * @param {number} ageMs
 */
export function dataAgeText(ageMs) {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  return seconds < 90
    ? formatRelativeTime(-seconds, 'second')
    : formatRelativeTime(-Math.round(seconds / 60), 'minute');
}

/**
 * The selected sign's card: MnDOT's location as the title, the message's
 * lines (MnDOT's text, untranslated), and the data age, which credits MnDOT.
 * `spoken` is the same content as one sentence for screen readers.
 * @param {{ location: string, multi: string }} sign
 * @param {{ ageMs: number, stale: boolean }} data
 * @returns {{ title: string, details: string[], spoken: string }}
 */
export function buildSignCard(sign, { ageMs, stale }) {
  const parsed = parseMultiText(sign.multi);
  const labels = pageLabels();
  const age = dataAgeText(ageMs);
  const ageLine = stale
    ? t('STALE · MnDOT data {age}', { age })
    : t('MnDOT data {age}', { age });
  const location =
    sign.location.length > TITLE_MAX_CHARS
      ? `${sign.location.slice(0, TITLE_MAX_CHARS - 1)}…`
      : sign.location;
  return {
    title: t('SIGN · {location}', { location }),
    details: [...cardLines(parsed, labels), ageLine],
    spoken: [
      t('Message sign, {location}', { location: sign.location }),
      spokenText(parsed, labels),
      ageLine,
    ]
      .filter(Boolean)
      .join('. '),
  };
}
