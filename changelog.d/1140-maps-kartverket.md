- Add Kartverket Topo and Kartverket Nautical as keyless basemaps for Norway:
  Norway's topographic map and nautical charts from Kartverket's open WMTS
  cache (CC BY 4.0), as map-source chips, share-link ids
  (`map=kartverket-topo`, `map=kartverket-nautical`) and voice stacks. Tiles
  are asked only within each map's extent; a failing tile source falls back to
  OSM (trygvehhh, #1140).
