/** Simplified Chinese pack — 传感图层（本地 ADS-B / ALPR 摄像头 / 标绘设施）。
 * 航空缩写（ICAO、ALT、GS、TRK、V/S、FPM、MSG、FT、KT）与频段符号
 * （1090 MHz、978 MHz UAT）保持原样。 */
export default {
  localAdsb: {
    heardBy: '由你的接收机接收',
    source: {
      webusb: '浏览器 SDR',
      feed: '解码器数据源',
    },
    status: {
      feedsSource: '解码器数据源',
      combinedSource: 'WebUSB + 解码器数据源',
      feedProblem: {
        one: '数据源 {list} {status}',
        other: '数据源 {list} {status}',
      },
      feedsLive: {
        one: '{live} 路数据源在播 · {heard}',
        other: '{live} 路数据源在播 · {heard}',
      },
      heardRate: '已收到 {heard} 架 · {rate}',
      heardCount: '已收到 {n} 架',
      msgRate: '{rate} msg/s',
      openingReceiver: '正在打开接收机',
      checkingFeeds: '正在检查解码器数据源',
      webusbUnsupported: 'WebUSB 需要桌面版 Chrome 或 Edge',
      connectHint: '在电台面板连接接收机',
      fmMode: '接收机处于 FM 模式',
      listening: '正在监听',
      usbError: 'USB 错误',
    },
    card: {
      receiverAndFeed: '你的 RTL-SDR 接收机和解码器数据源',
      receiverFeed: '你的解码器数据源',
      receiver: '你的 RTL-SDR 接收机',
      noCallsign: '无呼号',
      ageValue: '{n} 秒前',
      position: {
        one: '位置 {pos} · {messages} 条消息',
        other: '位置 {pos} · {messages} 条消息',
      },
    },
    feedName: '数据源',
  },
  alpr: {
    rowName: 'ALPR 摄像头',
    entity: 'ALPR 摄像头',
    displayFallback: 'ALPR 摄像头',
    sourceFallback: '摄像头来源',
    osmMapped: 'OSM 已标绘',
    sourceNamed: '来源：{name}',
    direction: '方向 {deg}°',
    publicMapData: '公共地图数据',
    chipShowNearest: '最近摄像头',
    chipTitleBlocked: '请先停止跟踪当前目标，再前往摄像头',
    chipTitle: '前往最近已加载的摄像头并显示详情',
    legendLabel: '摄像头徽标',
    legendBlurb:
      '选中后青色摄像头变为珊瑚色。扇形仅示意已标绘方向，并非实测覆盖范围。附近的摄像头可能不在屏幕内。',
    noneOnScreen: '屏幕上没有摄像头 —— 附近的摄像头在视野之外',
    retrying: '正在重试加载 ALPR 摄像头',
    loading: '正在加载 ALPR 摄像头',
    noDataArea: '此区域没有 ALPR 数据 —— 仅覆盖美国和加拿大',
    zoomIn: '放大以加载标绘摄像头',
    cached: '正在显示缓存位置',
    coverageLimited: '覆盖受限 —— 请放大',
    noData: '此区域没有 ALPR 数据',
  },
  installations: {
    loading: '正在加载标绘设施背景信息',
    withinKm: '{n} 公里范围内',
    viewportOnly: '仅当前视口',
    placesUnavailable: 'Google Places 搜索不可用；仅显示已标绘地点',
    servingCached: '正在提供缓存的标绘背景 · {date}',
    tooManySites: '视野内标绘地点过多，无法全部列出',
    contextUnavailable: '设施背景信息不可用',
  },
};
