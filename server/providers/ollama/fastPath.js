/**
 * Skip the model entirely for the one command people say most: a plain
 * "fly to <known preset city>". Anything richer goes to the model with the
 * full tool set, so this never narrows what the assistant can do.
 */
const DEFAULT_ALIASES = {
  austin: ['austin', 'austin texas'],
  sf: ['sf', 'san francisco', 'san fran', 'frisco'],
  nyc: ['nyc', 'new york', 'new york city', 'manhattan'],
  tokyo: ['tokyo'],
  london: ['london'],
  paris: ['paris'],
  dubai: ['dubai'],
  dc: ['dc', 'washington', 'washington dc', 'washington d.c.', 'd.c.'],
};

const LABELS = {
  austin: 'Austin',
  sf: 'San Francisco',
  nyc: 'New York City',
  tokyo: 'Tokyo',
  london: 'London',
  paris: 'Paris',
  dubai: 'Dubai',
  dc: 'Washington DC',
};

/** Human label for a preset id, for canned confirmations. */
export function flyToLabel(id) {
  if (LABELS[id]) return LABELS[id];
  const text = String(id || '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const VERB =
  /^(?:(?:please|ok|okay|hey|now|can you|could you)\s+)*(?:fly|go|take me|bring me|jump|navigate|head|travel|move)\s+(?:us\s+)?(?:over\s+)?(?:to|towards|toward)\s+(?:the\s+city\s+of\s+)?(?<place>[a-z. ]+?)(?:\s+please)?$/;

export function deterministicFlyTo(
  text,
  {
    locationIds = Object.keys(DEFAULT_ALIASES),
    aliases = DEFAULT_ALIASES,
  } = {},
) {
  const value = normalize(text);
  if (!value) return null;
  const match = VERB.exec(value);
  if (!match) return null;
  const place = match.groups.place.replace(/\.$/, '').trim();
  for (const id of locationIds) {
    const names = aliases[id] || [id];
    if (names.some((name) => normalize(name) === place))
      return { name: 'fly_to_location', arguments: { locationId: id } };
  }
  return null;
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[,!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');
}

const REMEMBER =
  /^(?:(?:please|ok|okay|hey)\s+)*(?:remember|save|bookmark|mark)\s+(?:this|the\s+current|my\s+current|the)\s*(?:place|view|spot|location|position|area)?\s+(?:as|called|named)\s+(?<name>.+?)(?:\s+please)?$/i;
const CALL_THIS =
  /^(?:(?:please|ok|okay)\s+)*call\s+(?:this|the\s+current)\s*(?:place|view|spot|location|position|area)?\s+(?<name>.+?)(?:\s+please)?$/i;

/** "Remember this place as home" needs no model: the name is in the sentence. */
export function deterministicRemember(text) {
  const value = String(text || '')
    .trim()
    .replace(/[.!?]+$/, '');
  const match = REMEMBER.exec(value) || CALL_THIS.exec(value);
  if (!match) return null;
  const name = match.groups.name
    .replace(/^["'\u201c\u2018]|["'\u201d\u2019]$/g, '')
    .replace(/^(?:my|the)\s+/i, '')
    .trim();
  if (!name || name.length > 40) return null;
  return { name: 'remember_place', arguments: { name } };
}

/** Spoken confirmation for a deterministic command, given its tool result. */
export function deterministicConfirmation(call, result) {
  if (!call) return '';
  if (call.name === 'fly_to_location') {
    const label = result?.label || flyToLabel(call.arguments.locationId);
    return `Flying to ${label}.`;
  }
  if (call.name === 'remember_place') {
    if (result?.ok === false)
      return `I could not save that: ${result.error || 'unknown error'}.`;
    return `Saved this view as ${result?.saved || call.arguments.name}.`;
  }
  return '';
}
