- A whole-project cleanup removes about 19,400 lines of dead code, duplicate
  helpers and tests that only restated constants, and fixes a few small bugs:
  Local ADS-B lookups retry after a temporary failure, adsb.lol categories
  C1-C5 map to their OpenSky codes, a level CCTV camera sends 0 degrees pitch,
  the Rail prompt shows its real activation altitude, the launch landing label
  follows the current language, the HUD sun elevation uses the real sun
  position, and an oversized key-setup request gets 413. Panoramax asset links
  must be public HTTPS, and AIS reports only `live` as healthy (gekh, #1974).
