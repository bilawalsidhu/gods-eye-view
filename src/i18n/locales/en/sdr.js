/** Local RTL-SDR card (templates/context.html + localSdr* modules). */
export default {
  card: {
    aria: 'Local RTL-SDR receiver',
    title: 'LOCAL RTL-SDR',
    browserNote:
      'Chrome/Edge · WebUSB · one local tuner shared by FM and the Local ADS-B layer.',
  },
  connect: {
    connect: 'CONNECT',
    disconnect: 'DISCONNECT',
    transitionalConnecting: 'CONNECTING',
    transitionalTuning: 'TUNING',
  },
  locate: {
    locate: 'LOCATE',
    located: 'LOCATED',
    locating: 'LOCATING…',
    title: 'Use your location for faster ADS-B position decoding',
  },
  changeDevice: {
    label: 'CHANGE DEVICE',
    title: 'Choose a different RTL-SDR or receiver channel',
  },
  mode: {
    aria: 'RTL-SDR receiver mode',
    fm: 'FM',
    adsb: 'ADS-B · 1090',
  },
  gain: {
    label: 'GAIN',
    aria: 'RTL-SDR tuner gain for the current mode',
    auto: 'AUTO',
  },
  connection: {
    streaming: 'STREAMING',
    heard: '{count} HEARD',
  },
  stats: {
    rate: 'MSG/S',
    heard: 'HEARD',
    positioned: 'POSITIONED',
    iq: 'IQ',
  },
  frequency: {
    label: 'FM MHZ',
  },
  tune: {
    label: 'TUNE',
  },
  seek: {
    aria: 'Seek broadcast FM stations',
    back: '◀ SEEK',
    forward: 'SEEK ▶',
  },
  volume: {
    label: 'SDR VOL',
    aria: 'Local SDR volume',
  },
  status: {
    waitingIq: 'waiting for IQ',
    messages: '{count} messages',
    dspBlocks: 'DSP {count} blocks',
    dspWaiting: 'DSP waiting',
    audioSignal: 'audio signal --',
    audioState: 'audio {state}',
  },
  feed: {
    prefix: 'Decoder feeds:',
    suffix: ' · read while Local ADS-B is on',
  },
};
