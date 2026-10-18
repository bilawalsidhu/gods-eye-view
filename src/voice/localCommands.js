import {
  localNavigationIntent,
  localNavigationReply,
} from './localNavigation.js';
import { GEV_ACTION_SCHEMAS } from './actionSchemas.js';

const schemas = new Map(
  GEV_ACTION_SCHEMAS.map((schema) => [schema.name, schema.parameters]),
);
function validate(value, schema, path) {
  const type = Array.isArray(value)
    ? 'array'
    : value === null
      ? 'null'
      : typeof value;
  if (schema.type && type !== schema.type)
    throw new Error(`${path} must be ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value))
    throw new Error(`${path} has an unsupported value`);
  if (
    type === 'number' &&
    (!Number.isFinite(value) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity))
  )
    throw new Error(`${path} is outside the allowed range`);
  if (
    type === 'string' &&
    (value.length < (schema.minLength ?? 0) ||
      value.length > (schema.maxLength ?? 4000))
  )
    throw new Error(`${path} has an invalid length`);
  if (type === 'array') {
    if (
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? 100)
    )
      throw new Error(`${path} has an invalid number of items`);
    if (schema.items)
      value.forEach((item, index) =>
        validate(item, schema.items, `${path}[${index}]`),
      );
  }
  if (type === 'object') {
    for (const key of schema.required || [])
      if (!Object.hasOwn(value, key))
        throw new Error(`${path}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key))
        validate(item, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false)
        throw new Error(`${path}.${key} is not supported`);
    }
  }
}

const action = (name, args = {}) => ({ name, args });
const clean = (text) =>
  String(text)
    .trim()
    .replace(/^(?:пожалуйста[,\s]+|please\s+)/iu, '')
    .replace(/[,\s]+(?:пожалуйста|please)[.!?]*$/iu, '')
    .replace(/[.!?]+$/u, '')
    .trim();
const layerNames = [
  [
    'military',
    /^(?:военные\s+(?:самол[её]ты|борта)|military(?:\s+aircraft)?)$/iu,
  ],
  ['flights', /^(?:самол[её]ты|рейсы|авиацию|aircraft|planes|flights)$/iu],
  ['satellites', /^(?:спутники|satellites)$/iu],
  ['ais-live-vessels', /^(?:корабли|суда|ships|vessels)$/iu],
  ['local-firms', /^(?:пожары|fires)$/iu],
];

function singleCommand(raw) {
  const text = clean(raw);
  if (
    /^(?:стоп|останови(?:ть)?\s+(?:слежение|сопровождение)|прекрати\s+(?:следить|слежение)|перестань\s+следить|stop\s+(?:tracking|following))$/iu.test(
      text,
    )
  )
    return [action('stop_tracking')];
  if (
    /^(?:(?:покажи|открой)\s+(?:мне\s+)?(?:всю\s+)?(?:землю|глобус)|(?:show(?:\s+me)?\s+)?(?:the\s+)?(?:whole\s+)?(?:earth|globe))$/iu.test(
      text,
    )
  )
    return [action('zoom_to_globe')];
  const zoom = text.match(
    /^(?:(немного|чуть(?:-чуть)?|сильно|максимально)\s+)?(приблизь|приблизить|увеличь|отдали|отдалить|отдались|уменьши|поближе|ближе|подальше|дальше|zoom\s+in|zoom\s+out|closer|further)(?:\s+(?:камеру|карту|вид|масштаб|camera|map))?(?:\s+(немного|чуть(?:-чуть)?|сильно|максимально|поближе|подальше|a\s+little|a\s+lot))?$/iu,
  );
  if (zoom) {
    const modifier = `${zoom[1] || ''} ${zoom[3] || ''}`;
    return [
      action('adjust_camera_zoom', {
        direction: /^(?:отдал|умень|подаль|даль)|out|further/iu.test(zoom[2])
          ? 'out'
          : 'in',
        amount: /немного|чуть|little/iu.test(modifier)
          ? 'little'
          : /сильно|максимально|lot/iu.test(modifier)
            ? 'lot'
            : 'medium',
      }),
    ];
  }
  const nearest = text.match(
    /^(?:(?:покажи|найди|выбери|следи\s+за|начни\s+следить\s+за)\s+(?:мне\s+)?ближайш(?:ий|им)\s+(военн(?:ый|ым)\s+)?самол[её]т(?:ом)?|(?:show|find|select|follow|track)\s+(?:me\s+)?(?:the\s+)?nearest\s+(military\s+)?(?:aircraft|plane))(?:\s+(?:в|над|около|у|к|to|in|near|over)\s+(.+))?$/iu,
  );
  if (nearest)
    return [
      action('select_nearest_aircraft', {
        layerId: nearest[1] || nearest[2] ? 'military' : 'flights',
        ...(nearest[3] ? { locationQuery: nearest[3] } : {}),
      }),
    ];
  const follow = text.match(
    /^(?:следи\s+за|начни\s+следить\s+за|отслеживай|сопровождай|follow|track)(?:\s+the)?\s+(.+)$/iu,
  );
  if (follow) {
    let query = follow[1];
    if (
      /^(?:этим(?:\s+самол[её]том)?|ним|выбранным\s+самол[её]том|this(?:\s+(?:plane|aircraft))?|it|selected\s+aircraft)$/iu.test(
        query,
      )
    )
      return [
        action('get_entity_context', { scope: 'selected' }),
        { name: 'track_entity', selected: true },
      ];
    const layerId = /^(?:военн|military)/iu.test(query)
      ? 'military'
      : /^(?:спутник|satellite)/iu.test(query)
        ? 'satellites'
        : /^(?:корабл|судн|ship|vessel)/iu.test(query)
          ? 'ais-live-vessels'
          : 'flights';
    query = query
      .replace(
        /^(?:(?:военн\S*|military)\s+)?(?:самол[её]т\S*|борт\S*|рейс\S*|спутник\S*|корабл\S*|судн\S*|aircraft|plane|flight|satellite|ship|vessel)\s+/iu,
        '',
      )
      .trim();
    if (
      !query ||
      query.length > 100 ||
      /\s(?:котор|рядом|ближай|near|which|that)\S*/iu.test(query)
    )
      return null;
    return [action('track_entity', { query, layerId })];
  }
  const layer = text.match(
    /^(включи|покажи|отключи|выключи|скрой|enable|show|disable|hide)\s+(?:(?:слой|the)\s+)?(.+)$/iu,
  );
  if (layer) {
    const id = layerNames.find(([, pattern]) => pattern.test(layer[2]))?.[0];
    if (id)
      return [
        action('set_layer_visibility', {
          layerId: id,
          enabled: !/^(?:отключи|выключи|скрой|disable|hide)$/iu.test(layer[1]),
        }),
      ];
  }
  const navigation = localNavigationIntent(text);
  if (navigation) return [action('fly_to_location', navigation)];
  return null;
}

/** Recognize only complete commands. Unknown or ambiguous clauses go to Bonsai. */
export function localCommandPlan(text) {
  // "Find flight X and follow it" is one tracking intent, not two targets.
  const input = clean(text)
    .replace(
      /^(?:найди|покажи)\s+(?:мне\s+)?((?:самол[её]т|борт|рейс)\s+.+?)\s+и\s+(?:следи\s+за\s+ним|сопровождай\s+его)$/iu,
      'следи за $1',
    )
    .replace(
      /^(?:find|show)\s+(?:me\s+)?((?:flight|aircraft|plane)\s+.+?)\s+and\s+(?:follow|track)\s+it$/iu,
      'follow $1',
    );
  const parts = input.split(
    /\s*(?:;|,?\s+(?:и\s+затем|а\s+затем|а\s+потом|и|затем|потом|and\s+then|and|then)\s+)\s*/iu,
  );
  if (parts.length > 4 || parts.some((part) => !part)) return null;
  const plans = parts.map(singleCommand);
  return plans.every(Boolean) ? plans.flat() : null;
}

export function selectedTrackingArguments(result) {
  const selected = result?.selected;
  if (
    !selected ||
    !['flights', 'military', 'satellites', 'ais-live-vessels'].includes(
      selected.layerId,
    )
  )
    throw new Error('Select an aircraft, ship or satellite first');
  const props = selected.properties || {};
  const query =
    props.icao24 ||
    props.callsign ||
    props.noradId ||
    props.mmsi ||
    selected.name ||
    selected.label;
  if (!query) throw new Error('The selected object has no tracking identifier');
  return { layerId: selected.layerId, query: String(query) };
}

/** Used for both generated and direct tracking: a disabled layer is not a missing plane. */
export async function runLocalAction(name, args, runAction, signal) {
  signal?.throwIfAborted();
  const schema = schemas.get(name);
  if (!schema) throw new Error('Unknown map action');
  validate(args, schema, name);
  if (name === 'track_entity' && args.layerId) {
    if (
      ![
        'flights',
        'military',
        'satellites',
        'ais-live-vessels',
        'local-firms',
      ].includes(args.layerId)
    )
      throw new Error('Unsupported tracking layer');
    const enabled = await runAction(
      'set_layer_visibility',
      { layerId: args.layerId, enabled: true },
      { signal },
    );
    signal?.throwIfAborted();
    if (enabled?.ok !== true)
      return {
        ok: false,
        action: name,
        error: enabled?.error || 'Could not enable the tracking layer',
      };
  }
  return runAction(name, args, { signal });
}

export function localActionReply(name, args, result, language) {
  if (name === 'fly_to_location') return localNavigationReply(result, language);
  const ru = language === 'ru';
  if (result?.cancelled) return ru ? 'Команда отменена.' : 'Command cancelled.';
  if (result?.ok !== true)
    return ru
      ? `Не удалось выполнить команду.${name === 'track_entity' ? ' Борт не найден в доступных данных; проверьте позывной и область карты.' : ''}`
      : `Could not complete the command.${name === 'track_entity' ? ' No matching contact in the available data; check its callsign and the map area.' : ''}`;
  const label = String(result.label || args.query || '').slice(0, 120);
  if (name === 'track_entity' || name === 'select_nearest_aircraft')
    return ru
      ? `Слежу за ${label || 'выбранным самолётом'}.`
      : `Tracking ${label || 'the selected aircraft'}.`;
  if (name === 'stop_tracking')
    return ru ? 'Слежение остановлено.' : 'Tracking stopped.';
  if (name === 'adjust_camera_zoom')
    return ru
      ? args.direction === 'in'
        ? 'Приближаю.'
        : 'Отдаляю.'
      : args.direction === 'in'
        ? 'Zooming in.'
        : 'Zooming out.';
  if (name === 'zoom_to_globe')
    return ru ? 'Показываю Землю.' : 'Showing the globe.';
  if (name === 'set_layer_visibility')
    return ru
      ? `Слой ${result.label || args.layerId} ${args.enabled ? 'включён' : 'выключен'}.`
      : `Layer ${result.label || args.layerId} ${args.enabled ? 'enabled' : 'disabled'}.`;
  return ru ? 'Готово.' : 'Done.';
}

/** Bounded utterances keep Piper's activation buffers independent of answer length. */
export function localSpeechChunks(text, limit = 240) {
  const chunks = [];
  let rest = String(text).trim().slice(0, 6000);
  while (rest.length > limit) {
    const prefix = rest.slice(0, limit + 1);
    const sentence = [...prefix.matchAll(/[.!?;]\s/gu)].at(-1)?.index;
    const end =
      sentence != null && sentence > limit / 3
        ? sentence + 1
        : prefix.lastIndexOf(' ') > 0
          ? prefix.lastIndexOf(' ')
          : limit;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
