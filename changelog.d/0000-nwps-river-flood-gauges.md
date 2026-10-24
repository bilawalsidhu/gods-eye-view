- Add the River Flood Gauges layer (Events group): about 13,000 NOAA National
  Water Prediction Service river gauges, coloured by the NWS flood category of
  their latest reading (action, minor, moderate, major), larger and on top while
  in flood. A click opens a card with the stage, flow and age of the reading, a
  current river forecast, the gauge's flood stages, its highest and most recent
  crests and its USGS site id, and links to the gauge's water.noaa.gov page;
  **SHOW MOST SEVERE** flies to the worst flooding gauge. The server builds one
  national snapshot from seven regional NWPS reads, one at a time, at most every
  15 minutes and within NWPS's limit of 10 list requests per 5 minutes, keeps a
  failed region's previous gauges, and answers 503 with `Retry-After` until it
  has data. Categories are NOAA's, not flood warnings (daikaginza, #PR).
