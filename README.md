# 学习搭子 · B站视频即时解释

看 B 站课程视频时，暂停 → 点「我这里不懂」（或按 `1`），右侧抽屉里马上给出一段 ≤120 字的三段式解释（说人话 / 打个比方 / 问你一句），之后可以打字或说话继续追问。

当前版本 **v1.2**：语音追问改为本机离线识别（国内也能用）、抓不到字幕时醒目引导你打开字幕、每次求助记成历史节点并可回溯。改动明细见 [CHANGELOG.md](CHANGELOG.md)。

实现依据：[提示词工程规格.md](提示词工程规格.md)（v1.2 的变化见 [docs/v1.2-规格变更.md](docs/v1.2-规格变更.md)，方案见 [docs/v1.2-方案.md](docs/v1.2-方案.md)）。

```
启动.bat                  双击启动本地代理
proxy/server.ps1          本地代理（Windows 自带 PowerShell 即可运行，不用装任何东西）
proxy/config.json         API Key 和模型配置 —— Key 只放这里，扩展永远拿不到
prompts/*.md              全部提示词，每次请求实时读取，改完保存立即生效
extension/                Chrome 扩展（Manifest V3）
data/calls.jsonl          每次调用一行日志（自动生成）
dev/                      自测工具：模拟上游 + 模拟播放页 + 设置页自测
docs/                     版本方案和规格变更
CHANGELOG.md              版本记录
```

## 快速开始

> 让 AI Agent（Claude Code、Codex 等）替你安装：把 [INSTALL.md](INSTALL.md) 交给它。

1. **填 Key**：打开 `proxy/config.json`，把 `apiKey` 填上。默认配的是阿里云百炼（通义千问），换别家见下文。
2. **启动代理**：双击 `启动.bat`。看到「学习搭子 v1.2.0 · 本地代理已启动」和「API Key 已配置」就好，**这个窗口要一直开着**。
3. **装扩展**：Chrome 打开 `chrome://extensions` → 右上角打开「开发者模式」→「加载已解压的扩展程序」→ 选 `extension` 文件夹。
4. **测连接**：点浏览器工具栏上的扩展图标 → 设置页 →「测试连接」，显示「已连上代理 · 模型 …」即可。
5. **使用**：打开一个 B 站课程视频，**打开字幕（CC 字幕或 AI 字幕）**，正常看一会儿，然后暂停 → 画面中央出现「我这里不懂」，点它或按 `1`。字幕是直接印在画面里的视频（硬字幕）不用管，播放时会自动从画面上读。忘了开字幕也没关系：播放 20 秒还没抓到字幕，播放器上方会提醒你，点【一键打开字幕】就行。
6. **第一次点麦克风**时，B 站页面会弹出「使用麦克风」的权限请求，选「允许」。

> 从旧版升级：关掉「启动.bat」的黑色窗口再双击重新打开（新接口 `/asr`、`/summarize` 要重启代理才生效），然后在 `chrome://extensions` 里点扩展的刷新按钮，再刷新 B 站页面。设置页右上角显示 `v1.2.0`、「测试连接」显示代理版本 1.2.0 就对了。

## 抽屉里能做什么

- **三段解释**：说人话 / 打个比方 / 问你一句。「问你一句」下面有「是 / 不是 / 不确定」，点一下就算回答。
- **追问**：底部输入框打字回车，或点麦克风说话（按钮变红并随音量跳动；说完停顿 0.7 秒自动识别并发送，录音中再点一次＝马上结束）。快捷按钮：还是不懂 / 展开讲讲（放宽到 200 字）/ 不管视频，直接讲 / 懂了。
- **直说 / 带我想**：直说＝直接给答案；带我想＝苏格拉底式，一次只问一个小问题引你自己想出来。连续两次说「不懂」会提示你切到「带我想」。
- **没抓到字幕时的指引卡片**：抽屉顶部的琥珀色卡片说明原因（没打开 / 要登录 / 这个视频没有字幕）和该怎么做，带【一键打开字幕】【倒回 30 秒重看】。
- **历史**：标题栏的【历史 N】列出本视频每次求助的节点（视频位置 + 一句话说明 + 追问轮数），点一个节点就回溯，见下文「学习历史」。
- **继续播放**、**Esc** 或右上角 × 关闭抽屉。全屏下也能用。

## 学习历史（v1.2）

- **节点**：每次求助（暂停点「我这里不懂」或按 `1`）拿到解释，就记成一个节点：视频位置、当时的三段解释、全部追问。
- **一句话说明**：节点一生成就有规则说明（如「卡在『线性无关』· 追问 1 次 · 已懂」）；关掉抽屉后，本地代理调一次模型（Call 4，`prompts/call4_summary.md`）换成 AI 写的一句话，如「线性无关：谁都不能由别的向量拼出来，追问后已懂」。没配 Key 或调用失败就保留规则说明；漏掉的下次打开这个视频时自动补上。设置页可以关掉 AI 说明。
- **回溯**：在抽屉的【历史】里点一个节点 → 视频跳回当时的位置并暂停，抽屉还原当时的解释和追问，顶部标出「回溯 · 某时间的记录」，可以**接着追问**（追问记在这个节点上）。暂停时「我这里不懂」旁边也有【历史】入口。
- **设置页「学习历史」**：按视频列出所有节点，点节点会打开那个视频并直接回溯；可以一键清空。
- 历史**只存在本机浏览器**（`chrome.storage.local`），每个视频最多 50 个节点，总量超过 8MB 时删最久没看的视频。

## 整片记忆（v1.3 探索，未合并到 main）

让 AI 读完整部视频的字幕再解释：既知道全片在讲什么、现在讲到哪一章，又能看清暂停点前后各 30 秒。方案见 [docs/v1.3-记忆分层-方案.md](docs/v1.3-记忆分层-方案.md)。

- **字幕来源**：打开视频页时直接从 B 站接口取整份 CC / AI 字幕（AI 字幕要登录 B 站）。取不到时退回边播边记：求助前把已经播过的字幕交给代理。
- **生成**：代理在后台把字幕切成 2–3 分钟一节，调模型给每节写标题和摘要（map），再汇总成主线、章节和术语表（reduce），存在 `data/memory/<视频>.json`。不阻塞求助，没配 Key 时只存原文。
- **求助时**拼四层上下文：全局层（主线 + 章节大纲，标出“现在在这一章”）→ 章节层（前后小节摘要）→ 焦点层（暂停点 ±30 秒原文，▶ 标出暂停那句）→ 回溯层（术语第一次出现的地方、和问题最相关的别的段落）。
- 抽屉底部的小字显示「整片记忆 · 4 章「当前章名」」或「整片记忆生成中」。
- `config.json` 可选 `"memory": { "enabled": true, "chunkSec": 150, "chunkChars": 900, "focusBefore": 30, "focusAfter": 30, "parallel": 3 }`。
- 只用模拟上游测过，真模型的效果还没验证。

## 语音追问（v1.2：本机识别）

Chrome 自带的语音识别要连 Google，国内用不了。v1.2 起改成：扩展只负责录音（16kHz 单声道，本地判断说完），录音发给本地代理，用 **Windows 自带的离线中文语音识别**转成文字，再自动作为追问发出。**不联网、不花钱、录音不保存**。一句七八秒的话识别约 0.3–0.5 秒。

- 代理启动窗口里有一行「语音识别  可用（Windows 本机离线识别，语言 zh-CN）」；不可用时会写原因（一般是没装中文语音识别：设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 安装「语音识别」；中文版 Windows 通常自带）。只在 Windows PowerShell 5.1 下可用（`启动.bat` 用的就是它）。
- 设置页「语音识别方式」：**本机识别**（默认）/ 浏览器自带（能访问 Google 时可用）。
- 想用云端识别：`proxy/config.json` 加一段 `"asr": { "engine": "cloud", "model": "whisper-1" }`（任何 OpenAI 兼容的 `/audio/transcriptions`；`baseUrl` / `apiKey` 不填就沿用上面的），云端失败会自动退回本机。`"engine": "off"` 关闭语音识别。见 `proxy/config.example.json`。
- 识别结果太短或只有「嗯」「啊」这类语气词时不自动发送，会填进输入框让你改。

## 换模型

任何 OpenAI 兼容的 `/chat/completions` 接口都行，只改 `proxy/config.json`，**保存即生效，不用重启代理**（改 `port` 除外）。

| 服务商 | baseUrl | model | visionModel |
|---|---|---|---|
| 阿里云百炼（默认） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | `qwen-vl-plus` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | 没有视觉模型：把 `sendImage` 设为 `false`，画面上的字改由本地识别读出 |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | `glm-4v-flash` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | `gpt-4o-mini` |

模型名以服务商当前文档为准。其他字段：

- `sendImage`：是否把暂停那一帧发给视觉模型。为 `false`（或视觉调用失败自动退回纯文本）时，代理改用本地文字识别读出画面上的字再交给模型，见下文「画面识字」。
- `ocr`：本地画面识字，默认 `true`。设为 `false` 就完全不识别画面文字。
- `httpProxy`：上游需要走代理时填，例如 `http://127.0.0.1:7890`。
- `timeoutSec`：上游超时秒数。
- `port`：改了端口要同时在扩展设置页把「代理地址」改成一样的。

## 画面识字（模型看不了图也能知道画面上写了什么）

用的是 Windows 自带的文字识别（`Windows.Media.Ocr`），**在本机跑、不联网、不花钱**，中文系统一般自带中文识别包。代理启动时窗口里会显示「画面识字 可用」或不可用的原因。

- **暂停那一帧**：扩展直接从 `<video>` 取一帧（不含弹幕和控制条）发给代理。模型能看图就直接看；看不了图（如 DeepSeek）时，代理把整帧识别出来：底部居中的那行当字幕补进上下文，其余的字（板书、标题、公式）作为「当前画面上的文字」附在问题后面，追问时也会带上。
- **烧在画面里的硬字幕**：有些视频（例如漫士沉思录）字幕是直接印在画面上的，播放器 DOM 里没有，原来就会「没抓到字幕」。现在播放时如果 8 秒内没出现过播放器字幕，扩展每 1.5 秒把画面底部 1/4 送给代理识别（每次约 10 毫秒），识别到的字幕和普通字幕一样按时间打点，进入 ±30 秒窗口。这些图片只发到本机代理，不会上传；设置页可以关掉「播放时读取画面里的硬字幕」。
- 识别会有错字（例如把「概念」读成「姬念」），公式和花体字基本读不出来；提示里已经告诉模型「看不懂的直接忽略」。
- 抽屉底部的小字：「看了画面」＝视觉模型看了图；「读了画面文字」＝用了本地识别；「字幕取自画面」＝上下文里有从画面读出来的硬字幕。
- 只在 Windows PowerShell 5.1 下可用（`启动.bat` 用的就是它）。提示没有识别语言包时：设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 安装「光学字符识别」。

## 改提示词

`prompts/` 下的文件就是规格里的原文，代理每次请求都重新读取：

| 文件 | 用途 |
|---|---|
| `call1_router.md` | Call 1 路由（in_video / related_general / off_topic） |
| `call2_explain.md` | Call 2 即时解释 |
| `call2_degraded.md` | Call 2 降级版（字幕不足 10 字时用） |
| `call2_retry_suffix.md` | Call 2 超过 120 字时，降温到 0.2 重试所追加的约束 |
| `call3_followup.md` | Call 3 追问 |
| `call3_mode_direct.md` / `call3_mode_socratic.md` | 两种追问模式：第一行是模式名，其余是规则 |
| `call4_summary.md` | Call 4 历史节点的一句话说明（v1.2） |
| `memory_map.md` | 整片记忆：每个小节的标题、摘要、术语（v1.3 探索） |
| `memory_reduce.md` | 整片记忆：全片主线、章节、术语表（v1.3 探索） |

- `{{subject}}` 这类占位符由代理填入，每个文件开头的 `<!-- -->` 注释里列了可用的占位符；注释本身不会发给模型。
- 模型输出里的 Markdown（`**`、标题、列表、「第一段：」之类）会被代理清掉再计字数。

## 日志：data/calls.jsonl

每行一条 JSON，`type` 是 `call1` / `call2` / `call3` / `call4` / `asr` / `close` / `client_event`。常用字段：

- `call2`：`call2_chars`（字数）、`seg_lengths`（三段各多少字）、`length_violation`、`retried`、`vision_used`、`degraded`、`total_ms`；画面识字相关：`ocr_used`、`ocr_subtitle`（暂停那帧读到的字幕）、`ocr_ms`、`ocr_error`、`client_transcript_len`（扩展送来的字幕长度，补字幕前）
- `call3`：`route`、`mode`、`first_token_ms`、`call3_chars`、`aborted`
- `close`：`user_closed_without_followup`（看完解释没追问就关了，规格里最关键的指标）、`turns`、`open_ms`、`node_id`、`restored`（是不是回溯出来的会话）
- `call4`：`node_id`、`summary`、`chars`、`total_ms`
- `asr`：`engine_used`、`audio_sec`、`text`、`ok`、`error`、`total_ms`（不存音频）
- `client_event`：`event` 是 `sub_guide`（字幕指引：在哪出现、点了什么、字幕状态）/ `voice`（语音结果：sent / filled / denied / no_speech / asr_error …）/ `history_open` / `history_restore`。字段说明见 [docs/v1.2-规格变更.md](docs/v1.2-规格变更.md) 第 8 节；v1.3 探索加了 `full_subs`（整片字幕拿没拿到、为什么）
- `memory`（v1.3 探索）：整片记忆生成完一行，小节数、模型摘要数、章节数、调用次数、耗时；`call2` / `call3` 多 `t_sec`、`memory_status`、`memory_focus`、`memory_chapter`、`memory_layer_chars`、`recall_hits`

统计「看完就关」的比例（在项目目录打开 PowerShell）：

```powershell
$rows = Get-Content data\calls.jsonl -Encoding UTF8 | ConvertFrom-Json; $c = @($rows | Where-Object { $_.type -eq 'close' -and $_.call2_ok }); '{0} 次解释，{1} 次看完就关' -f $c.Count, @($c | Where-Object user_closed_without_followup).Count
```

## 常见问题

**抽屉里说「连不上本地代理」**：`启动.bat` 那个窗口被关了，或者扩展设置里的代理地址和 `port` 对不上。

**提示「代理还没配置 API Key」/ 401**：`proxy/config.json` 里的 `apiKey` 没填或填错，改完保存即可，不用重启。

**抽屉顶部出现「没抓到这段的字幕」卡片**：卡片里写了原因——播放器字幕没打开（点【一键打开字幕】）、AI 字幕要登录 B 站才能看、或者这个视频本来就没有字幕。这时只能根据画面（或画面上读到的字）解释，效果会差一些。另外字幕是从**已经播过的**画面和字幕里收集的：刚打开页面就直接拖到某处暂停，前面 30 秒还没播过，就没有上下文——点【倒回 30 秒重看】，播到这里再暂停求助就好。播放时的「没检测到字幕」提示条点【不再提示】后所有视频都不再主动提醒，设置页「抓不到字幕时主动提醒」可以打开回来。

**抽屉显示「未用画面」、模型说看不到画面**：模型不支持图片，而且本地画面识字没起作用。看代理窗口启动时「画面识字」那一行：显示不可用就按提示装识别语言包；如果是旧版代理（没有这一行），关掉窗口重新双击 `启动.bat`。改了扩展代码后，还要在 `chrome://extensions` 里点扩展的刷新按钮，再刷新 B 站页面。

**麦克风不能用**：v1.2 起默认用本机识别，不再依赖 Google。按提示排查：「麦克风权限被拒绝」→ 点地址栏左边的图标把麦克风改成允许；「本地代理还是旧版本」→ 关掉「启动.bat」窗口重新打开；「本机语音识别不可用」→ 看代理窗口「语音识别」那一行的原因；「没听到声音」→ 检查 Windows 声音设置里的输入设备。也可以在设置页把语音关掉。

**为什么扩展要「读取和更改所有网站上的数据」权限**：直接从视频取帧失败时，会退回 `captureVisibleTab` 整页截图，这个接口需要这个权限。扩展实际只在 `www.bilibili.com` 上运行；不想发画面可以在设置页关掉「附带暂停那一帧画面」。

**B 站改版后按钮不出现 / 抓不到字幕**：字幕是按 class 名里含 `subtitle` 的节点抓的，播放器是找页面里最大的 `<video>`。改版后可能要调整 `extension/content.js` 里的 `readSubtitle` / `findVideo`。

## 实现说明（与规格对应）

- **Call 1 只在第一次追问时跑**：点按钮那一次直接按 `in_video` 走 Call 2；第一次追问时代理先跑 Call 1 再接 Call 3，之后沿用这次的路由。判成 `off_topic` 的那一句只给一句引导，不沿用，下一句重新判断。
- **Call 1 失败兜底**：模型不支持 JSON 模式会自动去掉 `response_format` 重试；返回的不是合法 JSON 时，用 2-gram 规则判断（问题和字幕重合 ≥2 个二字词 → `in_video`，否则 `related_general`）。
- **Call 2 超长**：超过 120 字 → temperature 0.2 + `call2_retry_suffix.md` 重试一次，更短才采用；仍超长就照常显示，并在日志里记 `length_violation`。
- **语音（v1.2 起与规格第 6 节不同）**：规格的「流式 STT 首个 partial ≥4 字就发起」依赖 Chrome 的在线识别，国内不可用；现在是本地静音检测（静音 0.7 秒判定说完）→ 代理 `/asr` 整句识别 → 自动发送。旧的浏览器识别留作设置页可选项（仍按 ≥4 字 + 静音 0.7 秒发送）。
- **历史节点（v1.2）**：扩展后台（service worker）统一读写 `hist:<视频ID>`，多个标签页同时写也不会互相覆盖；Call 4 也在后台调用，关掉页面不影响生成。设置页点节点时先记一条 `pendingRestore`，视频页加载后 2 分钟内读到它就回溯。
- **过往求助（past）**：每个视频最近 10 条存在 `chrome.storage`，每次带最近 3 条给 Call 2；设置页可以清空。
- **取帧**：优先把 `<video>` 当前帧画到 canvas（最大宽 1280，JPEG 0.85），不含弹幕、控制条和扩展自己的浮层；画布被跨域污染取不到时，退回整页截图：先把浮层藏起来，只裁视频区域，最大宽 960。
- **画面文字不改提示词**：本地识别出的文字拼在发给模型的**用户消息**末尾，`prompts/` 里规格原文一字不动。

## 开发自测（不需要真 Key，也不需要打开 B 站）

```bash
node dev/mock-upstream.js 9901
```

测试配置已经放在 `dev/mock-config.json`（连上面的模拟上游，端口 8788），日志写到 `data/dev-calls.jsonl`，不会混进真实日志：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File proxy\server.ps1 -ConfigPath dev\mock-config.json -LogPath data\dev-calls.jsonl
```

```bash
python -m http.server 8790 --bind 127.0.0.1
```

浏览器打开 `http://localhost:8790/dev/test-page.html?proxy=http://localhost:8788`：这是一个模拟的课程播放页，直接加载 `extension/history.js` + `extension/content.js`，用一个小 shim 代替 `chrome.*` 接口。点「播放」→ 暂停 → 点按钮或按 `1`。常用地址参数（完整列表见 `dev/test-page.html` 开头的注释）：

| 参数 | 用途 |
|---|---|
| `?sub=on\|off\|login\|none\|nobutton` | 模拟 B 站字幕菜单的五种状态，测字幕指引（页面下方的下拉框也能切） |
| `?rate=2` | 虚拟时钟两倍速，测「播放 20 秒无字幕主动提醒」省一半时间 |
| `?fakemic=1` | 把 `dev/sample-question.wav`（「线性无关到底是什么意思，能再举个例子吗」）当麦克风输入，测本机语音识别全流程 |
| `?mic=deny` | 模拟麦克风权限被拒 |
| `?burn=1` | 字幕烧进画面，测硬字幕识别 |
| `?fresh=1` | 清空模拟页保存的历史（历史存在 localStorage，刷新页面还在） |
| `?full=1` | 换成约 8 分钟的样例课（`dev/sample-subtitles.json`），并当作从 B 站取到了整片字幕，测整片记忆（v1.3 探索）；`POST /memory/context` 能看某个时间点拼出来的四层上下文 |

设置页自测：`http://localhost:8790/dev/options-page.html`（加 `?seed=1` 放入几个 B 站视频的示例节点），加载真实的 `options.html`，和模拟播放页共用历史，点节点会显示将要打开的链接和 `pendingRestore`。

模拟上游能触发的特殊情况写在 `dev/mock-upstream.js` 开头的注释里（超长重试、不支持 JSON 模式、视觉失败、路由返回乱码、离题、Call 4 一句话说明等）。`.claude/launch.json` 里有 `harness` / `mock-upstream` / `proxy-dev` 三个启动项。
