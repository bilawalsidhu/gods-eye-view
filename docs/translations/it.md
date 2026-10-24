# Italian (`it`)

Catalog: `src/i18n/locales/it.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

## Style

- Standard Italian; avoid regionalisms.
- Address the user with the informal «tu» imperative: «Scegli un luogo», «Inserisci una chiave», «Riprova». Buttons and menu items use the infinitive or a noun: «Salva», «Chiudi», «Annulla», «Riprova». Toggles name the thing: «Etichette», not «Mostra etichette».
- Sentence case, not Title Case: "Live Flights" → «Voli in diretta». UPPERCASE English stays UPPERCASE: «IN DIRETTA», «NESSUN DATO».
- Quotation marks inside Italian text are «…» only where the English quotes something; otherwise none: «Eliminare l'inquadratura "{shot}"?» keeps the straight quotes the English uses.
- Use the apostrophe for elision as Italian requires: «l'aereo», «dell'area», «un'ora».
- Italian runs longer than English. Short labels, chips and HUD readouts stay short: prefer a standard abbreviation with a period over a wrapped line («Vel.», «Dist.», «Prec.», «Succ.»).
- The HUD codes HDG, BRG, CRS, FOV, DEST, SPD, RANGE and ALT stay in English everywhere, as in cockpit avionics. Words used in a sentence are translated: heading → «rotta», range → «portata».
- Keyboard keys stay in English: Space, Esc, Enter, Tab, Shift, H, 1–9 («Tieni premuto Space per parlare»).
- Units: km, m, km/h, m/s, kn (knots), ft, h, min, s; in UPPERCASE text KM, KM/H, KN, FT, MIN, H. `°` and `%` stay.
- Numbers and dates always go through the formatters (`formatNumber`, `formatDate`, `formatRelativeTime`), which produce `1.234,5` for `it`. Never write a date order or a decimal separator into a string.
- "ago" goes after the time: «{count} min fa». When a placeholder already holds a localized "ago" text (`{age}`, `{ago}`), do not add «fa» again.

## Plurals

A `tn()` entry needs three forms. `Intl.PluralRules('it')` picks:

| Form    | Counts                                 | Example                 |
| ------- | -------------------------------------- | ----------------------- |
| `one`   | 1                                      | 1 telecamera            |
| `many`  | 1 000 000, 2 000 000… (exact millions) | 1 000 000 di telecamere |
| `other` | everything else: 0, 2–999 999, 1.5…    | 3 telecamere            |

The `many` form is the `other` text with «di» after the number: «{count} di telecamere caricate», «{count} DI CHIAVI IN ATTESA».

## Codes kept in Latin

These stay as written in English and are listed under `it` in `src/i18n/same-as-english.json` when an entry is nothing else: HDG, BRG, CRS, FOV, DEST, SPD, ALT, ETA, UTC, ADS-B, AIS, CCTV, FLIR, NVG, CRT, GEO, REC, NAV, MHz, AM/FM, compass codes on instruments (N, NNE, …), and product, provider and dataset names (Google Maps, Cesium ion, OpenAI, NASA FIRMS, USGS, OpenSky, Mapillary, OpenStreetMap …).

## Glossary

| English                                       | Italiano                                              |
| --------------------------------------------- | ----------------------------------------------------- |
| layer / data layer                            | livello / livello dati                                |
| feed / source / data source                   | feed / fonte / fonte dati                             |
| LIVE (status) / live data                     | IN DIRETTA / dati in tempo reale                      |
| SIMULATED                                     | SIMULATO                                              |
| stale / degraded / unavailable                | non aggiornato / degradato / non disponibile          |
| loading / retry / retrying / offline          | caricamento / riprova / nuovo tentativo / offline     |
| key (API key) / POWER UP / POWERED UP         | chiave (chiave API) / ATTIVA / ATTIVO                 |
| Provider Settings                             | Impostazioni dei provider                             |
| ON / OFF (state chips)                        | ON / OFF                                              |
| enable / disable                              | attivare / disattivare                                |
| globe / map / basemap / map source            | globo / mappa / mappa di base / fonte della mappa     |
| aircraft, plane / flight / military flights   | aereo / volo / voli militari                          |
| callsign / tail number / squawk               | nominativo / marche / squawk                          |
| vessel, ship                                  | nave                                                  |
| satellite / shell (Starlink)                  | satellite / guscio                                    |
| launch (rocket) / launch site / space mission | lancio / sito di lancio / missione spaziale           |
| contact / tracking / track (path)             | contatto / tracciamento / traccia                     |
| installation / site                           | installazione / sito                                  |
| mapped / observed                             | mappato / osservato                                   |
| camera / CCTV camera                          | telecamera / telecamera CCTV                          |
| earthquake / active fire                      | terremoto / incendio attivo                           |
| radio station                                 | stazione radio                                        |
| road / flow (traffic)                         | strada / flusso                                       |
| scene / shot                                  | scena / inquadratura                                  |
| briefing / panel / dock                       | briefing / pannello / dock                            |
| cockpit                                       | cabina di pilotaggio                                  |
| preset / visual preset                        | preimpostazione / preimpostazione visiva              |
| detection overlay                             | sovrapposizione di rilevamento                        |
| pin (Draw tool)                               | segnaposto                                            |
| heading, course / altitude / ground speed     | rotta / quota / velocità al suolo (breve: VEL. SUOLO) |
| PREV / NEXT · Previous / Next                 | PREC. / SUCC. · Precedente / Successivo               |
| L / R (relative bearing)                      | S / D                                                 |
| NOT AN ALL-CLEAR                              | NON È UN CESSATO ALLARME                              |
| click / click to …                            | fai clic / clic per …                                 |
| map tiles / scene bundle / radio directory    | tile / bundle / elenco                                |
| viewer camera (3D view) / FOCUS (action)      | visuale / CENTRA                                      |
| COCKPIT (chip) / range (firing)               | CABINA / poligono                                     |
| voice / assistant / analyst                   | voce / assistente / analista                          |
