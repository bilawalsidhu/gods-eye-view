/**
 * 繁體中文(台灣)UI dictionary.
 *
 * Keys are the English strings exactly as the app renders them (whitespace
 * collapsed). Lookups also fall back to an upper-cased key, so a label that
 * one surface writes as "Live Flights" and another as "LIVE FLIGHTS" needs one
 * entry. Proper nouns (provider names, product names, licence names, env var
 * names) stay in English on purpose.
 */
export const ZH_TW_MESSAGES = Object.freeze({
  // ── Brand & chrome ─────────────────────────────────────────────────────
  "GOD'S EYE": '上帝之眼',
  VIEW: '視角',
  'NO PLACE LEFT BEHIND': '無處遁形',
  'ACTIVE STYLE': '目前風格',
  'TOP SECRET // SI-TK // NOFORN': '絕對機密 // SI-TK // 禁止外流',
  'Initializing photorealistic world...': '正在初始化擬真世界…',
  'Initializing systems...': '系統初始化中…',
  'Configuring viewer...': '正在設定檢視器…',
  'Restoring shared view...': '正在還原分享的視角…',
  'LOADING LIVE DATA': '載入即時資料',
  'REFRESHING LIVE DATA': '更新即時資料',
  'LOAD COMPLETE': '載入完成',
  'syncing road network': '同步道路網路',
  'loading frames': '載入畫面',
  'LOADING FRAMES': '載入畫面',
  'camera grid ready': '攝影機網格就緒',
  'CAMERA GRID READY': '攝影機網格就緒',
  REC: '錄製',
  SUMMARY: '摘要',
  'Visible map targets': '可見地圖目標',
  'Globe actions': '地球操作',
  'Clear selected data layers': '清除已選資料圖層',
  'Turn off all selected data layers': '關閉所有已選資料圖層',
  'Copy share link': '複製分享連結',
  'Tilt map to oblique view': '將地圖傾斜為斜視角',
  'Toggle straight-down and tilted map views': '切換俯視/傾斜地圖視角',
  'Return map to straight-down view': '地圖回到正俯視',
  'Reset map to north up': '地圖重設為北方朝上',
  'Reset map bearing to north': '重設地圖方位為正北',
  'Reset to full globe view': '重設為完整地球視角',
  'Reset camera and return to full globe view': '重設鏡頭並回到完整地球視角',
  'Data attribution': '資料來源',
  'Close data attribution': '關閉資料來源',
  'Data provided by:': '資料提供:',
  'Powered by Esri': '由 Esri 提供',
  'fix the map': '修正地圖',
  'Double-click to rename': '按兩下以重新命名',
  'Rendered globe frames per second · toggle with `':
    '地球每秒渲染影格數 · 按 ` 切換',
  'FPS —': 'FPS —',

  // ── First run ──────────────────────────────────────────────────────────
  'MISSION CONTROL · FIRST LAUNCH': '任務控制 · 首次啟動',
  'Choose your first view': '選擇你的第一個視角',
  'It feels like a forbidden cockpit—then you realize the sources are public and the data is real.':
    '像是闖進了禁區駕駛艙——接著你才發現,所有來源都是公開的,資料也都是真的。',
  'LIVE CONTACTS': '即時目標',
  'Aircraft, vessels and nearby intelligence': '飛機、船舶與周邊情資',
  'SPACE MISSIONS': '太空任務',
  'Launches, spacecraft and orbital context': '發射、太空載具與軌道資訊',
  ENVIRONMENTAL: '環境',
  'Live earthquakes and active fires, from USGS and NASA':
    '來自 USGS 與 NASA 的即時地震與野火',
  'EXPLORE MANUALLY': '自由探索',
  'Begin with a clean globe': '從乾淨的地球開始',
  "Don't show this again": '不再顯示',
  'ESC to dismiss': 'ESC 關閉',
  'ESC to close': 'ESC 關閉',
  'Tip: the GEV MIC button in the dock lets you talk to the map.':
    '提示:按下底部的 GEV 麥克風按鈕,就能用語音操控地圖。',
  'Flying to Austin, TX...': '正在飛往德州奧斯汀…',

  // ── Common words ───────────────────────────────────────────────────────
  ON: '開',
  OFF: '關',
  'ON/OFF': '開/關',
  LOADING: '載入中',
  STALE: '資料過期',
  UNAVAILABLE: '無法使用',
  UNKNOWN: '未知',
  READY: '就緒',
  Ready: '就緒',
  ENABLE: '啟用',
  DISABLE: '停用',
  DISMISS: '關閉',
  RESET: '重設',
  CLEAR: '清除',
  Clear: '清除',
  PREV: '上一個',
  NEXT: '下一個',
  CURRENT: '目前',
  NEW: '新增',
  DEL: '刪除',
  REMOVE: '移除',
  LOAD: '載入',
  IMPORT: '匯入',
  START: '開始',
  PLAY: '播放',
  Play: '播放',
  STOP: '停止',
  FROM: '出發',
  TO: '目的',
  All: '全部',
  First: '第一',
  Second: '第二',
  Other: '其他',
  Changed: '已變更',
  old: '舊',
  never: '從未',
  'browser-side': '瀏覽器端',
  'configured externally': '已在外部設定',
  'Collapse panel': '收合面板',
  'Expand panel': '展開面板',
  STD: '標準',
  LEVEL: '水平',

  // ── Layers ─────────────────────────────────────────────────────────────
  'DATA LAYERS': '資料圖層',
  Movement: '移動目標',
  Cameras: '攝影機',
  Events: '事件',
  Infrastructure: '基礎設施',
  Utilities: '公用設施',
  'EARTH WATCH': '地球監測',
  'ACTIVE EVENTS': '進行中事件',
  'Live Flights': '即時航班',
  'Military Flights': '軍機',
  'Military flights': '軍機',
  'Live Vessels': '即時船舶',
  'AIS vessels': 'AIS 船舶',
  Satellites: '衛星',
  'Street Traffic': '道路交通',
  Transit: '大眾運輸',
  'Bike Share': '共享單車',
  Directions: '路線規劃',
  'Turn-by-turn directions': '逐步導航',
  'Mapped ALPR Cameras': '已標記車牌辨識攝影機',
  'ALPR camera': '車牌辨識攝影機',
  'Mapped Installations': '已標記軍事設施',
  'Mapped installations': '已標記軍事設施',
  'Active Fires': '野火熱點',
  'FIRMS Active Fires': 'FIRMS 野火熱點',
  Earthquakes: '地震',
  'Submarine Cables': '海底電纜',
  Dams: '水壩',
  'Data Centers': '資料中心',
  Radio: '廣播電台',
  'Camera badges': '攝影機標章',
  'Fixture aircraft': '示範飛機',
  ISS: '國際太空站',
  'Loading the Starlink shell…': '正在載入 Starlink 星座…',
  'Add the full Starlink broadband shell (thousands of extra points)':
    '加入完整 Starlink 寬頻星座(額外數千個點)',
  'Brightest naked-eye objects — CelesTrak visual group':
    '肉眼最亮天體 — CelesTrak 目視群組',
  'Crewed stations and their visiting vehicles': '載人太空站與來訪載具',
  'GNSS navigation — GPS, GLONASS, Galileo':
    'GNSS 導航衛星 — GPS、GLONASS、Galileo',
  'Geostationary belt — comms and weather, fixed over the equator':
    '地球同步軌道帶 — 通訊與氣象衛星,固定於赤道上空',
  'SIMULATED — add TomTom key for live':
    '模擬中 — 加入 TomTom 金鑰以取得即時路況',
  'Aviation / Marine': '航空/海事',
  'Public Safety': '公共安全',
  'Traffic / Transit': '交通/運輸',
  'Weather / Emergency': '氣象/緊急',
  Music: '音樂',
  News: '新聞',
  Talk: '談話',
  Place: '地點',
  'Custom directory': '自訂目錄',

  // ── CCTV panel ─────────────────────────────────────────────────────────
  CCTV: '監視器',
  'CCTV ON': '監視器 開',
  'CCTV OFF': '監視器 關',
  'SOURCE · UNKNOWN': '來源 · 未知',
  'FRAME · LOADING': '畫面 · 載入中',
  'FRAME · UNAVAILABLE': '畫面 · 無法使用',
  'LIVE · OK': '即時 · 正常',
  'LIVE · UNKNOWN': '即時 · 未知',
  'LIVE · DEGRADED': '即時 · 降級',
  'ACQUIRING FRAME': '擷取畫面中',
  'Enable CCTV to load camera intersections': '啟用監視器以載入路口攝影機',
  'Enable CCTV to start camera-linked intelligence summaries.':
    '啟用監視器以開始產生攝影機情資摘要。',
  'No cameras available in catalog.': '目錄中沒有可用的攝影機。',
  'No summary available.': '尚無摘要。',
  NEAREST: '最近',
  'SHOW NEAREST': '顯示最近',
  FOCUS: '對焦',
  'COVERAGE OFF': '覆蓋範圍 關',
  'COVERAGE ON': '覆蓋範圍 開',
  'COVERAGE VIEWSHED': '覆蓋範圍 視域',
  'AUTO HOP OFF': '自動輪播 關',
  'AUTO HOP ON': '自動輪播 開',
  'PROJECTION ON': '投影 開',
  'PROJECTION OFF': '投影 關',
  'CAL · --': '校正 · --',
  'CAL · RAW PRIOR': '校正 · 原始預設',
  'CAL · CALIBRATED': '校正 · 已校正',
  'CAL · CURATED': '校正 · 人工整理',
  CALIBRATION: '校正',
  ADJUST: '調整',
  'SAVE CAL': '儲存校正',
  'RESET CAL': '重設校正',
  'SCENE SUMMARY': '場景摘要',
  'CCTV feed frame': '監視器畫面',
  'CCTV camera': '監視器攝影機',
  MONITOR: '螢幕',
  'RAW PRIOR': '原始預設',
  'Live stream connected': '即時串流已連線',
  'Snapshot feed connected': '快照來源已連線',
  'Upstream snapshot active': '上游快照運作中',
  'Fallback Street View frame': '備援街景畫面',
  'Upstream unavailable': '上游無法使用',
  'No source configured': '未設定來源',
  'No stream URL configured': '未設定串流網址',
  'Drag the camera in the world: rings rotate, arrows move, handles set range/FOV':
    '在世界中拖曳攝影機:圓環旋轉、箭頭移動、把手調整距離/視角',
  'Camera pose — click a value to type': '攝影機姿態 — 點擊數值即可輸入',
  'Heading (compass °) — click to type': '方位角(羅盤 °)— 點擊輸入',
  'Pitch (° up/down) — click to type': '俯仰角(° 上/下)— 點擊輸入',
  'Horizontal FOV (°) — click to type': '水平視角(°)— 點擊輸入',
  'Range / monitor-plane distance (m) — click to type':
    '距離/投影平面距離(公尺)— 點擊輸入',
  'Mount height above ground (m) — click to type':
    '架設離地高度(公尺)— 點擊輸入',
  'North offset from catalog position (m) — click to type':
    '相對目錄位置的北向偏移(公尺)— 點擊輸入',
  'East offset from catalog position (m) — click to type':
    '相對目錄位置的東向偏移(公尺)— 點擊輸入',
  HDG: '方位',
  PITCH: '俯仰',
  FOV: '視角',
  RANGE: '距離',
  HGT: '高度',

  // ── Scenes ─────────────────────────────────────────────────────────────
  SCENES: '場景',
  'CAPTURE SHOT': '擷取鏡頭',
  'UPDATE SHOT': '更新鏡頭',
  'EXPORT PRESETS': '匯出預設',
  'RUN LOG': '執行紀錄',
  'SHARE SCENE': '分享場景',
  'EDIT DETAILS': '編輯詳細資料',
  'Scene recipe': '場景配方',
  'No shots yet. Use CAPTURE SHOT to save current look.':
    '尚無鏡頭。使用「擷取鏡頭」儲存目前畫面。',
  'Final view': '最終視角',

  // ── Location & presets ─────────────────────────────────────────────────
  LOCATION: '位置',
  'Landmark: --': '地標:--',
  '📍 Location: --': '📍 位置:--',
  'Search any location': '搜尋任何地點',
  'Search any location...': '搜尋任何地點…',
  'Search location by name or coordinates': '依名稱或座標搜尋地點',
  'Pin location tray': '釘選位置面板',
  'Keep location tray open': '保持位置面板開啟',
  'POSITION UNAVAILABLE': '無法取得位置',
  'REGION UNAVAILABLE': '無法取得區域',
  'RESOLVING REGION': '解析區域中',
  'VISUAL PRESETS': '視覺預設',
  'Pin visual presets': '釘選視覺預設',
  'Keep visual presets open': '保持視覺預設開啟',
  'Navigation, voice, and visual preset controls': '導航、語音與視覺預設控制',
  Normal: '一般',
  NORMAL: '一般',
  CRT: 'CRT 映像管',
  NVG: '夜視鏡',
  FLIR: '熱成像',
  Anime: '動畫',
  Noir: '黑色電影',
  Snow: '雪景',
  'Show the globe without a visual filter.': '不套用任何視覺濾鏡顯示地球。',
  'Emulate a green phosphor CRT with scanlines and screen curvature.':
    '模擬帶有掃描線與螢幕弧度的綠色磷光 CRT。',
  'Simulate night-vision goggles with green intensification and a tube vignette.':
    '模擬綠色增光與鏡筒暗角的夜視鏡。',
  'Simulate FLIR-style thermal contrast. Turn up Ironbow for color.':
    '模擬 FLIR 熱成像對比。調高 Ironbow 可顯示色彩。',
  'Apply bright cel-shaded color and illustrated outlines.':
    '套用明亮的賽璐璐上色與插畫描邊。',
  'Apply high-contrast monochrome film-noir grading.':
    '套用高對比黑白黑色電影調色。',
  'Add a cold, snowy whiteout treatment to the scene.':
    '為場景加上冰冷的白茫雪景效果。',
  'MAP SOURCE': '地圖來源',
  'Map source': '地圖來源',
  Style: '樣式',
  'Esri Satellite': 'Esri 衛星影像',
  'Google 3D': 'Google 3D',
  'Bing Aerial': 'Bing 航照',
  'Bing Labels': 'Bing 標註',
  Scale: '比例尺',
  'San Francisco': '舊金山',
  'New York': '紐約',
  Tokyo: '東京',
  London: '倫敦',
  Paris: '巴黎',
  Dubai: '杜拜',
  'Washington DC': '華盛頓特區',
  Austin: '奧斯汀',
  Tallinn: '塔林',
  Taipei: '臺北',
  'Taipei 101': '台北 101',
  'Taipei Main Station': '台北車站',
  Ximending: '西門町',
  'Presidential Office Building': '總統府',
  'Songshan Airport': '松山機場',
  Taiwan: '台灣',

  // ── Display / HUD ──────────────────────────────────────────────────────
  DISPLAY: '顯示',
  HUD: '抬頭顯示',
  'HUD layout': 'HUD 版面',
  Layout: '版面',
  Tactical: '戰術',
  Operator: '操作員',
  Minimal: '極簡',
  DETECT: '偵測',
  Density: '密度',
  Allocation: '分配',
  Elastic: '彈性',
  Weighted: '加權',
  Fade: '淡出',
  Outside: '外圍',
  PARAMETERS: '參數',
  Models: '模型',
  Proximity: '鄰近',
  Scope: '瞄準鏡',
  Feather: '羽化',
  Draw: '繪製',
  Shape: '形狀',
  Area: '區域',
  Line: '線',
  Pin: '圖釘',
  Primary: '主色',
  Amber: '琥珀',
  Cyan: '青',
  Green: '綠',
  Red: '紅',
  Celestial: '天體環',
  'Clean UI': '簡潔介面',
  Bloom: '光暈',
  Sharpen: '銳利化',
  Sharpening: '銳利化',
  'EXIT CLEAN VIEW': '離開簡潔檢視',
  SPARSE: '稀疏',
  BALANCED: '平衡',
  DENSE: '密集',
  'Intelligence HUD (H)': '情報抬頭顯示 (H)',
  'Detection Overlay (D)': '偵測疊加 (D)',
  'Detection overlay': '偵測疊加',
  'Detection overlay: dense': '偵測疊加:密集',
  'Detection label density': '偵測標籤密度',
  'Detection label allocation': '偵測標籤分配',
  'Detection fade distance': '偵測淡出距離',
  'World-overlay fade distance outside the keyhole as a percentage of its radius':
    '瞄準孔外世界疊加層的淡出距離(半徑百分比)',
  'Detection opacity outside the keyhole': '瞄準孔外的偵測不透明度',
  'World-overlay label and card opacity beyond the fade distance':
    '超過淡出距離後世界疊加標籤與卡片的不透明度',
  '3D aircraft — flat icons zoomed out, 3D models up close':
    '3D 飛機 — 拉遠為平面圖示,拉近為 3D 模型',
  '3D model coverage': '3D 模型範圍',
  'Scope — the circular viewport mask': '瞄準鏡 — 圓形視窗遮罩',
  'Scope edge feather': '瞄準鏡邊緣羽化',
  'Scope edge feather as a percentage of the keyhole radius':
    '瞄準鏡邊緣羽化(瞄準孔半徑百分比)',
  'Draw on the world — click vertices, double-click or Enter to finish, Esc to cancel':
    '在世界上繪圖 — 點擊頂點,按兩下或 Enter 完成,Esc 取消',
  'Shape to draw': '要繪製的形狀',
  'Label (optional)': '標籤(選填)',
  'Label for the drawn shape': '繪製形狀的標籤',
  'Colour of the drawn shape': '繪製形狀的顏色',
  'Remove every mark from the board': '清除畫板上所有標記',
  'Pick a shape, then click the map.': '選擇形狀,然後點擊地圖。',
  'Celestial ring — reveal the full globe': '天體環 — 顯示完整地球',
  'Hide UI chrome': '隱藏介面框架',
  'Bloom / Glow': '光暈/輝光',
  'Bloom intensity': '光暈強度',
  'Sharpen intensity': '銳利化強度',
  'Return UI controls': '恢復介面控制項',
  'Remove the route and both markers': '移除路線與兩端標記',
  'Swap A and B': '交換 A 與 B',
  'REPLAY ASCENT': '重播升空',
  'Replay the estimated ascent with a following camera':
    '以跟隨鏡頭重播推估的升空過程',

  // ── Context panel ──────────────────────────────────────────────────────
  CONTEXT: '情境',
  'Context mode': '情境模式',
  'SELECT CONTEXT': '選擇情境',
  CONTACTS: '目標',
  CONTACT: '目標',
  'CONTACTS — nearest planes · vessels · sites':
    '目標 — 最近的飛機 · 船舶 · 設施',
  'SPACE MISSIONS — launches & orbital assets': '太空任務 — 發射與軌道資產',
  COCKPIT: '駕駛艙',
  'SEARCH NEARBY SITES': '搜尋附近設施',
  'CONTACTS CONTEXT OFF': '目標情境 關',
  'SELECT CONTACTS TO LOAD OBSERVED / MAPPED PROXIMITY':
    '選擇「目標」以載入觀測/標記的鄰近資訊',
  'AVAILABLE MISSIONS': '可用任務',
  'SELECT A MISSION TO INSPECT': '選擇要檢視的任務',
  'LOADING 30-DAY MISSION INDEX': '載入 30 天任務索引',
  'TAB PREVIEWS · ENTER / SPACE SELECTS': 'TAB 預覽 · ENTER/空白鍵 選取',
  'Cycles the nearest contacts of whatever type you select — planes, vessels, installations. Satellites track independently.':
    '輪流切換所選類型的最近目標 — 飛機、船舶、設施。衛星獨立追蹤。',
  'Contact Context actions': '目標情境操作',
  'Reclassify tracked contact as TR-3B': '將追蹤目標重新分類為 TR-3B',
  'Reclassify as TR-3B': '重新分類為 TR-3B',
  'Available Space Missions': '可用太空任務',
  AHEAD: '前方',
  ORBIT: '軌道',

  // ── Radio ──────────────────────────────────────────────────────────────
  RADIO: '廣播',
  'RADIO READY': '廣播就緒',
  'STATION TAG': '電台標籤',
  'NO STATION SELECTED': '未選擇電台',
  'Enable Radio, then choose a globe marker or use next.':
    '啟用廣播,再選擇地球上的標記或按「下一個」。',
  'Choose a globe marker or use next.': '選擇地球上的標記或按「下一個」。',
  'DIRECTORY BAND': '目錄頻段',
  'DRAG TO TUNE': '拖曳調頻',
  'ALL · DRAG THE NEEDLE': '全部 · 拖曳指針',
  'SNAPS TO AVAILABLE STATIONS': '自動對齊可用電台',
  'Radio off': '廣播關閉',
  'STATION SITE': '電台位置',
  'STATION UNAVAILABLE': '電台無法使用',
  'OFF AIR': '未播出',
  'DIRECTORY: RADIO BROWSER': '目錄:RADIO BROWSER',
  'Audio connects directly to the broadcaster after you press play. Your IP is visible to that broadcaster.':
    '按下播放後會直接連線到廣播電台,你的 IP 位址會被該電台看到。',
  'Radio directory is temporarily unavailable.': '電台目錄暫時無法使用。',
  'Open compact Radio controls': '開啟精簡廣播控制',
  'Compact Radio controls': '精簡廣播控制',
  'Open detailed Radio controls': '開啟詳細廣播控制',
  'Close compact Radio controls': '關閉精簡廣播控制',
  'Previous station': '上一個電台',
  'Next station': '下一個電台',
  'Compact Radio volume': '精簡廣播音量',
  'Internet radio companion': '網路廣播',
  'Filter stations by station tag': '依電台標籤篩選',
  'Tune available internet radio stations': '調整可用網路電台',
  'Radio playback': '廣播播放',
  'Previous filtered station': '上一個篩選電台',
  'Play selected station': '播放所選電台',
  'Next filtered station': '下一個篩選電台',
  'Stop radio playback': '停止廣播播放',
  'Radio volume': '廣播音量',
  'Enable Radio': '啟用廣播',
  'Disable Radio': '停用廣播',
  'Play nearest radio station': '播放最近的電台',
  VOLUME: '音量',

  // ── Cockpit ────────────────────────────────────────────────────────────
  'OPTICAL PLANE · 01': '光學平面 · 01',
  'VISOR LOCK · ACTIVE': '護目鏡鎖定 · 啟用',
  'GROUND SPEED · KTS': '地速 · 節',
  'ALTITUDE · FT': '高度 · 英尺',
  'FIRST PERSON': '第一人稱',
  AIRCRAFT: '飛機',
  'LIVE TRACK · COURSE ALIGNED': '即時追蹤 · 航向對齊',
  'GROUND SPEED': '地速',
  KTS: '節',
  ALTITUDE: '高度',
  FT: '英尺',
  'CONTACTS · 250 KM': '目標 · 250 公里',
  'CONTEXT ONLY': '僅情境',
  SITE: '設施',
  'NEAREST OBSERVED / MAPPED': '最近的觀測/標記目標',
  'NO AVAILABLE EXAMPLE': '沒有可用範例',
  'AVAILABLE INPUTS ONLY · NOT AN ALL-CLEAR': '僅依現有資料 · 不代表安全無虞',
  WX: '天氣',
  'ESTIMATED FLIGHT PLAN': '推估飛行計畫',
  'ROUTE DATA UNAVAILABLE': '無航線資料',
  'LIVE SIGNALS': '即時訊號',
  'OBSERVED / MAPPED PINGS': '觀測/標記訊號',
  'CYCLE OFF': '輪播 關',
  'CYCLE ON': '輪播 開',
  'ACQUIRING REGIONAL NEWS': '取得區域新聞中',
  'LATEST LOCATION-MATCHED REPORTING': '最新在地相關報導',
  'PLACE / CONDITIONS / POSITION': '地點/天候/位置',
  TEMP: '溫度',
  WIND: '風',
  SKY: '天空',
  PRECIP: '降水',
  MM: '毫米',
  'Weather data by Open-Meteo.com': '天氣資料來自 Open-Meteo.com',
  'SOURCE-BACKED EVENTS · NO SYNTHETIC NEWS': '有來源佐證的事件 · 無合成新聞',
  SIG: '訊號',
  NEWS: '新聞',
  LOCAL: '在地',
  'ESC EXIT': 'ESC 離開',
  'C TOGGLE': 'C 切換',
  'EXIT COCKPIT': '離開駕駛艙',
  'Aircraft cockpit view': '飛機駕駛艙視角',
  'Estimated destination direction': '推估目的地方向',
  'Cockpit vision style': '駕駛艙視覺風格',
  'Previous cockpit vision style': '上一個駕駛艙視覺風格',
  'Previous vision style': '上一個視覺風格',
  'Current cockpit vision style: NORMAL. Activate for next style.':
    '目前駕駛艙視覺風格:一般。啟用以切換下一個風格。',
  'Current style: NORMAL — click for next': '目前風格:一般 — 點擊切換',
  'Next cockpit vision style': '下一個駕駛艙視覺風格',
  'Next vision style': '下一個視覺風格',
  'Current aircraft heading': '目前飛機航向',
  'Contact cockpit summary': '目標駕駛艙摘要',
  'Contact navigation': '目標導覽',
  'Previous — prior visited contact in the 250 km window':
    '上一個 — 250 公里範圍內先前造訪的目標',
  'Next — nearest unvisited contact in the 250 km window':
    '下一個 — 250 公里範圍內最近的未造訪目標',
  'Collapse Contact panel': '收合目標面板',
  'Collapse contact panel': '收合目標面板',
  'Nearby cohort counts': '周邊目標數量',
  'Enable cockpit weather effects': '啟用駕駛艙天氣效果',
  'Cockpit briefing carousel': '駕駛艙簡報輪播',
  'Estimated flight plan': '推估飛行計畫',
  'Cockpit briefing controls': '駕駛艙簡報控制',
  'Previous briefing page': '上一頁簡報',
  'Next briefing page': '下一頁簡報',
  'Cycle briefing pages automatically every 9 seconds (Signals → News → Local). Pauses while you hover or focus the panel. Live signal data refreshes continuously either way.':
    '每 9 秒自動輪播簡報頁(訊號 → 新聞 → 在地)。滑鼠停留或聚焦面板時暫停;即時訊號資料會持續更新。',
  'Collapse cockpit briefing panel': '收合駕駛艙簡報面板',
  'Collapse briefing panel': '收合簡報面板',
  'Live signals': '即時訊號',
  'Latest regional news': '最新區域新聞',
  'Location-based information': '在地資訊',
  'Cockpit briefing pages': '駕駛艙簡報頁',
  'Show Live Signals': '顯示即時訊號',
  'Show Regional News': '顯示區域新聞',
  'Show Local Info': '顯示在地資訊',
  'Cockpit display and Radio controls': '駕駛艙顯示與廣播控制',
  'Expand Cockpit display options': '展開駕駛艙顯示選項',
  'Cockpit display options': '駕駛艙顯示選項',
  'Expand Cockpit Radio controls': '展開駕駛艙廣播控制',
  'Cockpit compact Radio controls': '駕駛艙精簡廣播控制',
  'Previous filtered radio station': '上一個篩選電台',
  'Play selected radio station': '播放所選電台',
  'Next filtered radio station': '下一個篩選電台',
  'Cockpit Radio volume': '駕駛艙廣播音量',
  'View switcher': '視角切換',
  'Reset cockpit to full globe view': '駕駛艙重設為完整地球視角',
  'Exit cockpit and return to full globe view': '離開駕駛艙並回到完整地球視角',
  'Exit cockpit view': '離開駕駛艙視角',

  // ── Voice ──────────────────────────────────────────────────────────────
  'VOICE CONTROL': '語音控制',
  'VOICE STANDBY': '語音待命',
  'VOICE SYSTEM ERROR': '語音系統錯誤',
  'AI AGENT': 'AI 助理',
  'Voice control — activate to toggle voice; hold Space to speak':
    '語音控制 — 啟用以切換語音;按住空白鍵說話',
  'Voice control — talk to the planet': '語音控制 — 和地球對話',
  'Hold Space to speak · tap Space to activate focused controls':
    '按住空白鍵說話 · 輕按空白鍵啟用聚焦的控制項',
  'Check microphone permission and network access, then try again.':
    '請檢查麥克風權限與網路連線後再試一次。',

  // ── POWER UP / provider settings ───────────────────────────────────────
  'POWER UP': '強化功能',
  'POWERED UP': '已全面強化',
  'GROUND STATION · PROVIDER SETTINGS': '地面站 · 服務供應商設定',
  'Power up the globe': '強化你的地球',
  "The globe already flies keyless. Every key below switches on another real feed — paste one and it's saved into this app's local configuration, then the server restarts itself. Server-side keys stay on this machine; Google Maps and Cesium ion run in the browser and must be provider-restricted. Keys you configured elsewhere are shown but never touched.":
    '不需任何金鑰地球就能運作。下方每一組金鑰都會開啟另一個真實資料來源 — 貼上後會存入本機設定,伺服器隨即自動重新啟動。伺服器端金鑰只留在本機;Google Maps 與 Cesium ion 在瀏覽器中執行,務必在供應商端設定使用限制。在其他地方設定的金鑰只會顯示,不會被修改。',
  'SAVE KEYS': '儲存金鑰',
  'The Google Maps key buys the photorealistic planet — everything else stacks on top.':
    'Google Maps 金鑰帶來擬真地球 — 其他功能都疊加在它之上。',
  'Close key setup': '關閉金鑰設定',
  'GET KEY ↗': '取得金鑰 ↗',
  'Free key — register, paste, done': '免費金鑰 — 註冊、貼上、完成',
  'Metered — a billing-enabled account': '計費 — 需啟用帳單的帳戶',
  'This key runs in the browser by design — restrict it at the provider (see SECURITY.md)':
    '此金鑰設計上在瀏覽器執行 — 請在供應商端設定限制(見 SECURITY.md)',
  'The photorealistic 3D planet + place search': '擬真 3D 地球 + 地點搜尋',
  'Places context + Street View fallback; optional separate key':
    '地點資訊 + 街景備援;可選用獨立金鑰',
  'Live ships, worldwide': '全球即時船舶',
  'Live active-fire detections': '即時野火偵測',
  'Real live traffic (keyless runs a simulation)':
    '真實即時路況(無金鑰時為模擬)',
  'Bing imagery map stacks + world terrain': 'Bing 影像圖層 + 全球地形',
  'More flight-polling credits (anonymous works without)':
    '更多航班查詢額度(匿名也可使用)',
  'Higher space-missions request allowance': '更高的太空任務查詢額度',
  'Taiwan provincial-highway & city CCTV live streams':
    '台灣省道與縣市 CCTV 即時影像',
  'Needs CESIUM_ION_TOKEN — add it in Provider Settings':
    '需要 CESIUM_ION_TOKEN — 請在供應商設定中加入',
  'Needs GOOGLE_MAPS_API_KEY — add it in Provider Settings — or a Cesium ion token for the ion-hosted route':
    '需要 GOOGLE_MAPS_API_KEY — 請在供應商設定中加入 — 或使用 Cesium ion 權杖走 ion 託管路線',
  'Voice model: gpt-realtime-2 — click to switch to mini; applies next session':
    '語音模型:gpt-realtime-2 — 點擊切換為 mini;下次連線生效',

  // ── Attribution headings ───────────────────────────────────────────────
  'Earthquakes: Data courtesy of the U.S. Geological Survey':
    '地震:資料由美國地質調查局 (USGS) 提供',
  'Keyless place search:': '免金鑰地點搜尋:',
  'Live vessels (AIS):': '即時船舶 (AIS):',
  'Internet-radio station directory:': '網路電台目錄:',
  'Road geometry (traffic):': '道路幾何(交通):',
  'Terrain (keyless globe stacks):': '地形(免金鑰地球圖層):',
  'Mapped installation context:': '已標記設施資訊:',
  'Space mission launch, payload & recovery metadata:':
    '太空任務發射、酬載與回收資料:',
  'Military flights, aircraft traces & bounded regional flight fallback:':
    '軍機、飛行軌跡與區域航班備援:',
  'Transit vehicles: operator GTFS-Realtime feeds (each operator is credited below when its vehicles are shown)':
    '大眾運輸車輛:營運商 GTFS-Realtime 資料(顯示車輛時會於下方標註營運商)',
  'Bikeshare availability: GBFS operator feeds (e.g. Austin BCycle)':
    '共享單車可用數:GBFS 營運商資料(例如 Austin BCycle)',
  'ALPR camera locations (automatic license plate readers):':
    '車牌辨識攝影機位置(自動車牌辨識器):',
  'Cockpit current conditions:': '駕駛艙目前天候:',
  'Cockpit regional headlines:': '駕駛艙區域頭條:',
  'Cockpit place context and last-resort place search:':
    '駕駛艙地點資訊與備援地點搜尋:',
  'Dams:': '水壩:',
  'Datacenters:': '資料中心:',
  '(courtesy)': '(授權使用)',
  '(non-commercial)': '(非商業)',
  'Global Flights Radar': '全球航班雷達',
  'Global Incident Context': '全球事件情境',
  'Orbital Watch': '軌道監看',
  'City Overload': '城市過載',
  'Thermal Threat Board': '熱源威脅看板',
  'Omniscience Pullback': '全知拉遠',
});

/** Short status words that follow "Layer: " in layer chips. */
const STATUS_WORDS = new Set(['OFF', 'ON', 'LOADING', 'STALE', 'UNAVAILABLE']);

/**
 * Pattern rules for strings the app composes at runtime. Each rule returns the
 * translated string, or null to fall through. `t` translates a fragment (and
 * returns it unchanged when unknown).
 */
export const ZH_TW_PATTERNS = Object.freeze([
  (text, t) => {
    const m = /^(\d[\d,]*) cameras loaded · click a camera to activate$/.exec(
      text,
    );
    return m ? `已載入 ${m[1]} 支攝影機 · 點選攝影機以啟用` : null;
  },
  (text, t) => {
    const m = /^(\d[\d,]*) cameras loaded · enable CCTV to activate$/.exec(
      text,
    );
    return m ? `已載入 ${m[1]} 支攝影機 · 啟用監視器以使用` : null;
  },
  (text) => {
    const m = /^POWER UP · (\d+) KEYS? WAITING$/i.exec(text);
    return m ? `強化功能 · ${m[1]} 組金鑰待設定` : null;
  },
  (text) => {
    const m = /^PAGE (\d+)\/(\d+)$/.exec(text);
    return m ? `第 ${m[1]}/${m[2]} 頁` : null;
  },
  (text) => {
    const m = /^Flying to (.+?)\.\.\.$/.exec(text);
    return m ? `正在飛往 ${m[1]}…` : null;
  },
  (text) => {
    const m = /^paste ([A-Z0-9_]+)$/.exec(text);
    return m ? `貼上 ${m[1]}` : null;
  },
  (text, t) => {
    const m = /^(Expand|Collapse) (.+)$/.exec(text);
    if (!m) return null;
    const inner = t(m[2]);
    return inner === m[2]
      ? null
      : `${m[1] === 'Expand' ? '展開' : '收合'}${inner}`;
  },
  (text, t) => {
    // "Live Flights: OFF", "Cameras: LOADING"
    const m = /^(.+): ([A-Z]+)$/.exec(text);
    if (!m || !STATUS_WORDS.has(m[2])) return null;
    const head = t(m[1]);
    return head === m[1] ? null : `${head}:${t(m[2])}`;
  },
  (text, t) => {
    // "HDG 346°", "RANGE 260m", "HGT 8m", "FOV --"
    const m = /^(HDG|PITCH|FOV|RANGE|HGT) (.+)$/.exec(text);
    return m ? `${t(m[1])} ${m[2]}` : null;
  },
  (text) => {
    const m = /^LOADING FRAMES (\d+\/\d+)$/i.exec(text);
    return m ? `載入畫面 ${m[1]}` : null;
  },
  (text) => {
    const m = /^loading frames (\d+\/\d+)$/.exec(text);
    return m ? `載入畫面 ${m[1]}` : null;
  },
  (text, t) => {
    // Composite status lines: "LIVE · OK", "CCTV + Street View fallback · never".
    if (!text.includes(' · ')) return null;
    const parts = text.split(' · ');
    const out = parts.map((part) => t(part));
    return out.some((part, i) => part !== parts[i]) ? out.join(' · ') : null;
  },
]);

/** Extra vocabulary used only inside composite " · " segments. */
export const ZH_TW_SEGMENTS = Object.freeze({
  LIVE: '即時',
  OK: '正常',
  DEGRADED: '降級',
  SNAPSHOT: '快照',
  SYNTHETIC: '合成畫面',
  STREETVIEW: '街景',
  FRAME: '畫面',
  SOURCE: '來源',
  CAL: '校正',
  'CCTV + Street View fallback': '監視器 + 街景備援',
  'OSM routing': 'OSM 路線規劃',
  Local: '在地',
});
