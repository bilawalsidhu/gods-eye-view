export const LAYER_ID = 'local-adsb';
export const LAYER_NAME = 'Local ADS-B';
export const LAYER_SOURCE = 'RTL-SDR · WebUSB';
/** Distinct from the public Flights palette so both can be drawn together. */
export const LOCAL_ADSB_COLOR = '#ff4fd8';
/** Ring drawn around 978 MHz UAT aircraft: same magenta family, lighter. */
export const LOCAL_ADSB_UAT_RING_COLOR = '#ffb3ef';
export const ENTITY_PREFIX = `${LAYER_ID}:`;
/** Re-evaluate marker freshness and the card's position age this often. */
export const LOCAL_ADSB_TICK_MS = 1_000;
/** Coalesce receiver bursts into at most one scene sync per interval. */
export const LOCAL_ADSB_SYNC_MS = 200;
export const HEARD_BY_RECEIVER = 'Heard by your receiver';
export const BAND_LABELS = Object.freeze({
  1090: '1090 MHz',
  978: '978 MHz UAT',
});
export const SOURCE_LABELS = Object.freeze({
  webusb: 'browser SDR',
  feed: 'decoder feed',
});
