/* 学习搭子 · 内容脚本（运行在 B 站页面里）
 *
 * 触发：视频暂停 → 画面中央出现「我这里不懂」按钮；或在任意时刻按 1。
 * 上下文：MutationObserver 监听播放器里 class 含 subtitle 的节点，按 video.currentTime 打点，
 *         取暂停时刻 ±30 秒窗口作为模型的「记忆边界」。
 *         没有播放器字幕时（字幕烧在画面里），播放中定期把画面底部送本地代理做文字识别，同样打点。
 * 画面：直接从 <video> 取帧（不含弹幕和控制条），取不到再整页截图。
 * 载体：页面内右侧抽屉（Shadow DOM，样式与 B 站互不影响；全屏时跟随进入全屏元素）。
 */
(() => {
  'use strict';
  if (window.__learnBuddyLoaded) return;
  window.__learnBuddyLoaded = true;

  // ------------------------------------------------------------------ 常量
  const DEFAULT_QUESTION = '这里没听懂，帮我讲讲刚才这一段';
  const WINDOW_SEC = 30;          // 规格 2.2：±30 秒字幕窗口
  const MIN_VOICE_CHARS = 4;      // 规格 6：首个 partial ≥4 字就可以发起
  const VAD_SILENCE_MS = 700;     // 规格 6：静音判定不要设长
  const MAX_ENTRIES = 6000;
  const HARDSUB_EVERY_MS = 1500;  // 播放时每隔多久读一次画面底部的硬字幕
  const HARDSUB_STRIP = 0.25;     // 读画面底部多高的一条（占画面高度）
  const DOM_SUB_FRESH_MS = 8000;  // 播放器自己的字幕最近 8 秒出现过，就不读画面
  const DEFAULT_SETTINGS = { proxyUrl: 'http://localhost:8787', sendImage: true, hardsub: true, voice: true, mode: 'direct' };
  const CONFUSED_RE = /还是不懂|没懂|不明白|听不懂|看不懂|不理解|晕/;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    video: null,
    playerRoot: null,
    session: null,
    explaining: false,
    subs: { videoId: null, entries: [], last: '' },
    lastDomSubAt: 0,
    frameTainted: false,
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
        for (const [k, v] of Object.entries(changes)) if (k in DEFAULT_SETTINGS) state.settings[k] = v.newValue;
        ui.syncMode();
        ui.syncVoice();
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

  // ------------------------------------------------------------------ 字幕采集器（规格 2.2）
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
    return state.subs.entries
      .filter((e) => e.t >= t - WINDOW_SEC && e.t <= t + WINDOW_SEC)
      .sort((a, b) => a.t - b.t)
      .filter((e) => {
        const prev = lastSeen.get(e.text);
        lastSeen.set(e.text, e.t);
        return prev === undefined || e.t - prev > 4; // 倒回去重看时同一句会被记两次
      });
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
  function similarSub(a, b) {
    if (!a || !b) return false;
    if (a === b || a.includes(b) || b.includes(a)) return true;
    const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
    const A = grams(a);
    const B = grams(b);
    let inter = 0;
    let total = 0;
    for (const [g, n] of A) { inter += Math.min(n, B.get(g) || 0); total += n; }
    for (const n of B.values()) total += n;
    return total > 0 && (2 * inter) / total >= 0.6; // 识别有错字时同一句前后两次读出来不完全一样
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
    seeked: () => { if (state.video && state.video.paused) onPaused(); },
    play: () => ui.hideAsk(),
    playing: () => ui.hideAsk(),
    ended: () => ui.hideAsk(),
    emptied: () => ui.hideAsk(),
    timeupdate: () => scheduleScan(),
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
    ui.showAsk(v);
  }

  // ------------------------------------------------------------------ 求助记录（规格 2.3 的 past3）
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

  // ------------------------------------------------------------------ 会话：Call 2
  function newSession(v, trigger) {
    ensureSubsForVideo();
    const t = v.currentTime;
    const entries = transcriptWindow(t);
    const transcript = entries.map((e) => `[${fmt(e.t)}] ${e.text}`).join('\n');
    const before = entries.filter((e) => e.t <= t + 0.5);
    return {
      id: uid(),
      videoId: getVideoId(),
      t,
      timestamp: fmt(t),
      subject: getSubject(),
      transcript,
      degraded: bodyLength(transcript) < 10,
      subsFromScreen: entries.some((e) => e.src === 'ocr'),
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
    const res = await callProxy('/explain', {
      session_id: s.id,
      video_id: s.videoId,
      subject: s.subject,
      timestamp: s.timestamp,
      transcript: s.transcript,
      question: s.question,
      past,
      route: 'in_video', // 规格 3.1：按钮路径跳过 Call 1，路由恒定 in_video
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
    if (!s.originalConcept && s.transcript) {
      const lines = s.transcript.trim().split('\n');
      s.originalConcept = clip(lines[lines.length - 1].replace(/^\[\d{1,3}:\d{2}\]\s*/, ''), 40);
    }
    const first = (d.segments && d.segments[0]) || d.text || '';
    if (!s.originalConcept) s.originalConcept = clip(first, 40);
    ui.renderExplain(s);
    savePast(s.videoId, { question: `[${s.timestamp}] ${s.question}`, core: clip(first, 50), at: Date.now() });
  }

  // ------------------------------------------------------------------ 会话：Call 3 追问
  function sendFollowup(raw, via) {
    const s = state.session;
    const text = String(raw || '').trim();
    if (!s || s.closed || !text) return;
    if (!s.call2) { ui.showTip('等第一段解释出来再追问～'); return; }
    if (s.streaming) s.streaming.cancel();

    const mode = state.settings.mode === 'socratic' ? 'socratic' : 'direct';
    const turn = { q: text, a: '', mode, via, route: null };
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
      user_closed_without_followup: !!s.call2 && s.turns.length === 0, // 规格 8：最关键指标
      open_ms: Date.now() - s.openedAt,
      mode: state.settings.mode,
    });
  }

  function closeDrawer(reason) {
    voice.stop();
    finishSession(reason);
    ui.closeDrawer();
  }

  // ------------------------------------------------------------------ 语音追问（规格 6）
  const voice = (() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec = null;
    let active = false;
    let committed = false;
    let silenceTimer = 0;

    function commit() {
      if (committed) return;
      committed = true;
      clearTimeout(silenceTimer);
      try { rec && rec.stop(); } catch (_) {}
      const text = ui.getInput().trim();
      if (text) { ui.setInput(''); sendFollowup(text, 'voice'); }
    }

    function start() {
      if (!SR || active) return;
      rec = new SR();
      rec.lang = 'zh-CN';
      rec.interimResults = true; // 首个 partial 就拿到
      rec.continuous = true;
      rec.maxAlternatives = 1;
      committed = false;
      let finalText = '';
      ui.setInput('');
      rec.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finalText += r[0].transcript;
          else interim += r[0].transcript;
        }
        const text = (finalText + interim).trim();
        ui.setInput(text);
        clearTimeout(silenceTimer);
        // ≥4 字后，短静音就算说完；不等浏览器自己的长端点判定
        if (text.replace(/\s/g, '').length >= MIN_VOICE_CHARS) silenceTimer = setTimeout(commit, interim ? VAD_SILENCE_MS : 250);
      };
      rec.onerror = (e) => {
        const map = {
          'not-allowed': '麦克风权限被拒绝了，可以直接打字或点快捷回复。',
          'service-not-allowed': '浏览器不允许语音识别，可以直接打字或点快捷回复。',
          network: '语音识别服务连不上（Chrome 自带的语音识别要访问 Google），请直接打字。',
          'audio-capture': '没有找到麦克风，请直接打字。',
          'no-speech': '没听到声音，再点一次麦克风试试。',
        };
        if (map[e.error]) ui.showTip(map[e.error]);
      };
      rec.onend = () => {
        active = false;
        clearTimeout(silenceTimer);
        ui.setMic(false);
        if (!committed && ui.getInput().trim().length >= 2) commit();
      };
      try {
        rec.start();
        active = true;
        ui.setMic(true);
        ui.hideTip();
      } catch (_) {
        active = false;
        ui.setMic(false);
      }
    }

    function stop() {
      committed = true;
      clearTimeout(silenceTimer);
      try { rec && rec.abort(); } catch (_) {}
      active = false;
      ui.setMic(false);
    }

    return {
      supported: () => !!SR,
      toggle: () => (active ? commit() : start()),
      stop,
    };
  })();

  // ------------------------------------------------------------------ 界面（Shadow DOM）
  const CSS = `
:host {
  all: initial;
  --bg: #ffffff; --bg-soft: #f4f5f7; --ink: #18191c; --ink-2: #555b63; --ink-3: #8a9099;
  --line: #e2e5e9; --accent: #0b7a68; --accent-hover: #09685a; --accent-soft: #e5f3f0; --on-accent: #ffffff;
  --user: #eaf0fb; --warn: #8a4b06; --warn-soft: #fff4e0; --err: #b3261e; --err-soft: #fdeceb;
  --shadow: -16px 0 40px rgba(15, 20, 25, 0.14);
  font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: #1c1d21; --bg-soft: #26282d; --ink: #eceef1; --ink-2: #b4b9c0; --ink-3: #868c94;
    --line: #34373d; --accent: #3fb8a2; --accent-hover: #5ccab5; --accent-soft: #1f3a35; --on-accent: #0d1715;
    --user: #26324a; --warn: #f2c27b; --warn-soft: #3a2e1b; --err: #ff9a92; --err-soft: #3d2221;
    --shadow: -16px 0 40px rgba(0, 0, 0, 0.5);
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button { font: inherit; cursor: pointer; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.ask {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px 12px 22px; border-radius: 999px;
  border: 1px solid rgba(255,255,255,0.22); background: rgba(14, 16, 18, 0.82); color: #fff;
  font-size: 16px; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap;
  box-shadow: 0 10px 30px rgba(0,0,0,0.35); backdrop-filter: blur(8px);
  animation: pop .18s ease-out; transition: background .15s;
}
.ask:hover { background: rgba(11, 122, 104, 0.95); }
.ask kbd {
  font: 600 12px/1 ui-monospace, Consolas, monospace; padding: 5px 7px; border-radius: 6px;
  background: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.28);
}
@keyframes pop { from { opacity: 0; transform: translate(-50%, -46%) scale(.96); } }

.drawer {
  position: fixed; top: 0; right: 0; height: 100vh; width: min(380px, 100vw);
  display: flex; flex-direction: column;
  background: var(--bg); color: var(--ink); border-left: 1px solid var(--line); box-shadow: var(--shadow);
  font-size: 14px; line-height: 1.6;
  transform: translateX(104%); transition: transform .22s ease;
}
.drawer.open { transform: none; }

.head { display: flex; align-items: flex-start; gap: 10px; padding: 14px 12px 12px 16px; border-bottom: 1px solid var(--line); }
.head-main { flex: 1; min-width: 0; }
.brand { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 700; }
.brand .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.where { display: flex; align-items: center; gap: 8px; margin-top: 4px; font-size: 12px; color: var(--ink-2); min-width: 0; }
.where .ts { flex: none; font: 600 12px/1.6 ui-monospace, Consolas, monospace; color: var(--accent); }
.where .subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon { flex: none; width: 32px; height: 32px; border: 0; border-radius: 8px; background: transparent; color: var(--ink-2); font-size: 16px; }
.icon:hover { background: var(--bg-soft); color: var(--ink); }

.scroll { flex: 1; overflow-y: auto; padding: 16px; overscroll-behavior: contain; }
.notice { margin-bottom: 14px; padding: 8px 10px; border-radius: 8px; background: var(--warn-soft); color: var(--warn); font-size: 12px; line-height: 1.6; }

.seg + .seg { margin-top: 14px; }
.tag { display: inline-block; margin-bottom: 4px; padding: 1px 7px; border-radius: 4px; background: var(--accent-soft); color: var(--accent); font-size: 11px; font-weight: 600; letter-spacing: 0.04em; }
.seg p { margin: 0; font-size: 15px; line-height: 1.75; white-space: pre-wrap; word-break: break-word; }
.seg.hook p { font-weight: 600; }
.quick { display: flex; gap: 8px; margin-top: 10px; }
.quick button { flex: 1; padding: 7px 0; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); font-size: 13px; }
.quick button:hover { border-color: var(--accent); color: var(--accent); }
.quick button:disabled { opacity: .45; cursor: default; }
.meta { margin-top: 12px; font-size: 11px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.meta.warn { color: var(--warn); }

.loading-text { color: var(--ink-2); font-size: 13px; margin-bottom: 12px; }
.sk { height: 14px; margin: 10px 0; border-radius: 6px; background: linear-gradient(90deg, var(--bg-soft) 25%, var(--line) 50%, var(--bg-soft) 75%); background-size: 200% 100%; animation: shimmer 1.2s infinite linear; }
.sk.short { width: 62%; }
@keyframes shimmer { to { background-position: -200% 0; } }

.error { padding: 10px 12px; border-radius: 8px; background: var(--err-soft); color: var(--err); font-size: 13px; line-height: 1.6; word-break: break-word; }
.retry { margin-top: 10px; padding: 6px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); font-size: 13px; }

.thread { display: flex; flex-direction: column; gap: 10px; margin-top: 18px; }
.thread:empty { display: none; }
.thread::before { content: "追问"; font-size: 11px; color: var(--ink-3); letter-spacing: .08em; padding-top: 12px; border-top: 1px dashed var(--line); }
.turn { display: flex; flex-direction: column; gap: 6px; }
.bubble { max-width: 92%; padding: 8px 12px; font-size: 14px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
.bubble.user { align-self: flex-end; background: var(--user); border-radius: 12px 12px 4px 12px; }
.bubble.bot { align-self: flex-start; background: var(--bg-soft); border-radius: 12px 12px 12px 4px; }
.bubble.bot.redirect { background: var(--warn-soft); color: var(--warn); }
.bubble .note { display: block; font-size: 11px; color: var(--ink-3); margin-bottom: 2px; }
.bubble.streaming .text::after { content: "▍"; color: var(--accent); animation: blink 1s steps(2, start) infinite; }
.bubble.waiting .text::before { content: "…"; color: var(--ink-3); }
.turn .meta { margin-top: 0; padding-left: 4px; }
.turn .error { font-size: 12px; padding: 6px 10px; }
@keyframes blink { to { visibility: hidden; } }

.foot { border-top: 1px solid var(--line); padding: 10px 12px 12px; background: var(--bg); }
.tip { margin-bottom: 8px; font-size: 12px; color: var(--warn); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.chips button { padding: 4px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg); color: var(--ink-2); font-size: 12px; }
.chips button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.chips button:disabled, .composer :disabled { opacity: .45; cursor: default; }
.composer { display: flex; align-items: center; gap: 6px; padding: 4px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg-soft); }
.composer:focus-within { border-color: var(--accent); }
.input { flex: 1; min-width: 0; padding: 8px 6px; border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 14px; outline: none; }
.input::placeholder { color: var(--ink-3); }
.mic, .send { flex: none; display: grid; place-items: center; width: 34px; height: 34px; border: 0; border-radius: 9px; }
.mic { background: transparent; color: var(--ink-2); }
.mic:hover:not(:disabled) { background: var(--bg); color: var(--ink); }
.mic.on { background: var(--err-soft); color: var(--err); animation: pulse 1.2s ease-in-out infinite; }
.send { background: var(--accent); color: var(--on-accent); }
.send:hover:not(:disabled) { background: var(--accent-hover); }
@keyframes pulse { 50% { box-shadow: 0 0 0 6px transparent; } 0% { box-shadow: 0 0 0 0 var(--err-soft); } }
.foot-row { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
.mode { display: inline-flex; padding: 3px; border-radius: 9px; background: var(--bg-soft); }
.mode button { padding: 4px 12px; border: 0; border-radius: 7px; background: transparent; color: var(--ink-2); font-size: 12px; }
.mode button[aria-checked="true"] { background: var(--bg); color: var(--ink); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,.12); }
.resume { padding: 4px 6px; border: 0; background: transparent; color: var(--accent); font-size: 13px; font-weight: 600; }
.resume:hover { color: var(--accent-hover); }
`;

  const MIC_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  const SEND_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  const HTML = `
<button class="ask" type="button" hidden aria-label="我这里不懂（快捷键 1）"><span>我这里不懂</span><kbd>1</kbd></button>
<aside class="drawer" hidden role="dialog" aria-label="学习搭子">
  <header class="head">
    <div class="head-main">
      <div class="brand"><span class="dot"></span>学习搭子</div>
      <div class="where"><span class="ts"></span><span class="subject"></span></div>
    </div>
    <button class="icon close" type="button" title="关闭（Esc）" aria-label="关闭">✕</button>
  </header>
  <div class="scroll">
    <div class="notice" hidden></div>
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
      <button class="resume" type="button">继续播放 ▸</button>
    </div>
  </footer>
</aside>`;

  const ui = (() => {
    const host = document.createElement('div');
    host.id = 'learn-buddy-root';
    host.style.cssText = 'all: initial; position: fixed; left: 0; top: 0; width: 0; height: 0; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>${HTML}`;
    const $ = (sel) => root.querySelector(sel);
    const askBtn = $('.ask');
    const drawer = $('.drawer');
    const card = $('.card');
    const thread = $('.thread');
    const scroller = $('.scroll');
    const notice = $('.notice');
    const tip = $('.tip');
    const input = $('.input');
    const mic = $('.mic');
    const sendBtn = $('.send');
    let askVideo = null;
    let closeTimer = 0;

    // 抽屉里的点击/按键不要漏给 B 站播放器（否则会触发暂停/全屏/弹幕等快捷键）
    for (const ev of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'keypress', 'contextmenu', 'touchstart', 'touchend']) {
      host.addEventListener(ev, (e) => e.stopPropagation());
    }

    function mount() {
      const fs = document.fullscreenElement;
      const target = fs && fs.tagName !== 'VIDEO' ? fs : (document.body || document.documentElement);
      if (host.parentNode !== target) target.appendChild(host);
    }

    function placeAsk() {
      if (askBtn.hidden || !askVideo) return;
      const r = askVideo.getBoundingClientRect();
      const visible = r.width > 120 && r.height > 80 && r.bottom > 0 && r.top < window.innerHeight;
      askBtn.style.visibility = visible ? '' : 'hidden';
      if (!visible) return;
      askBtn.style.left = `${r.left + r.width / 2}px`;
      askBtn.style.top = `${r.top + r.height / 2}px`;
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

    askBtn.addEventListener('click', () => startExplain('button'));
    $('.close').addEventListener('click', () => closeDrawer('close_button'));
    $('.resume').addEventListener('click', () => { const v = state.video; if (v) v.play().catch(() => {}); });
    sendBtn.addEventListener('click', submitInput);
    mic.addEventListener('click', () => voice.toggle());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); submitInput(); }
    });
    for (const b of root.querySelectorAll('.chips button')) b.addEventListener('click', () => sendFollowup(b.dataset.say, 'chip'));
    for (const b of root.querySelectorAll('.mode button')) b.addEventListener('click', () => setMode(b.dataset.mode));
    window.addEventListener('resize', placeAsk);
    window.addEventListener('scroll', placeAsk, { passive: true });
    document.addEventListener('fullscreenchange', () => { mount(); setTimeout(placeAsk, 120); });
    setInterval(() => { if (!askBtn.hidden) placeAsk(); }, 400);

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
      if (d.total_ms) metaBits.push(`${(d.total_ms / 1000).toFixed(1)}s`);
      out.push(h('div', { class: 'meta' + (d.length_violation ? ' warn' : '') }, metaBits.join(' · ')));
      return out;
    }

    function setNotice(s) {
      let msg = '';
      const d = s.call2;
      if (s.degraded) {
        if (!s.frameCaptured) msg = '本次没有抓到字幕，也没有截到画面，只能根据你的描述来解释。';
        else if (!d) msg = '这一段没抓到字幕，正在看画面…';
        else if (d.vision_used) msg = '本次没有抓到字幕，只能依据画面来解释。打开播放器的字幕（CC / AI 字幕）后会更准。';
        else if (d.ocr_used) msg = '本次没有抓到字幕，只能依据画面上读到的文字来解释。字幕如果是印在画面里的，先多播放十几秒再暂停，就能连上前后文。';
        else msg = '本次没有抓到字幕，画面上也没读到字，只能根据你的描述来解释。';
      }
      notice.textContent = msg;
      notice.hidden = !msg;
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
      return {
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
      };
    }

    return {
      mount,
      setHidden(on) { host.style.visibility = on ? 'hidden' : ''; },
      showAsk(v) { mount(); askVideo = v; askBtn.hidden = false; placeAsk(); },
      hideAsk() { askBtn.hidden = true; askVideo = null; },
      openDrawer(s) {
        mount();
        clearTimeout(closeTimer);
        $('.ts').textContent = s.timestamp;
        $('.subject').textContent = s.subject;
        $('.subject').title = s.subject;
        thread.textContent = '';
        tip.hidden = true;
        input.value = '';
        setNotice(s);
        drawer.hidden = false;
        void drawer.offsetWidth; // 强制回流再加 class，滑入动画不依赖 rAF（后台标签页 rAF 可能不跑）
        drawer.classList.add('open');
      },
      isOpen() { return !drawer.hidden && drawer.classList.contains('open'); },
      owns(path) { return path.includes(host); },
      closeDrawer() {
        drawer.classList.remove('open');
        closeTimer = setTimeout(() => { drawer.hidden = true; }, 240);
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
        setNotice(s);
        card.textContent = '';
        card.append(...segmentView(s));
        setComposerEnabled(true);
        ui.syncVoice();
      },
      appendTurn: turnView,
      showTip(m) { tip.textContent = m; tip.hidden = false; },
      hideTip() { tip.hidden = true; },
      getInput: () => input.value,
      setInput(t) { input.value = t; },
      setMic(on) { mic.classList.toggle('on', !!on); mic.title = on ? '正在听…（再点一下立即发送）' : '语音追问'; },
      syncMode() {
        const mode = state.settings.mode === 'socratic' ? 'socratic' : 'direct';
        for (const b of root.querySelectorAll('.mode button')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
      },
      syncVoice() {
        const on = voice.supported() && state.settings.voice !== false;
        mic.hidden = !on;
        input.placeholder = on ? '追问：说或打字，哪里还卡着？' : '追问：打字或点上面的快捷回复';
      },
    };
  })();

  // ------------------------------------------------------------------ 快捷键 1（规格 10：暂停 → 中央按钮 / 1 快捷键）
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
  };
  tick();
  setInterval(tick, 1000);
})();
