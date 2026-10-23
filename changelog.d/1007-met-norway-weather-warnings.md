- Add a Weather Warnings layer under Weather for Norway: MET Norway's official
  yellow, orange and red warnings for land and sea areas (gale, wind, rain,
  snow, flooding and other MET events), NVE flood and landslide warnings
  (yellow and above, drawn over the warned municipalities using Kartverket
  outlines) and Varsom avalanche danger levels 2–5 by forecast region, all in
  effect now. Row chips switch Weather, Flood, Landslide and Avalanche on and
  off, and selecting an area opens a card with level, area, validity, the
  warning text and advice, linking to MET Norway or Varsom. Data is fetched
  keyless through `/api/weather-warnings`, which caches each feed separately
  so one failing provider leaves the others shown, and identifies itself as
  api.met.no requires. Voice and the analyst query can address the layer, and
  share links carry it as token `5` (trygvehhh, #1007).
