<#
  哄着学 Coaxly · 本地代理（Windows PowerShell 5.1 / PowerShell 7 均可运行）

  - 监听 http://localhost:<port>/（默认 8787）
  - 每次请求都实时读取 ../prompts/*.md，注入占位符后调用 OpenAI 兼容的 /chat/completions
  - 每次调用追加一行到 ../data/calls.jsonl
  - API Key 只存在 proxy/config.json，扩展永远不接触 Key

  端点：
    GET  /health    连通性与配置检查
    POST /explain   Call 2 即时解释（非流式；超 120 字降温重试；视觉失败回落纯文本；无字幕走降级 prompt）
    POST /route     Call 1 上下文路由（JSON 模式，失败走 2-gram 规则兜底）
    POST /followup  Call 3 追问续接（SSE 流式；首轮追问时先在内部跑 Call 1）
    POST /log       客户端事件（例如关闭抽屉 → user_closed_without_followup）
    POST /ocr       画面识字（本地 Windows OCR）
    POST /asr       语音识别（v1.2：默认 Windows 本机离线识别，可选云端 /audio/transcriptions）
    POST /summarize Call 4：历史节点的一句话说明（v1.2）
    POST /keypoints Call 5：按段读字幕标注课程重点（v1.3；JSON 模式，失败走关键词规则兜底）
    POST /memory/build    整片字幕 → 后台生成分层记忆（v1.4，见 docs/v1.4-记忆分层-方案.md）
    GET  /memory/status   ?video_id= 记忆生成进度
    POST /memory/context  调试：看某个时间点实际拼进提示词的四层上下文
#>
param(
  [string]$ConfigPath = '',
  [int]$Port = 0,
  [string]$LogPath = ''   # 开发自测时把日志写到别处，不混进正式的 data/calls.jsonl
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$ProxyDir  = $PSScriptRoot
$Root      = Split-Path -Parent $ProxyDir
$PromptDir = Join-Path $Root 'prompts'
$DataDir   = Join-Path $Root 'data'
$LogFile   = Join-Path $DataDir 'calls.jsonl'
if ($LogPath) { $LogFile = $(if ([IO.Path]::IsPathRooted($LogPath)) { $LogPath } else { Join-Path $Root $LogPath }) }
if (-not $ConfigPath) { $ConfigPath = Join-Path $ProxyDir 'config.json' }
elseif (-not [IO.Path]::IsPathRooted($ConfigPath)) { $ConfigPath = Join-Path $Root $ConfigPath }

$Utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $Utf8 } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
if (-not (Test-Path $ConfigPath)) {
  $example = Join-Path $ProxyDir 'config.example.json'
  if (Test-Path $example) { Copy-Item $example $ConfigPath }
}

$VERSION = '1.4.1'

# ---------------------------------------------------------------- 文案常量
$T_UNKNOWN_SUBJECT  = '未知课程'
$T_FIRST_HELP       = '（这是本视频第一次求助）'
$T_NO_TRANSCRIPT    = '（本次没有可用字幕）'
$T_NO_HISTORY       = '（这是第一轮追问）'
$T_DEFAULT_QUESTION = '这里没听懂，帮我讲讲刚才这一段'
$T_DEFAULT_REDIRECT = '先回到视频内容吧'
$T_DEFAULT_CONCEPT  = '刚才那一段'
$T_NO_KEY           = '代理还没配置 API Key：请编辑 proxy\config.json 里的 apiKey（保存即生效，不用重启代理）。'

$ROUTES = @('in_video', 'related_general', 'off_topic')
$CALL2_LIMIT = 120

# ---------------------------------------------------------------- 配置
function Get-Config {
  $cfg = [ordered]@{
    baseUrl     = 'https://api.openai.com/v1'
    apiKey      = ''
    model       = 'gpt-4o-mini'
    visionModel = ''
    port        = 8787
    httpProxy   = ''
    timeoutSec  = 60
    sendImage   = $true
    ocr         = $true
    asr         = $null
  }
  if (Test-Path $ConfigPath) {
    $raw = [IO.File]::ReadAllText($ConfigPath, $Utf8)
    try { $obj = $raw | ConvertFrom-Json } catch { throw "config.json 不是合法 JSON：$($_.Exception.Message)" }
    foreach ($p in $obj.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
  }
  if (-not $cfg.visionModel) { $cfg.visionModel = $cfg.model }
  $engine = [string](Get-Field $cfg.asr 'engine' 'local')
  if (@('local', 'cloud', 'off') -notcontains $engine) { $engine = 'local' }
  $cfg.asrEngine = $engine
  return $cfg
}

function Test-HasKey($cfg) {
  $k = [string]$cfg.apiKey
  return ($k.Trim().Length -gt 0)
}

# ---------------------------------------------------------------- 小工具
function Limit-Text([string]$s, [int]$n) {
  if ($null -eq $s) { return '' }
  if ($s.Length -le $n) { return $s }
  return $s.Substring(0, $n) + '…'
}

function Get-Field($obj, [string]$name, $default = '') {
  if ($null -eq $obj) { return $default }
  $p = $obj.PSObject.Properties[$name]
  if ($null -eq $p -or $null -eq $p.Value) { return $default }
  return $p.Value
}

function Get-NonEmpty($obj, [string]$name, [string]$default) {
  $v = [string](Get-Field $obj $name '')
  if ($v.Trim()) { return $v.Trim() }
  return $default
}

# 字幕「正文」长度：去掉 [mm:ss] 前缀和空白后再数，避免只有时间戳也被当成有字幕
function Get-TranscriptBodyLength([string]$transcript) {
  if (-not $transcript) { return 0 }
  $t = [regex]::Replace($transcript, '\[\d{1,3}:\d{2}\]', '')
  return ($t -replace '\s', '').Length
}

# ---------------------------------------------------------------- 提示词
function Read-Prompt([string]$name) {
  $path = Join-Path $PromptDir $name
  if (-not (Test-Path $path)) { throw "缺少提示词文件 prompts\$name" }
  $t = [IO.File]::ReadAllText($path, $Utf8)
  $t = [regex]::Replace($t, '<!--[\s\S]*?-->', '')
  return ($t -replace "`r`n", "`n").Trim()
}

function Fill-Template([string]$tpl, [hashtable]$vars) {
  $evaluator = [System.Text.RegularExpressions.MatchEvaluator] {
    param($m)
    $k = $m.Groups[1].Value
    if ($vars.ContainsKey($k)) { return [string]$vars[$k] }
    return $m.Value
  }
  return [regex]::Replace($tpl, '\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}', $evaluator)
}

function Read-Mode([string]$mode) {
  $file = if ($mode -eq 'socratic') { 'call3_mode_socratic.md' } else { 'call3_mode_direct.md' }
  $lines = @((Read-Prompt $file) -split "`n")
  $label = $lines[0].Trim()
  $rules = (@($lines | Select-Object -Skip 1) -join "`n").Trim()
  return @{ label = $label; rules = $rules }
}

function Format-Past($past) {
  $items = @($past | Where-Object { $_ })
  if ($items.Count -eq 0) { return $T_FIRST_HELP }
  $lines = foreach ($p in @($items | Select-Object -Last 3)) {
    if ($p -is [string]) { '- ' + $p }
    else { '- 问过：' + [string](Get-Field $p 'question' '') + ' → 当时核心：' + [string](Get-Field $p 'core' '') }
  }
  return "`n" + (@($lines) -join "`n")
}

function Format-History($history) {
  $items = @($history | Where-Object { $_ })
  if ($items.Count -eq 0) { return $T_NO_HISTORY }
  $i = 0
  $lines = foreach ($h in @($items | Select-Object -Last 2)) {
    $i++
    $q = Limit-Text ([string](Get-Field $h 'q' '')) 40
    $a = Limit-Text (([string](Get-Field $h 'a' '')) -replace '\s+', ' ') 60
    "第${i}轮 问：$q → 答：$a"
  }
  return "`n" + (@($lines) -join "`n")
}

# ---------------------------------------------------------------- Call 2 输出整理与校验（规格 4.4）
function Remove-Markdown([string]$t) {
  if ($null -eq $t) { return '' }
  $t = $t -replace "`r", ''
  $t = [regex]::Replace($t, '<think>[\s\S]*?</think>', '')
  $t = [regex]::Replace($t, '(?m)^[ \t]*```.*$', '')
  $t = [regex]::Replace($t, '(?m)^[ \t]*#{1,6}[ \t]*', '')
  $t = [regex]::Replace($t, '(?m)^[ \t]*>[ \t]?', '')
  $t = [regex]::Replace($t, '(?m)^[ \t]*[-*+•][ \t]+', '')
  $t = [regex]::Replace($t, '(?m)^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(\|[ \t]*:?-{3,}:?[ \t]*)*\|?[ \t]*$', '')
  $t = [regex]::Replace($t, '(?m)^[ \t]*\|.*$', [System.Text.RegularExpressions.MatchEvaluator] { param($m) ($m.Value -replace '\|', ' ').Trim() })
  $t = $t -replace '\*\*|__|`', ''
  $t = [regex]::Replace($t, '(?m)^[ \t]*<第[一二三]段[^>\n]*>[ \t]*$', '')
  $t = [regex]::Replace($t, '(?m)^[ \t]*[<【\[（(]?第[一二三123]段[^：:\n]{0,8}?[>】\]）)]?[ \t]*[：:][ \t]*', '')
  $t = [regex]::Replace($t, '(?m)^[ \t]+|[ \t]+$', '')
  return $t.Trim()
}

function Measure-Explain([string]$raw) {
  $clean = Remove-Markdown $raw
  $segs = @([regex]::Split($clean, '\n[ \t]*\n') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($segs.Count -lt 3 -and $clean.Contains("`n")) {
    $alt = @($clean -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($alt.Count -eq 3 -or ($segs.Count -eq 1 -and $alt.Count -gt 1)) { $segs = $alt }
  }
  $lens = @($segs | ForEach-Object { ($_ -replace '\s', '').Length })
  return @{
    text        = ($segs -join "`n`n")
    segments    = $segs
    seg_lengths = $lens
    seg_count   = $segs.Count
    chars       = ($clean -replace '\s', '').Length
  }
}

# ---------------------------------------------------------------- 上游调用
$script:HttpClients = @{}
function Get-HttpClient($cfg) {
  $key = "$($cfg.httpProxy)|$($cfg.timeoutSec)"
  if (-not $script:HttpClients.ContainsKey($key)) {
    $h = New-Object System.Net.Http.HttpClientHandler
    if ([string]$cfg.httpProxy) {
      $h.Proxy = New-Object System.Net.WebProxy([string]$cfg.httpProxy)
      $h.UseProxy = $true
    }
    $c = New-Object System.Net.Http.HttpClient($h)
    $c.Timeout = [TimeSpan]::FromSeconds([double]$cfg.timeoutSec)
    $script:HttpClients[$key] = $c
  }
  return $script:HttpClients[$key]
}

function Send-Upstream($cfg, $payload, [bool]$stream) {
  $client = Get-HttpClient $cfg
  $url = ([string]$cfg.baseUrl).TrimEnd('/') + '/chat/completions'
  $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $url)
  [void]$req.Headers.TryAddWithoutValidation('Authorization', 'Bearer ' + ([string]$cfg.apiKey).Trim())
  if ($stream) { [void]$req.Headers.TryAddWithoutValidation('Accept', 'text/event-stream') }
  $json = ConvertTo-Json -InputObject $payload -Depth 20 -Compress
  $req.Content = New-Object System.Net.Http.StringContent($json, $Utf8, 'application/json')
  try {
    $resp = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  } catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    if ($e.GetType().Name -like '*Canceled*') { return @{ ok = $false; status = 0; error = "上游超时（超过 $($cfg.timeoutSec) 秒没有响应）" } }
    return @{ ok = $false; status = 0; error = '请求上游失败：' + $e.Message }
  }
  if (-not $resp.IsSuccessStatusCode) {
    $code = [int]$resp.StatusCode
    $text = $Utf8.GetString($resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
    $resp.Dispose()
    return @{ ok = $false; status = $code; error = "上游返回 HTTP ${code}：" + (Limit-Text $text 600) }
  }
  return @{ ok = $true; status = [int]$resp.StatusCode; response = $resp }
}

function Invoke-Chat($cfg, [string]$model, [string]$system, $userContent, [double]$temperature, [int]$maxTokens, $extra) {
  $payload = [ordered]@{
    model       = $model
    messages    = @(
      [ordered]@{ role = 'system'; content = $system },
      [ordered]@{ role = 'user'; content = $userContent }
    )
    temperature = $temperature
    max_tokens  = $maxTokens
    stream      = $false
  }
  if ($extra) { foreach ($k in $extra.Keys) { $payload[$k] = $extra[$k] } }
  $r = Send-Upstream $cfg $payload $false
  if (-not $r.ok) { return $r }
  try { $raw = $Utf8.GetString($r.response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()) }
  finally { $r.response.Dispose() }
  try { $obj = $raw | ConvertFrom-Json } catch { return @{ ok = $false; status = 200; error = '上游返回的不是 JSON：' + (Limit-Text $raw 300) } }
  $text = $null
  try { $text = $obj.choices[0].message.content } catch {}
  if (-not $text) { return @{ ok = $false; status = 200; error = '上游没有返回内容：' + (Limit-Text $raw 300) } }
  return @{ ok = $true; status = 200; text = [string]$text }
}

# ---------------------------------------------------------------- 日志
function Write-CallLog([System.Collections.IDictionary]$rec) {
  $o = [ordered]@{ ts = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss.fffzzz') }
  foreach ($k in $rec.Keys) { $o[$k] = $rec[$k] }
  $line = ConvertTo-Json -InputObject $o -Depth 10 -Compress
  [IO.File]::AppendAllText($LogFile, $line + "`n", $Utf8)
}

# ---------------------------------------------------------------- 画面识字（本地 OCR）
# 用 Windows 自带的 Windows.Media.Ocr：不联网、不花钱，中文系统自带中文识别包。
# 用途：模型看不了图（例如 DeepSeek）或视觉调用失败时，把画面上的字读出来交给模型；
#       扩展播放时也会定期把画面底部条带送来识别，补上「烧在画面里的硬字幕」。
# 只在 Windows PowerShell 5.1 下可用（启动.bat 用的就是它）；不可用时一切照旧，只是少了画面文字。
$script:OcrState = $null

function Initialize-Ocr {
  if ($null -ne $script:OcrState) { return $script:OcrState }
  $st = @{ ok = $false; error = $null; engine = $null; asTask = $null; lang = '' }
  try {
    if ($PSVersionTable.PSEdition -eq 'Core') { throw '画面识字需要 Windows PowerShell 5.1（用 启动.bat 启动即可）' }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
    $st.asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
      Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
      Select-Object -First 1
    $engine = $null
    foreach ($tag in @('zh-Hans-CN', 'zh-Hans', 'zh-CN')) {
      try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $tag)) } catch {}
      if ($engine) { break }
    }
    if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    if (-not $engine) { throw '系统里没有可用的文字识别语言包（设置 → 时间和语言 → 语言 → 中文(简体) → 语言选项 → 光学字符识别）' }
    $st.engine = $engine
    $st.lang = [string]$engine.RecognizerLanguage.LanguageTag
    $st.ok = $true
  } catch {
    $st.error = $_.Exception.Message
  }
  $script:OcrState = $st
  return $st
}

function Wait-WinRt($op, [Type]$type) {
  $task = $script:OcrState.asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(15000)) { throw '文字识别超时' }
  return $task.Result
}

# Windows OCR 把每个汉字当成一个“词”，Line.Text 里字与字之间全是空格；这里只在两个英文/数字词之间留空格
function Join-OcrWords($words) {
  $sb = New-Object System.Text.StringBuilder
  $prev = ''
  foreach ($w in $words) {
    $t = [string]$w.Text
    if ($sb.Length -gt 0 -and $prev -match '[A-Za-z0-9]$' -and $t -match '^[A-Za-z0-9]') { [void]$sb.Append(' ') }
    [void]$sb.Append($t)
    $prev = $t
  }
  return $sb.ToString()
}

# 过滤明显的乱码行（公式、图案常被识别成一串符号）
function Test-OcrLineUseful([string]$s) {
  $len = ($s -replace '\s', '').Length
  if ($len -lt 3) { return $false }
  $good = ([regex]::Matches($s, '[一-鿿A-Za-z0-9]')).Count
  return ($good -ge 3 -and ($good / $len) -ge 0.6)
}

# 返回 @{ ok; code; error; width; height; ms; lines = @(@{ text; x; y; w; h }) }，行按从上到下排序
function Invoke-Ocr([string]$dataUrl) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $st = Initialize-Ocr
  if (-not $st.ok) { return @{ ok = $false; code = 'ocr_unavailable'; error = $st.error } }
  $comma = $dataUrl.IndexOf(',')
  if (-not $dataUrl.StartsWith('data:image/') -or $comma -lt 0) { return @{ ok = $false; code = 'bad_image'; error = '不是图片' } }
  $ms = $null
  try {
    $bytes = [Convert]::FromBase64String($dataUrl.Substring($comma + 1))
    $ms = New-Object System.IO.MemoryStream(, $bytes)
    $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
    try {
      $decoder = Wait-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bmp = Wait-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    } catch {
      return @{ ok = $false; code = 'bad_image'; error = '图片解不开（格式不支持或数据损坏）' }
    }
    $res = Wait-WinRt ($st.engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    $lines = New-Object System.Collections.ArrayList
    foreach ($line in $res.Lines) {
      $text = Join-OcrWords $line.Words
      if (-not (Test-OcrLineUseful $text)) { continue }
      $x1 = [double]::MaxValue; $y1 = [double]::MaxValue; $x2 = 0.0; $y2 = 0.0
      foreach ($w in $line.Words) {
        $r = $w.BoundingRect
        if ($r.X -lt $x1) { $x1 = $r.X }
        if ($r.Y -lt $y1) { $y1 = $r.Y }
        if ($r.X + $r.Width -gt $x2) { $x2 = $r.X + $r.Width }
        if ($r.Y + $r.Height -gt $y2) { $y2 = $r.Y + $r.Height }
      }
      [void]$lines.Add(@{ text = $text; x = $x1; y = $y1; w = $x2 - $x1; h = $y2 - $y1 })
    }
    $out = @{ ok = $true; width = [int]$bmp.PixelWidth; height = [int]$bmp.PixelHeight; lines = @($lines | Sort-Object { $_.y }); ms = $sw.ElapsedMilliseconds }
    try { $bmp.Dispose() } catch {}
    return $out
  } catch {
    return @{ ok = $false; code = 'ocr_failed'; error = '文字识别失败：' + $_.Exception.Message }
  } finally {
    if ($ms) { $ms.Dispose() }
  }
}

# region = 'subtitle'：图本身就是画面底部条带；'full'：整帧，底部 28% 当字幕带。
# 字幕 = 字幕带里、水平居中的行；其余是画面上的其他文字（板书、标题等）
function Split-OcrText($ocr, [string]$region) {
  $W = [double]$ocr.width
  $H = [double]$ocr.height
  $bandTop = if ($region -eq 'subtitle') { 0 } else { $H * 0.72 }
  $sub = New-Object System.Collections.ArrayList
  $other = New-Object System.Collections.ArrayList
  foreach ($l in $ocr.lines) {
    $cx = $l.x + $l.w / 2
    if ($l.y -ge $bandTop -and [math]::Abs($cx - $W / 2) -le $W * 0.22) { [void]$sub.Add($l.text) }
    else { [void]$other.Add($l.text) }
  }
  return @{ subtitle = ($sub -join ' '); other = @($other) }
}

function Get-FrameText($cfg, [string]$image) {
  if ($cfg.ocr -eq $false -or -not $image.StartsWith('data:image/')) { return $null }
  $o = Invoke-Ocr $image
  if (-not $o.ok) { return @{ ok = $false; error = $o.error; subtitle = ''; other = @(); ms = 0 } }
  $s = Split-OcrText $o 'full'
  return @{ ok = $true; error = $null; subtitle = $s.subtitle; other = $s.other; ms = $o.ms }
}

# 拼到发给模型的用户消息末尾（不改动规格里的提示词原文）
function Format-ScreenText($ft) {
  if (-not $ft -or -not $ft.ok) { return '' }
  $parts = @()
  if ($ft.subtitle) { $parts += '画面字幕：' + $ft.subtitle }
  $other = @($ft.other | Select-Object -First 12)
  if ($other.Count) {
    $parts += '画面上的其他文字：'
    $parts += @($other | ForEach-Object { '- ' + $_ })
  }
  if (-not $parts.Count) { return '' }
  return Limit-Text ("【当前画面上的文字（本地文字识别自动读出，可能有错字或乱码，看不懂的直接忽略；你看不到画面本身）】`n" + ($parts -join "`n")) 800
}

function Get-NormText([string]$s) { return ($s -replace '[\s，。、,\.!?！？：:；;“”"''()（）\[\]【】]', '') }

# 暂停那一帧读到的字幕，如果扩展收集的字幕里还没有，就补到末尾
function Add-SubtitleToTranscript([string]$transcript, [string]$timestamp, [string]$sub) {
  $n = Get-NormText $sub
  if ($n.Length -lt 2) { return $transcript }
  if ((Get-NormText $transcript).Contains($n)) { return $transcript }
  $line = "[$timestamp] $sub"
  if ($transcript.Trim()) { return $transcript.TrimEnd() + "`n" + $line }
  return $line
}

# ---------------------------------------------------------------- Call 1：路由
function Get-FallbackRoute([string]$question, [string]$transcript) {
  # 规格 3.4：问题里的中文与字母连续串 → 2 字滑窗；命中字幕中任意 2 个片段 → in_video
  $grams = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($m in [regex]::Matches(([string]$question).ToLowerInvariant(), '[一-鿿a-z]+')) {
    $s = $m.Value
    for ($i = 0; $i -le $s.Length - 2; $i++) { [void]$grams.Add($s.Substring($i, 2)) }
  }
  $tl = ([string]$transcript).ToLowerInvariant()
  $hits = 0
  foreach ($g in $grams) { if ($tl.Contains($g)) { $hits++ } }
  $route = if ($hits -ge 2) { 'in_video' } else { 'related_general' }
  return @{ route = $route; redirect = $null; fallback = $true; hits = $hits }
}

function ConvertFrom-RouterJson([string]$text) {
  $t = [regex]::Replace([string]$text, '<think>[\s\S]*?</think>', '')
  $t = [regex]::Replace($t, '```(?:json)?', '', 'IgnoreCase')
  $m = [regex]::Match($t, '\{[\s\S]*\}')
  if (-not $m.Success) { return $null }
  try { $o = $m.Value | ConvertFrom-Json } catch { return $null }
  $route = [string](Get-Field $o 'route' '')
  if ($ROUTES -notcontains $route) { return $null }
  $redirect = $null
  if ($route -eq 'off_topic') {
    $redirect = [string](Get-Field $o 'redirect' '')
    if (-not $redirect.Trim() -or $redirect -eq 'null') { $redirect = $T_DEFAULT_REDIRECT }
  }
  return @{ route = $route; redirect = $redirect; fallback = $false }
}

function Invoke-Router($cfg, [hashtable]$vars, [hashtable]$meta) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $result = $null
  $err = $null
  $jsonMode = $null
  if (-not $vars.ContainsKey('outline')) { $vars.outline = '（无）' }
  if (-not (Test-HasKey $cfg)) { $err = 'no_api_key' }
  else {
    $sys = Fill-Template (Read-Prompt 'call1_router.md') $vars
    $jsonMode = $true
    $r = Invoke-Chat $cfg ([string]$cfg.model) $sys $vars.question 0 120 @{ response_format = @{ type = 'json_object' } }
    if (-not $r.ok -and $r.status -ge 400 -and @(401, 403, 429) -notcontains $r.status) {
      # 规格 3.3：上游不支持 JSON 模式 → 去掉 response_format 重试一次
      $jsonMode = $false
      $r = Invoke-Chat $cfg ([string]$cfg.model) $sys $vars.question 0 120 $null
    }
    if ($r.ok) {
      $result = ConvertFrom-RouterJson $r.text
      if (-not $result) { $err = 'parse_failed: ' + (Limit-Text $r.text 120) }
    } else { $err = $r.error }
  }
  if (-not $result) {
    # 有整片大纲时一起比对：问到视频别处讲过的内容也算 in_video
    $result = Get-FallbackRoute $vars.question ($vars.transcript + "`n" + $vars.outline)
    $result.error = $err
  }
  $result.ms = $sw.ElapsedMilliseconds
  Write-CallLog ([ordered]@{
      type          = 'call1'
      session_id    = $meta.session_id
      video_id      = $meta.video_id
      timestamp     = $vars.timestamp
      user_question = $vars.question
      route         = $result.route
      redirect      = $result.redirect
      fallback      = [bool]$result.fallback
      json_mode     = $jsonMode
      error         = $result.error
      total_ms      = $result.ms
    })
  return $result
}

# ---------------------------------------------------------------- 字幕记忆分层（v1.4）
# 目标：AI 读完整部视频的全部字幕，既能模糊把握整体方向，又能精确把握暂停点前后那一段。
#
# 生成（扩展拿到整片字幕后 POST /memory/build，后台异步完成，结果存 data/memory/<视频>.json）：
#   L0 原文层 cues    整片字幕逐句（扩展从 B 站字幕接口拉取；拉不到时用播放中边看边抓的字幕）
#   L1 小节层 chunks  按时间切成 2–4 分钟的小节；map：一次读一批小节原文，每节写 ≤60 字摘要 + 术语
#   L2 全局层 global  reduce：读全部小节摘要，写主题 + 主线 + 3–10 个章节 + 关键术语表
#
# 使用（每次 /explain、/followup 按暂停点 t 现场拼装，越往下越精确）：
#   全局层  整片大纲，标出「用户现在在这一章」——只用来校准方向
#   章节层  上一 / 当前 / 下一小节的摘要——这一段从哪来、往哪去
#   焦点层  t-30 ~ t+30 秒原文，▶ 标出暂停那一句，分「已听过 / 还没看到」——解释对象
#   回溯层  焦点里的术语在前文第一次出现的原文；追问时再按问题检索最相关的小节
#
# 代理是单线程的，生成记忆要调几次模型（十几秒到一分钟），所以用异步 HttpClient 任务、
# 由主循环每 250ms 轮询推进；生成期间 /explain、/followup 照常响应，缺的层写「还在生成」。
$MemDir = Join-Path $DataDir 'memory'
$MEM_VERSION     = 1
$MEM_BATCH_CHARS = 6000   # map 一次最多读多少字
$MEM_BATCH_MAX   = 8      # map 一次最多几个小节
$script:MemCache = @{}    # video_id → 记忆对象（正在生成的也在这里，查询能看到进度）
$script:MemJobs  = @{}    # video_id → 生成任务
$script:MemIndex = @{}    # 记忆 hash → 小节二字词索引（追问检索用）

function Get-MemSettings($cfg) {
  $s = @{ enabled = $true; chunkSec = 150; chunkChars = 900; focusBefore = 30; focusAfter = 30; parallel = 3 }
  $m = $cfg.memory
  if ($m) { foreach ($k in @($s.Keys)) { $v = Get-Field $m $k $null; if ($null -ne $v) { $s[$k] = $v } } }
  $s.enabled = ($s.enabled -ne $false)
  foreach ($k in @('chunkSec', 'chunkChars', 'focusBefore', 'focusAfter', 'parallel')) { $s[$k] = [Math]::Max(1, [double]$s[$k]) }
  return $s
}

function Get-ShortHash([string]$s) {
  $sha = [Security.Cryptography.SHA1]::Create()
  try { $b = $sha.ComputeHash($Utf8.GetBytes($s)) } finally { $sha.Dispose() }
  return (-join ($b[0..7] | ForEach-Object { $_.ToString('x2') }))
}

function Get-MemPath([string]$videoId) {
  $safe = [regex]::Replace($videoId, '[^A-Za-z0-9_\-]', '_')
  if ($safe.Length -gt 80) { $safe = $safe.Substring(0, 60) + '_' + (Get-ShortHash $videoId) }
  return (Join-Path $MemDir ($safe + '.json'))
}

# 接受 [[from, to, text], ...]（扩展发的紧凑格式）或 B 站原始格式 [{from, to, content}]
function ConvertTo-MemCues($raw) {
  $list = New-Object System.Collections.ArrayList
  foreach ($c in @($raw)) {
    if ($null -eq $c) { continue }
    if ($c -is [System.Collections.IList]) {
      if ($c.Count -lt 3) { continue }
      $s = [double]$c[0]; $e = [double]$c[1]; $text = [string]$c[2]
    } else {
      $s = [double](Get-Field $c 'from' (Get-Field $c 's' 0))
      $e = [double](Get-Field $c 'to' (Get-Field $c 'e' $s))
      $text = [string](Get-Field $c 'content' (Get-Field $c 'text' ''))
    }
    $text = ($text -replace '\s+', ' ').Trim()
    if (-not $text) { continue }
    if ($e -lt $s) { $e = $s }
    [void]$list.Add([ordered]@{ s = [Math]::Round($s, 2); e = [Math]::Round($e, 2); text = $text })
  }
  $out = New-Object System.Collections.ArrayList
  foreach ($c in @($list | Sort-Object { $_.s })) {
    if ($out.Count) {
      $p = $out[$out.Count - 1]
      if ($p.text -eq $c.text -and $c.s - $p.s -lt 6) { if ($c.e -gt $p.e) { $p.e = $c.e }; continue } # 倒回重看时抓到两遍
    }
    [void]$out.Add($c)
  }
  return , $out.ToArray()
}

# 小节原文：每隔 30 秒插一个 [mm:ss]，让模型知道大概的时间位置，又不至于每句都带时间戳浪费字数
function Get-ChunkText($cues, [int]$a, [int]$b) {
  $sb = New-Object System.Text.StringBuilder
  $nextMark = -1.0
  for ($i = $a; $i -le $b; $i++) {
    $c = $cues[$i]
    if ([double]$c.s -ge $nextMark) {
      if ($sb.Length) { [void]$sb.Append("`n") }
      [void]$sb.Append('[' + (Format-Clock $c.s) + '] ')
      $nextMark = [double]$c.s + 30
    } else { [void]$sb.Append(' ') }
    [void]$sb.Append($c.text)
  }
  return $sb.ToString()
}

function Get-ChunkPlain($cues, [int]$a, [int]$b) {
  $parts = for ($i = $a; $i -le $b; $i++) { $cues[$i].text }
  return (@($parts) -join ' ')
}

# 切小节：到了目标时长 / 字数，就在下一个停顿或句末切开；最长不超过目标的 1.6 倍
function Split-MemChunks($cues, $ms) {
  $n = $cues.Count
  $ranges = New-Object System.Collections.ArrayList
  $a = 0
  while ($a -lt $n) {
    $s0 = [double]$cues[$a].s
    $chars = 0
    $b = $a
    for ($i = $a; $i -lt $n; $i++) {
      $b = $i
      $chars += $cues[$i].text.Length
      if ($i + 1 -ge $n) { break }
      $dur = [double]$cues[$i].e - $s0
      $gap = [double]$cues[$i + 1].s - [double]$cues[$i].e
      $hard = ($dur -ge $ms.chunkSec * 1.6 -or $chars -ge $ms.chunkChars * 1.6)
      $soft = (($dur -ge $ms.chunkSec -or $chars -ge $ms.chunkChars) -and ($gap -ge 0.6 -or $cues[$i].text -match '[。！？!?；;]$'))
      if ($hard -or $soft) { break }
    }
    [void]$ranges.Add(@{ a = $a; b = $b })
    $a = $b + 1
  }
  if ($ranges.Count -ge 2) {
    $last = $ranges[$ranges.Count - 1]
    $chars = (Get-ChunkPlain $cues $last.a $last.b).Length
    if ([double]$cues[$last.b].e - [double]$cues[$last.a].s -lt $ms.chunkSec * 0.4 -and $chars -lt $ms.chunkChars * 0.4) {
      $ranges[$ranges.Count - 2].b = $last.b
      $ranges.RemoveAt($ranges.Count - 1)
    }
  }
  $out = New-Object System.Collections.ArrayList
  foreach ($r in $ranges) {
    $plain = Get-ChunkPlain $cues $r.a $r.b
    [void]$out.Add([ordered]@{
        i       = $out.Count
        s       = [double]$cues[$r.a].s
        e       = [double]$cues[$r.b].e
        a       = $r.a
        b       = $r.b
        hash    = Get-ShortHash $plain
        title   = Limit-Text $cues[$r.a].text 12   # 规则兜底：模型摘要出来之前先用原文开头
        summary = Limit-Text $plain 60
        terms   = @()
        src     = 'rule'
      })
  }
  return , $out.ToArray()
}

function Get-CuesHash($cues, $ms) {
  $sb = New-Object System.Text.StringBuilder
  foreach ($c in $cues) { [void]$sb.Append([int]$c.s).Append('|').Append($c.text).Append("`n") }
  [void]$sb.Append("chunk=$($ms.chunkSec)/$($ms.chunkChars)")
  return (Get-ShortHash $sb.ToString())
}

function Save-Memory($mem) {
  if (-not (Test-Path $MemDir)) { New-Item -ItemType Directory -Path $MemDir | Out-Null }
  $mem.updated = (Get-Date).ToString('s')
  [IO.File]::WriteAllText((Get-MemPath ([string]$mem.video_id)), (ConvertTo-Json -InputObject $mem -Depth 8 -Compress), $Utf8)
}

function Get-Memory([string]$videoId) {
  if (-not $videoId) { return $null }
  if ($script:MemCache.ContainsKey($videoId)) { return $script:MemCache[$videoId] }
  $p = Get-MemPath $videoId
  if (-not (Test-Path $p)) { return $null }
  try { $m = [IO.File]::ReadAllText($p, $Utf8) | ConvertFrom-Json } catch { return $null }
  if ([int](Get-Field $m 'version' 0) -ne $MEM_VERSION) { return $null }
  if ($m.status -eq 'building') { $m.status = 'partial' } # 上次没生成完代理就关了
  $script:MemCache[$videoId] = $m
  return $m
}

# ---------------- 异步调用上游（不阻塞主循环）
function Start-ChatTask($cfg, [string]$system, [string]$user, [double]$temperature, [int]$maxTokens, [bool]$jsonMode) {
  $payload = [ordered]@{
    model       = [string]$cfg.model
    messages    = @(
      [ordered]@{ role = 'system'; content = $system },
      [ordered]@{ role = 'user'; content = $user }
    )
    temperature = $temperature
    max_tokens  = $maxTokens
    stream      = $false
  }
  if ($jsonMode) { $payload.response_format = @{ type = 'json_object' } }
  # 读整片字幕比即时解释慢得多，超时单独放宽
  $client = Get-HttpClient @{ httpProxy = [string]$cfg.httpProxy; timeoutSec = [Math]::Max(180, [int]$cfg.timeoutSec) }
  # 先算好 URL：New-Object X(a, b + c) 里逗号比加号优先，会变成三个参数
  $url = ([string]$cfg.baseUrl).TrimEnd('/') + '/chat/completions'
  $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $url)
  [void]$req.Headers.TryAddWithoutValidation('Authorization', 'Bearer ' + ([string]$cfg.apiKey).Trim())
  $req.Content = New-Object System.Net.Http.StringContent((ConvertTo-Json -InputObject $payload -Depth 10 -Compress), $Utf8, 'application/json')
  return @{ task = $client.SendAsync($req); req = $req; sw = [Diagnostics.Stopwatch]::StartNew() }
}

function Complete-ChatTask($ct) {
  $task = $ct.task
  try {
    if ($task.IsCanceled) { return @{ ok = $false; status = 0; error = '上游超时' } }
    if ($task.IsFaulted) {
      $e = $task.Exception
      while ($e.InnerException) { $e = $e.InnerException }
      if ($e.GetType().Name -like '*Canceled*') { return @{ ok = $false; status = 0; error = '上游超时' } }
      return @{ ok = $false; status = 0; error = '请求上游失败：' + $e.Message }
    }
    $resp = $task.Result
    try {
      $code = [int]$resp.StatusCode
      $raw = $Utf8.GetString($resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
    } finally { $resp.Dispose() }
    if ($code -lt 200 -or $code -ge 300) { return @{ ok = $false; status = $code; error = "上游返回 HTTP ${code}：" + (Limit-Text $raw 300) } }
    try { $obj = $raw | ConvertFrom-Json } catch { return @{ ok = $false; status = 200; error = '上游返回的不是 JSON：' + (Limit-Text $raw 200) } }
    $text = $null
    try { $text = [string]$obj.choices[0].message.content } catch {}
    if (-not $text) { return @{ ok = $false; status = 200; error = '上游没有返回内容：' + (Limit-Text $raw 200) } }
    return @{ ok = $true; status = 200; text = $text; ms = $ct.sw.ElapsedMilliseconds }
  } finally {
    try { $ct.req.Dispose() } catch {}
  }
}

function ConvertFrom-LooseJson([string]$text) {
  $t = [regex]::Replace([string]$text, '<think>[\s\S]*?</think>', '')
  $t = [regex]::Replace($t, '```(?:json)?', '', 'IgnoreCase').Trim()
  foreach ($pat in @('^[\s\S]*$', '\{[\s\S]*\}', '\[[\s\S]*\]')) {
    $m = [regex]::Match($t, $pat)
    if (-not $m.Success) { continue }
    try { return ($m.Value | ConvertFrom-Json) } catch {}
  }
  return $null
}

# ---------------- 生成：map（小节摘要）→ reduce（全局）
function Get-MapBatches($mem) {
  $batches = New-Object System.Collections.ArrayList
  $cur = New-Object System.Collections.ArrayList
  $chars = 0
  foreach ($c in @($mem.chunks)) {
    if ($c.src -eq 'llm') { continue } # 原文没变的小节沿用上次的摘要
    $len = (Get-ChunkText $mem.cues $c.a $c.b).Length
    if ($cur.Count -and ($chars + $len -gt $MEM_BATCH_CHARS -or $cur.Count -ge $MEM_BATCH_MAX)) {
      [void]$batches.Add(@{ ids = $cur.ToArray(); tries = 0 })
      $cur = New-Object System.Collections.ArrayList
      $chars = 0
    }
    [void]$cur.Add([int]$c.i)
    $chars += $len
  }
  if ($cur.Count) { [void]$batches.Add(@{ ids = $cur.ToArray(); tries = 0 }) }
  return , $batches
}

function Format-ChunkDigest($mem) {
  $lines = foreach ($c in @($mem.chunks)) {
    $head = "[$($c.i)] [$(Format-Clock $c.s)-$(Format-Clock $c.e)] "
    if ($c.src -eq 'llm') {
      $line = $head + $c.title + '：' + $c.summary
      if (@($c.terms).Count) { $line += '（术语：' + (@($c.terms) -join '、') + '）' }
      $line
    } else { $head + '（这一节没有摘要，原文开头）' + $c.summary }
  }
  return (@($lines) -join "`n")
}

function Start-MemCall($job, [string]$kind, $batch) {
  $mem = $job.mem
  $vars = @{
    subject     = [string]$mem.subject
    desc        = $(if ([string]$mem.desc) { [string]$mem.desc } else { '（无）' })
    duration    = Format-Clock $mem.duration
    chunk_count = [string]@($mem.chunks).Count
  }
  if ($kind -eq 'map') {
    $sys = Fill-Template (Read-Prompt 'memory_map.md') $vars
    $parts = foreach ($id in $batch.ids) {
      $c = $mem.chunks[$id]
      "### 小节 $id [$(Format-Clock $c.s)-$(Format-Clock $c.e)]`n" + (Get-ChunkText $mem.cues $c.a $c.b)
    }
    $user = @($parts) -join "`n`n"
    $max = 200 + 260 * @($batch.ids).Count
  } else {
    $sys = Fill-Template (Read-Prompt 'memory_reduce.md') $vars
    $user = Format-ChunkDigest $mem
    $max = 2000
  }
  $json = -not $job.noJson
  $ct = Start-ChatTask $job.cfg $sys $user 0.2 $max $json
  [void]$job.running.Add(@{ kind = $kind; batch = $batch; ct = $ct; json = $json })
  $job.calls = $job.calls + 1
}

function Set-MapResult($mem, $ids, $obj) {
  if ($null -eq $obj) { return 0 }
  $items = if ($obj -is [System.Array]) { $obj } else { @(Get-Field $obj 'chunks' @()) }
  $applied = 0
  foreach ($it in @($items)) {
    try { $i = [int](Get-Field $it 'i' -1) } catch { continue }
    if (@($ids) -notcontains $i) { continue }
    $summary = ([string](Get-Field $it 'summary' '')).Trim()
    if (-not $summary) { continue }
    $title = ([string](Get-Field $it 'title' '')).Trim()
    $terms = @(@(Get-Field $it 'terms' @()) | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ -and $_.Length -le 16 } | Select-Object -First 6)
    $c = $mem.chunks[$i]
    if ($title) { $c.title = Limit-Text $title 16 }
    $c.summary = Limit-Text $summary 90
    $c.terms = $terms
    $c.src = 'llm'
    $applied++
  }
  return $applied
}

function Set-ReduceResult($mem, $obj) {
  if ($null -eq $obj -or $obj -is [System.Array]) { return $false }
  $chunks = @($mem.chunks)
  $n = $chunks.Count
  $topic = ([string](Get-Field $obj 'topic' '')).Trim()
  $summary = ([string](Get-Field $obj 'summary' '')).Trim()
  if (-not $summary -and -not $topic) { return $false }
  # 章节：按 from 排序、去重叠、补空隙，保证按顺序覆盖全部小节
  $raw = New-Object System.Collections.ArrayList
  foreach ($ch in @(Get-Field $obj 'chapters' @())) {
    try { $f = [int](Get-Field $ch 'from' -1); $t = [int](Get-Field $ch 'to' -1) } catch { continue }
    if ($f -lt 0 -or $f -ge $n) { continue }
    if ($t -lt $f) { $t = $f }
    if ($t -ge $n) { $t = $n - 1 }
    $title = ([string](Get-Field $ch 'title' '')).Trim()
    [void]$raw.Add(@{ from = $f; to = $t; title = $title })
  }
  $chapters = New-Object System.Collections.ArrayList
  $next = 0
  foreach ($ch in @($raw | Sort-Object { $_.from })) {
    if ($ch.to -lt $next) { continue }
    $title = if ($ch.title) { Limit-Text $ch.title 18 } else { [string]$chunks[$next].title }
    [void]$chapters.Add([ordered]@{ from = $next; to = $ch.to; title = $title; s = [double]$chunks[$next].s; e = [double]$chunks[$ch.to].e })
    $next = $ch.to + 1
  }
  if ($next -lt $n) {
    if ($chapters.Count) { $last = $chapters[$chapters.Count - 1]; $last.to = $n - 1; $last.e = [double]$chunks[$n - 1].e }
    else { [void]$chapters.Add([ordered]@{ from = 0; to = $n - 1; title = $(if ($topic) { Limit-Text $topic 18 } else { '全片' }); s = [double]$chunks[0].s; e = [double]$chunks[$n - 1].e }) }
  }
  $terms = New-Object System.Collections.ArrayList
  $seen = @{}
  foreach ($tm in @(Get-Field $obj 'terms' @())) {
    $term = ([string](Get-Field $tm 'term' '')).Trim()
    if (-not $term -or $term.Length -gt 16 -or $seen.ContainsKey($term)) { continue }
    $seen[$term] = 1
    $ci = -1
    try { $ci = [int](Get-Field $tm 'chunk' -1) } catch {}
    $def = ([string](Get-Field $tm 'def' '')).Trim()
    [void]$terms.Add([ordered]@{ term = $term; def = (Limit-Text $def 30); chunk = $ci })
    if ($terms.Count -ge 15) { break }
  }
  $mem.global = [ordered]@{ topic = (Limit-Text $topic 30); summary = (Limit-Text $summary 220); chapters = $chapters.ToArray(); terms = $terms.ToArray() }
  return $true
}

function Start-MemoryJob($mem, $cfg) {
  $queue = Get-MapBatches $mem
  $job = @{
    mem = $mem; cfg = $cfg; queue = $queue; running = (New-Object System.Collections.ArrayList)
    phase = 'map'; total = $queue.Count; done = 0; failed = 0; calls = 0; reduceTries = 0; noJson = $false
    parallel = [int](Get-MemSettings $cfg).parallel
    errors = (New-Object System.Collections.ArrayList); sw = [Diagnostics.Stopwatch]::StartNew()
  }
  $mem.model = [string]$cfg.model
  $mem.progress = [ordered]@{ phase = 'map'; done = 0; total = $queue.Count }
  $script:MemJobs[[string]$mem.video_id] = $job
}

function Step-MemoryJob($job) {
  $mem = $job.mem
  foreach ($r in @($job.running)) {
    if (-not $r.ct.task.IsCompleted) { continue }
    $job.running.Remove($r)
    $res = Complete-ChatTask $r.ct
    if (-not $res.ok -and $r.json -and $res.status -ge 400 -and @(401, 403, 429) -notcontains $res.status) {
      $job.noJson = $true # 上游不支持 JSON 模式：去掉 response_format 重发
      Start-MemCall $job $r.kind $r.batch
      continue
    }
    if (-not $res.ok -and @(401, 403) -contains $res.status) {
      [void]$job.errors.Add($res.error) # Key 有问题，别的批次也不用试了
      $job.queue.Clear()
      $job.phase = 'done'
      continue
    }
    if ($r.kind -eq 'map') {
      $applied = 0
      if ($res.ok) { $applied = Set-MapResult $mem $r.batch.ids (ConvertFrom-LooseJson $res.text) }
      if ($applied -gt 0) { $job.done = $job.done + 1; continue }
      $r.batch.tries = $r.batch.tries + 1
      $err = if ($res.ok) { 'map 输出解析失败：' + (Limit-Text $res.text 120) } else { [string]$res.error }
      if ($r.batch.tries -lt 2 -and $job.phase -eq 'map') { $job.queue.Insert(0, $r.batch) }
      else { $job.done = $job.done + 1; $job.failed = $job.failed + 1; [void]$job.errors.Add($err) }
    } else {
      $ok = $false
      if ($res.ok) { $ok = Set-ReduceResult $mem (ConvertFrom-LooseJson $res.text) }
      if ($ok) { $job.phase = 'done'; continue }
      $job.reduceTries = $job.reduceTries + 1
      [void]$job.errors.Add($(if ($res.ok) { 'reduce 输出解析失败：' + (Limit-Text $res.text 120) } else { [string]$res.error }))
      if ($job.reduceTries -lt 2) { Start-MemCall $job 'reduce' $null } else { $job.phase = 'done' }
    }
  }
  if ($job.phase -eq 'map') {
    while ($job.running.Count -lt $job.parallel -and $job.queue.Count -gt 0) {
      $b = $job.queue[0]
      $job.queue.RemoveAt(0)
      Start-MemCall $job 'map' $b
    }
    if ($job.running.Count -eq 0 -and $job.queue.Count -eq 0) {
      $job.phase = 'reduce'
      Start-MemCall $job 'reduce' $null
    }
  }
  $mem.progress = [ordered]@{ phase = $job.phase; done = $job.done; total = $job.total }
  if ($job.phase -eq 'done' -and $job.running.Count -eq 0) { Complete-MemoryJob $job }
}

function Complete-MemoryJob($job) {
  $mem = $job.mem
  $vid = [string]$mem.video_id
  if ([object]::ReferenceEquals($script:MemJobs[$vid], $job)) { $script:MemJobs.Remove($vid) }
  $total = @($mem.chunks).Count
  $llm = @($mem.chunks | Where-Object { $_.src -eq 'llm' }).Count
  $mem.status = if ($mem.global -and $llm -eq $total) { 'ready' } elseif ($mem.global -or $llm -gt 0) { 'partial' } else { 'raw' }
  $mem.error = if ($job.errors.Count) { Limit-Text ([string]$job.errors[0]) 300 } else { $null }
  $mem.built_ms = $job.sw.ElapsedMilliseconds
  $mem.progress = [ordered]@{ phase = 'done'; done = $job.done; total = $job.total }
  Save-Memory $mem
  $chapters = if ($mem.global) { @($mem.global.chapters).Count } else { 0 }
  Write-CallLog ([ordered]@{
      type         = 'memory'
      video_id     = $vid
      source       = $mem.source
      status       = $mem.status
      cues         = @($mem.cues).Count
      chunks       = $total
      chunks_llm   = $llm
      chapters     = $chapters
      calls        = $job.calls
      failed       = $job.failed
      model        = $mem.model
      error        = $mem.error
      total_ms     = $mem.built_ms
    })
  $color = if ($mem.status -eq 'ready') { 'Green' } else { 'DarkYellow' }
  Write-Host ('[{0}] 整片记忆 {1}：{2} 句 → {3} 小节（模型摘要 {4}）→ {5} 章，调用 {6} 次，{7:0.0}s{8}' -f (Get-Date -Format 'HH:mm:ss'), $vid, @($mem.cues).Count, $total, $llm, $chapters, $job.calls, ($mem.built_ms / 1000), $(if ($mem.error) { '  ' + (Limit-Text $mem.error 80) } else { '' })) -ForegroundColor $color
}

# 主循环每 250ms、每处理完一个请求调一次；任何异常都只影响这一个任务，不影响代理
function Step-MemoryJobs {
  if ($script:MemJobs.Count -eq 0) { return }
  foreach ($vid in @($script:MemJobs.Keys)) {
    $job = $script:MemJobs[$vid]
    try { Step-MemoryJob $job }
    catch {
      [void]$job.errors.Insert(0, '生成记忆时代理内部错误：' + $_.Exception.Message)
      $job.running.Clear()
      try { Complete-MemoryJob $job } catch { $script:MemJobs.Remove($vid) }
    }
  }
}

# ---------------- 使用：按暂停点拼装四层上下文
function Get-Bigrams([string]$s) {
  $set = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($m in [regex]::Matches(([string]$s).ToLowerInvariant(), '[一-鿿a-z0-9]+')) {
    $v = $m.Value
    for ($i = 0; $i -le $v.Length - 2; $i++) { [void]$set.Add($v.Substring($i, 2)) }
  }
  return , $set
}

function Get-MemIndex($mem) {
  $key = [string]$mem.hash + '|' + [string]$mem.updated
  if ($script:MemIndex.ContainsKey($key)) { return $script:MemIndex[$key] }
  $sets = New-Object System.Collections.ArrayList
  $df = New-Object 'System.Collections.Generic.Dictionary[string,int]'
  foreach ($c in @($mem.chunks)) {
    $set = Get-Bigrams ((Get-ChunkPlain $mem.cues $c.a $c.b) + ' ' + $c.title + ' ' + $c.summary)
    [void]$sets.Add($set)
    foreach ($g in $set) { if ($df.ContainsKey($g)) { $df[$g] = $df[$g] + 1 } else { $df[$g] = 1 } }
  }
  if ($script:MemIndex.Count -gt 20) { $script:MemIndex.Clear() }
  $idx = @{ sets = $sets; df = $df; n = $sets.Count }
  $script:MemIndex[$key] = $idx
  return $idx
}

function Format-ChunkLine($c, [string]$label) {
  $head = "$label [$(Format-Clock $c.s)-$(Format-Clock $c.e)] "
  if ($c.src -ne 'llm') { return $head + '（摘要还没生成，原文开头）' + $c.summary }
  $line = $head + $c.title + '：' + $c.summary
  if (@($c.terms).Count) { $line += '（术语：' + (@($c.terms) -join '、') + '）' }
  return $line
}

function Get-CueSnippet($cues, [int]$k) {
  $a = [Math]::Max(0, $k - 1)
  $b = [Math]::Min($cues.Count - 1, $k + 1)
  return (Limit-Text (Get-ChunkPlain $cues $a $b) 90)
}

function Get-MemoryContext($mem, [double]$t, [string]$question, $ms) {
  $cues = @($mem.cues)
  $n = $cues.Count
  $chunks = @($mem.chunks)
  $g = $mem.global
  $lo = $t - $ms.focusBefore
  $hi = $t + $ms.focusAfter

  # ---- 焦点层：t 前后原文，▶ 标出暂停那一句
  $cur = -1
  for ($i = 0; $i -lt $n; $i++) { if ([double]$cues[$i].s -le $t + 0.3) { $cur = $i } else { break } }
  $pre = New-Object System.Collections.ArrayList
  $post = New-Object System.Collections.ArrayList
  $curLine = $null
  $focusChars = 0
  $focusText = New-Object System.Text.StringBuilder
  $focusLo = $n
  for ($i = 0; $i -lt $n; $i++) {
    $c = $cues[$i]
    if ([double]$c.e -lt $lo -and $i -ne $cur) { continue }
    if ([double]$c.s -gt $hi) { break }
    if ($i -lt $focusLo) { $focusLo = $i }
    $line = '[' + (Format-Clock $c.s) + '] ' + $c.text
    $focusChars += $c.text.Length
    [void]$focusText.Append($c.text).Append(' ')
    if ($i -lt $cur) { [void]$pre.Add($line) }
    elseif ($i -eq $cur) { $curLine = '▶ ' + $line + '　← 用户在 ' + (Format-Clock $t) + ' 暂停，这是暂停时正在播（或刚播完）的一句' }
    else { [void]$post.Add($line) }
  }
  $fl = New-Object System.Collections.ArrayList
  if ($pre.Count) { [void]$fl.Add('（暂停前，用户刚听过）'); $fl.AddRange($pre) }
  if ($curLine) { [void]$fl.Add($curLine) }
  if ($post.Count) { [void]$fl.Add('（暂停后，用户还没看到）'); $fl.AddRange($post) }
  $focus = @($fl) -join "`n"

  # ---- 暂停点落在哪个小节 / 哪一章
  $ci = 0
  foreach ($c in $chunks) { if ([double]$c.s -le $t) { $ci = [int]$c.i } else { break } }
  $curChapter = $null
  $curChapterNo = 0

  # ---- 全局层
  $gl = New-Object System.Collections.ArrayList
  $ol = New-Object System.Collections.ArrayList
  if ($g) {
    if ($g.topic) { [void]$gl.Add('主题：' + $g.topic) }
    if ($g.summary) { [void]$gl.Add('主线：' + $g.summary) }
    [void]$gl.Add('章节（全长 ' + (Format-Clock $mem.duration) + '）：')
    $k = 0
    foreach ($ch in @($g.chapters)) {
      $k++
      $line = "  $k. [$(Format-Clock $ch.s)-$(Format-Clock $ch.e)] $($ch.title)"
      if ($ci -ge [int]$ch.from -and $ci -le [int]$ch.to) { $line += '　← 用户现在在这一章'; $curChapter = $ch; $curChapterNo = $k }
      [void]$gl.Add($line)
      [void]$ol.Add("[$(Format-Clock $ch.s)] $($ch.title)")
    }
    $terms = @(@($g.terms) | Where-Object { $_ -and $_.term } | Select-Object -First 12)
    if ($terms.Count) { [void]$gl.Add('关键术语：' + ((@($terms | ForEach-Object { if ($_.def) { "$($_.term)（$($_.def)）" } else { [string]$_.term } })) -join '；')) }
  } else {
    $llm = @($chunks | Where-Object { $_.src -eq 'llm' })
    if ($llm.Count) {
      [void]$gl.Add('（整片总览还在生成，先给已读完的小节标题）')
      foreach ($c in $llm) { [void]$gl.Add("  [$(Format-Clock $c.s)] $($c.title)"); [void]$ol.Add("[$(Format-Clock $c.s)] $($c.title)") }
    } else {
      [void]$gl.Add('（整片记忆还在生成，暂时只有暂停点附近的字幕）')
    }
  }

  # ---- 章节层：上一 / 当前 / 下一小节
  $sl = New-Object System.Collections.ArrayList
  if ($chunks.Count) {
    if ($curChapter) { [void]$sl.Add("所在章节：第 $curChapterNo 章「$($curChapter.title)」") }
    if ($ci -gt 0) { [void]$sl.Add((Format-ChunkLine $chunks[$ci - 1] '上一小节')) }
    [void]$sl.Add((Format-ChunkLine $chunks[$ci] '▶ 当前小节'))
    if ($ci + 1 -lt $chunks.Count) { [void]$sl.Add((Format-ChunkLine $chunks[$ci + 1] '下一小节')) }
  }

  # ---- 回溯层 ①：焦点里出现的术语，在前文第一次出现的地方（老师常说「我们前面讲过的 X」）
  $rl = New-Object System.Collections.ArrayList
  $termDefs = [ordered]@{}
  if ($g) { foreach ($tm in @($g.terms)) { if ($tm -and $tm.term -and -not $termDefs.Contains([string]$tm.term)) { $termDefs[[string]$tm.term] = [string]$tm.def } } }
  foreach ($c in $chunks) { if ($c.src -eq 'llm') { foreach ($tm in @($c.terms)) { if ($tm -and -not $termDefs.Contains([string]$tm)) { $termDefs[[string]$tm] = '' } } } }
  $probe = $focusText.ToString() + ' ' + $question
  $usedCues = @{}
  foreach ($term in @($termDefs.Keys | Sort-Object { -([string]$_).Length })) {
    if ($rl.Count -ge 2) { break }
    if ($term.Length -lt 2 -or $probe.IndexOf($term, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    $first = -1
    for ($k = 0; $k -lt $focusLo; $k++) { if ($cues[$k].text.IndexOf($term, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $first = $k; break } }
    if ($first -lt 0 -or [double]$cues[$first].s -ge $lo - 5 -or $usedCues.ContainsKey($first)) { continue }
    $usedCues[$first] = 1
    $line = "- 「$term」最早在 [$(Format-Clock $cues[$first].s)] 出现：$(Get-CueSnippet $cues $first)"
    if ($termDefs[$term]) { $line += "（术语表：$($termDefs[$term])）" }
    [void]$rl.Add($line)
  }

  # ---- 回溯层 ②：追问时按问题检索焦点之外最相关的小节（二字词 + 逆文档频率）
  if ($question -and $question -ne $T_DEFAULT_QUESTION -and $chunks.Count -ge 2) {
    $idx = Get-MemIndex $mem
    $qg = Get-Bigrams $question
    $best = -1; $bestScore = 0.0; $bestHits = 0
    for ($k = 0; $k -lt $chunks.Count; $k++) {
      $c = $chunks[$k]
      if ([double]$c.e -ge $lo -and [double]$c.s -le $hi) { continue } # 和焦点重叠的小节已经在上面了
      $score = 0.0; $hits = 0
      foreach ($q in $qg) {
        if (-not $idx.sets[$k].Contains($q)) { continue }
        $df = $idx.df[$q]
        if ($df -ge $idx.n) { continue } # 每节都有的词没有区分度
        $score += [Math]::Log(($idx.n + 1.0) / ($df + 0.5))
        $hits++
      }
      if ($hits -ge 2 -and $score -gt $bestScore) { $best = $k; $bestScore = $score; $bestHits = $hits }
    }
    if ($best -ge 0) {
      $c = $chunks[$best]
      [void]$rl.Add('- 和这次追问最相关的另一段：' + (Format-ChunkLine $c ''))
      $bk = -1; $bh = 0
      for ($k = [int]$c.a; $k -le [int]$c.b; $k++) {
        $h = 0
        foreach ($q in $qg) { if ($cues[$k].text.ToLowerInvariant().Contains($q)) { $h++ } }
        if ($h -gt $bh) { $bh = $h; $bk = $k }
      }
      if ($bk -ge 0) { [void]$rl.Add("  原文 [$(Format-Clock $cues[$bk].s)]：$(Get-CueSnippet $cues $bk)") }
    }
  }

  return @{
    used          = $true
    status        = [string]$mem.status
    source        = [string]$mem.source
    focus         = $focus
    focus_chars   = $focusChars
    global_layer  = Limit-Text (@($gl) -join "`n") 1600
    section_layer = $(if ($sl.Count) { Limit-Text (@($sl) -join "`n") 700 } else { '（无）' })
    recall_layer  = $(if ($rl.Count) { Limit-Text (@($rl) -join "`n") 600 } else { '（无）' })
    outline       = $(if ($ol.Count) { Limit-Text (@($ol) -join ' / ') 600 } else { '（无）' })
    chunk_index   = $ci
    chapter       = $(if ($curChapter) { [string]$curChapter.title } else { $null })
    chapters      = $(if ($g) { @($g.chapters).Count } else { 0 })
    recall_hits   = $rl.Count
  }
}

# 给 /explain、/followup、/route 用：没有记忆时各层填说明文字，保证提示词里不留 {{占位符}}
function Get-MemoryVars($cfg, [string]$videoId, $tSec, [string]$question, [string]$clientTranscript = '') {
  $ms = Get-MemSettings $cfg
  $empty = @{
    used = $false; status = 'none'; focus = $null; focus_chars = 0; chapters = 0; recall_hits = 0
    global_layer = '（没有整片字幕记忆，只拿到了暂停点附近的字幕）'; section_layer = '（无）'; recall_layer = '（无）'; outline = '（无）'
    focus_before = [string][int]$ms.focusBefore; focus_after = [string][int]$ms.focusAfter
  }
  if (-not $ms.enabled -or -not $videoId -or $null -eq $tSec -or [string]$tSec -eq '') { return $empty }
  try { $t = [double]$tSec } catch { return $empty }
  $mem = Get-Memory $videoId
  if (-not $mem -or @($mem.cues).Count -eq 0) { return $empty }
  try {
    $r = Get-MemoryContext $mem $t $question $ms
    $r.focus_before = $empty.focus_before
    $r.focus_after = $empty.focus_after
    # 防串台：客户端自己抓到的字幕和记忆里同一时间段的字幕几乎不重合（同一个编号换了视频、
    # 开发自测页不同课程共用一个编号……），就不用这份记忆，免得把别的视频的内容拼进提示词
    if ($clientTranscript -and $r.focus_chars -ge 10) {
      $cg = Get-Bigrams ([regex]::Replace($clientTranscript, '\[\d{1,3}:\d{2}\]', ''))
      if ($cg.Count -ge 12) {
        $fg = Get-Bigrams $r.focus
        $hit = 0
        foreach ($x in $cg) { if ($fg.Contains($x)) { $hit++ } }
        if ($hit / $cg.Count -lt 0.3) {
          Write-Host ('    整片记忆和这次的字幕对不上（重合 {0:P0}），这次不用记忆：{1}' -f ($hit / $cg.Count), $videoId) -ForegroundColor DarkYellow
          $empty.status = 'mismatch'
          return $empty
        }
      }
    }
    return $r
  } catch {
    Write-Host ('    拼装整片记忆失败：' + $_.Exception.Message) -ForegroundColor DarkYellow
    $empty.status = 'error'
    return $empty
  }
}

# ---------------------------------------------------------------- HTTP 小工具
function Set-Cors($res) {
  $res.AddHeader('Access-Control-Allow-Origin', '*')
  $res.AddHeader('Access-Control-Allow-Headers', 'Content-Type')
  $res.AddHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  $res.AddHeader('Access-Control-Allow-Private-Network', 'true')
}

function Send-Json($ctx, [int]$status, $obj) {
  $res = $ctx.Response
  $bytes = $Utf8.GetBytes((ConvertTo-Json -InputObject $obj -Depth 10 -Compress))
  $res.StatusCode = $status
  $res.ContentType = 'application/json; charset=utf-8'
  Set-Cors $res
  $res.ContentLength64 = $bytes.Length
  # HEAD 请求只回头部（之前照样写 body，会报「写入流的字节超出 Content-Length」）
  if ($ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
  $res.OutputStream.Close()
}

function Read-Body($ctx) {
  $sr = New-Object IO.StreamReader($ctx.Request.InputStream, $Utf8)
  $raw = $sr.ReadToEnd()
  $sr.Close()
  if (-not $raw.Trim()) { return (New-Object PSObject) }
  try { return ($raw | ConvertFrom-Json) } catch { throw "请求体不是合法 JSON：$($_.Exception.Message)" }
}

function Start-Sse($ctx) {
  $res = $ctx.Response
  $res.StatusCode = 200
  $res.ContentType = 'text/event-stream; charset=utf-8'
  $res.SendChunked = $true
  $res.AddHeader('Cache-Control', 'no-cache')
  Set-Cors $res
}

function Send-Sse($ctx, $obj) {
  $bytes = $Utf8.GetBytes('data: ' + (ConvertTo-Json -InputObject $obj -Depth 10 -Compress) + "`n`n")
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $ctx.Response.OutputStream.Flush()
}

# ---------------------------------------------------------------- /health
function Invoke-Health($ctx) {
  $cfg = Get-Config
  $files = @(Get-ChildItem -Path $PromptDir -Filter '*.md' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  Send-Json $ctx 200 ([ordered]@{
      ok          = $true
      name        = 'coaxly-proxy'
      version     = $VERSION
      hasKey      = (Test-HasKey $cfg)
      baseUrl     = [string]$cfg.baseUrl
      model       = [string]$cfg.model
      visionModel = [string]$cfg.visionModel
      sendImage   = ($cfg.sendImage -ne $false)
      ocr         = ($cfg.ocr -ne $false)
      ocrReady    = $(if ($cfg.ocr -ne $false) { [bool](Initialize-Ocr).ok } else { $false })
      ocrError    = $(if ($cfg.ocr -ne $false) { (Initialize-Ocr).error } else { $null })
      asrEngine   = $cfg.asrEngine
      asrReady    = $(if ($cfg.asrEngine -ne 'off') { [bool](Initialize-Asr).ok } else { $false })
      asrError    = $(if ($cfg.asrEngine -ne 'off') { (Initialize-Asr).error } else { $null })
      asrModel    = $(if ($cfg.asrEngine -eq 'cloud') { [string](Get-Field $cfg.asr 'model' '') } else { $null })
      features    = @('explain', 'route', 'followup', 'ocr', 'asr', 'summarize', 'keypoints', 'memory')
      memory      = [ordered]@{ enabled = (Get-MemSettings $cfg).enabled; building = @($script:MemJobs.Keys) }
      prompts     = $files
    })
  return 'ok'
}

# ---------------------------------------------------------------- /route（Call 1 单独调用）
function Invoke-RouteEndpoint($ctx, $body) {
  $cfg = Get-Config
  $vars = @{
    subject    = Get-NonEmpty $body 'subject' $T_UNKNOWN_SUBJECT
    timestamp  = Get-NonEmpty $body 'timestamp' '00:00'
    transcript = [string](Get-Field $body 'transcript' '')
    question   = Get-NonEmpty $body 'question' ''
  }
  $mem = Get-MemoryVars $cfg ([string](Get-Field $body 'video_id' '')) (Get-Field $body 't_sec' $null) $vars.question $vars.transcript
  $vars.outline = $mem.outline
  if ($mem.focus -and $mem.focus_chars -ge (Get-TranscriptBodyLength $vars.transcript)) { $vars.transcript = $mem.focus }
  $meta = @{ session_id = (Get-Field $body 'session_id' $null); video_id = (Get-Field $body 'video_id' $null) }
  $r = Invoke-Router $cfg $vars $meta
  Send-Json $ctx 200 ([ordered]@{ route = $r.route; redirect = $r.redirect; fallback = [bool]$r.fallback; error = $r.error; total_ms = $r.ms })
  return "route=$($r.route) fallback=$([bool]$r.fallback)"
}

# ---------------------------------------------------------------- /explain（Call 2）
# $textQuestion：纯文本调用时发的用户消息（可能已经拼上了画面文字）
function Invoke-Call2Once($cfg, [string]$system, [string]$question, [string]$textQuestion, [string]$image, [bool]$useImage, [double]$temperature) {
  $visionError = $null
  $screenText = ''
  if ($useImage) {
    $content = @(
      [ordered]@{ type = 'text'; text = $question },
      [ordered]@{ type = 'image_url'; image_url = [ordered]@{ url = $image } }
    )
    $r = Invoke-Chat $cfg ([string]$cfg.visionModel) $system $content $temperature 400 $null
    if ($r.ok) { $r.vision_used = $true; $r.model = [string]$cfg.visionModel; return $r }
    # 规格 2.4：视觉调用失败 → 自动回落纯文本重试一次（这时用本地文字识别补上画面里的字）
    $visionError = $r.error
    Write-Host ('    视觉调用失败，回落纯文本：' + (Limit-Text $r.error 160)) -ForegroundColor DarkYellow
    if ($textQuestion -eq $question) {
      $screenText = Format-ScreenText (Get-FrameText $cfg $image)
      if ($screenText) { $textQuestion = $question + "`n`n" + $screenText }
    }
  }
  $r = Invoke-Chat $cfg ([string]$cfg.model) $system $textQuestion $temperature 400 $null
  $r.vision_used = $false
  $r.model = [string]$cfg.model
  $r.vision_error = $visionError
  $r.screen_text = $screenText
  return $r
}

function Invoke-Explain($ctx, $body) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $cfg = Get-Config
  $question = Get-NonEmpty $body 'question' $T_DEFAULT_QUESTION
  $timestamp = Get-NonEmpty $body 'timestamp' '00:00'
  $transcript = [string](Get-Field $body 'transcript' '')
  $clientTranscriptLen = $transcript.Length
  $image = [string](Get-Field $body 'image' '')
  $wantImage = ($image.StartsWith('data:image/') -and ($cfg.sendImage -ne $false))

  # 整片记忆（v1.4）：有记忆时，焦点层从整片字幕里按暂停点重新截取——
  # 包括用户还没播到的后 30 秒，并标出暂停那一句；另外拼上全局层、章节层、回溯层
  $mem = Get-MemoryVars $cfg ([string](Get-Field $body 'video_id' '')) (Get-Field $body 't_sec' $null) $question $transcript
  $useMemFocus = ($mem.used -and $mem.focus -and $mem.focus_chars -ge [Math]::Floor(0.8 * (Get-TranscriptBodyLength $transcript)))
  $promptTranscript = if ($useMemFocus) { $mem.focus } else { $transcript }

  # 模型不看图时，用本地文字识别读出画面上的字（含烧在画面里的硬字幕）
  $frameText = $null
  if (-not $wantImage) { $frameText = Get-FrameText $cfg $image }
  if ($frameText -and $frameText.ok) {
    $transcript = Add-SubtitleToTranscript $transcript $timestamp $frameText.subtitle
    $promptTranscript = Add-SubtitleToTranscript $promptTranscript $timestamp $frameText.subtitle
  }
  $screenText = Format-ScreenText $frameText
  $textQuestion = if ($screenText) { $question + "`n`n" + $screenText } else { $question }

  $degraded = if ($useMemFocus) { ((Get-TranscriptBodyLength $transcript) -lt 10 -and $mem.focus_chars -lt 10) } else { ((Get-TranscriptBodyLength $promptTranscript) -lt 10) }
  $route = [string](Get-Field $body 'route' 'in_video')
  if ($ROUTES -notcontains $route) { $route = 'in_video' }
  $vars = @{
    subject       = Get-NonEmpty $body 'subject' $T_UNKNOWN_SUBJECT
    timestamp     = $timestamp
    transcript    = $promptTranscript
    question      = $question
    past          = Format-Past (Get-Field $body 'past' $null)
    route         = $route
    global_layer  = $mem.global_layer
    section_layer = $mem.section_layer
    recall_layer  = $mem.recall_layer
    focus_before  = $mem.focus_before
    focus_after   = $mem.focus_after
  }
  $promptFile = if ($degraded) { 'call2_degraded.md' } else { 'call2_explain.md' }
  $system = Fill-Template (Read-Prompt $promptFile) $vars

  $rec = [ordered]@{
    type               = 'call2'
    session_id         = Get-Field $body 'session_id' $null
    video_id           = Get-Field $body 'video_id' $null
    timestamp          = $vars.timestamp
    subject            = $vars.subject
    trigger            = Get-Field $body 'trigger' 'button'
    route              = $route
    degraded           = $degraded
    prompt_file        = $promptFile
    transcript_len     = $transcript.Length
    transcript_snippet = $transcript
    user_question      = $question
    frame_sent         = $wantImage
    client_transcript_len = $clientTranscriptLen
    ocr_used           = [bool]$screenText
    ocr_subtitle       = if ($frameText) { $frameText.subtitle } else { $null }
    ocr_ms             = if ($frameText) { $frameText.ms } else { $null }
    ocr_error          = if ($frameText) { $frameText.error } else { $null }
    t_sec              = Get-Field $body 't_sec' $null
    memory_status      = $mem.status
    memory_focus       = $useMemFocus
    memory_chapter     = $mem.chapter
    memory_layer_chars = [ordered]@{ global = $mem.global_layer.Length; section = $mem.section_layer.Length; focus = $promptTranscript.Length; recall = $mem.recall_layer.Length }
    recall_hits        = $mem.recall_hits
  }
  if ($useMemFocus) { $rec.prompt_transcript = $promptTranscript }
  $memInfo = [ordered]@{ used = [bool]$mem.used; status = $mem.status; focus = $useMemFocus; chapters = $mem.chapters; chapter = $mem.chapter; recall_hits = $mem.recall_hits }

  if (-not (Test-HasKey $cfg)) {
    $rec.error = 'no_api_key'
    Write-CallLog $rec
    Send-Json $ctx 400 @{ error = $T_NO_KEY; code = 'no_api_key' }
    return 'no api key'
  }

  $first = Invoke-Call2Once $cfg $system $question $textQuestion $image $wantImage 0.4
  if ($first.screen_text) {
    # 视觉调用失败回落纯文本时补上的画面文字，重试和追问也沿用
    $screenText = $first.screen_text
    $textQuestion = $question + "`n`n" + $screenText
    $rec.ocr_used = $true
  }
  if (-not $first.ok) {
    $rec.error = $first.error
    $rec.vision_error = $first.vision_error
    $rec.total_ms = $sw.ElapsedMilliseconds
    Write-CallLog $rec
    Send-Json $ctx 502 @{ error = $first.error; code = 'upstream_error' }
    return 'upstream error'
  }

  $m1 = Measure-Explain $first.text
  $final = $m1
  $finalModel = $first.model
  $visionUsed = [bool]$first.vision_used
  $retried = $false
  $retryChars = $null
  if ($m1.chars -gt $CALL2_LIMIT) {
    # 规格 4.4：超长 → temperature 0.2 + 追加约束，重试一次，更短才采用
    $retried = $true
    $system2 = $system + "`n`n" + (Read-Prompt 'call2_retry_suffix.md')
    $second = Invoke-Call2Once $cfg $system2 $question $textQuestion $image $visionUsed 0.2
    if ($second.ok) {
      $m2 = Measure-Explain $second.text
      $retryChars = $m2.chars
      if ($m2.chars -lt $m1.chars) { $final = $m2; $finalModel = $second.model; $visionUsed = [bool]$second.vision_used }
    }
  }

  $violation = ($final.chars -gt $CALL2_LIMIT)
  $rec.model = $finalModel
  $rec.vision_used = $visionUsed
  $rec.vision_error = $first.vision_error
  $rec.call2_output = $final.text
  $rec.call2_chars = $final.chars
  $rec.seg_count = $final.seg_count
  $rec.seg_lengths = $final.seg_lengths
  $rec.length_violation = $violation
  $rec.retried = $retried
  $rec.first_chars = $m1.chars
  $rec.retry_chars = $retryChars
  $rec.total_ms = $sw.ElapsedMilliseconds
  Write-CallLog $rec

  Send-Json $ctx 200 ([ordered]@{
      text             = $final.text
      segments         = $final.segments
      chars            = $final.chars
      seg_count        = $final.seg_count
      seg_lengths      = $final.seg_lengths
      length_violation = $violation
      retried          = $retried
      degraded         = $degraded
      frame_sent       = $wantImage
      vision_used      = $visionUsed
      ocr_used         = [bool]$screenText
      screen_text      = $screenText
      transcript       = $transcript
      route            = $route
      model            = $finalModel
      memory           = $memInfo
      total_ms         = $sw.ElapsedMilliseconds
    })
  $flag = if ($violation) { ' 超长!' } else { '' }
  $deg = if ($degraded) { ' 降级' } else { '' }
  $ocrFlag = if (-not $screenText) { '' } elseif ($frameText) { " 画面文字=$($frameText.ms)ms" } else { ' 画面文字' }
  $memFlag = if ($mem.used) { " 记忆=$($mem.status)$(if ($mem.chapter) { '/' + $mem.chapter })$(if ($mem.recall_hits) { ' 回溯' + $mem.recall_hits })" } else { '' }
  return "call2 $($final.chars)字 段长[$(@($final.seg_lengths) -join ',')]$flag$deg 图=$visionUsed$ocrFlag 重试=$retried$memFlag"
}

# ---------------------------------------------------------------- /followup（Call 3，流式）
function Invoke-Followup($ctx, $body) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $cfg = Get-Config
  $followUp = Get-NonEmpty $body 'follow_up' ''
  if (-not $followUp) { Send-Json $ctx 400 @{ error = 'follow_up 不能为空' }; return 'empty follow_up' }

  $transcript = [string](Get-Field $body 'transcript' '')
  # 整片记忆（v1.4）：追问时回溯层额外按「这句追问」检索焦点之外最相关的小节
  $mem = Get-MemoryVars $cfg ([string](Get-Field $body 'video_id' '')) (Get-Field $body 't_sec' $null) $followUp $transcript
  $useMemFocus = ($mem.used -and $mem.focus -and $mem.focus_chars -ge [Math]::Floor(0.8 * (Get-TranscriptBodyLength $transcript)))
  if ($useMemFocus) { $transcript = $mem.focus }
  $degraded = if ($useMemFocus) { $mem.focus_chars -lt 10 } else { ((Get-TranscriptBodyLength $transcript) -lt 10) }
  $meta = @{ session_id = (Get-Field $body 'session_id' $null); video_id = (Get-Field $body 'video_id' $null) }
  $mode = if ([string](Get-Field $body 'mode' 'direct') -eq 'socratic') { 'socratic' } else { 'direct' }
  $timestamp = Get-NonEmpty $body 'timestamp' '00:00'
  $route = [string](Get-Field $body 'route' '')
  if ($ROUTES -notcontains $route) { $route = '' }

  $rec = [ordered]@{
    type       = 'call3'
    session_id = $meta.session_id
    video_id   = $meta.video_id
    timestamp  = $timestamp
    follow_up  = $followUp
    mode       = $mode
    turn_index = Get-Field $body 'turn_index' $null
    degraded   = $degraded
    t_sec          = Get-Field $body 't_sec' $null
    memory_status  = $mem.status
    memory_focus   = $useMemFocus
    memory_chapter = $mem.chapter
    recall_hits    = $mem.recall_hits
    recall_layer   = $(if ($mem.recall_hits) { $mem.recall_layer } else { $null })
  }

  Start-Sse $ctx
  $clientGone = $false
  $text = New-Object System.Text.StringBuilder
  $firstMs = $null
  $streamError = $null
  try {
    # 规格 3.1：首轮追问才路由；同一浮层后续追问沿用结论（由客户端带上 route）
    if (-not $route) {
      if ($degraded) {
        $routeInfo = @{ route = 'in_video'; redirect = $null; fallback = $false }
      } else {
        $routeInfo = Invoke-Router $cfg @{
          subject    = Get-NonEmpty $body 'subject' $T_UNKNOWN_SUBJECT
          timestamp  = $timestamp
          transcript = $transcript
          question   = $followUp
          outline    = $mem.outline
        } $meta
      }
      $route = $routeInfo.route
      $rec.routed_now = $true
      Send-Sse $ctx ([ordered]@{ type = 'route'; route = $route; redirect = $routeInfo.redirect; fallback = [bool]$routeInfo.fallback })
      if ($route -eq 'off_topic') {
        $rec.route = $route
        $rec.call3_output = $routeInfo.redirect
        $rec.skipped = 'off_topic'
        Send-Sse $ctx ([ordered]@{ type = 'done'; off_topic = $true; total_ms = $sw.ElapsedMilliseconds })
        return 'call3 skipped (off_topic)'
      }
    }
    $rec.route = $route

    if (-not (Test-HasKey $cfg)) {
      $rec.error = 'no_api_key'
      Send-Sse $ctx @{ type = 'error'; message = $T_NO_KEY }
      return 'no api key'
    }

    $modeInfo = Read-Mode $mode
    $call2 = Get-NonEmpty $body 'call2_output' '（无）'
    $vars = @{
      original_concept = Get-NonEmpty $body 'original_concept' $T_DEFAULT_CONCEPT
      mode_label       = $modeInfo.label
      mode_rules       = $modeInfo.rules
      call2_output     = $call2
      follow_up        = $followUp
      history_summary  = Format-History (Get-Field $body 'history' $null)
      transcript       = $(if ($degraded) { $T_NO_TRANSCRIPT } else { $transcript })
      global_layer     = $mem.global_layer
      section_layer    = $mem.section_layer
      recall_layer     = $mem.recall_layer
      focus_before     = $mem.focus_before
      focus_after      = $mem.focus_after
    }
    $system = Fill-Template (Read-Prompt 'call3_followup.md') $vars
    # 讲解时本地文字识别读出的画面文字，追问时也带上（模型看不了图，只能靠这个知道画面上写了什么）
    $userMsg = $followUp
    $screenText = Limit-Text ([string](Get-Field $body 'screen_text' '')) 800
    if ($screenText.Trim()) { $userMsg = $followUp + "`n`n" + $screenText; $rec.screen_text_sent = $true }
    $payload = [ordered]@{
      model       = [string]$cfg.model
      messages    = @(
        [ordered]@{ role = 'system'; content = $system },
        [ordered]@{ role = 'user'; content = $userMsg }
      )
      temperature = 0.6
      max_tokens  = 400
      stream      = $true
    }
    $r = Send-Upstream $cfg $payload $true
    if (-not $r.ok) {
      $rec.error = $r.error
      Send-Sse $ctx @{ type = 'error'; message = $r.error }
      return 'upstream error'
    }

    $stream = $r.response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $reader = New-Object IO.StreamReader($stream, $Utf8)
    $nonSse = New-Object System.Text.StringBuilder
    try {
      while ($true) {
        $line = $reader.ReadLine()
        if ($null -eq $line) { break }
        if (-not $line.StartsWith('data:')) { [void]$nonSse.AppendLine($line); continue }
        $data = $line.Substring(5).Trim()
        if ($data -eq '[DONE]') { break }
        if (-not $data) { continue }
        try { $chunk = $data | ConvertFrom-Json } catch { continue }
        $errObj = Get-Field $chunk 'error' $null
        if ($errObj) { $streamError = '上游流式报错：' + (Limit-Text ([string](Get-Field $errObj 'message' $data)) 300); break }
        $delta = $null
        try { $delta = $chunk.choices[0].delta.content } catch {}
        if ($delta) {
          if ($null -eq $firstMs) { $firstMs = $sw.ElapsedMilliseconds }
          [void]$text.Append([string]$delta)
          try { Send-Sse $ctx @{ type = 'delta'; text = [string]$delta } }
          catch { $clientGone = $true; break }
        }
      }
    } catch {
      $streamError = '读取上游流时中断：' + $_.Exception.Message
    } finally {
      $reader.Dispose()
      $r.response.Dispose()
    }

    # 上游无视 stream=true、直接回了一整块 JSON 的情况
    if ($text.Length -eq 0 -and -not $streamError -and $nonSse.Length -gt 0) {
      try {
        $whole = $nonSse.ToString() | ConvertFrom-Json
        $c = [string]$whole.choices[0].message.content
        if ($c) {
          $firstMs = $sw.ElapsedMilliseconds
          [void]$text.Append($c)
          Send-Sse $ctx @{ type = 'delta'; text = $c }
        }
      } catch {}
    }

    if (-not $clientGone) {
      if ($streamError) { Send-Sse $ctx @{ type = 'error'; message = $streamError; partial = $true } }
      $out = $text.ToString()
      Send-Sse $ctx ([ordered]@{
          type           = 'done'
          call3_chars    = ($out -replace '\s', '').Length
          first_token_ms = $firstMs
          total_ms       = $sw.ElapsedMilliseconds
        })
    }
    return "call3 $mode $(($text.ToString() -replace '\s', '').Length)字 首字=${firstMs}ms" + $(if ($clientGone) { ' (客户端已断开)' } else { '' })
  } catch {
    $rec.error = $_.Exception.Message
    try { Send-Sse $ctx @{ type = 'error'; message = '代理内部错误：' + $_.Exception.Message } } catch { $clientGone = $true }
    return 'call3 failed: ' + $_.Exception.Message
  } finally {
    if (-not $rec.Contains('call3_output')) { $rec.call3_output = $text.ToString() }
    $rec.call3_chars = ($rec.call3_output -replace '\s', '').Length
    $rec.first_token_ms = $firstMs
    $rec.total_ms = $sw.ElapsedMilliseconds
    $rec.aborted = $clientGone
    if ($streamError) { $rec.error = $streamError }
    Write-CallLog $rec
    try { $ctx.Response.OutputStream.Close() } catch {}
  }
}

# ---------------------------------------------------------------- /ocr（画面识字）
# 扩展播放时每隔一会儿送来画面底部条带（region=subtitle），用来收集烧在画面里的硬字幕。
# 调用很频繁，所以不在窗口里逐条打印（返回 'quiet'）。
function Invoke-OcrEndpoint($ctx, $body) {
  $cfg = Get-Config
  if ($cfg.ocr -eq $false) {
    Send-Json $ctx 200 ([ordered]@{ ok = $false; code = 'ocr_disabled'; error = '配置里关掉了画面识字（ocr: false）' })
    return 'quiet'
  }
  $region = if ([string](Get-Field $body 'region' 'subtitle') -eq 'full') { 'full' } else { 'subtitle' }
  $o = Invoke-Ocr ([string](Get-Field $body 'image' ''))
  if (-not $o.ok) {
    Send-Json $ctx 200 ([ordered]@{ ok = $false; code = $o.code; error = $o.error })
    return 'quiet'
  }
  $s = Split-OcrText $o $region
  Send-Json $ctx 200 ([ordered]@{
      ok       = $true
      subtitle = $s.subtitle
      other    = @($s.other)
      width    = $o.width
      height   = $o.height
      ms       = $o.ms
    })
  return 'quiet'
}

# ---------------------------------------------------------------- 语音识别（v1.2）
# Chrome 自带的语音识别要连 Google，国内用不了。v1.2 改成：扩展只录音（16kHz 单声道 WAV），这里识别。
# 默认用 Windows 自带的离线中文识别（System.Speech）：不联网、不花钱，短句 100ms 以内。
# 听写语法之外再加一组「快捷回复」短语语法：纯听写会把「懂了」听成「读了」，加上之后短句基本都准。
# 可选：config.json 的 asr.engine = "cloud" 时走任一 OpenAI 兼容的 /audio/transcriptions，失败自动退回本机。
$ASR_QUICK_PHRASES = @(
  '懂了', '明白了', '知道了', '听懂了', '还是不懂', '没懂', '不懂', '听不懂', '没听懂',
  '展开讲讲', '展开说说', '详细说说', '多讲一点', '再讲一遍', '换个说法', '举个例子', '再举个例子',
  '是', '是的', '对', '对的', '不是', '不对', '不确定', '不知道', '继续',
  '用你自己的知识解释一下', '不管视频直接讲', '不用管视频'
)
$script:AsrState = $null

function Initialize-Asr {
  if ($null -ne $script:AsrState) { return $script:AsrState }
  $st = @{ ok = $false; error = $null; engine = $null; lang = ''; name = '' }
  try {
    if ($PSVersionTable.PSEdition -eq 'Core') { throw '本机语音识别需要 Windows PowerShell 5.1（用 启动.bat 启动即可）' }
    Add-Type -AssemblyName System.Speech
    $info = $null
    foreach ($r in [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()) {
      if ($r.Culture.Name -like 'zh-CN*' -or $r.Culture.Name -like 'zh-Hans*') { $info = $r; break }
    }
    if (-not $info) { throw '系统里没有中文语音识别引擎（设置 → 时间和语言 → 语言和区域 → 中文(简体) → 语言选项 → 安装「语音识别」）' }
    $eng = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
    $dict = New-Object System.Speech.Recognition.DictationGrammar
    $dict.Name = 'dictation'
    $eng.LoadGrammar($dict)
    $choices = New-Object System.Speech.Recognition.Choices
    $choices.Add([string[]]$ASR_QUICK_PHRASES)
    $gb = New-Object System.Speech.Recognition.GrammarBuilder($choices)
    $gb.Culture = $info.Culture
    $quick = New-Object System.Speech.Recognition.Grammar($gb)
    $quick.Name = 'quick'
    $eng.LoadGrammar($quick)
    $st.engine = $eng
    $st.lang = [string]$info.Culture.Name
    $st.name = [string]$info.Name
    $st.ok = $true
  } catch {
    $st.error = $_.Exception.Message
  }
  $script:AsrState = $st
  return $st
}

# 把 data:audio/wav;base64,... 解成字节，并确认是 WAV（RIFF....WAVE）
function ConvertFrom-AudioDataUrl([string]$dataUrl) {
  $comma = $dataUrl.IndexOf(',')
  if (-not $dataUrl.StartsWith('data:audio/') -or $comma -lt 0) { return $null }
  try { $bytes = [Convert]::FromBase64String($dataUrl.Substring($comma + 1)) } catch { return $null }
  if ($bytes.Length -lt 44) { return $null }
  if ([Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'RIFF' -or [Text.Encoding]::ASCII.GetString($bytes, 8, 4) -ne 'WAVE') { return $null }
  return , $bytes
}

function Get-WavSeconds([byte[]]$wav) {
  try {
    $ch = [BitConverter]::ToInt16($wav, 22)
    $rate = [BitConverter]::ToInt32($wav, 24)
    $bits = [BitConverter]::ToInt16($wav, 34)
    $bps = [double]$rate * $ch * ($bits / 8)
    if ($bps -le 0) { return 0 }
    return [math]::Round(($wav.Length - 44) / $bps, 1)
  } catch { return 0 }
}

function Invoke-LocalAsr([byte[]]$wav) {
  $st = Initialize-Asr
  if (-not $st.ok) { return @{ ok = $false; code = 'asr_unavailable'; error = $st.error; engine = 'local' } }
  $ms = New-Object System.IO.MemoryStream(, $wav)
  $parts = New-Object System.Collections.ArrayList
  $confs = New-Object System.Collections.ArrayList
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $st.engine.SetInputToWaveStream($ms)
    # 一段录音里可能有好几句（中间停顿过），逐句识别直到音频读完；读完后再调用会抛 InvalidOperationException
    for ($i = 0; $i -lt 30 -and $sw.ElapsedMilliseconds -lt 8000; $i++) {
      $r = $null
      try { $r = $st.engine.Recognize() } catch { break }
      if (-not $r) {
        if ($ms.Position -ge $ms.Length) { break }
        continue
      }
      $t = ([string]$r.Text).Trim()
      if ($t) { [void]$parts.Add($t); [void]$confs.Add([math]::Round($r.Confidence, 2)) }
    }
  } catch {
    return @{ ok = $false; code = 'asr_failed'; error = '语音识别失败：' + $_.Exception.Message; engine = 'local' }
  } finally {
    try { $st.engine.SetInputToNull() } catch {}
    $ms.Dispose()
  }
  # 只有英文/数字之间才需要空格；中文听写结果里偶尔夹的空格去掉
  $text = [regex]::Replace(($parts -join ''), '(?<=[^A-Za-z0-9])\s+|\s+(?=[^A-Za-z0-9])', '')
  return @{ ok = $true; text = $text; engine = 'local'; confidence = @($confs); ms = $sw.ElapsedMilliseconds }
}

function Invoke-CloudAsr($cfg, [byte[]]$wav) {
  $a = $cfg.asr
  $base = [string](Get-Field $a 'baseUrl' '')
  if (-not $base.Trim()) { $base = [string]$cfg.baseUrl }
  $key = [string](Get-Field $a 'apiKey' '')
  if (-not $key.Trim()) { $key = [string]$cfg.apiKey }
  $model = [string](Get-Field $a 'model' '')
  if (-not $model.Trim()) { return @{ ok = $false; error = 'config.json 里 asr.model 没填' } }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $client = Get-HttpClient $cfg
  $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Post, $base.TrimEnd('/') + '/audio/transcriptions')
  [void]$req.Headers.TryAddWithoutValidation('Authorization', 'Bearer ' + $key.Trim())
  $form = New-Object System.Net.Http.MultipartFormDataContent
  $file = New-Object System.Net.Http.ByteArrayContent(, $wav)
  $file.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('audio/wav')
  $form.Add($file, 'file', 'speech.wav')
  $form.Add((New-Object System.Net.Http.StringContent($model)), 'model')
  $form.Add((New-Object System.Net.Http.StringContent('zh')), 'language')
  $form.Add((New-Object System.Net.Http.StringContent('json')), 'response_format')
  $req.Content = $form
  try {
    $resp = $client.SendAsync($req).GetAwaiter().GetResult()
  } catch {
    $e = $_.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    return @{ ok = $false; error = '云端语音识别请求失败：' + $e.Message }
  }
  try {
    $raw = $Utf8.GetString($resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult())
    if (-not $resp.IsSuccessStatusCode) { return @{ ok = $false; error = "云端语音识别返回 HTTP $([int]$resp.StatusCode)：" + (Limit-Text $raw 300) } }
  } finally { $resp.Dispose() }
  try { $obj = $raw | ConvertFrom-Json } catch { return @{ ok = $false; error = '云端语音识别返回的不是 JSON：' + (Limit-Text $raw 200) } }
  $text = ([string](Get-Field $obj 'text' '')).Trim()
  return @{ ok = $true; text = $text; engine = 'cloud'; model = $model; ms = $sw.ElapsedMilliseconds }
}

function Invoke-AsrEndpoint($ctx, $body) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $cfg = Get-Config
  $rec = [ordered]@{
    type       = 'asr'
    session_id = Get-Field $body 'session_id' $null
    video_id   = Get-Field $body 'video_id' $null
    engine     = $cfg.asrEngine
    reason     = Get-Field $body 'reason' $null
  }
  if ($cfg.asrEngine -eq 'off') {
    Send-Json $ctx 200 ([ordered]@{ ok = $false; code = 'asr_disabled'; error = '配置里关掉了语音识别（asr.engine = "off"）' })
    return 'asr disabled'
  }
  $wav = ConvertFrom-AudioDataUrl ([string](Get-Field $body 'audio' ''))
  if (-not $wav) {
    Send-Json $ctx 400 ([ordered]@{ ok = $false; code = 'bad_audio'; error = '收到的不是 WAV 录音' })
    return 'asr bad audio'
  }
  $rec.audio_sec = Get-WavSeconds $wav
  $r = $null
  if ($cfg.asrEngine -eq 'cloud') {
    $r = Invoke-CloudAsr $cfg $wav
    if (-not $r.ok) {
      $rec.cloud_error = $r.error
      Write-Host ('    云端语音识别失败，改用本机识别：' + (Limit-Text $r.error 160)) -ForegroundColor DarkYellow
      $r = $null
    }
  }
  if (-not $r) { $r = Invoke-LocalAsr $wav }
  $text = [string]$r.text
  $rec.engine_used = $r.engine
  $rec.ok = [bool]$r.ok
  $rec.text = $text
  $rec.chars = ($text -replace '\s', '').Length
  $rec.error = $r.error
  $rec.total_ms = $sw.ElapsedMilliseconds
  Write-CallLog $rec
  Send-Json $ctx 200 ([ordered]@{
      ok          = [bool]$r.ok
      text        = $text
      engine      = $r.engine
      code        = $r.code
      error       = $r.error
      cloud_error = $rec.cloud_error
      audio_sec   = $rec.audio_sec
      total_ms    = $sw.ElapsedMilliseconds
    })
  if (-not $r.ok) { return 'asr failed: ' + (Limit-Text ([string]$r.error) 80) }
  return "asr $($r.engine) 音频$($rec.audio_sec)s → $($rec.chars)字「$(Limit-Text $text 20)」"
}

# ---------------------------------------------------------------- /summarize（Call 4：历史节点的一句话说明，v1.2）
function Format-Turns($turns) {
  $items = @($turns | Where-Object { $_ })
  if ($items.Count -eq 0) { return '（没有追问）' }
  $i = 0
  $lines = foreach ($t in @($items | Select-Object -Last 6)) {
    $i++
    $q = Limit-Text ([string](Get-Field $t 'q' '')) 40
    $a = Limit-Text (([string](Get-Field $t 'a' '')) -replace '\s+', ' ') 60
    "${i}. 问：$q → 答：$a"
  }
  return (@($lines) -join "`n")
}

function ConvertTo-OneLine([string]$text) {
  $t = Remove-Markdown $text
  $line = [string](@($t -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }) | Select-Object -First 1)
  $line = [regex]::Replace($line, '^(一句话说明|说明|总结)[：:]\s*', '').Trim()
  # 只剥「整句外面的一对引号」：“线性无关”就是…… 这种开头的引号属于内容，不能剥
  foreach ($pair in @(@([char]'"', [char]'"'), @([char]0x201C, [char]0x201D), @([char]0x300C, [char]0x300D), @([char]0x0027, [char]0x0027))) {
    if ($line.Length -ge 2 -and $line[0] -eq $pair[0] -and $line[$line.Length - 1] -eq $pair[1]) {
      $inner = $line.Substring(1, $line.Length - 2)
      $open = @($inner.ToCharArray() | Where-Object { $_ -eq $pair[0] }).Count
      $close = @($inner.ToCharArray() | Where-Object { $_ -eq $pair[1] }).Count
      if ($pair[0] -eq $pair[1] -or $open -eq $close) { $line = $inner.Trim() }
      break
    }
  }
  $line = $line.TrimEnd([char]0x3002, [char]'.')
  return (Limit-Text $line 40)
}

function Invoke-SummarizeEndpoint($ctx, $body) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $cfg = Get-Config
  $turns = @(Get-Field $body 'turns' @())
  $transcript = [string](Get-Field $body 'transcript' '')
  if ($transcript.Length -gt 600) { $transcript = '…' + $transcript.Substring($transcript.Length - 600) }
  $vars = @{
    subject          = Get-NonEmpty $body 'subject' $T_UNKNOWN_SUBJECT
    timestamp        = Get-NonEmpty $body 'timestamp' '00:00'
    original_concept = Get-NonEmpty $body 'original_concept' $T_DEFAULT_CONCEPT
    transcript       = $(if ((Get-TranscriptBodyLength $transcript) -lt 10) { $T_NO_TRANSCRIPT } else { $transcript })
    call2_output     = Get-NonEmpty $body 'call2_output' '（无）'
    turns            = Format-Turns $turns
    turn_count       = [string]$turns.Count
  }
  $rec = [ordered]@{
    type       = 'call4'
    session_id = Get-Field $body 'session_id' $null
    video_id   = Get-Field $body 'video_id' $null
    node_id    = Get-Field $body 'node_id' $null
    timestamp  = $vars.timestamp
    turn_count = $turns.Count
  }
  if (-not (Test-HasKey $cfg)) {
    $rec.error = 'no_api_key'
    Write-CallLog $rec
    Send-Json $ctx 400 @{ error = $T_NO_KEY; code = 'no_api_key' }
    return 'no api key'
  }
  $system = Fill-Template (Read-Prompt 'call4_summary.md') $vars
  $r = Invoke-Chat $cfg ([string]$cfg.model) $system '请写这条学习记录的一句话说明。' 0.3 80 $null
  if (-not $r.ok) {
    $rec.error = $r.error
    $rec.total_ms = $sw.ElapsedMilliseconds
    Write-CallLog $rec
    Send-Json $ctx 502 @{ error = $r.error; code = 'upstream_error' }
    return 'call4 upstream error'
  }
  $summary = ConvertTo-OneLine $r.text
  $rec.summary = $summary
  $rec.chars = ($summary -replace '\s', '').Length
  $rec.total_ms = $sw.ElapsedMilliseconds
  Write-CallLog $rec
  Send-Json $ctx 200 ([ordered]@{ ok = $true; summary = $summary; chars = $rec.chars; model = [string]$cfg.model; total_ms = $sw.ElapsedMilliseconds })
  return "call4 $($rec.chars)字「$summary」"
}

# ---------------------------------------------------------------- /memory/*（整片字幕记忆，v1.4）
function Get-MemStatusObj($mem) {
  if (-not $mem) { return [ordered]@{ status = 'none' } }
  $chunks = @($mem.chunks)
  return [ordered]@{
    status     = [string]$mem.status
    source     = [string]$mem.source
    hash       = [string]$mem.hash
    cues       = @($mem.cues).Count
    chunks     = $chunks.Count
    chunks_llm = @($chunks | Where-Object { $_.src -eq 'llm' }).Count
    chapters   = $(if ($mem.global) { @($mem.global.chapters).Count } else { 0 })
    topic      = $(if ($mem.global) { [string]$mem.global.topic } else { $null })
    progress   = $mem.progress
    error      = $mem.error
    built_ms   = $mem.built_ms
    updated    = $mem.updated
  }
}

# 扩展拿到整片字幕后调用。立即返回，生成在后台进行（主循环推进）。
# 同一份字幕（hash 相同）已生成好就直接返回；字幕变了（例如边看边抓的字幕变多了）只重做原文变了的小节。
function Invoke-MemoryBuild($ctx, $body) {
  $cfg = Get-Config
  $ms = Get-MemSettings $cfg
  $vid = [string](Get-Field $body 'video_id' '')
  if (-not $vid) { Send-Json $ctx 400 @{ error = 'video_id 不能为空' }; return 'memory build: no video_id' }
  if (-not $ms.enabled) { Send-Json $ctx 200 @{ status = 'disabled' }; return 'memory disabled' }
  $source = Get-NonEmpty $body 'source' 'bilibili'
  $cues = ConvertTo-MemCues (Get-Field $body 'cues' @())
  if ($cues.Count -lt 5) { Send-Json $ctx 200 @{ status = 'too_short'; cues = $cues.Count }; return "memory too short ($($cues.Count))" }
  $hash = Get-CuesHash $cues $ms
  $old = Get-Memory $vid
  $job = $script:MemJobs[$vid]
  $force = (Get-Field $body 'force' $false) -eq $true

  if ($job -and -not $force) {
    # 整片字幕优先于边看边抓：正在用边看边抓的字幕生成时，来了整片字幕就换掉
    if (-not ($job.mem.source -eq 'live' -and $source -ne 'live')) {
      Send-Json $ctx 200 (Get-MemStatusObj $job.mem)
      return "memory $vid 生成中 $($job.done)/$($job.total)"
    }
  }
  if ($old -and $old.source -ne 'live' -and $source -eq 'live' -and -not $force) {
    Send-Json $ctx 200 (Get-MemStatusObj $old)
    return "memory $vid 已有整片字幕记忆，忽略边看边抓"
  }
  if ($old -and $old.hash -eq $hash -and -not $force -and ($old.status -eq 'ready' -or -not (Test-HasKey $cfg))) {
    Send-Json $ctx 200 (Get-MemStatusObj $old)
    return "memory $vid 已就绪（$($old.status)）"
  }

  $chunks = Split-MemChunks $cues $ms
  $dur = 0.0
  try { $dur = [double](Get-Field $body 'duration' 0) } catch {}
  if ($dur -le 0) { $dur = [double]$cues[$cues.Count - 1].e }
  $mem = [ordered]@{
    version  = $MEM_VERSION
    video_id = $vid
    subject  = Get-NonEmpty $body 'subject' $T_UNKNOWN_SUBJECT
    desc     = Limit-Text ([string](Get-Field $body 'desc' '')) 300
    source   = $source
    lan      = [string](Get-Field $body 'lan' '')
    hash     = $hash
    duration = $dur
    status   = 'building'
    error    = $null
    model    = $null
    progress = $null
    built_ms = $null
    updated  = $null
    global   = $null
    chunks   = $chunks
    cues     = $cues
  }
  # 原文没变的小节沿用上次的摘要（小节按原文 hash 对应）
  $reused = 0
  if ($old -and -not $force) {
    $byHash = @{}
    foreach ($c in @($old.chunks)) { if ($c.src -eq 'llm') { $byHash[[string]$c.hash] = $c } }
    foreach ($c in $chunks) {
      $o = $byHash[[string]$c.hash]
      if ($o) { $c.title = [string]$o.title; $c.summary = [string]$o.summary; $c.terms = @($o.terms); $c.src = 'llm'; $reused++ }
    }
  }
  $script:MemCache[$vid] = $mem
  if (-not (Test-HasKey $cfg)) {
    # 没 Key 也能用：焦点层和回溯层不需要模型，只是没有摘要和大纲
    $mem.status = 'raw'
    $mem.error = 'no_api_key'
    Save-Memory $mem
    Send-Json $ctx 200 (Get-MemStatusObj $mem)
    return "memory $vid 没有 Key，只存原文 $($cues.Count) 句"
  }
  Start-MemoryJob $mem $cfg
  Save-Memory $mem
  Step-MemoryJobs
  Send-Json $ctx 200 (Get-MemStatusObj $mem)
  return "memory $vid 开始生成：$source $($cues.Count) 句 → $($chunks.Count) 小节（沿用 $reused），map $($script:MemJobs[$vid].total) 批"
}

function Invoke-MemoryStatus($ctx) {
  $vid = [string]$ctx.Request.QueryString['video_id']
  Send-Json $ctx 200 (Get-MemStatusObj (Get-Memory $vid))
  return 'quiet'
}

# 调试 / 演示用：看某个时间点实际会拼给模型的四层上下文
function Invoke-MemoryContextEndpoint($ctx, $body) {
  $cfg = Get-Config
  $vid = [string](Get-Field $body 'video_id' '')
  $question = [string](Get-Field $body 'question' '')
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $r = Get-MemoryVars $cfg $vid (Get-Field $body 't' $null) $question ([string](Get-Field $body 'transcript' ''))
  Send-Json $ctx 200 ([ordered]@{
      used          = $r.used
      status        = $r.status
      chapter       = $r.chapter
      chunk_index   = $r.chunk_index
      global_layer  = $r.global_layer
      section_layer = $r.section_layer
      focus         = $r.focus
      recall_layer  = $r.recall_layer
      outline       = $r.outline
      ms            = $sw.ElapsedMilliseconds
    })
  return "memory context $vid t=$(Get-Field $body 't' '?') 回溯=$($r.recall_hits)"
}

# ---------------------------------------------------------------- /keypoints（Call 5：课程重点标注，v1.3）
# 扩展按段送字幕来（完整字幕约 5 分钟一段，或播放时攒下的一段），这里找出值得回看的重点。
# 模型输出会再校验一遍（时间落在本段并对齐字幕、长度、类别、去重、数量）；
# 没配 Key / 上游出错 / 输出解析不了时按关键词规则粗略标注，source = rule。
$KP_KINDS = @('定义', '结论', '方法', '强调', '易错')
$KP_RULES = @(
  @{ kind = '易错'; re = '容易(犯|错|混|搞混|弄错|忽略)|误区|混淆|千万别|千万不要|别搞错|常见错误|易错' },
  @{ kind = '强调'; re = '重点|关键|核心|记住|考试|常考|必考|注意' },
  @{ kind = '定义'; re = '叫做|称为|称作|定义' },
  @{ kind = '结论'; re = '定理|结论|公式|总结|也就是说|本质上' }
)

function Format-Clock([double]$sec) {
  $s = [int][math]::Floor([math]::Max(0, $sec))
  return ('{0:00}:{1:00}' -f [math]::Floor($s / 60), ($s % 60))
}

function ConvertFrom-Clock($v) {
  if ($null -eq $v) { return $null }
  if ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) { return [double]$v }
  $s = ([string]$v).Trim().Trim('[', ']')
  $m = [regex]::Match($s, '^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$')
  if ($m.Success) {
    if ($m.Groups[3].Success) { return [double]([int]$m.Groups[1].Value * 3600 + [int]$m.Groups[2].Value * 60 + [int]$m.Groups[3].Value) }
    return [double]([int]$m.Groups[1].Value * 60 + [int]$m.Groups[2].Value)
  }
  $d = 0.0
  if ([double]::TryParse($s, [ref]$d)) { return $d }
  return $null
}

function ConvertFrom-KeypointsJson([string]$text) {
  $t = [regex]::Replace([string]$text, '<think>[\s\S]*?</think>', '')
  $t = [regex]::Replace($t, '```(?:json)?', '', 'IgnoreCase')
  $m = [regex]::Match($t, '\{[\s\S]*\}')
  if ($m.Success) {
    try { $o = $m.Value | ConvertFrom-Json } catch { $o = $null }
    if ($o -and $o.PSObject.Properties['points']) { return @{ points = @($o.points | Where-Object { $_ }) } }
  }
  $m = [regex]::Match($t, '\[[\s\S]*\]')
  if ($m.Success) {
    try { $a = $m.Value | ConvertFrom-Json; return @{ points = @($a | Where-Object { $_ }) } } catch {}
  }
  return $null
}

# 把候选重点整理成最终结果：时间落在本段内（对齐到最近一句字幕的开头）、截断长度、类别归一、去重、限量
function Resolve-Keypoints($cands, $lines, [double]$from, [double]$to, $known, [int]$max) {
  $knownSet = @{}
  foreach ($k in @($known)) { $n = Get-NormText ([string]$k); if ($n) { $knownSet[$n] = $true } }
  $out = New-Object System.Collections.ArrayList
  foreach ($c in @($cands)) {
    $t = ConvertFrom-Clock (Get-Field $c 't' $null)
    if ($null -eq $t -or $t -lt $from - 5 -or $t -gt $to + 5) { continue }
    $best = $null
    foreach ($l in $lines) { if ($null -eq $best -or [math]::Abs($l.t - $t) -lt [math]::Abs($best.t - $t)) { $best = $l } }
    if ($best -and [math]::Abs($best.t - $t) -le 20) { $t = $best.t }
    $t = [math]::Min([math]::Max($t, $from), $to)
    $title = (([string](Get-Field $c 'title' '')) -replace '[\r\n]+', ' ').Trim().Trim('"', '“', '”', '「', '」')
    if (-not $title) { continue }
    if ($knownSet.ContainsKey((Get-NormText $title))) { continue }
    $kind = [string](Get-Field $c 'kind' '')
    if ($KP_KINDS -notcontains $kind) { $kind = '强调' }
    $level = 1
    try { if ([int](Get-Field $c 'level' 1) -eq 2) { $level = 2 } } catch {}
    [void]$out.Add([ordered]@{
        t         = [math]::Round($t, 1)
        timestamp = Format-Clock $t
        title     = Limit-Text $title 16
        note      = Limit-Text ((([string](Get-Field $c 'note' '')) -replace '[\r\n]+', ' ').Trim()) 40
        kind      = $kind
        level     = $level
      })
  }
  # 15 秒内的两个合并（留 level 高的）
  $merged = New-Object System.Collections.ArrayList
  foreach ($p in @($out | Sort-Object { $_.t })) {
    $prev = if ($merged.Count) { $merged[$merged.Count - 1] } else { $null }
    if ($prev -and $p.t - $prev.t -lt 15) {
      if ($p.level -gt $prev.level) { $merged[$merged.Count - 1] = $p }
      continue
    }
    [void]$merged.Add($p)
  }
  # level 2（核心）每 5 分钟最多 1 个：多出来的降成 1，留时间最早的
  $l2Cap = [math]::Max(1, [math]::Ceiling($max / 3))
  $l2 = 0
  foreach ($p in $merged) { if ($p.level -eq 2) { $l2++; if ($l2 -gt $l2Cap) { $p.level = 1 } } }
  $res = @($merged)
  if ($res.Count -gt $max) {
    $res = @($res | Sort-Object @{ Expression = { $_.level }; Descending = $true }, @{ Expression = { $_.t }; Descending = $false } | Select-Object -First $max)
    $res = @($res | Sort-Object { $_.t })
  }
  return $res
}

# 规则兜底：含「重点 / 容易错 / 叫做 / 定理」等词的句子，每 5 分钟最多 2 个
function Get-RuleKeypoints($lines, [double]$from, [double]$to, $known, [int]$max) {
  $cands = New-Object System.Collections.ArrayList
  $perSeg = @{}
  $lastT = $null
  foreach ($l in $lines) {
    $hit = $null
    foreach ($r in $KP_RULES) { if ($l.text -match $r.re) { $hit = $r; break } }
    if (-not $hit) { continue }
    if ($null -ne $lastT -and $l.t - $lastT -lt 15) { continue }  # 紧挨着的几句（「这是重点」「大家记住」）算同一个
    $seg = [string][math]::Floor(($l.t - $from) / 300)
    if (($perSeg[$seg] -as [int]) -ge 2) { continue }
    $lastT = $l.t
    $title = [regex]::Replace($l.text, '^(那么|所以|好|好的|这个|我们|大家|同学们|然后|接下来|嗯|啊)[，,、\s]*', '')
    $title = ($title -split '[，,。；;！!？?]')[0].Trim()
    if ($title.Length -lt 4) { $title = $l.text.Trim() }
    $perSeg[$seg] = ($perSeg[$seg] -as [int]) + 1
    [void]$cands.Add([pscustomobject]@{ t = $l.t; title = (Limit-Text $title 14); note = $l.text; kind = $hit.kind; level = 1 })
  }
  return @(Resolve-Keypoints $cands $lines $from $to $known $max)
}

function Invoke-KeypointsEndpoint($ctx, $body) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $cfg = Get-Config
  $lines = @(@(Get-Field $body 'lines' @()) | ForEach-Object {
      $t = ConvertFrom-Clock (Get-Field $_ 't' $null)
      $text = ((([string](Get-Field $_ 'text' '')) -replace '\s+', ' ')).Trim()
      if ($null -ne $t -and $text) { @{ t = [double]$t; text = $text } }
    } | Sort-Object { $_.t })
  $from = ConvertFrom-Clock (Get-Field $body 'span_from' $null)
  $to = ConvertFrom-Clock (Get-Field $body 'span_to' $null)
  if ($null -eq $from) { $from = $(if ($lines.Count) { $lines[0].t } else { 0 }) }
  if ($null -eq $to) { $to = $(if ($lines.Count) { $lines[$lines.Count - 1].t } else { 0 }) }
  if ($to -lt $from) { $to = $from }
  $duration = ConvertFrom-Clock (Get-Field $body 'duration' $null)
  $known = @(@(Get-Field $body 'known' @()) | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ } | Select-Object -Last 30)
  $max = [int][math]::Max(1, [math]::Min(6, [math]::Ceiling(($to - $from) / 100)))

  # 字幕拼成「[mm:ss] 句子」，最多 6000 字
  $sb = New-Object System.Text.StringBuilder
  $chars = 0
  foreach ($l in $lines) {
    if ($sb.Length -ge 6000) { break }
    [void]$sb.Append('[' + (Format-Clock $l.t) + '] ' + $l.text + "`n")
    $chars += ($l.text -replace '\s', '').Length
  }
  $transcript = $sb.ToString().TrimEnd()

  $rec = [ordered]@{
    type        = 'call5'
    video_id    = Get-Field $body 'video_id' $null
    source      = Get-Field $body 'source' $null
    span_from   = [math]::Round($from, 1)
    span_to     = [math]::Round($to, 1)
    lines       = $lines.Count
    chars       = $chars
    known       = $known.Count
    max_points  = $max
  }
  $points = @()
  $resultSource = 'ai'
  $reason = $null
  $jsonMode = $null
  if ($chars -lt 30) {
    $resultSource = 'empty'
  } elseif (-not (Test-HasKey $cfg)) {
    $resultSource = 'rule'
    $reason = 'no_api_key'
  } else {
    $vars = @{
      subject    = Get-NonEmpty $body 'subject' $T_UNKNOWN_SUBJECT
      span       = (Format-Clock $from) + '–' + (Format-Clock $to)
      duration   = $(if ($duration -gt 0) { Format-Clock $duration } else { '未知' })
      known      = $(if ($known.Count) { $known -join '、' } else { '（无）' })
      max_points = [string]$max
      transcript = $transcript
    }
    $system = Fill-Template (Read-Prompt 'call5_keypoints.md') $vars
    $user = '请标出这一段字幕里的课程重点，只输出 JSON。'
    $jsonMode = $true
    $r = Invoke-Chat $cfg ([string]$cfg.model) $system $user 0.2 600 @{ response_format = @{ type = 'json_object' } }
    if (-not $r.ok -and $r.status -ge 400 -and @(401, 403, 429) -notcontains $r.status) {
      $jsonMode = $false
      $r = Invoke-Chat $cfg ([string]$cfg.model) $system $user 0.2 600 $null
    }
    if (-not $r.ok) {
      $resultSource = 'rule'
      $reason = 'upstream_error'
      $rec.error = $r.error
    } else {
      $parsed = ConvertFrom-KeypointsJson $r.text
      if ($null -eq $parsed) {
        $resultSource = 'rule'
        $reason = 'parse_failed'
        $rec.error = 'parse_failed: ' + (Limit-Text $r.text 160)
      } else {
        $rec.raw_points = @($parsed.points).Count
        $points = @(Resolve-Keypoints $parsed.points $lines $from $to $known $max)
      }
    }
  }
  if ($resultSource -eq 'rule') { $points = @(Get-RuleKeypoints $lines $from $to $known $max) }

  $rec.result = $resultSource
  $rec.fallback_reason = $reason
  $rec.json_mode = $jsonMode
  $rec.points = @($points | ForEach-Object { "$($_.timestamp) [$($_.kind)$(if ($_.level -eq 2) { '·核心' })] $($_.title)" })
  $rec.total_ms = $sw.ElapsedMilliseconds
  Write-CallLog $rec
  Send-Json $ctx 200 ([ordered]@{
      ok              = $true
      points          = $points
      source          = $resultSource
      fallback_reason = $reason
      max_points      = $max
      model           = $(if ($resultSource -eq 'ai') { [string]$cfg.model } else { $null })
      total_ms        = $sw.ElapsedMilliseconds
    })
  $span = (Format-Clock $from) + '-' + (Format-Clock $to)
  if ($resultSource -eq 'empty') { return "call5 $span 字幕太少，跳过" }
  return "call5 $span $resultSource$(if ($reason) { "($reason)" }) → $($points.Count) 个重点"
}

# ---------------------------------------------------------------- /log（客户端事件）
function Invoke-ClientLog($ctx, $body) {
  $rec = [ordered]@{ type = 'client_event' }
  foreach ($p in $body.PSObject.Properties) { $rec[$p.Name] = $p.Value }
  Write-CallLog $rec
  Send-Json $ctx 200 @{ ok = $true }
  return "log $($rec.type)"
}

# ---------------------------------------------------------------- 路由分发
function Invoke-Request($ctx) {
  $method = $ctx.Request.HttpMethod
  $path = $ctx.Request.Url.AbsolutePath.TrimEnd('/')
  if ($method -eq 'OPTIONS') {
    $ctx.Response.StatusCode = 204
    Set-Cors $ctx.Response
    $ctx.Response.Close()
    return 'preflight'
  }
  switch ("$method $path") {
    'GET '          { return (Invoke-Health $ctx) }
    'GET /health'   { return (Invoke-Health $ctx) }
    'POST /explain' { return (Invoke-Explain $ctx (Read-Body $ctx)) }
    'POST /route'   { return (Invoke-RouteEndpoint $ctx (Read-Body $ctx)) }
    'POST /followup' { return (Invoke-Followup $ctx (Read-Body $ctx)) }
    'POST /log'     { return (Invoke-ClientLog $ctx (Read-Body $ctx)) }
    'POST /ocr'     { return (Invoke-OcrEndpoint $ctx (Read-Body $ctx)) }
    'POST /asr'     { return (Invoke-AsrEndpoint $ctx (Read-Body $ctx)) }
    'POST /summarize' { return (Invoke-SummarizeEndpoint $ctx (Read-Body $ctx)) }
    'POST /keypoints' { return (Invoke-KeypointsEndpoint $ctx (Read-Body $ctx)) }
    'POST /memory/build'   { return (Invoke-MemoryBuild $ctx (Read-Body $ctx)) }
    'GET /memory/status'   { return (Invoke-MemoryStatus $ctx) }
    'POST /memory/context' { return (Invoke-MemoryContextEndpoint $ctx (Read-Body $ctx)) }
    default {
      Send-Json $ctx 404 @{ error = "没有这个接口：$method $path" }
      return 'not found'
    }
  }
}

function Start-Listener([int]$port) {
  foreach ($hosts in @(@('localhost', '127.0.0.1'), @('localhost'))) {
    $l = New-Object System.Net.HttpListener
    foreach ($h in $hosts) { $l.Prefixes.Add("http://${h}:$port/") }
    try { $l.Start(); return $l }
    catch {
      $l.Close()
      $last = $_.Exception.Message
    }
  }
  throw "无法监听端口 ${port}：$last（是不是已经开了一个代理窗口？或换一个 port）"
}

# ---------------------------------------------------------------- 启动
$cfg0 = Get-Config
if ($Port -le 0) { $Port = [int]$cfg0.port }
if ($Port -le 0) { $Port = 8787 }
$listener = Start-Listener $Port

Write-Host ''
Write-Host "  哄着学 v$VERSION · 本地代理已启动" -ForegroundColor Green
Write-Host "  地址      http://localhost:$Port"
Write-Host "  模型      $($cfg0.model)   视觉模型 $($cfg0.visionModel)"
Write-Host "  上游      $($cfg0.baseUrl)"
if (Test-HasKey $cfg0) { Write-Host '  API Key   已配置' }
else { Write-Host '  API Key   未配置！请编辑 proxy\config.json 的 apiKey（保存即生效）' -ForegroundColor Yellow }
if ($cfg0.ocr -eq $false) { Write-Host '  画面识字  已关闭（config.json 里 ocr: false）' }
else {
  $ocr0 = Initialize-Ocr
  if ($ocr0.ok) { Write-Host "  画面识字  可用（Windows 本地识别，语言 $($ocr0.lang)）" }
  else { Write-Host ('  画面识字  不可用：' + $ocr0.error) -ForegroundColor Yellow }
}
if ($cfg0.asrEngine -eq 'off') { Write-Host '  语音识别  已关闭（config.json 里 asr.engine = "off"）' }
else {
  $asr0 = Initialize-Asr
  $asrNote = if ($cfg0.asrEngine -eq 'cloud') { "云端 $([string](Get-Field $cfg0.asr 'model' ''))，失败时用本机；" } else { '' }
  if ($asr0.ok) { Write-Host "  语音识别  可用（${asrNote}Windows 本机离线识别，语言 $($asr0.lang)）" }
  elseif ($cfg0.asrEngine -eq 'cloud') { Write-Host ("  语音识别  云端 $([string](Get-Field $cfg0.asr 'model' ''))；本机识别不可用：" + $asr0.error) -ForegroundColor Yellow }
  else { Write-Host ('  语音识别  不可用：' + $asr0.error) -ForegroundColor Yellow }
}
Write-Host "  提示词    $PromptDir（每次请求实时读取，改完不用重启）"
Write-Host "  日志      $LogFile"
Write-Host '  关闭这个窗口 = 停止代理。按 Ctrl+C 也可以停止。'
Write-Host ''

try {
  while ($listener.IsListening) {
    $ar = $listener.BeginGetContext($null, $null)
    while (-not $ar.AsyncWaitHandle.WaitOne(250)) { Step-MemoryJobs }
    $ctx = $listener.EndGetContext($ar)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $summary = ''
    try {
      $summary = Invoke-Request $ctx
    } catch {
      $msg = $_.Exception.Message
      $summary = "ERROR $msg"
      try { Send-Json $ctx 500 @{ error = "代理内部错误：$msg" } } catch {}
    }
    if ($summary -ne 'preflight' -and $summary -ne 'quiet') {
      Write-Host ('[{0}] {1,-4} {2,-10} {3,6}ms  {4}' -f (Get-Date -Format 'HH:mm:ss'), $ctx.Request.HttpMethod, $ctx.Request.Url.AbsolutePath, $sw.ElapsedMilliseconds, $summary)
    }
    Step-MemoryJobs
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
