// Shared 750-station directory for legacy and both-engine radio QA.
const tags = [
  'news',
  'talk',
  'weather,emergency',
  'public safety,scanner',
  'aviation,atc',
  'marine,maritime',
  'traffic,transit',
  'music,jazz',
  'music,rock',
  'community',
];
export const stations = Array.from({ length: 750 }, (_, index) => {
  const row = Math.floor(index / 30);
  const column = index % 30;
  return {
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    name:
      index === 360
        ? '100.3 The River - WQRV - Meridianville/Huntsville, AL'
        : index === 390
          ? 'La Zeta (Hermosillo) - 93.9 FM - XHHY - Uniradio - Hermosillo, Sonora'
          : `QA Radio ${String(index + 1).padStart(3, '0')}`,
    lat: -72 + row * 6,
    lon: -174 + column * 12,
    streamUrl: `https://audio.example.test/${index}.mp3`,
    homepage: `https://station.example.test/${index}`,
    tags: tags[index % tags.length].split(','),
    languages: index === 360 ? ['Spanish'] : ['English'],
    state: `Region ${row + 1}`,
    country: 'United States',
    countryCode: 'US',
    metadataTrust: 'untrusted-community',
    codec: index % 2 ? 'AAC' : 'MP3',
    bitrate: 128,
  };
});
