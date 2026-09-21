// 岗位库：storage.local 读写、去重合并、容量淘汰、匹配分缓存。
import { STORAGE_KEYS } from './constants.js';

const JOBS_KEY = STORAGE_KEYS.jobs;
const CACHE_KEY = STORAGE_KEYS.matchCache;

export async function loadJobs() {
  const got = await chrome.storage.local.get(JOBS_KEY);
  const list = got[JOBS_KEY];
  return Array.isArray(list) ? list : [];
}

export async function saveJobs(list) {
  await chrome.storage.local.set({ [JOBS_KEY]: Array.isArray(list) ? list : [] });
}

// 合并新抓取的岗位到库中。dedupe=true 时按 uid 去重（更新已存在的字段）。
// 返回 { jobs, added, updated }
export async function mergeJobs(incoming, { dedupe = true, maxJobs = 800 } = {}) {
  const now = new Date().toISOString();
  const existing = await loadJobs();
  const byUid = new Map(existing.map((j) => [j.uid, j]));
  let added = 0;
  let updated = 0;

  for (const raw of incoming) {
    if (!raw || !raw.uid) continue;
    if (dedupe && byUid.has(raw.uid)) {
      const prev = byUid.get(raw.uid);
      // 用新数据补全空字段，保留 savedAt / star / match
      const merged = {
        ...prev,
        ...raw,
        description: raw.description || prev.description,
        savedAt: prev.savedAt,
        star: prev.star,
        match: prev.match,
        lastSeenAt: now,
      };
      byUid.set(raw.uid, merged);
      updated++;
    } else {
      byUid.set(raw.uid, { ...raw, savedAt: now, lastSeenAt: now, star: false, match: null });
      added++;
    }
  }

  let list = Array.from(byUid.values());
  // 按最近出现时间倒序，超容量淘汰（保留收藏）
  list.sort((a, b) => (b.lastSeenAt || b.savedAt || '').localeCompare(a.lastSeenAt || a.savedAt || ''));
  if (list.length > maxJobs) {
    const starred = list.filter((j) => j.star);
    const rest = list.filter((j) => !j.star).slice(0, Math.max(0, maxJobs - starred.length));
    list = [...starred, ...rest];
  }

  await saveJobs(list);
  return { jobs: list, added, updated };
}

export async function deleteJob(uid) {
  const list = await loadJobs();
  const next = list.filter((j) => j.uid !== uid);
  await saveJobs(next);
  return next;
}

export async function clearJobs() {
  await chrome.storage.local.set({ [JOBS_KEY]: [] });
  return [];
}

export async function toggleStar(uid) {
  const list = await loadJobs();
  const next = list.map((j) => (j.uid === uid ? { ...j, star: !j.star } : j));
  await saveJobs(next);
  return next;
}

// 写回单个岗位的匹配分
export async function setJobMatch(uid, match) {
  const list = await loadJobs();
  const next = list.map((j) => (j.uid === uid ? { ...j, match } : j));
  await saveJobs(next);
  return next;
}

// 保存用户编辑后的招呼语草稿（发送前的最终文案，独立于 AI 生成的 match.greetings）
export async function setJobGreeting(uid, text) {
  const list = await loadJobs();
  const draft = String(text == null ? '' : text).slice(0, 800);
  const next = list.map((j) => (j.uid === uid ? { ...j, greetingDraft: draft } : j));
  await saveJobs(next);
  return next;
}

// —— 匹配分缓存：key = uid + profile 指纹，避免画像没变时重复调用 AI ——
export async function getMatchCache() {
  const got = await chrome.storage.local.get(CACHE_KEY);
  return got[CACHE_KEY] && typeof got[CACHE_KEY] === 'object' ? got[CACHE_KEY] : {};
}
export async function setMatchCache(cache) {
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}
export async function clearMatchCache() {
  await chrome.storage.local.remove(CACHE_KEY);
}
