# Russian (`ru`)

Catalog: `src/i18n/locales/ru.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

## Style

- Address the user with polite imperatives: «Нажмите», «Включите», «Попробуйте снова».
- Sentence case, not Title Case: "Live Flights" → «Рейсы в реальном времени».
- Quotes inside Russian text are «ёлочки». Write ё where it belongs: её, ещё, всё.
- In short labels, a standard abbreviation with a period beats a wrapped line: НЕОПРЕД., СЛЕД.
- Units: км, м, км/ч, м/с, уз (knots), фт (feet), ч, мин, с; in UPPERCASE text КМ, М, КМ/С, УЗ, ФТ. MW is МВт in any case. `°` and `%` stay.

## Plurals

A `tn()` entry needs four forms. `Intl.PluralRules('ru')` picks:

| Form    | Counts                   | Example    |
| ------- | ------------------------ | ---------- |
| `one`   | 1, 21, 31, 101…          | 1 камера   |
| `few`   | 2–4, 22–24, 32–34…       | 3 камеры   |
| `many`  | 0, 5–20, 25–30, 111–114… | 5 камер    |
| `other` | fractions: 1.5, 2.25…    | 1,5 камеры |

When a word next to a number cannot agree in every form, move the number after a colon instead: «доступно {bikes}», «ответов: {responses}». The same trick keeps place names and tool names out of a preposition's case: «откуда: {origin}», «Активно: {name}».

## Glossary

| English                                     | Русский                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| layer / data layer                          | слой / слой данных                                                 |
| feed                                        | поток данных (short: поток)                                        |
| source / data source                        | источник / источник данных                                         |
| LIVE (status) / live data                   | ОНЛАЙН / в реальном времени                                        |
| SIMULATED                                   | СИМУЛЯЦИЯ                                                          |
| stale / degraded / unavailable              | устарел / с перебоями / недоступен                                 |
| retry                                       | повтор                                                             |
| key (API key) / POWER UP                    | ключ / ЗАПУСК                                                      |
| Provider Settings                           | Настройки провайдеров                                              |
| globe / map / map source                    | глобус / карта / источник карты                                    |
| aircraft / flight / military flights        | самолёт (short HUD: борт) / рейс / военные рейсы                   |
| vessel, ship / vessels                      | судно / суда                                                       |
| satellite                                   | спутник                                                            |
| launch (rocket) / space mission             | пуск / космическая миссия                                          |
| contact / tracking                          | контакт / отслеживание                                             |
| installation, site                          | объект                                                             |
| camera / CCTV camera                        | камера / камера CCTV                                               |
| earthquake / active fire                    | землетрясение / активный пожар                                     |
| scene / shot / scene recipe                 | сцена / кадр / рецепт сцены                                        |
| briefing / panel / dock                     | брифинг / панель / док                                             |
| preset / visual preset                      | пресет / визуальный пресет                                         |
| Scope (circular viewport mask)              | прицел                                                             |
| heading / altitude / ground speed           | курс / высота / путевая скорость                                   |
| HDG / BRG / CRS / FOV / DEST / SPD / RANGE  | КУРС / ПЕЛ. / ПУТЬ / ОБЗОР / НАЗН. / СКОР / ДАЛЬН.                 |
| advisory (NHC/CPHC cyclone)                 | сводка (не «бюллетень»); Advisory center — центр циклона по сводке |
| Street View (Google)                        | Просмотр улиц (как в русских Google Картах)                        |
| CONUS (NOAA region code)                    | CONUS, без перевода                                                |
| WHOT/BHOT, Ironbow (thermal modes, palette) | без перевода                                                       |
| PREV / NEXT                                 | ПРЕД. / СЛЕД.                                                      |
| Previous / Next (button text)               | Назад / Далее                                                      |
| anchor / data pack / bundle (scene)         | якорь / пакет данных / архив                                       |
| basemap / box (Recent Imagery area)         | подложка / область                                                 |
| camera move                                 | перелёт                                                            |
| SIG / NEWS / LOCAL (briefing tabs)          | СИГН. / НОВОСТИ / МЕСТН.                                           |
| compass points (N, NNE, …)                  | С, ССВ, …                                                          |
| L / R (relative bearing)                    | Л / П                                                              |
