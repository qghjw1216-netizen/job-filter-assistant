// ISOLATED world collector：接收 sniffer 的 postMessage，转发给 background；
// 追踪当前页面平台；提供 DOM 兜底抓取（当接口嗅探未命中时）；
// 页面内显示一个极简的收录状态角标。
(function () {
  const CHANNEL = 'job-helper:sniffer';
  const MSG = {
    JOBS_CAPTURED: 'JOBS_CAPTURED',
    PAGE_CONTEXT_CHANGED: 'PAGE_CONTEXT_CHANGED',
    SEND_GREETING: 'SEND_GREETING',
    CURRENT_JOB: 'CURRENT_JOB',
  };

  // 判断嗅探到的 URL 是「列表」还是「岗位详情/卡片」
  function apiKind(urlStr) {
    let path = '';
    try {
      path = new URL(urlStr, location.href).pathname;
    } catch {
      return 'list';
    }
    if (/\/wapi\/zpgeek\/(job\/detail(?:\/[a-z]+)?|job\/card|geek\/job\/detail)\.json/.test(path)) return 'detail';
    if (/\/api\/job\/detail/.test(path)) return 'detail';
    return 'list';
  }

  // 从详情请求里取出岗位标识（BOSS: encryptJobId；51job: jobid）
  function jobKeyFromDetail(url, payload) {
    // 1) 优先请求 URL 上的查询参数
    try {
      const q = new URL(url, location.href).searchParams;
      const fromQuery = q.get('encryptJobId') || q.get('jobId') || q.get('jobid');
      if (fromQuery) return fromQuery;
    } catch {}
    // 2) 回退：从响应体里挖（字段名依平台而异，尽量宽松）
    try {
      const zp = payload && (payload.zpData || payload.resultbody || payload.resultBody);
      const info = zp && (zp.jobInfo || (zp.job && zp.job.item) || zp);
      if (info) {
        const k = info.encryptId || info.encryptJobId || info.jobId || info.jobid;
        if (k) return String(k);
      }
    } catch {}
    return null;
  }

  function platformOfHost(host) {
    if (/(^|\.)zhipin\.com$/i.test(host)) return 'boss';
    if (/(^|\.)51job\.com$/i.test(host)) return 'qcwy';
    return null;
  }
  const PLATFORM = platformOfHost(location.hostname);

  function send(type, extra) {
    try {
      chrome.runtime.sendMessage({ type, ...extra }).catch(() => {});
    } catch {}
  }

  let captured = 0;

  // —— 接收 sniffer 转发 ——
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.source !== CHANNEL) return;
    if (apiKind(d.url) === 'detail') {
      // 点开某个岗位：上报「当前岗位」，让面板实时切换
      const jobKey = jobKeyFromDetail(d.url, d.payload);
      if (jobKey) send(MSG.CURRENT_JOB, { platform: d.platform, jobKey });
      // 详情响应同样丢给归一化：命中列表结构则收录，否则被安全忽略
      send(MSG.JOBS_CAPTURED, { platform: d.platform, url: d.url, payload: d.payload });
      return;
    }
    if (d.platform === 'boss') recordBossOnline(d.payload); // 记录每个岗位的 HR 在线状态
    send(MSG.JOBS_CAPTURED, { platform: d.platform, url: d.url, payload: d.payload });
    captured++;
    flashBadge();
    scheduleReapplyFresh(); // 新一批卡片渲染后，若排序开着则重排
  });

  // —— 识别当前详情页岗位标识 & 是否聊天页 ——
  function detectJobKey() {
    const u = location.href;
    if (PLATFORM === 'boss') {
      // 详情页：/job_detail/<encryptId>.html；地理列表页详情抽屉不改 URL，识别不到属正常
      const m = u.match(/job_detail\/([\w-]+)\.html/) || u.match(/[?&]jobId=([\w-]+)/);
      return m ? m[1] : null;
    }
    if (PLATFORM === 'qcwy') {
      const m = u.match(/\/job\/(\d+)/) || u.match(/jobs\.51job\.com\/[^/]*\/(\d+)\.html/) || u.match(/[?&]jobid=(\d+)/i);
      return m ? m[1] : null;
    }
    return null;
  }
  // 是否处于沟通/聊天页（用于 UI 提示「可直接发送」）
  function detectChat() {
    const u = location.href.toLowerCase();
    if (PLATFORM === 'boss') return /\/chat|\/geek\/chat|zhipin\.com\/web\/geek\/chat/.test(u) || !!document.querySelector('.chat-input, .conversation-message, #chat-input');
    if (PLATFORM === 'qcwy') return /\/im|message|chat/.test(u) || !!document.querySelector('.im-input, .message-input, [class*="chat-input"]');
    return false;
  }

  // —— 上报页面上下文 ——
  function reportContext() {
    send(MSG.PAGE_CONTEXT_CHANGED, {
      platform: PLATFORM,
      url: location.href,
      jobKey: detectJobKey(),
      isChat: detectChat(),
    });
  }
  reportContext();
  // SPA 路由变化监听
  let lastUrl = location.href;
  const obs = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      reportContext();
    }
  });
  try {
    obs.observe(document, { subtree: true, childList: true });
  } catch {}

  // —— 极简状态角标（Apple 风：胶囊、毛玻璃） ——
  let badgeEl = null;
  let badgeTimer = null;
  function ensureBadge() {
    if (badgeEl) return badgeEl;
    badgeEl = document.createElement('div');
    badgeEl.className = 'jobhelper-capture-badge';
    badgeEl.innerHTML = '<span class="jh-dot"></span><span class="jh-text">已收录 0</span>';
    badgeEl.addEventListener('click', () => {
      send('OPEN_SIDEPANEL', {});
    });
    (document.body || document.documentElement).appendChild(badgeEl);
    return badgeEl;
  }
  function flashBadge() {
    const el = ensureBadge();
    el.querySelector('.jh-text').textContent = `已收录 ${captured} 次`;
    el.classList.add('jh-active');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => el.classList.remove('jh-active'), 1600);
  }

  // —— DOM 兜底：当接口嗅探长时间未命中时，从可见卡片粗略抓取 ——
  // 仅作为兜底，字段不如接口完整。默认延迟启动，命中过接口则不启用。
  function domFallback() {
    if (captured > 0 || !PLATFORM) return;
    const jobs = PLATFORM === 'boss' ? scrapeBoss() : scrapeQcwy();
    if (jobs.length) {
      // 包装成接口信封形状，复用 background 的归一化
      const payload = PLATFORM === 'boss'
        ? { code: 0, zpData: { jobList: jobs } }
        : { status: '1', resultbody: { job: { items: jobs } } };
      send(MSG.JOBS_CAPTURED, { platform: PLATFORM, url: location.href + '#dom', payload });
      captured++;
      flashBadge();
    }
  }

  function txt(el, sel) {
    const n = el.querySelector(sel);
    return n ? n.textContent.trim() : '';
  }

  function scrapeBoss() {
    const cards = document.querySelectorAll('.job-card-wrap, .job-card-wrapper, li.job-card-box');
    const out = [];
    cards.forEach((c) => {
      const jobName = txt(c, '.job-name') || txt(c, '.job-title');
      if (!jobName) return;
      out.push({
        jobId: c.getAttribute('data-jobid') || jobName,
        encryptJobId: '',
        jobName,
        salaryDesc: txt(c, '.salary') || txt(c, '.job-salary'),
        cityName: txt(c, '.job-area') || txt(c, '.company-location'),
        areaDistrict: '',
        jobExperience: '',
        jobDegree: '',
        skills: Array.from(c.querySelectorAll('.tag-list li, .job-card-footer .tag-list li')).map((x) => x.textContent.trim()),
        jobLabels: [],
        welfareList: [],
        brandName: txt(c, '.company-name') || txt(c, '.boss-name'),
        brandIndustry: txt(c, '.company-tag-list li'),
        brandScaleName: '',
        brandStageName: '',
      });
    });
    return out;
  }

  function scrapeQcwy() {
    const cards = document.querySelectorAll('.joblist-item, .j_joblist .e, [class*="joblist-item"]');
    const out = [];
    cards.forEach((c) => {
      const jobName = txt(c, '.jname') || txt(c, '.job-title') || txt(c, 'a[title]');
      if (!jobName) return;
      out.push({
        jobId: c.getAttribute('data-jobid') || jobName,
        jobName,
        provideSalaryString: txt(c, '.sal') || txt(c, '.salary'),
        jobAreaString: txt(c, '.d.at') || txt(c, '.area'),
        workYearString: '',
        degreeString: '',
        jobTags: Array.from(c.querySelectorAll('.tags .tag, .job-tags span')).map((x) => x.textContent.trim()),
        fullCompanyName: txt(c, '.cname') || txt(c, '.company-name'),
        companyName: txt(c, '.cname'),
        coIndustryText: txt(c, '.dc.at'),
        companySizeString: '',
        companyTypeString: '',
        jobDescribe: '',
        jobHref: (c.querySelector('a[href]') || {}).href || '',
      });
    });
    return out;
  }

  if (PLATFORM) {
    setTimeout(domFallback, 6000); // 给接口嗅探留出时间，再兜底
  }

  // ============================================================
  //  一键发送招呼语：DOM 自动化（等价于用户手动在聊天框打字并点发送）
  //  安全：仅在识别到聊天输入框时才填入；找不到就报错，绝不误填到搜索框。
  // ============================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== MSG.SEND_GREETING) return false;
    (async () => {
      try {
        const r = await fillAndSend(String(msg.text || ''));
        sendResponse(r);
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true; // 异步响应
  });

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 12) return false;
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  // 定位聊天输入框：优先各平台已知选择器，再退化到「可见的大号可编辑元素」启发式
  function findChatInput() {
    const known = PLATFORM === 'boss'
      ? ['#chat-input', '.chat-input', '.conversation-editor [contenteditable]', '.chat-editor [contenteditable]', 'textarea.input-area']
      : ['.im-input textarea', '.message-input textarea', '[class*="chat-input"] textarea', '.im-editor [contenteditable]', 'textarea[placeholder*="消息"]', 'textarea[placeholder*="聊"]'];
    for (const sel of known) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    // 启发式兜底：页面里可见、可编辑、位于视口下半部、面积较大的编辑区
    const cands = Array.from(document.querySelectorAll('textarea, [contenteditable=""], [contenteditable="true"]'))
      .filter(isVisible)
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top > window.innerHeight * 0.4 && r.width > 120;
      });
    if (!cands.length) return null;
    // 取最靠下、最宽的一个（聊天框通常在底部且横向铺满）
    cands.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.top - ra.top) || (rb.width - ra.width);
    });
    return cands[0];
  }

  // 找发送按钮（在输入框附近优先）
  function findSendButton(input) {
    const byText = (root) =>
      Array.from(root.querySelectorAll('button, a, [role="button"], .btn-send, .send-message, .btn-v2'))
        .filter(isVisible)
        .find((b) => /发\s*送|send/i.test((b.textContent || b.getAttribute('title') || '')));
    // 先在输入框的容器里找
    let scope = input;
    for (let i = 0; i < 4 && scope && scope.parentElement; i++) scope = scope.parentElement;
    return (scope && byText(scope)) || byText(document) || null;
  }

  // 找「开始/继续沟通」按钮：岗位详情页上点它才会弹出聊天窗口
  function findStartChatButton() {
    const re = PLATFORM === 'boss'
      ? /立即沟通|继续沟通|马上沟通|开始聊天/
      : /立即沟通|继续沟通|在线沟通|聊一聊|投递并沟通/;
    const nodes = Array.from(document.querySelectorAll('a, button, [role="button"], .btn, .op-btn, .btn-startchat, .start-chat'));
    return nodes
      .filter(isVisible)
      .find((b) => {
        const t = (b.textContent || '').trim();
        return t.length <= 12 && re.test(t); // 限长，避免命中含该词的大容器
      }) || null;
  }

  // 确保聊天输入框可用：已在就直接返回；否则点「立即沟通」并轮询等待其出现
  async function ensureChatInput(maxWaitMs = 4000) {
    let input = findChatInput();
    if (input) return input;
    const start = findStartChatButton();
    if (!start) return null; // 既没输入框也没沟通按钮：这不是可发送的页面
    start.click();
    const t0 = Date.now();
    while (Date.now() - t0 < maxWaitMs) {
      await new Promise((r) => setTimeout(r, 250));
      input = findChatInput();
      if (input) return input;
    }
    return null;
  }

  // 写入值：textarea/input 与 contenteditable 分别处理，并派发框架能感知的事件
  function setInputValue(el, text) {
    el.focus();
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea' || tag === 'input') {
      const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
      if (setter) setter.call(el, text); else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      // contenteditable
      el.textContent = '';
      const ok = document.execCommand && document.execCommand('insertText', false, text);
      if (!ok) el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
  }

  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }

  async function fillAndSend(text) {
    const content = text.trim();
    if (!content) return { ok: false, error: '招呼语为空' };
    // 聊天框不在就先自动点「立即沟通」把窗口开出来
    const input = await ensureChatInput();
    if (!input) {
      return { ok: false, error: '未找到聊天入口。请在岗位详情页或聊天列表页再试（需能看到「立即沟通」或聊天输入框）。' };
    }
    setInputValue(input, content);
    await new Promise((r) => setTimeout(r, 250)); // 等站点组件同步内部状态，避免发送按钮仍为禁用态

    const btn = findSendButton(input);
    if (btn && !btn.disabled) {
      btn.click();
    } else {
      pressEnter(input); // 多数聊天框回车即发送
    }
    // 校验：输入框是否已清空（发送成功的常见信号）
    await new Promise((r) => setTimeout(r, 300));
    const leftover = (input.value != null ? input.value : input.textContent || '').trim();
    if (leftover && leftover === content) {
      // 未清空：可能需要用户手动确认。已填入，交回用户点发送。
      return { ok: true, mode: 'filled', note: '已填入聊天框，请在页面上确认并发送' };
    }
    return { ok: true, mode: 'sent' };
  }

  // ============================================================
  //  BOSS「HR 活跃优先」排序按钮（仅 BOSS）
  //  背景：BOSS 列表/详情接口都不返回岗位发布时间（已真机核实），
  //  故无法做真正的「按发布时间」排序。此按钮用 HR 在线状态(bossOnline)
  //  作为「岗位还新鲜/在招」的近似信号，把 HR 在线的岗位排到最前。
  //  纯前端重排已渲染的卡片，不发额外请求、不改数据。
  // ============================================================
  const bossOnlineMap = new Map(); // encryptJobId -> bossOnline(bool)
  let freshOn = false; // 排序开关
  let reapplyTimer = null;
  const originalIndex = new WeakMap(); // 卡片元素 -> 初始 DOM 次序，用于关闭时还原

  function recordBossOnline(payload) {
    try {
      const zp = payload && payload.zpData;
      const list = zp && (zp.jobList || zp.recommendJobList);
      if (!Array.isArray(list)) return;
      for (const j of list) {
        const id = j && (j.encryptJobId || j.jobId);
        if (id) bossOnlineMap.set(String(id), !!j.bossOnline);
      }
    } catch {}
  }

  function scheduleReapplyFresh() {
    if (PLATFORM !== 'boss') return;
    clearTimeout(reapplyTimer);
    reapplyTimer = setTimeout(() => {
      ensureFreshButton();
      if (freshOn) applyFreshSort();
    }, 300);
  }

  // 找装所有岗位卡片的列表容器（推荐页 ul.rec-job-list；搜索页兜底）
  function findJobListContainer() {
    const known = document.querySelector('ul.rec-job-list, .job-list-box, .search-job-result ul, .job-list-container ul');
    if (known) return known;
    // 兜底：含最多卡片的公共父
    const cards = document.querySelectorAll('.job-card-wrap, li.job-card-box, .job-card-wrapper');
    if (!cards.length) return null;
    const count = new Map();
    cards.forEach((c) => {
      const p = c.closest('li') ? c.closest('li').parentElement : c.parentElement && c.parentElement.parentElement;
      if (p) count.set(p, (count.get(p) || 0) + 1);
    });
    let best = null, n = 0;
    count.forEach((v, k) => { if (v > n) { n = v; best = k; } });
    return best;
  }

  // 列表容器里，每个「岗位行」= 容器的直接子元素
  function getJobRows(container) {
    if (!container) return [];
    return Array.from(container.children).filter((row) => row.querySelector('.job-card-wrap, .job-card-box, a[href*="job_detail"]'));
  }

  function rowEncryptId(row) {
    const a = row.querySelector('a[href*="job_detail"]');
    if (!a) return null;
    const m = a.getAttribute('href').match(/job_detail\/([\w-]+)\.html/);
    return m ? m[1] : null;
  }
  // 该行 HR 是否在线：先查接口捕获，再退化到 DOM 上的在线标记
  function rowOnline(row) {
    const id = rowEncryptId(row);
    if (id && bossOnlineMap.has(id)) return bossOnlineMap.get(id);
    return !!row.querySelector('.online-tag, [class*="online"]');
  }

  function applyFreshSort() {
    const container = findJobListContainer();
    if (!container) return;
    const rows = getJobRows(container);
    if (rows.length < 2) return;
    // 记录初始次序（仅首次）
    rows.forEach((row, i) => { if (!originalIndex.has(row)) originalIndex.set(row, i); });
    // 稳定排序：在线优先，组内保持原次序
    const sorted = rows.slice().sort((a, b) => {
      const oa = rowOnline(a) ? 0 : 1;
      const ob = rowOnline(b) ? 0 : 1;
      if (oa !== ob) return oa - ob;
      return (originalIndex.get(a) || 0) - (originalIndex.get(b) || 0);
    });
    // 只有次序变化时才动 DOM，避免闪烁
    let changed = false;
    for (let i = 0; i < sorted.length; i++) if (rows[i] !== sorted[i]) { changed = true; break; }
    if (changed) sorted.forEach((row) => container.appendChild(row));
    markFreshRows(rows);
  }

  function restoreOrder() {
    const container = findJobListContainer();
    if (!container) return;
    const rows = getJobRows(container);
    rows.sort((a, b) => (originalIndex.get(a) || 0) - (originalIndex.get(b) || 0));
    rows.forEach((row) => container.appendChild(row));
    rows.forEach((row) => row.classList.remove('jh-fresh-row'));
  }

  // 给在线岗位行加一个小标记，便于一眼识别
  function markFreshRows(rows) {
    rows.forEach((row) => {
      if (rowOnline(row)) row.classList.add('jh-fresh-row');
      else row.classList.remove('jh-fresh-row');
    });
  }

  // —— 注入按钮 ——
  let freshBtn = null;
  function ensureFreshButton() {
    if (PLATFORM !== 'boss') return;
    if (freshBtn && document.contains(freshBtn)) return;
    const anchor = findFilterBarAnchor();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jh-fresh-btn' + (freshOn ? ' jh-on' : '');
    btn.innerHTML = '<span class="jh-fresh-dot"></span><span class="jh-fresh-label">HR 活跃优先</span>';
    btn.title = 'BOSS 未提供岗位发布时间，此排序按 HR 在线/活跃度把更可能在招的岗位排到前面';
    btn.addEventListener('click', () => {
      freshOn = !freshOn;
      btn.classList.toggle('jh-on', freshOn);
      if (freshOn) applyFreshSort();
      else restoreOrder();
    });
    freshBtn = btn;
    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(btn, anchor); // 放在筛选栏「清空」等锚点前
      btn.classList.remove('jh-floating');
    } else {
      btn.classList.add('jh-floating'); // 兜底：浮动在列表右上
      (document.body || document.documentElement).appendChild(btn);
    }
  }

  // 定位筛选栏锚点：返回一个「插入基准元素」，按钮插到它前面。
  // 依 2026-09 真机 DOM：筛选栏 = .c-filter-condition.filter-condition-inner，
  // 末端是 a.clear-search-btn(「清空」)——插在它前面正好落在筛选项右侧。
  function findFilterBarAnchor() {
    const clear = document.querySelector('.clear-search-btn');
    if (clear && isVisible(clear)) return clear;
    const inner = document.querySelector('.c-filter-condition.filter-condition-inner, .filter-condition-inner, .c-filter-condition');
    if (inner && isVisible(inner)) {
      // 没有清空按钮时，追加到筛选栏末尾（用一个占位末元素作基准）
      return inner.lastElementChild || inner;
    }
    // 退化：找一个含多个筛选项文字的容器，返回其最后一个子节点作锚
    const kw = ['薪资待遇', '工作经验', '学历要求', '公司行业', '公司规模'];
    let best = null, score = 0;
    document.querySelectorAll('div,ul,section').forEach((d) => {
      if (d.children.length < 3 || d.children.length > 16) return;
      const t = d.textContent || '';
      if (t.length > 600) return;
      const s = kw.filter((k) => t.indexOf(k) >= 0).length;
      if (s > score) { score = s; best = d; }
    });
    return best && score >= 3 ? best.lastElementChild : null;
  }

  function injectFreshStyles() {
    if (document.getElementById('jh-fresh-style')) return;
    const css = `
      .jh-fresh-btn{display:inline-flex;align-items:center;gap:6px;margin:0 8px;padding:5px 12px;
        font-size:13px;font-weight:500;color:#00a6a7;background:rgba(0,166,167,0.10);
        border:1px solid rgba(0,166,167,0.35);border-radius:16px;cursor:pointer;line-height:1.2;
        font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;transition:all .18s;vertical-align:middle;}
      .jh-fresh-btn:hover{background:rgba(0,166,167,0.16);}
      .jh-fresh-btn.jh-on{color:#fff;background:#00a6a7;border-color:#00a6a7;}
      .jh-fresh-dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.85;}
      .jh-fresh-btn.jh-floating{position:fixed;top:120px;right:20px;z-index:99998;
        box-shadow:0 4px 16px rgba(0,0,0,.12);background:#fff;}
      .jh-fresh-btn.jh-floating.jh-on{background:#00a6a7;color:#fff;}
      .jh-fresh-row{position:relative;}
      .jh-fresh-row::after{content:"HR活跃";position:absolute;top:8px;right:8px;z-index:2;
        font-size:11px;font-weight:600;color:#00a6a7;background:rgba(0,166,167,0.12);
        padding:1px 7px;border-radius:8px;pointer-events:none;}
    `;
    const style = document.createElement('style');
    style.id = 'jh-fresh-style';
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  if (PLATFORM === 'boss') {
    injectFreshStyles();
    // 首屏与后续渲染都尝试注入按钮
    const kick = () => { ensureFreshButton(); if (freshOn) applyFreshSort(); };
    setTimeout(kick, 1200);
    setTimeout(kick, 3000);
    // 列表/筛选栏因 SPA 重渲染时，补注入 + 重排
    try {
      new MutationObserver(() => scheduleReapplyFresh()).observe(document.body || document.documentElement, {
        subtree: true, childList: true,
      });
    } catch {}
  }
})();
