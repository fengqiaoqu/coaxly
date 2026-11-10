# macOS 安装与使用

macOS 使用 `proxy/server.py` 运行本地代理。Python 部分只使用标准库；本地画面识字和语音识别通过 Swift 工具调用系统的 Vision / Speech 框架。

## 环境

- 可运行的 Python 3：先执行 `python3 --version` 检查，系统未提供时需自行安装。
- Chrome 或 Edge，用于加载 `extension` 文件夹。
- Xcode Command Line Tools：编译本地 OCR 和语音工具时需要。可用 `xcode-select -p` 检查，未安装时运行 `xcode-select --install`。

缺少本地识别工具时，代理仍可处理字幕和文字提问。

## 配置与启动

在项目根目录的终端中操作。首次使用时复制配置；已有配置则保留：

```bash
if [ ! -f proxy/config.json ]; then
  cp proxy/config.example.json proxy/config.json
fi
```

编辑 `proxy/config.json`，填写模型服务的 `apiKey`，并核对 `baseUrl`、`model` 和 `visionModel`。字段说明见 [INSTALL.md](INSTALL.md)。

编译本地识别工具：

```bash
bash proxy/build-mac.sh
```

启动代理：

```bash
python3 proxy/server.py
```

也可运行 `bash 启动.command`；该脚本会在识别工具缺失时尝试编译，然后启动代理。保持终端窗口打开。

在另一个终端中检查连接：

```bash
curl http://localhost:8787/health
```

## 加载扩展

Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`。开启「开发者模式」，选择「加载已解压的扩展程序」，加载本仓库的 `extension` 文件夹。

打开扩展设置页，确认代理地址为 `http://localhost:8787`，点击「测试连接」。随后打开 B 站课程、开启字幕并暂停，点击「我这里不懂」或按 `1`。

扩展包含 Safari 的 `browser.*` 兼容层。Safari 需要按所用系统和 Xcode 版本完成 Web Extension 转换、加载与权限配置；具体流程及本地识别能力需要在目标 Mac 上验证。

## 平台差异

| 组件 | Windows | macOS |
|---|---|---|
| 本地代理 | `proxy/server.ps1` | `proxy/server.py` |
| 画面识字 | Windows OCR | Vision，工具为 `proxy/mac/lb-ocr` |
| 本地语音识别 | System.Speech | Speech，工具为 `proxy/mac/lb-asr` |
| 启动入口 | `启动.bat` | `启动.command` |

两个平台使用相同的配置结构和模型请求模板。编译出的 macOS 工具不纳入 Git；更换设备后需重新编译。

本地识别是否可用取决于系统版本、语言资源和权限，以 `/health` 返回及启动日志为准。首次使用麦克风或语音识别时，按系统和浏览器提示授予权限。选择云端语音识别会发送录音，其他数据发送与存储范围见 [README.md](README.md)。

## 排障

| 现象 | 检查方式 |
|---|---|
| 找不到 `python3` | 安装 Python 3，并在新终端中再次检查版本 |
| 本地识别工具编译失败 | 检查 Command Line Tools，重新运行 `bash proxy/build-mac.sh` 并查看错误 |
| 扩展连不上代理 | 确认进程仍在运行；检查 `/health`；核对扩展地址和配置端口 |
| 麦克风或语音识别不可用 | 检查浏览器权限和系统隐私设置；也可继续文字追问 |
| 修改端口后连不上 | 重启代理，并同步修改扩展设置中的代理地址 |

开发用模拟服务和测试页面见 [README.md](README.md)「本地开发」。模拟流程不能替代目标 Mac 上的系统能力和真实课程验证。
