import { t } from '../../i18n/index.js';

/** Compact card ages in translated minutes, hours or days. */
export function formatAge(deltaMs) {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;
  const hours = Math.floor(deltaMs / 3_600_000);
  if (hours < 1)
    return t('{count}m', {
      context: 'age',
      count: Math.max(1, Math.floor(deltaMs / 60_000)),
    });
  if (hours < 24) return t('{count}h', { context: 'age', count: hours });
  return t('{count}d', { context: 'age', count: Math.floor(hours / 24) });
}

/** Use the creator portion of the supplied attribution, never a guessed
 * observer/login. iNaturalist appends rights and licence text after it. */
export function photoCreator(photo) {
  if (typeof photo?.attribution !== 'string') return null;
  const creator = photo.attribution
    .replace(/^\s*(?:\(c\)|©|copyright)\s*/i, '')
    .replace(/,\s*(?:some|no|all)\s+rights\s+reserved\b.*$/i, '')
    .replace(
      /(?:,\s*|\s*\()(?:CC[\s-]+BY(?:[\s-]+(?:NC|SA|ND))*|CC0|public\s+domain)(?:\s+\d(?:\.\d)?)?\)?\s*$/i,
      '',
    )
    .trim();
  if (
    !creator ||
    /^(?:(?:some|no|all)\s+rights\s+reserved\b|CC(?:0|[\s-]+BY)\b)/i.test(
      creator,
    )
  )
    return null;
  return creator;
}
