import { MSG, MODE } from '../common/constants.js';
import { scoreProfile } from '../common/profile.js';
import { applyFilters } from '../common/filters.js';
import { VERDICT_LABELS, GREETING_LEVELS, normalizeGreetings } from '../common/ai/prompts.js';
import { send, h, toast, esc, debounce } from './ui-common.js';

const app = document.getElementById('app');

let jobs = [];
let settings = null;
let profile = null;
let providers = [];
let activeCtx = null; // 当前激活标签页上下文：{platform, jobKey, isChat}
const expanded = new Set(); // 展开分析详情的 uid（岗位库内联）
const scoring = new Set(); // 正在打分的 uid

// 视图状态
const view = {
  tab: 'library', // library | current
  sub: 'info', // 当前岗位子页：info | company | greeting
  greetLevel: 'standard', // 招呼语档位：short | standard | detailed
  search: '',
  verdict: 'all',
  sort: 'recent',
  platform: 'all',
};
let selectedUid = null; // 手动选中的「当前岗位」；null 时按页面自动识别
const greetingCache = new Map(); // uid -> 编辑中的招呼语文本（会话态）
let greetingTextarea = null; // 当前渲染的招呼语输入框引用
const checked = new Set(); // 岗位库中勾选的 uid（批量操作）
let batchBusy = false; // 批量分析进行中（禁用按钮 + 防重入）

async function boot() {
  await reload();
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === MSG.JOBS_UPDATED) {
      reload();
    } else if (msg.type === MSG.CURRENT_JOB) {
      // 网站上点开了新岗位：取消手动固定，跟随网站，实时刷新当前岗位视图
      onCurrentJobChanged();
    }
  });
}

async function onCurrentJobChanged() {
  selectedUid = null;
  await refreshContext();
  if (view.tab === 'current') render();
}

async function reload() {
  try {
    [jobs, settings, profile, providers, activeCtx] = await Promise.all([
      send(MSG.JOB_LIST_REQUEST),
      send(MSG.SETTINGS_GET),
      send(MSG.PROFILE_GET),
      send(MSG.AI_PROVIDERS_GET),
      send(MSG.ACTIVE_CONTEXT_REQUEST).catch(() => null),
    ]);
    view.platform = settings.mode === MODE.auto ? view.platform : settings.mode;
  } catch (e) {
    app.innerHTML = `<div class="empty"><div class="icon">⚠️</div>${esc(e.message)}</div>`;
    return;
  }
  render();
}

async function refreshContext() {
  try {
    activeCtx = await send(MSG.ACTIVE_CONTEXT_REQUEST);
  } catch {
    activeCtx = null;
  }
}

// —— 当前岗位解析：优先手动选中，其次按页面识别 ——
function currentJob() {
  if (selectedUid) {
    const j = jobs.find((x) => x.uid === selectedUid);
    if (j) return j;
  }
  if (activeCtx && activeCtx.platform && activeCtx.jobKey) {
    const uid = `${activeCtx.platform}:${activeCtx.jobKey}`;
    const j = jobs.find((x) => x.uid === uid);
    if (j) return j;
  }
  return null;
}

function greetingsOf(match) {
  return normalizeGreetings(match || {});
}

// 招呼语当前应显示的文本：编辑态 > 已存草稿 > AI 生成的对应档位
function greetingValueFor(job) {
  if (greetingTextarea && greetingTextarea.dataset.uid === job.uid) return greetingTextarea.value;
  if (greetingCache.has(job.uid)) return greetingCache.get(job.uid);
  if (job.greetingDraft) return job.greetingDraft;
  return greetingsOf(job.match)[view.greetLevel] || '';
}

function visibleJobs() {
  let list = jobs.slice();
  if (view.platform !== 'all') list = list.filter((j) => j.platform === view.platform);
  list = applyFilters(list, settings.filters);
  const q = view.search.trim().toLowerCase();
  if (q) {
    list = list.filter((j) =>
      [j.title, j.company, j.city, (j.skills || []).join(' '), (j.tags || []).join(' ')]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }
  if (view.verdict !== 'all') {
    if (view.verdict === 'unscored') list = list.filter((j) => !j.match);
    else list = list.filter((j) => j.match && j.match.verdict === view.verdict);
  }
  if (view.sort === 'score') {
    list.sort((a, b) => (b.match?.score ?? -1) - (a.match?.score ?? -1));
  } else if (view.sort === 'salary') {
    list.sort((a, b) => (b.salaryMaxK ?? b.salaryMinK ?? 0) - (a.salaryMaxK ?? a.salaryMinK ?? 0));
  } else {
    list.sort((a, b) => (b.lastSeenAt || b.savedAt || '').localeCompare(a.lastSeenAt || a.savedAt || ''));
  }
  return list;
}

function render() {
  greetingTextarea = null;
  app.innerHTML = '';

  if (view.tab === 'current') {
    app.appendChild(renderTopBar(0, 'current'));
    app.appendChild(renderCurrent());
    return;
  }

  const list = visibleJobs();
  app.appendChild(renderTopBar(list.length, 'library'));

  const ps = scoreProfile(profile);
  if (ps.score < 40) {
    app.appendChild(
      h('div', { class: 'profile-hint', onclick: () => send(MSG.OPEN_OPTIONS) }, [
        h('span', { text: '💡' }),
        h('span', { text: `画像完整度 ${ps.score}%，完善后 AI 匹配更准 →` }),
      ]),
    );
  } else if (!providers.length) {
    app.appendChild(
      h('div', { class: 'profile-hint', onclick: () => send(MSG.OPEN_OPTIONS) }, [
        h('span', { text: '🔌' }),
        h('span', { text: '尚未配置 AI 接口，点此前往设置 →' }),
      ]),
    );
  }

  const listEl = h('div', { class: 'sp-list' });
  if (!list.length) {
    listEl.appendChild(
      h('div', { class: 'empty' }, [
        h('div', { class: 'icon', text: '📭' }),
        h('div', { text: jobs.length ? '没有符合条件的岗位' : '还没有收录岗位' }),
        h('div', {
          class: 'tiny',
          text: jobs.length ? '试试调整筛选条件' : '打开 BOSS直聘 或 前程无忧 浏览岗位即可自动收录',
        }),
      ]),
    );
  } else {
    for (const job of list) listEl.appendChild(renderCard(job));
  }
  app.appendChild(listEl);
  app.appendChild(renderBottom(list));
}

// —— 顶栏：logo + 标题 + 顶级 Tab（岗位库/当前岗位）+（岗位库时）搜索筛选 ——
function renderTopBar(shown, mode) {
  const tabsRow = h('div', { class: 'sp-tabs' }, [
    tabBtn('library', '岗位库', view.tab === 'library'),
    tabBtn('current', '当前岗位', view.tab === 'current'),
  ]);

  const titleRow = h('div', { class: 'sp-title-row' }, [
    h('div', { class: 'sp-logo', text: '🎯' }),
    h('div', {}, [
      h('div', { class: 'sp-title', text: '岗位面板' }),
      h('div', {
        class: 'sp-count',
        text: mode === 'library' ? `共 ${jobs.length} 个岗位 · 显示 ${shown}` : ctxLabel(),
      }),
    ]),
    h('div', { class: 'spacer' }),
    mode === 'current'
      ? h('button', { class: 'jc-icon-btn', text: '↻', title: '刷新当前页面', onclick: async () => { await refreshContext(); render(); } })
      : null,
    h('button', { class: 'jc-icon-btn', text: '⚙️', title: '设置', onclick: () => send(MSG.OPEN_OPTIONS) }),
  ]);

  const children = [titleRow, tabsRow];

  if (mode === 'library') {
    const searchInput = h('input', { type: 'text', placeholder: '搜索岗位/公司/技能', value: view.search });
    searchInput.addEventListener(
      'input',
      debounce(() => {
        view.search = searchInput.value;
        render();
      }, 250),
    );

    const verdictChips = [
      ['all', '全部'],
      ['strong', '强匹配'],
      ['good', '较匹配'],
      ['fair', '一般'],
      ['unscored', '未分析'],
    ].map(([v, label]) =>
      h('button', {
        class: 'filter-chip' + (view.verdict === v ? ' active' : ''),
        text: label,
        onclick: () => { view.verdict = v; render(); },
      }),
    );

    const sortSel = h('select', { class: 'sp-sort' }, [opt('recent', '最近收录'), opt('score', '匹配分'), opt('salary', '薪资')]);
    sortSel.value = view.sort;
    sortSel.addEventListener('change', () => { view.sort = sortSel.value; render(); });

    const platChips = [
      ['all', '全部平台'],
      ['boss', 'BOSS'],
      ['qcwy', '51job'],
    ].map(([v, label]) =>
      h('button', {
        class: 'filter-chip' + (view.platform === v ? ' active' : ''),
        text: label,
        onclick: () => { view.platform = v; render(); },
      }),
    );

    children.push(
      h('div', { class: 'sp-toolbar' }, [h('div', { class: 'sp-search' }, [searchInput])]),
      h('div', { class: 'sp-filters' }, [...platChips]),
      h('div', { class: 'sp-filters', style: 'margin-top:8px' }, [...verdictChips, sortSel]),
    );
  }

  return h('div', { class: 'sp-top' }, children);
}

function tabBtn(key, label, active) {
  return h('button', {
    class: 'sp-tab' + (active ? ' active' : ''),
    text: label,
    onclick: async () => {
      if (view.tab === key) return;
      view.tab = key;
      if (key === 'current') await refreshContext();
      render();
    },
  });
}

function ctxLabel() {
  const job = currentJob();
  if (job) return `${job.platform === 'boss' ? 'BOSS' : '51job'} · ${job.company || '当前岗位'}`;
  if (activeCtx && activeCtx.platformName) return `${activeCtx.platformName} · 未匹配到收录岗位`;
  return '未识别到岗位页面';
}

// ============ 岗位库卡片 ============
function renderCard(job) {
  const m = job.match;
  const risks = (job._filter && job._filter.risks) || [];

  const scoreBox = h(
    'div',
    { class: 'jc-score', onclick: () => analyze(job, true) },
    m
      ? [
          h('div', { class: `score-badge verdict-${m.verdict}`, text: String(m.score) }),
          h('div', { class: 'lbl', text: VERDICT_LABELS[m.verdict] || '' }),
        ]
      : scoring.has(job.uid)
      ? [h('span', { class: 'spinner' })]
      : [
          h('div', { class: 'score-badge verdict-weak', text: '?', style: 'background:var(--fill-2);color:var(--text-3)' }),
          h('div', { class: 'lbl', text: '点击分析' }),
        ],
  );

  const tags = (job.skills.length ? job.skills : job.tags).slice(0, 5).map((t) => h('span', { class: 'chip', text: t }));
  if (risks.length) {
    for (const r of risks.slice(0, 2)) tags.push(h('span', { class: 'chip chip-red', text: '⚠ ' + r }));
  }

  const metaParts = [];
  metaParts.push(h('span', { class: `plat plat-${job.platform}`, text: job.platform === 'boss' ? 'BOSS' : '51job' }));
  if (job.city) metaParts.push(h('span', { text: job.city + (job.district ? ' · ' + job.district : '') }));
  if (job.experience) metaParts.push(h('span', { text: job.experience }));
  if (job.degree) metaParts.push(h('span', { text: job.degree }));
  if (job.companyScale) metaParts.push(h('span', { text: job.companyScale }));

  const isChecked = checked.has(job.uid);
  const checkbox = h('label', { class: 'jc-check', title: '勾选以批量操作' }, [
    (() => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = isChecked;
      cb.addEventListener('change', () => {
        if (cb.checked) checked.add(job.uid);
        else checked.delete(job.uid);
        card.classList.toggle('is-checked', cb.checked);
        updateBatchBar();
      });
      return cb;
    })(),
  ]);

  const card = h('div', { class: 'job-card fade-up' + (isChecked ? ' is-checked' : '') }, [
    h('div', { class: 'jc-head' }, [
      checkbox,
      h('div', { class: 'jc-main clickable', title: '在「当前岗位」查看', onclick: () => openCurrent(job, 'info') }, [
        h('div', { class: 'jc-title-row' }, [
          h('div', { class: 'jc-title', text: job.title, title: job.title }),
          job.salaryText ? h('div', { class: 'jc-salary', text: job.salaryText }) : null,
        ]),
        h('div', { class: 'jc-company', text: job.company + (job.companyIndustry ? ' · ' + job.companyIndustry : '') }),
        h('div', { class: 'jc-meta' }, metaParts),
        tags.length ? h('div', { class: 'jc-tags' }, tags) : null,
      ]),
      scoreBox,
    ]),
    h('div', { class: 'jc-actions' }, [
      h('button', { class: 'btn btn-sm btn-primary', text: m ? '重新分析' : 'AI 分析', onclick: () => analyze(job, true) }),
      h('button', { class: 'btn btn-sm', text: '打招呼', onclick: () => openCurrent(job, 'greeting') }),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'jc-icon-btn' + (job.star ? ' starred' : ''),
        text: job.star ? '★' : '☆',
        title: '收藏',
        onclick: async () => { jobs = await send(MSG.JOB_STAR_TOGGLE, { uid: job.uid }); render(); },
      }),
      job.url
        ? h('button', { class: 'jc-icon-btn', text: '↗', title: '打开原岗位', onclick: () => chrome.tabs.create({ url: job.url }) })
        : null,
      h('button', {
        class: 'jc-icon-btn',
        text: '🗑',
        title: '删除',
        onclick: async () => { jobs = await send(MSG.JOB_DELETE, { uid: job.uid }); render(); },
      }),
    ]),
  ]);
  return card;
}

function openCurrent(job, sub) {
  selectedUid = job.uid;
  view.tab = 'current';
  view.sub = sub || 'info';
  render();
}

// ============ 当前岗位模块 ============
function renderCurrent() {
  const job = currentJob();
  const body = h('div', { class: 'cur-body' });

  if (!job) {
    body.appendChild(
      h('div', { class: 'empty' }, [
        h('div', { class: 'icon', text: '🧭' }),
        h('div', { text: activeCtx && activeCtx.platform ? '未匹配到当前页面的岗位' : '未识别到岗位页面' }),
        h('div', { class: 'tiny', text: '在 BOSS/51job 打开某个岗位详情后点右上角 ↻ 刷新，或从岗位库里选择一个岗位' }),
        h('button', {
          class: 'btn btn-sm btn-primary',
          text: '去岗位库选择',
          style: 'margin-top:14px',
          onclick: () => { view.tab = 'library'; render(); },
        }),
      ]),
    );
    return body;
  }

  // 岗位头部：标题/薪资/公司 + 匹配分
  const m = job.match;
  const head = h('div', { class: 'cur-head' }, [
    h('div', { class: 'cur-head-main' }, [
      h('div', { class: 'cur-title', text: job.title }),
      job.salaryText ? h('div', { class: 'cur-salary', text: job.salaryText }) : null,
      h('div', { class: 'cur-company', text: job.company + (job.companyIndustry ? ' · ' + job.companyIndustry : '') }),
    ]),
    h(
      'div',
      { class: 'jc-score', onclick: () => analyze(job, true), title: '点击重新分析' },
      m
        ? [h('div', { class: `score-badge verdict-${m.verdict}`, text: String(m.score) }), h('div', { class: 'lbl', text: VERDICT_LABELS[m.verdict] || '' })]
        : scoring.has(job.uid)
        ? [h('span', { class: 'spinner' })]
        : [h('div', { class: 'score-badge verdict-weak', text: '?', style: 'background:var(--fill-2);color:var(--text-3)' }), h('div', { class: 'lbl', text: '点击分析' })],
    ),
  ]);
  body.appendChild(head);

  // 子页签
  const sub = h('div', { class: 'segmented subtabs' }, [
    subBtn('info', '岗位信息'),
    subBtn('company', '公司画像'),
    subBtn('greeting', '打招呼'),
  ]);
  body.appendChild(sub);

  const panel = h('div', { class: 'cur-panel fade-up' });
  if (view.sub === 'info') renderJobInfo(panel, job);
  else if (view.sub === 'company') renderCompany(panel, job);
  else renderGreeting(panel, job);
  body.appendChild(panel);

  return body;
}

function subBtn(key, label) {
  return h('button', {
    class: view.sub === key ? 'active' : '',
    text: label,
    onclick: () => { view.sub = key; render(); },
  });
}

function renderJobInfo(panel, job) {
  const facts = [];
  const factRow = (k, v) => (v ? facts.push(h('div', { class: 'fact' }, [h('span', { class: 'fk', text: k }), h('span', { class: 'fv', text: v })])) : null);
  factRow('薪资', job.salaryText);
  factRow('城市', job.city + (job.district ? ' · ' + job.district : ''));
  factRow('经验', job.experience);
  factRow('学历', job.degree);
  factRow('平台', job.platform === 'boss' ? 'BOSS 直聘' : '前程无忧 51job');
  if (facts.length) panel.appendChild(h('div', { class: 'cur-facts' }, facts));

  const skills = job.skills && job.skills.length ? job.skills : job.tags;
  if (skills && skills.length) {
    panel.appendChild(h('div', { class: 'cur-sec-title', text: '技能 / 标签' }));
    panel.appendChild(h('div', { class: 'jc-tags' }, skills.slice(0, 20).map((t) => h('span', { class: 'chip', text: t }))));
  }
  if (job.welfare && job.welfare.length) {
    panel.appendChild(h('div', { class: 'cur-sec-title', text: '福利' }));
    panel.appendChild(h('div', { class: 'jc-tags' }, job.welfare.slice(0, 20).map((t) => h('span', { class: 'chip chip-green', text: t }))));
  }
  if (job.description) {
    panel.appendChild(h('div', { class: 'cur-sec-title', text: '岗位描述' }));
    panel.appendChild(h('div', { class: 'cur-jd', text: job.description }));
  }

  // 匹配分析
  panel.appendChild(h('div', { class: 'cur-sec-title', text: '匹配分析' }));
  if (job.match) {
    panel.appendChild(renderAnalysis(job.match));
  } else {
    panel.appendChild(
      h('div', { class: 'cur-hint' }, [
        h('span', { text: '尚未分析，' }),
        h('button', { class: 'linklike', text: '立即 AI 分析', onclick: () => analyze(job, true) }),
      ]),
    );
  }
  if (job.url) {
    panel.appendChild(
      h('button', { class: 'btn btn-sm btn-block', text: '↗ 打开原岗位页面', style: 'margin-top:14px', onclick: () => chrome.tabs.create({ url: job.url }) }),
    );
  }
}

function renderAnalysis(m) {
  const box = h('div', { class: 'jc-analysis' }, [m.summary ? h('div', { class: 'summary', text: m.summary }) : null]);
  if (m.reasons && m.reasons.length) {
    box.appendChild(h('h5', { text: '✅ 契合点' }));
    box.appendChild(h('ul', {}, m.reasons.map((r) => h('li', { text: r }))));
  }
  if (m.gaps && m.gaps.length) {
    box.appendChild(h('h5', { text: '📌 差距/需补齐' }));
    box.appendChild(h('ul', {}, m.gaps.map((r) => h('li', { text: r }))));
  }
  if (m.risks && m.risks.length) {
    box.appendChild(h('h5', { text: '⚠️ 风险提示' }));
    box.appendChild(h('ul', {}, m.risks.map((r) => h('li', { class: 'risk-line', text: r }))));
  }
  return box;
}

function renderCompany(panel, job) {
  const rows = [];
  const row = (k, v) => (v ? rows.push(h('div', { class: 'fact' }, [h('span', { class: 'fk', text: k }), h('span', { class: 'fv', text: v })])) : null);
  row('公司', job.company);
  row('行业', job.companyIndustry);
  row('规模', job.companyScale);
  row('性质', job.companyType);
  row('阶段', job.companyStage);
  row('HR', [job.hrName, job.hrTitle].filter(Boolean).join(' · '));

  if (rows.length) {
    panel.appendChild(h('div', { class: 'cur-facts' }, rows));
  } else {
    panel.appendChild(h('div', { class: 'cur-hint', text: '暂无公司信息（该平台列表接口未返回，或浏览详情后可补全）' }));
  }
  panel.appendChild(
    h('div', { class: 'cur-note', text: '公司画像基于岗位接口返回的公开信息整理，仅供参考。' }),
  );
}

function renderGreeting(panel, job) {
  if (!providers.length) {
    panel.appendChild(
      h('div', { class: 'cur-hint' }, [h('span', { text: '尚未配置 AI 接口，' }), h('button', { class: 'linklike', text: '前往设置', onclick: () => send(MSG.OPEN_OPTIONS) })]),
    );
    return;
  }
  if (!job.match) {
    panel.appendChild(
      h('div', { class: 'cur-hint' }, [
        h('span', { text: '先做一次匹配分析，AI 会生成三档招呼语。' }),
      ]),
    );
    panel.appendChild(
      h('button', {
        class: 'btn btn-sm btn-primary btn-block',
        text: scoring.has(job.uid) ? '分析中…' : '生成招呼语',
        disabled: scoring.has(job.uid),
        style: 'margin-top:10px',
        onclick: () => analyze(job, true),
      }),
    );
    return;
  }

  // 档位切换
  const levelSeg = h(
    'div',
    { class: 'segmented greet-levels' },
    GREETING_LEVELS.map((lv) =>
      h('button', {
        class: view.greetLevel === lv.key ? 'active' : '',
        text: lv.label,
        onclick: () => {
          view.greetLevel = lv.key;
          // 切换档位时用该档 AI 文案覆盖编辑区（并存为草稿）
          const text = greetingsOf(job.match)[lv.key] || '';
          greetingCache.set(job.uid, text);
          persistGreeting(job.uid, text);
          render();
        },
      }),
    ),
  );
  panel.appendChild(h('div', { class: 'greet-head' }, [h('span', { class: 'cur-sec-title', text: '💬 招呼语（可编辑）' }), h('div', { class: 'spacer' }), levelSeg]));

  const value = greetingValueFor(job);
  const ta = h('textarea', { class: 'greet-editor', rows: 6, placeholder: '编辑要发送给 HR 的招呼语…' });
  ta.value = value;
  ta.dataset.uid = job.uid;
  greetingTextarea = ta;
  const counter = h('div', { class: 'greet-count', text: `${value.length} 字` });
  ta.addEventListener('input', () => {
    greetingCache.set(job.uid, ta.value);
    counter.textContent = `${ta.value.length} 字`;
    persistGreetingDebounced(job.uid, ta.value);
  });
  panel.appendChild(ta);
  panel.appendChild(counter);

  // 发送状态提示
  const onChat = activeCtx && activeCtx.isChat;
  panel.appendChild(
    h('div', { class: 'greet-hint' + (onChat ? ' ok' : '') }, [
      h('span', {
        text: onChat
          ? '✓ 已在聊天页，点发送直接送出'
          : 'ℹ 点「发送」会自动打开与 HR 的聊天窗口并送出（需停留在该岗位详情页或聊天页）',
      }),
    ]),
  );

  // 操作按钮
  panel.appendChild(
    h('div', { class: 'greet-tools' }, [
      h('button', {
        class: 'btn btn-sm',
        text: scoring.has(job.uid) ? '生成中…' : '↻ 重新生成',
        disabled: scoring.has(job.uid),
        onclick: () => regenerateGreeting(job),
      }),
      h('button', { class: 'btn btn-sm', text: '📋 复制', onclick: () => copyText(greetingValueFor(job)) }),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm btn-primary', text: '新窗口打开并复制', title: '在新窗口打开岗位页（不影响当前浏览），招呼语已复制，点「立即沟通」后 Ctrl+V 粘贴', onclick: () => sendGreeting(job) }),
    ]),
  );
}

function renderBottom(list) {
  const bar = h('div', { class: 'sp-bottom', id: 'sp-bottom-bar' });
  fillBottom(bar, list);
  return bar;
}

// 就地刷新底栏（勾选变化时不整页重渲，避免丢失滚动位置）
function updateBatchBar() {
  const bar = document.getElementById('sp-bottom-bar');
  if (bar) fillBottom(bar, visibleJobs());
}

function fillBottom(bar, list) {
  bar.innerHTML = '';
  const n = checked.size;

  const totalVisible = list.length;

  if (n > 0) {
    // 选中态：批量分析 / 批量导出，只作用于勾选的岗位
    const allSelected = totalVisible > 0 && n >= totalVisible;
    bar.classList.add('has-sel');
    bar.appendChild(
      h('div', { class: 'batch-wrap' }, [
        h('div', { class: 'batch-row1' }, [
          h('span', { class: 'batch-count', text: `已选 ${n}` }),
          h('button', {
            class: 'linklike',
            text: allSelected ? '取消全选' : '全选',
            onclick: () => {
              if (allSelected) checked.clear();
              else visibleJobs().forEach((j) => checked.add(j.uid));
              render();
            },
          }),
          h('button', { class: 'linklike', text: '清空选择', onclick: () => { checked.clear(); render(); } }),
        ]),
        h('div', { class: 'batch-row2' }, [
          h('button', {
            class: 'btn btn-sm btn-primary',
            text: `批量分析（${n}）`,
            disabled: batchBusy,
            onclick: () => batchAnalyze(checkedJobs()),
          }),
          h('button', { class: 'btn btn-sm', text: `批量导出（${n}）`, onclick: () => batchExport(checkedJobs()) }),
        ]),
      ]),
    );
    return;
  }

  // 默认态：全选可一键勾选全部可见岗位，勾选后再批量分析/导出
  bar.classList.remove('has-sel');
  bar.appendChild(
    h('button', {
      class: 'btn btn-sm btn-primary',
      text: `全选 (${totalVisible})`,
      disabled: totalVisible === 0,
      onclick: () => { list.forEach((j) => checked.add(j.uid)); render(); },
    }),
  );
  bar.appendChild(h('div', { class: 'spacer' }));
  bar.appendChild(h('button', { class: 'btn btn-sm', text: '导出', onclick: exportJobs }));
  bar.appendChild(
    h('button', {
      class: 'btn btn-sm btn-danger',
      text: '清空',
      onclick: async () => {
        if (!confirm('确定清空所有已收录岗位？此操作不可撤销。')) return;
        jobs = await send(MSG.JOB_CLEAR_REQUEST);
        checked.clear();
        render();
        toast('已清空岗位库');
      },
    }),
  );
}

function checkedJobs() {
  return jobs.filter((j) => checked.has(j.uid));
}

// ============ 招呼语持久化 ============
function persistGreeting(uid, text) {
  send(MSG.GREETING_SAVE, { uid, text }).catch(() => {});
}
const persistGreetingDebounced = debounce((uid, text) => persistGreeting(uid, text), 500);

async function sendGreeting(job) {
  const text = greetingValueFor(job).trim();
  if (!text) {
    toast('招呼语为空', true);
    return;
  }
  // 可选：发送前二次确认（设置 → 隐私 → confirmBeforeSend）
  if (settings.privacy && settings.privacy.confirmBeforeSend) {
    if (!confirm(`确认发送给 ${job.company || 'HR'}？\n\n${text}`)) return;
  }
  // 以当前文本为准，落库
  greetingCache.set(job.uid, text);
  persistGreeting(job.uid, text);
  // 先复制到剪贴板（无论新窗口能否打开，招呼语都在手上）
  copyText(text);
  try {
    // 在新窗口打开岗位页，不打断当前正在浏览的页面
    await send(MSG.OPEN_JOB_WINDOW, { url: job.url, platform: job.platform });
    toast('已在新窗口打开岗位页，招呼语已复制，请在新窗口点「立即沟通」后 Ctrl+V 粘贴发送');
  } catch (e) {
    // 无链接或打开失败：招呼语已复制，提示手动粘贴
    toast(`招呼语已复制，请手动打开岗位页粘贴发送（${e.message}）`, true);
  }
}

async function regenerateGreeting(job) {
  await analyze(job, true);
  greetingCache.delete(job.uid);
  persistGreeting(job.uid, ''); // 清掉旧草稿，显示新生成的对应档位
  render();
}

// ============ 分析 ============
async function analyze(job, force) {
  if (scoring.has(job.uid)) return;
  if (!providers.length) {
    toast('请先在设置中配置 AI 接口', true);
    send(MSG.OPEN_OPTIONS);
    return;
  }
  scoring.add(job.uid);
  render();
  try {
    await send(MSG.AI_MATCH_SCORE, { uid: job.uid, job, force });
    jobs = await send(MSG.JOB_LIST_REQUEST);
    expanded.add(job.uid);
    toast('分析完成');
  } catch (e) {
    toast(e.message, true);
  } finally {
    scoring.delete(job.uid);
    render();
  }
}

// 统一管理 batchBusy：带看门狗，任务异常挂起也能自动复位，避免批量按钮永久变灰。
let batchWatchdog = null;
function setBatchBusy(v) {
  batchBusy = v;
  clearTimeout(batchWatchdog);
  if (v) {
    batchWatchdog = setTimeout(() => {
      batchBusy = false;
      render();
      toast('批量任务超时已自动复位，请重试', true);
    }, 180000);
  }
}

// 逐个分析（短请求 + 进度），避免一次性长请求把 MV3 后台拖死导致挂起
async function batchAnalyze(list) {
  if (batchBusy) return;
  if (!providers.length) {
    toast('请先在设置中配置 AI 接口', true);
    send(MSG.OPEN_OPTIONS);
    return;
  }
  if (!list.length) return;
  const uids = list.map((j) => j.uid);
  setBatchBusy(true);
  uids.forEach((u) => scoring.add(u));
  render();
  let ok = 0, fail = 0;
  let firstErr = '';
  try {
    for (let i = 0; i < uids.length; i++) {
      const uid = uids[i];
      const job = jobs.find((j) => j.uid === uid);
      toast(`批量分析 ${i + 1}/${uids.length}…`);
      try {
        await send(MSG.AI_MATCH_SCORE, { uid, job });
        ok++;
      } catch (e) {
        fail++;
        const em = e instanceof Error ? e.message : String(e);
        if (!firstErr) firstErr = em;
        // 立刻把失败原因显示出来，不再等到最后（否则用户以为卡死）
        toast(`第 ${i + 1} 个失败：${em}`, true);
        // 第一个就失败：多半是供应商/画像/网络配置问题，后面必然全挂，中止并报出真实原因
        if (i === 0) {
          scoring.delete(uid);
          throw new Error(`分析失败：${em}`);
        }
      }
      scoring.delete(uid);
      jobs = await send(MSG.JOB_LIST_REQUEST).catch(() => jobs);
      render();
      // 调用之间留间隔，避免供应商限流（429）；最后一个不等
      if (i < uids.length - 1) await sleep(500);
    }
    if (fail) toast(`批量分析完成：成功 ${ok}，失败 ${fail}（${firstErr}）`, true);
    else toast(`批量分析完成：成功 ${ok}`);
  } catch (e) {
    toast(e.message, true);
  } finally {
    uids.forEach((u) => scoring.delete(u));
    setBatchBusy(false);
    render();
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// —— 批量导出：把勾选的岗位导成一份带详细分类与内容的表格（CSV，Excel/WPS 可直接打开） ——
function batchExport(list) {
  const items = Array.isArray(list) ? list : checkedJobs();
  if (!items.length) {
    toast('未选择岗位', true);
    return;
  }
  const csv = buildDetailedCsv(items);
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  chrome.downloads
    .download({ url, filename: `岗位导出-${items.length}条-${ts}.csv`, saveAs: true })
    .then(() => toast(`已导出 ${items.length} 个岗位`))
    .catch(() => {
      // 无 downloads 权限时回退：新标签打开
      chrome.tabs.create({ url });
      toast(`已在新标签打开导出内容（${items.length} 个岗位）`);
    });
}

// 生成详细 CSV：按「基本信息 / 岗位要求 / 公司信息 / AI匹配分析 / 招呼语 / 其他」分类排列列
function buildDetailedCsv(items) {
  const cols = [
    // —— 分类/优先级 ——
    ['平台', (j) => (j.platform === 'boss' ? 'BOSS直聘' : '前程无忧51job')],
    ['匹配档次', (j) => (j.match ? VERDICT_LABELS[j.match.verdict] || j.match.verdict : '未分析')],
    ['匹配分', (j) => (j.match ? j.match.score : '')],
    ['是否收藏', (j) => (j.star ? '★' : '')],
    // —— 基本信息 ——
    ['岗位名称', (j) => j.title],
    ['薪资', (j) => j.salaryText],
    ['薪资下限(K/月)', (j) => (j.salaryMinK != null ? j.salaryMinK : '')],
    ['薪资上限(K/月)', (j) => (j.salaryMaxK != null ? j.salaryMaxK : '')],
    ['城市', (j) => j.city],
    ['区域', (j) => j.district],
    // —— 岗位要求 ——
    ['工作经验', (j) => j.experience],
    ['学历要求', (j) => j.degree],
    ['技能', (j) => joinList(j.skills)],
    ['岗位标签', (j) => joinList(j.tags)],
    ['福利', (j) => joinList(j.welfare)],
    // —— 公司信息 ——
    ['公司名称', (j) => j.company],
    ['所属行业', (j) => j.companyIndustry],
    ['公司规模', (j) => j.companyScale],
    ['公司性质', (j) => j.companyType],
    ['融资阶段', (j) => j.companyStage],
    ['HR', (j) => j.hrName],
    ['HR职位', (j) => j.hrTitle],
    // —— AI 匹配分析 ——
    ['一句话总评', (j) => (j.match ? j.match.summary : '')],
    ['契合点', (j) => (j.match ? joinList(j.match.reasons) : '')],
    ['差距/需补齐', (j) => (j.match ? joinList(j.match.gaps) : '')],
    ['风险提示', (j) => (j.match ? joinList(j.match.risks) : '')],
    // —— 招呼语 ——
    ['招呼语(标准版)', (j) => (j.greetingDraft || (j.match ? normalizeGreetings(j.match).standard : ''))],
    // —— 其他 ——
    ['岗位描述', (j) => j.description],
    ['收录时间', (j) => fmtTime(j.savedAt)],
    ['最近出现', (j) => fmtTime(j.lastSeenAt)],
    ['岗位链接', (j) => j.url],
  ];
  const head = cols.map((c) => csvCell(c[0])).join(',');
  const rows = items.map((j) => cols.map((c) => csvCell(c[1](j))).join(','));
  return [head, ...rows].join('\r\n');
}

function joinList(x) {
  return Array.isArray(x) ? x.filter(Boolean).join('、') : x == null ? '' : String(x);
}
function fmtTime(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { hour12: false });
}
function csvCell(v) {
  const s = v == null ? '' : String(v);
  // 单元格内换行/逗号/引号：用双引号包裹并转义内部引号
  return `"${s.replace(/"/g, '""')}"`;
}

async function exportJobs() {
  try {
    const res = await send(MSG.JOB_EXPORT_REQUEST, { format: 'csv' });
    const blob = new Blob([res.content], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().slice(0, 10);
    await chrome.downloads.download({ url, filename: `岗位收录-${ts}.csv`, saveAs: true }).catch(() => {
      chrome.tabs.create({ url });
    });
    toast(`已导出 ${res.count} 个岗位`);
  } catch (e) {
    toast(e.message, true);
  }
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(
    () => toast('已复制'),
    () => toast('复制失败', true),
  );
}

function opt(v, label) {
  const o = document.createElement('option');
  o.value = v;
  o.textContent = label;
  return o;
}

boot();
