# 学习搭子 · macOS 版部署与使用说明

本项目原为 Windows 版（`proxy/server.ps1` + `启动.bat`）。macOS 适配版基于 **v1.4.0**，**不需要安装任何依赖**：代理用系统自带的 Python 3，画面识字 / 语音识别用系统自带的 Vision / Speech 框架（Swift 编译的本地 CLI，不联网、不花钱、不上传），整片字幕分层记忆（v1.4）也完整移植。

```
启动.command              双击启动本地代理（对应 Windows 的 启动.bat）
proxy/server.py           本地代理（macOS 版，Python 3 标准库，v1.4.0 全部 12 个端点）
proxy/mac/lb-ocr(.swift)  画面识字 CLI：macOS Vision 框架，等价 Windows 的 Windows.Media.Ocr
proxy/mac/lb-asr(.swift)  语音识别 CLI：macOS 26 用 SpeechTranscriber（设备端离线、免授权）；
                           macOS 13–25 退回 SFSpeechRecognizer（首次使用要一次授权）
proxy/build-mac.sh        编译上面两个 CLI（只需 Xcode Command Line Tools）
extension/                浏览器扩展（Manifest V3，Chrome / Safari 通用，新增 compat.js 兼容层）
dev/mock-upstream.py      模拟上游（Node 版的 Python 移植，含 v1.4 整片记忆的 map/reduce 模拟）
data/memory/              整片分层记忆的存储（自动生成）
```

## 一、首次部署（已完成的部分 ✅）

以下步骤已在本机执行完毕，一般不用重做：

1. **编译本地能力 CLI**：`bash proxy/build-mac.sh`（产物 `proxy/mac/lb-ocr`、`proxy/mac/lb-asr`）。
2. **生成配置**：首次启动会自动把 `proxy/config.example.json` 复制成 `proxy/config.json`。
3. **启动代理**：`python3 proxy/server.py`（或双击 `启动.command`），监听 `http://localhost:8787`。
4. **Chrome 扩展已装入**：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension` 文件夹。设置页「测试连接」已显示 **已连上代理**。

## 二、你还差两步

### 1. 填 API Key（必须）

打开 `proxy/config.json`，把 `apiKey` 填上（默认配的阿里云百炼/通义千问；换服务商只改 `baseUrl` / `model` / `visionModel`，对照表见 README.md）。**保存即生效，不用重启代理**。不填的话：即时解释 / 追问不可用，但整片记忆会先存原文（焦点层、回溯层照样能用），课程重点走规则标注。

### 2. Safari 加载扩展（想用 Safari 的话）

Safari 不像 Chrome 可以静默装未签名扩展，加载「临时扩展」需要本人 Touch ID / 密码确认，这步只能你来做（一分钟左右）：

1. Safari 设置 → 高级 → 勾选「显示网页开发者功能」（✅ 已帮你打开；设置里会出现「开发者」标签）。
2. 设置 → 开发者 → **添加临时扩展…** → 弹出管理员确认时用 **触控 ID 或输入密码**。
3. 文件选择框里选 `learn-buddy/extension` 文件夹。
4. 设置 → 扩展 → 勾选启用「学习搭子 · B站视频即时解释」。
5. 同一页里点开这个扩展 → **网站访问权限**给 `www.bilibili.com`（或所有网站）选「允许」——不给权限内容脚本不会注入。
6. 点工具栏的学习搭子图标打开设置页 → 「测试连接」显示「已连上代理」即成功。

**Safari 临时扩展的限制（Apple 的规定）**：退出 Safari 或 24 小时后会失效，需要重新「添加临时扩展」；每次重新添加都要再按一次触控 ID。长期固定使用建议：装完整 Xcode 后用 `xcrun safari-web-extension-converter extension/ -project-location build` 转成 App 常驻。日常主力用 Chrome 即可（Chrome 里的加载是一次性的，不会掉）。

## 三、日常使用

1. 双击 `启动.command`（Terminal 窗口保持打开，关窗 = 停止代理）。
2. 打开 B 站课程视频 → 打开字幕（CC / AI 字幕）→ 暂停 → 点「我这里不懂」或按 `1`。
3. 抽屉里可以打字追问、按麦克风说话（语音走本机识别，录音不上传）、切换「直说 / 带我想」。
4. 播放满 10 秒后扩展会把整片字幕交给代理生成**分层记忆**（抽屉底部小字显示进度），之后解释会带上全片大纲、章节脉络和暂停点 ±30 秒的精确原文。

## 四、macOS 版与 Windows 版的对应关系

| 能力 | Windows | macOS |
|---|---|---|
| 本地代理 | PowerShell 5.1（server.ps1） | Python 3（server.py），12 个端点与字段完全一致 |
| 整片分层记忆（v1.4） | 异步 HttpClient 任务，主循环每 250ms 步进 | 每个生成任务一个后台线程（内部按 `memory.parallel` 并行 map 批次），对外行为一致 |
| 画面识字 | Windows.Media.Ocr | Vision 框架（lb-ocr），zh-Hans，约 0.5 秒/帧 |
| 本机语音识别 | System.Speech | macOS 26+：SpeechTranscriber（设备端、免授权）；旧系统退回 SFSpeechRecognizer（首次要授权） |
| 启动 | 启动.bat | 启动.command |
| 日志 / 提示词 / 配置 / 记忆存储 | data/*.jsonl、prompts/*.md、proxy/config.json、data/memory/ | 完全相同（同一套文件） |

两个平台的代理同时只能跑一个（都监听 8787）。`/health` 返回里的 `platform` 字段是 `macOS`。`config.json` 的 `memory` 段（小节时长 / 字数、焦点窗口、并行数）两边通用。

## 五、开发自测（不需要真 Key）

```bash
python3 dev/mock-upstream.py 9901 &                                # 模拟 OpenAI 上游
python3 proxy/server.py --config dev/mock-config.json --port 8788 --log data/dev-calls.jsonl &   # 测试代理
python3 -m http.server 8790 --bind 127.0.0.1 &                     # 模拟播放页静态服务
```

- 模拟播放页：`http://localhost:8790/dev/test-page.html?proxy=http://localhost:8788`（播放 → 暂停 → 按 `1`；加 `&full=1` 会把 `dev/sample-subtitles.json` 当整片字幕，测分层记忆全流程；Chrome 和 Safari 都验证通过）
- 设置页自测：`http://localhost:8790/dev/options-page.html`
- mock 的特殊触发词（超长重试、off_topic、视觉失败、记忆 map/reduce 等）见 `dev/mock-upstream.py` 头部注释。

## 六、常见问题（macOS 特有）

| 现象 | 处理 |
|---|---|
| 「连不上本地代理」 | 代理窗口没开（双击 `启动.command`），或设置页代理地址与 `port` 不一致 |
| Safari 里按钮不出现 | 设置 → 扩展 → 学习搭子 → 网站访问权限没给 bilibili；或临时扩展已过期，重新添加 |
| Safari 重启后扩展消失 | Apple 限制：重新「添加临时扩展」即可 |
| 语音识别不可用（旧 macOS） | 系统设置 → 隐私与安全性 → 语音识别 → 给「终端」授权 |
| 麦克风不能用 | 第一次点麦克风时浏览器会弹权限，选允许；Safari 在 设置→网站→麦克风 |
| 画面识字不可用 | 重新跑 `bash proxy/build-mac.sh`；看 `curl http://localhost:8787/health` 的 `ocrError` |
| 整片记忆一直是 building | `curl "http://localhost:8787/memory/status?video_id=视频ID"` 看 error；没配 Key 时只存原文（焦点层可用）属正常 |
| 想换端口 | 改 `config.json` 的 `port`（要重启代理），并同步改扩展设置页「代理地址」 |

## 七、本次适配改动清单

- 新增 `proxy/server.py`：PowerShell 代理的完整移植（v1.4.0 全部端点：`/health`、`/explain`、`/route`、`/followup` SSE、`/log`、`/ocr`、`/asr`、`/summarize`、`/keypoints`、`/memory/build`、`/memory/status`、`/memory/context`）。超长降温重试、视觉失败回落、Call 1 JSON 模式回退 + 2-gram 兜底、Call 5 规则兜底、v1.4 整片记忆（map/reduce 后台生成、四层上下文、防串台、增量重做）、JSONL 日志等行为逐一对齐；`/health` 新增 `platform` 字段。
- 新增 `proxy/mac/lb-ocr.swift` / `lb-asr.swift` + `proxy/build-mac.sh`。
- 新增 `启动.command`、`dev/mock-upstream.py`（含 v1.4 记忆模拟与 `/__last?kind=` 查询）。
- 扩展 Safari 兼容：新增 `extension/compat.js`（Safari 用 `browser.*` 命名空间，统一映射到 `chrome.*`），并接进 manifest、background、设置页。扩展其余代码零改动。
- 原Windows 文件（`proxy/server.ps1`、`启动.bat`、`LearnBuddy.exe`）原样保留，Windows 上仍可照常用。
