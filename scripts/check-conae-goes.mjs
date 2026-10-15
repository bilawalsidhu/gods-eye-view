// Read-only diagnostic for the source contract; not an application provider.
const endpoint = 'https://geoservicios.conae.gov.ar/geoserver/FocosDeCalor/wfs';
const queries = [
  ['schema', {
    service: 'WFS', version: '1.0.0', request: 'DescribeFeatureType',
    typeName: 'FocosDeCalor:FocosGOES_24hs', outputFormat: 'application/json',
  }],
  ['sample', {
    service: 'WFS', version: '1.0.0', request: 'GetFeature',
    typeName: 'FocosDeCalor:FocosGOES_24hs', outputFormat: 'application/json',
    maxFeatures: '2', srsName: 'EPSG:4326',
  }],
];
let failed = false;
for (const [kind, params] of queries) {
  try {
    const response = await fetch(endpoint + '?' + new URLSearchParams(params), {
      signal: AbortSignal.timeout(25_000), redirect: 'error',
      headers: { Accept: 'application/json, application/xml, text/xml', 'User-Agent': 'Gods-Eye-View-CONAE-Source-Check/1.0' },
    });
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) {
        await reader.cancel();
        throw new Error('Response exceeds 256 KiB');
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    console.log(JSON.stringify({ kind, status: response.status, contentType: response.headers.get('content-type'), bytes: size }));
    if (!response.ok) throw new Error('HTTP ' + response.status);
    if (kind === 'sample') {
      const data = JSON.parse(body);
      if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
        throw new Error('Expected GeoJSON FeatureCollection');
      }
      console.log(JSON.stringify({
        kind, crs: data.crs ?? null, totalFeatures: data.totalFeatures ?? null,
        numberMatched: data.numberMatched ?? null, numberReturned: data.numberReturned ?? null,
        sample: data.features.slice(0, 2),
      }));
    } else {
      console.log(body.slice(0, 20000));
    }
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({ kind, error: error.message, cause: error.cause?.code ?? null }));
  }
}
if (failed) process.exitCode = 1;
