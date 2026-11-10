# Hebrew (`he`)

Catalog: `src/i18n/locales/he.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

## Style

- Address the user with a masculine imperative, Google style: הסתר, הצג, נסה שוב, התקרב. Menu items and tooltips take the noun form: הסרת {name}, הרחבת {name}, שינוי הצבע של {name}.
- Sentence case: Hebrew has no case forms, so UPPERCASE English is normal sentence style here; short HUD labels stay short, favor an abbreviation over a wrapped line.
- Units follow the catalog: ק"מ, מ׳, קמ"ש, שנ׳, דק׳, שע׳; an abbreviation always ends in the geresh (׳). Instrument readouts and formatted shared-unit labels keep the Latin units (km, NM, FT, KTS, MW, KM/S); catalog prose outside those readouts keeps ק"מ/מ׳. Codes like HDG, FOV, CAL, SRC, REC stay exactly as in English — see `same-as-english.json`.

## Digits and direction

- Western digits 0–9 only, like every catalog: "5 מטוסים", "26.08.2026". Dates in scene labels use dd.mm.yyyy.
- `{direction}` values are adverbs (שמאלה, ימינה, ישר); maneuver templates are written to place them after the verb: פנה {direction} אל {road}.
- Values inserted by t() are isolated (U+2068…U+2069); do not add manual RTL marks — write the sentence as natural Hebrew and let isolation do the rest.

## Plurals

A `tn()` entry needs three forms under `Intl.PluralRules('he')`:

| Form    | Counts                       | Example        |
| ------- | ---------------------------- | -------------- |
| `one`   | 1 and fractions below 1      | 1 מצלמה · 0.5  |
| `two`   | 2                            | 2 מצלמות       |
| `other` | 0, 3, 10, 100, integers…     | 5 מצלמות       |

With {count} shown as a digit, `two` and `other` share the plural noun (2 מצלמות, 5 מצלמות); `one` takes the singular (1 מצלמה). For constructs that resist agreement with a noun (אין, הכול, זמין), phrase around the number: "{count} תחנות מדווחות" is fine, but prefer "ממתין: {count}" over a mismatched genitive chain.

## Glossary

| English                                        | עברית                                                 |
| ---------------------------------------------- | ----------------------------------------------------- |
| layer / data layer                             | שכבה / שכבת נתונים                                    |
| feed                                           | פיד                                                   |
| source / data source / Provider Settings       | מקור / מקור נתונים / הגדרות הספקים                    |
| LIVE / live data / LIVE TRACK                  | חי / נתונים חיים / מעקב חי                            |
| SIMULATED                                      | מדומה                                                 |
| stale / degraded / unavailable                 | מיושן / מופחת / לא זמין                               |
| key (API key) / POWER UP                       | מפתח / שדרוג                                          |
| globe / map / map source / basemap             | גלובוס / מפה / מקור מפה / מפת בסיס                    |
| aircraft / flight / military flight            | מטוס (כלי טיס in class lists) / טיסה / טיסה צבאית     |
| vessel / ship / ships                          | אונייה / אוניות                                       |
| satellite                                      | לוויין                                                |
| launch (rocket) / space mission                | שיגור / משימת חלל                                     |
| contact / tracking                             | מגע / עקיבה                                           |
| installation / site                            | מתקן / אתר                                            |
| camera / CCTV camera / ALPR camera             | מצלמה / מצלמת CCTV / מצלמת ALPR                       |
| earthquake / active fire / cyclone             | רעידת אדמה / שריפה פעילה / ציקלון                     |
| scene / shot                                   | סצנה / שוט                                            |
| briefing / panel / dock                        | תדריך / פאנל / עגינה                                  |
| visual preset / style                          | ערכת ראייה / סגנון                                   |
| Scope (circular viewport mask) / keyhole       | סקופ / חור המנעול                                    |
| heading (compass °) / course                   | כיוון / מהלך                                         |
| HDG / BRG / CRS / FOV / DEST / SPD / RANGE     | בלי שינוי — קודי מכשיר                               |
| advisory (NHC/CPHC cyclone)                    | עדכון; Advisory center — מרכז הסערה לפי העדכון        |
| Street View (Google)                           | Street View, בלי תרגום                                |
| Street Level / Street Level layer              | Street Level, בלי תרגום (שם שכבה)                    |
| WHOT/BHOT, Ironbow, CRT, NVG, FLIR             | בלי שינוי — קודים ושמות מצבים                        |
| PREV / NEXT                                    | הקודם / הבא                                           |
| anchor / data pack / asset bundle (scene)      | עוגן / חבילת נתונים / חבילת נכסים                   |
| forecast (weather)                             | תחזית                                                 |
| witness / geolocated source                    | עד ראייה / מקור מאוכן                                 |
| contained (wildland fire) / FRP                | הכלה / FRP, בלי שינוי                                 |

