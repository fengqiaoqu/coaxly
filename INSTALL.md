# 安装指南（写给 AI Agent）

> 读者是替用户安装本项目的 AI Agent（Claude Code、Codex 等）。按顺序执行，每一步都有**验证方法**，验证通过再往下走。
> 给人看的使用说明在 [README.md](README.md)。

## 0. 先搞清楚要装什么

本项目由两部分组成，**两部分都要装好才能用**：

| 组件 | 位置 | 运行方式 | 谁来做 |
|---|---|---|---|
| 本地代理 | `proxy/server.ps1` | Windows PowerShell 5.1 常驻进程，监听 `http://localhost:8787` | Agent 可以全自动完成 |
| Chrome 扩展（MV3） | `extension/` | 在 Chrome 里「加载已解压的扩展程序」 | **必须由用户手动操作**，Agent 只能给出步骤 |

另外有一项 Agent **不能代填**的东西：上游大模型的 **API Key**（见第 3 步）。

没有任何需要安装的依赖：代理只用 Windows 自带的 PowerShell 5.1，不需要 Node、Python、npm、pip。（Node / Python 只在第 8 节「开发自测」里用到。）

## 1. 环境检查

| 要求 | 检查命令（PowerShell） | 期望结果 |
|---|---|---|
| Windows 10/11 | `[Environment]::OSVersion.Platform` | `Win32NT` |
| Windows PowerShell 5.1 | `powershell.exe -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'` | `5.1.x` |
| Chrome / Edge（Chromium 内核） | 问用户 | 用户在用 |
| 端口 8787 空闲 | `Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue` | 无输出。有输出先看第 9 节第一行：很可能代理已经在跑（代理用 `HttpListener`，端口的所属进程显示为 `System`/PID 4，看 PID 判断不出是谁，要用 `/health` 判断） |

**必须用 `powershell.exe`（5.1）启动代理，不要用 `pwsh`（PowerShell 7）。** 7 也能跑起来，但「画面识字」（`Windows.Media.Ocr`）和「本机语音识别」（`System.Speech`）在 7 下不可用，`/health` 里会显示 `ocrReady: false` / `asrReady: false`。

非 Windows 系统：**macOS 已支持**——用 `python3 proxy/server.py`（或双击 `启动.command`）代替第 4 步的 PowerShell，OCR / 语音识别用系统自带框架，详见 [README-macOS.md](README-macOS.md)；其余平台仍不支持。

## 2. 获取代码

如果当前目录已经是本仓库（存在 `proxy/server.ps1` 和 `extension/manifest.json`），跳过这步。否则：

```bash
git clone https://github.com/fengqiaoqu/learn-buddy.git
cd learn-buddy
```

**验证**：

```powershell
Test-Path proxy\server.ps1, extension\manifest.json, prompts\call2_explain.md
```

三个都是 `True`。

## 3. 配置 API Key

`proxy/config.json` 被 `.gitignore` 忽略，新克隆的仓库里没有。生成方式二选一：

- 什么都不做：代理第一次启动时会自动把 `proxy/config.example.json` 复制成 `proxy/config.json`；
- 或者现在手动复制：`Copy-Item proxy\config.example.json proxy\config.json`（**已存在就不要覆盖**，里面可能已有用户的 Key）。

然后需要填 `apiKey`。**Agent 不能编造 Key，也不要去别处找 Key。** 做法：

1. 问用户用哪家服务商、Key 是什么；或者请用户自己打开 `proxy/config.json` 填 `apiKey` 后告诉你。
2. 用户在对话里直接给了 Key 时，可以替他写进 `proxy/config.json` 的 `apiKey` 字段；写完不要在回复里复述 Key。
3. 用户暂时没有 Key：可以先跳过，代理照样能启动，`/health` 会显示 `hasKey: false`，扩展会提示「还没配置 API Key」。之后填上**保存即生效，不用重启代理**。

默认是阿里云百炼（通义千问）。换服务商只改 `baseUrl` / `model` / `visionModel`，对照表：

| 服务商 | baseUrl | model | visionModel |
|---|---|---|---|
| 阿里云百炼（默认） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | `qwen-vl-plus` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | 无；同时把 `sendImage` 设为 `false` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` | `glm-4v-flash` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | `gpt-4o-mini` |

其他字段（`ocr`、`httpProxy`、`timeoutSec`、`port`、`asr`）保持默认即可，含义见 `proxy/config.example.json` 里的 `_说明` 和 README「换模型」一节。用户在国内访问 OpenAI 需要代理时才填 `httpProxy`（如 `http://127.0.0.1:7890`）。

**编辑 `config.json` 的注意事项**：

- 必须保持合法 JSON（否则代理报「config.json 不是合法 JSON」）。
- 用 UTF-8 编码写入。不要用 Windows PowerShell 5.1 的 `Out-File` / `>` 重定向写这个文件（默认 UTF-16）；用编辑工具直接改，或 `[IO.File]::WriteAllText(路径, 内容, (New-Object Text.UTF8Encoding $false))`。
- **永远不要提交 `proxy/config.json`**（里面有 Key）。它已在 `.gitignore` 里，不要改 `.gitignore`、不要 `git add -f`。

## 4. 启动本地代理

代理是**常驻进程**，前台运行会一直阻塞。

**推荐（给用户留一个可见窗口）**：让用户双击项目根目录的 `启动.bat`，或者由 Agent 弹出一个新窗口：

```powershell
Start-Process -FilePath "$PWD\启动.bat" -WorkingDirectory "$PWD"
```

**Agent 自己在后台跑**（用 Agent 工具的后台运行功能，不要前台阻塞）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File proxy\server.ps1
```

正常启动时输出类似：

```
  学习搭子 v1.4.0 · 本地代理已启动
  地址      http://localhost:8787
  模型      qwen-plus   视觉模型 qwen-vl-plus
  上游      https://dashscope.aliyuncs.com/compatible-mode/v1
  API Key   已配置
  画面识字  可用（Windows 本地识别，语言 zh-Hans-CN）
  语音识别  可用（Windows 本机离线识别，语言 zh-CN）
  ...
```

注意：用户关闭这个窗口 = 代理停止，扩展就会提示「连不上本地代理」。要告诉用户**这个窗口要一直开着**，以后每次使用前都要先双击 `启动.bat`。

## 5. 验证代理

```powershell
Invoke-RestMethod http://localhost:8787/health | ConvertTo-Json
```

或：

```bash
curl -s http://localhost:8787/health
```

逐项检查返回的 JSON：

| 字段 | 期望 | 不符合时 |
|---|---|---|
| `ok` | `true` | 请求失败 → 代理没起来，看启动窗口的报错 |
| `name` | `learn-buddy-proxy` | 端口被别的程序占了，见第 9 节 |
| `version` | `1.4.0`，与 `extension/manifest.json` 的 `version` 一致 | 用户开着旧版代理窗口：关掉重开 |
| `features` | 包含 `keypoints`、`memory` | 同上：旧版代理没有课程重点 / 整片记忆接口 |
| `hasKey` | `true` | 回到第 3 步；不影响启动 |
| `prompts` | 包含 `call1_router.md` … `call5_keypoints.md`、`memory_map.md`、`memory_reduce.md` 共 11 个文件 | `prompts/` 目录缺文件，重新 `git checkout -- prompts` |
| `ocrReady` | `true` | 看 `ocrError`；可选功能，见第 9 节 |
| `asrReady` | `true` | 看 `asrError`；可选功能，见第 9 节 |

`ok`、`name`、`version`、`prompts` 必须通过；`hasKey`、`ocrReady`、`asrReady` 不通过时把原因告诉用户，不阻塞安装。

**可选：真实调用一次上游**（仅在 `hasKey: true` 时做，会消耗用户少量额度，先征得用户同意）：

```powershell
$body = @{ subject = '线性代数'; question = '这里没听懂'; transcript = '如果一组向量中没有任何一个能由其余向量线性表示，就称它们线性无关。'; timestamp = '01:00' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:8787/explain -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
```

返回里 `seg_count` 为 3、`chars` 大于 0、`degraded` 为 `false`，即说明 Key 和模型都可用；返回 401 / 鉴权错误 → Key 填错；超时 → 检查网络或 `httpProxy`。

返回的中文在 Windows PowerShell 5.1 控制台（尤其经 bash 管道转出时）可能显示成乱码，这只是控制台编码问题，不是代理出错，以上面几个数字字段为准。PowerShell 7 下显示正常。

## 6. 安装 Chrome 扩展（必须由用户操作）

Chrome 不允许程序静默安装未上架的扩展，Agent 不要尝试改注册表、改 Chrome 配置文件或用命令行参数加载扩展。把下面的步骤原样交给用户，并给出 `extension` 文件夹的**绝对路径**（用 `(Resolve-Path extension).Path` 取得）：

1. Chrome 地址栏打开 `chrome://extensions`（Edge 是 `edge://extensions`）。
2. 打开右上角「开发者模式」。
3. 点「加载已解压的扩展程序」，选择 `<项目绝对路径>\extension` 文件夹。
4. 列表里出现「学习搭子 · B站视频即时解释」，版本 `1.4.0`。
5. 点浏览器工具栏上的扩展图标（可能在拼图图标里）→ 打开设置页 → 点「测试连接」，显示「已连上代理 · 模型 …」即成功。

如果用户之前装过旧版：在 `chrome://extensions` 里点这个扩展的**刷新**按钮，然后刷新已打开的 B 站页面。

扩展默认连 `http://localhost:8787`。如果改过 `config.json` 的 `port`，要让用户在扩展设置页把「代理地址」改成同一个端口。

## 7. 交给用户之前的检查清单

全部满足才算安装完成：

- [ ] `/health` 返回 `ok: true`、`version: "1.4.0"`、`features` 含 `keypoints`、`memory`
- [ ] `hasKey: true`（或已明确告诉用户还需要填 Key、在哪填）
- [ ] 用户确认扩展已加载，设置页「测试连接」成功
- [ ] 已告诉用户：每次使用前先双击 `启动.bat`，窗口保持打开
- [ ] 已告诉用户使用方法：打开 B 站课程视频 → 打开字幕 → 暂停 → 点「我这里不懂」或按 `1`；第一次点麦克风时允许麦克风权限
- [ ] `ocrReady` / `asrReady` 为 `false` 时，已把原因和修复方法告诉用户
- [ ] `git status` 里没有 `proxy/config.json`（确认没被意外加入版本控制）

## 8. 开发自测（不需要真 Key，不需要打开 B 站）

只有用户要求「测试 / 开发 / 改代码」时才需要。需要 Node 和 Python。三个进程都是常驻的，都要后台运行：

```bash
node dev/mock-upstream.js 9901
```

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File proxy\server.ps1 -ConfigPath dev\mock-config.json -LogPath data\dev-calls.jsonl
```

```bash
python -m http.server 8790 --bind 127.0.0.1
```

- 模拟上游在 9901，测试代理在 **8788**（不和正式代理的 8787 冲突），日志写到 `data/dev-calls.jsonl`，不混进正式日志。
- 验证：`curl -s http://localhost:8788/health` 的 `model` 是 `mock-chat`。
- 模拟播放页：`http://localhost:8790/dev/test-page.html?proxy=http://localhost:8788`，点「播放」→ 暂停 → 按 `1`。地址参数见 README「开发自测」一节和 `dev/test-page.html` 开头的注释。
- 设置页自测：`http://localhost:8790/dev/options-page.html?seed=1`。
- 用 Claude Code 桌面版时，`.claude/launch.json` 里已有 `mock-upstream` / `proxy-dev` / `harness` 三个启动项，可直接用。

## 9. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动报「无法监听端口 8787」 | 已经开着一个代理窗口，或端口被别的程序占用 | 先 `Invoke-RestMethod http://localhost:8787/health`：`name` 是 `learn-buddy-proxy` 说明代理已在跑，不用再启动（版本不对就让用户关掉旧窗口重开）；是别的程序就把 `config.json` 的 `port` 改成别的值，并让用户同步改扩展设置页的代理地址 |
| 启动报 `HttpListener` 拒绝访问 | 极少见，`localhost` 前缀需要权限 | 代理会自动退回只监听 `localhost`；仍失败就换一个端口 |
| 运行脚本被执行策略拦截 | 系统禁止运行 `.ps1` | 命令里已带 `-ExecutionPolicy Bypass`（只对这次进程生效）。**不要**改系统级执行策略 |
| 「config.json 不是合法 JSON」 | 手改时引号、逗号写错 | 修好 JSON；实在改坏了，备份后从 `config.example.json` 重新复制，再把用户的 Key 填回去 |
| `/health` 里 `hasKey: false` | `apiKey` 为空 | 第 3 步 |
| 调用返回 401 | Key 错，或 Key 与 `baseUrl` 不是同一家 | 核对服务商和 Key |
| `ocrReady: false` | 用 `pwsh` 启动的，或系统没装中文 OCR 语言包 | 改用 `powershell.exe` / `启动.bat`；否则让用户：设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 安装「光学字符识别」。可选功能，不装也能用 |
| `asrReady: false` | 用 `pwsh` 启动的，或系统没装中文语音识别 | 同上，安装「语音识别」。不装只是不能语音追问，打字追问正常 |
| 扩展提示「连不上本地代理」 | 代理窗口被关了，或端口不一致 | 重新启动代理；核对扩展设置页的代理地址 |
| 扩展提示「本地代理还是旧版本」 | 代码更新后没重启代理 | 关掉代理窗口，重新双击 `启动.bat` |

## 10. Agent 不要做的事

- 不要编造、搜索或复用别处的 API Key；不要把 Key 写进 `extension/` 下的任何文件（设计上扩展永远拿不到 Key）。
- 不要提交 `proxy/config.json`、`data/` 下的日志。
- 不要改 `prompts/*.md`（它们是规格原文，代理每次请求实时读取）和 `提示词工程规格.md`（只读）。
- 不要修改系统设置（执行策略、防火墙、注册表、Chrome 策略）。语言包需要用户自己在 Windows 设置里装。
- 如果要编辑 `proxy/server.ps1`：它是 **UTF-8 带 BOM** 编码，保存时必须保留 BOM，否则 Windows PowerShell 5.1 会把中文读成乱码导致脚本报错。
- 安装过程只需要启动代理，不需要也不应该改任何源代码。
