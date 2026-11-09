(function () {
  'use strict';
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var charCount = function (s) { return s.replace(/\s/g, '').length; };
  var fmt = function (sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  };

  /* ---------- Global nav menu (≤833px) ---------- */
  var menuBtn = $('.gnav-menu'), drawerNav = $('#gnav-drawer');
  if (menuBtn) {
    menuBtn.addEventListener('click', function () {
      var open = menuBtn.getAttribute('aria-expanded') === 'true';
      menuBtn.setAttribute('aria-expanded', String(!open));
      menuBtn.setAttribute('aria-label', open ? '打开菜单' : '关闭菜单');
      drawerNav.hidden = open;
    });
    $$('a', drawerNav).forEach(function (a) {
      a.addEventListener('click', function () { drawerNav.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); });
    });
  }

  /* ---------- Reveal on scroll ---------- */
  var revealEls = $$('[data-reveal]');
  if (!('IntersectionObserver' in window) || reduce) {
    revealEls.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealEls.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) el.classList.add('in');
      else io.observe(el);
    });
  }

  /* ---------- Count-up numbers ---------- */
  $$('[data-count]').forEach(function (el) {
    var target = parseFloat(el.getAttribute('data-count'));
    var dec = parseInt(el.getAttribute('data-decimals') || '0', 10);
    if (reduce || !('IntersectionObserver' in window)) return;
    var done = false;
    var ob = new IntersectionObserver(function (es) {
      if (!es[0].isIntersecting || done) return;
      done = true; ob.disconnect();
      var t0 = performance.now(), dur = 1400;
      (function step(now) {
        var p = Math.min(1, (now - t0) / dur);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = (target * eased).toFixed(dec);
        if (p < 1) requestAnimationFrame(step);
      })(t0);
    }, { threshold: 0.6 });
    ob.observe(el);
  });

  /* ---------- Sub-nav scroll spy ---------- */
  var spyLinks = $$('[data-spy]');
  var spyTargets = spyLinks.map(function (a) { return document.getElementById(a.getAttribute('href').slice(1)); });
  function spy() {
    var y = window.innerHeight * 0.35, cur = -1;
    spyTargets.forEach(function (sec, i) {
      if (!sec) return;
      var r = sec.getBoundingClientRect();
      if (r.top <= y && r.bottom > y) cur = i;
    });
    spyLinks.forEach(function (a, i) {
      if (i === cur) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
    });
  }

  /* ---------- Video: scroll-linked scale + chapters ---------- */
  var vFrame = $('#video-frame'), video = $('#demo-video'), chapterBtns = $$('#chapters .chip');
  function scaleVideo() {
    if (!vFrame || reduce) return;
    var r = vFrame.getBoundingClientRect(), vh = window.innerHeight;
    var p = Math.min(1, Math.max(0, (vh - r.top) / (vh * 0.75)));
    vFrame.style.transform = 'scale(' + (0.88 + 0.12 * p).toFixed(4) + ')';
  }
  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return; ticking = true;
    requestAnimationFrame(function () { ticking = false; scaleVideo(); spy(); });
  }, { passive: true });
  scaleVideo(); spy();

  if (video) {
    chapterBtns.forEach(function (b) {
      b.addEventListener('click', function () {
        video.currentTime = parseFloat(b.getAttribute('data-t'));
        var pr = video.play(); if (pr && pr.catch) pr.catch(function () {});
      });
    });
    video.addEventListener('timeupdate', function () {
      var t = video.currentTime, idx = -1;
      chapterBtns.forEach(function (b, i) { if (t >= parseFloat(b.getAttribute('data-t'))) idx = i; });
      chapterBtns.forEach(function (b, i) { b.setAttribute('aria-pressed', String(i === idx)); });
    });
  }

  /* ---------- Hero orchestrated loop ---------- */
  var stage = $('#hero-stage');
  if (stage && !reduce) {
    var segs = $$('.hd-seg', stage), hFill = $('#hero-fill'), hHead = $('#hero-head'), hTime = $('#hero-time'), hBadge = $('#hero-badge');
    var total = 2472, base = 196;
    var timers = [];
    var later = function (fn, ms) { timers.push(setTimeout(fn, ms)); };
    function setT(t) {
      var pct = (t / total * 100).toFixed(2) + '%';
      hFill.style.width = pct; hHead.style.left = pct; hTime.textContent = fmt(t) + ' / 41:12';
    }
    function cycle() {
      stage.classList.remove('is-paused', 'is-pressed');
      segs.forEach(function (s) { s.classList.remove('on'); });
      hBadge.textContent = '▶ 播放中';
      var t = base;
      var iv = setInterval(function () { t += 1; setT(t); if (t >= 205) clearInterval(iv); }, 160);
      later(function () { stage.classList.add('is-paused'); hBadge.textContent = '‖ 已暂停'; }, 1700);
      later(function () { stage.classList.add('is-pressed'); }, 2700);
      later(function () { stage.classList.remove('is-pressed'); }, 2850);
      segs.forEach(function (s, i) { later(function () { s.classList.add('on'); }, 3100 + i * 700); });
      later(cycle, 9800);
    }
    var started = false;
    var ho = new IntersectionObserver(function (es) {
      if (es[0].isIntersecting && !started) { started = true; later(cycle, 900); }
    }, { threshold: 0.3 });
    ho.observe(stage);
  }

  /* ---------- Gap switch ---------- */
  var GAP = {
    sheng: { w: '省流', h: '不看也知道讲了什么', tools: 'AI 视频总结 · 笔记 · 思维导图', p: '帮你少看一点。可卡住的那一秒，摘要里不会有答案。' },
    juan: { w: '卷', h: '逼你多熬一点', tools: '打卡 · 排名 · 时长榜 · 倒计时', p: '帮你多熬一点。可熬得再久，没懂的地方还是没懂。' },
    hong: { w: '哄', h: '陪你把卡住的 30 秒看懂', tools: '在那一秒出现 · 懂前后文 · 讲得短 · 不评判', p: '这个位置还空着。讲完让你接着看，不把课讲浅，也不让你一个人硬扛。' }
  };
  var gapBtns = $$('[data-gap]'), gapWord = $('#gap-word'), gapBody = $('#gap-body');
  gapBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      var d = GAP[b.getAttribute('data-gap')];
      gapBtns.forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      gapWord.classList.add('out'); gapBody.classList.add('out');
      setTimeout(function () {
        gapWord.textContent = d.w;
        gapBody.innerHTML = '';
        var h = document.createElement('h3'); h.textContent = d.h;
        var t = document.createElement('p'); t.className = 'gap-tools'; t.textContent = d.tools;
        var p = document.createElement('p'); p.textContent = d.p;
        gapBody.appendChild(h); gapBody.appendChild(t); gapBody.appendChild(p);
        gapWord.classList.remove('out'); gapBody.classList.remove('out');
      }, reduce ? 0 : 180);
    });
  });

  /* ---------- Heatmap (illustrative data) ---------- */
  var heat = $('#heat'), readout = $('#heat-readout');
  if (heat) {
    var mins = 42, data = [];
    for (var i = 0; i < mins; i++) {
      // deterministic illustrative curve: peaks near 03, 12, 27 minutes
      var v = 0.08 + 0.85 * Math.exp(-Math.pow(i - 3, 2) / 3) + 0.95 * Math.exp(-Math.pow(i - 12, 2) / 4) + 0.6 * Math.exp(-Math.pow(i - 27, 2) / 5) + 0.12 * ((i * 7) % 5) / 5;
      data.push(Math.min(1, v));
    }
    var cells = data.map(function (v, i) {
      var b = document.createElement('button');
      b.type = 'button';
      var people = Math.round(v * 186);
      b.setAttribute('aria-label', '第 ' + (i + 1) + ' 分钟，' + people + ' 人卡住');
      b.addEventListener('click', function () {
        cells.forEach(function (c) { c.classList.remove('sel'); });
        b.classList.add('sel');
        var label = i === 41 ? '41:00–41:12' : fmt(i * 60) + '–' + fmt(i * 60 + 59);
        readout.textContent = label + ' · ' + people + ' 人在这里按了「我这里不懂」' + (v > 0.7 ? '，值得重讲一遍' : '');
      });
      heat.appendChild(b);
      return b;
    });
    var paint = function () { cells.forEach(function (c, i) { c.style.background = 'rgba(255,255,255,' + (0.06 + data[i] * 0.9).toFixed(2) + ')'; }); };
    if (reduce || !('IntersectionObserver' in window)) paint();
    else {
      var hob = new IntersectionObserver(function (es) {
        if (!es[0].isIntersecting) return; hob.disconnect();
        cells.forEach(function (c, i) { setTimeout(function () { c.style.background = 'rgba(255,255,255,' + (0.06 + data[i] * 0.9).toFixed(2) + ')'; }, i * 28); });
      }, { threshold: 0.4 });
      hob.observe(heat);
    }
  }

  /* ---------- Stuck-map nodes ---------- */
  $$('#nodes button').forEach(function (b) {
    b.addEventListener('click', function () {
      var open = b.getAttribute('aria-expanded') === 'true';
      b.setAttribute('aria-expanded', String(!open));
      document.getElementById(b.getAttribute('aria-controls')).hidden = open;
    });
  });

  /* ---------- Install steps ---------- */
  var STEPS = {
    win: [
      ['下载并解压源码', '点上面的「下载源码」，解压到任意文件夹。也可以 <code>git clone https://github.com/fengqiaoqu/coaxly</code>。'],
      ['填 API Key', '打开 <code>proxy/config.json</code>，把 <code>apiKey</code> 填上。默认是阿里云百炼（通义千问），也可以换 DeepSeek、智谱或 OpenAI。Key 只放在这里，扩展永远拿不到。'],
      ['启动本地代理', '双击 <code>启动.bat</code>。看到「本地代理已启动」和「API Key 已配置」就好，这个窗口要一直开着。'],
      ['装浏览器扩展', 'Chrome 打开 <code>chrome://extensions</code>，打开右上角「开发者模式」，点「加载已解压的扩展程序」，选 <code>extension</code> 文件夹。'],
      ['打开一节课，暂停', '打开 B 站课程视频，打开字幕，正常看一会儿。卡住时暂停，点「我这里不懂」或按 <kbd>1</kbd>。']
    ],
    mac: [
      ['下载并解压源码', '点上面的「下载源码」，解压到任意文件夹。也可以 <code>git clone https://github.com/fengqiaoqu/coaxly</code>。'],
      ['填 API Key', '打开 <code>proxy/config.json</code>，把 <code>apiKey</code> 填上。默认是阿里云百炼（通义千问），也可以换 DeepSeek、智谱或 OpenAI。'],
      ['启动本地代理', '双击 <code>启动.command</code>。看到代理已启动的提示后，这个窗口要一直开着。'],
      ['装浏览器扩展', 'Chrome：<code>chrome://extensions</code> 打开「开发者模式」，加载 <code>extension</code> 文件夹。Safari：扩展加上 <code>extension/compat.js</code> 兼容层，步骤见 README-macOS。'],
      ['打开一节课，暂停', '打开 B 站课程视频，打开字幕，正常看一会儿。卡住时暂停，点「我这里不懂」或按 <kbd>1</kbd>。']
    ]
  };
  var stepsEl = $('#steps'), osBtns = $$('[data-os]');
  function renderSteps(os) {
    stepsEl.innerHTML = STEPS[os].map(function (s) { return '<li><h3>' + s[0] + '</h3><p>' + s[1] + '</p></li>'; }).join('');
  }
  osBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      osBtns.forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      renderSteps(b.getAttribute('data-os'));
    });
  });
  if (stepsEl) renderSteps(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'mac' : 'win');
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) osBtns.forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-os') === 'mac')); });

  /* ---------- Interactive demo ---------- */
  var sim = $('#sim');
  if (!sim) return;
  var TOTAL = 2472; // 41:12
  var SCENES = [
    {
      kp: 205, from: 0, to: 466, chapter: '第 1 章「向量组的线性相关性」', near: '线性无关的定义',
      title: '第 3 讲 · 向量组的线性相关性', formula: 'k₁v₁ + k₂v₂ + k₃v₃ = 0', note: '只有零解 ⇔ 线性无关',
      subs: ['我们来看三个向量 v₁、v₂、v₃', '如果这个等式只有零解', '……任何一个，都不能由另外两个线性表示', '这时候我们就说，这组向量线性无关'],
      ex: [
        '一组向量里，谁都不能由其他几个「拼」出来，就叫线性无关。',
        '红、黄、蓝调不出彼此；加进橙色，就不行了，因为橙色能用红和黄调出来。',
        '如果里面有零向量，还线性无关吗？'
      ],
      answer: 'no',
      fb: {
        yes: '再想想：给零向量配系数 1，其余都配 0，系数不全为零，等式照样成立。所以含零向量的一组，一定线性相关。',
        no: '对。零向量前面放个 1，其他系数全取 0，就找到了一组非零解，所以一定线性相关。',
        unsure: '提示：只给零向量一个非零系数，其他都取 0，等式还成立吗？'
      },
      socratic: '先不看定义。假如三个向量里，有一个能用另外两个拼出来，你觉得它们还算「各自独立」吗？',
      sfb: { yes: '它能被别人拼出来，就不算独立了。线性无关说的正是：谁都拼不出谁。', no: '对。能被拼出来，就不独立。线性无关说的正是：谁都拼不出谁。', unsure: '换个说法：如果橙色能用红和黄调出来，橙色算不算一种「新」颜色？' },
      again: '换个角度：把等式里的系数想成「每个向量用几份」。只有全用 0 份才能凑出 0，说明谁也替代不了谁。',
      more: '定义是：k₁v₁ + k₂v₂ + k₃v₃ = 0 只有 k₁ = k₂ = k₃ = 0 这一组解。只要有一组不全为零的 k 能让等式成立，比如 k₁ ≠ 0，就能把 v₁ 移到一边，写成 v₂、v₃ 的组合，也就是被「拼」出来了。所以「只有零解」和「谁都拼不出谁」是同一件事的两种说法。',
      general: '不看这节课也一样：线性无关就是一组向量里没有「多余」的那个，去掉任何一个，能表示的范围都会变小。'
    },
    {
      kp: 728, from: 466, to: 1194, chapter: '第 2 章「矩阵的秩」', near: '行秩 = 列秩',
      title: '第 3 讲 · 矩阵的秩', formula: 'r(A) = 行秩 = 列秩', note: '秩 = 极大线性无关组里的向量个数',
      subs: ['把矩阵按行拆开，看有几行真正独立', '再按列拆开，看有几列真正独立', '……所以矩阵的行秩和列秩，其实永远相等', '这个共同的数，就叫矩阵的秩'],
      ex: [
        '秩就是这些行（或列）里，真正不重复的方向有几个。',
        '一份菜单写了十道菜，其实只有三种做法，换了换配料而已，秩就是 3。',
        '一个 3×5 的矩阵，秩可能等于 5 吗？'
      ],
      answer: 'no',
      fb: {
        yes: '不会。它只有 3 行，行秩最多是 3；行秩又等于列秩，所以秩最多是 3。',
        no: '对。秩不会超过行数和列数里较小的那个，这里最多是 3。',
        unsure: '提示：只有 3 行，行秩最多是几？它又等于列秩。'
      },
      socratic: '先只看行：一个 3 行的矩阵，最多能有几行「互相拼不出来」？',
      sfb: { yes: '我们换个问法：3 行里，独立的行最多能超过 3 行吗？显然不能。所以行秩不超过 3。', no: '对，最多 3 行。下一步想想：列秩为什么也被这个 3 管住？', unsure: '提示：独立的行，总数不可能比行数还多。' },
      again: '把每一行当成一条「信息」。有的行只是别的行加加减减得来的，不算新信息。秩就是新信息的条数。',
      more: '做初等行变换不会改变行与行之间的线性关系，最后化成阶梯形，非零行的条数就是行秩。阶梯形里每个非零行都有一个主元，主元所在的列恰好是一组极大线性无关的列，所以列秩也是这个数。行秩等于列秩，就是这么来的。',
      general: '不看这节课也一样：秩衡量一个矩阵「真正有几维的信息」，和它写出来有多少行多少列无关。'
    },
    {
      kp: 1660, from: 1194, to: TOTAL, chapter: '第 3 章「基与坐标」', near: '基与坐标',
      title: '第 3 讲 · 基与坐标', formula: 'β = x₁α₁ + x₂α₂ + x₃α₃', note: '(x₁, x₂, x₃) 就是 β 在这组基下的坐标',
      subs: ['取一组基 α₁、α₂、α₃', '空间里任何一个向量 β，都能写成它们的组合', '组合的系数，就是 β 的坐标', '……基一换，同一个向量的坐标也跟着变'],
      ex: [
        '基是一组最少的「零件」，空间里每个向量都能用它们唯一地拼出来，拼法就是坐标。',
        '同一个地点，可以说「东 3 北 4」，也可以说「沿大路走 5」。参照变了，说法变了，地点没变。',
        '换一组基，向量本身会变吗？'
      ],
      answer: 'no',
      fb: {
        yes: '不会。变的只是「怎么描述它」，也就是坐标；向量本身还是那个向量。',
        no: '对。换基只换坐标，向量还是那个向量。',
        unsure: '提示：地点换一种说法，地点本身挪了吗？'
      },
      socratic: '如果一组「零件」里有一个能被别的零件拼出来，它还算「最少」吗？',
      sfb: { yes: '它能被拼出来，就是多余的，去掉它照样能拼出所有向量。所以基里不能有这样的零件。', no: '对。所以基首先要线性无关，其次要能拼出整个空间。', unsure: '提示：去掉那个能被拼出来的零件，还能拼出所有向量吗？' },
      again: '基像一把尺子的刻度方向。选定方向以后，每个向量沿各方向走几步，就是它的坐标。',
      more: '基要同时满足两条：线性无关（没有多余的零件），并且能表示空间里所有向量（零件够用）。满足这两条，任何向量的表示方式就唯一，这组系数叫坐标。换一组基，坐标按过渡矩阵变换，但向量本身不变。',
      general: '不看这节课也一样：基就是一套「坐标系」，选不同的坐标系，同一个东西的数字描述不同。'
    }
  ];
  var LABELS = ['说人话', '打个比方', '问你一句'];

  var el = {
    title: $('#sim-btitle'), formula: $('#sim-formula'), note: $('#sim-note'), sub: $('#sim-sub'),
    badge: $('#sim-badge'), ask: $('#sim-ask'), askBtn: $('#sim-askbtn'), near: $('#sim-near'),
    play: $('#sim-play'), icoPlay: $('#ico-play'), icoPause: $('#ico-pause'),
    track: $('#sim-track'), fill: $('#sim-fill'), head: $('#sim-head'), time: $('#sim-time'), toast: $('#sim-toast'),
    drTime: $('#dr-time'), body: $('#dr-body'), meta: $('#dr-meta'), follow: $('#dr-follow'), resume: $('#dr-resume'), hist: $('#dr-hist')
  };
  var state = { t: 205, playing: false, mode: 'direct', scene: null, histCount: 0, open: false };
  var tick = null, typingToken = 0;

  // keypoint diamonds
  SCENES.forEach(function (s) {
    var k = document.createElement('button');
    k.type = 'button'; k.className = 'kp';
    k.style.left = (s.kp / TOTAL * 100) + '%';
    k.setAttribute('aria-label', '课程重点 ' + fmt(s.kp) + '：' + s.near);
    k.addEventListener('click', function (e) { e.stopPropagation(); seek(s.kp - 2); setPlaying(true); });
    el.track.insertBefore(k, el.head);
  });

  function sceneAt(t) { for (var i = 0; i < SCENES.length; i++) if (t < SCENES[i].to) return SCENES[i]; return SCENES[SCENES.length - 1]; }
  function render() {
    var s = sceneAt(state.t);
    if (s !== state.scene) {
      state.scene = s;
      el.title.textContent = s.title; el.formula.textContent = s.formula; el.note.textContent = s.note;
    }
    var idx = Math.floor(Math.max(0, state.t - (s.kp - 14)) / 6);
    el.sub.textContent = s.subs[Math.min(s.subs.length - 1, Math.max(0, idx))];
    var pct = (state.t / TOTAL * 100) + '%';
    el.fill.style.width = pct; el.head.style.left = pct;
    el.time.textContent = fmt(state.t) + ' / 41:12';
    var near = nearKp(state.t);
    el.near.textContent = near ? '附近重点：' + near.near : '暂停在 ' + fmt(state.t);
  }
  function nearKp(t) {
    for (var i = 0; i < SCENES.length; i++) { var d = SCENES[i].kp - t; if (d <= 45 && d >= -15) return SCENES[i]; }
    return null;
  }
  function seek(t) { state.t = Math.max(0, Math.min(TOTAL - 1, t)); render(); }
  function setPlaying(p) {
    state.playing = p;
    el.icoPlay.hidden = p; el.icoPause.hidden = !p;
    el.play.setAttribute('aria-label', p ? '暂停' : '播放');
    el.badge.textContent = p ? '▶ 播放中' : '‖ 已暂停';
    el.ask.hidden = p;
    clearInterval(tick);
    if (p) {
      if (state.open) closeDrawer(false);
      tick = setInterval(function () { if (state.t >= TOTAL - 1) { setPlaying(false); return; } seek(state.t + 1); }, 500);
    }
  }
  function toast(msg) {
    el.toast.textContent = msg; el.toast.classList.add('on');
    clearTimeout(toast._t); toast._t = setTimeout(function () { el.toast.classList.remove('on'); }, 2200);
  }

  // track scrubbing
  function trackSeek(clientX) {
    var r = el.track.getBoundingClientRect();
    seek(Math.round((clientX - r.left) / r.width * TOTAL));
  }
  var dragging = false;
  el.track.addEventListener('pointerdown', function (e) { if (e.target.classList.contains('kp')) return; dragging = true; el.track.setPointerCapture(e.pointerId); trackSeek(e.clientX); });
  el.track.addEventListener('pointermove', function (e) { if (dragging) trackSeek(e.clientX); });
  el.track.addEventListener('pointerup', function () { dragging = false; });
  el.track.addEventListener('pointercancel', function () { dragging = false; });

  el.play.addEventListener('click', function (e) { e.stopPropagation(); setPlaying(!state.playing); });
  el.askBtn.addEventListener('click', function (e) { e.stopPropagation(); ask(); });
  sim.addEventListener('click', function (e) {
    if (e.target.closest('.pbar') || e.target.closest('.ask-layer button')) return;
    setPlaying(!state.playing);
  });
  sim.addEventListener('keydown', function (e) {
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); setPlaying(!state.playing); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.target.matches && e.target.matches('input, textarea')) return;
    var r = sim.getBoundingClientRect();
    var visible = r.bottom > 0 && r.top < window.innerHeight;
    if (!visible) return;
    if (e.key === '1' && !state.playing) { e.preventDefault(); ask(); }
    if (e.key === 'Escape' && state.open) closeDrawer(true);
  });

  // mode toggle
  $$('.seg-toggle button').forEach(function (b) {
    b.addEventListener('click', function () {
      state.mode = b.getAttribute('data-mode');
      $$('.seg-toggle button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      if (state.open) ask(true);
    });
  });

  function typeInto(node, text, speed) {
    var token = typingToken;
    return new Promise(function (resolve) {
      if (reduce) { node.textContent = text; resolve(); return; }
      var i = 0; node.classList.add('caret');
      (function next() {
        if (token !== typingToken) { node.classList.remove('caret'); return; }
        i += 1; node.textContent = text.slice(0, i);
        if (i < text.length) setTimeout(next, speed || 26);
        else { node.classList.remove('caret'); resolve(); }
      })();
    });
  }

  function answerChips(container, fbNode, fbMap, right) {
    var chips = document.createElement('div'); chips.className = 'chips'; chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', '回答');
    [['yes', '是'], ['no', '不是'], ['unsure', '不确定']].forEach(function (pair) {
      var c = document.createElement('button'); c.type = 'button'; c.className = 'chip'; c.textContent = pair[1];
      c.setAttribute('aria-pressed', 'false');
      c.addEventListener('click', function () {
        $$('.chip', chips).forEach(function (x) { x.setAttribute('aria-pressed', String(x === c)); });
        typingToken++;
        typeInto(fbNode, fbMap[pair[0]], 18);
        if (pair[0] === right) toast('答对了，这个卡点标为「已懂」');
      });
      chips.appendChild(c);
    });
    container.appendChild(chips);
  }

  function ask(keepCount) {
    if (state.playing) setPlaying(false);
    var s = sceneAt(state.t);
    var at = fmt(state.t);
    state.open = true;
    el.ask.hidden = true;
    if (!keepCount) { state.histCount += 1; el.hist.textContent = '历史 ' + state.histCount; }
    typingToken++;
    el.drTime.textContent = '· ' + at;
    el.body.innerHTML = '';
    el.meta.hidden = false; el.follow.hidden = false;
    var list = document.createElement('div'); list.className = 'ex-list';
    el.body.appendChild(list);
    var t0 = performance.now();
    var token = typingToken;

    if (state.mode === 'socratic') {
      var seg = document.createElement('div'); seg.className = 'ex-seg';
      seg.innerHTML = '<span class="ex-n">?</span><h4>带我想 · 一次只问一个小问题</h4><p></p><p class="ex-feedback"></p>';
      list.appendChild(seg);
      el.meta.textContent = '带我想 · 不直接给答案 · 整片记忆 · ' + s.chapter;
      typeInto($('p', seg), s.socratic).then(function () {
        if (token !== typingToken) return;
        answerChips(seg, $('.ex-feedback', seg), s.sfb, 'no');
        seg.appendChild($('.ex-feedback', seg));
      });
      return;
    }

    var nodes = s.ex.map(function (txt, i) {
      var seg = document.createElement('div'); seg.className = 'ex-seg';
      seg.innerHTML = '<span class="ex-n">0' + (i + 1) + '</span><h4>' + LABELS[i] + '</h4><p></p>' + (i === 2 ? '<p class="ex-feedback"></p>' : '');
      list.appendChild(seg);
      return seg;
    });
    var chars = s.ex.reduce(function (n, x) { return n + charCount(x); }, 0);
    el.meta.innerHTML = '<span class="ok">正在讲解…</span>';
    var firstMs = Math.round(320 + Math.random() * 380);
    var chain = new Promise(function (r) { setTimeout(r, reduce ? 0 : firstMs); });
    nodes.forEach(function (seg, i) {
      chain = chain.then(function () { if (token === typingToken) return typeInto($('p', seg), s.ex[i]); });
    });
    chain.then(function () {
      if (token !== typingToken) return;
      var last = nodes[2];
      answerChips(last, $('.ex-feedback', last), s.fb, s.answer);
      last.appendChild($('.ex-feedback', last));
      var secs = ((performance.now() - t0) / 1000).toFixed(1);
      el.meta.innerHTML = '<span class="ok">' + chars + ' 字 · 3 段</span> · 整片记忆 · ' + s.chapter + ' · 首字 ' + (firstMs / 1000).toFixed(1) + ' 秒';
    });
  }

  function followup(kind) {
    var s = sceneAt(state.t);
    if (kind === 'got') {
      toast('已懂。看完就关，回到视频');
      setTimeout(function () { closeDrawer(true); setPlaying(true); }, reduce ? 0 : 900);
      return;
    }
    var map = { again: ['还是不懂', s.again], more: ['展开讲讲 · 放宽到 200 字', s.more], general: ['不管视频，直接讲', s.general] };
    var item = map[kind];
    typingToken++;
    var list = $('.ex-list', el.body);
    if (!list) return;
    var seg = document.createElement('div'); seg.className = 'ex-seg';
    seg.innerHTML = '<span class="ex-n">›</span><h4></h4><p></p>';
    $('h4', seg).textContent = '追问 · ' + item[0];
    list.appendChild(seg);
    typeInto($('p', seg), item[1], 18);
  }
  $$('[data-fu]').forEach(function (b) { b.addEventListener('click', function () { followup(b.getAttribute('data-fu')); }); });
  el.resume.addEventListener('click', function () { closeDrawer(true); setPlaying(true); });

  function closeDrawer(resetUI) {
    typingToken++;
    state.open = false;
    el.ask.hidden = state.playing;
    if (resetUI) {
      el.drTime.textContent = '';
      el.body.innerHTML = '<p class="drawer-empty">这次求助已记进<strong>学习历史</strong>（' + state.histCount + ' 个节点）。再暂停一次，或者点进度条上的菱形，跳到下一个课程重点。</p>';
      el.meta.hidden = true; el.follow.hidden = true;
    }
  }

  render();
})();
