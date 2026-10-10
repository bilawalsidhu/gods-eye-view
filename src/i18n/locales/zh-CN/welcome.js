/** Simplified Chinese pack — first-launch welcome launcher. */
export default {
  kicker: '任务控制 · 首次启动',
  title: '选择你的首个视图',
  description:
    '宛如置身未经授权的神秘驾驶舱——直到你发现，信源完全公开，数据皆为真实。',
  missions: {
    contacts: {
      label: '实时目标追踪',
      subcopy: '航空器、舰船与周边态势情报',
    },
    spaceMissions: {
      label: '航天与深空任务',
      subcopy: '火箭发射、在轨航天器与轨道空间态势',
    },
    environmental: {
      label: '全球环境监测',
      subcopy: '来自 USGS 与 NASA 的实时地震与火情监测',
      choices: {
        environmental: '全球环境监测',
        earthWatch: '地球观察',
        activeEvents: '活跃事件',
      },
    },
    explore: {
      label: '手动自主探索',
      subcopy: '从纯净的原生地球模型开始',
    },
  },
  suppress: '不再提示',
  escToDismiss: '按 ESC 关闭',
  tip: '提示：点击底栏的 GEV 麦克风按钮，可直接与地图进行语音交互。',
  busy: {
    contacts: '正在启动实时目标追踪…',
    spaceMissions: '正在打开航天与深空任务…',
    environmental: '正在扫描全球环境事件…',
    fallback: '正在处理…',
  },
  failure: {
    missionOpen: '无法打开该任务{detail}。请重试或手动探索。',
    storageBlocked: '该浏览器正在阻止存储，因此未能保存此项设置。',
  },
};
