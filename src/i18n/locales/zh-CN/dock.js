/** 简体中文包 — 底部命令 dock：视觉预设、位置栏与地图来源栏。 */
export default {
  aria: '导航、语音与视觉预设控制',
  presets: {
    title: '视觉预设',
    pin: '固定视觉预设',
    pinTitle: '保持视觉预设展开',
  },
  styles: {
    normal: {
      label: '标准',
      title: '显示无视觉滤镜的地球。',
    },
    retro: {
      label: 'CRT',
      title: '模拟绿磷 CRT 的扫描线与屏幕弯曲。',
    },
    surveillance: {
      label: 'NVG',
      title: '模拟夜视仪的绿色增亮与镜筒暗角。',
    },
    thermal: {
      label: 'FLIR',
      title: '模拟 FLIR 风格的热成像对比。调高 Ironbow 可获得色彩。',
    },
    anime: {
      label: '动漫',
      title: '应用明亮的赛璐璐着色与描边轮廓。',
    },
    noir: {
      label: '黑调',
      title: '应用高对比的黑色电影式单色调色。',
    },
    snow: {
      label: '雪景',
      title: '为场景添加寒冷的雪白效果。',
    },
  },
  mapSource: {
    title: '地图来源',
    chipsAria: '地图来源',
  },
  mini: {
    styleLabel: '风格',
  },
  location: {
    title: '位置',
    pin: '固定位置栏',
    pinTitle: '保持位置栏展开',
    searchToggleTitle: '搜索任意地点',
    searchPlaceholder: '搜索任意地点…',
    searchAria: '按名称或坐标搜索地点',
  },
};
