const TRANSLATIONS = new Map([
  ["God's Eye View", '上帝視角'],
  ['Initializing photorealistic world...', '正在初始化擬真世界...'],
  ['NO PLACE LEFT BEHIND', '不遺漏任何角落'],
  ['ACTIVE STYLE', '目前風格'],
  ['NORMAL', '標準'],
  ['MISSION CONTROL · FIRST LAUNCH', '任務控制 · 首次啟動'],
  ['Choose your first view', '選擇第一個視角'],
  [
    'It feels like a forbidden cockpit—then you realize the sources are public and the data is real.',
    '彷彿進入機密駕駛艙，卻發現所有來源皆為公開資料，而且一切都是真實的。',
  ],
  ['LIVE CONTACTS', '即時目標'],
  ['Aircraft, vessels and nearby intelligence', '飛機、船舶與附近情報'],
  ['SPACE MISSIONS', '太空任務'],
  ['Launches, spacecraft and orbital context', '發射任務、太空載具與軌道資訊'],
  ['ENVIRONMENTAL', '環境事件'],
  [
    'Live earthquakes and active fires, from USGS and NASA',
    '來自 USGS 與 NASA 的即時地震及火災',
  ],
  ['EXPLORE MANUALLY', '自行探索'],
  ['Begin with a clean globe', '從乾淨的地球儀開始'],
  ["Don't show this again", '不要再顯示'],
  ['ESC to dismiss', '按 ESC 關閉'],
  [
    'Tip: the GEV MIC button in the dock lets you talk to the map.',
    '提示：底部的 GEV MIC 按鈕可讓你用語音操作地圖。',
  ],
  ['Starting live contacts…', '正在啟動即時目標…'],
  ['Opening space missions…', '正在開啟太空任務…'],
  ['Scanning active events…', '正在掃描即時事件…'],
  ['Working…', '處理中…'],
  [
    'This browser is blocking storage, so that could not be saved.',
    '瀏覽器已封鎖儲存空間，因此無法儲存此設定。',
  ],
  ['VISUAL PRESETS', '視覺預設'],
  ['Normal', '標準'],
  ['Anime', '動漫'],
  ['Noir', '黑白電影'],
  ['Snow', '雪景'],
  ['MAP SOURCE', '地圖來源'],
  ['Map source', '地圖來源'],
  ['Style', '風格'],
  ['LOCATION', '位置'],
  ['Location: --', '位置：--'],
  ['Landmark: --', '地標：--'],
  ['DISPLAY', '顯示'],
  ['Layout', '版面'],
  ['Tactical', '戰術'],
  ['Operator', '操作員'],
  ['Minimal', '精簡'],
  ['DETECT', '偵測'],
  ['Density', '密度'],
  ['Allocation', '配置'],
  ['Elastic', '彈性'],
  ['Weighted', '加權'],
  ['Fade', '淡出'],
  ['Outside', '外圍'],
  ['PARAMETERS', '參數'],
  ['Models', '模型'],
  ['Proximity', '近距離'],
  ['All', '全部'],
  ['Scope', '視野'],
  ['Feather', '柔邊'],
  ['Draw', '繪製'],
  ['Shape', '形狀'],
  ['Area', '區域'],
  ['Line', '線段'],
  ['Pin', '標記'],
  ['Primary', '主要'],
  ['Amber', '琥珀'],
  ['Cyan', '青色'],
  ['Green', '綠色'],
  ['Red', '紅色'],
  ['Clear', '清除'],
  ['Celestial', '天體'],
  ['Clean UI', '隱藏介面'],
  ['Bloom', '光暈'],
  ['Sharpen', '銳化'],
  ['EXIT CLEAN VIEW', '返回操作介面'],
  ['DATA LAYERS', '資料圖層'],
  ['CONTEXT', '情境'],
  ['CONTACTS', '目標'],
  ['SELECT CONTEXT', '選擇情境'],
  ['COCKPIT', '駕駛艙'],
  ['SEARCH NEARBY SITES', '搜尋附近設施'],
  ['CONTACTS CONTEXT OFF', '目標情境已關閉'],
  [
    'SELECT CONTACTS TO LOAD OBSERVED / MAPPED PROXIMITY',
    '選擇目標以載入觀測及地圖鄰近資訊',
  ],
  ['AVAILABLE MISSIONS', '可用任務'],
  ['SELECT A MISSION TO INSPECT', '選擇任務以查看'],
  ['LOADING 30-DAY MISSION INDEX', '正在載入 30 天任務索引'],
  ['TAB PREVIEWS · ENTER / SPACE SELECTS', 'TAB 預覽 · ENTER / 空白鍵選取'],
  ['RADIO', '網路電台'],
  ['RADIO READY', '電台待命'],
  ['ENABLE', '啟用'],
  ['VOLUME', '音量'],
  ['OFF', '關閉'],
  ['STATION TAG', '電台標籤'],
  ['NO STATION SELECTED', '尚未選擇電台'],
  [
    'Enable Radio, then choose a globe marker or use next.',
    '啟用電台後，選擇地球上的標記或按下一個。',
  ],
  ['DIRECTORY BAND', '目錄頻段'],
  ['DRAG TO TUNE', '拖曳選台'],
  ['ALL · DRAG THE NEEDLE', '全部 · 拖曳指針'],
  ['SNAPS TO AVAILABLE STATIONS', '自動對準可用電台'],
  ['PREV', '上一個'],
  ['PLAY', '播放'],
  ['NEXT', '下一個'],
  ['STOP', '停止'],
  ['Radio off', '電台已關閉'],
  ['STATION SITE', '電台網站'],
  ['DIRECTORY: RADIO BROWSER', '目錄：RADIO BROWSER'],
  [
    'Audio connects directly to the broadcaster after you press play. Your IP is visible to that broadcaster.',
    '按下播放後會直接連線到廣播業者，對方將能看見你的 IP 位址。',
  ],
  ['SOURCE · UNKNOWN', '來源 · 未知'],
  ['Enable CCTV to load camera intersections', '啟用 CCTV 以載入監視器位置'],
  ['CCTV OFF', 'CCTV 關閉'],
  ['NEAREST', '最近'],
  ['FOCUS', '聚焦'],
  ['COVERAGE OFF', '覆蓋範圍關閉'],
  ['AUTO HOP OFF', '自動切換關閉'],
  ['PROJECTION ON', '投影開啟'],
  ['CALIBRATION', '校正'],
  ['ADJUST', '調整'],
  ['SAVE CAL', '儲存校正'],
  ['RESET CAL', '重設校正'],
  ['SCENE SUMMARY', '場景摘要'],
  [
    'Enable CCTV to start camera-linked intelligence summaries.',
    '啟用 CCTV 以開始產生監視器連動情報摘要。',
  ],
  ['SCENES', '場景'],
  ['NEW', '新增'],
  ['DEL', '刪除'],
  ['CAPTURE SHOT', '擷取鏡位'],
  ['UPDATE SHOT', '更新鏡位'],
  ['START', '開始'],
  ['EXPORT PRESETS', '匯出預設'],
  ['IMPORT', '匯入'],
  ['RUN LOG', '執行紀錄'],
  ['Ready', '就緒'],
  ['FIRST PERSON', '第一人稱'],
  ['AIRCRAFT', '航空器'],
  ['LIVE TRACK · COURSE ALIGNED', '即時追蹤 · 航向已對準'],
  ['CURRENT', '目前'],
  ['GROUND SPEED', '地面速度'],
  ['ALTITUDE', '高度'],
  ['CONTACT', '目標'],
  ['CONTACTS · 250 KM', '目標 · 250 公里'],
  ['CONTEXT ONLY', '僅供情境參考'],
  ['NEAREST OBSERVED / MAPPED', '最近的觀測／地圖項目'],
  ['NO AVAILABLE EXAMPLE', '目前沒有可用項目'],
  ['AVAILABLE INPUTS ONLY · NOT AN ALL-CLEAR', '僅依現有輸入 · 不代表安全無虞'],
  ['ESTIMATED FLIGHT PLAN', '預估飛行計畫'],
  ['ROUTE DATA UNAVAILABLE', '無可用航線資料'],
  ['FROM', '起點'],
  ['TO', '終點'],
  ['UNKNOWN', '未知'],
  ['LIVE SIGNALS', '即時訊號'],
  ['OBSERVED / MAPPED PINGS', '觀測／地圖訊號'],
  ['POWER UP', '擴充功能'],
  ['POWERED UP', '功能已就緒'],
  ['AI AGENT', 'AI 助理'],
  ['VOICE STANDBY', '語音待命'],
  ['GROUND STATION · PROVIDER SETTINGS', '地面站 · 服務供應商設定'],
  ['Power up the globe', '擴充地球資訊'],
  [
    "The globe already flies keyless. Every key below switches on another real feed — paste one and it's saved into this app's local configuration, then the server restarts itself. Server-side keys stay on this machine; Google Maps and Cesium ion run in the browser and must be provider-restricted. Keys you configured elsewhere are shown but never touched.",
    '不設定金鑰也能使用地球儀。下方每組金鑰可啟用額外的即時資料；貼上後會儲存在本機設定，伺服器也會自動重啟。伺服器端金鑰只留在本機；Google Maps 與 Cesium ion 在瀏覽器執行，請務必設定供應商存取限制。從其他位置設定的金鑰只會顯示，不會被修改。',
  ],
  ['SAVE KEYS', '儲存金鑰'],
  ['ESC to close', '按 ESC 關閉'],
  [
    'The Google Maps key buys the photorealistic planet — everything else stacks on top.',
    'Google Maps 金鑰提供擬真地球，其餘資料會疊加在地圖上。',
  ],
  ['LOADING LIVE DATA', '正在載入即時資料'],
  ['syncing road network', '正在同步道路網路'],
  ['loading frames', '正在載入影像'],
  ['Globe actions', '地球操作'],
  ['Clear selected data layers', '清除已選資料圖層'],
  ['Copy share link', '複製分享連結'],
  ['Tilt map to oblique view', '切換地圖傾斜視角'],
  ['Reset map to north up', '將地圖重設為北向上'],
  ['Reset to full globe view', '返回完整地球視角'],
  ['Navigation, voice, and visual preset controls', '位置、語音與視覺預設控制'],
  ['Visible map targets', '可見地圖目標'],
]);

const ATTRIBUTE_NAMES = [
  'aria-label',
  'aria-valuetext',
  'placeholder',
  'title',
];

const PATTERNS = [
  [
    /^Could not open that mission(.*)\. Retry or explore manually\.$/,
    '無法開啟該任務$1。請重試或自行探索。',
  ],
  [/^Location: (.*)$/, '位置：$1'],
  [/^Landmark: (.*)$/, '地標：$1'],
  [/^Error: (.*)$/, '錯誤：$1'],
  [/^POWER UP · (\d+) KEYS? WAITING$/, '擴充功能 · 尚有 $1 組金鑰未設定'],
  [/^Expand (.*)$/, '展開$1'],
  [/^Collapse (.*)$/, '收合$1'],
];

export function translateTraditionalChinese(value) {
  if (typeof value !== 'string') return value;
  const exact = TRANSLATIONS.get(value);
  if (exact) return exact;
  for (const [pattern, replacement] of PATTERNS) {
    if (pattern.test(value)) return value.replace(pattern, replacement);
  }
  return value;
}

function translateTextNode(node) {
  if (node.parentElement?.closest?.('.material-symbols-outlined')) return;
  const value = node.nodeValue;
  const trimmed = value?.trim();
  if (!trimmed) return;
  const translated = translateTraditionalChinese(trimmed);
  if (translated === trimmed) return;
  node.nodeValue = value.replace(trimmed, translated);
}

function translateElement(element) {
  if (!(element instanceof Element)) return;
  for (const attribute of ATTRIBUTE_NAMES) {
    if (!element.hasAttribute(attribute)) continue;
    const current = element.getAttribute(attribute);
    const translated = translateTraditionalChinese(current);
    if (translated !== current) element.setAttribute(attribute, translated);
  }
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) translateTextNode(child);
    else if (child.nodeType === Node.ELEMENT_NODE) translateElement(child);
  }
}

export function initTraditionalChinese(documentRef = globalThis.document) {
  if (!documentRef?.documentElement || !globalThis.MutationObserver)
    return null;
  documentRef.documentElement.lang = 'zh-Hant';
  documentRef.title = translateTraditionalChinese(documentRef.title);
  translateElement(documentRef.body);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') translateTextNode(mutation.target);
      if (mutation.type === 'attributes') translateElement(mutation.target);
      for (const node of mutation.addedNodes || []) {
        if (node.nodeType === Node.TEXT_NODE) translateTextNode(node);
        else if (node.nodeType === Node.ELEMENT_NODE) translateElement(node);
      }
    }
  });
  observer.observe(documentRef.body, {
    attributes: true,
    attributeFilter: ATTRIBUTE_NAMES,
    childList: true,
    characterData: true,
    subtree: true,
  });
  return observer;
}
