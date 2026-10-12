/** 简体中文语言包 — 本地 RTL-SDR 卡片。 */
export default {
  card: {
    aria: '本地 RTL-SDR 接收机',
    title: '本地 RTL-SDR',
    browserNote:
      'Chrome/Edge · WebUSB · 一个本地调谐器由 FM 与本地 ADS-B 图层共享。',
  },
  connect: {
    connect: '连接',
    disconnect: '断开连接',
    transitionalConnecting: '连接中',
    transitionalTuning: '调谐中',
  },
  locate: {
    locate: '定位',
    located: '已定位',
    locating: '定位中…',
    title: '使用你的位置以更快解码 ADS-B 位置',
  },
  changeDevice: {
    label: '更换设备',
    title: '选择其他 RTL-SDR 或接收通道',
  },
  mode: {
    aria: 'RTL-SDR 接收模式',
    fm: 'FM',
    adsb: 'ADS-B · 1090',
  },
  gain: {
    label: '增益',
    aria: '当前模式下的 RTL-SDR 调谐器增益',
    auto: '自动',
  },
  connection: {
    streaming: '正在流式接收',
    heard: '已收到 {count} 架',
  },
  stats: {
    rate: '消息/秒',
    heard: '已收到',
    positioned: '已定位',
    iq: 'IQ',
  },
  frequency: {
    label: 'FM MHz',
  },
  tune: {
    label: '调谐',
  },
  seek: {
    aria: '搜索广播 FM 电台',
    back: '◀ 搜台',
    forward: '搜台 ▶',
  },
  volume: {
    label: 'SDR 音量',
    aria: '本地 SDR 音量',
  },
  status: {
    waitingIq: '等待 IQ 数据',
    messages: '{count} 条消息',
    dspBlocks: 'DSP {count} 个模块',
    dspWaiting: 'DSP 等待中',
    audioSignal: '音频信号 --',
    audioState: '音频 {state}',
  },
  feed: {
    prefix: '解码馈源：',
    suffix: ' · 仅在本地 ADS-B 开启时读取',
  },
};
