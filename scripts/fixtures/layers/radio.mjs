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

export async function installRadioFixture(page) {
  await page.evaluateOnNewDocument((stations) => {
    localStorage.clear();
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    window.__qaRadio = {
      stations,
      generation: 1,
      plays: [],
      delay: 0,
      response: 'normal',
      pending: null,
    };
    HTMLMediaElement.prototype.play = function () {
      window.qaPlayer = this;
      window.__qaRadio.plays.push(this.src);
      if (window.__qaRadio.delayPlay) {
        window.__qaRadio.delayPlay = false;
        return new Promise((resolve) => {
          window.__qaRadio.releasePlay = () => {
            this.dispatchEvent(new Event('playing'));
            resolve();
          };
        });
      }
      queueMicrotask(() => this.dispatchEvent(new Event('playing')));
      return Promise.resolve();
    };
    const fetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const address = String(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      );
      if (address.includes('/api/radio/stations')) {
        const qa = window.__qaRadio;
        qa.reads = (qa.reads || 0) + 1;
        const response = {
          stations: qa.response === 'empty' ? [] : qa.stations,
          updatedAt: new Date().toISOString(),
          stale: false,
          degraded: false,
          acceptedGeneration: qa.generation,
          catalogInstance: 'fixture-radio-fixture',
        };
        const mode = qa.response;
        const delay = qa.delay;
        qa.delay = 0;
        if (delay)
          await new Promise((resolve) => {
            qa.pending = resolve;
          });
        init?.signal?.throwIfAborted();
        return new Response(
          mode === 'failure' ? '{}' : JSON.stringify(response),
          {
            status: mode === 'failure' ? 503 : 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (address.includes('/api/radio/click/'))
        return new Response(null, { status: 204 });
      if (address.includes('/api/flights'))
        return new Response('{"states":[]}');
      if (address.includes('/api/military')) return new Response('{"ac":[]}');
      if (address.includes('/api/vessels'))
        return new Response('{"connected":false,"vessels":[]}');
      return fetch(input, init);
    };
  }, stations);
}
