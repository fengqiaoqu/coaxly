'use strict';

const DEFAULTS = { proxyUrl: 'http://localhost:8787', sendImage: true, hardsub: true, voice: true, mode: 'direct' };
const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  $('proxyUrl').value = s.proxyUrl;
  $('sendImage').checked = s.sendImage !== false;
  $('hardsub').checked = s.hardsub !== false;
  $('voice').checked = s.voice !== false;
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === s.mode;
}

function save(patch) { return chrome.storage.local.set(patch); }

$('proxyUrl').addEventListener('change', (e) => {
  const v = e.target.value.trim().replace(/\/+$/, '') || DEFAULTS.proxyUrl;
  e.target.value = v;
  save({ proxyUrl: v });
});
$('sendImage').addEventListener('change', (e) => save({ sendImage: e.target.checked }));
$('hardsub').addEventListener('change', (e) => save({ hardsub: e.target.checked }));
$('voice').addEventListener('change', (e) => save({ voice: e.target.checked }));
for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener('change', () => { if (r.checked) save({ mode: r.value }); });
}

$('test').addEventListener('click', async () => {
  const status = $('status');
  status.className = '';
  status.textContent = '连接中…';
  const res = await chrome.runtime.sendMessage({ type: 'call', path: '/health', method: 'GET' });
  if (res && res.ok) {
    const d = res.data || {};
    status.className = d.hasKey ? 'ok' : 'err';
    const look = d.sendImage === false
      ? (d.ocr === false ? '不看画面' : d.ocrReady ? '画面文字由本地识别' : '画面识字不可用：' + (d.ocrError || '请重启代理'))
      : `视觉模型 ${d.visionModel}`;
    status.textContent = d.hasKey
      ? `已连上代理 · 模型 ${d.model} · ${look}`
      : '已连上代理，但还没配置 API Key（编辑 proxy/config.json）';
  } else {
    status.className = 'err';
    status.textContent = res && res.unreachable
      ? '连不上本地代理：请确认「启动.bat」那个窗口还开着，地址和端口一致。'
      : `出错：${(res && res.error) || '未知错误'}`;
  }
});

$('clearPast').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('past:'));
  if (keys.length) await chrome.storage.local.remove(keys);
  $('clearStatus').textContent = `已清空 ${keys.length} 个视频的记录`;
});

load();
