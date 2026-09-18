/**
 * src/voice/ondemand/intents.js — local fast-path intents for the OnDemand
 * voice pipeline. Pure functions over the transcript text: no DOM, no
 * network, no timers, so they run BEFORE any proxy call and keep working
 * when OnDemand is unavailable (the layer flips immediately; the spoken
 * answer is best-effort).
 *
 *   matchLayerIntents('show military flights near me')
 *     → [{ layerId: 'military', enabled: true, label: 'military flights', clause: '…' }]
 *
 * Layer ids are the DATA LAYERS panel ids the layer manager registers
 * (dataManager.setEnabled(id, bool, { origin: 'voice' })).
 */

/** Ordered: the more specific family (military) wins over the generic one (flights). */
export const LAYER_INTENTS = Object.freeze([
  {
    layerId: 'military',
    label: 'military flights',
    pattern:
      /\bmilitary\b|\bmil(?:itary)? (?:flights?|aircraft|planes?|traffic)\b|\bwarplanes?\b|\bfighter jets?\b/i,
  },
  {
    layerId: 'flights',
    label: 'live flights',
    pattern:
      /\b(?:live |civil |commercial |air )?(?:flights?|aircrafts?|airplanes?|planes?|air traffic|airliners?|jets?)\b/i,
  },
  {
    layerId: 'ais-live-vessels',
    label: 'live vessels',
    pattern: /\b(?:vessels?|ships?|boats?|shipping|maritime traffic|ais)\b/i,
  },
  {
    layerId: 'satellites',
    label: 'satellites',
    pattern: /\b(?:satellites?|sats|orbits?|orbital tracks?)\b/i,
  },
  {
    layerId: 'traffic',
    label: 'road traffic',
    pattern: /\b(?:road |street |car |vehicle )?traffic\b(?! control)/i,
    exclude: /\b(?:air|maritime|shipping) traffic\b/i,
  },
  {
    layerId: 'transit',
    label: 'transit',
    pattern:
      /\b(?:transit|buses|bus|trains?|subway|metro|light rail|rail|trams?|streetcars?)\b/i,
  },
  {
    layerId: 'bikeshare',
    label: 'bikeshare',
    pattern: /\b(?:bike ?share|bikes?|bicycles?|citi ?bike|cycle hire)\b/i,
  },
]);

const ENABLE_VERBS =
  /\b(?:show|enable|turn on|switch on|display|activate|bring up|put up|add|light up|pull up|reveal|start)\b/i;
const DISABLE_VERBS =
  /\b(?:hide|disable|turn off|switch off|remove|deactivate|kill|drop|clear|take off|stop showing|get rid of)\b/i;
const CLAUSE_SPLIT = /\s*(?:,|;|\bthen\b|\band\b|\bbut\b|\bplus\b)\s*/i;

/** Strip filler so "near me", "in the scene" etc. never confuse the verb scan. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[“”"']/g, '')
    .replace(
      /\b(?:please|can you|could you|would you|hey|ok|okay|now|just)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} text transcript
 * @returns {{layerId:string, enabled:boolean, label:string, clause:string}[]}
 */
export function matchLayerIntents(text) {
  const normalized = normalize(text);
  if (!normalized) return [];
  const results = [];
  const seen = new Set();
  let carriedVerb = null;
  for (const clause of normalized.split(CLAUSE_SPLIT)) {
    if (!clause) continue;
    const enable = ENABLE_VERBS.test(clause);
    const disable = DISABLE_VERBS.test(clause);
    let verb = null;
    if (enable && !disable) verb = true;
    else if (disable && !enable) verb = false;
    else if (enable && disable) {
      // both present: the later verb governs ("turn off flights and show ships" is split; here e.g. "show... remove")
      const enableAt = clause.search(ENABLE_VERBS);
      const disableAt = clause.search(DISABLE_VERBS);
      verb = enableAt > disableAt;
    } else verb = carriedVerb;
    if (verb === null) continue;
    carriedVerb = verb;
    for (const intent of LAYER_INTENTS) {
      if (seen.has(intent.layerId)) continue;
      if (intent.exclude && intent.exclude.test(clause)) continue;
      if (!intent.pattern.test(clause)) continue;
      // "military flights" must not ALSO enable the generic flights layer.
      if (intent.layerId === 'flights' && LAYER_INTENTS[0].pattern.test(clause))
        continue;
      seen.add(intent.layerId);
      results.push({
        layerId: intent.layerId,
        enabled: verb,
        label: intent.label,
        clause,
      });
    }
  }
  return results;
}

const SPATIAL_HINTS =
  /\b(?:near me|nearby|around (?:here|me|us)|in (?:the )?(?:scene|view|area|region|frame)|overhead|above (?:me|us)|what(?:'s| is| are)? (?:flying|happening|out there|moving|going on)|track|follow|investigate|anomal(?:y|ies|ous)|closest|nearest|find|where(?:'s| is| are)|fly (?:to|me)|take me|zoom|frame|look at|flights?|aircraft|planes?|vessels?|ships?|satellites?|military|traffic|transit|bikeshare|earthquakes?|fires?|launch(?:es)?|iss|cameras?|cctv|radio|layers?|map|scene|camera)\b/i;
const CHAT_HINTS =
  /^(?:who|why|explain|define|tell me about|what is a|what are|how does|history of|joke|hello|hi\b|thanks|thank you)/i;

/**
 * Pick the thinking route for a turn. 'workflow' when the utterance reads
 * like a spatial task (it triggers the OnDemand Spatial workflow alongside
 * the chat answer), otherwise 'chat'.
 * @returns {'workflow'|'chat'}
 */
export function classifyRoute(text) {
  const normalized = normalize(text);
  if (!normalized) return 'chat';
  if (CHAT_HINTS.test(normalized) && !SPATIAL_HINTS.test(normalized))
    return 'chat';
  return SPATIAL_HINTS.test(normalized) ? 'workflow' : 'chat';
}

/** Short spoken confirmation for the local fast path ("Military flights layer on."). */
export function localConfirmation(intents, { failed = [] } = {}) {
  if (!intents.length) return '';
  const parts = intents.map((intent) => {
    const bad = failed.find((f) => f.layerId === intent.layerId);
    if (bad) return `${capitalize(intent.label)} layer could not be changed`;
    return `${capitalize(intent.label)} layer ${intent.enabled ? 'on' : 'off'}`;
  });
  return `${parts.join('. ')}.`;
}

/**
 * Split a chat answer into spoken text and an optional MapAction list. The
 * fulfillment prompt asks the model to append one line
 * `MAPACTIONS: [{"name":…,"args":{…}}]`; a fenced ```json block carrying
 * `mapActions`/`actions` is also honoured. Malformed JSON is dropped, never
 * spoken.
 * @returns {{ text: string, mapActions: object[] }}
 */
export function extractMapActions(answer) {
  const raw = String(answer || '');
  if (!raw.trim()) return { text: '', mapActions: [] };
  let text = raw;
  let mapActions = [];
  const lineMatch =
    /(?:^|\n)\s*MAPACTIONS?\s*:\s*(\[[\s\S]*?\])\s*(?:\n|$)/i.exec(raw);
  if (lineMatch) {
    mapActions = safeParseArray(lineMatch[1]);
    text = raw.replace(lineMatch[0], '\n');
  } else {
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    if (fence) {
      const parsed = safeParseObject(fence[1]);
      const list = parsed?.mapActions ?? parsed?.actions;
      if (Array.isArray(list)) {
        mapActions = list;
        text = raw.replace(
          fence[0],
          parsed?.message ? String(parsed.message) : '',
        );
      }
    } else {
      const parsed = safeParseObject(raw);
      const list = parsed?.mapActions ?? parsed?.actions;
      if (parsed && Array.isArray(list)) {
        mapActions = list;
        text = typeof parsed.message === 'string' ? parsed.message : '';
      }
    }
  }
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), mapActions };
}

function safeParseArray(source) {
  try {
    const parsed = JSON.parse(source);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeParseObject(source) {
  const trimmed = String(source || '').trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function capitalize(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}
