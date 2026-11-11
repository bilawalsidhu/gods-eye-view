# Swedish (`sv`)

Catalog: `src/i18n/locales/sv.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

Translation source: [God's Eye View Sverige](https://github.com/Kajjan7610/Gods-view-sweden) by Kaj Obst, November 2026.

## Style

- Standard Swedish as in Swedish software and on Swedish authority sites (SMHI, Trafikverket, Polisen).
- Actions and hints use the imperative without a pronoun: «Försök igen», «Klicka på en kamera för att aktivera den», «Välj en tagning först», «Tillåt mikrofonen och försök igen». Avoid «du»/«ni»; "your" becomes «egen» or is left out: «Egen RTL-SDR-mottagare», «Stationen ser din IP-adress» only where a person must be addressed.
- Sentence case, not Title Case: "Live Flights" → «Liveflyg», "Provider Settings" → «Leverantörsinställningar». UPPERCASE English stays UPPERCASE: «LIVEDATA AV», NOT AN ALL-CLEAR → «INTE FARA ÖVER».
- Compounds are written as one word, with a hyphen after a name, code or abbreviation: «datalager», «väderrutor», «TomTom-nyckel», «AIS-fartyg», «Street View-reserv». Never split a compound with a space.
- Short labels, chips and HUD readouts stay short; use a standard abbreviation with a period over a wrapped line: RÄCKV., HAST., NEDERB., ÖVR., MEDD., FÖRST., KAL. «Jämför» is JFR, without a period.
- The avionics codes HDG, BRG, CRS, DEST, SPD, ALT, GS, TRK, V/S, FOV and SQUAWK stay in English, as in the cockpit. Words in a sentence are translated: heading → «kurs», bearing → «bäring», range → «räckvidd».
- A dash between clauses is a spaced en dash « – ». Quotes are ”…” (Swedish closing quotes on both sides).
- Status and waiting messages: «Väntar på uppdatering», «Laddar …». Reasons after a dash stay lower case: «Scenen sparades inte – projektet är större än 5 MiB».
- A layer named in a sentence takes its panel name in quotes: «Lagret ”Liveflyg” är inte aktiverat».
- Rolling windows say their length: LAST YEAR → «SENASTE 12 MÅN.», LAST MONTH → «SENASTE 30 DAGARNA».
- Keyboard keys: Mellanslag, Backsteg, Skift; Esc, Enter, Tab and letter keys stay.
- Decimal comma in fixed text: «M4,4», «28,2710° N». Thousands separator is a space: «1 000 km». Formatted numbers come from `Intl` and are already Swedish.
- Units: km, m, km/h, m/s, kn (knop), ft (fot), hPa, MW, h, min, s, d (dygn, in short readouts); in UPPERCASE text KM, KM/H, KN, FT, MIN, H, D. A space between number and unit, also before %: «{value} m», «{count} min», «50 %». `°` sticks to the number.
- "ago": «för {count} min sedan», short «{count} min sedan». When a placeholder already holds a localized "ago" text (`{age}`, `{ago}`), do not add «sedan» again.
- Compass points use O for öst and V for väst, as SMHI does: N, NNO, NO, ONO, O, OSO, SO, SSO, S, SSV, SV, VSV, V, VNV, NV, NNV; hemisphere letters N, S, O, V.
- Routing: «Sväng {direction} in på {road}», «Fortsätt {direction}», «Ta {exit} avfarten» with ordinals «2:a», «3:e».

## Plurals

A `tn()` entry needs two forms. `Intl.PluralRules('sv')` picks:

| Form    | Counts                      | Example     |
| ------- | --------------------------- | ----------- |
| `one`   | 1                           | 1 kamera    |
| `other` | everything else: 0, 2, 1,5… | 3 kameror   |

Abbreviated units and codes do not change: «{count} MEDD.».

## Glossary

| English                                        | Svenska                                                         |
| ---------------------------------------------- | --------------------------------------------------------------- |
| layer / data layer                             | lager / datalager                                               |
| feed / source / data source                    | flöde / källa / datakälla                                       |
| LIVE (status) / live data                      | LIVE / livedata                                                 |
| SIMULATED                                      | SIMULERAT                                                       |
| stale / degraded / unavailable                 | inaktuell / begränsad / otillgänglig                            |
| retry / retrying / retrying slowly             | nytt försök / försöker igen / försöker igen med längre intervall |
| fallback                                       | reserv                                                          |
| key (API key) / POWER UP / POWERED UP          | nyckel / KOPPLA PÅ / PÅKOPPLAD                                  |
| Provider Settings                              | Leverantörsinställningar                                        |
| ON / OFF (state chips)                         | PÅ / AV                                                         |
| enable / disable                               | aktivera / inaktivera                                           |
| globe / map / map source / basemap             | glob / karta / kartkälla / bakgrundskarta                       |
| aircraft / flight / military flights           | luftfartyg (short labels: flygplan) / flygning / militärflyg    |
| vessel, ship                                   | fartyg                                                          |
| satellite / shell (Starlink)                   | satellit / skal                                                 |
| launch (rocket) / launch site / space mission  | uppskjutning / uppskjutningsplats / rymduppdrag                 |
| contact / tracking                             | kontakt / följning                                              |
| installation / site                            | anläggning / plats                                              |
| camera / CCTV camera                           | kamera / CCTV-kamera                                            |
| earthquake / active fire / fire perimeter      | jordbävning / aktiv brand / brandgräns                          |
| cyclone / advisory (NHC) / cone                | cyklon / bulletin / kon                                         |
| radio station / broadcast FM                   | radiostation / FM-radio                                         |
| road / traffic flow                            | väg / trafikflöde                                               |
| transit / bike share                           | kollektivtrafik / hyrcyklar                                     |
| scene / shot / capture shot / camera move      | scen / tagning / spara tagning / kameraåkning                   |
| anchor / data pack / bundle                    | ankare / datapaket / paket                                      |
| briefing / panel / dock                        | genomgång / panel / docka                                       |
| preset / visual preset                         | förval / visuellt förval                                        |
| Scope (circular viewport mask) / keyhole       | Scope / nyckelhål                                               |
| overlay / detection overlay                    | överlägg / detekteringsöverlägg                                 |
| Clean UI                                       | Rent gränssnitt                                                 |
| Night vision / Thermal / Snow (styles)         | Mörkerseende / Värmekamera / Snö                                |
| heading / altitude / ground speed              | kurs / höjd / markfart                                          |
| RANGE / PITCH / HGT (CCTV calibration chips)   | RÄCKV. / LUTN. / HÖJD                                           |
| PREV / NEXT / RESUME                           | FÖRRA / NÄSTA / FORTSÄTT                                        |
| nearest (spatial)                              | närmaste                                                        |
| expand / collapse                              | fäll ut / fäll ihop                                             |
| Street Level / Street View (Google)            | Gatunivå / Street View                                          |
| Recent Imagery                                 | Senaste bilder                                                  |
| voice (control) / voice session                | röststyrning / röstsession                                      |
| click / tap / press a key                      | klicka / tryck / tryck på tangenten                             |
| card / label (on the map) / clear (layers)     | kort / etikett / stäng av                                       |
| frame (weather, video) / image                 | bildruta / bild                                                 |
| incident                                       | händelse                                                        |
