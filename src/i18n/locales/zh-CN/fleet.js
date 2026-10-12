/** Simplified Chinese pack — 机队图层（航班 / 军用航班 / 船舶）及共享的机型、
 * AIS 船型词汇。术语遵循 docs/I18N.md：模拟、已过期等真实性语义不变，
 * LIVE/ICAO/MMSI/KT 等标记保持原样。 */
export default {
  flights: {
    context: {
      onGround: '在地面',
      statusStale: '已过期（丢失轮询）',
      statusLive: '实时',
    },
    tracked: {
      stale: '已过期',
    },
  },
  military: {
    context: {
      onGround: '在地面',
      statusStale: '已过期（丢失轮询）',
      statusLive: '实时',
    },
    tracked: {
      stale: '已过期',
      typeUnknown: '机型未知',
      regUnknown: '注册号未知',
      operatorUnknown: '运营方未知',
    },
  },
  aircraft: {
    altitudeUnknown: '高度未知',
  },
  aircraftClass: {
    light: '轻型飞机',
    glider: '滑翔机',
    turboprop: '涡桨飞机',
    airliner: '喷气客机',
    widebody: '宽体机',
    quadjet: '四发喷气机',
    helicopter: '直升机',
    fastjet: '喷气战机',
    bizjet: '公务机',
    uav: '无人机',
  },
  vessels: {
    awaitingPositions: '等待可用的 AIS 位置…',
    chip: {
      firstConnect: '等待第一个 AIS 位置…',
      apiKeyRejected: 'API 密钥被拒绝 — 请检查 AISSTREAM_API_KEY',
      feedSilentFor: '数据源已静默 {n} 秒 — 无 AIS 数据',
      feedSilent: '数据源已静默 — 无 AIS 数据',
      feedDown: '数据源中断 — 正在缓慢重试{suffix}',
      reconnecting: '正在重新连接数据源…{suffix}',
      attemptSuffix: '（第 {n} 次尝试）',
      awaitingPositions: '等待可用的 AIS 位置…',
      awaitingFirstMessage: '等待第一条 AIS 消息…',
      feedUnavailable: '数据源不可用',
      reasonDetail: '{reason}（{detail}）',
    },
    reason: {
      'missing-key': '未设置 AISSTREAM_API_KEY',
      unsupported: '不支持实时数据源',
      connecting: '正在连接数据源…',
      closed: '数据源已断开',
      error: '数据源中断',
      idle: '数据源空闲',
    },
    hud: {
      line: 'AIS：{name}',
      idle: 'AIS：--',
      typeFallback: '船舶',
      stale: '已过期',
    },
    card: {
      typeFallback: '船舶',
      unnamed: '船舶',
      stale: '已过期',
    },
  },
  aisType: {
    fishing: '捕捞',
    towing: '拖带',
    dredger: '挖泥船',
    diveOps: '潜水作业',
    military: '军用',
    sailing: '帆船',
    pleasure: '游艇',
    pilot: '引航船',
    sar: '搜救',
    tug: '拖船',
    portTender: '港作补给船',
    antiPollution: '防污船',
    lawEnforce: '执法船',
    medical: '医疗船',
    highSpeed: '高速船',
    passenger: '客运',
    cargo: '货运',
    tanker: '油轮',
    other: '其他',
  },
};
