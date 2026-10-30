// WFS features for the Vegbilder provider's tests.

const IMAGE_HOST = 'https://s3vegbilder.atlas.vegvesen.no';

/** A WFS photo feature on Rv. 162 in Oslo, `meter` along the road, `seconds` into the drive. */
export function vegbilderFeature({
  year = 2025,
  pano = false,
  meter = 568,
  seconds = 0,
  lane = '1',
  day = '06-19',
  lon = 10.75704,
  lat = 59.91032,
  withUrls = true,
} = {}) {
  const time = new Date(
    Date.parse(`${year}-${day}T04:39:00+02:00`) + seconds * 1000,
  );
  const stamp = time.toISOString().slice(0, 19).replaceAll(':', '.');
  const kind = pano ? '360' : 'Planar';
  const type = `Vegbilder_${pano ? '360_' : ''}${year}`;
  return {
    type: 'Feature',
    id: `${type}.${stamp}_RV00162_S1D50_m${String(Math.round(meter)).padStart(5, '0')}_${kind}_${lane}`,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      BILDETYPE: pano ? '360' : 'Planar',
      AAR: year,
      TIDSPUNKT: time.toISOString(),
      VEGKATEGORI: 'R',
      VEGSTATUS: 'V',
      VEGNUMMER: 162,
      STREKNING: 1,
      DELSTREKNING: 50,
      ANKERPUNKT: null,
      KRYSSDEL: null,
      SIDEANLEGGSDEL: null,
      METER: meter,
      FELTKODE: lane,
      RETNING: 198.26,
      ...(withUrls
        ? {
            URL: `${IMAGE_HOST}/vegfoto-prod-w-${year}/${kind}/f.jpg?sig=a+b=`,
            ...(pano
              ? {
                  URLPREVIEW: `${IMAGE_HOST}/vegfoto-prod-w-${year}/${kind}/f_preview.jpg?sig=c`,
                }
              : {}),
          }
        : {}),
    },
  };
}

/** Photos `step` metres apart heading north along one lane, in drive order. */
export function driveFeatures(count, { step = 10, start = 0, ...rest } = {}) {
  return Array.from({ length: count }, (_, i) =>
    vegbilderFeature({
      meter: start + i * step,
      seconds: i,
      lat: 59.91 + (start + i * step) / 110_540,
      ...rest,
    }),
  );
}
