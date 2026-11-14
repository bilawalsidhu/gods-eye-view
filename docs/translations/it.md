# Italian (`it`)

Catalog: `src/i18n/locales/it.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

Translation source: abiyeenzo (#912).

## Style

- Standard Italian as in Italian software UIs. Address the user with informal "tu" imperatives: «Aggiungi», «Attiva», «Scegli», «Incolla», «Riprova». Tooltips that name an action use the same imperative: «Espandi il pannello», «Ripristina la camera».
- Sentence case, not Title Case: "Live Flights" → «Voli live», "Space Missions" → «Missioni spaziali». UPPERCASE English stays UPPERCASE: «LIVE», «NON DISPONIBILE».
- Quotes inside Italian text are straight double quotes: «Eliminare lo scatto "{shot}"?». Use the accented capitals (È, À) in UPPERCASE text: «VELOCITÀ», «CITTÀ».
- Errors read as a statement, not a past participle on its own: "Search failed" → «Ricerca non riuscita»; "Could not …" → «Impossibile …». A dash that joins a cause and a hint becomes a colon: «Chiave API rifiutata: controlla AISSTREAM_API_KEY». The same goes for a label and its hint in a tooltip: «Direzione (bussola °): clic per digitare».
- Short labels, chips and HUD readouts stay short. A standard abbreviation with a period beats a wrapped line: REGOLAZ., RILEV., INCL., ALT., VEL., STIM., PROIEZ., ESP.; PREC / SUCC for PREV / NEXT and PREVIOUS / NEXT.
- The HUD codes HDG, BRG, CRS, FOV and DEST stay in English, as in cockpit avionics. RANGE is «PORTATA». Words used in a sentence are translated: heading → «prua» (aircraft, ships) or «direzione» (camera, buses, trams, trains), course → «rotta».
- Keyboard keys stay in English: Space, Enter, Esc, Tab, Shift, Backspace, H, 1–9 («Tieni premuto Space per parlare», «Premi Enter per riprovare»).
- Decimal comma in numbers written in the text, magnitudes included: «28,2710° N», «M5,2». Numbers formatted by the code follow `Intl` and need nothing.
- Amounts: thousands, millions and billions are written out or abbreviated in Italian, not with K/M/B: «{amount} mila $», «{amount} mln $», «{amount} mld $».
- Units: km, m, km/h, m/s, kn (knots), ft (feet), h, min, s; in UPPERCASE text KM, KM/S, KT, FT, MIN, H. "m" is always metres, so minutes are «min» («5 min fa»). MW stays MW. `°` and `%` stay.
- "ago" goes after the time: «{count} min fa». When a placeholder already holds a localized "ago" text (`{age}`, `{ago}`), do not add «fa» again.
- A feature name used as a sentence subject gets a head noun so the verb agrees: «La modalità Missioni spaziali isola…», «Il pannello Impostazioni provider è disattivato…», «Il livello {layer} è attivo…», «Lo strumento {name} è attivo…». A short card title with a placeholder name puts the state after a colon: «{label}: attivato». The same goes for a placeholder list of names: «Attivazione recente: {layers}». A count in a plain `t()` entry (no plural forms) that can be 1 goes after a label, so nothing has to agree with it: «Record accettati: {accepted} su {raw}».
- English loanwords that Italian UIs use as they are stay in English: feed, live, cockpit, briefing, preset, overlay, layout, snapshot, tile, provider, timeout, payload, bloom, scope.

## Plurals

A `tn()` entry needs three forms. `Intl.PluralRules('it')` picks:

| Form    | Counts                                 | Example                 |
| ------- | -------------------------------------- | ----------------------- |
| `one`   | 1                                      | 1 telecamera            |
| `many`  | 1 000 000, 2 000 000… (exact millions) | 1 000 000 di telecamere |
| `other` | everything else: 0, 2–999 999, 1,5…    | 3 telecamere            |

The `many` form is the `other` text with «di» after the number when a noun follows: «{count} di telecamere caricate», «{count} DI CHIAVI IN ATTESA». When no noun follows the number («{count} vicine», «{count} RICEVUTI»), `many` repeats `other`. Nouns that do not change in the plural keep one form for all three (`{count} file`, `{count} data center`), with «di» in `many`.

## Glossary

| English                                       | Italiano                                                     |
| --------------------------------------------- | ------------------------------------------------------------ |
| layer / data layer                            | livello / livello dati                                       |
| feed / source / data source                   | feed / fonte / fonte dati                                    |
| LIVE (status) / live data / live (feed state) | LIVE / dati live / live                                      |
| SIMULATED                                     | SIMULATO                                                     |
| stale / degraded / unavailable                | obsoleto / degradato / non disponibile                       |
| retry / retrying                              | riprova / nuovo tentativo                                    |
| rate limited                                  | limite di richieste (raggiunto)                              |
| key (API key) / POWER UP / POWERED UP         | chiave / ACCENDI / ACCESO                                    |
| Provider Settings                             | Impostazioni provider                                        |
| ON / OFF (state chips)                        | ON / OFF                                                     |
| enable / disable                              | attivare / disattivare                                       |
| globe / map / map source / map stack          | globo / mappa / fonte mappa / stack mappa                    |
| basemap / box (Recent Imagery area)           | mappa di base / riquadro                                     |
| aircraft, plane / flight / military flights   | aereo / volo / voli militari                                 |
| vessel, ship                                  | nave                                                         |
| satellite / shell (Starlink) / DENSE          | satellite / shell / DENSO                                    |
| SPARSE / BALANCED / DENSE (detection modes)   | RADO / BILANCIATO / DENSO (agree with «overlay»)             |
| broadband (Starlink shell)                    | a banda larga                                                |
| VISUAL (CelesTrak group)                      | VISIBILI                                                     |
| launch (rocket) / launch site / space mission | lancio / sito di lancio / missione spaziale                  |
| ascent / replay / payload / stage             | salita / replay / payload / stadio                           |
| contact / tracking                            | contatto / tracciamento                                      |
| installation / site                           | installazione / sito                                         |
| mapped / observed                             | mappato / osservato                                          |
| camera (view) / camera, CCTV camera           | camera / telecamera, telecamera CCTV                         |
| earthquake / active fire / fire perimeter     | terremoto / incendio attivo / perimetro dell'incendio        |
| lightning strike / cloud (cover, %)           | fulmine / nuvole («non singoli fulmini», «20% di nuvole»)    |
| incident (wildfire, Type N) / scene incident  | evento (Evento di tipo N, Incendio senza nome) / evento      |
| trigger record (USGS card) / OPEN SOURCE link | scheda / APRI LA FONTE                                       |
| advisory (NHC/CPHC cyclone) / cone            | bollettino / cono di incertezza                              |
| forecast lead hours (cyclone points)          | scadenze di previsione in ore                                |
| AIR / SEA (radio category) / ground station   | ARIA / MARE / stazione di terra                              |
| radio station / broadcaster                   | stazione radio / emittente                                   |
| CH (radio channel readout)                    | CH (unchanged)                                               |
| road / flow (traffic)                         | strada / flusso                                              |
| transit / bike share                          | trasporto pubblico / bike sharing                            |
| last report (vehicle position)                | ultima segnalazione                                          |
| scene / shot / scene recipe                   | scena / scatto / ricetta della scena                         |
| anchor / data pack / bundle (scene)           | ancora / pacchetto dati / pacchetto                          |
| story beat                                    | tappa del racconto                                           |
| briefing / panel / dock                       | briefing / pannello / dock                                   |
| cockpit                                       | cockpit                                                      |
| preset / visual preset                        | preset / preset visivo                                       |
| Tactical / Minimal / Cyber                    | Tattico / Minimale / Cyber                                   |
| Scope (circular viewport mask) / keyhole      | scope / foro                                                 |
| feather / fade                                | sfumatura / dissolvenza                                      |
| detection overlay                             | overlay di rilevamento                                       |
| pin (Draw tool) / mark                        | segnaposto / segno                                           |
| pin (Recent Imagery)                          | fissare                                                      |
| Draw / Directions (tools)                     | Disegno / Indicazioni                                        |
| Street Level (layer) / Street View (Google)   | Vista stradale / Street View                                 |
| Recent Imagery                                | Immagini recenti                                             |
| Global Context / Context (panel)              | Contesto globale / Contesto                                  |
| heading, course / altitude / ground speed     | prua, rotta / altitudine / velocità al suolo (VEL. AL SUOLO) |
| altitude in short HUD captions / Alt unknown  | QUOTA (QUOTA · FT) / Quota sconosciuta                       |
| fallback (FALLBACK, Street View fallback)     | riserva / di riserva (SUPERFICIE DI RISERVA)                 |
| forecast track / advisory center (cyclones)   | traccia prevista / centro del ciclone da bollettino          |
| witness source / authored (scene)             | fonte testimoniale / predefinito, definito dall'autore       |
| explore manually                              | esplora manualmente                                          |
| HDG / BRG / CRS / FOV / DEST                  | HDG / BRG / CRS / FOV / DEST (unchanged)                     |
| RANGE / PITCH / HGT (CCTV calibration)        | PORTATA / INCL. / ALT.                                       |
| PREV / NEXT                                   | PREC / SUCC                                                  |
| Previous / Next (button text)                 | Precedente / Successivo                                      |
| Focus {target} (action, aria label)           | Inquadra {target} (the FOCUS button stays FOCUS)             |
| L / R (relative bearing)                      | S / D                                                        |
| SIG / NEWS / LOCAL (briefing tabs)            | SIG / NOTIZIE / LOCALE                                       |
| compass points (N, NNE, …, W, NW)             | N, NNE, …, O, NO (west is «O», ovest)                        |
| NOT AN ALL-CLEAR                              | NON È UN VIA LIBERA                                          |
| weather field / model / valid / issued        | campo / modello / valida / emessa                            |
| click / click to …                            | fai clic / clic per …                                        |
