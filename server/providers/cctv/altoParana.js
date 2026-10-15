/** Public operator feeds; directory coordinates are area anchors, not mounts.
 * Source and location references: docs/CCTV-PARAGUAY.md.
 */
export function loadAltoParanaSources() {
  return [
    {
      id: 'paraguay-atacado-connect',
      name: 'Puente de la Amistad / Aduana PTZ (approximate location)',
      city: 'Ciudad del Este',
      cityId: 'ciudad-del-este',
      provider: 'Atacado Connect',
      lat: -25.509005,
      lon: -54.607234,
      feedType: 'hls',
      url: 'https://video02.logicahost.com.br/brimostech/camatg01.stream/playlist.m3u8',
      sourcePageUrl:
        'https://atacadoconnect.com/camera-da-ponte-da-amizade-ao-vivo',
      locationNote:
        'Approximate bridge-area anchor; camera mount unverified. One PTZ feed rotates between bridge and customs views.',
      headingConfidence: 'low',
      sourceKind: 'public-webcam',
      license: 'Public operator feed; no open video license asserted.',
      credit: 'Atacado Connect · LógicaHost',
      code: 'CDE AMISTAD PTZ',
    },
    ...[1, 2].map((number) => ({
      id: `paraguay-ibarra-cam${number}`,
      name: `San Lorenzo CAM${number} (approximate location)`,
      city: 'Presidente Franco',
      cityId: 'presidente-franco',
      provider: 'Grupo Ibarra',
      lat: -25.5503,
      lon: -54.6317,
      feedType: 'hls',
      // The published 1024×576 variant fits the bounded relay and panel.
      url: `https://www.gibarra.com.py/v${number}_1/cam.m3u8`,
      snapshotUrl: `https://www.gibarra.com.py/cam${number}.jpg`,
      sourcePageUrl: 'https://www.gibarra.com.py/',
      locationNote:
        'Approximate San Lorenzo area anchor shared by two cameras; mounts and facing unverified.',
      headingConfidence: 'low',
      sourceKind: 'public-webcam',
      license: 'Public operator feed; no open video license asserted.',
      credit: 'Grupo Ibarra',
      code: `PFR IBARRA ${number}`,
    })),
  ];
}
