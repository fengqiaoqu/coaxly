<p align="center"><img src="assets/logo.png" width="168" alt="Coaxly 哄着学"></p>

# Coaxly 哄着学

Coaxly 是一个 B 站课程学习扩展：暂停视频后，结合字幕和当前画面解释这一段内容，并支持继续追问。

当前版本：**1.4.1**。浏览器扩展负责页面交互，本地代理负责模型调用、画面识字和语音识别。

## 功能

- **暂停解释**：暂停后点击「我这里不懂」或按 `1`，在侧栏查看解释、例子和确认问题。
- **文字与语音追问**：继续提问，也可切换「直说」和「带我想」两种回答方式。
- **课程重点**：根据字幕标注定义、结论、方法和易错点，点击标记跳回对应位置。
- **学习历史**：保存求助位置和对话，之后可回到该位置继续追问。
- **整片字幕上下文**：将字幕整理为章节摘要，结合暂停点附近的原文生成解释；没有完整字幕时使用已播放部分。

## 安装与使用

Windows 使用 Windows PowerShell 5.1 和 Chrome / Edge。macOS 使用 Python 3；本地画面识字和语音识别还需要编译 Swift 工具，见 [macOS 说明](README-macOS.md)。

1. 获取代码：

   ```bash
   git clone https://github.com/fengqiaoqu/coaxly.git
   cd coaxly
   ```

2. 将 `proxy/config.example.json` 复制为 `proxy/config.json`，填写模型服务的 `apiKey`，并核对 `baseUrl`、`model` 和 `visionModel`。已有配置时不要覆盖。
3. Windows 双击 `启动.bat`；macOS 运行 `bash 启动.command`。代理运行期间保持终端窗口打开，默认地址为 `http://localhost:8787`。
4. 在浏览器的扩展管理页打开「开发者模式」，选择「加载已解压的扩展程序」，加载本仓库的 `extension` 文件夹。
5. 打开扩展设置页，点击「测试连接」。随后打开 B 站课程、开启字幕，暂停并点击「我这里不懂」。首次使用语音时需允许麦克风权限。

详细安装、配置和排障步骤见 [INSTALL.md](INSTALL.md)。更新代码后，重启代理、重新加载扩展并刷新视频页。

## 数据与模型服务

API Key 保存在本机的 `proxy/config.json`，由代理向所配置的模型服务发起请求，浏览器扩展不读取 Key。实际模型调用可能产生服务商费用。

生成解释、课程重点和章节摘要时，相关字幕、提问及对话上下文会发送到模型服务。`sendImage` 开启且模型支持图像时，还会发送当前视频画面。画面 OCR 在本机执行；语音默认使用本机识别，选择云端识别时会上传录音，选择浏览器识别时由浏览器的识别服务处理。

学习历史和重点标注保存在浏览器本地存储中；章节缓存和调用日志写入 `data/`。日志可能包含字幕片段、提问、回答和识别文本。`proxy/config.json` 与 `data/` 均不纳入 Git。

## 目录

```text
extension/                 浏览器扩展
proxy/server.ps1           Windows 本地代理
proxy/server.py            macOS 本地代理
proxy/mac/                 macOS OCR / 语音工具源码
proxy/config.example.json  配置示例
prompts/                   代理运行所需的模型请求模板
dev/                       模拟服务、测试页面和样例数据
assets/                    项目标识
```

## 本地开发

`dev/` 提供模拟模型服务和播放器，可检查请求流程，无需真实 API Key。分别在项目根目录的三个终端中启动：

```bash
python dev/mock-upstream.py 9901
```

Windows 代理：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File proxy/server.ps1 -ConfigPath dev/mock-config.json -Port 8788 -LogPath data/dev-calls.jsonl
```

macOS 代理：

```bash
python3 proxy/server.py --config dev/mock-config.json --port 8788 --log data/dev-calls.jsonl
```

静态页面服务：

```bash
python -m http.server 8790 --bind 127.0.0.1
```

macOS 的 Python 命令使用 `python3`。打开 `http://localhost:8790/dev/test-page.html?proxy=http://localhost:8788`；追加 `&full=1` 可使用整片字幕样例。设置页测试入口为 `http://localhost:8790/dev/options-page.html`。模拟服务用于检查流程，不能验证真实模型的解释质量。

## 限制

字幕缺失、识字错误和模型输出错误都会影响解释。公式、板书和复杂图形的识别可能不完整，关键结论应与课程材料核对。完整字幕能否读取取决于视频资源和 B 站登录状态；播放器改版也可能影响扩展。

macOS 的 Safari 兼容方式与本地识别前提见 [README-macOS.md](README-macOS.md)。版本变化见 [CHANGELOG.md](CHANGELOG.md)。
