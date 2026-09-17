/**
 * 繁體中文（台灣）語系字典檔
 * Traditional Chinese translations dictionary for God's Eye View.
 */
export default Object.freeze({
  // App chrome & Title
  'app.title': "GOD'S EYE VIEW",
  'app.subtitle': '全球態勢 · 盡收眼底',
  'app.activeStyle': '當前樣式',

  // Top navigation & actions
  'actions.clearLayers': '關閉所有已選取的資料圖層',
  'actions.clearLayersAria': '清除已選圖層',
  'actions.share': '複製視角分享連結',
  'actions.tilt': '切換俯視與傾斜視角',
  'actions.tiltAria': '切換地圖傾斜視角',
  'actions.northUp': '重設地圖指北',
  'actions.northUpAria': '重設為正北朝上',
  'actions.resetGlobe': '重設視角並返回完整地球',
  'actions.resetGlobeAria': '重設為全球視角',
  'actions.switchLang': '切換語系 / Switch Language (繁中 / EN)',

  // Loading & Sync
  'loading.global': '即時情資載入中',
  'loading.traffic': '同步道路路網中',
  'loading.cctv': '讀取畫面中',

  // Bottom Command Dock
  'dock.presets': '視覺預設',
  'dock.pinPresets': '固定視覺預設面板',
  'dock.mapSource': '圖資來源',
  'dock.powerUp': '解鎖金鑰',
  'dock.searchPlaceholder': '搜尋城市、地標、經緯度或座標...',
  'dock.flightTracking': '航班追蹤',
  'dock.vesselTracking': '船隻追蹤',

  // Visual Styles
  'style.normal': '正常',
  'style.normalDesc': '原始擬真地球影像，無特殊濾鏡效果。',
  'style.retro': 'CRT',
  'style.retroDesc': '模擬綠色螢光 CRT 顯像管與掃描線曲面效果。',
  'style.surveillance': '夜視鏡',
  'style.surveillanceDesc': '模擬微光夜視鏡綠色增強與暗角光暈效果。',
  'style.thermal': '熱成像',
  'style.thermalDesc': '模擬 FLIR 紅外線熱成像對比。',
  'style.anime': '動漫',
  'style.animeDesc': '賽璐珞卡通描邊插畫渲染風格。',
  'style.noir': '黑白電影',
  'style.noirDesc': '高對比復古黑白底片電影調色風格。',
  'style.snow': '風雪',
  'style.snowDesc': '極地酷寒暴風雪與白化降雪視覺處理。',

  // Data Layer Groups
  'layers.title': '資料圖層',
  'layers.groups.Movement': '動態目標',
  'layers.groups.Cameras': '即時影像',
  'layers.groups.Infrastructure': '關鍵設施',
  'layers.groups.Events': '重大事件',
  'layers.groups.Utilities': '分析工具',
  'layers.groups.Other': '其他圖層',

  // Layer Names
  'layers.items.satellites': '軌道衛星',
  'layers.items.flights': '商業航班',
  'layers.items.military': '軍用飛行器',
  'layers.items.aisLiveVessels': '即時船舶 (AIS)',
  'layers.items.traffic': '即時路況',
  'layers.items.transit': '大眾運輸',
  'layers.items.bikeshare': '共享單車',
  'layers.items.cctv': '監視器 (CCTV)',
  'layers.items.alprCameras': '車牌辨識攝影機',
  'layers.items.militaryInstallations': '軍事設施據點',
  'layers.items.localDatacenters': '雲端資料中心',
  'layers.items.submarineCables': '全球海底光纜',
  'layers.items.localDams': '重要水利水壩',
  'layers.items.rocketLaunches': '太空發射任務 (30天)',
  'layers.items.earthquakes': '全球地震 (24小時)',
  'layers.items.localFirms': '活躍野火熱點',
  'layers.items.directions': '路徑規劃與測量',
  'layers.items.radio': '全球即時電台廣播',

  // Layer Feed Statuses
  'layers.status.nominal': '開啟',
  'layers.status.loading': '載入中',
  'layers.status.degraded': '效能受限',
  'layers.status.stale': '逾時未更',
  'layers.status.partial': '部分可用',
  'layers.status.fallback': '備用模式',
  'layers.status.unavailable': '無法連線',

  // CCTV Panel
  'cctv.title': '即時監視器',
  'cctv.sourceUnknown': '來源 · 未知',
  'cctv.enableHint': '啟動 CCTV 以載入路口即時監視器',
  'cctv.off': 'CCTV 關閉',
  'cctv.on': 'CCTV 開啟',
  'cctv.nearest': '最近鏡頭',
  'cctv.prev': '上一支',
  'cctv.next': '下一支',
  'cctv.focus': '鎖定聚焦',
  'cctv.coverageOff': '覆蓋範圍 關',
  'cctv.coverageOn': '覆蓋範圍 開',
  'cctv.autoHopOff': '自動巡航 關',
  'cctv.autoHopOn': '自動巡航 開',
  'cctv.projectionOn': '3D 投影 開',
  'cctv.projectionOff': '3D 投影 關',
  'cctv.calibration': '攝影機姿態校準',
  'cctv.adjust': '手動調整',
  'cctv.adjustTitle':
    '拖曳世界中的相機控制項：旋轉環旋轉、箭頭移動、手柄設定距離與視角',
  'cctv.saveCal': '儲存校準',
  'cctv.resetCal': '重設校準',
  'cctv.sceneSummary': '鏡頭情資摘要',
  'cctv.summaryHint': '啟動 CCTV 即可開始攝影機關聯情報分析。',

  // Scene Director
  'scenes.title': '運鏡場景',
  'scenes.new': '新增',
  'scenes.delete': '刪除',
  'scenes.captureShot': '擷取鏡頭',
  'scenes.updateShot': '更新鏡頭',
  'scenes.start': '開始導覽',
  'scenes.stop': '停止',
  'scenes.next': '下個鏡頭',
  'scenes.export': '匯出預設',
  'scenes.import': '匯入',
  'scenes.runLog': '運行記錄',
  'scenes.ready': '就緒',

  // Cockpit HUD
  'cockpit.pitch': '俯仰',
  'cockpit.roll': '滾轉',
  'cockpit.alt': '高度',
  'cockpit.spd': '航速',
  'cockpit.target': '目標',
  'cockpit.exit': '退出駕駛艙',

  // Display Controls
  'display.title': '顯示控制',
  'display.hud': '情資 HUD',
  'display.layout': '版面配置',
  'display.detect': '目標偵測',
  'display.density': '標籤密度',
  'display.allocation': '分配模式',
  'display.fade': '邊緣淡出',
  'display.outside': '視野外透明度',
  'display.params': '風格參數調控',
  'display.3d': '3D 模型',
  'display.models': '呈現範圍',
  'display.proximity': '鄰近顯示',
  'display.all': '全部顯示',
  'display.scope': '圓形遮罩',
  'display.feather': '柔邊羽化',
  'display.draw': '測繪標註',
  'display.shape': '圖形形狀',
  'display.area': '多邊形面積',
  'display.line': '測量折線',

  // Welcome / First Launch
  'welcome.kicker': '任務控制中心 · 首次啟動',
  'welcome.title': '選擇您的初始探索視角',
  'welcome.desc':
    '宛如置身機密情資態勢駕駛艙——但所有資料來源皆為公開真實的開放情資。',
  'welcome.contacts': '即時動態目標',
  'welcome.contactsDesc': '全球商業航班、海上船隻與周邊情報',
  'welcome.space': '太空航太任務',
  'welcome.spaceDesc': '火箭發射軌跡、太空船與在軌衛星',
  'welcome.environmental': '全球環境監控',
  'welcome.environmentalDesc': 'USGS 即時地震與 NASA 活躍野火熱點',
  'welcome.explore': '自由手動探索',
  'welcome.exploreDesc': '從未啟用圖層的純淨地球開始巡覽',
  'welcome.dontShow': '不再顯示此導覽畫面',
  'welcome.esc': '按 ESC 關閉',
  'welcome.tip': '提示：點擊底部指揮列的 GEV MIC 按鈕可使用語音控制地圖。',

  // Provider Settings (POWER UP)
  'powerup.kicker': '地面站 · 服務提供者金鑰設定',
  'powerup.title': '解鎖地球情資數據源',
  'powerup.desc':
    '系統已預設支援免金鑰漫遊。填入下方任一 API 金鑰即可啟動對應真實數據源——儲存後將寫入本機設定檔並自動重啟伺服器生效。伺服器端金鑰僅保留於本機；Google Maps 與 Cesium ion 會在瀏覽器端執行。',
  'powerup.save': '儲存金鑰',
  'powerup.hint': '按 ESC 關閉',
  'powerup.note':
    'Google Maps 金鑰可解鎖高擬真 3D 建築地形——其他即時圖層皆疊加於其上。',
});
