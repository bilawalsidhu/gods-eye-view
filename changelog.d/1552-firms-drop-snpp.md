- Stop requesting Suomi NPP in Active Fires. NASA stopped delivering its data
  on November 2, 2026, so `VIIRS_SNPP_NRT` returned no rows while still costing
  a MAP_KEY transaction on every refresh; the layer now merges VIIRS NOAA-20,
  VIIRS NOAA-21 and MODIS (IMBrandao, #1552).
