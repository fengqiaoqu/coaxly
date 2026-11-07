'use strict';

const DEFAULTS = {
  proxyUrl: 'http://localhost:8787', sendImage: true, hardsub: true, voice: true, mode: 'direct',
  voiceEngine: 'local', subGuide: true, summaryAi: true, // v1.2
  keyPoints: true, kpTrack: true, kpCue: true, // v1.3
};
const $ = (id) => document.getElementById(id);
const NODES_PER_VIDEO = 5; // 每个视频先显示最近几个节点，其余点「展开」

$('ver').textContent = 'v' + chrome.runtime.getManifest().version;

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  $('proxyUrl').value = s.proxyUrl;
  $('sendImage').checked = s.sendImage !== false;
  $('hardsub').checked = s.hardsub !== false;
  $('voice').checked = s.voice !== false;
  $('subGuide').checked = s.subGuide !== false;
  $('summaryAi').checked = s.summaryAi !== false;
  for (const id of ['keyPoints', 'kpTrack', 'kpCue']) $(id).checked = s[id] !== false;
  syncKpDeps();
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === s.mode;
  for (const r of document.querySelectorAll('input[name="voiceEngine"]')) r.checked = r.value === (s.voiceEngine === 'browser' ? 'browser' : 'local');
}

function save(patch) { return chrome.storage.local.set(patch); }

$('proxyUrl').addEventListener('change', (e) => {
  const v = e.target.value.trim().replace(/\/+$/, '') || DEFAULTS.proxyUrl;
  e.target.value = v;
  save({ proxyUrl: v });
});
for (const id of ['sendImage', 'hardsub', 'voice', 'subGuide', 'summaryAi', 'keyPoints', 'kpTrack', 'kpCue']) {
  $(id).addEventListener('change', (e) => { save({ [id]: e.target.checked }); syncKpDeps(); });
}
// 总开关关掉时，两个子开关变灰（值保留）
function syncKpDeps() {
  const on = $('keyPoints').checked;
  for (const id of ['kpTrack', 'kpCue']) { $(id).disabled = !on; $(id).closest('label').style.opacity = on ? '' : '.5'; }
}
for (const name of ['mode', 'voiceEngine']) {
  for (const r of document.querySelectorAll(`input[name="${name}"]`)) {
    r.addEventListener('change', () => { if (r.checked) save({ [name]: r.value }); });
  }
}

// ------------------------------------------------------------------ 测试连接
$('test').addEventListener('click', async () => {
  const status = $('status');
  status.className = '';
  status.textContent = '连接中…';
  const res = await chrome.runtime.sendMessage({ type: 'call', path: '/health', method: 'GET' });
  if (res && res.ok) {
    const d = res.data || {};
    const old = d.version && !(d.features || []).includes('keypoints');
    status.className = !d.hasKey ? 'err' : old ? 'warn' : 'ok';
    const look = d.sendImage === false
      ? (d.ocr === false ? '不看画面' : d.ocrReady ? '画面文字由本地识别' : '画面识字不可用：' + (d.ocrError || '请重启代理'))
      : `视觉模型 ${d.visionModel}`;
    let asr;
    if (!d.version) asr = '代理是旧版本（没有语音识别和一句话说明），请关掉「启动.bat」窗口再重新打开';
    else if (!(d.features || []).includes('keypoints')) asr = `代理是 v${d.version}，没有课程重点功能，请关掉「启动.bat」窗口再重新打开`;
    else if (d.asrEngine === 'off') asr = '语音识别已在代理配置里关闭';
    else if (d.asrEngine === 'cloud') asr = `语音识别：云端 ${d.asrModel || ''}${d.asrReady ? '（本机识别兜底）' : ''}`;
    else asr = d.asrReady ? '语音识别：本机离线可用' : '本机语音识别不可用：' + (d.asrError || '未知原因');
    status.textContent = d.hasKey
      ? `已连上代理${d.version ? ' v' + d.version : ''} · 模型 ${d.model} · ${look} · ${asr}`
      : `已连上代理，但还没配置 API Key（编辑 proxy/config.json）· ${asr}`;
  } else {
    status.className = 'err';
    status.textContent = res && res.unreachable
      ? '连不上本地代理：请确认「启动.bat」那个窗口还开着，地址和端口一致。'
      : `出错：${(res && res.error) || '未知错误'}`;
  }
});

// ------------------------------------------------------------------ 学习历史（v1.2）
const fmtDate = (ms) => {
  const d = new Date(ms || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 视频 ID（content.js 的 getVideoId）→ 能打开的地址，并带上跳转位置 t=
function videoUrl(videoId, t) {
  const sec = Math.max(0, Math.floor(t || 0));
  const bv = /^(BV[0-9A-Za-z]+|av\d+)(?:_p(\d+))?$/i.exec(videoId);
  if (bv) return `https://www.bilibili.com/video/${bv[1]}/?${bv[2] ? `p=${bv[2]}&` : ''}t=${sec}`;
  const ep = /^(ep\d+|ss\d+)/.exec(videoId);
  if (ep) return `https://www.bilibili.com/bangumi/play/${ep[1]}?t=${sec}`;
  if (videoId.startsWith('/')) return `https://www.bilibili.com${videoId}`;
  return null;
}

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

async function openNode(node) {
  const url = videoUrl(node.videoId, node.t);
  if (!url) return;
  // 内容脚本在视频页加载后读到它，就会跳到节点位置并还原对话（2 分钟内有效）
  await chrome.storage.local.set({ pendingRestore: { videoId: node.videoId, nodeId: node.id, at: Date.now() } });
  chrome.tabs.create({ url });
}

async function renderHistory() {
  const list = $('histList');
  const videos = await LBHistory.listAll();
  list.textContent = '';
  let total = 0;
  for (const v of videos) {
    const nodes = [...v.nodes].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    total += nodes.length;
    const box = el('div', { class: 'hist-video' },
      el('h3', null, el('span', { class: 't', title: v.subject || v.videoId }, v.subject || v.videoId), el('span', { class: 'n' }, `${nodes.length} 个节点 · ${fmtDate(v.updatedAt)}`)));
    const rows = nodes.map((n) => {
      const turns = (n.turns || []).length;
      const url = videoUrl(n.videoId, n.t);
      return el('button', {
        type: 'button',
        class: 'hist-node',
        disabled: !url,
        title: url ? `打开视频，跳到 ${n.timestamp} 并还原当时的对话` : '无法识别这个视频的地址',
        onclick: () => openNode(n),
      },
      el('span', { class: 'ts' }, n.timestamp),
      el('span', { class: 'body' },
        el('span', { class: 'sum' }, LBHistory.summaryOf(n)),
        el('span', { class: 'meta' }, `${fmtDate(n.createdAt)} · ${turns ? `追问 ${turns} 轮` : '没有追问'}${n.summarySource === 'ai' ? ' · AI 说明' : ''}`)));
    });
    box.append(...rows.slice(0, NODES_PER_VIDEO));
    if (rows.length > NODES_PER_VIDEO) {
      const more = el('button', { type: 'button', class: 'more' }, `展开其余 ${rows.length - NODES_PER_VIDEO} 个`);
      more.addEventListener('click', () => { more.replaceWith(...rows.slice(NODES_PER_VIDEO)); });
      box.append(more);
    }
    list.append(box);
  }
  if (total) $('histStatus').textContent = `共 ${videos.length} 个视频、${total} 个节点`;
}

$('clearHist').addEventListener('click', async () => {
  if (!confirm('清空所有视频的学习历史？清空后不能恢复。')) return;
  const n = await LBHistory.clearAll();
  await renderHistory();
  $('histStatus').textContent = `已清空 ${n} 个视频的学习历史`;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k.startsWith(LBHistory.PREFIX))) renderHistory();
});

// ------------------------------------------------------------------ 课程重点（v1.3）
async function kpCount() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('kp:'));
  const points = keys.reduce((n, k) => n + ((all[k] && all[k].points) || []).length, 0);
  return { keys, points };
}
async function renderKpStatus() {
  const { keys, points } = await kpCount();
  $('kpStatus').textContent = keys.length ? `已为 ${keys.length} 个视频标注了 ${points} 个重点` : '';
}
$('clearKp').addEventListener('click', async () => {
  const { keys } = await kpCount();
  if (keys.length && !confirm(`清空 ${keys.length} 个视频的重点标注？下次播放时会重新分析（会再调用模型）。`)) return;
  if (keys.length) await chrome.storage.local.remove(keys);
  $('kpStatus').textContent = `已清空 ${keys.length} 个视频的重点标注`;
});

// ------------------------------------------------------------------ 求助记录（给 Call 2 换角度用）
$('clearPast').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('past:'));
  if (keys.length) await chrome.storage.local.remove(keys);
  $('clearStatus').textContent = `已清空 ${keys.length} 个视频的记录`;
});

load();
renderHistory();
renderKpStatus();
