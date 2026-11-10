/* 哄着学 Coaxly · 内容脚本（运行在 B 站页面里）
 *
 * 触发：视频暂停 → 画面中央出现「我这里不懂」按钮；或在任意时刻按 1。
 * 上下文：MutationObserver 监听播放器里 class 含 subtitle 的节点，按 video.currentTime 打点，
 *         取暂停时刻 ±30 秒窗口作为模型的「记忆边界」。
 *         没有播放器字幕时（字幕烧在画面里），播放中定期把画面底部送本地代理做文字识别，同样打点。
 * 画面：直接从 <video> 取帧（不含弹幕和控制条），取不到再整页截图。
 * 载体：页面内右侧抽屉（Shadow DOM，样式与 B 站互不影响；全屏时跟随进入全屏元素）。
 *
 * v1.2：
 * - 语音追问改为「页面录音 → 本地代理 /asr 识别」（Chrome 自带识别要连 Google，国内用不了）。
 * - 抓不到字幕时的醒目指引：判断字幕为什么没有（没开 / 要登录 / 没有），播放中主动提醒、一键打开字幕、倒回重看。
 * - 历史节点：每次求助记一个节点（由扩展后台写入），带一句话说明；选节点 = 视频跳回去 + 还原当时的对话，可接着追问。
 *
 * v1.3：
 * - 界面：衬线正文、深浅色模式与进度条重点标记。
 * - 课程重点：读完整字幕（B 站字幕接口，带用户自己的登录态）或边播边攒的字幕，分段交给本地代理 /keypoints（Call 5）
 *   判定重点 → 进度条标记 + 抽屉「重点」列表 + 播放经过时提示 + 暂停时「附近重点」。存在 chrome.storage.local 的 kp:<视频ID>。
 */
(() => {
  'use strict';
  if (window.__coaxlyLoaded) return;
  window.__coaxlyLoaded = true;

  // ------------------------------------------------------------------ 常量
  const DEFAULT_QUESTION = '这里没听懂，帮我讲讲刚才这一段';
  const WINDOW_SEC = 30;          // ±30 秒字幕窗口
  const MIN_VOICE_CHARS = 4;      // 有效语音文字的最小长度
  const VAD_SILENCE_MS = 700;     // 静音结束判定时长
  const MAX_ENTRIES = 6000;
  const HARDSUB_EVERY_MS = 1500;  // 播放时每隔多久读一次画面底部的硬字幕
  const HARDSUB_STRIP = 0.25;     // 读画面底部多高的一条（占画面高度）
  const DOM_SUB_FRESH_MS = 8000;  // 播放器自己的字幕最近 8 秒出现过，就不读画面
  const VOICE_NOISE_MS = 300;     // v1.2 本机识别：先测 0.3 秒环境噪音
  const VOICE_NO_SPEECH_MS = 6000;
  const VOICE_MAX_MS = 20000;
  const SUB_GUIDE_AFTER_SEC = 20; // v1.2：累计播放 20 秒还没抓到字幕就主动提醒
  const SUB_TOAST_MS = 15000;
  const DEFAULT_SETTINGS = {
    proxyUrl: 'http://localhost:8787', sendImage: true, hardsub: true, voice: true, mode: 'direct',
    voiceEngine: 'local', subGuide: true, summaryAi: true, // v1.2
    keyPoints: true, kpTrack: true, kpCue: true,             // v1.3 课程重点
  };
  const CONFUSED_RE = /还是不懂|没懂|不明白|听不懂|看不懂|不理解|晕/;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    video: null,
    playerRoot: null,
    session: null,
    explaining: false,
    subs: { videoId: null, entries: [], last: '' },
    mem: { videoId: null, trackSent: null, liveSent: 0, info: null, stale: false, busy: false }, // v1.4 整片记忆
    lastDomSubAt: 0,
    frameTainted: false,
    hist: { videoId: null, nodes: [] },                       // 本视频的历史节点（缓存，以后台存储为准）
    guide: { videoId: null, played: 0, lastT: null, shown: false }, // 主动提醒的播放计时
    suppressAskUntil: 0,                                      // 回溯跳转时不弹「我这里不懂」
    pendingChecked: false,
    kp: kpEmpty(null),                                        // v1.3 课程重点
  };

  // ------------------------------------------------------------------ 小工具
  const fmt = (sec) => {
    const s = Math.max(0, Math.floor(sec || 0));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const clip = (s, n) => { s = String(s || '').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  // 等浮层隐藏真正绘制完再截图；rAF 在后台/被节流的标签页里可能不触发，所以兜底 150ms
  const nextPaint = () => new Promise((r) => {
    let done = false;
    const finish = () => { if (!done) { done = true; r(); } };
    setTimeout(finish, 150);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
  const isEditable = (el) => !!el && el.nodeType === 1 && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const bodyLength = (transcript) => transcript.replace(/\[\d{1,3}:\d{2}\]/g, '').replace(/\s/g, '').length;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtDate = (ms) => {
    const d = new Date(ms || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  // ------------------------------------------------------------------ 与扩展后台通信
  function bg(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) resolve({ ok: false, extensionError: true, error: err.message });
          else resolve(resp || { ok: false, error: '扩展后台没有响应' });
        });
      } catch (e) {
        resolve({ ok: false, extensionError: true, error: String((e && e.message) || e) });
      }
    });
  }
  const callProxy = (path, body) => bg({ type: 'call', path, body });
  const logEvent = (body) => { callProxy('/log', body); };

  function streamProxy(path, body, onEvent) {
    let port;
    let ended = false;
    try {
      port = chrome.runtime.connect({ name: 'stream' });
    } catch (e) {
      onEvent({ type: 'error', extensionError: true, message: String((e && e.message) || e) });
      onEvent({ type: 'end' });
      return () => {};
    }
    port.onMessage.addListener((ev) => {
      if (ended) return;
      if (ev.type === 'end') { ended = true; try { port.disconnect(); } catch (_) {} }
      onEvent(ev);
    });
    port.onDisconnect.addListener(() => {
      if (ended) return;
      ended = true;
      onEvent({ type: 'error', interrupted: true, message: '和扩展后台的连接断了，已保留收到的部分。' });
      onEvent({ type: 'end' });
    });
    port.postMessage({ path, body });
    return () => { if (!ended) { ended = true; try { port.disconnect(); } catch (_) {} } };
  }

  function describeError(res) {
    if (!res) return '出错了，请再试一次。';
    if (res.extensionError) return '扩展刚刚被更新或重新加载过，请刷新本页面后再试。';
    if (res.unreachable) return `连不上本地代理（${state.settings.proxyUrl}）。请确认「启动.bat」那个黑色窗口还开着。`;
    return res.error || res.message || '出错了，请再试一次。';
  }

  // ------------------------------------------------------------------ 设置
  function loadSettings() {
    try {
      chrome.storage.local.get(DEFAULT_SETTINGS, (s) => {
        if (chrome.runtime.lastError || !s) return;
        state.settings = { ...DEFAULT_SETTINGS, ...s };
        ui.syncMode();
        ui.syncVoice();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        for (const [k, v] of Object.entries(changes)) {
          if (k in DEFAULT_SETTINGS) state.settings[k] = v.newValue === undefined ? DEFAULT_SETTINGS[k] : v.newValue;
          // 后台写入了本视频的节点（新节点 / AI 一句话说明 / 别的标签页的追问）→ 刷新缓存
          if (k === 'hist:' + state.hist.videoId) setHistCache(state.hist.videoId, v.newValue);
          // 设置页清空了重点标注 → 本页也清掉，继续播放会重新标注
          if (k === 'kp:' + state.kp.videoId && v.newValue === undefined) { state.kp.points = []; state.kp.spans = []; state.kp.ruleReason = null; }
        }
        ui.syncMode();
        ui.syncVoice();
        ui.syncKeypoints();
      });
    } catch (_) { /* 扩展上下文失效时忽略 */ }
  }
  function setMode(mode) {
    state.settings.mode = mode;
    try { chrome.storage.local.set({ mode }); } catch (_) {}
    ui.syncMode();
  }

  // ------------------------------------------------------------------ 视频与页面信息
  function findVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video, bwp-video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  function getVideoId() {
    const u = new URL(location.href);
    const path = u.pathname;
    let id = (path.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i) || [])[1]
      || u.searchParams.get('bvid')
      || (path.match(/\/(ep\d+|ss\d+)/) || [])[1]
      || path;
    const p = u.searchParams.get('p');
    if (p && p !== '1') id += '_p' + p;
    return id;
  }

  function getSubject() {
    const title = document.title.replace(/_哔哩哔哩_bilibili\s*$/, '').replace(/[-_]哔哩哔哩.*$/, '').trim();
    let heading = '';
    for (const sel of ['h1.video-title', '.video-info-title h1', '.video-title', '[class*="video-title"]', '.media-title', '[class*="course-title"]']) {
      const el = document.querySelector(sel);
      const t = el && (el.getAttribute('title') || el.textContent || '').trim();
      if (t) { heading = t; break; }
    }
    const parts = [];
    if (heading) parts.push(heading);
    if (title && !(heading && (title.includes(heading) || heading.includes(title)))) parts.push(title);
    const partEl = document.querySelector('.video-pod__item.active [class*="title"], .list-box li.on .part, .cur-list li.on .part');
    const part = partEl && partEl.textContent.trim();
    if (part && !parts.some((p) => p.includes(part))) parts.push('分P：' + part);
    return clip(parts.join(' / '), 120) || '未知课程';
  }

  // ------------------------------------------------------------------ 字幕采集器
  let observer = null;
  let scanTimer = 0;

  function ensureSubsForVideo() {
    const id = getVideoId();
    if (state.subs.videoId !== id) state.subs = { videoId: id, entries: [], last: '' };
  }

  function observePlayer(v) {
    if (observer) observer.disconnect();
    let root = v.closest('.bpx-player-container, #bilibili-player, [class*="player-container"], [class*="player-wrap"]');
    if (!root) {
      root = v;
      for (let i = 0; i < 6 && root.parentElement && root.parentElement !== document.body; i++) root = root.parentElement;
    }
    state.playerRoot = root;
    observer = new MutationObserver(scheduleScan);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = 0; scanSubtitles(); }, 120);
  }

  function readSubtitle(root) {
    const out = [];
    for (const el of root.querySelectorAll('[class*="subtitle" i]')) {
      if (el.querySelector('[class*="subtitle" i]')) continue; // 只取最内层
      if (el.closest('[class*="ctrl" i], [class*="setting" i], [class*="menu" i]')) continue; // 排除字幕设置菜单
      if (!el.getClientRects().length) continue;
      const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t && !out.includes(t)) out.push(t);
    }
    return out.join(' / ');
  }

  function scanSubtitles() {
    const v = state.video;
    if (!v) return;
    ensureSubsForVideo();
    const subs = state.subs;
    const text = readSubtitle(state.playerRoot || document);
    if (!text) { subs.last = ''; return; }
    state.lastDomSubAt = Date.now();
    if (text === subs.last) return;
    subs.last = text;
    subs.entries.push({ t: v.currentTime, text });
    if (subs.entries.length > MAX_ENTRIES) subs.entries.splice(0, subs.entries.length - MAX_ENTRIES);
  }

  function transcriptWindow(t) {
    const lastSeen = new Map();
    const live = state.subs.entries
      .filter((e) => e.t >= t - WINDOW_SEC && e.t <= t + WINDOW_SEC)
      .sort((a, b) => a.t - b.t)
      .filter((e) => {
        const prev = lastSeen.get(e.text);
        lastSeen.set(e.text, e.t);
        return prev === undefined || e.t - prev > 4; // 倒回去重看时同一句会被记两次
      });
    // v1.3：这一段没播过（例如刚打开就拖到中间暂停），而本视频读到了完整字幕 → 用完整字幕补上
    if (bodyLength(live.map((e) => e.text).join('')) < 20) {
      const fromTrack = trackWindow(t);
      if (fromTrack.length) return fromTrack;
    }
    return live;
  }

  // ------------------------------------------------------------------ 整片记忆（v1.4）
  // 边播边记只有「播过的」字幕：暂停点后 30 秒没有，整部视频讲了什么也不知道。
  // 字幕沿用课程重点（v1.3）读到的完整字幕 state.kp.track（B 站字幕接口，校验过时长、和播放器字幕比对过）；
  // 读不到（没字幕 / AI 字幕要登录 / 番剧 / 设置里关了「读取完整字幕」）就在求助前把播过的字幕交给代理。
  // 代理 /memory/build 在后台生成分层记忆（小节摘要 + 全片大纲）；之后每次求助，
  // 代理按 t_sec 把「全局层 / 章节层 / 焦点层 / 回溯层」拼进提示词。
  const MEM_LIVE_MIN = 30;   // 边播边记至少 30 句才值得做记忆
  const MEM_LIVE_STEP = 40;  // 之后每多 40 句重发一次（代理只重做原文变了的小节）

  function memState() {
    const id = state.subs.videoId;
    if (state.mem.videoId !== id) state.mem = { videoId: id, trackSent: null, liveSent: 0, info: null, stale: false, busy: false, wait: 0 };
    return state.mem;
  }
  // 旧版代理没有 /memory，或代理配置里关了整片记忆：这个视频不再发
  const memOff = (m) => !!(m.info && (m.info.status === 'unsupported' || m.info.status === 'disabled'));

  // 边播边记的字幕 → [开始, 结束, 文本]（结束时间取下一句出现的时刻）
  function liveCues() {
    const es = state.subs.entries.slice().sort((a, b) => a.t - b.t);
    return es.map((e, i) => {
      const next = es[i + 1];
      const end = next && next.t - e.t < 10 ? next.t : e.t + 3;
      return [+e.t.toFixed(2), +end.toFixed(2), e.text];
    });
  }

  async function memBuild(source) {
    const m = memState();
    if (!m.videoId || m.busy || memOff(m)) return;
    const tr = state.kp.track;
    const fromTrack = source === 'track';
    if (fromTrack && !kpTrackReady()) return;
    const cues = fromTrack ? tr.lines.map((l) => [+l.from.toFixed(2), +l.to.toFixed(2), l.text]) : liveCues();
    const force = !fromTrack && m.stale; // 之前用串台的完整字幕做过记忆：用播过的字幕整个重做
    if (fromTrack) m.trackSent = tr.lines; else m.liveSent = state.subs.entries.length;
    m.busy = true;
    const res = await callProxy('/memory/build', {
      video_id: m.videoId,
      subject: getSubject(),
      desc: tr.desc || '',
      source: fromTrack ? 'bilibili' : 'live',
      lan: fromTrack ? tr.lan || '' : '',
      duration: Math.round(kpDuration()),
      cues,
      force,
    });
    m.busy = false;
    if (state.mem !== m) return;
    if (res.ok && res.data) {
      m.info = res.data;
      if (force) m.stale = false;
    } else if (res.status === 404) {
      m.info = { status: 'unsupported' };
    } else {
      // 代理没开 / 出错：过一会儿再试
      if (fromTrack) m.trackSent = null; else m.liveSent = 0;
      m.wait = Date.now() + (res.unreachable ? 30e3 : 60e3);
    }
  }

  // 每秒一次（和课程重点同一个节拍）：完整字幕读到了、确认是这个视频的，就交给代理做整片记忆
  function memTick() {
    const m = memState();
    const k = state.kp;
    const tr = k.track;
    if (!m.videoId || m.busy || memOff(m) || Date.now() < m.wait) return;
    if (m.trackSent && tr.status === 'mismatch') { m.stale = true; m.trackSent = null; } // 播放时发现完整字幕是别的视频的
    if (!kpTrackReady() || m.trackSent === tr.lines) return;
    if (k.played < KP_START_AFTER && !k.forced) return; // 点开看一眼的视频不花调用（求助时会直接发）
    const v = state.video;
    if (!tr.verified && k.played < 60 && v && !v.paused) {
      // 和课程重点一样：播放器上正显示字幕时，先等攒够 3 句、确认完整字幕确实是这个视频的
      const live = state.subs.entries.filter((e) => e.src !== 'ocr' && /[一-鿿]/.test(e.text)).length;
      if (live > 0 && live < 3) return;
    }
    memBuild('track');
  }

  // 求助前：完整字幕还没交给代理就现在交；没有完整字幕时，把播过的字幕交给代理（够多、且比上次多了一截才发）
  function memBeforeAsk() {
    const m = memState();
    if (!m.videoId || m.busy || memOff(m)) return;
    const tr = state.kp.track;
    if (kpTrackReady()) return m.trackSent === tr.lines ? undefined : memBuild('track');
    if (tr.status === 'loading') return; // 完整字幕还在读：这次先不用记忆
    const n = state.subs.entries.length;
    if (n < MEM_LIVE_MIN || (m.liveSent && n - m.liveSent < MEM_LIVE_STEP)) return;
    return memBuild('live'); // 代理只是切小节、起后台任务，很快返回；等它是为了这次求助就能用上
  }

  // ------------------------------------------------------------------ 字幕状态与指引（v1.2 建议 1）
  // 读 B 站播放器的字幕菜单，判断「为什么没字幕」：
  //   on 已打开 / off 有字幕没打开 / need_login AI 字幕要登录 / none 有字幕按钮但没有字幕 / no_button 播放器没有字幕功能
  const SUB_CTRL = '.bpx-player-ctrl-subtitle';
  const SUB_ITEM = '.bpx-player-ctrl-subtitle-language-item';
  const isCloseItem = (el) => /^(close|off)$/i.test(el.dataset.lan || '') || /^关闭/.test((el.textContent || '').trim());

  function subtitleCtrl() {
    return (state.playerRoot && state.playerRoot.querySelector(SUB_CTRL)) || document.querySelector(SUB_CTRL);
  }
  function subtitleItems(ctrl) {
    return ctrl ? [...ctrl.querySelectorAll(SUB_ITEM)].filter((el) => !isCloseItem(el)) : [];
  }
  function displayed(el) {
    if (!el) return false;
    try { return el.style.display !== 'none' && getComputedStyle(el).display !== 'none'; } catch (_) { return false; }
  }

  function subtitleState() {
    const recent = Date.now() - state.lastDomSubAt < DOM_SUB_FRESH_MS;
    const ctrl = subtitleCtrl();
    if (!ctrl) return recent ? 'on' : 'no_button';
    const items = subtitleItems(ctrl);
    if (recent || items.some((el) => el.classList.contains('bpx-state-active'))) return 'on';
    if (displayed(ctrl.querySelector('.bpx-player-ctrl-subtitle-language-unlogin'))) return 'need_login';
    return items.length ? 'off' : 'none';
  }

  const SUB_REASON = {
    off: '这个视频有字幕，只是没打开。',
    need_login: 'B 站的 AI 字幕要登录后才能看。',
    none: '这个视频暂时没有字幕。',
    no_button: '这个视频没有字幕。',
    on: '字幕开着，但这一段还没播放过（字幕是边播边记的）。',
  };

  // 自动点开字幕菜单里的中文字幕：优先人工 CC 中文，其次 AI 中文。1.5 秒内确认字幕出现。
  async function openSubtitles() {
    const ctrl = subtitleCtrl();
    const items = subtitleItems(ctrl);
    const lan = (el) => String(el.dataset.lan || '').toLowerCase();
    const pick = items.find((el) => /^zh/.test(lan(el)))
      || items.find((el) => /^ai-zh/.test(lan(el)))
      || items.find((el) => /中文|汉语|简体/.test(el.textContent || ''))
      || items[0];
    if (!pick) return { ok: false, reason: 'no_item' };
    try { pick.click(); } catch (_) { return { ok: false, reason: 'click_failed' }; }
    for (let i = 0; i < 10; i++) {
      await sleep(150);
      if (pick.classList.contains('bpx-state-active') || subtitleState() === 'on') return { ok: true, lan: lan(pick) || clip(pick.textContent, 12) };
    }
    return { ok: false, reason: 'not_confirmed' };
  }

  function logGuide(where, action, extra) {
    logEvent({ type: 'client_event', event: 'sub_guide', where, action, state: subtitleState(), video_id: getVideoId(), ...(extra || {}) });
  }

  async function guideOpenSubtitles(where) {
    const r = await openSubtitles();
    logGuide(where, 'open', { result: r.ok ? 'ok' : r.reason, lan: r.lan || null });
    if (!r.ok) ui.pointAtSubtitle(); // 点不开：在播放器「字幕」按钮上画一个闪烁的圈
    return r.ok;
  }

  function guideRewind(where, fromT) {
    const v = state.video || findVideo();
    if (!v) return;
    const to = Math.max(0, (fromT == null ? v.currentTime : fromT) - WINDOW_SEC);
    logGuide(where, 'rewind', { from: Math.round(v.currentTime), to: Math.round(to) });
    closeDrawer('rewind');
    state.suppressAskUntil = Date.now() + 800;
    try { v.currentTime = to; } catch (_) {}
    v.play().catch(() => {});
  }

  // 播放中主动提醒：本视频累计播放 ≥20 秒，一句字幕都没抓到（播放器字幕、画面硬字幕都没有）
  function trackGuide() {
    const v = state.video;
    const id = state.subs.videoId;
    if (!v || !id) return;
    const g = state.guide;
    if (g.videoId !== id) {
      let shown = false;
      try { shown = sessionStorage.getItem('lb_sub_guide:' + id) === '1'; } catch (_) {}
      state.guide = { videoId: id, played: 0, lastT: null, shown };
      return;
    }
    if (v.paused || v.ended || document.hidden) { g.lastT = null; return; }
    const t = v.currentTime;
    if (g.lastT != null && t > g.lastT && t - g.lastT < 3) g.played += t - g.lastT;
    g.lastT = t;
    if (g.shown || g.played < SUB_GUIDE_AFTER_SEC || state.settings.subGuide === false) return;
    if (state.subs.entries.length || ui.isOpen()) return;
    if (kpTrackReady()) return; // v1.3：读到了完整字幕，解释和重点都不依赖播放器字幕了
    const st = subtitleState();
    if (st === 'on') return;
    g.shown = true;
    try { sessionStorage.setItem('lb_sub_guide:' + id, '1'); } catch (_) {}
    ui.showSubToast(v, st);
    logGuide('toast', 'shown');
  }

  // ------------------------------------------------------------------ 取帧（直接从 <video> 画到 canvas）
  // 好处：没有弹幕、控制条和我们自己的浮层，也不用截整个标签页。
  // B 站的视频是 MSE（blob:）同源流，画布不会被污染；万一被污染（toDataURL 抛错）就退回整页截图。
  const frameCanvas = document.createElement('canvas');
  function grabVideoFrame(v, { maxWidth = 1280, bottom = 1, quality = 0.85 } = {}) {
    if (!v || v.tagName !== 'VIDEO' || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null;
    const vw = v.videoWidth;
    const vh = v.videoHeight;
    const sh = Math.max(1, Math.round(vh * Math.min(1, bottom)));
    const k = Math.min(1, maxWidth / vw);
    frameCanvas.width = Math.max(1, Math.round(vw * k));
    frameCanvas.height = Math.max(1, Math.round(sh * k));
    try {
      frameCanvas.getContext('2d').drawImage(v, 0, vh - sh, vw, sh, 0, 0, frameCanvas.width, frameCanvas.height);
      return frameCanvas.toDataURL('image/jpeg', quality);
    } catch (_) {
      state.frameTainted = true;
      return null;
    }
  }

  // ------------------------------------------------------------------ 硬字幕采集（字幕烧在画面里，DOM 里没有）
  // 播放器自己的字幕（CC / AI 字幕）没出现时，每 1.5 秒把画面底部一条送给本地代理做文字识别，
  // 识别到的字幕和 DOM 字幕一样按 currentTime 打点，进入 ±30 秒窗口。图片只发到本机代理，不上传。
  const hardsub = { busy: false, pauseUntil: 0, lastEntry: null, ready: null };
  const normSub = (s) => String(s || '').replace(/[\s，。、,.!?！？：:；;“”"'()（）[\]【】《》…·\-—_|]/g, '');
  // 两句话的 2-gram 相似度（0~1）
  function diceScore(a, b) {
    const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
    const A = grams(a);
    const B = grams(b);
    let inter = 0;
    let total = 0;
    for (const [g, n] of A) { inter += Math.min(n, B.get(g) || 0); total += n; }
    for (const n of B.values()) total += n;
    return total > 0 ? (2 * inter) / total : 0;
  }
  function similarSub(a, b, min = 0.6) {
    if (!a || !b) return false;
    if (a === b || a.includes(b) || b.includes(a)) return true;
    return diceScore(a, b) >= min; // 识别有错字时同一句前后两次读出来不完全一样
  }

  function addHardsub(t, text) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    const n = normSub(text);
    if (n.length < 2) return;
    ensureSubsForVideo();
    const entries = state.subs.entries;
    const prev = hardsub.lastEntry;
    if (prev && entries.includes(prev) && t >= prev.t && t - prev.t < 15 && similarSub(normSub(prev.text), n)) {
      if (n.length > normSub(prev.text).length) prev.text = text; // 同一句：留读得更全的那次
      return;
    }
    const e = { t, text, src: 'ocr' };
    entries.push(e);
    hardsub.lastEntry = e;
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  }

  async function sampleHardsub() {
    const v = state.video;
    if (!v || v.paused || v.ended || hardsub.busy || document.hidden) return;
    if (state.settings.hardsub === false || state.frameTainted) return;
    if (Date.now() < hardsub.pauseUntil) return;
    if (Date.now() - state.lastDomSubAt < DOM_SUB_FRESH_MS) return; // 播放器字幕在显示，用它就够了
    const t = v.currentTime;
    const image = grabVideoFrame(v, { maxWidth: 960, bottom: HARDSUB_STRIP, quality: 0.85 });
    if (!image) return;
    hardsub.busy = true;
    try {
      const res = await callProxy('/ocr', { image, region: 'subtitle' });
      if (!res.ok) {
        // 代理没开 / 老版本代理没有 /ocr / 扩展被重新加载：先歇一会儿再试
        hardsub.pauseUntil = Date.now() + (res.extensionError ? 3600e3 : res.status === 404 ? 60e3 : 15e3);
        return;
      }
      const d = res.data || {};
      if (!d.ok) {
        hardsub.ready = false;
        hardsub.pauseUntil = Date.now() + (d.code === 'bad_image' ? 3e3 : 60e3);
        return;
      }
      hardsub.ready = true;
      if (d.subtitle) addHardsub(t, d.subtitle);
    } finally {
      hardsub.busy = false;
    }
  }
  setInterval(sampleHardsub, HARDSUB_EVERY_MS);

  // ------------------------------------------------------------------ 绑定视频
  const videoHandlers = {
    pause: () => onPaused(),
    seeking: () => { state.kp.cueT = null; },
    seeked: () => { if (state.video && state.video.paused) onPaused(); },
    play: () => ui.hideAsk(),
    playing: () => ui.hideAsk(),
    ended: () => ui.hideAsk(),
    emptied: () => ui.hideAsk(),
    timeupdate: () => { scheduleScan(); kpCueCheck(); },
  };

  function bindVideo(v) {
    if (state.video === v) return;
    if (state.video) for (const [ev, fn] of Object.entries(videoHandlers)) state.video.removeEventListener(ev, fn);
    state.video = v;
    for (const [ev, fn] of Object.entries(videoHandlers)) v.addEventListener(ev, fn);
    observePlayer(v);
  }

  function onPaused() {
    const v = state.video;
    if (!v || v.ended || !(v.currentTime > 0.5) || state.explaining) return;
    if (Date.now() < state.suppressAskUntil) return; // 回溯 / 倒回时自己触发的暂停、跳转
    // 这一段（±30 秒）没抓到字幕：按钮下方加一行提醒（v1.2）
    const noSubs = bodyLength(transcriptWindow(v.currentTime).map((e) => e.text).join('')) < 10;
    ui.showAsk(v, { noSubs, histCount: state.hist.nodes.length, kpNear: kpNear(v.currentTime) });
  }

  // ------------------------------------------------------------------ 求助记录（最近三次求助）
  function loadPast(videoId) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get({ ['past:' + videoId]: [] }, (o) => resolve((o && o['past:' + videoId]) || []));
      } catch (_) { resolve([]); }
    });
  }
  function savePast(videoId, item) {
    loadPast(videoId).then((list) => {
      list.push(item);
      try { chrome.storage.local.set({ ['past:' + videoId]: list.slice(-10) }); } catch (_) {}
    });
  }

  // ------------------------------------------------------------------ 历史节点（v1.2 建议 2）
  // 节点由扩展后台统一写入 chrome.storage.local（hist:<视频ID>），这里只保留本视频的缓存用来显示。
  function setHistCache(videoId, entry) {
    if (videoId !== state.hist.videoId) return;
    state.hist.nodes = entry && Array.isArray(entry.nodes) ? entry.nodes : [];
    ui.syncHistory();
  }

  async function loadHistory(videoId) {
    state.hist = { videoId, nodes: [] };
    ui.syncHistory();
    const res = await bg({ type: 'hist:list', videoId });
    if (res && res.ok) setHistCache(videoId, res.data);
  }

  function nodeFromSession(s) {
    return {
      id: s.nodeId,
      videoId: s.videoId,
      subject: s.subject,
      t: s.t,
      timestamp: s.timestamp,
      createdAt: s.createdAt,
      call2: s.call2,
      transcript: s.transcript,
      screenText: s.screenText,
      originalConcept: s.originalConcept,
      route: s.route,
      degraded: s.degraded,
      subsFromScreen: s.subsFromScreen,
      frameCaptured: s.frameCaptured,
      turns: s.turns.filter((t) => t.a).map((t) => ({ q: t.q, a: t.a, mode: t.mode, via: t.via, route: t.route, at: t.at })),
    };
  }

  // 拿到解释后、每轮追问结束后各存一次；会话结束时再让后台生成 AI 一句话说明
  function saveNode(s, summarize) {
    if (!s || !s.call2 || !s.nodeId) return;
    bg({ type: 'hist:put', node: nodeFromSession(s), summarize: !!summarize, sessionId: s.id }).then((res) => {
      if (res && res.ok && res.data) setHistCache(res.data.videoId, res.data);
    });
  }

  function sessionFromNode(node) {
    return {
      id: uid(),
      nodeId: node.id,
      restored: true,
      createdAt: node.createdAt,
      videoId: node.videoId,
      t: node.t,
      timestamp: node.timestamp,
      subject: node.subject || getSubject(),
      transcript: node.transcript || '',
      degraded: !!node.degraded,
      subsFromScreen: !!node.subsFromScreen,
      frameCaptured: node.frameCaptured !== false,
      screenText: node.screenText || '',
      trigger: 'history',
      question: DEFAULT_QUESTION,
      originalConcept: node.originalConcept || '',
      call2: node.call2,
      route: node.route || null,
      turns: (node.turns || []).map((t) => ({ ...t })),
      confused: 0,
      openedAt: Date.now(),
      streaming: null,
      closed: false,
    };
  }

  // 选择节点 = 回溯：视频跳回该位置并暂停，抽屉还原当时的解释和追问，可以接着追问
  function restoreNode(node, where) {
    if (!node || !node.call2) return;
    const cur = state.session;
    if (cur && !cur.closed && cur.nodeId === node.id && ui.isOpen()) { ui.showChat(); return; }
    voice.stop();
    finishSession('switch_node');
    const v = findVideo() || state.video;
    if (v) {
      bindVideo(v);
      state.suppressAskUntil = Date.now() + 1500;
      try { v.pause(); } catch (_) {}
      try { v.currentTime = node.t; } catch (_) {}
    }
    ui.hideAsk();
    const s = sessionFromNode(node);
    state.session = s;
    state.explaining = false;
    ui.openDrawer(s);
    ui.renderExplain(s);
    for (const turn of s.turns) ui.appendTurn(turn).restore(turn);
    ui.showRestored(node);
    logEvent({
      type: 'client_event',
      event: 'history_restore',
      where,
      video_id: node.videoId,
      node_id: node.id,
      node_t: Math.round(node.t),
      node_age_ms: Date.now() - (node.createdAt || Date.now()),
      turns: s.turns.length,
      summary_source: node.summarySource || 'rule',
    });
  }

  function openHistory(where) {
    ui.hideAsk();
    ui.showHistory();
    logEvent({ type: 'client_event', event: 'history_open', where, video_id: state.hist.videoId, nodes: state.hist.nodes.length });
  }

  // 设置页「学习历史」里点了某个节点：设置页先记下 pendingRestore 再打开视频，这里接着回溯
  async function checkPendingRestore() {
    if (state.pendingChecked) return;
    const v = state.video;
    if (!v || v.readyState < 1) return;
    state.pendingChecked = true;
    const o = await new Promise((resolve) => {
      try { chrome.storage.local.get({ pendingRestore: null }, (x) => resolve(x || {})); } catch (_) { resolve({}); }
    });
    const p = o.pendingRestore;
    if (!p || p.videoId !== getVideoId() || Date.now() - (p.at || 0) > 120e3) return;
    try { chrome.storage.local.remove('pendingRestore'); } catch (_) {}
    const res = await bg({ type: 'hist:list', videoId: p.videoId });
    const node = res && res.ok && res.data && (res.data.nodes || []).find((n) => n.id === p.nodeId);
    if (!node) return;
    await sleep(600); // 等 B 站播放器自己的自动播放 / 跳转先完成
    restoreNode(node, 'options');
  }

  // ------------------------------------------------------------------ 课程重点（v1.3 需求 2）
  // 字幕两条来源：完整字幕（B 站字幕接口，全片，优先）；没有就用边播边攒的字幕（只能标已播放的部分）。
  // 分段交给本地代理 /keypoints（Call 5）判定重点；结果存 chrome.storage.local 的 kp:<视频ID>，同一视频再打开直接读缓存。
  // 展示：进度条标记（插在 B 站自己的进度条元素里，跟着控制条显示 / 隐藏 / 全屏走）、抽屉「重点」列表、
  //       播放经过重点时的提示卡片、暂停时「附近重点」。
  const KP_SEG_SEC = 300;          // 完整字幕按约 5 分钟一段
  const KP_SEG_MIN_TAIL = 90;      // 最后不足 90 秒的并进上一段
  const KP_AHEAD_SEC = 1800;       // 最多提前分析到当前位置后 30 分钟
  const KP_START_AFTER = 10;       // 本视频累计播放 10 秒才开始（点开看一眼的视频不花调用）
  const KP_LIVE_MIN_SEC = 150;     // 已播放字幕：攒够 150 秒且 ≥200 字，或攒到 1200 字，就分析这一段
  const KP_LIVE_MIN_CHARS = 200;
  const KP_LIVE_MAX_CHARS = 1200;
  const KP_LIVE_CAP_CHARS = 2400;  // 一次最多送这么多字（代理没开时攒下的一大段分几次送）
  const KP_GAP_SEC = 60;           // 字幕之间断开超过 60 秒（拖动跳过）算两段
  const KP_MAX_VIDEOS = 150;
  const KP_NEAR_BEFORE = 45;       // 暂停位置前 45 秒 ~ 后 15 秒内的重点算「附近重点」
  const KP_NEAR_AFTER = 15;
  const KP_KINDS = ['定义', '结论', '方法', '强调', '易错'];
  const kpNoteOf = (p) => (p.note && !normSub(p.note).startsWith(normSub(String(p.title).replace(/…$/, ''))) ? p.note : '');

  function kpEmpty(videoId) {
    return {
      videoId,
      loaded: false,
      points: [],        // { id, t, timestamp, title, note, kind, level: 1|2, src: 'ai'|'rule', source: 'track'|'live' }
      spans: [],         // 已分析过的时间段 [from, to, source]
      trackLan: null,
      ruleReason: null,  // 有段落用了规则兜底的原因（no_api_key / upstream_error / parse_failed）
      track: { status: 'idle', lines: [], segs: [], lan: null, lanDoc: null, duration: 0, desc: '', verified: false, checkedN: 0 },
      played: 0,
      lastT: null,
      busy: null,        // 正在分析的段 { from, to }
      wait: 0,
      lastErr: null,
      forced: false,     // 打开过重点面板：不等播放满 10 秒
      forceLive: false,  // 点了【分析已播放部分】
      cueT: null,
    };
  }

  const kpTrackReady = () => state.kp.track.status === 'ok' && state.kp.videoId === state.subs.videoId;
  function trackWindow(t) {
    if (!kpTrackReady()) return [];
    return state.kp.track.lines
      .filter((l) => l.from >= t - WINDOW_SEC && l.from <= t + WINDOW_SEC)
      .map((l) => ({ t: l.from, text: l.text, src: 'track' }));
  }
  function kpDuration() {
    const v = state.video;
    if (v && isFinite(v.duration) && v.duration > 0) return v.duration;
    return state.kp.track.duration || 0;
  }
  const kpCoveredAt = (k, t) => k.spans.some((s) => s[0] <= t && t <= s[1]);
  const kpCoveredSpan = (k, from, to) => k.spans.some((s) => s[0] <= from + 1 && s[1] >= to - 1);

  // ---------------- 缓存
  function kpLoad(videoId) {
    const k = kpEmpty(videoId);
    state.kp = k;
    try {
      chrome.storage.local.get({ ['kp:' + videoId]: null }, (o) => {
        if (state.kp !== k) return;
        const e = o && o['kp:' + videoId];
        if (e) {
          k.points = Array.isArray(e.points) ? e.points : [];
          k.spans = Array.isArray(e.spans) ? e.spans : [];
          k.trackLan = e.trackLan || null;
          k.ruleReason = e.ruleReason || null;
        }
        k.loaded = true;
        ui.syncKeypoints();
      });
    } catch (_) { k.loaded = true; }
    ui.syncKeypoints();
  }

  let kpPruned = false;
  function kpSave(k) {
    const entry = { videoId: k.videoId, subject: getSubject(), points: k.points, spans: k.spans, trackLan: k.trackLan, ruleReason: k.ruleReason, updatedAt: Date.now() };
    try { chrome.storage.local.set({ ['kp:' + k.videoId]: entry }); } catch (_) {}
    if (kpPruned) return;
    kpPruned = true; // 每个页面只清理一次：超过 150 个视频时删最久没更新的
    try {
      chrome.storage.local.get(null, (all) => {
        if (!all) return;
        const list = Object.keys(all).filter((x) => x.startsWith('kp:')).map((x) => [x, (all[x] && all[x].updatedAt) || 0]);
        if (list.length <= KP_MAX_VIDEOS) return;
        list.sort((a, b) => a[1] - b[1]);
        chrome.storage.local.remove(list.slice(0, list.length - KP_MAX_VIDEOS).map((x) => x[0]));
      });
    } catch (_) {}
  }

  // ---------------- 完整字幕（和 B 站播放器自己取字幕走同一组接口，带用户自己的登录态）
  function parseVideoRef(id) {
    const m = /^(?:(BV[0-9A-Za-z]+)|av(\d+))(?:_p(\d+))?$/i.exec(id || '');
    if (!m) return null; // 番剧（ep / ss）等接口不同，走「已播放字幕」
    return { q: m[1] ? 'bvid=' + m[1] : 'aid=' + m[2], p: Number(m[3] || 1) };
  }
  async function getJson(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function kpFetchTrack(k) {
    const tr = k.track;
    const finish = (status, extra) => {
      if (state.kp !== k) return;
      Object.assign(tr, extra || {}, { status });
      ui.syncKeypoints();
      logEvent({
        type: 'client_event', event: 'kp_track', result: status, video_id: k.videoId,
        lan: tr.lan || null, lines: tr.lines.length, duration: Math.round(tr.duration || 0), error: (extra && extra.error) || null,
      });
    };
    const ref = parseVideoRef(k.videoId);
    if (!ref) { finish('unsupported'); return; }
    tr.status = 'loading';
    try {
      const view = await getJson('https://api.bilibili.com/x/web-interface/view?' + ref.q);
      if (!view || view.code !== 0 || !view.data) throw new Error('view code ' + (view && view.code));
      const pages = view.data.pages || [];
      const page = pages.find((x) => x.page === ref.p) || pages[ref.p - 1] || pages[0] || {};
      const cid = page.cid || view.data.cid;
      const duration = Number(page.duration || view.data.duration) || 0;
      let info = null;
      for (const path of ['/x/player/v2', '/x/player/wbi/v2']) {
        try {
          const pl = await getJson(`https://api.bilibili.com${path}?${ref.q}&cid=${cid}`);
          if (pl && pl.code === 0 && pl.data) { info = pl.data; break; }
        } catch (_) { /* 试下一个 */ }
      }
      if (!info) throw new Error('player api failed');
      const subs = ((info.subtitle && info.subtitle.subtitles) || []).filter((x) => x && x.subtitle_url);
      if (!subs.length) { finish(info.need_login_subtitle ? 'need_login' : 'none', { duration }); return; }
      // 选字幕：人工中文 → AI 中文 → 其他中文 → 任意一条
      const lanOf = (x) => String(x.lan || '').toLowerCase();
      const pick = subs.find((x) => /^zh/.test(lanOf(x))) || subs.find((x) => /^ai-zh/.test(lanOf(x)))
        || subs.find((x) => /中文|汉语/.test(x.lan_doc || '')) || subs[0];
      let url = String(pick.subtitle_url);
      if (url.startsWith('//')) url = 'https:' + url;
      else if (url.startsWith('http://')) url = 'https://' + url.slice(7);
      const file = await getJson(url);
      const lines = ((file && file.body) || [])
        .map((b) => ({ from: Number(b.from) || 0, to: Number(b.to) || Number(b.from) || 0, text: String(b.content || '').replace(/\s+/g, ' ').trim() }))
        .filter((l) => l.text)
        .sort((a, b) => a.from - b.from);
      const dur = duration || kpDuration();
      const last = lines.length ? lines[lines.length - 1].to : 0;
      const meta = { lan: pick.lan || null, lanDoc: pick.lan_doc || null, duration: dur, desc: clip(String(view.data.desc || ''), 300) }; // desc：v1.4 整片记忆用
      // 校验：这个接口出现过返回别的视频字幕的情况 → 行数太少、时长对不上就不用
      if (lines.length < 10 || (dur > 0 && (last > dur + 30 || last < dur * 0.5))) {
        finish('mismatch', { ...meta, error: `lines=${lines.length} last=${Math.round(last)}s duration=${Math.round(dur)}s` });
        return;
      }
      k.trackLan = meta.lan;
      finish('ok', { ...meta, lines, segs: kpSegments(lines) });
    } catch (e) {
      finish('error', { error: String((e && e.message) || e) });
    }
  }

  // 播放器上实际出现过的字幕（≥3 句）里，至少一句要能在完整字幕 ±10 秒内找到相似句；一句都对不上 → 丢弃完整字幕
  function kpVerifyTrack(k) {
    const tr = k.track;
    if (tr.status !== 'ok' || tr.verified) return;
    const live = state.subs.entries.filter((e) => e.src !== 'ocr' && /[一-鿿]/.test(e.text)); // 画面识字有错字，不拿来判断
    if (live.length < 3 || live.length === tr.checkedN) return;
    tr.checkedN = live.length;
    const sample = live.slice(-8);
    const hit = sample.some((e) => {
      const n = normSub(e.text);
      return tr.lines.some((l) => Math.abs(l.from - e.t) <= 10 && similarSub(normSub(l.text), n, 0.5));
    });
    if (hit) { tr.verified = true; return; }
    tr.status = 'mismatch';
    tr.lines = [];
    tr.segs = [];
    k.points = k.points.filter((p) => p.source !== 'track');
    k.spans = k.spans.filter((s) => s[2] !== 'track');
    kpSave(k);
    ui.syncKeypoints();
    logEvent({ type: 'client_event', event: 'kp_track', result: 'mismatch', where: 'live_check', video_id: k.videoId, lan: tr.lan || null, sample: sample.length });
  }

  // ---------------- 分段
  function kpSegments(lines) {
    const segs = [];
    let cur = null;
    for (const l of lines) {
      if (!cur || l.from - cur.from >= KP_SEG_SEC) { cur = { from: segs.length ? l.from : 0, to: l.to, lines: [] }; segs.push(cur); }
      cur.lines.push(l);
      cur.to = Math.max(cur.to, l.to);
    }
    const tail = segs[segs.length - 1];
    if (segs.length > 1 && tail.to - tail.from < KP_SEG_MIN_TAIL) {
      segs.pop();
      const prev = segs[segs.length - 1];
      prev.lines.push(...tail.lines);
      prev.to = tail.to;
    }
    return segs;
  }

  // 完整字幕：先当前位置所在的段，再往后（最多 30 分钟），再往前补已经看过的
  function kpNextSeg(k, t) {
    const todo = k.track.segs.filter((s) => !kpCoveredSpan(k, s.from, s.to));
    if (!todo.length) return null;
    return todo.find((s) => t >= s.from && t < s.to)
      || todo.find((s) => s.from >= t && s.from <= t + KP_AHEAD_SEC)
      || todo.filter((s) => s.to <= t).pop()
      || null;
  }

  // 已播放字幕：没分析过的字幕按时间连成一段段，够条件的拿出来分析
  function kpLiveChunk(k, force) {
    const v = state.video;
    const now = v ? v.currentTime : 0;
    const seen = new Set();
    const es = state.subs.entries
      .filter((e) => !kpCoveredAt(k, e.t))
      .sort((a, b) => a.t - b.t)
      .filter((e) => { const key = e.text + '@' + Math.round(e.t / 5); if (seen.has(key)) return false; seen.add(key); return true; });
    const chunks = [];
    let c = null;
    for (const e of es) {
      if (!c || e.t - c.to > KP_GAP_SEC) { c = { from: e.t, to: e.t, lines: [], chars: 0 }; chunks.push(c); }
      c.lines.push(e);
      c.to = e.t;
      c.chars += bodyLength(e.text);
    }
    for (const ch of chunks) {
      // 当前位置还在这一段里（正往下播）→ 它还在变长；已经离开（拖走了 / 播完了）就可以收尾
      const open = !(v && v.ended) && now >= ch.from - 1 && now <= ch.to + KP_GAP_SEC;
      const ready = (ch.to - ch.from >= KP_LIVE_MIN_SEC && ch.chars >= KP_LIVE_MIN_CHARS)
        || ch.chars >= KP_LIVE_MAX_CHARS
        || (!open && ch.chars >= 100)
        || (force && ch.chars >= 30);
      if (!ready) continue;
      const lines = [];
      let chars = 0;
      for (const e of ch.lines) {
        if (chars >= KP_LIVE_CAP_CHARS) break;
        lines.push(e);
        chars += bodyLength(e.text);
      }
      return { from: Math.max(0, lines[0].t - 0.5), to: lines[lines.length - 1].t + 0.5, lines: lines.map((e) => ({ t: e.t, text: e.text })), source: 'live' };
    }
    return null;
  }

  // ---------------- 调度：一次只跑一段，跑完歇 1.5 秒
  async function kpPump() {
    const k = state.kp;
    const v = state.video;
    if (!k.videoId || !k.loaded || k.busy || !v || state.settings.keyPoints === false) return;
    if (Date.now() < k.wait) return;
    if (k.played < KP_START_AFTER && !k.forced) return;
    const tr = k.track;
    if (tr.status === 'loading' || (tr.status === 'idle' && state.settings.kpTrack !== false)) return; // 等完整字幕的结果
    let job = null;
    if (tr.status === 'ok' && !tr.verified && k.played < 60 && !v.paused) {
      // 播放器上正显示字幕：先等攒够 3 句、确认完整字幕确实是这个视频的再分析（免得白花一次调用）
      const live = state.subs.entries.filter((e) => e.src !== 'ocr' && /[一-鿿]/.test(e.text)).length;
      if (live > 0 && live < 3) return;
    }
    if (tr.status === 'ok') {
      const seg = kpNextSeg(k, v.currentTime);
      if (seg) job = { from: seg.from, to: seg.to, lines: seg.lines.map((l) => ({ t: l.from, text: l.text })), source: 'track' };
    } else {
      job = kpLiveChunk(k, k.forceLive || v.ended);
      if (!job) k.forceLive = false;
    }
    if (job) await kpRun(k, job);
  }

  async function kpRun(k, job) {
    k.busy = { from: job.from, to: job.to };
    ui.tickKeypoints();
    const res = await callProxy('/keypoints', {
      video_id: k.videoId,
      subject: getSubject(),
      span_from: Math.floor(job.from),
      span_to: Math.ceil(job.to),
      duration: Math.round(kpDuration()),
      lines: job.lines.map((l) => ({ t: Math.round(l.t * 10) / 10, text: l.text })),
      known: k.points.map((p) => p.title).slice(-40),
      source: job.source,
    });
    k.busy = null;
    if (state.kp !== k) return;
    if (!res.ok) {
      // 代理没开 / 旧版代理没有 /keypoints / 扩展被重新加载：先歇一会儿，面板里写明原因
      k.lastErr = res.extensionError ? 'extension' : res.unreachable ? 'unreachable' : res.status === 404 ? 'old_proxy' : 'error';
      k.wait = Date.now() + (res.extensionError ? 3600e3 : res.unreachable ? 30e3 : res.status === 404 ? 600e3 : 60e3);
      ui.syncKeypoints();
      return;
    }
    const d = res.data || {};
    k.lastErr = null;
    if (d.source === 'rule' && d.fallback_reason) k.ruleReason = d.fallback_reason;
    for (const p of Array.isArray(d.points) ? d.points : []) {
      const t = Number(p.t);
      if (!isFinite(t) || !p.title) continue;
      if (k.points.some((q) => Math.abs(q.t - t) < 15)) continue;
      k.points.push({
        id: uid(),
        t,
        timestamp: fmt(t),
        title: clip(p.title, 16),
        note: clip(p.note || '', 40),
        kind: KP_KINDS.includes(p.kind) ? p.kind : '强调',
        level: Number(p.level) === 2 ? 2 : 1,
        src: d.source === 'rule' ? 'rule' : 'ai',
        source: job.source,
      });
    }
    k.points.sort((a, b) => a.t - b.t);
    k.spans.push([Math.round(job.from * 10) / 10, Math.round(job.to * 10) / 10, job.source]);
    k.wait = Date.now() + 1500;
    kpSave(k);
    ui.syncKeypoints();
  }

  function kpTick() {
    const id = state.subs.videoId;
    if (!id) return;
    if (state.kp.videoId !== id) kpLoad(id);
    const k = state.kp;
    const v = state.video;
    if (v && !v.paused && !v.ended && !document.hidden) {
      const t = v.currentTime;
      if (k.lastT != null && t > k.lastT && t - k.lastT < 3) k.played += t - k.lastT;
      k.lastT = t;
    } else k.lastT = null;
    // v1.4：整片记忆也用完整字幕，所以关掉课程重点也照读（只有关掉「读取完整字幕」才不读）
    if (state.settings.kpTrack !== false && k.track.status === 'idle' && k.loaded) kpFetchTrack(k);
    kpVerifyTrack(k);
    if (state.settings.keyPoints !== false) kpPump();
    memTick();
    kpRenderMarkers();
    ui.tickKeypoints();
  }

  // ---------------- 状态文字（重点面板底部 / 空列表）
  const KP_TRACK_NOTE = {
    need_login: '登录 B 站后能读取完整字幕，提前标出全片重点。',
    none: '这个视频没有完整字幕。',
    mismatch: '完整字幕和视频对不上，已改用播放时的字幕。',
    error: '完整字幕读取失败。',
  };
  function kpStatus() {
    const k = state.kp;
    const tr = k.track;
    const out = { text: '', warn: false, canRun: false, empty: '' };
    if (state.settings.keyPoints === false) {
      out.text = '课程重点标注已在设置里关闭。';
      out.empty = '课程重点标注已关闭（设置页「课程重点」可以打开）。';
      return out;
    }
    const dur = kpDuration();
    const waitingTrack = tr.status === 'loading' || (tr.status === 'idle' && state.settings.kpTrack !== false);
    const started = k.played >= KP_START_AFTER || k.forced;
    let basis;
    if (tr.status === 'ok') {
      const done = tr.segs.filter((s) => kpCoveredSpan(k, s.from, s.to)).length;
      basis = `依据完整字幕${tr.lanDoc ? `（${tr.lanDoc}）` : ''} · 已分析 ${done}/${tr.segs.length} 段${dur ? `（全长 ${fmt(dur)}）` : ''}`;
    } else if (waitingTrack) {
      basis = '正在读取完整字幕…';
    } else {
      const note = state.settings.kpTrack === false ? '设置里关了「读取完整字幕」。' : (KP_TRACK_NOTE[tr.status] || '');
      basis = '依据已播放的字幕 · 继续播放会接着标注' + (note ? '。' + note : '');
      out.canRun = !k.busy && !!kpLiveChunk(k, true);
    }
    if (k.busy) out.text = `正在分析 ${fmt(k.busy.from)}–${fmt(k.busy.to)}…`;
    else if (k.lastErr === 'unreachable') { out.text = '连不上本地代理，标注先暂停（「启动.bat」开着就会自动继续）。'; out.warn = true; }
    else if (k.lastErr === 'old_proxy') { out.text = '本地代理是旧版本，没有课程重点功能：关掉「启动.bat」窗口再重新打开。'; out.warn = true; }
    else if (k.lastErr === 'extension') { out.text = '扩展刚被更新过，请刷新本页面。'; out.warn = true; }
    else if (k.lastErr === 'error') { out.text = '这一段分析出错了，1 分钟后自动重试。'; out.warn = true; }
    else if (k.ruleReason) {
      out.text = basis + '。' + (k.ruleReason === 'no_api_key' ? '代理没配置 API Key，重点是按关键词粗略标的。' : '有的段落模型没给出可用结果，按关键词粗略标注。');
      out.warn = k.ruleReason === 'no_api_key';
    } else out.text = basis;
    if (k.busy) out.empty = '正在读字幕找重点…';
    else if (waitingTrack) out.empty = '正在读取完整字幕…';
    else if (tr.status === 'ok') out.empty = k.spans.length ? '已经分析的部分没有找到明显的重点。' : started ? '正在读字幕找重点…' : '播放 10 秒后自动开始标注。';
    else if (state.subs.entries.length) out.empty = '还没攒够字幕。继续播放会边播边标；也可以点下面的【分析已播放部分】。';
    else out.empty = '还没抓到字幕。打开播放器的字幕继续播放，重点会边播边标出来。';
    return out;
  }

  // ---------------- 交互
  function kpNear(t) {
    if (state.settings.keyPoints === false) return null;
    let best = null;
    for (const p of state.kp.points) {
      if (p.t < t - KP_NEAR_BEFORE || p.t > t + KP_NEAR_AFTER) continue;
      if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    }
    return best;
  }

  function kpJump(p, where) {
    const v = findVideo() || state.video;
    if (!v) return;
    logEvent({ type: 'client_event', event: 'kp_jump', where, video_id: state.kp.videoId, t: Math.round(p.t), from: Math.round(v.currentTime), kind: p.kind, src: p.src });
    if (ui.isOpen()) closeDrawer('kp_jump');
    ui.hideAsk();
    ui.hideKpCue();
    state.suppressAskUntil = Date.now() + 800;
    try { v.currentTime = Math.max(0, p.t - 2); } catch (_) {}
    v.play().catch(() => {});
  }

  function openKeypoints(where) {
    const k = state.kp;
    k.forced = true; // 打开面板 = 立即开始标注，不用等播放满 10 秒
    ui.hideAsk();
    ui.showKeypoints();
    logEvent({ type: 'client_event', event: 'kp_open', where, video_id: k.videoId, points: k.points.length, track: k.track.status });
    kpPump();
  }

  function kpAnalyzeNow() {
    const k = state.kp;
    k.forced = true;
    k.forceLive = true;
    k.wait = 0;
    k.lastErr = null;
    kpPump();
    ui.syncKeypoints();
  }

  // 播放正常经过一个重点（不是拖过去的）→ 视频左上角提示 5 秒
  function kpCueCheck() {
    const k = state.kp;
    const v = state.video;
    if (!v || v.paused || v.ended) { k.cueT = null; return; }
    const t = v.currentTime;
    const prev = k.cueT;
    k.cueT = t;
    if (prev == null || t <= prev || t - prev > 1.5) return;
    if (state.settings.keyPoints === false || state.settings.kpCue === false || ui.isOpen() || document.hidden) return;
    const p = k.points.find((x) => x.t > prev && x.t <= t);
    if (!p) return;
    ui.showKpCue(v, p);
    logEvent({ type: 'client_event', event: 'kp_cue', action: 'shown', video_id: k.videoId, t: Math.round(p.t), kind: p.kind });
  }

  // ---------------- 进度条标记：插在 B 站自己的进度条里（鼠标移上去时的进度条 + 控制条收起时底部常驻的细进度条）
  const kpBar = { layers: {}, bound: new WeakSet() };
  const KP_BARS = [['.bpx-player-progress', 'main'], ['.bpx-player-shadow-progress-area', 'shadow']];

  function kpRenderMarkers() {
    const k = state.kp;
    const dur = kpDuration();
    const pts = state.settings.keyPoints !== false && dur > 0 && k.videoId === state.subs.videoId ? k.points : [];
    const sig = `${k.videoId}|${Math.round(dur)}|${pts.map((p) => p.t + ':' + p.level).join(',')}`;
    for (const [sel, kind] of KP_BARS) {
      const bar = (state.playerRoot && state.playerRoot.querySelector(sel)) || document.querySelector(sel);
      if (!bar) continue;
      let layer = kpBar.layers[kind];
      if (!layer || layer.parentNode !== bar) { // 第一次，或 B 站把进度条重绘掉了 → 补回来
        if (layer) layer.remove();
        layer = document.createElement('div');
        layer.className = 'coaxly-kp';
        layer.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2;';
        bar.appendChild(layer);
        kpBar.layers[kind] = layer;
        if (kind === 'main') kpBindHover(bar);
      }
      if (layer.dataset.sig === sig) continue;
      layer.dataset.sig = sig;
      layer.textContent = '';
      for (const p of pts) {
        const m = document.createElement('i');
        const left = Math.max(0, Math.min(100, (p.t / dur) * 100)).toFixed(3) + '%';
        m.style.cssText = kind === 'main' && p.level === 2
          ? `position:absolute;left:${left};top:50%;width:8px;height:8px;transform:translate(-50%,-50%) rotate(45deg);background:#7fa2da;border:1px solid #fdf9ee;border-radius:1px;box-sizing:border-box;`
          : `position:absolute;left:${left};top:0;width:${kind === 'main' ? 3 : 2}px;height:100%;transform:translateX(-50%);background:#7fa2da;border-radius:1px;`;
        layer.appendChild(m);
      }
    }
  }

  function kpBindHover(bar) {
    const area = bar.closest('.bpx-player-progress-wrap') || bar;
    if (kpBar.bound.has(area)) return;
    kpBar.bound.add(area);
    area.addEventListener('mousemove', (e) => {
      const r = bar.getBoundingClientRect();
      const dur = kpDuration();
      if (!r.width || !dur || state.settings.keyPoints === false) { ui.hideKpTip(); return; }
      let best = null;
      let bestD = 8;
      for (const p of state.kp.points) {
        const x = r.left + (p.t / dur) * r.width;
        const d = Math.abs(x - e.clientX);
        if (d <= bestD) { bestD = d; best = { p, x }; }
      }
      if (best) ui.showKpTip(best.p, best.x, r);
      else ui.hideKpTip();
    });
    area.addEventListener('mouseleave', () => ui.hideKpTip());
  }

  // ------------------------------------------------------------------ 会话：Call 2
  function newSession(v, trigger) {
    ensureSubsForVideo();
    const t = v.currentTime;
    const entries = transcriptWindow(t);
    const transcript = entries.map((e) => `[${fmt(e.t)}] ${e.text}`).join('\n');
    const before = entries.filter((e) => e.t <= t + 0.5);
    return {
      id: uid(),
      nodeId: uid(),        // v1.2 历史节点编号（回溯后接着追问仍用同一个）
      restored: false,
      createdAt: Date.now(),
      videoId: getVideoId(),
      t,
      timestamp: fmt(t),
      subject: getSubject(),
      transcript,
      degraded: bodyLength(transcript) < 10,
      subsFromScreen: entries.some((e) => e.src === 'ocr'),
      subsFromTrack: entries.some((e) => e.src === 'track'),
      screenText: '',
      trigger,
      question: DEFAULT_QUESTION,
      originalConcept: clip(before.length ? before[before.length - 1].text : '', 40),
      call2: null,
      route: null,
      turns: [],
      confused: 0,
      openedAt: Date.now(),
      streaming: null,
      closed: false,
    };
  }

  async function startExplain(trigger) {
    const v = findVideo() || state.video;
    if (!v || state.explaining) return;
    bindVideo(v);
    if (!v.paused) { try { v.pause(); } catch (_) {} }
    scanSubtitles();
    finishSession('retrigger');
    voice.stop();

    const s = newSession(v, trigger);
    state.session = s;
    state.explaining = true;
    ui.hideAsk();

    let image = null;
    if (state.settings.sendImage !== false) {
      // 优先直接从 <video> 取干净的一帧；取不到再整页截图（截图前先把自己的浮层藏起来，免得拍进画面）
      image = grabVideoFrame(v, { maxWidth: 1280, quality: 0.85 });
      if (image) s.frameSource = 'video';
      else {
        ui.setHidden(true);
        await nextPaint();
        const r = v.getBoundingClientRect();
        const cap = await bg({
          type: 'capture',
          rect: { x: r.left, y: r.top, width: r.width, height: r.height },
          viewport: { width: window.innerWidth, height: window.innerHeight },
        });
        ui.setHidden(false);
        if (cap && cap.ok) { image = cap.dataUrl; s.frameSource = 'screen'; }
        else s.captureError = (cap && cap.error) || 'capture_failed';
      }
    }
    s.frameCaptured = !!image;
    ui.openDrawer(s);
    await runExplain(s, image);
  }

  async function runExplain(s, image) {
    state.explaining = true;
    ui.renderLoading(s);
    const past = (await loadPast(s.videoId)).slice(-3).map((p) => ({ question: p.question, core: p.core }));
    if (!s.restored) { try { await memBeforeAsk(); } catch (_) {} }
    const res = await callProxy('/explain', {
      session_id: s.id,
      video_id: s.videoId,
      subject: s.subject,
      timestamp: s.timestamp,
      t_sec: s.t, // v1.4：代理按它从整片记忆里切焦点层、定位章节
      transcript: s.transcript,
      question: s.question,
      past,
      route: 'in_video', // 按钮路径跳过 Call 1，路由恒定 in_video
      trigger: s.trigger,
      image,
    });
    if (state.session === s) state.explaining = false;
    if (state.session !== s || s.closed) return;
    if (!res.ok) {
      ui.renderExplainError(s, describeError(res), () => runExplain(s, image));
      return;
    }
    const d = res.data || {};
    s.call2 = d;
    // 代理可能用暂停那一帧读到的字幕补全了上下文；追问时沿用补全后的版本和画面文字
    if (typeof d.transcript === 'string' && d.transcript.length >= s.transcript.length) s.transcript = d.transcript;
    if (typeof d.degraded === 'boolean') s.degraded = d.degraded;
    s.screenText = d.screen_text || '';
    s.memory = d.memory || null;
    if (!s.originalConcept && s.transcript) {
      const lines = s.transcript.trim().split('\n');
      s.originalConcept = clip(lines[lines.length - 1].replace(/^\[\d{1,3}:\d{2}\]\s*/, ''), 40);
    }
    const first = (d.segments && d.segments[0]) || d.text || '';
    if (!s.originalConcept) s.originalConcept = clip(first, 40);
    ui.renderExplain(s);
    savePast(s.videoId, { question: `[${s.timestamp}] ${s.question}`, core: clip(first, 50), at: Date.now() });
    saveNode(s); // v1.2：生成历史节点（规则说明立即有）
  }

  // ------------------------------------------------------------------ 会话：Call 3 追问
  function sendFollowup(raw, via) {
    const s = state.session;
    const text = String(raw || '').trim();
    if (!s || s.closed || !text) return;
    if (!s.call2) { ui.showTip('等第一段解释出来再追问～'); return; }
    if (s.streaming) s.streaming.cancel();

    const mode = state.settings.mode === 'socratic' ? 'socratic' : 'direct';
    const turn = { q: text, a: '', mode, via, route: null, at: Date.now() };
    const history = s.turns.filter((t) => t.a && t.route !== 'off_topic').slice(-2).map((t) => ({ q: t.q, a: t.a }));
    s.turns.push(turn);
    const view = ui.appendTurn(turn);

    if (CONFUSED_RE.test(text)) s.confused += 1;
    if (mode === 'direct' && s.confused >= 2) ui.showTip('还卡着？试试切到「带我想」，我一步一步问你。');
    else ui.hideTip();

    const cancel = streamProxy('/followup', {
      session_id: s.id,
      video_id: s.videoId,
      subject: s.subject,
      timestamp: s.timestamp,
      t_sec: s.t,
      transcript: s.transcript,
      original_concept: s.originalConcept,
      call2_output: s.call2.text,
      screen_text: s.screenText || '',
      follow_up: text,
      history,
      mode,
      route: s.route, // null → 代理先跑 Call 1；之后沿用
      turn_index: s.turns.length,
    }, (ev) => {
      if (state.session !== s) return;
      if (ev.type === 'route') {
        turn.route = ev.route;
        if (ev.route !== 'off_topic') s.route = ev.route; // 离题不沿用，下一句重新判断
        if (ev.route === 'off_topic') { turn.a = ev.redirect || '先回到视频内容吧'; view.setText(turn.a); view.markRedirect(); }
        else if (ev.route === 'related_general') view.setNote('和当前片段关系不大');
      } else if (ev.type === 'delta') {
        turn.a += ev.text;
        view.setText(turn.a);
      } else if (ev.type === 'done') {
        view.setMeta(ev);
      } else if (ev.type === 'error') {
        view.setError(describeError(ev.unreachable ? { unreachable: true } : ev.extensionError ? { extensionError: true } : { error: ev.message }));
      } else if (ev.type === 'end') {
        view.finish();
        if (s.streaming && s.streaming.turn === turn) s.streaming = null;
        if (!s.closed) saveNode(s); // 每轮追问结束更新节点
      }
    });
    s.streaming = { turn, cancel: () => { cancel(); view.finish(); } };
  }

  function finishSession(reason) {
    const s = state.session;
    if (!s || s.closed) return;
    s.closed = true;
    if (s.streaming) { s.streaming.cancel(); s.streaming = null; }
    if (state.explaining) state.explaining = false;
    logEvent({
      type: 'close',
      reason,
      session_id: s.id,
      video_id: s.videoId,
      timestamp: s.timestamp,
      call2_ok: !!s.call2,
      turns: s.turns.length,
      user_closed_without_followup: !!s.call2 && s.turns.length === 0, // 记录未追问即关闭的会话
      open_ms: Date.now() - s.openedAt,
      mode: state.settings.mode,
      node_id: s.call2 ? s.nodeId : null,
      restored: !!s.restored,
    });
    // 会话结束：节点存最终版，并让后台生成 AI 一句话说明（关掉页面也会继续）
    saveNode(s, state.settings.summaryAi !== false);
  }

  function closeDrawer(reason) {
    voice.stop();
    finishSession(reason);
    ui.closeDrawer();
  }

  // ------------------------------------------------------------------ 语音追问（本机识别）
  // v1.1 用的 Chrome 自带识别（webkitSpeechRecognition）要把声音发到 Google，国内连不上，语音完全不可用。
  // v1.2 默认：页面里录音（16kHz 单声道）+ 本地静音检测 → WAV 发给本地代理 /asr → Windows 离线识别 → 自动发出追问。
  // 设置页可以切回「浏览器自带」（能访问 Google 时可用）。
  const voice = (() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const AC = window.AudioContext || window.webkitAudioContext;
    const FILLER_RE = /^[嗯啊呃额哦噢喔唔哎诶欸呀哈么吗呢吧了\s，。,.!?！？、…~～]*$/;
    const ONE_CHAR_OK = /^[是对不好行嗯]$/; // 回答「问你一句」时可能只说一个字
    let token = 0;       // 每次开始 / 停止都 +1，过期的回调直接丢弃
    let rec = null;      // 本机录音：{ finish(reason), abort() }
    let browser = null;  // 浏览器识别：{ commit(), abort() }

    const engine = () => (state.settings.voiceEngine === 'browser' && SR ? 'browser' : 'local');
    const canLocal = () => !!(AC && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const logVoice = (result, extra) => logEvent({ type: 'client_event', event: 'voice', engine: engine(), result, session_id: state.session && state.session.id, ...(extra || {}) });

    function deliver(text, sess, extra) {
      const clean = String(text || '').trim();
      const core = clean.replace(/[\s，。,.!?！？、…~～]/g, '');
      if (!clean) {
        ui.showTip('没听清，再点麦克风说一次试试，或直接打字。');
        logVoice('empty', extra);
        return;
      }
      if (FILLER_RE.test(clean) || (core.length < 2 && !ONE_CHAR_OK.test(core))) {
        ui.setInput(clean);
        ui.focusInput();
        ui.showTip('只听到「' + clean + '」，改一下再发送？');
        logVoice('filled', { ...extra, chars: core.length });
        return;
      }
      if (state.session !== sess || !sess || sess.closed) return;
      ui.setInput('');
      sendFollowup(clean, 'voice');
      logVoice('sent', { ...extra, chars: core.length });
    }

    // ---------------- 本机识别：录音 + 静音检测
    function encodeWav(chunks, rate) {
      let n = 0;
      for (const c of chunks) n += c.length;
      const pcm = new Float32Array(n);
      let o = 0;
      for (const c of chunks) { pcm.set(c, o); o += c.length; }
      // 不是 16kHz（浏览器不支持指定采样率时）就按块平均降采样
      let out = pcm;
      if (rate !== 16000) {
        const k = rate / 16000;
        out = new Float32Array(Math.floor(pcm.length / k));
        for (let i = 0; i < out.length; i++) {
          const a = Math.floor(i * k);
          const b = Math.min(pcm.length, Math.floor((i + 1) * k));
          let sum = 0;
          for (let j = a; j < b; j++) sum += pcm[j];
          out[i] = b > a ? sum / (b - a) : 0;
        }
      }
      const buf = new ArrayBuffer(44 + out.length * 2);
      const dv = new DataView(buf);
      const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
      str(0, 'RIFF'); dv.setUint32(4, 36 + out.length * 2, true); str(8, 'WAVE');
      str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      str(36, 'data'); dv.setUint32(40, out.length * 2, true);
      for (let i = 0; i < out.length; i++) {
        const v = Math.max(-1, Math.min(1, out[i]));
        dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      }
      return new Uint8Array(buf);
    }
    function toBase64(bytes) {
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }

    function asrError(res) {
      if (res.extensionError || res.unreachable) return describeError(res);
      if (res.status === 404) return '本地代理还是旧版本，不支持语音识别。请关掉「启动.bat」的黑色窗口，再双击重新打开。';
      const d = res.data || {};
      if (d.code === 'asr_disabled') return '语音识别在代理配置里关掉了（config.json 的 asr.engine）。可以直接打字。';
      if (d.code === 'asr_unavailable') return '本机语音识别不可用：' + (d.error || '未知原因') + '。可以在设置页改用「浏览器自带」识别，或直接打字。';
      return '语音识别失败：' + (d.error || res.error || '未知错误') + '。可以直接打字。';
    }

    async function startLocal() {
      const my = ++token;
      const sess = state.session;
      ui.setMic('listening');
      ui.hideTip();
      ui.setInput('');
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e) {
        if (my !== token) return;
        ui.setMic(false);
        const name = (e && e.name) || '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          ui.showTip('麦克风权限被拒绝了：点地址栏左边的图标，把「麦克风」改成允许，再点一次麦克风。也可以直接打字。');
          logVoice('denied');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          ui.showTip('没有找到麦克风，请直接打字或点快捷回复。');
          logVoice('no_mic');
        } else {
          ui.showTip('打不开麦克风：' + ((e && e.message) || name || '未知错误') + '。可以直接打字。');
          logVoice('mic_error', { error: String((e && e.message) || name) });
        }
        return;
      }
      if (my !== token) { stream.getTracks().forEach((t) => t.stop()); return; }

      let ctx;
      try { ctx = new AC({ sampleRate: 16000 }); } catch (_) { ctx = new AC(); }
      try { await ctx.resume(); } catch (_) {}
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      const chunks = [];
      const t0 = performance.now();
      let noise = 0;
      let noiseN = 0;
      let thr = 0.012;
      let speechAt = 0;
      let lastVoice = 0;
      let ended = false;

      const cleanup = () => {
        try { proc.disconnect(); src.disconnect(); } catch (_) {}
        proc.onaudioprocess = null;
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        ui.setMicLevel(0);
      };

      async function finish(reason) {
        if (ended) return;
        ended = true;
        cleanup();
        rec = null;
        if (reason === 'abort' || my !== token) return;
        const audioMs = Math.round(performance.now() - t0);
        if (reason === 'no_speech') {
          ui.setMic(false);
          ui.showTip('没听到声音。再点一次麦克风，说完停一下会自动发送。');
          logVoice('no_speech', { audio_ms: audioMs });
          return;
        }
        const samples = chunks.reduce((n, c) => n + c.length, 0);
        if (samples < ctx.sampleRate * 0.4) { ui.setMic(false); return; } // 刚点开就又点了一下
        ui.setMic('busy');
        const wav = encodeWav(chunks, ctx.sampleRate);
        const t1 = performance.now();
        const res = await callProxy('/asr', {
          audio: 'data:audio/wav;base64,' + toBase64(wav),
          session_id: sess && sess.id,
          video_id: sess && sess.videoId,
        });
        if (my !== token) return;
        ui.setMic(false);
        const extra = { reason, audio_ms: audioMs, asr_ms: Math.round(performance.now() - t1) };
        if (!res.ok || !res.data || !res.data.ok) {
          ui.showTip(asrError(res));
          logVoice('asr_error', { ...extra, status: res.status || null, code: (res.data && res.data.code) || null });
          return;
        }
        deliver(res.data.text, sess, { ...extra, asr_engine: res.data.engine });
      }

      proc.onaudioprocess = (e) => {
        if (ended) return;
        const data = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(data));
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        const now = performance.now() - t0;
        ui.setMicLevel(Math.min(1, rms / 0.08));
        if (now < VOICE_NOISE_MS) {
          noise += rms;
          noiseN++;
          thr = Math.max(0.012, (noise / noiseN) * 3);
          return;
        }
        if (rms > thr) { if (!speechAt) speechAt = now; lastVoice = now; }
        if (speechAt && now - lastVoice > VAD_SILENCE_MS) finish('vad');   // 说完停 0.7 秒 → 结束
        else if (!speechAt && now > VOICE_NO_SPEECH_MS) finish('no_speech');
        else if (now > VOICE_MAX_MS) finish('max');
      };
      src.connect(proc);
      proc.connect(ctx.destination); // ScriptProcessor 要接到输出才会跑；不写输出缓冲区 = 静音
      rec = { finish, abort: () => finish('abort') };
    }

    // ---------------- 浏览器自带识别（v1.1 的做法，需要能访问 Google）
    function startBrowser() {
      const my = ++token;
      const r = new SR();
      r.lang = 'zh-CN';
      r.interimResults = true; // 首个 partial 就拿到
      r.continuous = true;
      r.maxAlternatives = 1;
      let committed = false;
      let finalText = '';
      let silenceTimer = 0;
      const sess = state.session;
      const commit = () => {
        if (committed) return;
        committed = true;
        clearTimeout(silenceTimer);
        try { r.stop(); } catch (_) {}
        const text = ui.getInput().trim();
        if (text) deliver(text, sess, { reason: 'browser' });
      };
      ui.setInput('');
      r.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const x = e.results[i];
          if (x.isFinal) finalText += x[0].transcript;
          else interim += x[0].transcript;
        }
        const text = (finalText + interim).trim();
        ui.setInput(text);
        clearTimeout(silenceTimer);
        // ≥4 字后，短静音就算说完；不等浏览器自己的长端点判定
        if (text.replace(/\s/g, '').length >= MIN_VOICE_CHARS) silenceTimer = setTimeout(commit, interim ? VAD_SILENCE_MS : 250);
      };
      r.onerror = (e) => {
        const map = {
          'not-allowed': '麦克风权限被拒绝了，可以直接打字或点快捷回复。',
          'service-not-allowed': '浏览器不允许语音识别，可以直接打字或点快捷回复。',
          network: '浏览器自带的语音识别要访问 Google，现在连不上。请到设置页把「语音识别方式」改成「本机识别」。',
          'audio-capture': '没有找到麦克风，请直接打字。',
          'no-speech': '没听到声音，再点一次麦克风试试。',
        };
        if (map[e.error]) ui.showTip(map[e.error]);
        logVoice('browser_error', { error: e.error });
      };
      r.onend = () => {
        clearTimeout(silenceTimer);
        if (my === token) { browser = null; ui.setMic(false); }
        if (!committed && ui.getInput().trim().length >= 2) commit();
      };
      try {
        r.start();
        browser = { commit, abort: () => { committed = true; clearTimeout(silenceTimer); try { r.abort(); } catch (_) {} } };
        ui.setMic('listening');
        ui.hideTip();
      } catch (_) {
        browser = null;
        ui.setMic(false);
      }
    }

    function stop() {
      token++;
      if (rec) rec.abort();
      if (browser) browser.abort();
      rec = null;
      browser = null;
      ui.setMic(false);
    }

    function toggle() {
      if (rec) return rec.finish('manual');     // 录音中再点一次 = 立即结束并识别
      if (browser) return browser.commit();
      if (ui.micBusy()) return undefined;       // 正在识别，等结果
      return engine() === 'browser' ? startBrowser() : startLocal();
    }

    return {
      supported: () => (engine() === 'browser' ? !!SR : canLocal()),
      toggle,
      stop,
    };
  })();

  // ------------------------------------------------------------------ 界面（Shadow DOM）
  // logo 配色预览：奶油白底 + logo 长春花蓝（#7fa2da 做装饰，加深的 #4a6fb8 做文字和按钮）+ 藏青墨色；原 v1.3 视觉：暖象牙白底 + 陶土橙一处点睛 + 衬线体读正文 + 细线代替阴影（只借鉴审美，不用任何品牌标志）。
  // 不加载网络字体：拉丁字母走 Georgia，中文回落到本机的思源宋体 / 华文宋体 / 宋体。
  const CSS = `
:host {
  all: initial;
  --bg: #fcfbf7; --bg-soft: #eef2fa; --surface: #ffffff;
  --ink: #1f2a44; --ink-2: #56607a; --ink-3: #7a849b;
  --line: #e3e8f1; --line-strong: #cfd8e8;
  --accent: #4a6fb8; --accent-hover: #3d5f9f; --accent-soft: #e9effa; --on-accent: #ffffff;
  --brand: #7fa2da; --brand-soft: #b8cff1; --cream: #fdf9ee;
  --kraft: #e3b866; --warn: #8a6224; --warn-soft: #fdf6e6; --warn-line: #f0e1bd;
  --err: #c0473b; --err-soft: #fbeae7; --olive: #4b8570;
  --solid: #2f3f63; --on-solid: #ffffff;
  --shadow: -12px 0 40px rgba(31, 42, 68, 0.10);
  --float: 0 10px 30px rgba(31, 42, 68, 0.16);
  --serif: Georgia, "Noto Serif SC", "Source Han Serif SC", "Source Han Serif CN", "Songti SC", STSong, SimSun, serif;
  --sans: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace;
  font-family: var(--sans);
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: #1b2030; --bg-soft: #252b3d; --surface: #161a27;
    --ink: #eef2fa; --ink-2: #b9c2d6; --ink-3: #8c95ab;
    --line: #2e3549; --line-strong: #3c445a;
    --accent: #9ab8ea; --accent-hover: #b3caf0; --accent-soft: #263453; --on-accent: #10192e;
    --brand: #7fa2da; --brand-soft: #3a4d78; --cream: #fdf9ee;
    --kraft: #d9b46e; --warn: #e8c891; --warn-soft: #2f2b25; --warn-line: #4a4234;
    --err: #f0968c; --err-soft: #3a2427; --olive: #8cc5ad;
    --solid: #eef2fa; --on-solid: #1b2030;
    --shadow: -12px 0 40px rgba(0, 0, 0, 0.45);
    --float: 0 10px 30px rgba(0, 0, 0, 0.5);
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; cursor: pointer; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* ---------- 暂停时浮在视频上的按钮（视频总是深色，所以这里固定用深墨色） */
.askwrap {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: center; gap: 10px;
  animation: pop .2s ease-out;
}
.ask {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 14px 10px 14px; border-radius: 999px;
  border: 1px solid rgba(253, 249, 238, 0.18); background: rgba(27, 37, 64, 0.84); color: #fdf9ee;
  font: 500 17px/1.2 var(--serif); letter-spacing: 0.04em; white-space: nowrap;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.32); backdrop-filter: blur(10px);
  transition: background .18s, border-color .18s;
}
.ask:hover { background: #4a6fb8; border-color: transparent; }
.ask .logo { flex: none; width: 28px; height: 28px; margin: -2px -2px -2px 0; }
.ask kbd {
  font: 500 12px/1 var(--mono); padding: 5px 8px; border-radius: 999px;
  background: rgba(253, 249, 238, 0.12); border: 1px solid rgba(253, 249, 238, 0.24);
}
.askhint { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; max-width: 420px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 5px 12px; border-radius: 999px; border: 1px solid rgba(253, 249, 238, 0.16);
  background: rgba(27, 37, 64, 0.80); color: #fdf9ee; font-size: 12px; line-height: 1.4;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.28); backdrop-filter: blur(8px);
}
button.chip:hover { background: #4a6fb8; border-color: transparent; }
.chip.nosub { background: #fdf9ee; color: #6b4a1c; border-color: #f0e1bd; }
.chip b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dia { flex: none; display: inline-block; width: 7px; height: 7px; border-radius: 1px; background: #7fa2da; transform: rotate(45deg); }
button.chip:hover .dia { background: #fdf9ee; }
@keyframes pop { from { opacity: 0; transform: translate(-50%, -46%) scale(.97); } }

/* ---------- 抽屉 */
.drawer {
  position: fixed; top: 0; right: 0; height: 100vh; width: min(400px, 100vw);
  display: flex; flex-direction: column;
  background: var(--bg); color: var(--ink); border-left: 1px solid var(--line); box-shadow: var(--shadow);
  font-size: 14px; line-height: 1.6;
  transform: translateX(104%); transition: transform .26s cubic-bezier(.2, .8, .2, 1);
}
.drawer.open { transform: none; }

.head { display: flex; align-items: center; gap: 6px; padding: 16px 12px 14px 20px; border-bottom: 1px solid var(--line); }
.head-main { flex: 1; min-width: 0; }
.brand { display: flex; align-items: center; gap: 8px; font: 600 17px/1.3 var(--serif); letter-spacing: 0.02em; }
.brand .logo { flex: none; width: 26px; height: 26px; margin: -3px 2px -3px 0; }
.brand .en { font: 500 11px/1 var(--sans); letter-spacing: 0.08em; color: var(--ink-3); }
.brand .name { padding: 0 2px; background: linear-gradient(transparent 64%, var(--brand-soft) 64%, var(--brand-soft) 90%, transparent 90%); }
.where { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 12px; color: var(--ink-3); min-width: 0; }
.where .ts { flex: none; font: 500 12px/1.5 var(--mono); color: var(--accent); }
.where .ts:empty { display: none; }
.where .subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 999px; background: transparent; color: var(--ink-3); }
.icon:hover { background: var(--bg-soft); color: var(--ink); }
.hbtn {
  flex: none; display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px;
  border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--ink-2); font-size: 12.5px;
  transition: background .15s, color .15s, border-color .15s;
}
.hbtn:hover { background: var(--bg-soft); color: var(--ink); }
.hbtn[aria-pressed="true"] { background: var(--solid); border-color: var(--solid); color: var(--on-solid); }
.badge { min-width: 16px; padding: 0 5px; border-radius: 999px; background: var(--bg-soft); color: var(--ink-2); font-size: 11px; font-weight: 600; line-height: 16px; text-align: center; font-variant-numeric: tabular-nums; }
.kpbtn .badge { background: var(--accent-soft); color: var(--accent); }
.hbtn[aria-pressed="true"] .badge { background: rgba(127, 127, 127, 0.28); color: inherit; }

.scroll { flex: 1; overflow-y: auto; padding: 20px 20px 28px; overscroll-behavior: contain; }
.restored { margin-bottom: 18px; padding: 8px 12px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); font-size: 12px; line-height: 1.6; }

/* ---------- 抓不到字幕时的指引卡片 */
.guide { margin-bottom: 22px; padding: 14px 16px 12px; border: 1px solid var(--warn-line); border-radius: 14px; background: var(--warn-soft); }
.guide h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 4px; font: 600 15px/1.5 var(--serif); color: var(--ink); }
.guide h3::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--kraft); }
.guide .why { font-size: 13px; color: var(--ink-2); }
.guide ol { margin: 10px 0 0; padding-left: 20px; font-size: 13px; line-height: 1.75; color: var(--ink-2); }
.acts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }
.acts button { padding: 6px 14px; border-radius: 999px; border: 1px solid var(--line-strong); background: transparent; color: var(--ink); font-size: 12.5px; }
.acts button:hover:not(:disabled) { background: var(--bg-soft); }
.acts button.primary { background: var(--solid); border-color: var(--solid); color: var(--on-solid); }
.acts button.primary:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.acts button.quiet { border-color: transparent; color: var(--ink-3); }
.acts button:disabled { opacity: .55; cursor: default; }
.ok { color: var(--olive); font-size: 13px; font-weight: 600; }
.guide .basis { margin-top: 10px; font-size: 11px; color: var(--ink-3); }

/* ---------- 三段解释 */
.seg + .seg { margin-top: 18px; }
.tag { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; font-size: 11.5px; font-weight: 500; letter-spacing: 0.08em; color: var(--ink-3); }
.tag::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--brand); }
.seg p { margin: 0; font: 400 16px/1.8 var(--serif); color: var(--ink); white-space: pre-wrap; word-break: break-word; }
.seg.hook { padding: 14px 16px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); box-shadow: inset 3px 0 0 var(--brand); }
.quick { display: flex; gap: 8px; margin-top: 12px; }
.quick button { flex: 1; padding: 6px 0; border-radius: 999px; border: 1px solid var(--line-strong); background: transparent; color: var(--ink); font-size: 13px; transition: background .15s, color .15s; }
.quick button:hover:not(:disabled) { background: var(--solid); border-color: var(--solid); color: var(--on-solid); }
.quick button:disabled { opacity: .45; cursor: default; }
.meta { margin-top: 16px; font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.meta.warn { color: var(--warn); }

.loading-text { margin-bottom: 14px; font: 15px/1.7 var(--serif); color: var(--ink-2); }
.sk { height: 13px; margin: 12px 0; border-radius: 999px; background: linear-gradient(90deg, var(--bg-soft) 25%, var(--line) 50%, var(--bg-soft) 75%); background-size: 200% 100%; animation: shimmer 1.3s infinite linear; }
.sk.short { width: 62%; }
@keyframes shimmer { to { background-position: -200% 0; } }

.error { padding: 10px 12px; border-radius: 10px; background: var(--err-soft); color: var(--err); font-size: 13px; line-height: 1.6; word-break: break-word; }
.retry { margin-top: 12px; padding: 6px 16px; border-radius: 999px; border: 1px solid var(--line-strong); background: transparent; color: var(--ink); font-size: 13px; }
.retry:hover { background: var(--bg-soft); }

/* ---------- 追问：用户浅色气泡，回答不加气泡、直接衬线排版 */
.thread { display: flex; flex-direction: column; gap: 14px; margin-top: 26px; }
.thread:empty { display: none; }
.thread::before { content: "追问"; padding-top: 18px; border-top: 1px solid var(--line); font-size: 11.5px; font-weight: 500; letter-spacing: 0.08em; color: var(--ink-3); }
.turn { display: flex; flex-direction: column; gap: 8px; }
.bubble { font-size: 14px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
.bubble.user { align-self: flex-end; max-width: 86%; padding: 8px 14px; border-radius: 16px; background: var(--bg-soft); color: var(--ink); }
.bubble.bot { align-self: stretch; padding: 0 2px; font: 15.5px/1.8 var(--serif); color: var(--ink); }
.bubble.bot.redirect { padding: 8px 12px; border-radius: 12px; background: var(--warn-soft); color: var(--warn); font: 14px/1.7 var(--sans); }
.bubble .note { display: block; margin-bottom: 2px; font: 11px/1.5 var(--sans); color: var(--ink-3); }
.bubble.streaming .text::after { content: ""; display: inline-block; width: 8px; height: 8px; margin-left: 5px; border-radius: 50%; background: var(--brand); vertical-align: 0.05em; animation: breathe 1s ease-in-out infinite; }
.bubble.waiting .text::before { content: "…"; color: var(--ink-3); }
.turn .meta { margin-top: 0; padding-left: 2px; }
.turn .error { font-size: 12px; padding: 6px 10px; }
@keyframes breathe { 50% { opacity: .25; transform: scale(.8); } }

/* ---------- 底部：快捷回复 + 输入框 + 模式 */
.foot { padding: 12px 16px 14px; border-top: 1px solid var(--line); background: var(--bg); }
.tip { margin-bottom: 10px; padding: 7px 11px; border-radius: 10px; background: var(--warn-soft); color: var(--warn); font-size: 12px; line-height: 1.6; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.chips button { padding: 4px 11px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--ink-2); font-size: 12px; transition: background .15s, color .15s; }
.chips button:hover:not(:disabled) { background: var(--bg-soft); color: var(--ink); border-color: var(--line-strong); }
.chips button:disabled, .composer :disabled { opacity: .45; cursor: default; }
.composer {
  display: flex; align-items: center; gap: 6px; padding: 5px 5px 5px 6px;
  border: 1px solid var(--line-strong); border-radius: 16px; background: var(--surface);
  box-shadow: 0 1px 2px rgba(31, 42, 68, 0.05), 0 6px 16px rgba(31, 42, 68, 0.05);
  transition: border-color .15s;
}
.composer:focus-within { border-color: var(--ink-3); }
.input { flex: 1; min-width: 0; padding: 8px 6px; border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 14px; outline: none; }
.input::placeholder { color: var(--ink-3); }
.mic, .send { flex: none; display: grid; place-items: center; width: 34px; height: 34px; border: 0; border-radius: 10px; }
.mic { background: transparent; color: var(--ink-3); }
.mic:hover:not(:disabled) { background: var(--bg-soft); color: var(--ink); }
.mic.on { background: var(--err-soft); color: var(--err); box-shadow: 0 0 0 calc(2px + var(--lvl, 0) * 8px) var(--err-soft); transition: box-shadow .08s linear; }
.mic.busy { color: var(--accent); animation: fade 0.9s ease-in-out infinite; }
.send { background: var(--accent); color: var(--on-accent); transition: background .15s; }
.send:hover:not(:disabled) { background: var(--accent-hover); }
@keyframes fade { 50% { opacity: .35; } }
.foot-row { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
.mode { display: inline-flex; padding: 3px; border-radius: 999px; background: var(--bg-soft); }
.mode button { padding: 3px 13px; border: 0; border-radius: 999px; background: transparent; color: var(--ink-2); font-size: 12px; }
.mode button[aria-checked="true"] { background: var(--surface); color: var(--ink); font-weight: 600; box-shadow: 0 1px 2px rgba(31, 42, 68, 0.14); }
.resume { padding: 4px 6px; border: 0; background: transparent; color: var(--ink-2); font-size: 13px; }
.resume:hover { color: var(--accent); }

/* ---------- 历史 / 重点面板（共用） */
.panel { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.pv-head { display: flex; align-items: center; gap: 8px; padding: 10px 16px 10px 10px; border-bottom: 1px solid var(--line); }
.pv-back { padding: 4px 10px; border: 0; border-radius: 999px; background: transparent; color: var(--ink-2); font-size: 13px; }
.pv-back:hover { background: var(--bg-soft); color: var(--ink); }
.pv-title { font: 600 14.5px/1.5 var(--serif); color: var(--ink); }
.pv-list { flex: 1; overflow-y: auto; padding: 10px 12px 18px; overscroll-behavior: contain; }
.pv-empty { padding: 28px 10px; color: var(--ink-3); font: 14px/1.8 var(--serif); }
.pv-foot { display: flex; align-items: center; gap: 10px; padding: 10px 16px 14px; border-top: 1px solid var(--line); font-size: 12px; line-height: 1.6; color: var(--ink-3); }
.pv-foot .kv-status { flex: 1; min-width: 0; }
.pv-foot .kv-status.warn { color: var(--warn); }
.pv-foot button { flex: none; padding: 5px 12px; border-radius: 999px; border: 1px solid var(--solid); background: var(--solid); color: var(--on-solid); font-size: 12px; }
.pv-foot button:hover { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.n-ts { position: relative; z-index: 1; flex: none; align-self: flex-start; padding: 0 8px; border-radius: 999px; background: var(--bg); border: 1px solid var(--line); font: 500 12px/1.7 var(--mono); color: var(--accent); }
.n-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }

.node { position: relative; display: flex; gap: 12px; width: 100%; padding: 11px 10px 11px 8px; border: 0; border-radius: 12px; background: transparent; color: var(--ink); text-align: left; }
.node::before { content: ""; position: absolute; left: 34px; top: 0; bottom: 0; width: 1px; background: var(--line); }
.node:first-child::before { top: 22px; }
.node:last-child::before { bottom: calc(100% - 22px); }
.node:only-child::before { display: none; }
.node:hover { background: var(--bg-soft); }
.node.current { background: var(--accent-soft); }
.node.current .n-ts { border-color: var(--accent); }
.n-sum { font: 14.5px/1.6 var(--serif); word-break: break-word; }
.n-meta { font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.n-cur { flex: none; align-self: flex-start; padding: 0 8px; border-radius: 999px; background: var(--accent); color: var(--on-accent); font-size: 11px; line-height: 20px; }

.kp { display: flex; gap: 12px; width: 100%; padding: 12px 10px; border: 0; border-radius: 12px; background: transparent; color: var(--ink); text-align: left; }
.kp + .kp { margin-top: 2px; }
.kp:hover { background: var(--bg-soft); }
.kp.now { background: var(--accent-soft); }
.kp.now .n-ts { border-color: var(--accent); }
.kp-title { display: flex; align-items: center; gap: 8px; font: 600 15px/1.5 var(--serif); word-break: break-word; }
.kp.core .kp-title::before { content: ""; flex: none; width: 7px; height: 7px; border-radius: 1px; background: var(--brand); transform: rotate(45deg); }
.kp-note { font: 13.5px/1.7 var(--serif); color: var(--ink-2); word-break: break-word; }
.kp-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
.kp-tags span { padding: 0 8px; border: 1px solid var(--line); border-radius: 999px; font-size: 11px; line-height: 18px; color: var(--ink-3); }
.kp-tags .core { border-color: var(--accent); color: var(--accent); }
.kp-tags .asked { border-color: var(--olive); color: var(--olive); }

/* ---------- 播放中的提示：字幕提醒条 / 字幕按钮圈 / 经过重点 / 进度条上的重点卡片 */
.subtoast {
  position: fixed; left: 50%; top: 12px; transform: translateX(-50%); width: min(460px, calc(100vw - 32px));
  padding: 12px 16px 12px 18px; border-radius: 14px; border: 1px solid var(--warn-line); border-left: 4px solid var(--kraft);
  background: var(--bg); color: var(--ink-2); font-size: 13px; line-height: 1.65; box-shadow: var(--float); animation: drop .22s ease-out;
}
.subtoast b { display: block; margin-bottom: 2px; font: 600 15px/1.5 var(--serif); color: var(--ink); }
.subtoast .acts { justify-content: flex-end; margin-top: 10px; }
@keyframes drop { from { opacity: 0; transform: translate(-50%, -8px); } }
.subring { position: fixed; border: 2px solid #7fa2da; border-radius: 10px; pointer-events: none; animation: ring 1.1s ease-in-out infinite; }
.subring span { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); padding: 4px 11px; border-radius: 999px; background: #4a6fb8; color: #fff; font-size: 12px; font-weight: 600; white-space: nowrap; }
@keyframes ring { 0%, 100% { box-shadow: 0 0 0 0 rgba(127, 162, 218, .6); } 50% { box-shadow: 0 0 0 10px rgba(127, 162, 218, 0); } }

.kpcue {
  position: fixed; display: flex; align-items: center; gap: 10px; max-width: min(380px, calc(100vw - 32px));
  padding: 9px 16px 9px 13px; border-radius: 12px; border: 1px solid rgba(253, 249, 238, 0.14);
  background: rgba(27, 37, 64, 0.86); color: #fdf9ee; text-align: left;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.3); backdrop-filter: blur(10px); animation: slidein .26s ease-out;
}
.kpcue:hover { background: rgba(27, 37, 64, 0.95); border-color: rgba(127, 162, 218, 0.8); }
.kpcue .lbl { flex: none; font-size: 11px; letter-spacing: 0.08em; color: #b8cff1; }
.kpcue .ttl { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 14px/1.4 var(--serif); }
@keyframes slidein { from { opacity: 0; transform: translateX(-8px); } }
.kptip {
  position: fixed; transform: translate(-50%, -100%); width: max-content; max-width: 260px;
  padding: 9px 13px 10px; border-radius: 12px; border: 1px solid var(--line);
  background: var(--bg); color: var(--ink); box-shadow: var(--float); pointer-events: none;
}
.kptip .k { display: flex; align-items: center; gap: 6px; font-size: 11px; letter-spacing: 0.06em; color: var(--accent); }
.kptip .t { margin-top: 2px; font: 600 14px/1.45 var(--serif); }
.kptip .n { margin-top: 2px; font: 12.5px/1.6 var(--serif); color: var(--ink-2); }
`;

  const MIC_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  const SEND_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  // 品牌 logo：扩展包里的 icons/logo-mark.png（manifest 里登记为 web_accessible_resources，B 站页面才能加载）
  const LOGO_URL = (() => { try { return chrome.runtime.getURL('icons/logo-mark.png'); } catch (_) { return ''; } })();
  const LOGO_IMG = LOGO_URL ? `<img class="logo" src="${LOGO_URL}" alt="" draggable="false">` : '';
  const CLOSE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  const HTML = `
<div class="askwrap" hidden>
  <button class="ask" type="button" aria-label="我这里不懂（快捷键 1）">${LOGO_IMG}<span>我这里不懂</span><kbd>1</kbd></button>
  <div class="askhint" hidden>
    <span class="chip nosub" hidden>这段没抓到字幕，解释可能不准</span>
    <button class="chip kpchip" type="button" hidden title="打开本视频的课程重点"><i class="dia"></i><span>附近重点</span><b></b></button>
    <button class="chip histchip" type="button" hidden title="看本视频的历史节点">历史 <b>0</b></button>
  </div>
</div>
<div class="subtoast" hidden role="status"></div>
<div class="subring" hidden><span>点这里打开字幕</span></div>
<button class="kpcue" type="button" hidden title="打开本视频的课程重点"><i class="dia"></i><span class="lbl">重点</span><span class="ttl"></span></button>
<div class="kptip" hidden></div>
<aside class="drawer" hidden role="dialog" aria-label="哄着学 Coaxly">
  <header class="head">
    <div class="head-main">
      <div class="brand" title="哄着学 Coaxly：别人卷你，我哄你。">${LOGO_IMG}<span class="name">哄着学</span><span class="en">Coaxly</span></div>
      <div class="where"><span class="ts"></span><span class="subject"></span></div>
    </div>
    <button class="hbtn kpbtn" type="button" title="课程重点：根据字幕判定的重点位置，点一条跳过去" aria-label="课程重点" aria-pressed="false">重点<span class="badge" hidden>0</span></button>
    <button class="hbtn hist" type="button" title="历史节点：每次求助都会记一个节点，点开可以跳回去" aria-label="历史节点" aria-pressed="false">历史<span class="badge" hidden>0</span></button>
    <button class="icon close" type="button" title="关闭（Esc）" aria-label="关闭">${CLOSE_SVG}</button>
  </header>
  <section class="panel histview" hidden aria-label="历史节点">
    <div class="pv-head"><button class="pv-back" type="button">‹ 返回</button><span class="pv-title"></span></div>
    <div class="pv-list"></div>
  </section>
  <section class="panel kpview" hidden aria-label="课程重点">
    <div class="pv-head"><button class="pv-back" type="button">‹ 返回</button><span class="pv-title"></span></div>
    <div class="pv-list"></div>
    <div class="pv-foot"><span class="kv-status"></span><button class="kv-run" type="button" hidden>分析已播放部分</button></div>
  </section>
  <div class="scroll">
    <div class="restored" hidden></div>
    <div class="guide" hidden role="status"></div>
    <section class="card" aria-live="polite"></section>
    <div class="thread"></div>
  </div>
  <footer class="foot">
    <div class="tip" hidden></div>
    <div class="chips">
      <button type="button" data-say="还是不懂">还是不懂</button>
      <button type="button" data-say="展开讲讲">展开讲讲</button>
      <button type="button" data-say="用你自己的知识解释一下，不用管视频">不管视频，直接讲</button>
      <button type="button" data-say="懂了">懂了</button>
    </div>
    <div class="composer">
      <button class="mic" type="button" title="语音追问" aria-label="语音追问">${MIC_SVG}</button>
      <input class="input" type="text" placeholder="追问：哪里还卡着？" enterkeyhint="send" autocomplete="off">
      <button class="send" type="button" title="发送" aria-label="发送">${SEND_SVG}</button>
    </div>
    <div class="foot-row">
      <div class="mode" role="radiogroup" aria-label="追问模式">
        <button type="button" role="radio" data-mode="direct" title="直接给短答案">直说</button>
        <button type="button" role="radio" data-mode="socratic" title="不直接给答案，一次问你一个小问题">带我想</button>
      </div>
      <button class="resume" type="button">继续播放 ›</button>
    </div>
  </footer>
</aside>`;

  const ui = (() => {
    const host = document.createElement('div');
    host.id = 'coaxly-root';
    host.style.cssText = 'all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>${HTML}`;
    const $ = (sel) => root.querySelector(sel);
    const askWrap = $('.askwrap');
    const askBtn = $('.ask');
    const askHint = $('.askhint');
    const askNoSub = $('.nosub');
    const histChip = $('.histchip');
    const subToast = $('.subtoast');
    const subRing = $('.subring');
    const drawer = $('.drawer');
    const card = $('.card');
    const thread = $('.thread');
    const scroller = $('.scroll');
    const restored = $('.restored');
    const guide = $('.guide');
    const histBtn = $('.hist');
    const histBadge = $('.hist .badge');
    const histView = $('.histview');
    const hvTitle = $('.histview .pv-title');
    const hvList = $('.histview .pv-list');
    const kpChip = $('.kpchip');
    const kpBtn = $('.kpbtn');
    const kpBadge = $('.kpbtn .badge');
    const kpView = $('.kpview');
    const kvTitle = $('.kpview .pv-title');
    const kvList = $('.kpview .pv-list');
    const kvStatus = $('.kv-status');
    const kvRun = $('.kv-run');
    const kpCue = $('.kpcue');
    const kpTip = $('.kptip');
    let cueVideo = null;
    let cueTimer = 0;
    const foot = $('.foot');
    const tip = $('.tip');
    const input = $('.input');
    const mic = $('.mic');
    const sendBtn = $('.send');
    let askVideo = null;
    let closeTimer = 0;
    let toastVideo = null;
    let toastTimer = 0;
    let ringTarget = null;
    let ringTimer = 0;
    let micState = false;

    // 抽屉里的点击/按键不要漏给 B 站播放器（否则会触发暂停/全屏/弹幕等快捷键）
    for (const ev of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'keypress', 'contextmenu', 'touchstart', 'touchend']) {
      host.addEventListener(ev, (e) => e.stopPropagation());
    }

    function mount() {
      const fs = document.fullscreenElement;
      const target = fs && fs.tagName !== 'VIDEO' ? fs : (document.body || document.documentElement);
      if (host.parentNode !== target) target.appendChild(host);
    }

    const visibleRect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 120 && r.height > 80 && r.bottom > 0 && r.top < window.innerHeight ? r : null;
    };

    function placeAsk() {
      if (askWrap.hidden || !askVideo) return;
      const r = visibleRect(askVideo);
      askWrap.style.visibility = r ? '' : 'hidden';
      if (!r) return;
      askWrap.style.left = `${r.left + r.width / 2}px`;
      askWrap.style.top = `${r.top + r.height / 2}px`;
    }

    function placeToast() {
      if (subToast.hidden) return;
      const r = visibleRect(toastVideo);
      subToast.style.left = r ? `${r.left + r.width / 2}px` : '50%';
      subToast.style.top = r ? `${Math.max(8, r.top + 12)}px` : '12px';
    }

    function placeRing() {
      if (subRing.hidden) return;
      const label = subRing.querySelector('span');
      let r = ringTarget && ringTarget.isConnected ? ringTarget.getBoundingClientRect() : null;
      if (!r || r.width < 4 || r.height < 4) {
        // 控制条收起来了：在播放器上模拟一次鼠标移动让它出来；还是看不见就圈住播放器右下角
        const vr = visibleRect(state.video);
        if (!vr) { subRing.hidden = true; return; }
        try {
          (state.playerRoot || state.video).dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: vr.left + vr.width / 2, clientY: vr.top + vr.height / 2 }));
        } catch (_) {}
        r = ringTarget && ringTarget.isConnected ? ringTarget.getBoundingClientRect() : null;
        if (!r || r.width < 4 || r.height < 4) {
          r = { left: vr.right - 220, top: vr.bottom - 46, width: 210, height: 40 };
          label.textContent = '播放器右下角的「字幕」按钮';
        } else label.textContent = '点这里打开字幕';
      } else label.textContent = '点这里打开字幕';
      subRing.style.left = `${r.left - 5}px`;
      subRing.style.top = `${r.top - 5}px`;
      subRing.style.width = `${r.width + 10}px`;
      subRing.style.height = `${r.height + 10}px`;
    }

    function scrollToEnd() { scroller.scrollTop = scroller.scrollHeight; }

    function setComposerEnabled(on) {
      for (const b of root.querySelectorAll('.chips button')) b.disabled = !on;
      input.disabled = !on;
      sendBtn.disabled = !on;
      mic.disabled = !on;
    }

    function submitInput() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      sendFollowup(text, 'text');
    }

    const defaultPlaceholder = () => (voice.supported() && state.settings.voice !== false ? '追问：说或打字，哪里还卡着？' : '追问：打字或点上面的快捷回复');

    askBtn.addEventListener('click', () => startExplain('button'));
    histChip.addEventListener('click', () => openHistory('ask'));
    histBtn.addEventListener('click', () => (histView.hidden ? openHistory('drawer') : backFromHistory()));
    $('.histview .pv-back').addEventListener('click', () => backFromHistory());
    kpChip.addEventListener('click', () => openKeypoints('ask'));
    kpBtn.addEventListener('click', () => (kpView.hidden ? openKeypoints('drawer') : backFromHistory()));
    $('.kpview .pv-back').addEventListener('click', () => backFromHistory());
    kvRun.addEventListener('click', () => kpAnalyzeNow());
    kpCue.addEventListener('click', () => {
      logEvent({ type: 'client_event', event: 'kp_cue', action: 'click', video_id: state.kp.videoId });
      hideKpCue();
      openKeypoints('cue');
    });
    $('.close').addEventListener('click', () => closeDrawer('close_button'));
    $('.resume').addEventListener('click', () => { const v = state.video; if (v) v.play().catch(() => {}); });
    sendBtn.addEventListener('click', submitInput);
    mic.addEventListener('click', () => voice.toggle());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submitInput(); }
    });
    for (const b of root.querySelectorAll('.chips button')) b.addEventListener('click', () => sendFollowup(b.dataset.say, 'chip'));
    for (const b of root.querySelectorAll('.mode button')) b.addEventListener('click', () => setMode(b.dataset.mode));
    subToast.addEventListener('mouseenter', () => clearTimeout(toastTimer));
    subToast.addEventListener('mouseleave', () => { clearTimeout(toastTimer); toastTimer = setTimeout(() => hideToast('timeout'), 5000); });
    kpCue.addEventListener('mouseenter', () => clearTimeout(cueTimer));
    kpCue.addEventListener('mouseleave', () => { clearTimeout(cueTimer); cueTimer = setTimeout(hideKpCue, 2500); });
    const placeAll = () => { placeAsk(); placeToast(); placeRing(); placeCue(); };
    window.addEventListener('resize', placeAll);
    window.addEventListener('scroll', placeAll, { passive: true });
    document.addEventListener('fullscreenchange', () => { mount(); hideKpTip(); setTimeout(placeAll, 120); });
    setInterval(() => { if (!askWrap.hidden || !subToast.hidden || !subRing.hidden || !kpCue.hidden) placeAll(); }, 400);

    // ---------------- 课程重点：播放经过时的提示卡片、进度条上的说明卡片（v1.3）
    function placeCue() {
      if (kpCue.hidden) return;
      const r = visibleRect(cueVideo);
      if (!r) { kpCue.style.visibility = 'hidden'; return; }
      kpCue.style.visibility = '';
      kpCue.style.left = `${r.left + 14}px`;
      kpCue.style.top = `${Math.max(8, r.top + 14)}px`;
    }
    function hideKpCue() { clearTimeout(cueTimer); kpCue.hidden = true; cueVideo = null; }
    function showKpCue(v, p) {
      mount();
      cueVideo = v;
      kpCue.querySelector('.lbl').textContent = p.level === 2 ? '核心重点' : '重点';
      kpCue.querySelector('.ttl').textContent = p.title;
      kpCue.title = (kpNoteOf(p) ? kpNoteOf(p) + '\n' : '') + '点开看本视频的全部重点';
      kpCue.hidden = false;
      placeCue();
      clearTimeout(cueTimer);
      cueTimer = setTimeout(hideKpCue, 5000);
    }
    function hideKpTip() { kpTip.hidden = true; }
    // x：标记在屏幕上的横坐标；bar：进度条矩形。B 站自己的预览小窗（缩略图 + 时间）显示时，放在它上面，不挡住它
    function showKpTip(p, x, bar) {
      mount();
      kpTip.textContent = '';
      kpTip.append(h('div', { class: 'k' }, h('i', { class: 'dia' }), `${p.level === 2 ? '核心重点' : '重点'} · ${p.timestamp} · ${p.kind}`), h('div', { class: 't' }, p.title));
      if (kpNoteOf(p)) kpTip.append(h('div', { class: 'n' }, kpNoteOf(p)));
      kpTip.hidden = false;
      let top = bar.top;
      const pop = (state.playerRoot || document).querySelector('.bpx-player-progress-popup');
      if (pop) {
        const pr = pop.getBoundingClientRect();
        let shown = pr.width > 0 && pr.height > 0 && pr.bottom <= bar.top + 4;
        try { const cs = getComputedStyle(pop); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) shown = false; } catch (_) {}
        if (shown) top = Math.min(top, pr.top);
      }
      const w = kpTip.offsetWidth || 220;
      const left = Math.max(8 + w / 2, Math.min(window.innerWidth - 8 - w / 2, x));
      kpTip.style.left = `${left}px`;
      kpTip.style.top = `${Math.max(kpTip.offsetHeight + 8, top - 10)}px`;
    }

    function segmentView(s) {
      const d = s.call2;
      const segs = (d.segments && d.segments.length ? d.segments : String(d.text || '').split(/\n\s*\n/)).filter(Boolean);
      const out = [];
      if (segs.length === 3) {
        const labels = ['说人话', '打个比方', '问你一句'];
        segs.forEach((t, i) => {
          const seg = h('div', { class: 'seg' + (i === 2 ? ' hook' : '') }, h('span', { class: 'tag' }, labels[i]), h('p', null, t));
          if (i === 2) {
            seg.append(h('div', { class: 'quick' },
              ['是', '不是', '不确定'].map((a) => h('button', { type: 'button', onclick: () => sendFollowup(a, 'hook') }, a))));
          }
          out.push(seg);
        });
      } else {
        for (const t of segs) out.push(h('div', { class: 'seg' }, h('p', null, t)));
      }
      const metaBits = [`${d.chars} 字`, `${d.seg_count} 段`];
      if (d.length_violation) metaBits.push('超出 120 字');
      if (d.retried) metaBits.push('已重试');
      metaBits.push(d.vision_used ? '看了画面' : d.ocr_used ? '读了画面文字' : '未用画面');
      if (s.subsFromScreen) metaBits.push('字幕取自画面');
      const m = d.memory; // v1.4 整片记忆
      if (m && m.used) {
        metaBits.push(m.status === 'ready' || m.status === 'partial'
          ? `整片记忆${m.chapters ? ` · ${m.chapters} 章` : ''}${m.chapter ? `「${m.chapter}」` : ''}`
          : m.status === 'building' ? '整片记忆生成中' : '整片字幕');
      } else if (s.subsFromTrack) metaBits.push('字幕取自完整字幕');
      if (d.total_ms) metaBits.push(`${(d.total_ms / 1000).toFixed(1)}s`);
      out.push(h('div', { class: 'meta' + (d.length_violation ? ' warn' : '') }, metaBits.join(' · ')));
      return out;
    }

    // ---------------- 抓不到字幕时的指引卡片（v1.2，替换 v1.1 的一行小黄字）
    const GUIDE_STEPS = {
      off: ['点下面的【一键打开字幕】（或播放器右下角「字幕」按钮，选中文）', '点【倒回 30 秒重看】，播到这里再暂停求助，就有前后文了'],
      need_login: ['先登录 B 站（页面右上角头像）', '在播放器右下角「字幕」里选中文（AI 生成的也可以）', '倒回 30 秒重看，播到这里再暂停求助'],
      none: ['如果字幕是印在画面里的：保持「启动.bat」开着，先多播放十几秒再暂停，就能读到画面上的字', '也可以在下面的追问里直接说你卡在哪句话'],
      on: ['点【倒回 30 秒重看】，让这一段的字幕先播一遍', '播到这里再暂停求助'],
    };
    GUIDE_STEPS.no_button = GUIDE_STEPS.none;

    function renderGuide(s) {
      guide.textContent = '';
      if (!s.degraded) { guide.hidden = true; return; }
      const st = subtitleState();
      const d = s.call2;
      let basis;
      if (!s.frameCaptured) basis = '本次没截到画面，只能根据你的描述来解释。';
      else if (!d) basis = '正在看画面…';
      else if (d.vision_used) basis = '本次只能依据画面来解释。';
      else if (d.ocr_used) basis = '本次只能依据画面上读到的文字来解释。';
      else basis = '画面上也没读到字，只能根据你的描述来解释。';
      const why = h('div', { class: 'why' }, SUB_REASON[st] || '');
      const acts = h('div', { class: 'acts' });
      if (st === 'off') {
        const openBtn = h('button', { type: 'button', class: 'primary' }, '一键打开字幕');
        openBtn.addEventListener('click', async () => {
          openBtn.disabled = true;
          openBtn.textContent = '正在打开…';
          if (await guideOpenSubtitles('drawer')) {
            openBtn.replaceWith(h('span', { class: 'ok' }, '字幕已打开 ✓'));
            why.textContent = '字幕打开了。这一段之前没播过，点【倒回 30 秒重看】再求助就准了。';
          } else {
            openBtn.disabled = false;
            openBtn.textContent = '一键打开字幕';
            why.textContent = '没能自动打开。请点播放器上闪烁圈住的「字幕」按钮，选中文字幕。';
          }
        });
        acts.append(openBtn);
      }
      acts.append(h('button', { type: 'button', class: st === 'off' ? '' : 'primary', onclick: () => guideRewind('drawer', s.t) }, '倒回 30 秒重看'));
      guide.append(
        h('h3', null, '没抓到这段的字幕'),
        why,
        h('ol', null, (GUIDE_STEPS[st] || []).map((x) => h('li', null, x))),
        acts,
        h('div', { class: 'basis' }, basis),
      );
      guide.hidden = false;
      if (!s.guideLogged) { s.guideLogged = true; logGuide('drawer', 'shown'); }
    }

    // ---------------- 播放中的主动提醒
    function hideToast(action) {
      clearTimeout(toastTimer);
      if (subToast.hidden) return;
      subToast.hidden = true;
      if (action) logGuide('toast', action);
    }

    function showSubToast(v, st) {
      mount();
      toastVideo = v;
      subToast.textContent = '';
      const TEXT = {
        off: '这个视频有字幕，只是没打开。打开后哄着学才听得到老师在讲什么。',
        need_login: 'B 站的 AI 字幕要登录后才能看。登录后在播放器右下角「字幕」里选中文。',
        none: '这个视频暂时没有字幕。如果字幕是印在画面里的，保持「启动.bat」开着，就能读到画面上的字。',
      };
      TEXT.no_button = TEXT.none;
      const title = h('b', null, '没检测到字幕，哄着学的解释会不准');
      const body = h('div', null, TEXT[st] || TEXT.none);
      const acts = h('div', { class: 'acts' });
      if (st === 'off') {
        const openBtn = h('button', { type: 'button', class: 'primary' }, '一键打开字幕');
        openBtn.addEventListener('click', async () => {
          openBtn.disabled = true;
          clearTimeout(toastTimer);
          if (await guideOpenSubtitles('toast')) {
            title.textContent = '字幕已打开 ✓';
            body.textContent = '接下来播放的内容哄着学都能听到。';
            acts.remove();
            toastTimer = setTimeout(() => hideToast(), 3000);
          } else hideToast();
        });
        acts.append(openBtn);
      }
      acts.append(
        h('button', { type: 'button', onclick: () => hideToast('dismiss') }, '知道了'),
        h('button', {
          type: 'button',
          class: 'quiet',
          title: '以后所有视频都不再主动提醒（设置页可以改回来）',
          onclick: () => { try { chrome.storage.local.set({ subGuide: false }); } catch (_) {} state.settings.subGuide = false; hideToast('never'); },
        }, '不再提示'),
      );
      subToast.append(title, body, acts);
      subToast.hidden = false;
      placeToast();
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => hideToast('timeout'), SUB_TOAST_MS);
    }

    function pointAtSubtitle() {
      mount();
      ringTarget = subtitleCtrl();
      subRing.hidden = false;
      placeRing();
      clearTimeout(ringTimer);
      ringTimer = setTimeout(() => { subRing.hidden = true; }, 6000);
    }

    // ---------------- 历史节点时间线
    const nodeSummary = (n) => n.summary || n.ruleSummary || '';

    function renderHistory() {
      const nodes = [...state.hist.nodes].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      hvTitle.textContent = `本视频的学习历史（${nodes.length}）`;
      hvList.textContent = '';
      if (!nodes.length) {
        hvList.append(h('div', { class: 'pv-empty' }, '还没有记录。暂停后点「我这里不懂」或按 1，每次求助都会记成一个节点，之后可以从这里跳回去接着问。'));
        return;
      }
      const cur = state.session && !state.session.closed ? state.session.nodeId : null;
      for (const n of nodes) {
        const turns = (n.turns || []).length;
        const isCur = n.id === cur;
        hvList.append(h('button', {
          type: 'button',
          class: 'node' + (isCur ? ' current' : ''),
          title: `跳回 ${n.timestamp}，还原当时的解释和追问`,
          onclick: () => restoreNode(n, 'drawer'),
        },
        h('span', { class: 'n-ts' }, n.timestamp),
        h('span', { class: 'n-body' },
          h('span', { class: 'n-sum' }, nodeSummary(n)),
          h('span', { class: 'n-meta' }, `${fmtDate(n.createdAt)} · ${turns ? `追问 ${turns} 轮` : '没有追问'}`)),
        isCur ? h('span', { class: 'n-cur' }, '当前') : null));
      }
    }

    function openShell() {
      // 抽屉没开时只打开时间线（不开始新的求助）
      if (!drawer.hidden && drawer.classList.contains('open')) return;
      mount();
      clearTimeout(closeTimer);
      $('.ts').textContent = '';
      $('.subject').textContent = getSubject();
      $('.subject').title = $('.subject').textContent;
      drawer.hidden = false;
      void drawer.offsetWidth;
      drawer.classList.add('open');
    }

    // ---------------- 课程重点列表（v1.3）
    function kpCurrentId() {
      const v = state.video;
      if (!v) return null;
      const now = v.currentTime + 2;
      let id = null;
      for (const p of state.kp.points) if (p.t <= now) id = p.id;
      return id;
    }

    function renderKeypoints() {
      const k = state.kp;
      const pts = state.settings.keyPoints === false ? [] : k.points;
      kvTitle.textContent = `本视频的课程重点（${pts.length}）`;
      kvList.textContent = '';
      const st = kpStatus();
      kvStatus.textContent = st.text;
      kvStatus.classList.toggle('warn', !!st.warn);
      kvRun.hidden = !st.canRun;
      if (!pts.length) {
        kvList.append(h('div', { class: 'pv-empty' }, st.empty));
        return;
      }
      const cur = kpCurrentId();
      for (const p of pts) {
        const asked = state.hist.nodes.some((n) => n.t >= p.t - 15 && n.t <= p.t + 45);
        kvList.append(h('button', {
          type: 'button',
          class: 'kp' + (p.id === cur ? ' now' : '') + (p.level === 2 ? ' core' : ''),
          'data-id': p.id,
          title: `跳到 ${p.timestamp} 开始播放`,
          onclick: () => kpJump(p, 'panel'),
        },
        h('span', { class: 'n-ts' }, p.timestamp),
        h('span', { class: 'n-body' },
          h('span', { class: 'kp-title' }, p.title),
          kpNoteOf(p) ? h('span', { class: 'kp-note' }, kpNoteOf(p)) : null,
          h('span', { class: 'kp-tags' },
            h('span', null, p.kind || '强调'),
            p.level === 2 ? h('span', { class: 'core' }, '核心') : null,
            asked ? h('span', { class: 'asked', title: '你在这附近求助过' }, '求助过') : null,
            p.src === 'rule' ? h('span', { title: '模型没返回可用结果时，按「重点 / 注意 / 定义」等关键词粗略标注的' }, '关键词') : null))));
      }
    }

    // 只刷新「当前播放位置所在的那条」的高亮，不重建列表（避免鼠标悬停时闪）
    function tickKeypoints() {
      if (kpView.hidden) return;
      const cur = kpCurrentId();
      for (const b of kvList.querySelectorAll('.kp')) b.classList.toggle('now', b.dataset.id === cur);
      const st = kpStatus();
      if (kvStatus.textContent !== st.text) {
        kvStatus.textContent = st.text;
        kvStatus.classList.toggle('warn', !!st.warn);
      }
      kvRun.hidden = !st.canRun;
    }

    function showPanel(which) {
      openShell();
      histView.hidden = which !== 'hist';
      kpView.hidden = which !== 'kp';
      scroller.hidden = true;
      foot.hidden = true;
      histBtn.setAttribute('aria-pressed', String(which === 'hist'));
      kpBtn.setAttribute('aria-pressed', String(which === 'kp'));
      if (which === 'hist') renderHistory();
      else renderKeypoints();
    }

    function showChat() {
      histView.hidden = true;
      kpView.hidden = true;
      scroller.hidden = false;
      foot.hidden = false;
      histBtn.setAttribute('aria-pressed', 'false');
      kpBtn.setAttribute('aria-pressed', 'false');
    }

    function backFromHistory() {
      if (state.session && !state.session.closed) showChat();
      else closeDrawer('history_back');
    }

    function turnView(turn) {
      const text = h('span', { class: 'text' });
      const note = h('span', { class: 'note', hidden: true });
      const bot = h('div', { class: 'bubble bot waiting' }, note, text);
      const meta = h('div', { class: 'meta', hidden: true });
      const err = h('div', { class: 'error', hidden: true });
      const el = h('div', { class: 'turn' },
        h('div', { class: 'bubble user' }, turn.q), bot, err, meta);
      thread.append(el);
      scrollToEnd();
      const view = {
        setText(t) { bot.classList.remove('waiting'); bot.classList.add('streaming'); text.textContent = t.replace(/\*\*/g, ''); scrollToEnd(); },
        setNote(t) { note.textContent = t; note.hidden = false; },
        markRedirect() { bot.classList.add('redirect'); },
        setMeta(ev) {
          const bits = [];
          if (ev.off_topic) bits.push('离题，已拉回');
          if (ev.call3_chars != null) bits.push(`${ev.call3_chars} 字`);
          if (ev.first_token_ms != null) bits.push(`首字 ${ev.first_token_ms}ms`);
          if (bits.length) { meta.textContent = bits.join(' · '); meta.hidden = false; }
        },
        setError(m) { err.textContent = m; err.hidden = false; scrollToEnd(); },
        finish() {
          bot.classList.remove('streaming');
          if (bot.classList.contains('waiting')) { bot.classList.remove('waiting'); if (!text.textContent) bot.hidden = true; }
          scrollToEnd();
        },
        // 回溯：直接显示当时的回答
        restore(t) {
          if (t.route === 'off_topic') view.markRedirect();
          else if (t.route === 'related_general') view.setNote('和当前片段关系不大');
          view.setText(String(t.a || ''));
          view.finish();
        },
      };
      return view;
    }

    return {
      mount,
      setHidden(on) { host.style.visibility = on ? 'hidden' : ''; },
      showAsk(v, opts) {
        mount();
        askVideo = v;
        const o = opts || {};
        askNoSub.hidden = !o.noSubs;
        const n = o.histCount || 0;
        histChip.hidden = !n;
        histChip.querySelector('b').textContent = String(n);
        kpChip.hidden = !o.kpNear;
        if (o.kpNear) {
          kpChip.querySelector('b').textContent = clip(o.kpNear.title, 14);
          kpChip.title = `附近重点 ${o.kpNear.timestamp}：${o.kpNear.title}${kpNoteOf(o.kpNear) ? '\n' + kpNoteOf(o.kpNear) : ''}\n点开看本视频的全部重点`;
        }
        askHint.hidden = askNoSub.hidden && histChip.hidden && kpChip.hidden;
        askWrap.hidden = false;
        hideKpCue();
        placeAsk();
      },
      hideAsk() { askWrap.hidden = true; askVideo = null; },
      showSubToast,
      hideToast,
      pointAtSubtitle,
      openDrawer(s) {
        mount();
        clearTimeout(closeTimer);
        hideToast();
        hideKpCue();
        showChat();
        $('.ts').textContent = s.timestamp;
        $('.subject').textContent = s.subject;
        $('.subject').title = s.subject;
        thread.textContent = '';
        tip.hidden = true;
        restored.hidden = true;
        input.value = '';
        renderGuide(s);
        drawer.hidden = false;
        void drawer.offsetWidth; // 强制回流再加 class，滑入动画不依赖 rAF（后台标签页 rAF 可能不跑）
        drawer.classList.add('open');
      },
      isOpen() { return !drawer.hidden && drawer.classList.contains('open'); },
      owns(path) { return path.includes(host); },
      closeDrawer() {
        drawer.classList.remove('open');
        closeTimer = setTimeout(() => { drawer.hidden = true; showChat(); }, 240);
      },
      renderLoading(s) {
        card.textContent = '';
        card.append(
          h('div', { class: 'loading-text' }, `正在看 ${s.timestamp} 前后这一段…`),
          h('div', { class: 'sk' }), h('div', { class: 'sk short' }), h('div', { class: 'sk' }),
        );
        setComposerEnabled(false);
      },
      renderExplainError(s, msg, retry) {
        card.textContent = '';
        card.append(h('div', { class: 'error' }, msg), h('button', { class: 'retry', type: 'button', onclick: retry }, '重试'));
        setComposerEnabled(false);
      },
      renderExplain(s) {
        renderGuide(s);
        card.textContent = '';
        card.append(...segmentView(s));
        setComposerEnabled(true);
        ui.syncVoice();
      },
      showRestored(node) {
        restored.textContent = `回溯 · ${fmtDate(node.createdAt)} 的记录 · 视频已跳回 ${node.timestamp}，可以接着追问`;
        restored.hidden = false;
        scroller.scrollTop = 0;
      },
      showHistory() { showPanel('hist'); },
      showKeypoints() { hideKpCue(); showPanel('kp'); },
      showChat,
      showKpCue,
      hideKpCue,
      showKpTip,
      hideKpTip,
      tickKeypoints,
      syncKeypoints() {
        const on = state.settings.keyPoints !== false;
        const n = on ? state.kp.points.length : 0;
        kpBtn.hidden = !on;
        kpBadge.textContent = String(n);
        kpBadge.hidden = !n;
        if (!on) { hideKpCue(); hideKpTip(); if (!kpView.hidden && ui.isOpen()) backFromHistory(); }
        if (!kpView.hidden) renderKeypoints();
        kpRenderMarkers();
      },
      syncHistory() {
        const n = state.hist.nodes.length;
        histBadge.textContent = String(n);
        histBadge.hidden = !n;
        if (!askWrap.hidden) {
          histChip.hidden = !n;
          histChip.querySelector('b').textContent = String(n);
          askHint.hidden = askNoSub.hidden && histChip.hidden && kpChip.hidden;
        }
        if (!histView.hidden) renderHistory();
        if (!kpView.hidden) renderKeypoints(); // 「求助过」标记跟着历史节点变
      },
      appendTurn: turnView,
      showTip(m) { tip.textContent = m; tip.hidden = false; },
      hideTip() { tip.hidden = true; },
      getInput: () => input.value,
      setInput(t) { input.value = t; },
      focusInput() { try { input.focus(); } catch (_) {} },
      // 麦克风三种状态：false 空闲 / 'listening' 正在听（随音量跳动）/ 'busy' 正在识别
      setMic(st) {
        micState = st || false;
        mic.classList.toggle('on', micState === 'listening');
        mic.classList.toggle('busy', micState === 'busy');
        mic.title = micState === 'listening' ? '正在听…说完停一下自动发送（再点一下立即发送）' : micState === 'busy' ? '正在识别…' : '语音追问';
        input.placeholder = micState === 'listening' ? '正在听…说完停一下会自动发送' : micState === 'busy' ? '正在识别…' : defaultPlaceholder();
        if (!micState) mic.style.removeProperty('--lvl');
      },
      setMicLevel(x) { mic.style.setProperty('--lvl', (x || 0).toFixed(2)); },
      micBusy: () => micState === 'busy',
      syncMode() {
        const mode = state.settings.mode === 'socratic' ? 'socratic' : 'direct';
        for (const b of root.querySelectorAll('.mode button')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
      },
      syncVoice() {
        const on = voice.supported() && state.settings.voice !== false;
        mic.hidden = !on;
        if (!micState) input.placeholder = defaultPlaceholder();
      },
    };
  })();

  // ------------------------------------------------------------------ 快捷键 1（暂停 → 中央按钮 / 1 快捷键）
  window.addEventListener('keydown', (e) => {
    // Esc 关抽屉：焦点在哪都生效（按 1 呼出后焦点还在页面上）；但用户在 B 站自己的输入框里按 Esc 不抢
    if (e.key === 'Escape') {
      if (!ui.isOpen()) return;
      const path = e.composedPath ? e.composedPath() : [];
      if (!ui.owns(path) && isEditable(path[0] || e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      closeDrawer('escape');
      return;
    }
    if (e.key !== '1' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const target = (e.composedPath && e.composedPath()[0]) || e.target;
    if (isEditable(target) || isEditable(document.activeElement)) return;
    if (!findVideo()) return;
    e.preventDefault();
    e.stopPropagation();
    startExplain('hotkey');
  }, true);

  window.addEventListener('pagehide', () => finishSession('pagehide'));

  // ------------------------------------------------------------------ 启动
  ui.syncMode();
  ui.syncVoice();
  loadSettings();
  const tick = () => {
    const v = findVideo();
    if (v) { bindVideo(v); ui.mount(); }
    ensureSubsForVideo();
    if (state.hist.videoId !== state.subs.videoId) loadHistory(state.subs.videoId); // 换了视频 / 分P
    trackGuide();
    checkPendingRestore();
    kpTick();
  };
  tick();
  setInterval(tick, 1000);
})();
