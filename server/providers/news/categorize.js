// Rule-based report categories, relevance and severity: the News layer's
// base reading, shared by every news server. Multilingual stems (en, uk, ru,
// ar, he and more) matched at a word start on normalised text; a trailing `$`
// makes a stem whole-word. A title hit counts double. Ties go to the earlier
// category in CATEGORY_ORDER, which runs from most to least specific.
//
// A news server may replace these readings with its own; the rules stay
// as the fallback.

/** Text as the rules match it: folded case, one apostrophe, no vowel marks. */
function normaliseForMatch(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[’ʼ`´]/g, "'")
    .replace(/[ً-ٰٟ֑-ׇ]/g, '')
    .replace(/[أإآ]/g, 'ا');
}

export const CATEGORY_ORDER = Object.freeze([
  'strike',
  'alert',
  'air-defence',
  'ground',
  'casualties',
  'humanitarian',
  'infrastructure',
  'disaster',
  'protest',
  'political',
  // Business and trade: the rules' reading, or World News API's business.
  'economy',
]);

// [stem, weight]; weight defaults to 1.
const RULES = {
  strike: [
    'strike',
    'airstrike',
    'air strike',
    'missile',
    'rocket',
    'drone',
    'shelling',
    'shelled',
    'bomb',
    'explosion',
    'blast',
    'artillery',
    'shahed',
    ['attack', 0.5],
    'удар',
    'ракет',
    'дрон',
    'бпла',
    'обстріл',
    'обстрел',
    'вибух',
    'взрыв',
    'шахед',
    'бомб',
    ['атак', 0.5],
    'غارة',
    'غارات',
    'قصف',
    'صاروخ',
    'صواريخ',
    'مسيرة',
    'انفجار',
    ['استهداف', 0.7],
    ['هجوم', 0.5],
    'תקיפה',
    'טיל',
    'רקט',
    'כטב"מ',
    'פיצוץ',
    'הפצצ',
  ],
  'air-defence': [
    'air defen',
    'intercept',
    'shot down',
    'downed',
    'air raid',
    'ппо',
    'збит',
    'сбит',
    'перехоп',
    'перехват',
    'повітряна тривога',
    'воздушная тревога',
    'الدفاع الجوي',
    'اعتراض',
    'יירוט',
    'יורט',
    'כיפת ברזל',
    'אזעק',
  ],
  ground: [
    'advance$',
    'advances$',
    'advancing',
    'offensive',
    'captur',
    'liberat',
    'assault',
    'clash',
    'fighting',
    'counteroffensive',
    'frontline',
    'front line',
    'battle',
    'encircl',
    ['troops', 0.5],
    'наступ',
    'штурм',
    'звільн',
    'освобо',
    'бої$',
    'бои$',
    'контрнаступ',
    'захоп',
    'захват',
    'оточ',
    'окруж',
    'продвиж',
    'просуван',
    'اشتباك',
    'معارك',
    'تقدم',
    'سيطر',
    'اقتحام',
    'توغل',
    'לחימה',
    'קרב',
    'פשיט',
    'תמרון',
  ],
  casualties: [
    'killed',
    'dead$',
    'deaths',
    'wounded',
    'injured',
    'casualt',
    'death toll',
    'загин',
    'поранен',
    'жертв',
    'вбит',
    'погиб',
    'ранен',
    'убит',
    'قتلى',
    'شهداء',
    'شهيد',
    'جرحى',
    'مقتل',
    'اصاب',
    'הרוג',
    'נהרג',
    'פצוע',
    'נפצע',
  ],
  humanitarian: [
    'evacuat',
    'aid$',
    'refugee',
    'displac',
    'humanitarian',
    'famine',
    'hunger',
    'convoy',
    'shelter',
    'евакуац',
    'эвакуац',
    'гуманітар',
    'гуманитар',
    'біженц',
    'беженц',
    'انسانية',
    'نازح',
    'نزوح',
    'مساعدات',
    'اجلاء',
    'مجاعة',
    'הומניטרי',
    'פינוי',
    'סיוע',
  ],
  infrastructure: [
    'power outage',
    'blackout',
    'electricity',
    'energy',
    'grid$',
    'substation',
    'water supply',
    'bridge',
    'railway',
    'refinery',
    'port$',
    'dam$',
    'power plant',
    'енерг',
    'энерг',
    'знеструм',
    'обесточ',
    'підстанц',
    'подстанц',
    'залізниц',
    'железн',
    'нпз',
    'الكهرباء',
    'محطة',
    'مياه',
    'جسر',
    'חשמל',
    'תשתית',
  ],
  disaster: [
    'earthquake',
    'flood',
    'wildfire',
    'landslide',
    'cyclone',
    'hurricane',
    'typhoon',
    'tsunami',
    'eruption',
    'glof$',
    'glacial lake',
    'storm$',
    'lightning',
    'землетрус',
    'землетрясен',
    'повін',
    'паводк',
    'наводнен',
    'زلزال',
    'فيضان',
    'سيول',
    'רעידת אדמה',
    'שיטפון',
  ],
  protest: [
    'protest',
    'demonstrat',
    'rally$',
    'rallies',
    'riot',
    // Not a bare "протест": "протестировал" is "tested".
    'протест$',
    'протеста',
    'протесту',
    'протестом',
    'протесте$',
    'протесты',
    'протестов',
    'протестн',
    'протестую',
    'протестова',
    'мітинг',
    'митинг',
    'احتجاج',
    'مظاهر',
    'تظاهر',
    'הפגנ',
    'מחאה',
  ],
  political: [
    'talks$',
    'negotiat',
    'sanction',
    'summit',
    'ceasefire',
    'truce',
    'peace',
    'election',
    'parliament',
    ['president', 0.5],
    ['minister', 0.5],
    ['statement', 0.5],
    // A state visit ("Emir of Qatar arrives in Amman").
    ['visit', 0.5],
    ['delegation', 0.5],
    ['agreement', 0.5],
    'memorandum',
    'diplomat',
    'bilateral',
    'ambassador',
    ['визит', 0.5],
    ['делегац', 0.5],
    'дипломат',
    'переговор',
    'санкц',
    'перемир',
    'вибори',
    'выборы',
    ['президент', 0.5],
    ['міністр', 0.5],
    ['министр', 0.5],
    'مفاوضات',
    'عقوبات',
    'هدنة',
    'وقف اطلاق النار',
    ['وزير', 0.5],
    ['رئيس', 0.5],
    'משא ומתן',
    'הפסקת אש',
    'סנקצי',
    ['ראש הממשלה', 0.5],
  ],
  // Elections and party politics ("How Gina Hinojosa Captured Texas" is a
  // governor's race, not a battle). They count toward political only when
  // nothing physical happened (categorizeText): a strike in an election week
  // is still a strike.
  election: [
    'midterm',
    'electoral',
    'elect$',
    'ballot',
    'voter',
    'vote$',
    'votes$',
    'voting',
    'polls$',
    'candidate',
    'senate race',
    'referendum',
    'inaugurat',
    // Plurals only: "Democratic Republic of Congo", "Republican Guard".
    'democrats$',
    'republicans$',
    'gop$',
    'избира',
    'голосован',
    'виборц',
    'голосуван',
    'انتخاب',
    'בחירות',
  ],
};

// Business, trade, industry and energy, counted only when nothing physical
// happened (categorizeText): an oil depot struck is a strike. English,
// Russian, Ukrainian, Turkish and the European stems.
RULES.economy = [
  'econom',
  'gdp$',
  'inflation',
  'investment',
  'investor',
  'export',
  'imports$',
  'import$',
  'tariff',
  'trade deal',
  'trade turnover',
  'central bank',
  'stock market',
  'budget',
  'oil and gas',
  'oilfield',
  'oil field',
  'gas field',
  'exploration',
  'drilling',
  'mining',
  'industr',
  'manufactur',
  'business',
  'company',
  'companies',
  'revenue',
  'profit',
  'merger',
  'tourism',
  'agricultur',
  'harvest',
  'экономи',
  'инвест',
  'экспорт',
  'импорт',
  'инфляц',
  'ввп$',
  'бюджет',
  'промышлен',
  'бизнес',
  'компани',
  'товарооборот',
  'економі',
  'інвест',
  'експорт',
  'промисло',
  'ekonomi',
  'yatırım',
  'ihracat',
  'ithalat',
  'enflasyon',
  'sanayi',
  'şirket',
  'wirtschaft',
  'konjunktur',
  'unternehm',
  'inversi',
  'investiss',
  'investiment',
  'empresa',
  'entreprise',
  'impresa',
];

// Attack words beyond PHYSICAL's harm, which keep a report off economy.
const ATTACK = new RegExp(
  String.raw`(?<![\p{L}])(?:attack|assault|target|hit(?![\p{L}])|fire|plot|war(?![\p{L}])|wartime|атак|удар|пораж|пожар|обстр|війн|войн|هجوم|استهداف|حرب|מתקפ|ataque|attaque|attacco|angriff|saldır)`,
  'u',
);

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Spanish, French, Portuguese, Italian and German stems, for outlets that
// report in their own language (a train crash in Spain, in Spanish).
const EUROPEAN = {
  strike: [
    'bombarde',
    'misil',
    'míssil',
    'dron$',
    'explosión',
    'explosão',
    'esplosi',
    'ataque',
    'attaque',
    'attacco',
    'angriff',
    'rakete',
    'luftangriff',
  ],
  'air-defence': ['antiaére', 'défense aérienne', 'flugabwehr', 'abatid'],
  ground: [
    'combate',
    'combats',
    'enfrentamiento',
    'affrontement',
    'scontri',
    'gefecht',
  ],
  casualties: [
    'muert',
    'fallecid',
    'herid',
    'morts$',
    'tué',
    'blessé',
    'morti',
    'ferit',
    'mortos',
    'ferido',
    'muere',
    'mueren',
    'fallece',
    'meurt',
    'morre',
    'tote$',
    'verletzt',
    'víctimas',
    'victimes',
    'vittime',
  ],
  humanitarian: [
    'evacua',
    'évacu',
    'refugiad',
    'réfugi',
    'flüchtling',
    'desplazad',
  ],
  infrastructure: [
    'apagón',
    'panne',
    'blackout',
    'descarril',
    'déraill',
    'deragliament',
    'entgleis',
    'accidente',
    'accident',
    'incidente',
    'choque',
    'collision',
    'collisione',
    'zusammenstoß',
    'incendio',
    'incendie',
  ],
  disaster: [
    'terremoto',
    'séisme',
    'tremblement',
    'erdbeben',
    'inundaci',
    'inondation',
    'alluvion',
    'überschwemm',
    'huracán',
    'ouragan',
    'uragano',
    'tormenta',
    'tempête',
    'tempesta',
    'sturm',
    'cicl',
    'erupci',
    'éruption',
    'eruzione',
  ],
  protest: [
    'protesta',
    'manifesta',
    'disturbio',
    'émeute',
    'huelga',
    'grève',
    'sciopero',
    'streik',
    'demonstration',
  ],
};
for (const [category, stems] of Object.entries(EUROPEAN))
  RULES[category] = [...(RULES[category] || []), ...stems];

const COMPILED = Object.entries(RULES).map(([category, stems]) => ({
  category,
  rules: stems.map((entry) => {
    const [stem, weight = 1] = Array.isArray(entry) ? entry : [entry];
    const whole = stem.endsWith('$');
    const body = escapeRegex(
      normaliseForMatch(whole ? stem.slice(0, -1) : stem),
    ).replace(/\s+/g, '\\s+');
    const arabic = /\p{Script=Arabic}/u.test(stem) ? '(?:[وفبلك]?(?:ال)?)' : '';
    const hebrew = /\p{Script=Hebrew}/u.test(stem) ? '(?:[ובלמהשכ]{0,2})' : '';
    return {
      weight,
      regex: new RegExp(
        `(?<![\\p{L}\\p{N}])${arabic}${hebrew}${body}${whole ? '(?![\\p{L}\\p{N}])' : ''}`,
        'u',
      ),
    };
  }),
}));

const EVENT_CATEGORIES = new Set([
  'strike',
  'air-defence',
  'ground',
  'casualties',
  'disaster',
]);
// Words that tie a report to armed conflict or crisis, whatever its category
// (en, fr, ru, uk, ar, he, es).
const CONFLICT_TERMS = new RegExp(
  [
    'war',
    'army',
    'military',
    'militar',
    'troops',
    'soldier',
    'militant',
    'jihad',
    'terror',
    'insurg',
    'rebel',
    'ceasefire',
    'truce',
    'hostage',
    'sanction',
    'shell',
    'drone',
    'missile',
    'airstrike',
    'frappe',
    'armée',
    'soldat',
    'djihad',
    'fama',
    'jnim',
    'houthi',
    'hezbollah',
    'hamas',
    'irgc',
    'rsf',
    'wagner',
    'africa corps',
    'войн',
    'війн',
    'армі',
    'арми',
    'всу',
    'зсу',
    'бпла',
    'обстр',
    'фронт',
    'حرب',
    'الجيش',
    'هجوم',
    'قصف',
    'الحوثي',
    'مسلح',
    'מלחמה',
    'צה"ל',
    'guerra',
    'ejército',
    // Violence, coercion and their aftermath.
    'massacre',
    'atrocit',
    'genocide',
    'arms',
    'weapon',
    'detain',
    'abduct',
    'kidnap',
    'air raid',
    'alert',
    'jamming',
    'тривог',
    'тревог',
    'відбій',
    'отбой',
    'occupied',
    'occupation',
    'territor',
    'convoy',
    'demining',
    'forces',
    'raid',
    'conflict',
    'putin',
    'zelensk',
    'окуп',
    'оккуп',
    // Diplomacy and strategic stakes of the conflict.
    'ambassador',
    'mediat',
    'election',
    'talks',
    'negotiat',
    'envoy',
    'diplomat',
    'foreign minister',
    'condemn',
    'nuclear',
    'hormuz',
    'blockade',
    'négociation',
    'переговор',
    'перемир',
    'مفاوضات',
    'هدنة',
  ]
    // Short words are whole words ("war" is not "warning" or "Warsaw").
    .map((w) => `(?<![\\p{L}])${w}${w.length < 5 ? '(?![\\p{L}])' : ''}`)
    .join('|'),
  'iu',
);

/**
 * How much a report matters to its hotspot, by rule: `core` for a physical conflict or crisis event, `related` for
 * news tied to the conflict (by wording, or because the source covers
 * nothing else), `minor` for the rest of what a broad outlet publishes
 * (prices, sport, health, culture).
 */
const termPatterns = new Map();
/** A word-start pattern for a hotspot term ("pow" must not match "power"). */
function termPattern(term) {
  if (!termPatterns.has(term))
    termPatterns.set(
      term,
      new RegExp(
        // Short terms are whole words ("pow" is not "power"); longer ones are
        // stems ("mobiliz" → mobilized, mobilization).
        `(?<![\\p{L}])${normaliseForMatch(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${term.length < 5 ? '(?![\\p{L}])' : ''}`,
        'u',
      ),
    );
  return termPatterns.get(term);
}

export function relevanceOf({
  category,
  tags = [],
  title = '',
  summary = '',
  dedicated = false,
  relatedTerms = [],
  floor = 'minor',
}) {
  const text = normaliseForMatch(`${title} ${summary}`);
  // A hotspot's own vocabulary counts as conflict wording there (Iran:
  // "Qalibaf", "IAEA"; Israel: "settler"; Ukraine: "prisoner exchange").
  const conflict =
    CONFLICT_TERMS.test(text) ||
    relatedTerms.some((term) => termPattern(term).test(text));
  // Any event reading counts, even when another category wins the title
  // ("the accident toll rises to 74": infrastructure first, casualties too).
  if (
    EVENT_CATEGORIES.has(category) ||
    tags.some((tag) => EVENT_CATEGORIES.has(tag))
  )
    return 'core';
  if (conflict && ['humanitarian', 'infrastructure'].includes(category))
    return 'core';
  if (conflict || dedicated || category === 'humanitarian') return 'related';
  return floor;
}

// Alerts: air-raid alerts and reports of drones or missiles on their way
// ("Реактивний БпЛА курсом на Полтаву", "КАБи на Донеччину", "drone heading
// for Kyiv", "➡️"). Something is in the air; nothing has hit yet. Most of an
// air force's channel is these, and as "strikes" they would merge into real
// strike events and inflate them.
// A direction counts only after a weapon ("БпЛА … з півдня"), so a convoy
// leaving "in the direction of Oleshky" is not an alert.
const WEAPON =
  '(?:бпла|дрон|шахед|герань|ракет|каб|балістик|крилат|боєприпас|боеприпас|uav|drone|missile|shahed|ballistic|cruise|munition)';
const DIRECTION =
  '(?:курсом на|у напрямку|в напрямку|в направлении|у бік|в сторону|повз |з (?:північ|півден|схід|сход|захід|заход)|с (?:север|юг|восток|запад)|на |над |heading |on course|toward)';
const ALERT = new RegExp(
  `${WEAPON}[^.!?]{0,40}${DIRECTION}|^[^\\p{L}]*курсом на|тривог|тревог|загроза застосування|угроза применения|air[- ]raid|threat of (?:missile|drone|ballistic|uav)|[➡⬅⬆⬇↗↘↙↖]`,
  'u',
);
// Wording that something did hit: then it is a strike (or air defence), not an alert.
const IMPACT =
  /влуч|вибух|уражен|пошкодж|загин|поранен|зруйн|пожеж|атак|удар по|збит|знищ|попадан|взрыв|поражен|поврежд|погиб|ранен|разруш|сбит|уничтож|\bhit\b|\bhits\b|struck|explosion|blast|killed|injur|wounded|damage|destroy|fire\b|shot down|intercept|attack/u;

/** Whether a report's title is an alert: a threat on its way, nothing hit yet. */
function isAlertText(title = '', summary = '') {
  const t = normaliseForMatch(`${title} ${summary}`.slice(0, 400));
  return ALERT.test(t) && !IMPACT.test(t);
}

// "Hit" or "struck" says nothing on its own: what hit decides (a missile is a
// strike, a flood or lightning a disaster), and those words score by
// themselves. A few phrases use a category's word for another thing.
const PHRASES = [
  [/storm shadow/gu, 'missile'],
  [/lightning strikes?/gu, 'lightning'],
  [
    /(?:general|hunger|labou?r|workers?|nationwide|national|transport|rail|teachers?|doctors?|nurses?) strikes?|on strike|strike action/gu,
    'protest',
  ],
];
const rephrase = (text) =>
  PHRASES.reduce((out, [re, word]) => out.replace(re, word), text);

// An election story borrows the words of war and disaster ("‘An Earthquake’:
// A Democratic Rout", "captured Texas", "a bloodbath for Republicans"). With
// election wording and nothing physical (no weapon, no one hurt, no quake's
// magnitude), the event categories give way to political.
const ELECTION =
  /(?<![\p{L}])(?:election|midterm|electoral|ballot|voters?(?![\p{L}])|votes?(?![\p{L}])|voting|polls(?![\p{L}])|senate race|referendum|democrats|republicans|gop(?![\p{L}])|[\p{L}]+-elect(?![\p{L}])|выбор|избира|вибор|голосув|голосов|انتخاب|בחירות)/u;
const PHYSICAL =
  /(?<![\p{L}])(?:kill|dead(?![\p{L}])|fighting|clash|air ?strike|strikes?(?![\p{L}])|struck|destroy|downed|ablaze|on fire|catch(?:es)? fire|caught fire|naval mine|landmine|shot down|sunk|sank|deaths?|injur|wounded|casualt|troops|soldier|missile|drone|rocket|shell(?:ing|ed)|artiller|explosi|blast|bomb|gunfire|shot(?![\p{L}])|shooting|magnitude|richter|tremor|evacuat|flood(?:ed|ing|waters)|убит|погиб|ранен|ракет|дрон|обстрел|загин|поранен|обстріл|قتل|جرح|صاروخ|הרג|פצוע|טיל)/u;
/** The categories of a physical event (an alert is a threat, not yet one). */
const EVENT_KINDS = new Set([
  'strike',
  'air-defence',
  'ground',
  'casualties',
  'disaster',
  'infrastructure',
]);

/**
 * Categorise a report from its title and summary.
 * @returns {{category: string, tags: string[]}}
 */
export function categorizeText({ title = '', summary = '' } = {}) {
  if (isAlertText(title)) return { category: 'alert', tags: ['alert'] };
  const t = rephrase(normaliseForMatch(title));
  const s = rephrase(normaliseForMatch(summary));
  const scores = new Map();
  for (const { category, rules } of COMPILED) {
    let score = 0;
    for (const { regex, weight } of rules) {
      if (regex.test(t)) score += 2 * weight;
      else if (regex.test(s)) score += weight;
    }
    if (score > 0) scores.set(category, score);
  }
  const all = `${t} ${s}`;
  const election = scores.get('election') || 0;
  scores.delete('election');
  const physical = PHYSICAL.test(all);
  // Business words and no harm or attack: "advance exploration" is no
  // front-line advance; "attack an industrial facility" stays a strike.
  if (physical || ATTACK.test(all)) scores.delete('economy');
  else if (scores.has('economy'))
    for (const kind of EVENT_KINDS) scores.delete(kind);
  if (!physical) {
    if (election)
      scores.set('political', (scores.get('political') || 0) + election);
    if (ELECTION.test(all)) {
      for (const kind of EVENT_KINDS) scores.delete(kind);
      scores.set('political', Math.max(scores.get('political') || 0, 1));
    }
  }
  if (!scores.size) return { category: 'other', tags: [] };
  const ranked = CATEGORY_ORDER.filter((c) => scores.has(c)).sort(
    (a, b) => scores.get(b) - scores.get(a),
  );
  return { category: ranked[0], tags: ranked };
}

// Severity by rule, for reports without a severity of their own (0 none,
// 1 minor incident, 2 significant: deaths, injuries or real damage, 3 major:
// mass casualties). Wording in en, uk, ru, ar, he, es, fr, de.
const SEVERITY_EVENTS = new Set([...EVENT_CATEGORIES, 'infrastructure']);
const MAJOR_HARM =
  /mass casualt|massacre|dozens (?:of \p{L}+ )?(?:killed|dead)|hundreds (?:of \p{L}+ )?(?:killed|dead)|масов\p{L}* (?:жертв|загибел|гибел)|десятки (?:загибл|погибш|убит|вбит|людей загин|человек погиб)|مجزرة|عشرات (?:القتلى|الشهداء)|טבח/u;
const HARM_WORDS =
  'kill|dead|died|death|injur|wound|casualt|загин|загибл|погиб|убит|вбит|поранен|ранен|постражд|пострадал|травм|قتل|قتيل|شهيد|شهداء|جرح|جريح|إصاب|اصاب|נהרג|הרוג|פצוע|muert|herid|tué|mort|bless|getötet|tote|verletz';
const HARM = new RegExp(String.raw`(?<![\p{L}])(?:${HARM_WORDS})`, 'u');
// "No casualties", "без жертв": the harm word is there, the harm is not.
const NO_HARM =
  /(?:no|without|zero) (?:casualt|injur|deaths|victims|one (?:was )?(?:hurt|injured))|без (?:жертв|постраждал|пострадавш|загибл|погибш)|не постраждал|не пострадал|لا (?:إصابات|اصابات)|אין נפגעים|sin (?:víctimas|heridos)|sans (?:victime|blessé)/u;
const DAMAGE =
  /destroy|damag|ablaze|on fire|fire broke|explosion|collapse|зруйн|разруш|пошкодж|поврежд|пожеж|пожар|вибух|взрыв|دمار|تدمير|انفجار|حريق|הרס|פיצוץ|שריפה|destru|incendi|explos|zerstör/u;
// An age ("a 71-year-old woman", "71-річна", "71-летний") is not a count.
const NUMBER = String.raw`(\d{1,3}(?:[,.\s]\d{3})+|\d{1,5})(?![\d,.]*[-\s]*(?:year|yr|річн|рок|летн|год))`;
const COUNTS = [
  // "14 killed", "three people dead" is left to the words; "14 civilians dead".
  new RegExp(String.raw`${NUMBER}\s+(?:\p{L}+\s+){0,2}(?:${HARM_WORDS})`, 'gu'),
  // "killing 14", "death toll rises to 74", "kills at least 20".
  new RegExp(
    String.raw`(?:kill\p{L}*|toll\p{L}*(?:\s+\p{L}+){0,3}|загинул\p{L}*|погибл\p{L}*|жертв\p{L}*)\s+(?:at least\s+|не менее\s+|щонайменше\s+|до\s+|to\s+)?${NUMBER}`,
    'gu',
  ),
];

function largestCount(text) {
  let most = 0;
  for (const pattern of COUNTS)
    for (const match of text.matchAll(pattern)) {
      const n = Number(match[1].replace(/[,.\s]/g, ''));
      // A year ("since 2022 killed…") is not a toll.
      if (n < 1900 || n > 2100) most = Math.max(most, n);
    }
  return most;
}

/** A report's severity by rule, 0–3. */
export function severityByRules({
  category,
  tags = [],
  title = '',
  summary = '',
}) {
  const text = normaliseForMatch(`${title} ${summary}`);
  const harmed = HARM.test(text) && !NO_HARM.test(text);
  if (MAJOR_HARM.test(text) || (harmed && largestCount(text) >= 10)) return 3;
  const event =
    SEVERITY_EVENTS.has(category) ||
    tags.some((tag) => SEVERITY_EVENTS.has(tag));
  if (harmed && (event || category === 'humanitarian')) return 2;
  if (event && DAMAGE.test(text)) return 2;
  return event ? 1 : 0;
}
