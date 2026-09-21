// AI 提示词构造：简历抽取、单岗位匹配打分。
// 均要求模型返回严格 JSON，配合 client.chatJson 使用。
import { redactProfileForAi, redactJobForAi } from './privacy.js';

// —— 简历文本 -> 画像草稿 ——
export function buildResumeExtractPrompt(resumeText) {
  const system =
    '你是资深招聘与职业规划顾问。请从求职者简历中抽取结构化个人画像，只输出 JSON，不要任何解释或 Markdown 围栏。' +
    '无法确定的字段留空字符串或空数组，不要编造。金额单位统一为千元/月（k）。';
  const schema = `{
  "target": {
    "jobTitles": ["目标/胜任岗位名，最多5个"],
    "cities": ["期望或现居城市"],
    "salaryMinK": 期望月薪下限数字或null,
    "salaryMaxK": 期望月薪上限数字或null,
    "industries": ["目标行业"],
    "companySizes": [],
    "workModes": []
  },
  "basics": {
    "yearsOfExperience": 工作年限数字或null,
    "education": "最高学历，如 本科/硕士",
    "currentTitle": "当前或最近职位"
  },
  "capabilities": {
    "skills": ["专业技能关键词，尽量全"],
    "strengths": ["3-6条个人优势亮点"],
    "industryExperience": ["涉猎过的行业"]
  },
  "workSummary": "150字内工作经历概述",
  "projectSummary": "150字内代表项目概述",
  "highlights": ["3-6条可量化的核心成就"]
}`;
  const user =
    `请依据以下简历内容抽取画像，严格按此 JSON 结构输出：\n${schema}\n\n` +
    `=== 简历原文开始 ===\n${String(resumeText || '').slice(0, 12000)}\n=== 简历原文结束 ===`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// —— 单岗位匹配打分 ——
export function buildMatchPrompt(profile, job, opts = {}) {
  const includeCompany = opts.includeCompany !== false;
  const includeName = !!opts.includeName;
  const p = redactProfileForAi(profile, { includeName });
  const j = redactJobForAi(job, { includeCompany });

  const system =
    '你是求职匹配分析助手。基于「求职者画像」评估「岗位」的匹配度，站在求职者视角给出理性、务实的判断，' +
    '不夸大、不贬低。只输出 JSON，不要解释或 Markdown 围栏。';
  const schema = `{
  "score": 0-100 的整数匹配分,
  "verdict": "strong | good | fair | weak 之一",
  "reasons": ["3-5条命中/契合点，具体到技能或经历"],
  "gaps": ["1-4条差距或需补齐项，没有则空数组"],
  "risks": ["1-3条风险提示，如疑似外包/薪资倒挂/经验要求过高，没有则空数组"],
  "summary": "40字内一句话总评",
  "greetings": {
    "short": "精简版开场白，30-50字，直击最核心的1个匹配亮点与求职意向，可直接发给HR",
    "standard": "标准版开场白，60-100字，结合自身亮点与岗位要点，礼貌自然，可直接发给HR",
    "detailed": "详细版开场白，120-180字，展开2-3个与岗位契合的亮点，适合正式自我介绍"
  }
}`;
  const user =
    `【求职者画像】\n${JSON.stringify(p, null, 1)}\n\n` +
    `【岗位信息】\n${JSON.stringify(j, null, 1)}\n\n` +
    `请按以下 JSON 结构输出匹配分析：\n${schema}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 校验/规整匹配结果
export function sanitizeMatch(obj) {
  const o = typeof obj === 'object' && obj ? obj : {};
  let score = Math.round(Number(o.score));
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(100, score));
  const verdicts = ['strong', 'good', 'fair', 'weak'];
  let verdict = verdicts.includes(o.verdict) ? o.verdict : scoreToVerdict(score);
  const arr = (x) =>
    Array.isArray(x) ? x.map((v) => String(v).trim()).filter(Boolean).slice(0, 6) : [];
  const greetings = normalizeGreetings(o);
  return {
    score,
    verdict,
    reasons: arr(o.reasons),
    gaps: arr(o.gaps),
    risks: arr(o.risks),
    summary: String(o.summary || '').trim().slice(0, 120),
    greetings,
    greeting: greetings.standard, // 兼容旧字段：默认取标准版
    at: new Date().toISOString(),
  };
}

// 归一化三档招呼语：接受新结构 {greetings:{short,standard,detailed}} 或旧单字段 {greeting:"..."}。
// 任一档缺失时用已有的其它档兜底，保证三档都非空。
export function normalizeGreetings(obj) {
  const o = typeof obj === 'object' && obj ? obj : {};
  const g = typeof o.greetings === 'object' && o.greetings ? o.greetings : {};
  const clean = (v) => String(v == null ? '' : v).trim().slice(0, 600);
  let short = clean(g.short);
  let standard = clean(g.standard || o.greeting); // 旧缓存的 greeting 视作标准版
  let detailed = clean(g.detailed);
  // 兜底：优先用标准版填补，其次任取一个非空的
  const any = standard || detailed || short;
  if (!standard) standard = any;
  if (!short) short = standard;
  if (!detailed) detailed = standard;
  return { short, standard, detailed };
}

export const GREETING_LEVELS = [
  { key: 'short', label: '精简版' },
  { key: 'standard', label: '标准版' },
  { key: 'detailed', label: '详细版' },
];

export function scoreToVerdict(score) {
  if (score >= 80) return 'strong';
  if (score >= 65) return 'good';
  if (score >= 45) return 'fair';
  return 'weak';
}

export const VERDICT_LABELS = {
  strong: '强匹配',
  good: '较匹配',
  fair: '一般',
  weak: '偏低',
};
