// Service Worker：消息路由 + 岗位收录 + AI 调用编排 + 上下文追踪。
import { MSG, PLATFORM_META } from '../common/constants.js';
import { normalizeResponse, platformOfHost } from '../common/platforms.js';
import {
  loadJobs, mergeJobs, deleteJob, clearJobs, toggleStar, setJobMatch, setJobGreeting,
  getMatchCache, setMatchCache, clearMatchCache,
} from '../common/jobsStore.js';
import {
  loadSettings, saveSettings, loadProviders, saveProviders, getActiveProvider,
} from '../common/settingsStore.js';
import { loadProfile, saveProfile, clearProfile, sanitizeProfile } from '../common/profile.js';
import { sanitizeProvider } from '../common/ai/providers.js';
import { chat, chatJson, testProvider, listModels } from '../common/ai/client.js';
import { buildResumeExtractPrompt, buildMatchPrompt, sanitizeMatch, buildTailorResumePrompt, sanitizeTailor } from '../common/ai/prompts.js';
import { redactText } from '../common/ai/privacy.js';

// 记录每个 tab 当前所处平台，供 UI 查询「当前站点」
const tabContext = new Map();

// —— 侧边栏：点击工具栏图标即打开 ——
chrome.runtime.onInstalled.addListener(async () => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {}
});

// —— 统一消息入口 ——
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  handle(msg, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  return true; // 异步响应
});

async function handle(msg, sender) {
  switch (msg.type) {
    // ---------- 岗位数据流 ----------
    case MSG.JOBS_CAPTURED:
      return onJobsCaptured(msg, sender);
    case MSG.JOB_LIST_REQUEST:
      return loadJobs();
    case MSG.JOB_DELETE:
      return afterJobsChange(await deleteJob(msg.uid));
    case MSG.JOB_CLEAR_REQUEST:
      return afterJobsChange(await clearJobs());
    case MSG.JOB_STAR_TOGGLE:
      return afterJobsChange(await toggleStar(msg.uid));
    case MSG.JOB_EXPORT_REQUEST:
      return exportJobs(msg.format);
    case MSG.GREETING_SAVE:
      return afterJobsChange(await setJobGreeting(msg.uid, msg.text));

    // ---------- 页面上下文 ----------
    case MSG.PAGE_CONTEXT_CHANGED:
      if (sender.tab && sender.tab.id != null) {
        const prev = tabContext.get(sender.tab.id) || {};
        tabContext.set(sender.tab.id, {
          platform: msg.platform,
          url: msg.url,
          // URL 能识别到岗位就用它；否则（如列表页详情抽屉不改 URL）保留上次 CURRENT_JOB 记下的
          jobKey: msg.jobKey || prev.jobKey || null,
          isChat: !!msg.isChat,
          at: Date.now(),
        });
      }
      return { ok: true };
    case MSG.CURRENT_JOB:
      if (sender.tab && sender.tab.id != null) {
        const prev = tabContext.get(sender.tab.id) || {};
        tabContext.set(sender.tab.id, {
          ...prev,
          platform: msg.platform || prev.platform,
          jobKey: msg.jobKey,
          at: Date.now(),
        });
        // 实时推给面板：让「当前岗位」跟随网站上点开的岗位切换
        broadcast(MSG.CURRENT_JOB, { tabId: sender.tab.id, platform: msg.platform, jobKey: msg.jobKey });
      }
      return { ok: true };
    case MSG.ACTIVE_CONTEXT_REQUEST:
      return getActiveContext();

    // ---------- 发送招呼语 ----------
    case MSG.SEND_GREETING:
      return sendGreetingToChat(msg.text, msg.platform, msg.url);
    case MSG.OPEN_JOB_CHAT:
      return openJobChat(msg.text, msg.platform, msg.url);

    // ---------- 设置 ----------
    case MSG.SETTINGS_GET:
      return loadSettings();
    case MSG.SETTINGS_SAVE:
      return saveSettings(msg.patch || {});

    // ---------- 画像 ----------
    case MSG.PROFILE_GET:
      return loadProfile();
    case MSG.PROFILE_SAVE:
      return saveProfile(msg.profile);
    case MSG.PROFILE_CLEAR:
      await clearMatchCache(); // 画像清空后匹配缓存失效
      return clearProfile();

    // ---------- AI 供应商 ----------
    case MSG.AI_PROVIDERS_GET:
      return loadProviders();
    case MSG.AI_PROVIDERS_SAVE:
      return saveProviders(msg.providers);
    case MSG.AI_PROVIDER_TEST:
      return testProvider(sanitizeProvider(msg.provider));
    case MSG.AI_PROVIDER_MODELS:
      return listModels(sanitizeProvider(msg.provider));

    // ---------- AI 能力 ----------
    case MSG.AI_RESUME_EXTRACT:
      return extractResume(msg.text);
    case MSG.AI_MATCH_SCORE:
      return scoreOne(msg.uid, msg.job, { force: msg.force });
    case MSG.AI_MATCH_BATCH:
      return scoreBatch(msg.uids, { force: msg.force });
    case MSG.AI_TAILOR_RESUME:
      return tailorResume(msg.uid, msg.job);

    // ---------- 面板控制 ----------
    case MSG.OPEN_OPTIONS:
      chrome.runtime.openOptionsPage();
      return { ok: true };

    default:
      throw new Error(`未知消息类型：${msg.type}`);
  }
}

// —— 岗位收录 ——
async function onJobsCaptured(msg, sender) {
  const settings = await loadSettings();
  if (!settings.autoCapture) return { added: 0, updated: 0, skipped: true };
  const jobs = normalizeResponse(msg.platform, msg.payload, { url: msg.url });
  if (!jobs.length) return { added: 0, updated: 0 };
  const { jobs: all, added, updated } = await mergeJobs(jobs, {
    dedupe: settings.dedupe,
    maxJobs: settings.maxJobs,
  });
  broadcast(MSG.JOBS_UPDATED, { count: all.length, added, updated });

  // 自动打分（可选）：仅对新加入的、且已有可用供应商与画像时
  if (settings.autoScore && added > 0) {
    const newUids = jobs.slice(0, added).map((j) => j.uid);
    scoreBatch(newUids, {}).catch(() => {});
  }
  return { added, updated, total: all.length };
}

function afterJobsChange(list) {
  broadcast(MSG.JOBS_UPDATED, { count: list.length });
  return list;
}

async function getActiveContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let platform = null;
  let url = '';
  let jobKey = null;
  let isChat = false;
  if (tab) {
    url = tab.url || '';
    try {
      platform = platformOfHost(new URL(url).hostname);
    } catch {}
    const ctx = tabContext.get(tab.id);
    if (ctx) {
      if (!platform) platform = ctx.platform;
      jobKey = ctx.jobKey || null;
      isChat = !!ctx.isChat;
    }
  }
  return {
    platform,
    url,
    jobKey,
    isChat,
    platformName: platform ? PLATFORM_META[platform].name : '',
  };
}

// —— 一键把招呼语发给 HR ——
// 策略：找到目标平台已打开的「沟通/聊天」标签页，交由其 content-script 做 DOM 自动填入+发送。
// 不逆向 IM 协议、不伪造请求，等价于用户手动在聊天框里打字并点发送，风险最低。
// url 存在时（批量发送场景）：先把该标签页导航到对应岗位详情页，再由 content-script 点「立即沟通」开聊天并发送。
// —— 新建标签页打开岗位并自动进入与 HR 的沟通 ——
// 在当前窗口新开一个标签页并激活（视图跳过去），保留用户正在浏览的标签不关闭。
// 新标签加载完成后，让其 content-script 自动点「立即沟通」开聊天，并尽力填入招呼语；
// 填不进（BOSS 聊天框常被混淆）时招呼语已在剪贴板，用户 Ctrl+V 手动粘贴即可。
async function openJobChat(text, platform, url) {
  const target = String(url || '').trim();
  const content = String(text || '').trim();
  if (!target) throw new Error('该岗位没有可打开的链接');

  // 新建标签页并激活（保留当前标签）
  const tab = await chrome.tabs.create({ url: target, active: true });
  try {
    await waitTabComplete(tab.id);
  } catch {
    // 加载超时也继续尝试，content-script 可能已就绪
  }

  // content-script 自动点「立即沟通」进入聊天，并尽力填入
  try {
    const res = await sendMessageWithRetry(tab.id, { type: MSG.SEND_GREETING, text: content });
    if (res && res.ok) return { ok: true, tabId: tab.id, mode: res.mode || 'sent' };
    // 聊天已尝试打开但未能自动填入：退回手动粘贴
    return { ok: true, tabId: tab.id, mode: 'opened', note: (res && res.error) || '' };
  } catch (e) {
    return { ok: true, tabId: tab.id, mode: 'opened', note: e instanceof Error ? e.message : String(e) };
  }
}

// 等待新标签页加载完成（+ 少量沉淀时间给 SPA 渲染）
function waitTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      if (err) reject(err);
      else setTimeout(resolve, 1500); // SPA 渲染沉淀
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(() => finish(new Error('页面加载超时')), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    // 创建时可能已加载完成，主动查一次兜底
    chrome.tabs.get(tabId).then((t) => { if (t && t.status === 'complete') finish(); }).catch(() => {});
  });
}

async function sendGreetingToChat(text, platform, url) {
  const content = String(text || '').trim();
  if (!content) throw new Error('招呼语为空');

  const hostGlobs = platform && PLATFORM_META[platform]
    ? PLATFORM_META[platform].hosts.map((host) => `*://${host}/*`)
    : ['*://*.zhipin.com/*', '*://*.51job.com/*'];

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: hostGlobs });
  } catch {
    tabs = [];
  }
  if (!tabs.length) {
    throw new Error('未找到已打开的 BOSS/51job 页面，请先在网站上打开对应平台');
  }

  // 优先当前激活标签，其次最近使用
  tabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || (b.lastAccessed || 0) - (a.lastAccessed || 0));

  // 批量发送：把首选标签导航到目标岗位页，等页面就绪
  if (url) {
    const tab = tabs[0];
    try {
      if (!sameJobPage(tab.url, url)) {
        await navigateAndWait(tab.id, url);
      }
      const res = await sendMessageWithRetry(tab.id, { type: MSG.SEND_GREETING, text: content });
      if (res && res.ok) return { ok: true, tabId: tab.id, mode: res.mode || 'dom' };
      throw new Error((res && res.error) || '未定位到聊天输入框');
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
  }

  // 单发：在已打开的标签里直接发（当前页应已是岗位/聊天页）
  const errors = [];
  for (const tab of tabs) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: MSG.SEND_GREETING, text: content });
      if (res && res.ok) {
        try { await chrome.tabs.update(tab.id, { active: true }); } catch {}
        return { ok: true, tabId: tab.id, mode: res.mode || 'dom' };
      }
      if (res && res.error) errors.push(res.error);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  const detail = errors.find((x) => x && !/Receiving end does not exist/i.test(x));
  throw new Error(detail || '未定位到聊天输入框，请确认已打开与 HR 的聊天窗口后再试');
}

// 是否已在同一岗位页（避免重复导航）
function sameJobPage(curUrl, targetUrl) {
  if (!curUrl || !targetUrl) return false;
  const id = (u) => {
    const m = String(u).match(/job_detail\/([\w-]+)\.html/) || String(u).match(/\/job\/(\d+)/) || String(u).match(/\/(\d+)\.html/);
    return m ? m[1] : null;
  };
  const a = id(curUrl), b = id(targetUrl);
  return !!a && a === b;
}

// 导航标签页并等待加载完成（+ 少量沉淀时间给 SPA 渲染）
function navigateAndWait(tabId, url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      if (err) reject(err);
      else setTimeout(resolve, 1500); // SPA 渲染沉淀
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(() => finish(new Error('页面加载超时')), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url, active: true }).catch((e) => finish(e));
  });
}

// 向 content-script 发消息，带重试（导航后 content-script 可能尚未就绪）
async function sendMessageWithRetry(tabId, msg, tries = 6, gap = 700) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, msg);
      if (res) return res;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
      if (!/Receiving end does not exist/i.test(lastErr)) throw new Error(lastErr);
    }
    await sleep(gap);
  }
  throw new Error(lastErr || 'content-script 未就绪');
}

// —— 简历抽取 ——
async function extractResume(text) {
  const provider = await getActiveProvider();
  if (!provider) throw new Error('尚未配置 AI 供应商，请先到设置页添加');
  const settings = await loadSettings();
  const clean = settings.privacy.redactPII ? redactText(String(text || '')) : String(text || '');
  if (!clean.trim()) throw new Error('简历内容为空');
  const draft = await chatJson(provider, buildResumeExtractPrompt(clean), { json: true, maxTokens: 2048 });
  return sanitizeProfile(draft); // 返回草稿，由前端展示给用户确认后再入库
}

// —— 匹配打分（单个） ——
async function scoreOne(uid, jobArg, { force = false } = {}) {
  const provider = await getActiveProvider();
  if (!provider) throw new Error('尚未配置 AI 供应商，请先到设置页添加');
  const [profile, settings, jobs] = await Promise.all([loadProfile(), loadSettings(), loadJobs()]);
  const job = jobArg || jobs.find((j) => j.uid === uid);
  if (!job) throw new Error('岗位不存在');

  const fp = profileFingerprint(profile, provider);
  const cache = await getMatchCache();
  const cacheKey = `${job.uid}::${fp}`;
  if (!force && cache[cacheKey]) {
    await setJobMatch(job.uid, cache[cacheKey]);
    return cache[cacheKey];
  }

  const prompt = buildMatchPrompt(profile, job, {
    includeCompany: settings.privacy.sendCompanyName,
  });
  const raw = await chatJson(provider, prompt, { json: true, maxTokens: 1024 });
  const match = sanitizeMatch(raw);
  cache[cacheKey] = match;
  await setMatchCache(cache);
  await setJobMatch(job.uid, match);
  broadcast(MSG.JOBS_UPDATED, { uid: job.uid, scored: true });
  return match;
}

// —— 简历定制建议（按岗位 JD，不落库） ——
// 只返回建议给前端会话内展示，不写入岗位库/画像/缓存，符合「简历数据仅本会话使用」。
async function tailorResume(uid, jobArg) {
  const provider = await getActiveProvider();
  if (!provider) throw new Error('尚未配置 AI 供应商，请先到设置页添加');
  const [profile, settings, jobs] = await Promise.all([loadProfile(), loadSettings(), loadJobs()]);
  const job = jobArg || jobs.find((j) => j.uid === uid);
  if (!job) throw new Error('岗位不存在');
  const prompt = buildTailorResumePrompt(profile, job, {
    includeCompany: settings.privacy.sendCompanyName,
  });
  const raw = await chatJson(provider, prompt, { json: true, maxTokens: 1536 });
  return sanitizeTailor(raw);
}

// —— 匹配打分（批量，串行限速） ——
async function scoreBatch(uids, { force = false } = {}) {
  const list = Array.isArray(uids) ? uids : [];
  const jobs = await loadJobs();
  const map = new Map(jobs.map((j) => [j.uid, j]));
  const results = [];
  for (const uid of list) {
    const job = map.get(uid);
    if (!job) continue;
    try {
      const m = await scoreOne(uid, job, { force });
      results.push({ uid, ok: true, score: m.score });
    } catch (e) {
      results.push({ uid, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    await sleep(400); // 轻限速，避免供应商 429
  }
  broadcast(MSG.JOBS_UPDATED, { batchScored: true });
  return results;
}

// 画像+供应商指纹：任一变化则缓存失效
function profileFingerprint(profile, provider) {
  const s = JSON.stringify({
    t: profile.target,
    c: profile.capabilities,
    b: profile.basics,
    w: profile.workSummary,
    pj: profile.projectSummary,
    h: profile.highlights,
    pr: profile.preference,
    m: provider.model,
  });
  // 简单 hash
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

async function exportJobs(format) {
  const jobs = await loadJobs();
  if (format === 'csv') {
    const cols = ['platform', 'title', 'company', 'salaryText', 'city', 'district', 'experience', 'degree', 'companyIndustry', 'companyScale', 'url'];
    const head = cols.join(',');
    const rows = jobs.map((j) =>
      cols.map((c) => `"${String(j[c] ?? '').replace(/"/g, '""')}"`).join(','),
    );
    return { format: 'csv', content: '﻿' + [head, ...rows].join('\n'), count: jobs.length };
  }
  return { format: 'json', content: JSON.stringify(jobs, null, 2), count: jobs.length };
}

function broadcast(type, payload) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 清理关闭的 tab 上下文
chrome.tabs.onRemoved.addListener((tabId) => tabContext.delete(tabId));
