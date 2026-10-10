/**
 * 简体中文包 — 加载反馈：顶部状态芯片、交通同步回退与标记地点可用性文案。
 * 重试文案保留「原因 — 后续动作」的「 — 」分隔形状，供上层拆分。
 */
export default {
  layerFallback: '图层',
  trafficFallback: '正在同步路网',
  overpassDetail: 'OpenStreetMap · Overpass',
  overpassUnavailable: 'Overpass 暂时不可用',
  camera: {
    retryIn: 'ALPR 摄像头 · 将在 {seconds} 秒后重试',
    retryPending: 'ALPR 摄像头 · 等待重试',
    retrying: '正在重试 ALPR 摄像头',
    fetching: '正在获取 ALPR 摄像头',
  },
  sites: {
    retrying: '正在重试标记地点',
    fetching: '正在获取标记地点',
  },
  batch: {
    loading: '正在加载实时数据',
    refreshing: '正在刷新实时数据',
    turningOff: '正在关闭实时数据',
    complete: '加载完成',
    cancelled: '已取消加载',
    failed: '加载失败',
    liveOff: '实时数据已关闭',
    sitesLoaded: '标记地点已加载',
  },
  install: {
    rate_limited: 'Overpass 已被限流',
    timeout: 'Overpass 请求超时',
    query_failed: 'Overpass 无法完成查询',
    tiles_unavailable: '地图瓦片暂时不可用',
    names_unavailable: '地点名称暂时不可用',
    unavailable: 'Overpass 暂时不可用',
    fetching: '正在获取标记地点…',
    retrying: '正在重试标记地点…',
    retryingIn: '{reason} — 将在 {seconds} 秒后重试',
    retryPending: '{reason} — 等待重试',
    zoomIn: '放大以搜索标记设施',
    stale: '正在显示缓存的标记地点',
    idle: '标记地点未加载',
    whereNear: '（距目标 {km} 公里内）',
    whereInView: '（视野内）',
    noSites: '未找到标记地点{where}',
    sites: {
      one: '{count} 个标记地点{where}',
      other: '{count} 个标记地点{where}',
    },
    loaded: '标记地点已加载',
  },
};
