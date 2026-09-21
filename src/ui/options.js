import { MSG, MODE } from '../common/constants.js';
import { emptyProfile, scoreProfile, sanitizeProfile, mergeDraft } from '../common/profile.js';
import { PRESETS, PROTOCOLS, PROTOCOL_LABELS, providerFromPreset, sanitizeProvider, validateProvider } from '../common/ai/providers.js';
import { send, h, toast, toList, fromList, debounce } from './ui-common.js';
import { parseResumeFile } from './resumeParser.js';

const navEl = document.getElementById('nav');
const mainEl = document.getElementById('main');

let settings = null;
let providers = [];
let profile = null;

const SECTIONS = [
  { id: 'profile', icon: '👤', label: '个人画像', render: renderProfile },
  { id: 'ai', icon: '🔌', label: 'AI 接口', render: renderAi },
  { id: 'filters', icon: '🧲', label: '岗位筛选', render: renderFilters },
  { id: 'general', icon: '⚙️', label: '通用与隐私', render: renderGeneral },
];
let current = 'profile';

async function boot() {
  await reloadAll();
  renderNav();
  route();
}
async function reloadAll() {
  [settings, providers, profile] = await Promise.all([
    send(MSG.SETTINGS_GET),
    send(MSG.AI_PROVIDERS_GET),
    send(MSG.PROFILE_GET),
  ]);
}

function renderNav() {
  navEl.innerHTML = '';
  for (const s of SECTIONS) {
    navEl.appendChild(
      h('button', {
        class: 'nav-item' + (s.id === current ? ' active' : ''),
        onclick: () => {
          current = s.id;
          renderNav();
          route();
        },
      }, [h('span', { class: 'ic', text: s.icon }), h('span', { text: s.label })]),
    );
  }
}
function route() {
  const sec = SECTIONS.find((s) => s.id === current);
  mainEl.innerHTML = '';
  sec.render();
}

function sectionHead(title, desc) {
  return h('div', { class: 'sec-head' }, [
    h('div', { class: 'sec-title', text: title }),
    desc ? h('div', { class: 'sec-desc', text: desc }) : null,
  ]);
}

// ============================================================
//  个人画像
// ============================================================
let draft = null; // AI 抽取草稿待确认

function renderProfile() {
  mainEl.appendChild(sectionHead('个人画像', '上传简历自动抽取，或手动填写。画像越完整，AI 匹配越准。'));

  // 完整度环
  const ps = scoreProfile(profile);
  const ring = h('div', { class: 'ring' }, [h('span', { text: ps.score + '%' })]);
  ring.style.setProperty('--p', ps.score);
  mainEl.appendChild(
    h('div', { class: 'score-ring' }, [
      ring,
      h('div', { class: 'score-info' }, [
        h('div', { style: 'font-weight:600;font-size:15px', text: `完整度 ${ps.completed}/${ps.total} 项` }),
        ps.missing.length
          ? h('div', { class: 'missing', text: '待补充：' + ps.missing.join('、') })
          : h('div', { class: 'missing', text: '画像已相当完整 👍' }),
      ]),
    ]),
  );

  // 简历上传
  const uploadPanel = h('div', { class: 'panel' }, [
    h('div', { class: 'panel-title', text: '📄 上传简历，AI 自动填写' }),
    h('div', { class: 'panel-desc', text: '支持 PDF、DOCX、TXT。文件仅在本机解析为文本，抽取后需你确认才写入画像。' }),
  ]);
  const fileInput = h('input', { type: 'file', accept: '.pdf,.docx,.txt,.md,.json', style: 'display:none' });
  const zone = h('div', { class: 'upload-zone' }, [
    h('div', { class: 'up-icon', text: '📎' }),
    h('div', { class: 'up-main', text: '点击选择简历文件，或拖拽到此处' }),
    h('div', { class: 'up-sub', text: 'PDF / DOCX / TXT · 也可在下方直接粘贴文本' }),
  ]);
  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleFile(fileInput.files[0]);
  });
  uploadPanel.appendChild(zone);
  uploadPanel.appendChild(fileInput);

  // 粘贴文本
  const pasteArea = h('textarea', { placeholder: '或在此粘贴简历文本…', rows: 4 });
  uploadPanel.appendChild(
    h('div', { class: 'field', style: 'margin-top:8px' }, [pasteArea]),
  );
  uploadPanel.appendChild(
    h('button', {
      class: 'btn btn-primary',
      text: '🤖 从文本抽取画像',
      onclick: () => {
        const t = pasteArea.value.trim();
        if (!t) return toast('请先粘贴简历文本', true);
        extractFromText(t);
      },
    }),
  );

  // 草稿确认区
  if (draft) uploadPanel.appendChild(renderDraft());
  mainEl.appendChild(uploadPanel);

  // 手动编辑表单
  mainEl.appendChild(renderProfileForm());

  // 清除画像
  mainEl.appendChild(
    h('div', { class: 'panel' }, [
      h('div', { class: 'row-between' }, [
        h('div', {}, [
          h('div', { class: 'panel-title', text: '🧹 一键清除画像' }),
          h('div', { class: 'panel-desc', style: 'margin:0', text: '清空全部画像字段，并使已有匹配分缓存失效。不可撤销。' }),
        ]),
        h('button', { class: 'btn btn-danger', text: '清除画像', onclick: confirmClearProfile }),
      ]),
    ]),
  );
}

async function handleFile(file) {
  const overlay = showBusy('正在解析简历文件…');
  try {
    const { text } = await parseResumeFile(file);
    overlay.setText('AI 正在抽取画像…');
    const d = await send(MSG.AI_RESUME_EXTRACT, { text });
    draft = sanitizeProfile(d);
    toast('抽取完成，请确认');
    route();
  } catch (e) {
    toast(e.message, true);
  } finally {
    overlay.close();
  }
}

async function extractFromText(text) {
  const overlay = showBusy('AI 正在抽取画像…');
  try {
    const d = await send(MSG.AI_RESUME_EXTRACT, { text });
    draft = sanitizeProfile(d);
    toast('抽取完成，请确认');
    route();
  } catch (e) {
    toast(e.message, true);
  } finally {
    overlay.close();
  }
}

function renderDraft() {
  const d = draft;
  const line = (k, v) => (v && v.length ? h('div', {}, [h('span', { class: 'k', text: k + '：' }), h('span', { text: Array.isArray(v) ? v.join('、') : String(v) })]) : null);
  const preview = h('div', { class: 'draft-preview' }, [
    line('目标岗位', d.target.jobTitles),
    line('目标城市', d.target.cities),
    line('期望薪资', d.target.salaryMinK ? `${d.target.salaryMinK}-${d.target.salaryMaxK || ''}k` : ''),
    line('工作年限', d.basics.yearsOfExperience ? d.basics.yearsOfExperience + ' 年' : ''),
    line('学历', d.basics.education),
    line('当前职位', d.basics.currentTitle),
    line('技能', d.capabilities.skills),
    line('优势', d.capabilities.strengths),
    line('行业经验', d.capabilities.industryExperience),
    line('工作概述', d.workSummary),
    line('项目概述', d.projectSummary),
    line('核心成就', d.highlights),
  ]);
  return h('div', { class: 'draft-box' }, [
    h('h4', { text: '✨ AI 抽取结果（确认后合并到画像）' }),
    preview,
    h('div', { class: 'draft-actions' }, [
      h('button', {
        class: 'btn btn-primary',
        text: '合并到画像',
        onclick: async () => {
          profile = mergeDraft(profile, draft);
          profile = await send(MSG.PROFILE_SAVE, { profile });
          draft = null;
          toast('已合并并保存');
          route();
        },
      }),
      h('button', {
        class: 'btn',
        text: '替换现有画像',
        onclick: async () => {
          profile = await send(MSG.PROFILE_SAVE, { profile: draft });
          draft = null;
          toast('已替换并保存');
          route();
        },
      }),
      h('button', { class: 'btn btn-ghost', text: '放弃', onclick: () => { draft = null; route(); } }),
    ]),
  ]);
}

function renderProfileForm() {
  const p = profile;
  const save = debounce(async () => {
    profile = await send(MSG.PROFILE_SAVE, { profile });
    renderNavScoreRefresh();
  }, 600);

  const bindText = (obj, key, opts = {}) => {
    const input = h('input', { type: opts.type || 'text', value: obj[key] ?? '', placeholder: opts.ph || '' });
    input.addEventListener('input', () => {
      obj[key] = opts.type === 'number' ? (input.value === '' ? null : Number(input.value)) : input.value;
      save();
    });
    return input;
  };
  const bindList = (obj, key, ph) =>
    tagEditor(obj[key], (arr) => {
      obj[key] = arr;
      save();
    }, ph);
  const bindArea = (obj, key, ph) => {
    const ta = h('textarea', { placeholder: ph || '', rows: 3 });
    ta.value = obj[key] || '';
    ta.addEventListener('input', () => {
      obj[key] = ta.value;
      save();
    });
    return ta;
  };

  const panel = h('div', { class: 'panel' }, [h('div', { class: 'panel-title', text: '✏️ 手动编辑（自动保存）' })]);

  // 求职目标
  panel.appendChild(h('h4', { style: 'margin:16px 0 10px;font-size:14px', text: '求职目标' }));
  panel.appendChild(field('目标岗位', bindList(p.target, 'jobTitles', '回车添加，如 前端工程师')));
  panel.appendChild(field('目标城市', bindList(p.target, 'cities', '如 广州')));
  panel.appendChild(
    h('div', { class: 'grid-3' }, [
      field('期望月薪下限(k)', bindText(p.target, 'salaryMinK', { type: 'number', ph: '如 15' })),
      field('期望月薪上限(k)', bindText(p.target, 'salaryMaxK', { type: 'number', ph: '如 25' })),
      field('工作年限', bindText(p.basics, 'yearsOfExperience', { type: 'number', ph: '如 3' })),
    ]),
  );
  panel.appendChild(field('目标行业', bindList(p.target, 'industries', '如 互联网')));

  // 个人能力
  panel.appendChild(h('h4', { style: 'margin:16px 0 10px;font-size:14px', text: '个人基础' }));
  panel.appendChild(
    h('div', { class: 'grid-2' }, [
      field('最高学历', bindText(p.basics, 'education', { ph: '如 本科' })),
      field('当前/最近职位', bindText(p.basics, 'currentTitle', { ph: '如 高级前端' })),
    ]),
  );
  panel.appendChild(field('姓名（仅本地展示，默认不发送给 AI）', bindText(p.basics, 'name', { ph: '可留空' })));

  panel.appendChild(h('h4', { style: 'margin:16px 0 10px;font-size:14px', text: '能力与经历' }));
  panel.appendChild(field('专业技能', bindList(p.capabilities, 'skills', '如 React、TypeScript')));
  panel.appendChild(field('优势亮点', bindList(p.capabilities, 'strengths', '一句一条')));
  panel.appendChild(field('行业经验', bindList(p.capabilities, 'industryExperience', '如 电商、金融')));
  panel.appendChild(field('工作经历概述', bindArea(p, 'workSummary', '一段话概述工作经历')));
  panel.appendChild(field('项目经历概述', bindArea(p, 'projectSummary', '代表性项目')));
  panel.appendChild(field('核心成就', bindList(p, 'highlights', '可量化的成果，一条一个')));

  // 偏好禁区
  panel.appendChild(h('h4', { style: 'margin:16px 0 10px;font-size:14px', text: '偏好与禁区' }));
  panel.appendChild(field('规避关键词', bindList(p.preference, 'avoidKeywords', '如 外包、驻场')));
  panel.appendChild(field('硬性排除', bindList(p.preference, 'dealbreakers', '如 需要出差')));
  panel.appendChild(field('给 AI 的额外说明', bindArea(p.preference, 'notes', '任何想让 AI 知道的补充')));

  return panel;
}

function renderNavScoreRefresh() {
  // 仅在画像页刷新完整度环，避免整页重绘打断输入
  if (current !== 'profile') return;
  const ps = scoreProfile(profile);
  const ring = mainEl.querySelector('.ring');
  if (ring) {
    ring.style.setProperty('--p', ps.score);
    ring.querySelector('span').textContent = ps.score + '%';
  }
}

function confirmClearProfile() {
  showModal({
    title: '清除个人画像？',
    body: '将清空全部画像字段，并使已生成的岗位匹配分缓存失效。此操作不可撤销。',
    confirmText: '确认清除',
    danger: true,
    onConfirm: async () => {
      profile = await send(MSG.PROFILE_CLEAR);
      toast('画像已清除');
      route();
    },
  });
}

// ============================================================
//  AI 接口
// ============================================================
function renderAi() {
  mainEl.appendChild(sectionHead('AI 接口', '兼容 OpenAI / Anthropic / Gemini 等主流协议，可接入任意兼容供应商或本地模型。'));

  // 添加供应商
  const presetSel = h('select', {}, PRESETS.map((p) => {
    const o = document.createElement('option');
    o.value = p.key;
    o.textContent = p.name + (p.hint ? ` — ${p.hint}` : '');
    return o;
  }));
  mainEl.appendChild(
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-title', text: '➕ 添加供应商' }),
      h('div', { class: 'panel-desc', text: '选择预设一键创建，或选“自定义供应商”手动填写。' }),
      h('div', { class: 'row' }, [
        presetSel,
        h('button', {
          class: 'btn btn-primary',
          text: '添加',
          onclick: async () => {
            const prov = providerFromPreset(presetSel.value);
            providers = await send(MSG.AI_PROVIDERS_SAVE, { providers: [...providers, prov] });
            if (!settings.activeProviderId) {
              settings = await send(MSG.SETTINGS_SAVE, { patch: { activeProviderId: prov.id } });
            }
            toast('已添加，请填写 API Key 与模型');
            route();
          },
        }),
      ]),
    ]),
  );

  if (!providers.length) {
    mainEl.appendChild(
      h('div', { class: 'empty' }, [h('div', { class: 'icon', text: '🔌' }), h('div', { text: '还没有配置任何 AI 供应商' })]),
    );
    return;
  }

  for (const prov of providers) mainEl.appendChild(renderProviderCard(prov));
}

function renderProviderCard(prov) {
  const isActive = settings.activeProviderId === prov.id;
  const card = h('div', { class: 'prov-card' + (isActive ? ' active' : '') });

  // 表单字段绑定到 prov 副本
  const commit = debounce(async () => {
    providers = await send(MSG.AI_PROVIDERS_SAVE, { providers });
  }, 500);
  const bind = (key, opts = {}) => {
    const input = h('input', { type: opts.type || 'text', value: prov[key] ?? '', placeholder: opts.ph || '' });
    input.addEventListener('input', () => {
      prov[key] = opts.type === 'number' ? Number(input.value) : input.value;
      commit();
    });
    return input;
  };

  // 协议下拉
  const protoSel = h('select', {}, PROTOCOLS.map((p) => {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = PROTOCOL_LABELS[p];
    return o;
  }));
  protoSel.value = prov.protocol;
  protoSel.addEventListener('change', () => {
    prov.protocol = protoSel.value;
    commit();
    route();
  });

  // 模型输入 + 发现列表
  const modelInput = bind('model', { ph: '如 gpt-4o-mini' });
  const modelList = h('datalist', { id: `models-${prov.id}` });
  modelInput.setAttribute('list', `models-${prov.id}`);
  for (const m of prov.discoveredModels) {
    const o = document.createElement('option');
    o.value = m;
    modelList.appendChild(o);
  }

  card.appendChild(
    h('div', { class: 'prov-head' }, [
      h('div', { class: 'prov-name', text: prov.name }),
      isActive ? h('span', { class: 'prov-badge', text: '● 当前启用' }) : null,
      h('span', { class: 'prov-proto', text: PROTOCOL_LABELS[prov.protocol] }),
    ]),
  );

  const body = h('div', { class: 'prov-body' }, [
    h('div', { class: 'grid-2' }, [field('名称', bind('name')), field('协议', protoSel)]),
    field('API Base URL', bind('baseUrl', { ph: 'https://api.example.com/v1' })),
    h('div', { class: 'grid-2' }, [
      field(prov.protocol === 'gemini' ? 'API Key（走 query）' : 'API Key', bind('apiKey', { type: 'password', ph: 'sk-...' })),
      field('模型 ID', h('div', {}, [modelInput, modelList])),
    ]),
  ]);

  // 高级设置
  const advWrap = h('div', { class: 'hidden' }, [
    prov.protocol === 'anthropic' ? field('anthropic-version', bind('anthropicVersion', { ph: '2023-06-01' })) : null,
    h('div', { class: 'grid-2' }, [
      field('temperature', bind('temperature', { type: 'number', ph: '0.3' })),
      field('max tokens', bind('maxTokens', { type: 'number', ph: '2048' })),
    ]),
    field('自定义请求 URL（可选，覆盖 Base 拼接）', bind('requestUrl', { ph: '留空则自动拼接' })),
    field('自定义模型列表 URL（可选）', bind('modelsUrl', { ph: '留空则用 Base/models' })),
    field('额外请求头（JSON，可选）', extraHeadersEditor(prov, commit)),
  ]);
  const advToggle = h('span', { class: 'adv-toggle', text: '▸ 高级设置' });
  advToggle.addEventListener('click', () => {
    advWrap.classList.toggle('hidden');
    advToggle.textContent = advWrap.classList.contains('hidden') ? '▸ 高级设置' : '▾ 高级设置';
  });
  body.appendChild(advToggle);
  body.appendChild(advWrap);

  // 测试结果区
  const resultEl = h('div', {});

  // 操作行
  body.appendChild(
    h('div', { class: 'row', style: 'margin-top:14px;flex-wrap:wrap' }, [
      h('button', { class: 'btn btn-sm btn-primary', text: '测试连接', onclick: () => testProv(prov, resultEl) }),
      h('button', { class: 'btn btn-sm', text: '拉取模型列表', onclick: () => fetchModels(prov, resultEl) }),
      !isActive
        ? h('button', {
            class: 'btn btn-sm',
            text: '设为启用',
            onclick: async () => {
              settings = await send(MSG.SETTINGS_SAVE, { patch: { activeProviderId: prov.id } });
              toast('已设为当前启用');
              route();
            },
          })
        : null,
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-sm btn-danger',
        text: '删除',
        onclick: async () => {
          providers = await send(MSG.AI_PROVIDERS_SAVE, { providers: providers.filter((x) => x.id !== prov.id) });
          if (settings.activeProviderId === prov.id) {
            settings = await send(MSG.SETTINGS_SAVE, { patch: { activeProviderId: providers[0]?.id || '' } });
          }
          toast('已删除');
          route();
        },
      }),
    ]),
  );
  body.appendChild(resultEl);
  card.appendChild(body);
  return card;
}

function extraHeadersEditor(prov, commit) {
  const ta = h('textarea', { rows: 2, placeholder: '{"X-Custom":"value"}' });
  ta.value = Object.keys(prov.extraHeaders || {}).length ? JSON.stringify(prov.extraHeaders) : '';
  ta.addEventListener('input', () => {
    const v = ta.value.trim();
    if (!v) {
      prov.extraHeaders = {};
      commit();
      ta.style.borderColor = '';
      return;
    }
    try {
      const obj = JSON.parse(v);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        prov.extraHeaders = obj;
        commit();
        ta.style.borderColor = '';
      } else throw new Error();
    } catch {
      ta.style.borderColor = 'var(--red)';
    }
  });
  return ta;
}

async function testProv(prov, resultEl) {
  const v = validateProvider(prov);
  if (!v.ok) {
    resultEl.className = 'test-result test-err';
    resultEl.textContent = '配置有误：' + v.errors.join('；');
    return;
  }
  resultEl.className = 'test-result';
  resultEl.innerHTML = '<span class="spinner"></span> 测试中…';
  try {
    const r = await send(MSG.AI_PROVIDER_TEST, { provider: prov });
    if (r.ok) {
      resultEl.className = 'test-result test-ok';
      resultEl.textContent = `✓ ${r.message}${r.sample ? '（模型回复：' + r.sample + '）' : ''}`;
    } else {
      resultEl.className = 'test-result test-err';
      resultEl.textContent = '✕ ' + r.message;
    }
  } catch (e) {
    resultEl.className = 'test-result test-err';
    resultEl.textContent = '✕ ' + e.message;
  }
}

async function fetchModels(prov, resultEl) {
  resultEl.className = 'test-result';
  resultEl.innerHTML = '<span class="spinner"></span> 拉取模型中…';
  try {
    const models = await send(MSG.AI_PROVIDER_MODELS, { provider: prov });
    prov.discoveredModels = models;
    providers = await send(MSG.AI_PROVIDERS_SAVE, { providers });
    resultEl.className = 'test-result test-ok';
    resultEl.textContent = `✓ 发现 ${models.length} 个模型，已填入模型下拉候选`;
    route();
  } catch (e) {
    resultEl.className = 'test-result test-err';
    resultEl.textContent = '✕ ' + e.message + '（部分供应商不支持列模型，可手动填写模型 ID）';
  }
}

// ============================================================
//  岗位筛选
// ============================================================
function renderFilters() {
  mainEl.appendChild(sectionHead('岗位筛选', '本地规则先过一遍（不消耗 AI）。命中排除词或不满足条件的岗位不进入列表。'));
  const f = settings.filters;
  const save = debounce(async () => {
    settings = await send(MSG.SETTINGS_SAVE, { patch: { filters: f } });
  }, 500);

  const panel = h('div', { class: 'panel' });
  panel.appendChild(
    h('div', { class: 'set-row' }, [
      h('div', {}, [h('div', { class: 's-label', text: '启用本地筛选' }), h('div', { class: 's-desc', text: '关闭时收录全部岗位，仅标注风险词' })]),
      switchEl(f.enabled, (val) => { f.enabled = val; save(); }),
    ]),
  );
  mainEl.appendChild(panel);

  const listBind = (key, ph) =>
    tagEditor(f[key], (arr) => { f[key] = arr; save(); }, ph);

  const p2 = h('div', { class: 'panel' }, [
    h('div', { class: 'panel-title', text: '关键词' }),
    field('包含关键词（配置后须命中任一）', listBind('keywordsInclude', '如 前端、React')),
    field('排除关键词（命中即剔除）', listBind('keywordsExclude', '如 电销、催收')),
    field('风险词（仅标注不剔除）', listBind('riskKeywords', '如 外包、驻场')),
    field('屏蔽公司（公司名含即剔除）', listBind('excludeCompanies', '公司名关键词')),
  ]);
  mainEl.appendChild(p2);

  const numBind = (key, ph) => {
    const input = h('input', { type: 'number', value: f[key] ?? '', placeholder: ph });
    input.addEventListener('input', () => { f[key] = input.value === '' ? null : Number(input.value); save(); });
    return input;
  };
  const p3 = h('div', { class: 'panel' }, [
    h('div', { class: 'panel-title', text: '条件' }),
    field('城市（含任一即保留）', listBind('cities', '如 广州、深圳')),
    h('div', { class: 'grid-2' }, [
      field('薪资下限(k/月)', numBind('salaryMinK', '如 12')),
      field('薪资上限(k/月)', numBind('salaryMaxK', '如 30')),
    ]),
    field('经验偏好（软提示）', listBind('experience', '如 1-3年')),
    field('学历偏好（软提示）', listBind('degrees', '如 本科')),
  ]);
  mainEl.appendChild(p3);
}

// ============================================================
//  通用与隐私
// ============================================================
function renderGeneral() {
  mainEl.appendChild(sectionHead('通用与隐私', '控制抓取行为与发送给 AI 的数据范围。所有数据仅存本机浏览器。'));
  const save = debounce(async (patch) => {
    settings = await send(MSG.SETTINGS_SAVE, { patch });
  }, 200);

  // 运行模式
  const modePanel = h('div', { class: 'panel' }, [
    h('div', { class: 'panel-title', text: '运行模式' }),
    h('div', { class: 'panel-desc', text: '自动 = 跟随当前站点；也可锁定只看某个平台。' }),
    (() => {
      const seg = h('div', { class: 'segmented' });
      [[MODE.auto, '自动'], [MODE.boss, 'BOSS 直聘'], [MODE.qcwy, '前程无忧']].forEach(([v, l]) => {
        seg.appendChild(h('button', {
          class: settings.mode === v ? 'active' : '',
          text: l,
          onclick: async () => { settings = await send(MSG.SETTINGS_SAVE, { patch: { mode: v } }); route(); },
        }));
      });
      return seg;
    })(),
  ]);
  mainEl.appendChild(modePanel);

  // 抓取行为
  const cap = h('div', { class: 'panel' }, [h('div', { class: 'panel-title', text: '抓取与分析' })]);
  cap.appendChild(setRow('自动收录岗位', '浏览列表时自动抓取', settings.autoCapture, (v) => save({ autoCapture: v })));
  cap.appendChild(setRow('自动 AI 分析', '新收录岗位自动打分（消耗 token）', settings.autoScore, (v) => save({ autoScore: v })));
  cap.appendChild(setRow('列表内显示角标', '页面右下角显示收录状态', settings.showBadge, (v) => save({ showBadge: v })));
  cap.appendChild(setRow('去重', '相同岗位只保留一条', settings.dedupe, (v) => save({ dedupe: v })));
  const maxInput = h('input', { type: 'number', value: settings.maxJobs, style: 'width:100px' });
  maxInput.addEventListener('input', () => save({ maxJobs: Number(maxInput.value) || 800 }));
  cap.appendChild(
    h('div', { class: 'set-row' }, [
      h('div', {}, [h('div', { class: 's-label', text: '岗位库上限' }), h('div', { class: 's-desc', text: '超出按时间淘汰（收藏不淘汰）' })]),
      maxInput,
    ]),
  );
  mainEl.appendChild(cap);

  // 隐私
  const priv = h('div', { class: 'panel' }, [
    h('div', { class: 'panel-title', text: '隐私' }),
    h('div', { class: 'panel-desc', text: '发送给第三方 AI 前的数据处理。API Key 与全部数据仅保存在本机。' }),
  ]);
  priv.appendChild(setRow('发送前脱敏', '隐去手机号、邮箱、联系方式、个人链接等', settings.privacy.redactPII, (v) => save({ privacy: { redactPII: v } })));
  priv.appendChild(setRow('发送岗位公司名', '公司名一般为公开招聘信息，发送可提升分析质量', settings.privacy.sendCompanyName, (v) => save({ privacy: { sendCompanyName: v } })));
  mainEl.appendChild(priv);

  // 数据管理
  mainEl.appendChild(
    h('div', { class: 'panel' }, [
      h('div', { class: 'panel-title', text: '数据' }),
      h('div', { class: 'row', style: 'gap:10px;flex-wrap:wrap' }, [
        h('button', { class: 'btn', text: '导出岗位 (JSON)', onclick: () => exportData('json') }),
        h('button', { class: 'btn', text: '导出岗位 (CSV)', onclick: () => exportData('csv') }),
        h('button', {
          class: 'btn btn-danger',
          text: '清空岗位库',
          onclick: () => showModal({
            title: '清空岗位库？', body: '删除全部已收录岗位，不可撤销。', confirmText: '清空', danger: true,
            onConfirm: async () => { await send(MSG.JOB_CLEAR_REQUEST); toast('已清空'); },
          }),
        }),
      ]),
    ]),
  );
}

async function exportData(format) {
  try {
    const res = await send(MSG.JOB_EXPORT_REQUEST, { format });
    const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json';
    const blob = new Blob([res.content], { type: mime });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().slice(0, 10);
    await chrome.downloads.download({ url, filename: `岗位收录-${ts}.${format}`, saveAs: true });
    toast(`已导出 ${res.count} 个岗位`);
  } catch (e) {
    toast(e.message, true);
  }
}

// ============================================================
//  通用组件
// ============================================================
function field(label, control) {
  return h('div', { class: 'field' }, [h('label', { text: label }), control]);
}

function setRow(label, desc, checked, onChange) {
  return h('div', { class: 'set-row' }, [
    h('div', {}, [h('div', { class: 's-label', text: label }), h('div', { class: 's-desc', text: desc })]),
    switchEl(checked, onChange),
  ]);
}

function switchEl(checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch' }, [input, h('span', { class: 'slider' })]);
}

// 标签编辑器：chip + 输入，回车/逗号添加
function tagEditor(values, onChange, placeholder) {
  const arr = Array.isArray(values) ? [...values] : [];
  const wrap = h('div', { class: 'tag-editor' });
  const input = h('input', { type: 'text', placeholder: placeholder || '回车添加' });

  function redraw() {
    wrap.innerHTML = '';
    arr.forEach((v, i) => {
      wrap.appendChild(
        h('span', { class: 'chip chip-accent' }, [
          h('span', { text: v }),
          h('span', { class: 'x', text: '×', onclick: () => { arr.splice(i, 1); onChange([...arr]); redraw(); } }),
        ]),
      );
    });
    wrap.appendChild(input);
    input.focus();
  }
  function commit() {
    const parts = toList(input.value);
    let changed = false;
    for (const p of parts) {
      if (!arr.some((x) => x.toLowerCase() === p.toLowerCase())) {
        arr.push(p);
        changed = true;
      }
    }
    input.value = '';
    if (changed) {
      onChange([...arr]);
      redraw();
    }
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !input.value && arr.length) {
      arr.pop();
      onChange([...arr]);
      redraw();
    }
  });
  input.addEventListener('blur', commit);
  // 初次渲染不抢焦点
  arr.forEach((v, i) => {
    wrap.appendChild(
      h('span', { class: 'chip chip-accent' }, [
        h('span', { text: v }),
        h('span', { class: 'x', text: '×', onclick: () => { arr.splice(i, 1); onChange([...arr]); redraw(); } }),
      ]),
    );
  });
  wrap.appendChild(input);
  return wrap;
}

function showModal({ title, body, confirmText = '确认', danger = false, onConfirm }) {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => backdrop.remove();
  backdrop.appendChild(
    h('div', { class: 'modal' }, [
      h('h3', { text: title }),
      h('p', { text: body }),
      h('div', { class: 'modal-actions' }, [
        h('button', { class: 'btn', text: '取消', onclick: close }),
        h('button', {
          class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'),
          text: confirmText,
          onclick: async () => { await onConfirm(); close(); },
        }),
      ]),
    ]),
  );
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
}

function showBusy(text) {
  const el = h('div', { class: 'busy-overlay' }, [
    h('span', { class: 'spinner big-spinner' }),
    h('div', { text }),
  ]);
  document.body.appendChild(el);
  return {
    setText: (t) => {
      el.querySelector('div').textContent = t;
    },
    close: () => el.remove(),
  };
}

boot();
