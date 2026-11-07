<#
  学习搭子 · 本地代理（Windows PowerShell 5.1 / PowerShell 7 均可运行）

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
#>
param(
  [string]$ConfigPath = '',
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$ProxyDir  = $PSScriptRoot
$Root      = Split-Path -Parent $ProxyDir
$PromptDir = Join-Path $Root 'prompts'
$DataDir   = Join-Path $Root 'data'
$LogFile   = Join-Path $DataDir 'calls.jsonl'
if (-not $ConfigPath) { $ConfigPath = Join-Path $ProxyDir 'config.json' }

$Utf8 = New-Object System.Text.UTF8Encoding($false)
try { [Console]::OutputEncoding = $Utf8 } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir | Out-Null }
if (-not (Test-Path $ConfigPath)) {
  $example = Join-Path $ProxyDir 'config.example.json'
  if (Test-Path $example) { Copy-Item $example $ConfigPath }
}

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
  }
  if (Test-Path $ConfigPath) {
    $raw = [IO.File]::ReadAllText($ConfigPath, $Utf8)
    try { $obj = $raw | ConvertFrom-Json } catch { throw "config.json 不是合法 JSON：$($_.Exception.Message)" }
    foreach ($p in $obj.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
  }
  if (-not $cfg.visionModel) { $cfg.visionModel = $cfg.model }
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
    $result = Get-FallbackRoute $vars.question $vars.transcript
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
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
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
      name        = 'learn-buddy-proxy'
      hasKey      = (Test-HasKey $cfg)
      baseUrl     = [string]$cfg.baseUrl
      model       = [string]$cfg.model
      visionModel = [string]$cfg.visionModel
      sendImage   = ($cfg.sendImage -ne $false)
      ocr         = ($cfg.ocr -ne $false)
      ocrReady    = $(if ($cfg.ocr -ne $false) { [bool](Initialize-Ocr).ok } else { $false })
      ocrError    = $(if ($cfg.ocr -ne $false) { (Initialize-Ocr).error } else { $null })
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

  # 模型不看图时，用本地文字识别读出画面上的字（含烧在画面里的硬字幕）
  $frameText = $null
  if (-not $wantImage) { $frameText = Get-FrameText $cfg $image }
  if ($frameText -and $frameText.ok) { $transcript = Add-SubtitleToTranscript $transcript $timestamp $frameText.subtitle }
  $screenText = Format-ScreenText $frameText
  $textQuestion = if ($screenText) { $question + "`n`n" + $screenText } else { $question }

  $degraded = ((Get-TranscriptBodyLength $transcript) -lt 10)
  $route = [string](Get-Field $body 'route' 'in_video')
  if ($ROUTES -notcontains $route) { $route = 'in_video' }
  $vars = @{
    subject    = Get-NonEmpty $body 'subject' $T_UNKNOWN_SUBJECT
    timestamp  = $timestamp
    transcript = $transcript
    question   = $question
    past       = Format-Past (Get-Field $body 'past' $null)
    route      = $route
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
  }

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
      total_ms         = $sw.ElapsedMilliseconds
    })
  $flag = if ($violation) { ' 超长!' } else { '' }
  $deg = if ($degraded) { ' 降级' } else { '' }
  $ocrFlag = if (-not $screenText) { '' } elseif ($frameText) { " 画面文字=$($frameText.ms)ms" } else { ' 画面文字' }
  return "call2 $($final.chars)字 段长[$(@($final.seg_lengths) -join ',')]$flag$deg 图=$visionUsed$ocrFlag 重试=$retried"
}

# ---------------------------------------------------------------- /followup（Call 3，流式）
function Invoke-Followup($ctx, $body) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $cfg = Get-Config
  $followUp = Get-NonEmpty $body 'follow_up' ''
  if (-not $followUp) { Send-Json $ctx 400 @{ error = 'follow_up 不能为空' }; return 'empty follow_up' }

  $transcript = [string](Get-Field $body 'transcript' '')
  $degraded = ((Get-TranscriptBodyLength $transcript) -lt 10)
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
Write-Host '  学习搭子 · 本地代理已启动' -ForegroundColor Green
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
Write-Host "  提示词    $PromptDir（每次请求实时读取，改完不用重启）"
Write-Host "  日志      $LogFile"
Write-Host '  关闭这个窗口 = 停止代理。按 Ctrl+C 也可以停止。'
Write-Host ''

try {
  while ($listener.IsListening) {
    $ar = $listener.BeginGetContext($null, $null)
    while (-not $ar.AsyncWaitHandle.WaitOne(250)) { }
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
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
