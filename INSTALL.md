# 安装与配置

Coaxly 需要同时运行浏览器扩展和本地代理。Windows 使用 PowerShell 代理；macOS 使用 Python 代理，平台步骤见 [README-macOS.md](README-macOS.md)。

## Windows

前提：Windows 10/11、Windows PowerShell 5.1、Chrome 或 Edge。代理无需安装 npm / pip 依赖；本地 OCR 和语音识别依赖系统语言组件。

### 1. 获取代码

```bash
git clone https://github.com/fengqiaoqu/coaxly.git
cd coaxly
```

也可下载仓库 ZIP 并解压到固定目录。

### 2. 创建配置

首次使用时，将 `proxy/config.example.json` 复制为 `proxy/config.json`。在项目根目录的 PowerShell 中执行：

```powershell
if (-not (Test-Path -LiteralPath proxy/config.json)) {
    Copy-Item -LiteralPath proxy/config.example.json -Destination proxy/config.json
}
```

用文本编辑器打开 `proxy/config.json`，按所用模型服务填写：

| 字段 | 含义 |
|---|---|
| `baseUrl` | OpenAI 兼容接口地址，代理会在其后追加 `/chat/completions` |
| `apiKey` | 对应服务的 API Key |
| `model` | 文本模型名称 |
| `visionModel` | 图像模型名称；不使用图像时将 `sendImage` 设为 `false` |
| `port` | 本地代理端口，默认 `8787` |
| `httpProxy` | 访问模型服务时使用的 HTTP 代理，未使用则留空 |
| `asr.engine` | 语音识别方式：`local`、`cloud` 或 `off` |

接口地址和模型名称以服务商文档为准。配置文件需为 UTF-8 编码的合法 JSON。API Key 和模型设置保存后生效；更换端口需重启代理，并同步修改扩展设置中的代理地址。

`proxy/config.json` 包含凭据，已由 `.gitignore` 排除。实际模型调用按服务商规则计费；只检查本地连接时无需发起模型请求。

### 3. 启动代理

双击 `启动.bat`，或在项目根目录的 PowerShell 中执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File proxy/server.ps1
```

保持该窗口打开。Windows 本地 OCR 和语音识别使用 PowerShell 5.1，请使用 `powershell.exe` 启动。

另开一个 PowerShell 窗口检查：

```powershell
Invoke-RestMethod http://localhost:8787/health
```

返回应包含代理版本和功能状态。`hasKey: false` 表示尚未填写 Key；本地连接可正常检查，模型解释仍需配置 Key。

### 4. 加载扩展

1. Chrome 打开 `chrome://extensions`；Edge 打开 `edge://extensions`。
2. 打开「开发者模式」，选择「加载已解压的扩展程序」。
3. 选择本仓库的 `extension` 文件夹。
4. 打开扩展设置页，确认代理地址为 `http://localhost:8787`，点击「测试连接」。

### 5. 使用

打开 B 站课程并开启字幕。暂停后点击「我这里不懂」或按 `1`，在侧栏查看解释和继续追问。语音追问需允许页面使用麦克风；没有可用本地识别组件时可继续文字输入。

## 更新

更新代码后，依次重启本地代理、在扩展管理页重新加载扩展、刷新已打开的视频页。保留原有 `proxy/config.json`，不要用示例覆盖。

## 常见问题

| 现象 | 检查方式 |
|---|---|
| 连不上本地代理 | 确认启动窗口仍在运行；检查 `/health`；核对扩展地址与配置端口 |
| 提示未配置 Key / 401 | 检查 `proxy/config.json` 的 `apiKey`、服务地址和账户权限 |
| 端口被占用 | 先检查该端口的 `/health`，确认是否已有代理；或更换端口并更新扩展地址 |
| 没有可用字幕 | 开启播放器字幕；需要时登录 B 站；没有字幕的视频只能依赖画面识别 |
| 语音识别不可用 | 确认使用 PowerShell 5.1；检查系统中文语音组件和浏览器麦克风权限 |
| 画面识字不可用 | 检查系统 OCR 语言组件；识别复杂公式或板书时可改用文字提问 |
| 更新后界面或功能未变化 | 重启代理、重新加载扩展，再刷新视频页 |

模型解释会把相关内容发送到配置的服务。数据存储和发送范围见 [README.md](README.md)。不使用真实 Key 的开发验证方式也见 README「本地开发」。
