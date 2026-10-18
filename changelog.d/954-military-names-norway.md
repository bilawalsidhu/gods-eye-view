- Name Norway's unnamed military areas and place active bases that
  OpenStreetMap does not map. A small Norwegian supplement to the military
  name pack names five mapped areas OSM leaves unnamed (Andøya, Evenes and
  Gardermoen flystasjon, Værnes garnison, Luftkrigsskolen) and adds Wikidata
  positions for five active sites with no mapped area (Luftforsvarsbase Bodø,
  Banak flystasjon, Ramsund orlogsstasjon, Setermoen leir, Høybuktmoen leir),
  which now stay on the map in close views as well as wide ones. Every row
  cites its Wikidata item; OSM names always win. Operators with Overpass
  configured get the same names. `scripts/build-military-names-norway.py`
  rebuilds or `--verify`s the supplement from a pinned Geofabrik extract
  (trygvehhh, #954).
