// 哄着学 Coaxly · 画面识字（macOS）
// 用 macOS 自带的 Vision 框架做本地文字识别：不联网、不花钱、中文开箱即用。
// 等价于 Windows 版的 Windows.Media.Ocr。
//
// 用法：
//   lb-ocr --check        检查可用性（不识别图片），输出 {"ok":true,"langs":["zh-Hans",...]}
//   lb-ocr <图片路径>      识别图片，输出：
//     {"ok":true,"width":W,"height":H,"lines":[{"text":"…","x":..,"y":..,"w":..,"h":..}]}
//   坐标是像素、左上角原点（已从 Vision 的归一化左下原点换算）；行按从上到下排序。
//   乱码行过滤、字幕带切分在代理的 Python 里做（与 Windows 版一致）。
//   出错输出 {"ok":false,"code":"…","error":"…"}，退出码 1。

import Foundation
import Vision
import AppKit

func output(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    }
}

func fail(_ code: String, _ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    output(["ok": false, "code": code, "error": message])
    exit(1)
}

let args = CommandLine.arguments.dropFirst()

if args.first == "--check" {
    let req = VNRecognizeTextRequest()
    var langs: [String] = []
    if #available(macOS 13.0, *) {
        if let supported = try? req.supportedRecognitionLanguages() {
            langs = supported
        }
    }
    let zh = langs.first { $0.hasPrefix("zh") }
    output(["ok": true, "langs": [zh ?? "zh-Hans"] + langs.filter { !$0.hasPrefix("zh") }.prefix(3), "all": langs.count])
    exit(0)
}

guard let path = args.first else {
    fail("bad_args", "用法：lb-ocr <图片路径> 或 lb-ocr --check")
}

let url = URL(fileURLWithPath: path)
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    fail("bad_image", "图片解不开（格式不支持或数据损坏）")
}

let width = cg.width
let height = cg.height

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
if #available(macOS 13.0, *) {
    request.recognitionLanguages = ["zh-Hans", "en-US"]
} else {
    request.recognitionLanguages = ["zh-Hans", "en-US"]
}

let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("ocr_failed", "文字识别失败：\(error.localizedDescription)")
}

var lines: [[String: Any]] = []
for obs in (request.results ?? []) {
    guard let text = obs.topCandidates(1).first?.string else { continue }
    let bb = obs.boundingBox  // 归一化坐标，原点在左下
    let x = bb.origin.x * Double(width)
    let y = (1.0 - bb.origin.y - bb.height) * Double(height)
    let w = bb.width * Double(width)
    let h = bb.height * Double(height)
    lines.append(["text": text, "x": x, "y": y, "w": w, "h": h])
}
lines.sort { ($0["y"] as! Double) < ($1["y"] as! Double) }

output(["ok": true, "width": width, "height": height, "lines": lines])
exit(0)
