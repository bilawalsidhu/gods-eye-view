/**
 * The name fields to read for a language, in order: `name:<locale>`, then
 * its base language (Chinese by script), then `name`, then `name:latin`.
 * @param {string} locale
 * @returns {string[]}
 */
export function nameKeys(locale = 'en') {
  const tag = String(locale || 'en');
  const base = tag.split('-')[0];
  const keys = [`name:${tag}`];
  if (base === 'zh')
    keys.push(/Hant|TW|HK|MO/i.test(tag) ? 'name:zh-Hant' : 'name:zh-Hans');
  keys.push(`name:${base}`, 'name', 'name:latin');
  return [...new Set(keys)];
}
