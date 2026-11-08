# 哄着学 Coaxly · converge-v2 改造说明

> 分支 `feat/converge-v2` · 基线 `6634e7b`（v1.2） · 6 个提交 · 15 个文件 · **+1611 / −224** 行
> 目标：把「只能看当前 30 秒」的即时解释，升级成「知道整门课结构」的学习搭子，并修掉三个致命体验问题。

---

## 目录

- [一、这次到底做了什么](#一这次到底做了什么)
- [二、Step 1 · Call 0 课程索引（含预热）](#二step-1--call-0-课程索引含预热)
- [三、Step 2 · 路径 A/B 双版本 Call 2](#三step-2--路径-ab-双版本-call-2)
- [四、Step 3 · Call 2 改流式](#四step-3--call-2-改流式)
- [五、Step 4 · 长度治理：150 字 / 详细模式 / 强制截断](#五step-4--长度治理150-字--详细模式--强制截断)
- [六、Step 5 · 三个致命问题修复](#六step-5--三个致命问题修复追问误杀--啰嗦--快捷按钮失效)
- [七、Step 6 · 工程健壮性与可观测性](#七step-6--工程健壮性与可观测性)
- [八、文件清单](#八文件清单)
- [九、接口与数据变化](#九接口与数据变化)
- [十、自测清单](#十自测清单可逐项勾选)
- [十一、与上游 v1.3 的关系](#十一与上游-v13-的关系必读)
- [十二、已知限制与后续](#十二已知限制与后续)

---

## 一、这次到底做了什么

| 维度 | 改造前（v1.2） | 改造后（converge-v2） |
|---|---|---|
| 课程全局理解 | 只有 ±30 秒字幕窗口 | **Call 0 课程索引**（四区块 ≤1500 字 + 缓存 + 预热） |
| 索引可信度 | 无 | **Call 0.5 自检**（规则粗筛 → JSON 补丁 → `index_quality`） |
| Call 2 输出形态 | 单版本、非流式 | **路径 A/B 双版本 + 流式首字即显** |
| 长度纪律 | ≤120 字（50/40/30） | **≤150 字（60/50/30）/ 详细模式 ≤500 字（150/250/100）** |
| 超长处理 | 降温重试后替换原文 | 重试 → **仍超则强制截断 + 提示**；流式不撤回已显示内容 |
| 追问路由 | 三分类，正常追问容易被误杀 | **快捷按钮硬拦截 + 3 条豁免规则** |
| 离题处理 | 硬 redirect | **软拉回（≤60 字）**，连续两次才硬转 |
| 可观测性 | 少量字段 | 新增 `path_taken / index_quality / ttft_ms / truncated / length_mode` 等 |

**提交序列**

```text
fb762a7  feat: Call 0 index + path A/B + streaming Call 2 + 150 chars + warmup
5d39270  feat: 落地收敛版 prompt 原文 + 5 个占位符对齐 + Call 0.5 JSON 自检 + off_topic 软拉回
6aaf75c  fix:  恢复 call2_retry_suffix + 非流式重试/流式追加双路径 + 启动 FATAL 校验
4ca8bc1  fix:  流式改为显式声明 + 空内容防御 + dump_prompt 调试开关
53f6ecf  fix:  修复三大致命问题——追问误杀 / 啰嗦超长 / 快捷按钮失效
4e6657c  docs: 新增改造说明文档
```

---

## 二、Step 1 · Call 0 课程索引（含预热）

### 为什么

v1.2 的 Call 3 规则写着"超出 ±30 秒就请用户倒回去"——用户问「这个和前面讲的 X 什么关系」时，系统只能拒绝。
**索引是打通跨时间戳追问的唯一手段。**

### 技术路径

```text
扩展 background.js
  └─ 页面加载 → biliSubtitlePack(bvid)
       ├─ GET /x/web-interface/view?bvid=      → cid / 标题
       ├─ GET /x/player/v2?bvid=&cid=         → 字幕文件地址
       └─ GET <subtitle_url>                  → 整段字幕 [{from,to,content}]
  └─ POST /index { bvid, cid, subject, part_info, subtitles[] }

代理 server.ps1
  └─ POST /index → Invoke-IndexBuild
       ① 字幕 → 带 [mm:ss] 的整段文本
       ② 时长 >120 分钟 → 每 30 分钟切段，逐段 Call 0，再确定性合并
       ③ Call 0 产出四区块：课程概览 / 核心概念时间线 / 概念关系 / 课程边界
       ④ 缓存 data/index/<bvid>__<cid>.json（TTL 24h）
       ⑤ 预热：用「索引 + 路径 A 系统提示」打一次 max_tokens=1 请求
```

### 关键取舍

| 取舍 | 原因 |
|---|---|
| 索引落盘缓存 | 代理重启可复用；跨会话命中预热 |
| 长视频分段后**确定性合并**（不再多烧一次模型） | 省 token、结果可复现、避免合并阶段幻觉 |
| 预热失败 → 走路径 B，不做"先降级再后台预热" | 避免中间态不可预测（应表现为"第一次简短、第二次完整"） |

### 验证

```text
POST /index → ok, index_quality=medium, chunks=1, warm_ok=true, build_ms≈1.5s，缓存文件已落盘
POST /explain → meta{path:A, chars_limit:150} → done{ttft≈400ms}
无索引视频 → path=B, reason=no_index
```

---

## 三、Step 2 · 路径 A/B 双版本 Call 2

### 为什么

v1.2 的 `call2_degraded.md` 是"残缺版"：它允许模型"只根据画面回答"，输出形态和正常版不一致，
用户会直接感知到"这次答得不一样"。

### 技术路径

```text
判定函数 Get-Call2Path：
  索引存在 && 未过期 && quality ≠ low && 预热完成  →  路径 A（注入索引）
  否则                                            →  路径 B（不注入索引）

两条路径的**输出结构纪律完全一致**：
  三段 · ≤150 字 · 60/50/30 · 开头定位句式 · 末尾 [[新概念: ...]] 元信息
差别只有一处：A 可以引用索引里的跨时间戳概念（必须标时间范围），B 明确只看得见当前 90 秒。
```

### 文件变化

| 操作 | 文件 |
|---|---|
| 新增 | `prompts/call2_no_index.md`（路径 B，取代旧的 `call2_degraded.md`） |
| 删除 | `prompts/call2_degraded.md` |

---

## 四、Step 3 · Call 2 改流式

### 为什么

注入索引后 Prefill 变长，非流式的首字延迟明显上升。
流式把"屏幕空白"压缩到只包含 Prefill + 首 token，用户看到第一个字，心理等待就结束。

### 技术路径

```text
代理：/explain 支持 SSE，事件协议
  meta     { path, path_reason, prompt_file, model, index_quality, chars_limit, length_mode }
  delta    { text }                     ← 逐块转发
  condense { text, chars }              ← 仅流式且未截断时（超长追加极简版）
  done     { chars, seg_count, seg_lengths, length_violation, truncated, ttft_ms, ... }
  error    { message }

扩展：content.js 复用已有的 streamProxy（Call 3 早就在用这套机制）
  meta  → 显示"正在生成"
  delta → 逐段渲染
  done  → 落 s.call2、渲染三段、写历史节点
```

### 兼容性设计（重要）

**流式必须由客户端显式传 `stream: true` 才启用。** 不传则返回普通 JSON。

> 原因：改造过程中出现过"抽屉只有一行 meta、正文空白"的故障——旧版 `content.js` 用 `JSON.parse`
> 解析 SSE 体，拿到 `null`，于是只渲染了 meta 行。改成显式声明后，新旧前端都能正常工作。

---

## 五、Step 4 · 长度治理：150 字 / 详细模式 / 强制截断

### 三层防线

| 层 | 机制 |
|---|---|
| ① Prompt | `{{length_mode}}`：concise ≤150 字（60/50/30）；detailed ≤500 字（150/250/100） |
| ② 重试 | 非流式超限 → 追加 `call2_retry_suffix.md` + `temperature=0.2` 再请求一次，更短才采用 |
| ③ **兜底** | 仍超限 → **强制截断到上限** + `…（字数超限，请点击下方[展开讲讲]）`，日志记 `truncated` |

流式同样截断：超过上限后**停止转发正文**，改发那句提示——不撤回用户已看到的内容。

### 验证

```text
非流式 concise 172 字 → 重试得 93 字 → 采用 93（retried=true, truncated=false）
流式   concise 172 字 → 截断到 150 + 提示（truncated=true, chars=169, first_chars=172）
流式   detailed 172 字 → 不截断（chars_limit=500）
```

---

## 六、Step 5 · 三个致命问题修复（追问误杀 / 啰嗦 / 快捷按钮失效）

### 6.1 追问被误杀

**工程侧硬拦截**（在调用任何模型之前）——匹配前端**真实发出**的字符串：

| 按钮 | 实际发送 |
|---|---|
| 还是不懂 | `还是不懂` |
| 展开讲讲 | `展开讲讲` |
| 不管视频，直接讲 | `用你自己的知识解释一下，不用管视频`（长句，最易漏） |
| 懂了 | `懂了` |

命中 → **完全不调用 Call 1**，直接 `route = in_video`，SSE 事件带 `shortcut: true`。

**Prompt 侧再叠一层**：`call1_router.md` 加 3 条 `CRITICAL EXEMPTIONS`——表达困惑、问「什么是 X」（即使字幕里没有）、引用刚收到的解释里的概念，一律不许判 `off_topic`；并注入 `{{course_index}}` + `{{call2_output}}` 供判断。

### 6.2 啰嗦

见 Step 4 的三层防线。

### 6.3 快捷按钮失效

```text
展开讲讲 / 展开说说 / 详细说说 / 多讲一点 / 再讲一遍
  → length_mode = detailed（注入 Call 2 与 Call 3）
  → max_tokens 放大：Call 2 500→900，Call 3 500→800
  → 前端段落标签切换为「原理解构 / 详细推导 / 应用避坑」，且不再显示「是/不是/不确定」按钮
```

---

## 七、Step 6 · 工程健壮性与可观测性

| 项 | 内容 |
|---|---|
| **启动 FATAL 校验** | 启动时检查 12 个必需 prompt，缺任何一个立刻 `[FATAL]` 退出，而不是等用户点求助才在界面上报红字 |
| **占位符兜底** | `Clear-LeftoverVars`：模板填充后残留的 `{{x}}` 统一替换为 `（无）`，结构上不可能把字面量送进模型 |
| **空内容防御** | 模型真空返回时返回明确错误（含排查建议），不再静默成功 |
| **Prompt 导出** | 请求体加 `"dump_prompt": true` → 最终 SYSTEM/USER Prompt 落盘，便于核对变量注入 |
| **日志字段** | 见下节 |

---

## 八、文件清单

### 新增

| 文件 | 作用 |
|---|---|
| `prompts/call0_index.md` | Call 0：四区块课程索引（≤1500 字） |
| `prompts/call0_selfcheck.md` | Call 0.5：JSON 补丁 + `patch_confidence` |
| `prompts/call2_no_index.md` | 路径 B：无索引版 Call 2（结构与 A 对齐 + `length_mode`） |
| `prompts/call2_condense.md` | 流式超长时追加的 ≤100 字极简版 |
| `prompts/call3_off_topic_soft.md` | off_topic 软拉回（≤60 字） |
| `docs/converge-v2-改造说明.md` | 详细版改造文档（同一内容的展开版） |

### 修改

| 文件 | 要点 |
|---|---|
| `proxy/server.ps1` | 索引引擎（Call 0/0.5/粗筛/合并/预热）、路径判定、流式 Call 2、截断兜底、快捷拦截、off_topic 软拉回、新日志字段、启动 FATAL 校验 |
| `extension/background.js` | 抓 B 站整段字幕（view → player/v2 → subtitle JSON）并调用 `/index` |
| `extension/content.js` | Call 2 流式渲染、精简版展示、`[[新概念]]` 过滤、`length_mode` 标签、off_topic 不预填 |
| `prompts/call1_router.md` | 换修复版（3 条豁免）+ 注入 `course_index` / `call2_output` |
| `prompts/call2_explain.md` | 换修复版（`{{length_mode}}`）+ 顶部索引块 + 索引引用纪律/新概念元信息 |
| `prompts/call2_retry_suffix.md` | 恢复并适配 150 字上限 |
| `prompts/call3_followup.md` | 换修复版（意图分流 / 禁反问 / 外部知识出口）+ 保留模式段 |
| `dev/mock-upstream.js` | Call 2 识别改为按「定位纪律 / 课程索引开始」判断（原先按 `stream` 会把流式 Call 2 误判成 Call 3） |

---

## 九、接口与数据变化

### 新增接口

```http
POST /index
  body: { bvid, cid?, subject?, course_title?, part_info?, subtitles: [{from,to,text}], force? }
  resp: { ok, cached, index_quality, chars, chunks,
          missed_candidates[], timestamp_suspect[], patches_applied[],
          needs_rebuild, warm_ok, build_ms, file }
```

### `/explain` 变化

```text
body.stream      必须显式 true 才流式；否则返回普通 JSON（兼容旧前端）
body.length_mode 'concise'(默认) | 'detailed'
body.dump_prompt true → 导出最终 Prompt

SSE 事件：meta / delta / condense / done / error（详见 Step 3）
```

### 日志新字段（`data/calls.jsonl`）

| 类型 | 新增字段 |
|---|---|
| `call0` | `index_quality / index_chars / missed_candidates / timestamp_suspect / needs_rebuild / warm_ok / warm_ms / chunks / llm_calls` |
| `call2` | `path_taken / path_reason / index_quality / ttft_ms / stream / chars_limit / length_mode / truncated / model_overran / retried / retry_chars / first_chars / condense_chars / condense_added / explanation_concepts` |
| `call3` | `length_mode / shortcut_bypass / off_topic_streak / soft_pullback` |

### 配置新增

```jsonc
{
  "call2Model": "glm-4-flash",   // Call 2 专用模型（锁 Flash/Haiku 级）
  "streamExplain": true,         // 允许流式（仍需客户端显式声明）
  "warmup": true,                // 索引建好后预热缓存
  "index": { "enabled": true, "maxChars": 1500, "ttlHours": 24, "chunkChars": 6000 }
}
```

---

## 十、自测清单（可逐项勾选）

### 索引

- [ ] 打开 B 站课程视频，播放 10~30 秒后检查 `data/index/` 是否生成 `<bvid>__<cid>.json`
- [ ] `POST /index` 返回 `ok:true` 且含 `index_quality` / `warm_ok`
- [ ] 第二次调用同一视频返回 `cached:true`

### 路径判定

- [ ] 索引就绪后求助 → 抽屉显示「已用课程索引」，问「这和前面讲的 X 什么关系」能答且标明时间
- [ ] 无索引视频求助 → 显示「未用课程索引（仅当前片段）」，且三段结构与 A 一致

### 流式与长度

- [ ] 解释逐字出现（不是等 3 秒整段蹦出）
- [ ] `data/calls.jsonl` 该条 `call2` 里 `ttft_ms` 有值且流式为 `true`
- [ ] 模型超长时底部出现「…（字数超限，请点击下方[展开讲讲]）」，且 `truncated:true`
- [ ] 点「展开讲讲」后输出变长（`chars_limit:500`、`length_mode:detailed`）

### 三个致命问题

- [ ] 点「还是不懂」→ 不出现"离题/已拉回"，给出不同于上次的解释；日志无 `call1` 记录
- [ ] 追问「什么是 X」→ 直接回答，不被拉回视频
- [ ] 离题问题（如问天气）第一次被温和拉回（≤60 字），连问两次才硬转

### 工程健壮性

- [ ] 临时改名任一 prompt → 启动即打印 `[FATAL]` 并退出
- [ ] 请求体加 `"dump_prompt": true` → 生成的 Prompt 里无 `{{...}}` 残留

---

## 十一、与上游 v1.3 的关系（必读）

本次开发基于 **v1.2（`6634e7b`）**；开发期间上游 `main` 已前进到 **v1.3（`15379f2`）**：

```text
15379f2  v1.3：Anthropic 风格界面重设计、读字幕自动标注课程重点
f032201  新增 INSTALL.md：给 AI Agent 看的安装指南
```

v1.3 的方向是「**界面重设计 + Call 5 课程重点标注**」（新增 `prompts/call5_keypoints.md`、`INSTALL.md`、`docs/v1.3-方案.md`，`content.js` 重写 +1087 行），**没有** Call 0 索引、没有路径 A/B、Call 2 仍是非流式。

**潜在冲突面（双方都改过）**

```text
proxy/server.ps1       本分支 +1111/−224   上游 +225
extension/content.js   本分支 +169          上游 +1087（UI 层已重写）
dev/mock-upstream.js   双方都有小改动
```

**合并建议（按风险从低到高）**

1. **以分支形式提交，由维护者评估**（本次做法，零风险，不污染 `main`）
2. 若要合并：把「索引 / 流式 / 路由」当作独立层，与 v1.3 的 UI 层分开处理
   - `server.ps1`：功能均为**新增函数**，可逐块解决冲突
   - `content.js`：建议以 v1.3 为基线，把本分支的 169 行（流式渲染 / 精简版 / 标签 / off_topic）**重新贴到新版结构上**
3. **不建议直接 rebase**：`content.js` 已被重写，机械 rebase 会产生不可读的冲突

---

## 十二、已知限制与后续

| # | 限制 | 说明 |
|---|---|---|
| 1 | `call1_router.md` 为 3 类 + 3 豁免 | 收敛版的第四类 `cross_video` 与 5 条保护条款尚未合入 |
| 2 | `call2_explain.md` 非逐字版 | 现为镜像版（定位纪律 / 150 / 60-50-30 / 索引注入 / 新概念元信息） |
| 3 | 语义缓存未实现 | `{{reference_answer}}` 恒为空字符串 |
| 4 | 跨供应商 fallback 未实现 | 超时只重试主供应商，不切备用 |
| 5 | 索引依赖 B 站字幕接口 + 登录态 | 拿不到字幕 → `no_subtitle`，自动走路径 B |
| 6 | 前端未透传 `length_mode` | 代理按「展开讲讲」等关键词推断，够用但不精确 |
| 7 | `proxy/server.ps1` 编码为 UTF-8 with BOM | 上游原为 UTF-16LE；PowerShell 5.1 两者都能读，但 diff 会整文件显示 |

---

## 附：如何验证这份改动是真的（不花真 Key）

```powershell
# 1) 用模拟上游验证全链路（不需要 API Key）
node dev/mock-upstream.js 9901                      # 无 node 时可用 Electron 当 node
powershell -NoProfile -ExecutionPolicy Bypass -File proxy\server.ps1 `
  -ConfigPath dev\mock-config.json -LogPath data\dev-calls.jsonl -Port 8796

# 2) 看索引构建
curl -sS -X POST http://127.0.0.1:8796/index `
  -H "Content-Type: application/json" `
  --data-binary @index-request.json

# 3) 看流式解释
curl -sS -N -X POST http://127.0.0.1:8796/explain `
  -H "Content-Type: application/json" --data-binary @explain-request.json

# 4) 看日志字段
Get-Content data\dev-calls.jsonl | Select-Object -Last 5 |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Select-Object type, path_taken, index_quality, ttft_ms, length_mode, truncated, call2_chars
```
