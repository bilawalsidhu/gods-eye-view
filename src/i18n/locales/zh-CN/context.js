/** 简体中文语言包 — 全局态势侧栏：面板框架、模式选项卡与模块提示。 */
export default {
  panel: {
    collapse: '折叠面板',
    expand: '展开面板',
  },
  panels: {
    weather: {
      title: '天气',
      countAria: '活跃天气产品',
    },
    imagery: {
      title: '近期影像',
      countAria: '影像盒内的天数',
    },
    context: {
      title: '态势',
    },
  },
  modes: {
    tablistAria: '态势模式',
    contacts: {
      label: '目标',
      tooltip:
        '循环切换你所选类型的最近目标 — 飞机、船舶、设施。卫星独立跟踪。',
    },
    spaceMissions: {
      label: '太空任务',
    },
  },
  modeWord: {
    context: '态势',
    spaceMissions: '太空任务',
  },
  standby: {
    title: '选择态势',
    contacts: '目标 — 最近的飞机 · 船舶 · 地点',
    spaceMissions: '太空任务 — 发射与轨道资产',
  },
  actions: {
    aria: '目标态势操作',
    cockpit: '驾驶舱',
    searchNearby: '搜索附近设施',
    tr3bAria: '将跟踪目标重新归类为 TR-3B',
    tr3bTitle: '重新归类为 TR-3B',
  },
  awareness: {
    off: '目标态势未开启',
    hint: '选择目标以加载观测 / 已测绘的邻近信息',
  },
  roster: {
    aria: '可用太空任务',
    title: '可用任务',
    hint: '选择一个任务进行查看',
    loading: '正在加载 30 天任务索引',
    hintKeys: 'TAB 预览 · ENTER / 空格 选择',
  },
  toast: {
    restoreFailed: '态势未能恢复所有图层，请重试',
    noneSelected: '没有已选数据图层',
    notCleared: {
      one: '{count} 个数据图层未能清除',
      other: '{count} 个数据图层未能清除',
    },
    cleared: {
      one: '已清除 {count} 个数据图层',
      other: '已清除 {count} 个数据图层',
    },
    clearFailed: '未能清除已选数据图层',
    contactsTransition: '目标未能完成请求的切换，请重试',
    missionsTransition: '太空任务未能完成请求的切换，请重试',
    installationsRefreshed: '附近设施已刷新',
    installationsFailed: '附近设施刷新失败，请重试',
    zoomIn: '放大地图以搜索已测绘设施',
    layerUnavailable: '当前态势模式下该图层不可用',
    layerStartFailed: '{layerId} 未能正常启动',
    layerStopFailed: '{layerId} 未能正常停止',
    missionsRestoreFailed: '太空任务取消后未能恢复之前的图层状态',
    startBlocked: '{mode} 未能启动，因为另一图层未能正常停止',
  },
};
