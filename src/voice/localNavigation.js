// Ordinary navigation is an application command. Small language models must not
// invent coordinates, camera distances or a narration in place of executing it.
export function localNavigationIntent(text) {
  let input = String(text)
    .trim()
    .replace(/[.!?]+$/u, '')
    .trim();
  input = input.replace(/^(?:пожалуйста[,\s]+|please\s+)/iu, '');
  const match = input.match(
    /^(?:(?:покажи(?:те)?|открой|найди|приблизь|перенеси(?:\s+меня)?|перемести(?:\s+меня)?|перелети|лети|давай\s+(?:полетим|перейдем|перейдём))\s+(?:мне\s+)?(?:(?:на\s+карте|к|в|на)\s+)?|(?:show(?:\s+me)?|find|open|take\s+me\s+to|fly\s+to|go\s+to|zoom\s+to)\s+)(.+)$/iu,
  );
  if (!match) return null;
  let query = match[1]
    .replace(/[,\s]+(?:пожалуйста|please)$/iu, '')
    .replace(/\s+(?:на\s+карте|on\s+the\s+map)$/iu, '')
    .trim();
  if (
    !query ||
    query.length > 160 ||
    /^(?:это|там|тут|сюда|туда|здесь|меня|е[её]|его|this|that|there|here|it)$/iu.test(
      query,
    )
  )
    return null;
  // Compound requests, descriptions, layers and relative camera commands need
  // the assistant. Do not misinterpret "show nearby aircraft" as a place name.
  if (
    /(?:^|\s)(?:и|затем|потом|как|где|что|почему|and|then|how|where|why)(?:\s|$)|[;\n]/iu.test(
      query,
    )
  )
    return null;
  if (
    /(?:^|\s)(?:самол[её]т\S*|борт\S*|рейс\S*|корабл\S*|суд\S*|спутник\S*|камер\S*|сло[йяи]\S*|пожар\S*|землетрясени\S*|трафик\S*|меню|панел\S*|радио|кабел\S*|поближе|подальше|ближе|дальше|всю\s+землю|землю|глобус|обзор|расскажи\S*|aircraft|flights?|ships?|vessels?|satellites?|cameras?|layers?|fires?|earthquakes?|traffic|menu|panel|radio|closer|further|earth|globe|overview|tell)(?:\s|$)/iu.test(
      query,
    )
  )
    return null;
  // Leave numeric height requests to the model; its navigation tool still uses
  // automatic framing and cannot inject an arbitrary distance.
  if (
    /(?:высот|расстояни|метр|километр|\d\s*(?:км|м)\b|\b(?:height|altitude|meters?|kilometers?)\b)/iu.test(
      query,
    )
  )
    return null;
  query = normalizeLocalPlaceQuery(query);
  return {
    query,
    waitForArrival: true,
    ...(/^(?:приблизь|zoom\s+to)/iu.test(input) ? { viewMode: 'close' } : {}),
  };
}

export function normalizeLocalPlaceQuery(query) {
  const text = String(query)
    .trim()
    .replace(/^["«]|["»]$/gu, '');
  if (
    /^красн(?:ая|ую|ой)\s+площад(?:ь|и)(?:(?:\s+в|,)\s*москв[аеу])?$/iu.test(
      text,
    )
  )
    return 'Красная площадь, Москва';
  if (/^red\s+square(?:,?\s+(?:in\s+)?moscow)?$/iu.test(text))
    return 'Red Square, Moscow';
  const cities = new Map([
    ['нью-йорк', 'New York'],
    ['нью йорк', 'New York'],
    ['ньюйорк', 'New York'],
    ['москву', 'Москва'],
    ['лондон', 'London'],
    ['париж', 'Paris'],
    ['токио', 'Tokyo'],
    ['дубай', 'Dubai'],
    ['вашингтон', 'Washington DC'],
    ['сан-франциско', 'San Francisco'],
    ['остин', 'Austin'],
  ]);
  return cities.get(text.toLowerCase()) || text;
}

export function localNavigationArguments(args, userText) {
  if (
    typeof args.query !== 'string' ||
    !args.query.trim() ||
    args.query.length > 160
  )
    throw new Error('fly_to_location requires a place name in query');
  const query = normalizeLocalPlaceQuery(args.query);
  if (/^[\d\s.,+\-]+$/u.test(query)) {
    const numbers = query.match(/[+-]?\d+(?:\.\d+)?/gu) || [];
    const requested = String(userText).match(/[+-]?\d+(?:\.\d+)?/gu) || [];
    if (
      numbers.length !== 2 ||
      !numbers.every((number) => requested.includes(number))
    )
      throw new Error('Use the requested place name, not invented coordinates');
  }
  // Ignore any extra camera fields, including those present in older history.
  // A model cannot override the geocoder or turn off arrival confirmation.
  return {
    query,
    waitForArrival: true,
    ...(/^(?:приблизь|zoom\s+to)/iu.test(String(userText).trim())
      ? { viewMode: 'close' }
      : {}),
  };
}

/** The application, not model-generated prose, confirms navigation outcomes. */
export function localNavigationReply(result, language) {
  const ru = language === 'ru';
  if (result?.cancelled)
    return ru ? 'Переход отменён.' : 'Navigation was cancelled.';
  if (result?.ok !== true)
    return ru
      ? 'Не удалось перейти к этому месту. Уточните название и город.'
      : 'Could not navigate there. Please specify the place and city.';
  if (result.arrived !== true)
    return ru
      ? 'Переход ещё не подтверждён.'
      : 'Arrival has not been confirmed.';
  const label = String(result.label || result.query || '')
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 200);
  return ru
    ? `Показываю: ${label || 'нужное место'}.`
    : `Showing ${label || 'the requested place'}.`;
}
