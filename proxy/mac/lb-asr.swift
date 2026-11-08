// 哄着学 Coaxly · 语音识别（macOS）
// 本机中文识别，等价于 Windows 版的 System.Speech 离线识别。
//
// macOS 26+：用新的 SpeechTranscriber（SpeechAnalyzer 架构）：完全设备端离线，不需要任何授权弹窗。
// macOS 13–25：退回旧的 SFSpeechRecognizer（需要一次「语音识别」授权；从纯后台进程调用时不可用，
//              请用 启动.command 从「终端」启动代理，这样授权提示能正常弹出）。
//
// 用法：
//   lb-asr --check        检查可用性，输出 {"ok":true,"locale":"zh-CN","onDevice":true,"auth":"authorized"}
//   lb-asr <音频.wav>      识别 WAV（16kHz 单声道），输出 {"ok":true,"text":"…"}
//   出错输出 {"ok":false,"code":"…","error":"…"}，退出码 1。

import Foundation
import Speech
import AVFAudio

func output(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    }
    fflush(stdout)
}

func fail(_ code: String, _ message: String) -> Never {
    output(["ok": false, "code": code, "error": message])
    exit(1)
}

let args = Array(CommandLine.arguments.dropFirst())

// ---------------------------------------------------------------- macOS 26：SpeechTranscriber（免授权、设备端）
if #available(macOS 26, *) {
    let locale = Locale(identifier: "zh-CN")

    if args.first == "--check" {
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        var supported = false
        Task {
            if await SpeechTranscriber.isAvailable {
                if let loc = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
                    supported = true
                    _ = loc
                }
            }
            ok = supported
            sem.signal()
        }
        sem.wait()
        if ok {
            output(["ok": true, "locale": locale.identifier, "onDevice": true, "auth": "authorized", "engine": "speech-transcriber"])
        } else {
            output(["ok": false, "locale": locale.identifier,
                    "error": "SpeechTranscriber 不可用或未安装中文语音资源（系统设置 → 键盘 → 听写，或等待系统自动下载）"])
        }
        exit(ok ? 0 : 1)
    }

    guard let path = args.first else {
        fail("bad_args", "用法：lb-asr <音频.wav> 或 lb-asr --check")
    }

    let sem = DispatchSemaphore(value: 0)
    var resultText: String? = nil
    var errorMessage: String? = nil
    Task {
        do {
            let transcriber = try SpeechTranscriber(locale: locale, preset: .transcription)
            let audioFile = try AVAudioFile(forReading: URL(fileURLWithPath: path))
            let analyzer = try await SpeechAnalyzer(modules: [transcriber])
            try await analyzer.start(inputAudioFile: audioFile, finishAfterFile: true)
            var parts: [String] = []
            for try await r in transcriber.results {
                parts.append(String(r.text.characters))
            }
            resultText = parts.joined()
        } catch {
            errorMessage = error.localizedDescription
        }
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 120)
    if let text = resultText, !text.isEmpty {
        output(["ok": true, "text": text])
        exit(0)
    }
    fail("asr_failed", errorMessage ?? "语音识别超时或没有识别到内容（120 秒）")
}

// ---------------------------------------------------------------- macOS 13–25：SFSpeechRecognizer（要授权）
var recognizer: SFSpeechRecognizer? = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN"))
if recognizer == nil { recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-Hans")) }
guard let rec = recognizer else {
    fail("asr_unavailable", "系统里没有中文语音识别引擎（可在 设置 → 键盘 → 听写 里启用听写功能后重试）")
}

if args.first == "--check" {
    let status = SFSpeechRecognizer.authorizationStatus()
    let ok = (status == .authorized || status == .notDetermined)
    var obj: [String: Any] = ["ok": ok, "locale": rec.locale.identifier,
                              "onDevice": rec.supportsOnDeviceRecognition,
                              "auth": status == .authorized ? "authorized" :
                                      status == .notDetermined ? "not_determined" : "denied"]
    if !ok { obj["error"] = "语音识别授权被拒绝（系统设置 → 隐私与安全性 → 语音识别）" }
    output(obj)
    exit(ok ? 0 : 1)
}

guard let path = args.first else {
    fail("bad_args", "用法：lb-asr <音频.wav> 或 lb-asr --check")
}

switch SFSpeechRecognizer.authorizationStatus() {
case .authorized:
    break
case .notDetermined:
    // 只在有 GUI 上下文（比如从「终端」启动）时才请求授权，避免后台进程直接崩溃
    let sem = DispatchSemaphore(value: 0)
    SFSpeechRecognizer.requestAuthorization { _ in sem.signal() }
    _ = sem.wait(timeout: .now() + 60)
    if SFSpeechRecognizer.authorizationStatus() != .authorized {
        fail("asr_denied", "语音识别授权被拒绝或超时（系统设置 → 隐私与安全性 → 语音识别）")
    }
default:
    fail("asr_denied", "语音识别不可用：授权状态为拒绝/受限（系统设置 → 隐私与安全性 → 语音识别）")
}

let request = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path))
request.shouldReportPartialResults = false
if rec.supportsOnDeviceRecognition {
    request.requiresOnDeviceRecognition = true
}

var resultText: String? = nil
var finished = false
let task = rec.recognitionTask(with: request) { result, error in
    if let r = result, r.isFinal {
        resultText = r.bestTranscription.formattedString
    }
    if error != nil || (result?.isFinal ?? false) {
        finished = true
    }
}
let deadline = Date().addingTimeInterval(90)
while !finished && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2))
}
task.cancel()
if let text = resultText, !text.isEmpty {
    output(["ok": true, "text": text])
    exit(0)
}
fail("asr_failed", "语音识别失败或没有识别到内容")
