export * from './records.js';

/**
 * The source's credit for the renderer's credits port, in the "Data
 * attribution" list, from plain text and an HTTPS URL only; the port
 * escapes it as it shows it.
 * @returns {{text: string, href: string, inline: false}|null}
 */
export function alprCredit(attribution) {
  if (!attribution?.text || !attribution?.href) return null;
  const href = new URL(attribution.href);
  if (href.protocol !== 'https:' || href.username || href.password) {
    throw new TypeError('Camera attribution requires a public HTTPS link');
  }
  return { text: `ALPR: ${attribution.text}`, href: href.href, inline: false };
}
