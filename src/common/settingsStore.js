// 设置与 AI 供应商列表的 storage 读写。
import { STORAGE_KEYS, defaultSettings, defaultFilters } from './constants.js';
import { sanitizeProviderList } from './ai/providers.js';

const SET_KEY = STORAGE_KEYS.settings;
const PROV_KEY = STORAGE_KEYS.aiProviders;

export async function loadSettings() {
  const got = await chrome.storage.local.get(SET_KEY);
  return mergeSettings(got[SET_KEY]);
}
export async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = mergeSettings({ ...cur, ...patch, filters: { ...cur.filters, ...(patch && patch.filters) }, privacy: { ...cur.privacy, ...(patch && patch.privacy) } });
  await chrome.storage.local.set({ [SET_KEY]: next });
  return next;
}

export function mergeSettings(input) {
  const d = defaultSettings();
  if (!isObj(input)) return d;
  return {
    ...d,
    ...input,
    privacy: { ...d.privacy, ...(isObj(input.privacy) ? input.privacy : {}) },
    filters: { ...defaultFilters(), ...(isObj(input.filters) ? input.filters : {}) },
  };
}

export async function loadProviders() {
  const got = await chrome.storage.local.get(PROV_KEY);
  return sanitizeProviderList(got[PROV_KEY]);
}
export async function saveProviders(list) {
  const clean = sanitizeProviderList(list);
  await chrome.storage.local.set({ [PROV_KEY]: clean });
  return clean;
}

// 取当前启用的供应商（settings.activeProviderId 指向；否则取第一个可用）
export async function getActiveProvider() {
  const [settings, providers] = await Promise.all([loadSettings(), loadProviders()]);
  if (!providers.length) return null;
  const byId = providers.find((p) => p.id === settings.activeProviderId);
  return byId || providers[0];
}

function isObj(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
