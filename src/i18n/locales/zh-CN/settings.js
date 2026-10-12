/** Simplified Chinese pack — Provider Settings key setup. */
export default {
  kicker: '地面站 · 数据提供商设置',
  closeAria: '关闭密钥设置',
  title: '点亮地球',
  description:
    '地球无需密钥即可运行。下方每一把密钥都会点亮另一路真实数据源——粘贴一把，它就会存入本应用的本地配置，随后服务器自行重启。服务器端密钥只保留在这台机器上；Google Maps 与 Cesium ion 在浏览器中运行，必须在服务商处设置限制。你在其他地方配置的密钥仅作展示，绝不会被改动。',
  apply: '保存密钥',
  escToClose: '按 ESC 关闭',
  status: {
    // Painted by keySetup.js (say()/close()), never by the static binder.
    default: 'Google Maps 密钥换来照片级写实的地球——其余一切都叠加在它之上。',
  },
  chip: {
    waiting: {
      // zh pluralizes with "other" only; "one" exists for key parity.
      one: '点亮地球 · {count} 把密钥待接入',
      other: '点亮地球 · {count} 把密钥待接入',
    },
    ready: '已点亮',
    projectKeys: '项目密钥：{label}',
  },
  tier: {
    metered: '按量计费——需要启用结算的账号',
    free: '免费密钥——注册、粘贴，即可使用',
  },
  badge: {
    browserSide: '浏览器端',
    browserSideTip:
      '此密钥按设计在浏览器中运行——请在服务商处设置限制（见 SECURITY.md）',
    external: '由外部配置',
    externalTip: '由你的环境、钥匙串或启动器提供——请在原设置处修改',
  },
  row: {
    manage: '管理 ↗',
    getKey: '获取密钥 ↗',
    remove: '移除',
    removeTip: '从此应用保存的密钥中移除 {title}',
  },
  field: {
    paste: '粘贴 {envVar}',
    replace: '{envVar} 已保存——粘贴可替换',
  },
  keys: {
    googleMaps: {
      title: 'GOOGLE MAPS',
      unlocks: '照片级写实的 3D 地球 + 地点搜索',
    },
    googleMapsServer: {
      title: 'GOOGLE MAPS — 服务器端',
      unlocks: 'Places 上下文 + 街景回退；可选的独立密钥',
    },
    openai: {
      title: 'OPENAI',
      unlocks: '语音控制——API 密钥或 ChatGPT OAuth',
    },
    aisstream: {
      title: 'AISSTREAM',
      unlocks: '全球实时船舶',
    },
    firms: {
      title: 'NASA FIRMS',
      unlocks: '实时活跃火点探测',
    },
    tomtom: {
      title: 'TOMTOM',
      unlocks: '真实实时路况（无密钥时运行模拟）',
    },
    cesiumIon: {
      title: 'CESIUM ION',
      unlocks: 'Bing 影像地图堆栈 + 全球地形',
    },
    opensky: {
      title: 'OPENSKY',
      unlocks: '更多航班轮询配额（无密钥时以匿名方式可用）',
    },
    mapillary: {
      title: 'MAPILLARY',
      unlocks:
        '街景影像与街景图层中的覆盖范围。免费：在 Mapillary 开发者控制台注册一个应用，并粘贴其 Client Token',
    },
    launchLibrary: {
      title: 'LAUNCH LIBRARY',
      unlocks: '更高的太空任务请求配额',
    },
  },
  requirement: {
    tooltip: '需要 {envVars}——请在“数据提供商设置”中添加',
  },
  voiceAuth: {
    stateOauth: '语音认证 · CHATGPT OAUTH',
    stateApiKey: '语音认证 · API 密钥',
    useApiKey: '使用 API 密钥',
    useOauth: '使用 CHATGPT OAUTH',
    useApiKeyTip: '下次云语音会话使用 OPENAI_API_KEY',
    useOauthTip: '下次云语音会话使用本机已登录的 ChatGPT/Codex OAuth 会话',
    switchedToApiKey: '云语音将在下次会话使用 OPENAI_API_KEY。',
  },
  store: {
    appConfig: '应用配置',
    localEnv: '本地 .env',
  },
  save: {
    saving: '正在保存…',
    savedTo: '已保存到{store}。正在重启——本页将自动刷新。',
    removedFrom: '已从{store}移除。正在重启——本页将自动刷新。',
    failedStatus: '保存失败（{status}）。',
    failedMessage: '保存失败：{message}',
    pasteFirst: '请先粘贴至少一把密钥。',
  },
  remove: {
    confirm: '确定要从保存的配置中移除此密钥吗？',
  },
  oauth: {
    checking: '正在检查本机 ChatGPT OAuth 登录…',
    checkFailed: 'OAuth 检查失败：{message}',
    checkFailedShort: '无法检查 ChatGPT 登录状态。',
    checkFailedRetry: '无法检查 ChatGPT 登录状态，请重试。',
    selected: '已为云语音选择 ChatGPT OAuth。你的 API 密钥仍会保留并可用。',
    expired: 'ChatGPT 登录已过期。正在重新打开登录…',
    opening: '正在在你的浏览器中打开 ChatGPT 登录…',
    startFailed: '无法在此机器上启动 ChatGPT 登录。',
    waiting: '请在浏览器中完成 ChatGPT 登录，正在等待其完成…',
    timedOut: 'ChatGPT 登录超时。点击“{button}”重试。',
    complete: 'ChatGPT 登录完成。下次云语音会话将使用 OAuth。',
  },
};
