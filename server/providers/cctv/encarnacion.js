/**
 * Public player published by the Municipality of Encarnación. The coordinates
 * identify the Centro Cívico / Sambódromo, not a surveyed camera mount:
 * https://encarnacion.gov.py/turismo/cicuito-recreacion-y-areas-verdes/
 * (municipal location link https://goo.gl/maps/FPPUYExxRyszFxoKA).
 * Keep the provider's player intact; never persist its expiring media tokens.
 */
export function loadEncarnacionSources() {
  return [
    {
      id: 'encarnacion-sambodromo',
      name: 'Sambódromo / Costanera (approximate location)',
      city: 'Encarnación',
      cityId: 'encarnacion',
      provider: 'Municipalidad de Encarnación',
      lat: -27.3290627,
      lon: -55.8749491,
      feedType: 'embed',
      embedUrl: 'https://rtsp.me/embed/3NsfyZGe/',
      sourcePageUrl: 'https://encarnacion.gov.py/en-vivo/',
      locationNote:
        'Approximate Sambódromo location; camera mount and facing unverified.',
      headingConfidence: 'low',
      sourceKind: 'municipal-player',
      license:
        'Public municipal player; no open license asserted for the video.',
      credit: 'Municipalidad de Encarnación · RTSP.me',
      code: 'ENC SAMBÓDROMO',
    },
  ];
}
