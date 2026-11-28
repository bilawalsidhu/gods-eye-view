// The first-run launcher's owner-chosen copy, shared by the launcher and the
// welcome view that renders it.
import { msg } from './i18n/index.js';

/** The fires/quakes mission's tile title (translate with t()). */
export const ENVIRONMENTAL_TITLE = msg('ENVIRONMENTAL');

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
