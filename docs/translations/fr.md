# French (`fr`)

Catalog: `src/i18n/locales/fr.json`. General rules: [TRANSLATORS.md](../TRANSLATORS.md).

## Style

- Address the user with a plain second person and natural imperatives: « Activez », « Choisissez », « Collez », « Réessayez ». When space is tight or the text names an object, the infinitive works too: « Cadrer les aéronefs », « Voler vers la position ».
- Sentence case, not Title Case. UPPERCASE English stays UPPERCASE, but only the words that matter get translated: « VOL MILITAIRE », « À L'INSTANT ». Aviation codes (HDG, BRG, CRS, FOV, DEST, SPD, TRK, ALT, VS, SQUAWK, ADS-B, AIS, CCTV, GNSS) stay identical, as a cockpit would print them.
- No em dash. Write the pause with what fits: a colon, a comma, « ou », or two sentences. The translators' rule of keeping `—` applies to separators printed by product or reused from English, not to new French prose.
- Keep `·`, `→`, `↗`, `…`, `±`, `°`, `×`, the thin non-breaking space before `%` and `:` where French uses one, and the typographic apostrophe `'` in the prose.
- Quotes are the guillemets « … », not straight double quotes. Only keys, code and environment names keep their original quotes.
- Short labels, chips and HUD readouts stay short. A standard abbreviation beats a wrapped line: « TEMP », « PRÉCIP. », « VENT », « ACTUEL », « PRÊT », « INACTIF », « EN DIRECT ».

## Plurals

`Intl.PluralRules('fr')` picks three categories. `one` is the singular (1), `many` is the exact millions (1 000 000, 2 000 000…) and `other` covers everything else, including 0. In practice:

| Form    | Counts                        | Example              |
| ------- | ----------------------------- | -------------------- |
| `one`   | 1                             | 1 caméra             |
| `many`  | 1 000 000, 2 000 000…         | 1 000 000 de caméras |
| `other` | 0, 2, 3, 1.5, 999 999…        | 3 caméras            |

The `many` form is the `other` text with « de » after the number: « {count} DE CLÉS EN ATTENTE », « {count} de caméras chargées ». The `one` and `other` forms are kept distinct even when French writes them the same, so the catalog stays explicit.

## Units, separators and typography

- Units follow the aviation interface: km, m, km/h, km/s, ft, kn, kts, hPa, dB, dBFS, msg/s, MB, MiB, MW, °, %. Time units are h, min, s; « il y a 5 min » not « il y a 5 m ». Altitude and distance keep the American-cockpit codes (FT, KT, FL, HDG, TRK, V/S).
- A non-breaking space goes before `%`, `°` when the value follows a word, and the French double punctuation `: ; ! ?` as soon as a word joins them. A thin non-breaking space just before `°` reads fine in compact cells: « 250 km », « 30 % », « ALT {altitude} FT ».
- Numbers and dates are formatted by `formatNumber`, `formatDate`, `formatUtcDayMonth` in `src/i18n/index.js`, never concatenated by hand.
- Compass points and their abbreviations stay in English: N, NNE, NE, ENE, E, ESE, SE, SSE, S, SSO, SO, OSO, O, ONO, NO, NNO. The full French names (nord, nord-est, etc.) only appear when the text is prose, not a chip.

## Glossary

| English                                       | Français                                                        |
| --------------------------------------------- | --------------------------------------------------------------- |
| layer / data layer                            | couche / couche de données                                      |
| feed / source / data source                   | flux / source / source de données                               |
| LIVE / live data / on air                     | EN DIRECT / données en direct / à l'antenne (radio)             |
| SIMULATED                                     | SIMULÉ                                                          |
| stale / degraded / partial / unavailable      | périmé / dégradé / partiel / indisponible                       |
| retry / retrying                              | nouvelle tentative / nouvelle tentative dans …                  |
| API key / POWER UP / POWERED UP               | clé / ALLUMAGE / ALLUMÉ                                         |
| ON / OFF (state chips)                        | ACTIF / INACTIF                                                 |
| Provider Settings                             | Paramètres des fournisseurs                                     |
| map / map source / map stack / basemap        | carte / source de la carte / pile de cartes / fond de carte  |
| globe / viewport / keyhole (Scope)            | globe / fenêtre affichée / hublot                               |
| aircraft / flight / commercial / military     | aéronef / vol / commercial / militaire                          |
| vessel, ship                                  | navire                                                          |
| satellite / shell (Starlink) / DENSE          | satellite / constellation / DENSE                               |
| launch / launch site / space mission          | lancement / site de lancement / mission spatiale                |
| ascent / replay / orbit / stage / payload     | ascension / relecture / orbite / étage / charge utile           |
| contact / tracked / follow                    | contact / suivi / suivre                                        |
| installation / site / mapped                  | installation / site / cartographié                              |
| camera / CCTV camera                          | caméra / caméra CCTV                                            |
| earthquake / fire / fire perimeter            | séisme / incendie / périmètre d'incendie                        |
| radio station / station tag / station site    | station / étiquette de station / site de la station             |
| directory / directory refresh                 | répertoire / actualisation du répertoire                        |
| road / flow (traffic) / route                 | route / flux / itinéraire                                       |
| scene / shot / shot camera / run log          | scène / plan / caméra du plan / journal d'exécution             |
| briefing / panel / dock                       | briefing / panneau / barre                                      |
| cockpit / vision style                        | cockpit / style de vision                                       |
| preset / visual preset / active style         | préréglage / préréglage visuel / style actif                    |
| scope / feather / celestial ring              | hublot / adoucissement / anneau céleste                         |
| bloom / glow / sharpen / grain / vignette     | halo / lueur / netteté / grain / vignettage                     |
| Cyber / detection overlay / detection opacity | Cyber / superposition de détection / opacité de la détection    |
| pin / draw / drawing the map                  | repère / dessiner / dessin sur la carte                         |
| position tray / landmark                      | tiroir de position / repère                                      |
| weather / wind / sea level pressure / forecast| météo / vent / pression au niveau de la mer / prévision         |
| cloud / clear / overcast                      | nuageux / dégagé / couvert                                      |
| fire confidence / fire behavior               | confiance du feu / comportement du feu                          |
| squawk / transponder code / emergency         | squawk / code transpondeur / urgence                            |
| heading, course / bearing / track             | cap / relèvement / route                                        |
| satellite speed / ground speed                | vitesse du satellite / vitesse sol                              |
| root / upstream / snapshot                    | amont / amont / instantané                                      |
| saved / unsaved / authored                    | enregistré / non enregistré / composé                           |
| scoped / out of coverage                      | dans un rayon / hors de la couverture                           |
| from the last poll / feed age                 | depuis la dernière remontée / âge du flux                       |
| now / just now / lately / stale               | à l'instant / il y a un instant / il y a X / périmé             |
| offline (audio synthesizer / feed)            | hors ligne / en panne                                            |
| season (visual preset) / sky                  | saison / ciel                                                    |
| Ski / Snow (weather presets)                  | Ski / Neige                                                     |
| Holo / HUD theme names                        | noms de thèmes restés tels quels (CRT, NVG, FLIR, Anime, Noir…) |
| RAW / CALIBRATED / CURATED (CCTV)             | BRUT / ÉTALONNÉ / VÉRIFIÉ                                       |
| Live Flights                                  | Vols en direct                                                  |
| Active fires / FIRMS                          | Incendies actifs / FIRMS                                        |
| Mapped installations                          | Installations cartographiées                                    |
| Global Context                                | Contexte global                                                  |
| Submarine cables                              | Câbles sous-marins                                              |
| Earthquakes (24h)                             | Séismes (24 h)                                                  |
| Satellite constellations                      | Constellations de satellites                                    |
| Cyclones                                      | Cyclones                                                        |
| Street Traffic                                | Trafic routier                                                  |
| Air quality                                   | Qualité de l'air                                                |
| GNSS Integrity                                | Intégrité GNSS                                                  |
| Bike Share / Bikeshare                        | Vélos en libre-service                                          |
| Transit                                       | Transports en commun                                            |
| Cameras                                       | Caméras                                                         |
| Street Level                                  | Street Level                                                    |
| Recent Imagery                                | Imagerie récente                                                |
| Fire perimeters                               | Périmètres de feux                                              |
| Cyclone advisories                            | Avis de cyclones                                                |
| Local ADS-B / RTL-SDR / SDR decoder           | ADS-B local / RTL-SDR / décodeur SDR                            |
| WebUSB / USB                                  | WebUSB / USB                                                    |
| Previous / Next                               | Précédent / Suivant                                             |
| Start here / Show all / Deselect              | Commencer ici / Tout afficher / Désélectionner                  |
| Last N days/years                             | N derniers jours / N dernières années                           |
| Sign in / OAuth / API key / token             | connexion / OAuth / clé d'API / jeton                           |
| share link / import / export                  | lien de partage / import / export                               |
| provider / covering region                    | fournisseur / région couverte                                   |

## What stays in English

- Codes, callouts and device acronyms: ADS-B, AIS, CCTV, GNSS, GPS, GLONASS, Galileo, HUD, CRT, NVG, FLIR, HDR, USB, SDR, RTL-SDR, FM, AM, dB, dBFS, MW, MMSI, AQHI, NHC, CPHC, NOAA, USGS, ECCC, NESDIS, GFS, ECMWF, OpenAI, ChatGPT, Google, Cesium, CelesTrak, Mapillary, Panoramax, KartaView, OpenStreetMap, TomTom, OSM, HLS, NWS.
- Theme names: Normal, CRT, NVG, FLIR, Anime, Noir, Snow, Cyber, Whot/Bhot, Ironbow. Radio genre names: Ambient, Blues, Country, Dance, Folk, Funk, Hip-Hop, House, Indie, Jazz, Latin, Metal, Pop, Punk, R&B, Reggae, Rock, Soul, Techno, Trance, World.
- Button combinations and key names stay where they name a keyboard key: Space, Esc, Enter, Tab, Shift, H, 1–9, A, B, S.
- Common short words used across the French interface already: OK, VS, LIVE, SYNC, PAUSE, STOP, START, END, INFO, MSG/S, STATION, AUTO, MINI, STD, MM, KM, GAIN.
