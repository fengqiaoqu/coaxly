/* 学习搭子 · service worker
 * 1. 转发内容脚本到本地代理的请求（扩展只认代理地址，永远不接触 API Key）
 * 2. Call 3 的 SSE 流：chrome.runtime.connect({name:'stream'}) 长连接逐块转发
 * 3. 截图：captureVisibleTab → OffscreenCanvas 裁出视频矩形（绕开 B 站跨域视频污染画布的问题）
 * 4. 历史节点（v1.2）：所有标签页的节点都由这里统一写入 chrome.storage.local，会话结束后调 /summarize 生成一句话说明。
 *    放在后台做，页面关掉了说明也照样会生成。
 * 5. 整片字幕（v1.3 探索）：内容脚本取 B 站字幕 JSON 被跨域拦下时，由这里代取（只放行 bilibili.com / hdslb.com）。
 */
'use strict';

importScripts('history.js');

const DEFAULTS = { proxyUrl: 'http://localhost:8787', sendImage: true, summaryAi: true };
const MAX_FRAME_WIDTH = 960;

async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

function proxyBase(settings) {
  return String(settings.proxyUrl || DEFAULTS.proxyUrl).replace(/\/+$/, '');
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// ------------------------------------------------------------------ 普通请求
async function callProxy(path, body, method) {
  const settings = await getSettings();
  const m = method || (body === undefined ? 'GET' : 'POST');
  let res;
  try {
    res = await fetch(proxyBase(settings) + path, {
      method: m,
      headers: m === 'GET' ? undefined : { 'Content-Type': 'application/json' },
      body: m === 'GET' ? undefined : JSON.stringify(body || {}),
    });
  } catch (e) {
    return { ok: false, unreachable: true, error: String((e && e.message) || e) };
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  if (!res.ok) {
    return { ok: false, status: res.status, error: (data && (data.error || data.message)) || text || `HTTP ${res.status}` };
  }
  return { ok: true, data };
}

// ------------------------------------------------------------------ 整片字幕（v1.3 探索）
// 内容脚本取 B 站接口 / 字幕文件被跨域拦下时的后备。只放行 B 站自己的域名，不做通用代理。
async function fetchBiliJson(url) {
  let u;
  try { u = new URL(url); } catch (_) { return { ok: false, error: 'bad_url' }; }
  const host = u.hostname.toLowerCase();
  const allowed = u.protocol === 'https:' && ['bilibili.com', 'hdslb.com'].some((d) => host === d || host.endsWith('.' + d));
  if (!allowed) return { ok: false, error: 'host_not_allowed' };
  try {
    const res = await fetch(u.href, { credentials: 'include' });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// ------------------------------------------------------------------ 截图并裁剪
function bytesToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function captureFrame(tab, rect, viewport) {
  if (!tab) return { ok: false, error: 'no_tab' };
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bmp = await createImageBitmap(await (await fetch(shot)).blob());
  const scale = bmp.width / Math.max(1, viewport.width);
  const sx = Math.max(0, Math.round(rect.x * scale));
  const sy = Math.max(0, Math.round(rect.y * scale));
  const sw = Math.min(bmp.width - sx, Math.round(rect.width * scale));
  const sh = Math.min(bmp.height - sy, Math.round(rect.height * scale));
  if (sw < 32 || sh < 32) return { ok: false, error: 'video_not_visible' };
  const k = Math.min(1, MAX_FRAME_WIDTH / sw);
  const canvas = new OffscreenCanvas(Math.round(sw * k), Math.round(sh * k));
  canvas.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return {
    ok: true,
    dataUrl: 'data:image/jpeg;base64,' + bytesToBase64(await blob.arrayBuffer()),
    width: canvas.width,
    height: canvas.height,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'call') return sendResponse(await callProxy(msg.path, msg.body, msg.method));
      if (msg.type === 'capture') {
        const settings = await getSettings();
        if (settings.sendImage === false) return sendResponse({ ok: false, error: 'disabled' });
        return sendResponse(await captureFrame(sender.tab, msg.rect, msg.viewport));
      }
      if (msg.type === 'openOptions') { chrome.runtime.openOptionsPage(); return sendResponse({ ok: true }); }
      if (msg.type === 'fetchJson') return sendResponse(await fetchBiliJson(msg.url));
      if (msg.type === 'hist:list') {
        sendResponse({ ok: true, data: await LBHistory.list(msg.videoId) });
        const settings = await getSettings();
        if (settings.summaryAi !== false) await LBHistory.backfill(msg.videoId, callProxy);
        return undefined;
      }
      if (msg.type === 'hist:put') {
        const entry = await LBHistory.put(msg.node);
        sendResponse({ ok: true, data: entry });
        if (msg.summarize) {
          const settings = await getSettings();
          if (settings.summaryAi !== false) await LBHistory.summarize(msg.node.videoId, msg.node.id, callProxy, msg.sessionId);
        }
        return undefined;
      }
      sendResponse({ ok: false, error: 'unknown_message' });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

// ------------------------------------------------------------------ 流式转发（Call 3）
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'stream') return;
  const ctrl = new AbortController();
  let closed = false;
  const post = (ev) => { if (!closed) { try { port.postMessage(ev); } catch (_) { closed = true; } } };
  port.onDisconnect.addListener(() => { closed = true; ctrl.abort(); });

  port.onMessage.addListener(async (msg) => {
    const settings = await getSettings();
    let res;
    try {
      res = await fetch(proxyBase(settings) + msg.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg.body || {}),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (!closed) { post({ type: 'error', unreachable: true, message: String((e && e.message) || e) }); post({ type: 'end' }); }
      return;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try { message = JSON.parse(text).error || text; } catch (_) { /* keep text */ }
      post({ type: 'error', status: res.status, message: message || `HTTP ${res.status}` });
      post({ type: 'end' });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const flush = (block) => {
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data) return;
      try { post(JSON.parse(data)); } catch (_) { /* 忽略坏块 */ }
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r/g, '');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          flush(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
        }
      }
      if (buf.trim()) flush(buf);
    } catch (e) {
      if (!closed) post({ type: 'error', interrupted: true, message: '流式连接中断，已保留收到的部分。' });
    }
    post({ type: 'end' });
  });
});
