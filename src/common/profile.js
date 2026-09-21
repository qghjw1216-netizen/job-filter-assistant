// 个人画像：schema、默认值、清洗、完整度评分、storage 读写。
// 通用职业版（不限设计师），供匹配打分与简历抽取共用。
import { STORAGE_KEYS } from './constants.js';

const KEY = STORAGE_KEYS.profile;

export function emptyProfile() {
  return {
    schemaVersion: 1,
    // 求职目标
    target: {
      jobTitles: [], // 目标岗位
      cities: [], // 目标城市
      salaryMinK: null, // 期望月薪下限（千元）
      salaryMaxK: null,
      industries: [], // 目标行业
      companySizes: [], // 期望公司规模
      workModes: [], // 办公方式：现场/混合/远程
    },
    // 个人能力
    basics: {
      name: '', // 仅本地展示，默认不外发
      yearsOfExperience: null, // 工作年限
      education: '', // 最高学历
      currentTitle: '', // 当前/最近职位
    },
    capabilities: {
      skills: [], // 技能关键词
      strengths: [], // 优势亮点
      industryExperience: [], // 行业经验
    },
    // 经历（可由简历抽取填充）
    workSummary: '', // 工作经历概述
    projectSummary: '', // 项目经历概述
    highlights: [], // 核心成就 bullet
    // 求职偏好与禁区
    preference: {
      avoidKeywords: [], // 不想要的岗位特征
      dealbreakers: [], // 硬性排除
      notes: '', // 自由备注给 AI 的额外说明
    },
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

// 完整度评分项（权重合计 100）
const SCORE_ITEMS = [
  { label: '目标岗位', weight: 14, ok: (p) => p.target.jobTitles.length > 0 },
  { label: '目标城市', weight: 8, ok: (p) => p.target.cities.length > 0 },
  { label: '期望薪资', weight: 8, ok: (p) => num(p.target.salaryMinK) || num(p.target.salaryMaxK) },
  { label: '工作年限', weight: 8, ok: (p) => num(p.basics.yearsOfExperience) },
  { label: '最高学历', weight: 6, ok: (p) => !!p.basics.education },
  { label: '当前职位', weight: 6, ok: (p) => !!p.basics.currentTitle },
  { label: '专业技能', weight: 16, ok: (p) => p.capabilities.skills.length > 0 },
  { label: '优势亮点', weight: 8, ok: (p) => p.capabilities.strengths.length > 0 },
  { label: '行业经验', weight: 6, ok: (p) => p.capabilities.industryExperience.length > 0 },
  { label: '工作经历', weight: 8, ok: (p) => !!p.workSummary.trim() },
  { label: '项目/成就', weight: 6, ok: (p) => !!p.projectSummary.trim() || p.highlights.length > 0 },
];

export function scoreProfile(profile) {
  const p = sanitizeProfile(profile);
  const done = SCORE_ITEMS.filter((it) => it.ok(p));
  return {
    score: done.reduce((s, it) => s + it.weight, 0),
    completed: done.length,
    total: SCORE_ITEMS.length,
    missing: SCORE_ITEMS.filter((it) => !it.ok(p)).map((it) => it.label),
  };
}

// 深度清洗：任意输入（含 AI 抽取草稿）-> 合法 profile
export function sanitizeProfile(input) {
  const base = emptyProfile();
  if (!isObj(input)) return base;
  const t = isObj(input.target) ? input.target : {};
  const b = isObj(input.basics) ? input.basics : {};
  const c = isObj(input.capabilities) ? input.capabilities : {};
  const pref = isObj(input.preference) ? input.preference : {};
  return {
    schemaVersion: 1,
    target: {
      jobTitles: arr(t.jobTitles),
      cities: arr(t.cities),
      salaryMinK: posNum(t.salaryMinK),
      salaryMaxK: posNum(t.salaryMaxK),
      industries: arr(t.industries),
      companySizes: arr(t.companySizes),
      workModes: arr(t.workModes),
    },
    basics: {
      name: s(b.name),
      yearsOfExperience: nonNegNum(b.yearsOfExperience),
      education: s(b.education),
      currentTitle: s(b.currentTitle),
    },
    capabilities: {
      skills: arr(c.skills),
      strengths: arr(c.strengths),
      industryExperience: arr(c.industryExperience),
    },
    workSummary: s(input.workSummary),
    projectSummary: s(input.projectSummary),
    highlights: arr(input.highlights),
    preference: {
      avoidKeywords: arr(pref.avoidKeywords),
      dealbreakers: arr(pref.dealbreakers),
      notes: s(pref.notes),
    },
    updatedAt: s(input.updatedAt) || new Date().toISOString(),
    createdAt: s(input.createdAt) || new Date().toISOString(),
  };
}

// —— storage ——
export async function loadProfile() {
  const got = await chrome.storage.local.get(KEY);
  return sanitizeProfile(got[KEY]);
}
export async function saveProfile(profile) {
  const clean = sanitizeProfile(profile);
  clean.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [KEY]: clean });
  return clean;
}
export async function clearProfile() {
  await chrome.storage.local.remove(KEY);
  return emptyProfile();
}

// 合并 AI 抽取草稿到现有画像（用户确认后调用）：数组去重合并，标量空则填充
export function mergeDraft(current, draft) {
  const a = sanitizeProfile(current);
  const d = sanitizeProfile(draft);
  const mergeArr = (x, y) => arr([...x, ...y]);
  return sanitizeProfile({
    ...a,
    target: {
      jobTitles: mergeArr(a.target.jobTitles, d.target.jobTitles),
      cities: mergeArr(a.target.cities, d.target.cities),
      salaryMinK: a.target.salaryMinK ?? d.target.salaryMinK,
      salaryMaxK: a.target.salaryMaxK ?? d.target.salaryMaxK,
      industries: mergeArr(a.target.industries, d.target.industries),
      companySizes: mergeArr(a.target.companySizes, d.target.companySizes),
      workModes: mergeArr(a.target.workModes, d.target.workModes),
    },
    basics: {
      name: a.basics.name || d.basics.name,
      yearsOfExperience: a.basics.yearsOfExperience ?? d.basics.yearsOfExperience,
      education: a.basics.education || d.basics.education,
      currentTitle: a.basics.currentTitle || d.basics.currentTitle,
    },
    capabilities: {
      skills: mergeArr(a.capabilities.skills, d.capabilities.skills),
      strengths: mergeArr(a.capabilities.strengths, d.capabilities.strengths),
      industryExperience: mergeArr(a.capabilities.industryExperience, d.capabilities.industryExperience),
    },
    workSummary: a.workSummary || d.workSummary,
    projectSummary: a.projectSummary || d.projectSummary,
    highlights: mergeArr(a.highlights, d.highlights),
    preference: {
      avoidKeywords: mergeArr(a.preference.avoidKeywords, d.preference.avoidKeywords),
      dealbreakers: mergeArr(a.preference.dealbreakers, d.preference.dealbreakers),
      notes: a.preference.notes || d.preference.notes,
    },
    createdAt: a.createdAt,
  });
}

// —— helpers ——
function isObj(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function s(x) {
  return typeof x === 'string' ? x.trim() : x == null ? '' : String(x).trim();
}
function arr(x) {
  if (!Array.isArray(x)) {
    // 容忍 AI 返回逗号分隔字符串
    if (typeof x === 'string' && x.trim()) x = x.split(/[,，、;；\n]/);
    else return [];
  }
  const seen = new Set();
  const out = [];
  for (const v of x) {
    const item = s(v);
    const key = item.toLowerCase();
    if (item && !seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
function posNum(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function nonNegNum(x) {
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function num(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}
