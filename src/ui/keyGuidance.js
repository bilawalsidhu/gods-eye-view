/**
 * Key guidance in the UI language. keySetupCore.mjs builds the same sentences
 * in English for the server and the AI tools; these are the ones people read.
 */
import {
  KEY_SETUP_KEYS,
  keySetupRequirementEnvVars,
} from '../keySetupCore.mjs';
import { formatList, t, translateKnown } from '../i18n/index.js';

/** "Needs X — add it in Provider Settings", or '' for an unknown or hidden key. */
export function keyRequirementText(id) {
  return keysRequirementText([id]);
}

/**
 * The same for several keys, their variables in one list in the UI
 * language ("Needs X or Y — …"); unknown or hidden keys are left out, and
 * none known is ''.
 * @param {Array<string>} ids Registry entry ids, in the order to name them.
 */
export function keysRequirementText(ids = []) {
  const envVars = [
    ...new Set(ids.map((id) => (id ? keySetupRequirementEnvVars(id) : null))),
  ].filter(Boolean);
  if (envVars.length > 1)
    return t('Needs {envVars} — add one in Provider Settings', {
      envVars: formatList(envVars, { type: 'disjunction' }),
    });
  return envVars.length
    ? t('Needs {envVars} — add it in Provider Settings', {
        envVars: formatList(envVars),
      })
    : '';
}

/** The key's product name in title case: GOOGLE MAPS → Google Maps. */
function keyName(id) {
  const entry = KEY_SETUP_KEYS.find((candidate) => candidate.id === id);
  return entry
    ? entry.title
        .toLowerCase()
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
    : null;
}

/**
 * The requirement, then the switched-off sources that would draw with a key
 * already set (see keySetupWithAlternatives).
 *
 * @param {string} requirement
 * @param {Array<{label: string, requiresKeyId: string|null}>} [alternatives]
 */
export function keyGuidanceText(requirement, alternatives = []) {
  const options = alternatives.map(({ label, requiresKeyId }) => {
    const name = keyName(requiresKeyId);
    const source = translateKnown(label);
    return name
      ? t('light {source} to use your {name} key', { source, name })
      : t('light {source}', { source });
  });
  if (!options.length) return requirement;
  const offer = options.join(t(', or '));
  if (requirement)
    return t('{requirement}, or {offer}', { requirement, offer });
  return offer.charAt(0).toLocaleUpperCase() + offer.slice(1);
}
