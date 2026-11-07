# 学习搭子 · B站视频即时解释

看 B 站课程视频时，暂停 → 点「我这里不懂」（或按 `1`），右侧抽屉里马上给出一段 ≤120 字的三段式解释（说人话 / 打个比方 / 问你一句），之后可以打字或说话继续追问。

实现依据：[提示词工程规格.md](提示词工程规格.md)。

```
启动.bat                  双击启动本地代理
proxy/server.ps1          本地代理（Windows 自带 PowerShell 即可运行，不用装任何东西）
proxy/config.json         API Key 和模型配置 —— Key 只放这里，扩展永远拿不到
prompts/*.md              全部提示词，每次请求实时读取，改完保存立即生效
extension/                Chrome 扩展（Manifest V3）
data/calls.jsonl          每次调用一行日志（自动生成）
dev/                      自测工具：模拟上游 + 模拟播放页
```

## 快速开始

1. **填 Key**：打开 `proxy/config.json`，把 `apiKey` 填上。默认配的是阿里云百炼（通义千问），换别家见下文。
2. **启动代理**：双击 `启动.bat`。看到「学习搭子 · 本地代理已启动」和「API Key 已配置」就好，**这个窗口要一直开着**。
3. **装扩展**：Chrome 打开 `chrome://extensions` → 右上角打开「开发者模式」→「加载已解压的扩展程序」→ 选 `extension` 文件夹。
4. **测连接**：点浏览器工具栏上的扩展图标 → 设置页 →「测试连接」，显示「已连上代理 · 模型 …」即可。
5. **使用**：打开一个 B 站课程视频，**打开字幕（CC 字幕或 AI 字幕）**，正常看一会儿，然后暂停 → 画面中央出现「我这里不懂」，点它或按 `1`。字幕是直接印在画面里的视频（硬字幕）不用管，播放时会自动从画面上读。

## 抽屉里能做什么

- **三段解释**：说人话 / 打个比方 / 问你一句。「问你一句」下面有「是 / 不是 / 不确定」，点一下就算回答。
- **追问**：底部输入框打字回车，或点麦克风说话（说完停顿一下会自动发送）。快捷按钮：还是不懂 / 展开讲讲（放宽到 200 字）/ 不管视频，直接讲 / 懂了。
- **直说 / 带我想**：直说＝直接给答案；带我想＝苏格拉底式，一次只问一个小问题引你自己想出来。连续两次说「不懂」会提示你切到「带我想」。
- **继续播放**、**Esc** 或右上角 × 关闭抽屉。全屏下也能用。

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

- `{{subject}}` 这类占位符由代理填入，每个文件开头的 `<!-- -->` 注释里列了可用的占位符；注释本身不会发给模型。
- 模型输出里的 Markdown（`**`、标题、列表、「第一段：」之类）会被代理清掉再计字数。

## 日志：data/calls.jsonl

每行一条 JSON，`type` 是 `call1` / `call2` / `call3` / `close`。常用字段：

- `call2`：`call2_chars`（字数）、`seg_lengths`（三段各多少字）、`length_violation`、`retried`、`vision_used`、`degraded`、`total_ms`；画面识字相关：`ocr_used`、`ocr_subtitle`（暂停那帧读到的字幕）、`ocr_ms`、`ocr_error`、`client_transcript_len`（扩展送来的字幕长度，补字幕前）
- `call3`：`route`、`mode`、`first_token_ms`、`call3_chars`、`aborted`
- `close`：`user_closed_without_followup`（看完解释没追问就关了，规格里最关键的指标）、`turns`、`open_ms`

统计「看完就关」的比例（在项目目录打开 PowerShell）：

```powershell
$rows = Get-Content data\calls.jsonl -Encoding UTF8 | ConvertFrom-Json; $c = @($rows | Where-Object { $_.type -eq 'close' -and $_.call2_ok }); '{0} 次解释，{1} 次看完就关' -f $c.Count, @($c | Where-Object user_closed_without_followup).Count
```

## 常见问题

**抽屉里说「连不上本地代理」**：`启动.bat` 那个窗口被关了，或者扩展设置里的代理地址和 `port` 对不上。

**提示「代理还没配置 API Key」/ 401**：`proxy/config.json` 里的 `apiKey` 没填或填错，改完保存即可，不用重启。

**黄色提示「本次没有抓到字幕」**：播放器的字幕没打开，视频也没有印在画面里的字幕。这时只能根据画面（或画面上读到的字）解释，效果会差一些。另外字幕是从**已经播过的**画面和字幕里收集的：刚打开页面就直接拖到某处暂停，前面 30 秒还没播过，就没有上下文。正常看一会儿再暂停就好。

**抽屉显示「未用画面」、模型说看不到画面**：模型不支持图片，而且本地画面识字没起作用。看代理窗口启动时「画面识字」那一行：显示不可用就按提示装识别语言包；如果是旧版代理（没有这一行），关掉窗口重新双击 `启动.bat`。改了扩展代码后，还要在 `chrome://extensions` 里点扩展的刷新按钮，再刷新 B 站页面。

**麦克风不能用**：Chrome 的语音识别要连 Google 的服务器，访问不了 Google 时会提示「语音识别服务连不上」，那就打字。第一次使用还要允许网页使用麦克风。也可以在设置页把语音关掉。

**为什么扩展要「读取和更改所有网站上的数据」权限**：直接从视频取帧失败时，会退回 `captureVisibleTab` 整页截图，这个接口需要这个权限。扩展实际只在 `www.bilibili.com` 上运行；不想发画面可以在设置页关掉「附带暂停那一帧画面」。

**B 站改版后按钮不出现 / 抓不到字幕**：字幕是按 class 名里含 `subtitle` 的节点抓的，播放器是找页面里最大的 `<video>`。改版后可能要调整 `extension/content.js` 里的 `readSubtitle` / `findVideo`。

## 实现说明（与规格对应）

- **Call 1 只在第一次追问时跑**：点按钮那一次直接按 `in_video` 走 Call 2；第一次追问时代理先跑 Call 1 再接 Call 3，之后沿用这次的路由。判成 `off_topic` 的那一句只给一句引导，不沿用，下一句重新判断。
- **Call 1 失败兜底**：模型不支持 JSON 模式会自动去掉 `response_format` 重试；返回的不是合法 JSON 时，用 2-gram 规则判断（问题和字幕重合 ≥2 个二字词 → `in_video`，否则 `related_general`）。
- **Call 2 超长**：超过 120 字 → temperature 0.2 + `call2_retry_suffix.md` 重试一次，更短才采用；仍超长就照常显示，并在日志里记 `length_violation`。
- **语音「首个 partial ≥4 字」的理解**：开启 interim 结果，识别出 ≥4 个字后静音 0.7 秒自动发送（拿到 final 结果后 0.25 秒）。不足 4 字不发，避免「嗯」「那个」误触发。
- **过往求助（past）**：每个视频最近 10 条存在 `chrome.storage`，每次带最近 3 条给 Call 2；设置页可以清空。
- **取帧**：优先把 `<video>` 当前帧画到 canvas（最大宽 1280，JPEG 0.85），不含弹幕、控制条和扩展自己的浮层；画布被跨域污染取不到时，退回整页截图：先把浮层藏起来，只裁视频区域，最大宽 960。
- **画面文字不改提示词**：本地识别出的文字拼在发给模型的**用户消息**末尾，`prompts/` 里规格原文一字不动。

## 开发自测（不需要真 Key，也不需要打开 B 站）

```bash
node dev/mock-upstream.js 9901
```

再准备一份测试配置（`baseUrl` 填 `http://127.0.0.1:9901/v1`，`apiKey` 随便填，`model` / `visionModel` 随便起名），然后启动代理：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File proxy\server.ps1 -ConfigPath C:\path\to\test-config.json
```

```bash
python -m http.server 8790 --bind 127.0.0.1
```

浏览器打开 `http://localhost:8790/dev/test-page.html`：这是一个模拟的课程播放页，直接加载 `extension/content.js`，用一个小 shim 代替 `chrome.*` 接口。点「播放」→ 暂停 → 点按钮或按 `1`；勾选「关闭字幕」可以测降级路径，勾选「字幕烧进画面」（或地址加 `?burn=1`）可以测硬字幕识别；地址加 `?proxy=http://localhost:8788` 可以连另一个端口上的代理。模拟上游能触发的特殊情况写在 `dev/mock-upstream.js` 开头的注释里（超长重试、不支持 JSON 模式、视觉失败、路由返回乱码、离题等）。
