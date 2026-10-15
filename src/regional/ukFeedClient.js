/** Read a registered public feed; camera records retain their own provider links. */
export async function readUkFeed(id, signal, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(
    id === 'cameras' ? '/api/cctv/sources' : `/api/uk-data/${id}`,
    { signal },
  );
  if (!response.ok) throw new Error('Public data service unavailable');
  const data = await response.json();
  if (id !== 'cameras') return data;
  return {
    status: 'available',
    retrievedAt: new Date().toISOString(),
    message: data.trimmedPacks?.length
      ? 'The global camera limit may trim provider coverage.'
      : '',
    rows: (data.sources || [])
      .filter(
        (c) =>
          ['gateshead', 'a19', 'utmc-northeast', 'london'].includes(c.cityId) ||
          c.pack === 'tfl',
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        details: `${c.city} · ${c.provider} · snapshots, check the timestamp inside the image · camera direction estimated`,
        lat: c.lat,
        lon: c.lon,
        camera: true,
        url:
          c.sourcePage ||
          (c.cityId === 'london' || c.pack === 'tfl'
            ? 'https://tfl.gov.uk/traffic/status/'
            : 'https://netrafficcams.co.uk/'),
      })),
  };
}
