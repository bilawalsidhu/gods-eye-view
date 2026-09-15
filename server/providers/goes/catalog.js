export const GOES_SATELLITES = Object.freeze([
  Object.freeze({
    id: 'GOES-19',
    starCode: 'GOES19',
    role: 'east',
    lon0: -75.2,
  }),
  Object.freeze({
    id: 'GOES-18',
    starCode: 'GOES18',
    role: 'west',
    lon0: -137.0,
  }),
]);
export const GOES_STAR_PRODUCT = 'GEOCOLOR';
export const GOES_STAR_PRODUCTS = Object.freeze({
  // STAR's GeoColor and C13 JPEG endpoints are the native 2 km full-disk
  // product.  Keep dimensions explicit: they are part of the data contract.
  GEOCOLOR: Object.freeze({
    id: 'GEOCOLOR',
    label: 'GeoColor',
    endpointSize: 5424,
    nativeWidth: 5424,
    nativeHeight: 5424,
    nominalResolutionKm: 2,
    resolutionState: 'native',
  }),
  ABI13: Object.freeze({
    id: 'ABI13',
    label: 'ABI channel 13 infrared',
    endpointSize: 5424,
    nativeWidth: 5424,
    nativeHeight: 5424,
    nominalResolutionKm: 2,
    resolutionState: 'native',
  }),
  // STAR's largest non-ZIP C02 JPEG is 5424px. The nominal 0.5 km
  // 21696px native ZIP is intentionally not consumed by this single-image
  // path (and must not trigger unbounded ZIP expansion).
  ABI2: Object.freeze({
    id: 'ABI2',
    label: 'ABI channel 2 visible',
    endpointSize: 5424,
    nativeWidth: 21696,
    nativeHeight: 21696,
    nominalResolutionKm: 0.5,
    resolutionState: 'fallback',
    fallbackWidth: 5424,
    fallbackHeight: 5424,
    fallbackResolutionKm: 2,
    nativeZipNote:
      'The 21696x21696 native C02 ZIP is not consumed by the single-image pipeline.',
  }),
});
export function isGoESStarProduct(product) {
  return Object.hasOwn(GOES_STAR_PRODUCTS, product);
}

/** Return the current STAR CDN image URL for a satellite. */
export function starImageUrl(
  satellite,
  { size, product = GOES_STAR_PRODUCT } = {},
) {
  if (!isGoESStarProduct(product))
    throw new RangeError(`Unsupported STAR product: ${product}`);
  size ??= GOES_STAR_PRODUCTS[product].endpointSize;
  return `https://cdn.star.nesdis.noaa.gov/${satellite.starCode}/ABI/FD/${product}/${size}x${size}.jpg`;
}
