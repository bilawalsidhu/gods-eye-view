# German (`de`)

Catalog: `src/i18n/locales/de.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

## Style

- Standard German that reads naturally in Germany, Austria and Switzerland; use «ß» as in Germany («Straße», «Maßstab»).
- Address the user with the formal «Sie»: «Wählen Sie einen Ort», «Geben Sie einen Schlüssel ein». Buttons and menu items use the infinitive, not an imperative: «Speichern», «Schließen», «Erneut versuchen», «Abbrechen». Toggles name the thing: «Beschriftungen», not «Beschriftungen anzeigen».
- Sentence case, not Title Case, with the capitalisation German grammar requires: "Live Flights" → «Live-Flüge». UPPERCASE English stays UPPERCASE: «LIVE», «KEINE DATEN».
- Write compounds as one word or with a hyphen, never with a space: «Datenebene», «API-Schlüssel», «ADS-B-Empfänger», «CCTV-Kamera».
- Quotation marks inside German text are „…“: «Aufnahme „{shot}“ löschen?».
- German runs longer than English. Short labels, chips and HUD readouts stay short: prefer a standard abbreviation with a period over a wrapped line («Geschw.», «Entf.», «Höhe», «Zurück», «Weiter»).
- The HUD codes HDG, BRG, CRS, FOV, DEST, SPD, RANGE and ALT stay in English everywhere, as in cockpit avionics. Words used in a sentence are translated: heading → «Kurs», range → «Reichweite».
- Keyboard keys stay in English: Space, Esc, Enter, Tab, Shift, H, 1–9 («Halten Sie Space gedrückt, um zu sprechen»).
- Units: km, m, km/h, m/s, kn (knots), ft, h, min, s; in UPPERCASE text KM, KM/H, KN, FT, MIN, H. Put a space between number and unit as the English does. `°` and `%` stay; write «12 %» only where the English already has the space.
- Numbers and dates always go through the formatters (`formatNumber`, `formatDate`, `formatRelativeTime`), which produce `1.234,5` for `de`. Never write a date order or a decimal separator into a string.
- "ago" goes before the time: «vor {count} min». When a placeholder already holds a localized "ago" text (`{age}`, `{ago}`), do not add «vor» again.

## Plurals

A `tn()` entry needs two forms. `Intl.PluralRules('de')` picks:

| Form    | Counts                       | Example   |
| ------- | ---------------------------- | --------- |
| `one`   | 1                            | 1 Kamera  |
| `other` | everything else: 0, 2, 1.5 … | 3 Kameras |

## Codes kept in Latin

These stay as written in English and are listed under `de` in `src/i18n/same-as-english.json` when an entry is nothing else: HDG, BRG, CRS, FOV, DEST, SPD, ALT, ETA, UTC, ADS-B, AIS, CCTV, FLIR, NVG, CRT, GEO, REC, NAV, MHz, AM/FM, LIVE, compass codes on instruments (N, NNE, …), and product, provider and dataset names (Google Maps, Cesium ion, OpenAI, NASA FIRMS, USGS, OpenSky, Mapillary, OpenStreetMap …).

## Glossary

| English                                       | Deutsch                                                   |
| --------------------------------------------- | --------------------------------------------------------- |
| layer / data layer                            | Ebene / Datenebene                                        |
| feed / source / data source                   | Feed / Quelle / Datenquelle                               |
| LIVE (status) / live data                     | LIVE / Live-Daten                                         |
| SIMULATED                                     | SIMULIERT                                                 |
| stale / degraded / unavailable                | veraltet / eingeschränkt / nicht verfügbar                |
| loading / retry / retrying / offline          | wird geladen / erneut versuchen / neuer Versuch / offline |
| key (API key) / POWER UP / POWERED UP         | Schlüssel (API-Schlüssel) / AKTIVIEREN / AKTIV            |
| Provider Settings                             | Anbietereinstellungen                                     |
| ON / OFF (state chips)                        | AN / AUS                                                  |
| enable / disable                              | aktivieren / deaktivieren                                 |
| globe / map / basemap / map source            | Globus / Karte / Basiskarte / Kartenquelle                |
| aircraft, plane / flight / military flights   | Flugzeug / Flug / Militärflüge                            |
| callsign / tail number / squawk               | Rufzeichen / Kennzeichen / Squawk                         |
| vessel, ship                                  | Schiff                                                    |
| satellite / shell (Starlink)                  | Satellit / Schale                                         |
| launch (rocket) / launch site / space mission | Start / Startplatz / Raumfahrtmission                     |
| contact / tracking / track (path)             | Kontakt / Verfolgung / Spur                               |
| installation / site                           | Einrichtung / Standort                                    |
| mapped / observed                             | kartiert / beobachtet                                     |
| camera / CCTV camera                          | Kamera / CCTV-Kamera                                      |
| earthquake / active fire                      | Erdbeben / aktiver Brand                                  |
| radio station                                 | Radiosender                                               |
| road / flow (traffic)                         | Straße / Verkehrsfluss                                    |
| scene / shot                                  | Szene / Aufnahme                                          |
| briefing / panel / dock                       | Lagebericht / Bereich / Dock                              |
| cockpit                                       | Cockpit                                                   |
| preset / visual preset                        | Voreinstellung / visuelle Voreinstellung                  |
| detection overlay                             | Erkennungsüberlagerung                                    |
| pin (Draw tool)                               | Markierung                                                |
| heading, course / altitude / ground speed     | Kurs / Höhe / Geschwindigkeit über Grund (kurz: GS)       |
| PREV / NEXT · Previous / Next                 | ZURÜCK / WEITER · Zurück / Weiter                         |
| L / R (relative bearing)                      | L / R                                                     |
| NOT AN ALL-CLEAR                              | KEINE ENTWARNUNG                                          |
| click / click to …                            | klicken / klicken, um …                                   |
| board (Draw tool) / fallback / bike share     | Zeichenfläche / Ersatz / Leihräder                        |
| cyclone advisory / range (firing)             | Wirbelsturmvorhersage / Schießplatz                       |
| voice / assistant / analyst                   | Sprache / Assistent / Analyst                             |
