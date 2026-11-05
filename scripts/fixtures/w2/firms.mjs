// Real /api/firms envelope; fixed source receipt and acquisition clocks.
export const FIRMS_EPOCH_MS = Date.UTC(2026, 9, 16, 12);
export const FIRMS_VALID_COUNT = 371;

export function firmsFixture() {
  const fires = [];
  const regions = [
    [37.77, -122.42],
    [30.27, -97.74],
    [61.2, -149.9],
  ];
  for (const [region, [latitude, longitude]] of regions.entries()) {
    for (let row = -5; row <= 5; row++) {
      for (let column = -5; column <= 5; column++) {
        const index = fires.length;
        fires.push({
          lat: latitude + row * 0.12,
          lon: longitude + column * 0.12,
          frp:
            region === 0 && row === 0 && column === 0 ? 999 : 5 + (index % 120),
          confidence: ['low', 'nominal', 'high', 85][index % 4],
          brightness: 280 + (index % 90),
          daynight: index % 2 ? 'N' : 'D',
          acqDate: '2026-10-16',
          acqTime: String(800 + (index % 60)),
          instrument: index % 4 === 3 ? 'MODIS' : 'VIIRS',
          satellite: index % 4 === 3 ? 'Terra' : 'NOAA-20',
        });
      }
    }
  }
  for (const [lat, lon] of [
    [10, 179.7],
    [10, -179.7],
    [89.5, 45],
    [-89.5, -135],
    [0.2, 179.8],
    [-0.2, -179.8],
    [70, 179.5],
    [-70, -179.5],
  ]) {
    fires.push({
      lat,
      lon,
      frp: 30,
      confidence: 'high',
      brightness: 320,
      daynight: 'D',
      acqDate: '2026-10-16',
      acqTime: '930',
      instrument: 'VIIRS',
      satellite: 'NOAA-20',
    });
  }
  fires.push({ lat: 'invalid', lon: 0 }, { lat: 0, lon: 'invalid' });
  return { fires, fetchedAt: FIRMS_EPOCH_MS - 120000, stale: false };
}
