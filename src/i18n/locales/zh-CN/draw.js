/**
 * Simplified Chinese pack — 手绘白板（显示 ▸ 绘制）提示与标注引擎的失败描述。
 */
export default {
  hint: {
    pickShape: '先选择形状，再在地图上点击。',
    pinPlace: '按 Enter 放置图钉，按 Esc 取消。',
    pinClick: '点击图钉的放置位置。',
    clickMore: {
      one: '再点击 {count} 个点。',
      other: '再点击 {count} 个点。',
    },
    areaDegenerate: '这些点都在同一条直线上——请移开其中一个点才能围出面。',
    lineDegenerate: '这条线没有长度——请在更远处点击。',
    finish: '{measure} · 双击或按 Enter 完成，Backspace 撤销，Esc 取消。',
    limitReached: '已达 {max} 点上限',
    full: '该形状已有 {max} 个点——请完成绘制或按 Backspace。',
    offGlobe: '该点在地球之外——请点击地球上的位置。',
    notPlaced: '该形状无法放置。',
    placeFailed: '无法放置形状：{error}',
    boardCleared: '画板已清除。',
    pointerBusy: '{owner} 正在使用指针——请先关闭它。',
  },
  error: {
    unresolved: '无法解析位置',
    limit: '已达标注数量上限',
    failed: '标注失败',
  },
};
