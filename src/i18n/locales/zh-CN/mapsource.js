/** 简体中文包 — 地图来源栏：来源芯片、状态回退与不可用原因。品牌名保留原文。 */
export default {
  status: {
    switching: '...',
    fallback: '地图',
  },
  chip: {
    aria: '{label} 不可用：{hint}',
  },
  stack: {
    unavailable: '{label} 不可用',
    unavailableFallback: '此地图来源',
  },
  esri: {
    fallback: 'Esri Satellite 不可用；正在使用 OSM',
    tileFallback: 'Esri Satellite 瓦片请求失败；正在使用 OSM',
  },
  photoreal: {
    keyed: 'Google 3D 瓦片不可用 — 请检查密钥的 API 限制、配额或网络',
    keyless: '{requirement} — 或使用 Cesium ion 令牌走 ion 托管路线',
  },
};
