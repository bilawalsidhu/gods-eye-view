# Sun, time, shadows and limited news search

Open **SUN & NEWS** (in the phone menu under View & style). Neither function fetches news or enables itself at startup.

## Sun and shadows

Pick a globe point or enter coordinates, an IANA time zone, date and local wall time, and a vertical object height. **Calculate** uses locally vendored SunCalc 2.1.1; no API or remote service is involved. Time-zone gaps are rejected and repeated wall times select the earlier instant with an ambiguity notice. Sunrise/sunset, polar-day/night conditions and sun position are reported. The dashed shadow sketch assumes a vertical object on level unobstructed ground; terrain, buildings, weather and actual scene occlusion are not modeled. Near/below-horizon shadows are withheld. It does not change global globe lighting.

## Limited news fallback

Select a bounded rectangle and enter a city/region name plus optional topic and UTC date range, then explicitly choose **Search news**. The rectangle is local area-of-interest context only. GDELT DOC2 searches the place name in article text: **this is not verified spatial filtering**. Geographic retrieval was unavailable during verification: the documented GEO2 route returned HTTP 404; DOC2 returned HTTP 429. These observations do not establish that GEO2 is retired.

No news pins are drawn and no search-place geocoding is substituted for article/event coordinates. Cards link to publisher sources and label the GDELT seen/indexed time; publisher publication dates and event locations are not independently verified. Only text and UTC dates leave the PC, through the fixed DOC2 endpoint. No article bodies or publisher images are scraped. Results are bounded to 25, and old cards are marked stale on changes or failures. Rate limits respect Retry-After, with no automatic retry. Provider outages are shown as errors, never fabricated empty results.

## Verification

`npm run qa:sun-news -- --url http://127.0.0.1:4173` uses synthetic provider responses and an isolated browser to check desktop and phone layouts, safe source links, local calculations, pointer cancellation, stale/error/empty results and rate limits. It does not prove current GDELT availability or real article geography.

Primary provider contracts: [DOC2](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/), [GEO2](https://blog.gdeltproject.org/gdelt-geo-2-0-api-debuts/), [current data catalog](https://www.gdeltproject.org/data.html).
