# Ukrainian (`uk`)

Catalog: `src/i18n/locales/uk.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

Translation source: meirm (#312).

## Style

- Address the user with polite imperatives: «Натисніть», «Увімкніть», «Спробуйте ще раз».
- Sentence case, not Title Case: "Live Flights" → «Рейси онлайн».
- Ukrainian norms, not Russian calques: «у радіусі», «за посиланням», «надто довгий», «потім», «вигляд» (a camera view: «вигляд згори»), «стеження» (tracking); prepositions alternate у/в and і/й by euphony.
- The apostrophe is always ʼ (U+02BC): обʼєкт, звʼязок, памʼять. Not ' or ’.
- Quotes inside Ukrainian text are «ялинки»; a button or layer name inside a sentence goes in them: Увімкніть «Вуличні знімки».
- In short labels, a standard abbreviation with a period beats a wrapped line: ПОПЕР., ДАЛЬН., КАЛІБР.
- Units: км, м, км/год, м/с, вуз (knots), фт (feet), год, хв, с, МГц, дБ, гПа; in UPPERCASE text КМ, М, КМ/С, ВУЗ, ФТ. MW is МВт in any case. `°` and `%` stay. Decimal comma in coordinates written as text: 28,2710° пн. ш.
- Coordinates: пн. ш. / пд. ш. / сх. д. / зх. д.; the HUD hemisphere letters are Пн, Пд, Сх, Зх.

## Plurals

A `tn()` entry needs four forms. `Intl.PluralRules('uk')` picks:

| Form    | Counts                   | Example    |
| ------- | ------------------------ | ---------- |
| `one`   | 1, 21, 31, 101…          | 1 камера   |
| `few`   | 2–4, 22–24, 32–34…       | 3 камери   |
| `many`  | 0, 5–20, 25–30, 111–114… | 5 камер    |
| `other` | fractions: 1.5, 2.25…    | 1,5 камери |

`other` takes the genitive singular: 1,5 кадру, 1,5 літака, 1,5 ключа. When a word next to a number cannot agree in every form, move the number after a colon instead: «поруч: {count}», «відповідей: {responses}». The same trick keeps place names and tool names out of a preposition's case: «звідки: {origin}», «Активно: {name}».

## Glossary

| English                                         | Українська                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| layer / data layer                              | шар / шар даних                                                  |
| feed                                            | потік даних (short: потік)                                       |
| source / data source                            | джерело / джерело даних                                          |
| LIVE (status) / live data                       | ОНЛАЙН / у реальному часі (status chip: ДАНІ ОНЛАЙН)             |
| SIMULATED / SYNTHETIC                           | ІМІТАЦІЯ                                                         |
| stale / degraded / unavailable                  | застарів / з перебоями (chip: ПЕРЕБОЇ) / недоступний             |
| retry                                           | повтор                                                           |
| key (API key) / POWER UP                        | ключ / ЗАПУСК                                                    |
| Provider Settings / provider                    | Налаштування постачальників / постачальник                       |
| globe / map / map source / basemap              | глобус / карта / джерело карти / підкладка                       |
| aircraft / flight / military flights            | літак (short HUD: борт) / рейс / військові рейси                 |
| vessel, ship / vessels                          | судно / судна (gen. pl. суден)                                   |
| satellite                                       | супутник                                                         |
| launch (rocket) / space mission                 | запуск / космічна місія                                          |
| ascent (rocket) / booster FLIGHT {n}            | виведення / ПОЛІТ {n} (not рейс)                                 |
| contact / tracking                              | контакт / стеження                                               |
| installation, site / mapped                     | обʼєкт / нанесений (обʼєкт, контакт)                             |
| camera / CCTV camera                            | камера / камера CCTV                                             |
| earthquake / active fire / fire perimeter       | землетрус / активна пожежа / контур пожежі                       |
| advisory (NHC/CPHC cyclone)                     | зведення                                                         |
| scene / shot / scene recipe                     | сцена / кадр / рецепт сцени                                      |
| briefing / panel / dock                         | брифінг / панель / док                                           |
| preset / visual preset                          | пресет / візуальний пресет                                       |
| Scope, keyhole (circular viewport mask)         | приціл                                                           |
| overlay (detection overlay) / world overlay     | накладка / накладка на глобусі                                   |
| heading / altitude / ground speed               | курс / висота / шляхова швидкість                                |
| map bearing, map heading                        | азимут карти                                                     |
| HDG / BRG / CRS, TRK / FOV / DEST / SPD / RANGE | КУРС / ПЕЛ. / ШК (шляховий кут) / ОГЛЯД / ПРИЗН. / ШВИД / ДАЛЬН. |
| Street View (Google)                            | Перегляд вулиць (as in Ukrainian Google Maps)                    |
| Street Level (layer)                            | Вуличні знімки                                                   |
| imagery / recent imagery                        | знімки / свіжі знімки                                            |
| radar reflectivity / lightning density          | радіолокаційна відбивність / щільність блискавок                 |
| infrared                                        | інфрачервоний (short: ІЧ)                                        |
| receiver / gain / decoder                       | приймач / підсилення / декодер                                   |
| broadcaster                                     | мовник                                                           |
| CONUS, WHOT/BHOT, Ironbow, CRT, NVG, FLIR       | без перекладу                                                    |
| PREV / NEXT (HUD) / Previous / Next             | ПОПЕР. / ДАЛІ / Попередній / Наступний                           |
| anchor / data pack / bundle (scene)             | якір / пакет даних / архів                                       |
| box (Recent Imagery area)                       | область                                                          |
| camera move                                     | переліт                                                          |
| SIG / NEWS / LOCAL (briefing tabs)              | СИГН. / НОВИНИ / МІСЦ.                                           |
| compass points (N, NNE, NE, …)                  | Пн, ПнПнСх, ПнСх, …                                              |
| L / R (relative bearing)                        | Л / П                                                            |
| click / tap                                     | клацнути / натиснути                                             |
| session (voice, OAuth)                          | сеанс                                                            |
| sequence (street-level photos)                  | послідовність                                                    |
| search (place search)                           | пошук місця                                                      |
| pitch (CCTV camera pose)                        | нахил                                                            |
| traffic (road traffic layer)                    | дорожній рух                                                     |
| phosphor (CRT)                                  | люмінофор                                                        |
| view (map extent) / view centre / in view       | видима область (карти) / центр карти / у кадрі                   |
| select (verb) / selected                        | вибрати / вибраний (not обрати)                                  |
| ping (cockpit proximity contacts)               | контакт                                                          |
| merge (turn-by-turn) / on ramp                  | влитися в потік / вʼїзд (off ramp: зʼїзд)                        |
| watch (Earth/Orbital Watch)                     | спостереження                                                    |
| timeout                                         | тайм-аут                                                         |
| icon                                            | значок (not іконка)                                              |
| run (scene playback) / RUN LOG                  | відтворення / ЖУРНАЛ ВІДТВОРЕННЯ (запуск is a rocket launch)     |
| Preview (voice panel replies)                   | відповіді                                                        |
| Marine (radio tag) / pleasure craft             | море (not флот) / прогулянкове судно                             |
| emergency (ADS-B) / Emergency (radio tag)       | аварійний стан / надзвичайні ситуації                            |
| confidence (FIRMS fire detection)               | достовірність (short: достов.)                                   |
| thermal (FLIR-style imaging)                    | тепловий (not термальний)                                        |
| map stack                                       | набір карт                                                       |
| stage (rocket) re-entry / recovery              | вхід ступеня в атмосферу / повернення                            |
| ON / OFF (toggle chips)                         | УВІМК. / ВИМК.                                                   |
| Clean UI / EXIT CLEAN VIEW                      | чистий інтерфейс / ПОВЕРНУТИ ІНТЕРФЕЙС                           |
| full globe view                                 | вигляд всього глобуса                                            |
| inputs (cockpit context chip)                   | потоки (not вхідні дані)                                         |
| downrange (rocket stage)                        | дальність                                                        |
| resolution (spatial)                            | роздільна здатність (not роздільність)                           |
| shared follow expired                           | посилання на стеження застаріло                                  |
