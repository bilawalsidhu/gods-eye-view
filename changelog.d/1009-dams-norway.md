- Dams now cover Norway: the 4,141 dams in NVE's register (NLOD), where the
  layer previously had none. Cards show purpose, dam type, year built, power
  plant and municipality, and the analyst query and find_infrastructure tool
  return them. The data lives in its own file, built by
  `scripts/build-dams-norway.py`; the layer and query source load a main file
  plus regional supplements. The layer's source label now reads "OpenInfraMap
  · NVE" instead of "USACE" (trygvehhh, #1009).
