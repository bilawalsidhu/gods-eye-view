/**
 * Simplified Chinese pack — 分析师答案卡用语：范围标签、截断说明、
 * 图层状态拒绝与区域查询。analystEngine.js 中面向模型的查询规格错误
 * 模板按设计保留英文。
 */
export default {
  scope: {
    anywhere: '已加载数据中的任意位置',
    inView: '视野内',
    overRegion: '{name} 范围内',
    withinKmOf: '距 {center} {km} 公里范围内',
    withinKm: '{km} 公里范围内',
    viewDetail: '距视图中心 {km} 公里范围内',
  },
  caveat: {
    countedFirst: '已统计最先加载的 {n} 条记录',
    countedOf: '已统计已加载 {m} 条记录中的 {n} 条',
    layerNote: '{layer}：{note}',
    layerStatus: '{layer} {status}',
  },
  refusal: {
    off: {
      one: '{names} 已关闭。可以让我打开它们。',
      other: '{names} 已关闭。可以让我打开它们。',
    },
    notReady: {
      one: '{names} 仍在加载或处于关闭状态——暂无记录。',
      other: '{names} 仍在加载或处于关闭状态——暂无记录。',
    },
    unavailable: {
      one: '{names} 当前不可用或已关闭。',
      other: '{names} 当前不可用或已关闭。',
    },
  },
  region: {
    timeout: '正在查询“{name}”的边界耗时过长——请稍后重试。',
    unresolved: '无法解析“{name}”的边界——请尝试州、国家或具名自然区域。',
  },
};
