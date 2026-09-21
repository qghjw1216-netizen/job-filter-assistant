// 全局常量：存储键、消息类型、平台定义。
// 被 background 与各 UI 页以 ES module 方式引入；content-script 侧有独立副本（见 src/content）。

export const STORAGE_KEYS = {
  settings: 'jobHelperSettingsV1',
  profile: 'jobHelperProfileV1',
  jobs: 'jobHelperJobsV1',
  aiProviders: 'jobHelperAiProvidersV1',
  matchCache: 'jobHelperMatchCacheV1',
  lastReport: 'jobHelperLastCaptureReportV1',
};

// 平台标识
export const PLATFORM = {
  boss: 'boss',
  qcwy: 'qcwy', // 前程无忧 51job
};

export const PLATFORM_META = {
  [PLATFORM.boss]: {
    id: PLATFORM.boss,
    name: 'BOSS 直聘',
    short: 'BOSS',
    color: '#00a6a7',
    hosts: ['zhipin.com', 'www.zhipin.com'],
    searchUrl: 'https://www.zhipin.com/web/geek/jobs',
  },
  [PLATFORM.qcwy]: {
    id: PLATFORM.qcwy,
    name: '前程无忧 51job',
    short: '51job',
    color: '#eb6100',
    hosts: ['we.51job.com', 'www.51job.com', 'jobs.51job.com'],
    searchUrl: 'https://we.51job.com/pc/search',
  },
};

// 运行模式：auto = 跟随当前站点；其余为强制单平台视图
export const MODE = {
  auto: 'auto',
  boss: PLATFORM.boss,
  qcwy: PLATFORM.qcwy,
};

// 消息协议（background <-> content <-> UI）
export const MSG = {
  // 岗位数据流
  JOBS_CAPTURED: 'JOBS_CAPTURED', // content -> bg：嗅探到的原始岗位
  JOBS_UPDATED: 'JOBS_UPDATED', // bg -> UI：岗位库变化广播
  JOB_LIST_REQUEST: 'JOB_LIST_REQUEST', // UI -> bg：拉取岗位库
  JOB_DELETE: 'JOB_DELETE',
  JOB_CLEAR_REQUEST: 'JOB_CLEAR_REQUEST',
  JOB_STAR_TOGGLE: 'JOB_STAR_TOGGLE',
  JOB_EXPORT_REQUEST: 'JOB_EXPORT_REQUEST',
  GREETING_SAVE: 'GREETING_SAVE', // UI -> bg：保存用户编辑后的招呼语

  // 页面上下文
  ACTIVE_CONTEXT_REQUEST: 'ACTIVE_CONTEXT_REQUEST', // UI -> bg：当前激活标签的平台 + 当前岗位
  PAGE_CONTEXT_CHANGED: 'PAGE_CONTEXT_CHANGED', // content -> bg：平台/URL/当前岗位 变化

  // 发送招呼语（一键发给 HR）
  SEND_GREETING: 'SEND_GREETING', // UI -> bg -> content：把招呼语填入聊天框并发送

  // 当前查看的岗位（用户在网站上点开某个岗位详情时）
  CURRENT_JOB: 'CURRENT_JOB', // content -> bg -> UI：当前岗位切换（携带 platform + jobKey）

  // 设置 & 画像
  SETTINGS_GET: 'SETTINGS_GET',
  SETTINGS_SAVE: 'SETTINGS_SAVE',
  PROFILE_GET: 'PROFILE_GET',
  PROFILE_SAVE: 'PROFILE_SAVE',
  PROFILE_CLEAR: 'PROFILE_CLEAR',

  // AI 供应商
  AI_PROVIDERS_GET: 'AI_PROVIDERS_GET',
  AI_PROVIDERS_SAVE: 'AI_PROVIDERS_SAVE',
  AI_PROVIDER_TEST: 'AI_PROVIDER_TEST', // 连通性测试
  AI_PROVIDER_MODELS: 'AI_PROVIDER_MODELS', // 拉取模型列表

  // AI 能力
  AI_RESUME_EXTRACT: 'AI_RESUME_EXTRACT', // 简历文本 -> 画像草稿
  AI_MATCH_SCORE: 'AI_MATCH_SCORE', // 单岗位匹配打分
  AI_MATCH_BATCH: 'AI_MATCH_BATCH', // 批量匹配
  AI_TAILOR_RESUME: 'AI_TAILOR_RESUME', // 按岗位 JD 生成简历定制建议（不落库，会话内使用）

  // 面板控制
  OPEN_OPTIONS: 'OPEN_OPTIONS',
  OPEN_SIDEPANEL: 'OPEN_SIDEPANEL',
  OPEN_JOB_CHAT: 'OPEN_JOB_CHAT', // 新建标签页打开岗位并自动进入与 HR 的沟通（保留当前标签），配合剪贴板手动粘贴
};

// content-script 嗅探事件的 window.postMessage 频道
export const SNIFFER_CHANNEL = 'job-helper:sniffer';

// 默认设置
export function defaultSettings() {
  return {
    mode: MODE.auto,
    autoCapture: true, // 浏览时自动收录嗅探到的岗位
    autoScore: false, // 收录后自动 AI 打分（默认关，省 token）
    showBadge: true, // 在岗位卡片上显示匹配角标
    dedupe: true,
    maxJobs: 800, // 岗位库上限，超出按时间淘汰
    activeProviderId: '', // 当前启用的 AI 供应商
    privacy: {
      redactPII: true, // 发送前脱敏
      sendCompanyName: true, // 岗位公司名一般是公开信息，默认发送
      confirmBeforeSend: false,
    },
    filters: defaultFilters(),
  };
}

// 本地筛选规则（不消耗 AI，先过一遍）
export function defaultFilters() {
  return {
    enabled: false,
    keywordsInclude: [], // 命中任一即保留（岗位名/JD/标签）
    keywordsExclude: [], // 命中任一即排除
    riskKeywords: ['外包', '驻场', '猎头', '销售', '电销', '中介'], // 风险词标注（不强制排除）
    cities: [],
    salaryMinK: null, // 期望月薪下限（千元）
    salaryMaxK: null,
    experience: [], // 经验档位标签
    degrees: [], // 学历标签
    excludeCompanies: [], // 屏蔽公司（子串匹配）
  };
}
