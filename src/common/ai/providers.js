// AI 供应商配置：协议类型、预设、清洗校验。
// 目标：兼容市面上主流 API 协议，不锁定单一供应商。
//
// 支持的协议族（覆盖绝大多数厂商）：
//   openai-chat      —— OpenAI /chat/completions 格式。事实标准，被 DeepSeek、
//                        阿里百炼(兼容模式)、智谱、Kimi、MiniMax、硅基流动、
//                        本地 Ollama/LM Studio/vLLM 等广泛采用。
//   openai-responses —— OpenAI 新版 /responses 格式。
//   anthropic        —— Anthropic /v1/messages 格式（Claude）。
//   gemini           —— Google Gemini generateContent 格式。
//
// 任何未列出的厂商，只要兼容上述任一协议，填自定义 baseUrl 即可接入。

export const PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic', 'gemini'];

export const PROTOCOL_LABELS = {
  'openai-chat': 'OpenAI 兼容 (/chat/completions)',
  'openai-responses': 'OpenAI Responses (/responses)',
  anthropic: 'Anthropic (/v1/messages)',
  gemini: 'Google Gemini',
};

// 预设：一键创建常见供应商。baseUrl 为官方地址，用户填 key+model 即用。
export const PRESETS = [
  {
    key: 'openai',
    name: 'OpenAI',
    protocol: 'openai-chat',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '官方或任何 OpenAI 兼容网关',
  },
  {
    key: 'deepseek',
    name: 'DeepSeek 深度求索',
    protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    hint: '性价比高，中文强',
  },
  {
    key: 'dashscope',
    name: '阿里云百炼·通义千问',
    protocol: 'openai-chat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    hint: 'OpenAI 兼容模式',
  },
  {
    key: 'zhipu',
    name: '智谱 GLM',
    protocol: 'openai-chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    hint: '有免费额度模型',
  },
  {
    key: 'moonshot',
    name: 'Kimi 月之暗面',
    protocol: 'openai-chat',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    hint: '长上下文',
  },
  {
    key: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    protocol: 'openai-chat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    hint: '聚合多家开源模型',
  },
  {
    key: 'anthropic',
    name: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-haiku-latest',
    hint: '需要 anthropic-version 头',
  },
  {
    key: 'gemini',
    name: 'Google Gemini',
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-1.5-flash',
    hint: 'key 走查询参数',
  },
  {
    key: 'ollama',
    name: '本地 Ollama',
    protocol: 'openai-chat',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5',
    hint: '本地模型，无需 key（localhost 允许 http）',
  },
  {
    key: 'custom',
    name: '自定义供应商',
    protocol: 'openai-chat',
    baseUrl: '',
    model: '',
    hint: '任意兼容上述协议的接口',
  },
];

export function newId() {
  const rnd = (globalThis.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.floor(Math.random() * 1e9).toString(16)}`;
  return `prov-${rnd}`;
}

export function providerFromPreset(presetKey) {
  const p = PRESETS.find((x) => x.key === presetKey) || PRESETS.find((x) => x.key === 'custom');
  return sanitizeProvider({
    id: newId(),
    name: p.name,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: '',
    anthropicVersion: p.protocol === 'anthropic' ? '2023-06-01' : '',
    discoveredModels: [],
  });
}

// 清洗单个供应商配置
export function sanitizeProvider(input) {
  const o = isObj(input) ? input : {};
  const protocol = PROTOCOLS.includes(o.protocol) ? o.protocol : 'openai-chat';
  return {
    id: s(o.id) || newId(),
    name: s(o.name) || '未命名供应商',
    protocol,
    baseUrl: cleanUrl(o.baseUrl),
    requestUrl: cleanUrl(o.requestUrl), // 可选：完全自定义请求地址，非空则覆盖 baseUrl 拼接
    modelsUrl: cleanUrl(o.modelsUrl), // 可选：自定义模型列表地址
    apiKey: s(o.apiKey),
    model: cleanModel(o.model),
    anthropicVersion: protocol === 'anthropic' ? s(o.anthropicVersion) || '2023-06-01' : '',
    extraHeaders: cleanHeaders(o.extraHeaders), // 自定义请求头（如网关鉴权）
    temperature: numOr(o.temperature, 0.3),
    maxTokens: intOr(o.maxTokens, 2048),
    discoveredModels: cleanModels(o.discoveredModels),
    updatedAt: s(o.updatedAt) || new Date().toISOString(),
  };
}

export function sanitizeProviderList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const p = sanitizeProvider(item);
    if (seen.has(p.id)) p.id = newId();
    seen.add(p.id);
    out.push(p);
  }
  return out;
}

// 该配置是否可用于真实请求
export function isProviderUsable(p) {
  const prov = sanitizeProvider(p);
  const needsKey = !isLocalUrl(prov.baseUrl);
  return !!(prov.baseUrl && prov.model && (!needsKey || prov.apiKey));
}

// —— helpers ——
function isObj(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function s(x) {
  return typeof x === 'string' ? x.trim() : x == null ? '' : String(x).trim();
}
function numOr(x, d) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}
function intOr(x, d) {
  const n = parseInt(x, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
}
export function cleanUrl(x) {
  const v = s(x).replace(/\/+$/, '');
  if (!v) return '';
  return v;
}
function cleanModel(x) {
  const v = s(x);
  if (!v) return '';
  if (v.length > 200) return v.slice(0, 200);
  return v;
}
function cleanHeaders(x) {
  if (!isObj(x)) return {};
  const out = {};
  for (const [k, v] of Object.entries(x)) {
    const key = s(k);
    if (key) out[key] = s(v);
  }
  return out;
}
function cleanModels(x) {
  if (!Array.isArray(x)) return [];
  const seen = new Set();
  const out = [];
  for (const m of x) {
    const id = typeof m === 'string' ? s(m) : s(m && m.id);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out.sort();
}
export function isLocalUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

// URL 合法性校验（用于保存前提示）：https 强制，localhost 放行 http
export function validateProvider(p) {
  const prov = sanitizeProvider(p);
  const errors = [];
  if (!prov.name) errors.push('名称不能为空');
  if (!prov.baseUrl) {
    errors.push('Base URL 不能为空');
  } else {
    try {
      const u = new URL(prov.baseUrl);
      if (u.protocol !== 'https:' && !isLocalUrl(prov.baseUrl)) {
        errors.push('Base URL 必须使用 HTTPS（localhost 开发环境除外）');
      }
    } catch {
      errors.push('Base URL 不是合法地址');
    }
  }
  if (!prov.model) errors.push('模型 ID 不能为空');
  return { ok: errors.length === 0, errors, provider: prov };
}
