<div align="center">

# 🌐 God's Eye View · 简体中文说明

**[English](README.md) · 简体中文**

### 浏览器里的侦察卫星模拟器——然后你会意识到：数据源全部公开，数据都是真实的。

逼真三维地球。实时飞机、船舶、卫星、地震、交通与公共摄像头。由实时 AI 智能体驱动的免手语音控制。

_无处遁形。_

</div>

---

<div align="center">

**快速开始** · **界面语言** · **密钥与费用** · **常见问题** · **能力与限制** · [贡献指南（英文）](CONTRIBUTING.md)

</div>

---

## 这是什么

God's Eye View 把公开信号汇集到一颗可探索的地球上：飞行器应答机、船舶信标、轨道根数、地震台网与公共摄像头的实时数据，同处一个场景——你可以在全球视野与单个目标之间自由切换。它在本地浏览器中运行，源码完全可查。

- **🛩️ 驾驶舱视角**：进入被跟踪航班内部，相机沿真实地形一路下落。
- **📡 目标态势**：目标周边 250 km 内的一切——逐个切换实时飞机并直接进入驾驶舱。
- **🎯 点击即跟踪**：相机锁定、拖尾轨迹、完整元数据；跟踪火点或船舶可一键移交最近的公共摄像头。
- **🌦️ 天气**：GFS/ECMWF 预报风场动画、观测雷达/卫星云图/闪电回放、NHC/CPHC 气旋路径——免密钥。
- **🎙️ 语音控制**（需 OpenAI 密钥）：*“带我去 LAX，选中最近的一架在空飞机。”*
- **🔗 分享链接**：相机、风格、图层乃至被跟踪目标都能序列化进 URL。
- 更多能力见[英文 README 功能清单](README.md#️-what-this-thing-does)。

> 诚实语义：大多数数据源为实时或定期刷新；交通是沿真实路网的模拟；摄像头位姿与火箭轨迹为粗略估算。中文界面保留这些限定——“实时 / 预报 / 模拟 / 估算 / 数据已过期 / 需要密钥”不会被翻译成更强的能力表述。

---

## 快速开始

**无需注册账号或 API 密钥即可启动。** 免密钥基线：Esri 卫星影像 + 免密钥地形（Esri 不可达时自动回退 OSM）。航班、军用飞机、卫星、地震、公共摄像头、电台与发射任务均免密钥可用。

### 环境要求

- **Node.js 24.x（24.14.0 或更高）或 26.x**（不推荐 25，已停止维护）
- Windows / macOS / Linux

### 终端启动

```bash
git clone https://github.com/bilawalsidhu/gods-eye-view.git
cd gods-eye-view
npm ci
npm run doctor
npm run dev
```

打开 **`http://localhost:4173`**，在首启面板选择 **实时目标 / 太空任务 / 环境监测 / 自行探索**。

也可以通过 [Pinokio](https://pinokio.co/apps/github-com-bilawalsidhu-gods-eye-view) 一键安装（英文 README「Path 1」）。

### 界面语言

- 首次启动按浏览器语言自动选择：中文环境进入 **简体中文**，其他环境为 **English**。
- 手动切换：右上角 **显示** 面板底部的 **界面语言** 下拉框（English / 简体中文）。手动选择优先于浏览器语言，刷新与下次打开都会保留。
- 切换语言**无需刷新页面**：地图视角、图层开关、跟踪目标、面板状态与表单内容全部保留。
- 缺失翻译自动回退英文。发现翻译问题？欢迎提交 Issue/PR（见 [docs/I18N.md](docs/I18N.md)）。

---

## 密钥与费用

密钥是升级项而非前提。点击右下角 **点亮地球**（POWER UP）图标打开 **数据提供商设置**：粘贴密钥、保存，应用自动重启并点亮对应能力。

| 密钥 | 点亮 | 费用 |
| --- | --- | --- |
| [Cesium ion](https://cesium.com/ion) | Bing 影像地图栈 + 世界地形 | 免费额度（符合条件的个人非商业用途） |
| Google Maps | 逼真三维地图（直连计费）+ 地点搜索 | 按量计费，需开启结算 |
| OpenAI | 云端语音控制 | 按量计费（支持 ChatGPT OAuth 登录） |
| AISStream | 全球实时船舶 | 免费 |
| NASA FIRMS | 活跃火点 | 免费 |
| OpenSky | 更多航班轮询额度 | 免费 / OAuth |
| TomTom | 真实路况（无密钥时为模拟交通） | 免费额度 |

完整的能力矩阵、安全限制与共享实例规则见[英文 Keys & Costs](README.md#-api-keys) 与 [SECURITY.md](SECURITY.md)。密钥写入本机被 Git 忽略的 `.env`（终端克隆）或 `pinokio/ENVIRONMENT`（Pinokio），浏览器端密钥（Google Maps、Cesium ion）必须在供应商处设置限制。

---

## 常见问题

**启动后地图是空的/加载失败？** 打开浏览器控制台查看错误；免密钥基线只需要 Esri 与 OSM 可达。国内网络访问 Google 3D Tiles 需要自行解决连通性，应用会在 Google 不可用时自动回退到 Esri/OSM 基线。

**中文界面不完整？** 界面自有文案已完整汉化并随语言切换即时更新；少数与数据源协议一致的状态串（如数据源自述的降级原因）保持英文，完整清单见 [docs/I18N-COVERAGE.md](docs/I18N-COVERAGE.md)。

**语音助手说英语？** 界面与字幕控件已汉化，但实时模型的回答语言由模型决定，不随界面语言自动切换；应用自身的语音播报与卡片文字为中文。

**如何参与翻译/新增语言？** 阅读 [docs/I18N.md](docs/I18N.md)：新增一个语言包 + 注册支持列表即可，奇偶校验测试会强制中英 key 对齐。

---

## 能力与限制（务必阅读）

- 这是**公开数据**的聚合与可视化：不把公开数据的推断包装成情报结论；缺失广播、未加载区域或未标注设施不构成“不存在”的证据（全局态势面板内含此免责声明）。
- 实体名称（航班号、MMSI、船名、卫星名）、坐标与 MGRS 保持原值；第三方署名与法律声明保留原文。
- 地图与影像的版权署名（Cesium ion、Google、OpenStreetMap 等）在应用内保留并链接原始声明。
- 本项目代码以 [MIT](LICENSE) 许可发布；第三方数据、模型与影像各自遵循其许可（[DATA_SOURCES.md](DATA_SOURCES.md)、[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)），不因翻译而改变。

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [README.md](README.md) | 英文完整说明（功能、安装、密钥、成本） |
| [docs/I18N.md](docs/I18N.md) | 国际化架构、key 规范、新增语言步骤 |
| [docs/I18N-COVERAGE.md](docs/I18N-COVERAGE.md) | 汉化覆盖清单与明确排除项 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献流程与基线检查 |
| [TESTING.md](TESTING.md) / [SECURITY.md](SECURITY.md) | 测试与安全 |
