# German (`de`)

Catalog: `src/i18n/locales/de.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

Translation source: abiyeenzo (#908).

## Style

- Standard German that reads naturally in Germany, Austria and Switzerland; ß where it belongs (Straße, schließen), no Swiss ss.
- No direct address: neither «Sie» nor «du». Actions and hints use the neutral infinitive: «Erneut versuchen», «Kamera anklicken zum Aktivieren», «Zuerst eine Aufnahme wählen», «Mikrofonzugriff erlauben und erneut versuchen». "Your" becomes the article or «eigene»: «Eigener RTL-SDR-Empfänger», «Die IP-Adresse ist für diesen Sender sichtbar».
- Nouns are capitalized, as German requires; otherwise sentence case, not Title Case: "Live Flights" → «Live-Flüge», "Provider Settings" → «Anbieter-Einstellungen». UPPERCASE English stays UPPERCASE: «LIVE-DATEN AUS», «KEINE ENTWARNUNG». In UPPERCASE, ß is written SS: «SCHLIESSEN», «STRASSENEBENE».
- Compounds are written as one word or with a hyphen next to a name, code or English term: «Datenebene», «Wetterkacheln», «TomTom-Schlüssel», «AIS-Schiffe», «Street-View-Fallback». Do not split them with spaces.
- Short labels, chips and HUD readouts stay short. German runs about a third longer than English, so prefer a short word or a standard abbreviation with a period over a wrapped line: REICHW., GESCHW., NIEDERSCHL., SONST., NACHR., VERST., VGL., KAL., KOMM. (a bare «KOMM» reads as the imperative)
- The avionics codes HDG, BRG, CRS, DEST, SPD, ALT, GS, TRK, V/S, FOV and SQUAWK stay in English, as in the cockpit. Words used in a sentence are translated: heading → «Kurs», bearing → «Peilung», range → «Reichweite».
- A dash between clauses is a spaced en dash « – »; a colon is fine where it explains: «Feed ausgefallen – neue Versuche in größeren Abständen», «SIMULIERT: Verkehrsdienst nicht erreichbar». Quotes are „…“.
- Status and waiting messages use the neutral infinitive too: «Warten auf Aktualisierung», not «Warte auf …». Reasons inserted after a dash stay lower case: «Szene nicht gespeichert – das Projekt ist größer als 5 MiB».
- A layer named in a sentence takes its panel name in quotes: «Die Ebene „Live-Flüge“ ist nicht aktiviert», «die Ebene „Live-Flüge“ lädt Daten für den jeweiligen Bildausschnitt».
- Rolling time windows say their length, so they cannot read as the previous calendar period: LAST YEAR → «LETZTE 12 MONATE», LAST MONTH → «LETZTE 30 TAGE».
- Keyboard keys are named as on German keyboards where they differ: Leertaste, Rücktaste, Umschalt; Esc, Enter, Tab and letter keys stay.
- Decimal comma in fixed text: «M4,4», «28,2710° N». Thousands separator is a period: «1.000 km». Formatted numbers come from `Intl` and are already German.
- Units: km, m, km/h, m/s, kn (knots, also in the cockpit), ft (feet), hPa, MW, h, min, s, T (days, in short readouts); in UPPERCASE text KM, KM/H, KN, FT, MIN, H, T («VOR {count} H»). A space between number and unit, in compact readouts too: «{value} m», «{count} min», «50 %», «{speed} KN», «{count} / 30 T». `°` sticks to the number.
- "ago" goes before the time: «vor {count} min», «vor {value}». When a placeholder already holds a localized "ago" text (`{age}` in `STALE · cached {age}`, `{ago}`), do not add «vor» again.
- Compass points use O for Ost: N, NNO, NO, ONO, O, OSO, SO, SSO, S, SSW, SW, WSW, W, WNW, NW, NNW; hemisphere letters N, S, O, W.
- Routing: direction words are lowercase adverbs (links, leicht rechts, scharf links, geradeaus), so a sentence never starts with one: «Auf {road} {direction} abbiegen», «Hier {direction} abbiegen», «Weiter {direction}». «Hier», not «Dann»: the step card already says «dann {leg}» and «Nächster Schritt: …». At a fork the verb is «weiter», which also works with «geradeaus»: «An der Gabelung {direction} weiter». Roundabout exits are ordinals with a period: «die {exit} Ausfahrt» → «die 2. Ausfahrt». A lane is named by where it leads, not by its position: «Die geradeaus führende Spur benutzen», «die leicht nach links führende», «die scharf nach rechts führende» (not «halblinke» or «äußerst linke»).

## Plurals

A `tn()` entry needs two forms. `Intl.PluralRules('de')` picks:

| Form    | Counts                      | Example   |
| ------- | --------------------------- | --------- |
| `one`   | 1                           | 1 Kamera  |
| `other` | everything else: 0, 2, 1,5… | 3 Kameras |

Keep the verb in agreement: «{count} Station meldet» / «{count} Stationen melden». Abbreviated units and codes do not change: «{count} NACHR.», «{count} EMPFANGEN».

## Glossary

| English                                        | Deutsch                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| layer / data layer                             | Ebene / Datenebene                                                     |
| feed / source / data source / input (cockpit)  | Feed / Quelle / Datenquelle / Quelle                                   |
| LIVE (status) / live data                      | LIVE / Live-Daten                                                      |
| SIMULATED                                      | SIMULIERT                                                              |
| stale / degraded / unavailable                 | veraltet / eingeschränkt / nicht verfügbar                             |
| retry / retrying / retrying slowly             | neuer Versuch / erneut versuchen / neue Versuche in größeren Abständen |
| fallback                                       | Fallback                                                               |
| key (API key) / POWER UP / POWERED UP          | Schlüssel / STARTKLAR / HOCHGEFAHREN                                   |
| Provider Settings                              | Anbieter-Einstellungen                                                 |
| ON / OFF (state chips)                         | EIN / AUS                                                              |
| enable / disable                               | aktivieren / deaktivieren                                              |
| globe / map / map source / map stack / basemap | Globus / Karte / Kartenquelle / Kartenstapel / Basiskarte              |
| aircraft / flight / military flights           | Luftfahrzeug (HUD and short labels: Flugzeug) / Flug / Militärflüge    |
| vessel, ship                                   | Schiff                                                                 |
| satellite / shell (Starlink) / DENSE           | Satellit / Schale / DICHT                                              |
| launch (rocket) / launch site / space mission  | Start / Startplatz / Raummission                                       |
| ascent / replay / payload / stage / downrange  | Aufstieg / Replay, Wiedergabe / Nutzlast / Stufe / Downrange           |
| contact / tracking                             | Kontakt / Verfolgung                                                   |
| installation / site                            | Anlage / Standort                                                      |
| mapped / observed                              | kartiert / beobachtet (Bhote chip OBSERVED IMAGERY: REALE BILDDATEN)   |
| camera / CCTV camera / camera badge            | Kamera / CCTV-Kamera / Kamera-Markierung                               |
| earthquake / active fire / fire perimeter      | Erdbeben / aktiver Brand / Brandgrenze                                 |
| cyclone / advisory (NHC/CPHC) / cone           | Wirbelsturm / Lagebericht (not «Warnung») / Kegel                      |
| issued (advisory, forecast)                    | ausgegeben                                                             |
| radio station                                  | Sender                                                                 |
| broadcast FM                                   | UKW                                                                    |
| road / flow (traffic) / flow coverage          | Straße / Verkehrsfluss / Live-Abdeckung                                |
| transit / bike share                           | ÖPNV / Bikesharing                                                     |
| scene / shot / scene recipe                    | Szene / Aufnahme / Szenenrezept                                        |
| capture shot / camera move                     | Aufnahme speichern / Kameraflug                                        |
| anchor / data pack / bundle                    | Anker / Datenpaket / Bundle                                            |
| story beat / evidence beat                     | Story-Schritt / Beweisschritt                                          |
| briefing / panel / dock                        | Briefing / Bereich / Dock                                              |
| cockpit                                        | Cockpit                                                                |
| preset / visual preset                         | Preset / visuelles Preset                                              |
| Scope (circular viewport mask) / keyhole       | Scope / Schlüsselloch                                                  |
| feather / fade                                 | Weichzeichnung / Ausblenden                                            |
| overlay / detection overlay                    | Overlay / Erkennungs-Overlay                                           |
| Clean UI                                       | Reine Ansicht                                                          |
| Night vision / Thermal / Snow (cockpit styles) | Nachtsicht / Wärmebild / Schnee                                        |
| heading / altitude / ground speed              | Kurs / Höhe / Geschwindigkeit über Grund (short: GESCHW. ÜBER GRUND)   |
| HDG / BRG / CRS / DEST / SPD / FOV             | unchanged                                                              |
| RANGE / PITCH / HGT (CCTV calibration chips)   | REICHW. / NEIGUNG / HÖHE                                               |
| PREV / NEXT                                    | ZURÜCK / WEITER                                                        |
| RESUME (radio transport button)                | FORTSETZEN (not «WEITER», which is NEXT in the same row)               |
| nearest (spatial)                              | nächstgelegen (always; «nächste» is NEXT)                              |
| expand / collapse (sections)                   | ausklappen / einklappen                                                |
| L / R (relative bearing)                       | L / R                                                                  |
| SIG / NEWS / LOCAL (briefing tabs)             | SIG / NEWS / LOKAL                                                     |
| NOT AN ALL-CLEAR                               | KEINE ENTWARNUNG                                                       |
| Street Level / Street View (Google)            | Straßenebene / Street View                                             |
| Recent Imagery / box / pin (a day)             | Aktuelle Bilddaten / Bereich / fixieren                                |
| frame (bring into view)                        | ins Bild nehmen                                                        |
| mark (map annotation) / outline                | Markierung / Umriss                                                    |
| voice (control) / voice session                | Sprachsteuerung / Sprachsitzung                                        |
| YOU / THIS / HERE (voice card labels)          | EINGABE / DIES / HIER                                                  |
| click / click to …                             | anklicken / … klicken                                                  |
| tap (touch)                                    | Antippen (not «Tipp», which is a hint)                                 |
| press / tap a key                              | Taste drücken / kurz drücken (never «tippen» for keys)                 |
| tilted view                                    | Schrägansicht                                                          |
| card (host card) / voice card                  | Eintrag (in hints), Infokarte / Sprachkarte                            |
| label (on the map) / clear (switch off layers) | Beschriftung / ausschalten (not «löschen»)                             |
| station tag (radio filter)                     | Kategorie                                                              |
| DIRECTORY BAND / {category} BAND (radio dial)  | SENDERSKALA / SENDERSKALA · {category} (not «-BAND»: «ROCK-BAND»)      |
| MIC (dock button)                              | MIKRO                                                                  |
| frame (weather, video) / image                 | Frame / Bild                                                           |
| collapse / landslide (Bhote Koshi)             | Erdrutsch (not «Abbruch», which reads as "cancel")                     |
| website (radio station)                        | Website (SENDER-WEBSITE; «Standort» is a physical site)                |
