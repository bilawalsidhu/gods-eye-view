- Active Fires works without a NASA FIRMS key for South America: the server
  serves INPE Programa Queimadas' 10-minute VIIRS, MODIS and GOES-19
  detections, credited in the layer row and attribution (Itallo Brandão,
  @IMBrandao, #1573).
- Guard against a temporary HTTP-200 INPE directory response with no CSV
  names after a populated fetch: retain the last-good fires for retry instead
  of replacing them with a misleading empty success (follow-up to IMBrandao's
  #1573 contribution).
