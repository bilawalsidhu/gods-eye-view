// The first-run launcher's owner-chosen copy, shared by the launcher and the
// welcome view that renders it.
import { msg, t } from './i18n/index.js';

/**
 * Owner-selectable name for the fires/quakes mission. Flip this ONE constant to
 * re-label the tile; the alternates are pre-written so the choice is a taste
 * call at review time, not an edit.
 * @type {'ENVIRONMENTAL'|'EARTH_WATCH'|'ACTIVE_EVENTS'}
 */
export const ENVIRONMENTAL_LABEL_CHOICE = 'ENVIRONMENTAL';

const ENVIRONMENTAL_LABEL_KEYS = Object.freeze({
  ENVIRONMENTAL: msg('ENVIRONMENTAL'),
  EARTH_WATCH: msg('EARTH WATCH'),
  ACTIVE_EVENTS: msg('ACTIVE EVENTS'),
});

/**
 * @param {string} [choice]
 * @returns {{title: string}} The label set the constant above selects.
 */
export function environmentalLabel(choice = ENVIRONMENTAL_LABEL_CHOICE) {
  const key =
    ENVIRONMENTAL_LABEL_KEYS[choice] || ENVIRONMENTAL_LABEL_KEYS.ENVIRONMENTAL;
  return { title: t(key) };
}

/**
 * The outbound links the first-run card offers.
 * @type {Readonly<Record<string, string>>}
 */
export const FIRST_RUN_LINKS = Object.freeze({
  /** The open-source repository. */
  source: 'https://github.com/bilawalsidhu/gods-eye-view',
  youtube: 'https://www.youtube.com/@bilawalsidhu',
  x: 'https://x.com/bilawalsidhu',
  instagram: 'https://www.instagram.com/bilawal.ai',
  linkedin: 'https://www.linkedin.com/in/bilawalsidhu',
  website: 'https://bilawal.ai',
  halfpixel: 'https://halfpixel.ai',
});
