/** Simplified Chinese pack — CCTV camera panel. */
export default {
  panel: {
    title: '监控',
  },
  frameAlt: '监控画面',
  selectAria: '监控摄像头',
  toggle: {
    on: '监控开',
    off: '监控关',
  },
  nearest: '最近',
  prev: '上一个',
  next: '下一个',
  focus: '聚焦',
  coverage: {
    on: '覆盖开',
    off: '覆盖关',
    viewshed: '视域开',
  },
  autoHop: {
    on: '自动跳转开',
    off: '自动跳转关',
  },
  projection: {
    on: '投影开',
    off: '投影关',
  },
  cal: {
    title: '标定',
    adjust: '调整',
    adjustOn: '调整开',
    adjustTooltip: '在世界中拖动相机：圆环旋转，箭头平移，手柄设定距离/视场角',
    save: '保存标定',
    reset: '重置标定',
    readoutAria: '相机位姿——点击数值直接输入',
    chip: '标定 · {badge}',
    edited: '标定 · 已编辑（未保存）',
    headingTooltip: '航向（罗经角 °）——点击输入',
    pitchTooltip: '俯仰（° 上/下）——点击输入',
    fovTooltip: '水平视场角（°）——点击输入',
    rangeTooltip: '距离 / 监视平面距离（m）——点击输入',
    heightTooltip: '离地安装高度（m）——点击输入',
    northTooltip: '相对目录位置的北向偏移（m）——点击输入',
    eastTooltip: '相对目录位置的东向偏移（m）——点击输入',
  },
  badge: {
    calibrated: '已标定',
    curated: '人工校准',
    rawPrior: '原始先验',
    none: '--',
  },
  meta: {
    idle: '启用监控以加载摄像头路口',
    monitor: '显示器',
    off: '关闭',
    configuredSource: '已配置数据源',
    loadedClick: '已加载 {n} 个摄像头 · 点击摄像头以激活',
    loadedEnable: '已加载 {n} 个摄像头 · 启用监控以激活',
  },
  source: {
    unknown: '信号源 · 未知',
  },
  frame: {
    loading: '画面 · 加载中',
    unavailable: '画面 · 不可用',
  },
  sync: {
    gridReady: '摄像头网格就绪',
  },
  summary: {
    label: '场景摘要',
    idle: '启用监控以启动与摄像头联动的情报摘要。',
    empty: '暂无摘要。',
  },
  toast: {
    saved: '监控标定已保存',
    reset: '监控标定已重置',
  },
};
