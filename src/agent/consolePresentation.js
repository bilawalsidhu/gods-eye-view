import { t } from '../i18n/index.js';
import { formatCommandCostUsd } from './cost.js';

// Display-only formatting; never changes IDs or conversation/tool data.

function consoleTextParts(text) {
  const value = String(text);
  if (!/[\p{Script=Arabic}\p{Script=Hebrew}]/u.test(value))
    return [{ text: value, ltr: false }];
  const technical =
    /\(?[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?\)?|[A-Za-z][A-Za-z0-9_.:/@-]*(?:[ \t]+[+-]?\d+(?:\.\d+)?[°%]?)?/g;
  const parts = [];
  let end = 0;
  for (const match of value.matchAll(technical)) {
    if (match.index > end)
      parts.push({ text: value.slice(end, match.index), ltr: false });
    parts.push({ text: match[0], ltr: true });
    end = match.index + match[0].length;
  }
  if (end < value.length) parts.push({ text: value.slice(end), ltr: false });
  return parts;
}

function providerOptionLabel(provider) {
  if (provider.authType === 'oauth') return t('ChatGPT plan');
  if (provider.configured) return provider.label;
  return `${provider.label} (needs ${provider.apiKeyEnv})`;
}

function modelOptionLabel(model) {
  const parts = [model.label];
  const cost = formatCommandCostUsd(model.costPerCommandUsd);
  if (cost !== 'n/a') parts.push(cost);
  if (model.supportsVision) parts.push('vision');
  return parts.length > 1
    ? `${parts[0]}  ·  ${parts.slice(1).join(' · ')}`
    : parts[0];
}

export { consoleTextParts, providerOptionLabel, modelOptionLabel };
