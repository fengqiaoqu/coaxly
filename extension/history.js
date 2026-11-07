/* 学习搭子 · 历史节点存储（v1.2）
 *
 * 用户每打开一次学习搭子并拿到解释，就是一个「节点」。节点存在 chrome.storage.local：
 *   hist:<视频ID> → { videoId, subject, updatedAt, nodes: [节点…] }
 * 只由扩展后台（background.js 通过 importScripts 加载本文件）写入，所有写操作排队执行，
 * 多个标签页同时追问也不会互相覆盖。设置页、模拟页也加载本文件，用来读取 / 清空。
 */
(function (global) {
  'use strict';

  const PREFIX = 'hist:';
  const MAX_NODES = 50;              // 每个视频最多留多少个节点
  const MAX_BYTES = 8 * 1024 * 1024; // 扩展存储总占用超过这个数，就删最久没看的视频
  const TRANSCRIPT_MAX = 2000;
  const DONE_RE = /懂了|明白了|知道了|会了|清楚了|理解了/;
  const STUCK_RE = /还是不懂|没懂|不懂|不明白|听不懂|看不懂|不理解|晕/;

  const area = () => chrome.storage.local;
  const get = (keys) => new Promise((resolve) => area().get(keys, (o) => resolve(o || {})));
  const set = (obj) => new Promise((resolve) => area().set(obj, () => resolve()));
  const remove = (keys) => new Promise((resolve) => area().remove(keys, () => resolve()));
  const bytesInUse = () => new Promise((resolve) => {
    try { area().getBytesInUse(null, (n) => resolve(n || 0)); } catch (_) { resolve(0); }
  });

  // 所有写操作串行：上一个失败也不影响下一个
  let chain = Promise.resolve();
  function serial(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }

  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const keyOf = (videoId) => PREFIX + videoId;

  // ---------------------------------------------------------------- 规则生成的一句话说明（立即可用；AI 说明出来后替换）
  function firstSegment(node) {
    const d = node.call2 || {};
    const segs = Array.isArray(d.segments) && d.segments.length ? d.segments : String(d.text || '').split(/\n\s*\n/);
    return String(segs[0] || '').replace(/\*\*/g, '');
  }

  function ruleSummary(node) {
    const turns = (node.turns || []).filter((t) => t && t.q);
    const concept = clip(node.originalConcept, 18);
    const head = concept ? `卡在「${concept}」` : `${node.timestamp || ''} 这一段`;
    if (!turns.length) return `${head}：${clip(firstSegment(node), 20)}`;
    const last = String(turns[turns.length - 1].q || '');
    let result = '';
    if (DONE_RE.test(last) && !STUCK_RE.test(last)) result = ' · 已懂';
    else if (STUCK_RE.test(last)) result = ' · 还没懂';
    return `${head} · 追问 ${turns.length} 次${result}`;
  }

  // ---------------------------------------------------------------- 节点清洗（只存继续追问需要的东西）
  function pickCall2(d) {
    if (!d) return null;
    const out = {};
    for (const k of ['text', 'segments', 'chars', 'seg_count', 'length_violation', 'retried', 'vision_used', 'ocr_used', 'total_ms', 'degraded']) {
      if (d[k] !== undefined) out[k] = d[k];
    }
    return out;
  }

  function cleanNode(n) {
    const turns = (n.turns || [])
      .filter((t) => t && t.q && (t.a || t.error))
      .map((t) => ({ q: String(t.q), a: String(t.a || ''), mode: t.mode || 'direct', via: t.via || 'text', route: t.route || null, at: t.at || null }));
    const node = {
      id: String(n.id),
      videoId: String(n.videoId),
      subject: String(n.subject || ''),
      t: Number(n.t) || 0,
      timestamp: String(n.timestamp || ''),
      createdAt: n.createdAt || Date.now(),
      updatedAt: Date.now(),
      call2: pickCall2(n.call2),
      transcript: String(n.transcript || '').slice(0, TRANSCRIPT_MAX),
      screenText: String(n.screenText || '').slice(0, 600),
      originalConcept: String(n.originalConcept || ''),
      route: n.route || null,
      degraded: !!n.degraded,
      subsFromScreen: !!n.subsFromScreen,
      frameCaptured: n.frameCaptured !== false,
      turns,
    };
    node.rev = 1 + turns.length;
    node.ruleSummary = ruleSummary(node);
    return node;
  }

  // ---------------------------------------------------------------- 读
  async function list(videoId) {
    if (!videoId) return null;
    const o = await get(keyOf(videoId));
    return o[keyOf(videoId)] || null;
  }

  async function listAll() {
    const o = await get(null);
    return Object.keys(o)
      .filter((k) => k.startsWith(PREFIX) && o[k] && Array.isArray(o[k].nodes))
      .map((k) => o[k])
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // ---------------------------------------------------------------- 写
  async function prune() {
    let used = await bytesInUse();
    if (used <= MAX_BYTES) return 0;
    const all = await listAll();
    let removed = 0;
    // 从最久没更新的视频开始删，每删一个重新量一次
    for (let i = all.length - 1; i > 0 && used > MAX_BYTES; i--) {
      await remove(keyOf(all[i].videoId));
      removed++;
      used = await bytesInUse();
    }
    return removed;
  }

  function put(raw) {
    return serial(async () => {
      if (!raw || !raw.id || !raw.videoId) throw new Error('节点缺少 id 或 videoId');
      const node = cleanNode(raw);
      const key = keyOf(node.videoId);
      const entry = (await get(key))[key] || { videoId: node.videoId, subject: node.subject, nodes: [] };
      const i = entry.nodes.findIndex((x) => x.id === node.id);
      if (i >= 0) {
        const old = entry.nodes[i];
        node.createdAt = old.createdAt || node.createdAt;
        // 已经生成过的 AI 说明先留着，会话结束后再按新的追问重写
        if (old.summary) { node.summary = old.summary; node.summarySource = old.summarySource; node.summaryRev = old.summaryRev; }
        entry.nodes[i] = node;
      } else {
        entry.nodes.push(node);
      }
      entry.nodes.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      if (entry.nodes.length > MAX_NODES) entry.nodes.splice(0, entry.nodes.length - MAX_NODES);
      entry.subject = node.subject || entry.subject;
      entry.updatedAt = Date.now();
      await set({ [key]: entry });
      await prune();
      return entry;
    });
  }

  // 调代理 /summarize（Call 4）生成一句话说明并写回节点。call(path, body) → { ok, data, status, error }
  const inflight = new Set();
  async function summarize(videoId, nodeId, call, sessionId) {
    const entry = await serial(() => list(videoId));
    const node = entry && entry.nodes.find((x) => x.id === nodeId);
    if (!node || !node.call2) return { ok: false, error: 'no_node' };
    if (node.summarySource === 'ai' && node.summaryRev === node.rev) return { ok: true, skipped: true, summary: node.summary };
    const tag = nodeId + ':' + node.rev;
    if (inflight.has(tag)) return { ok: true, skipped: true };
    inflight.add(tag);
    try {
      const res = await call('/summarize', {
        session_id: sessionId || null,
        node_id: node.id,
        video_id: node.videoId,
        subject: node.subject,
        timestamp: node.timestamp,
        original_concept: node.originalConcept,
        transcript: node.transcript,
        call2_output: (node.call2 && node.call2.text) || '',
        turns: node.turns.map((t) => ({ q: t.q, a: t.a })),
      });
      const summary = res && res.ok && res.data && res.data.ok ? String(res.data.summary || '').trim() : '';
      if (!summary) return { ok: false, status: res && res.status, error: (res && res.error) || 'empty_summary' };
      await serial(async () => {
        const key = keyOf(videoId);
        const e = (await get(key))[key];
        const n = e && e.nodes.find((x) => x.id === nodeId);
        if (!n) return;
        n.summary = summary;
        n.summarySource = 'ai';
        n.summaryRev = node.rev; // 记下是按第几版生成的；之后又有追问会再生成
        await set({ [key]: e });
      });
      return { ok: true, summary };
    } finally {
      inflight.delete(tag);
    }
  }

  // 补生成：会话没正常结束（关标签页、后台被回收、当时代理没开）的节点没有 AI 说明，
  // 下次打开这个视频时补上。只补最近 max 个、且 minAgeMs 内没改过的（可能还在追问中）。
  async function backfill(videoId, call, opts) {
    const { max = 3, minAgeMs = 60000 } = opts || {};
    const entry = await list(videoId);
    if (!entry) return 0;
    const now = Date.now();
    const stale = entry.nodes
      .filter((n) => n.call2 && !(n.summarySource === 'ai' && n.summaryRev === n.rev) && now - (n.updatedAt || 0) > minAgeMs)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, max);
    let done = 0;
    for (const n of stale) {
      const res = await summarize(videoId, n.id, call);
      if (!res || !res.ok) break; // 代理没开 / 出错就别接着打了
      if (!res.skipped) done++;
    }
    return done;
  }

  function clearAll() {
    return serial(async () => {
      const o = await get(null);
      const keys = Object.keys(o).filter((k) => k.startsWith(PREFIX));
      if (keys.length) await remove(keys);
      return keys.length;
    });
  }

  // 显示用：AI 说明优先，没有就用规则说明
  const summaryOf = (node) => (node && (node.summary || node.ruleSummary)) || '';

  global.LBHistory = { PREFIX, MAX_NODES, list, listAll, put, summarize, backfill, clearAll, ruleSummary, summaryOf };
})(typeof self !== 'undefined' ? self : this);
